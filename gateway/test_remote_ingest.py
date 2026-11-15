"""Disposable HTTP ingress tests; no saved dotenv, cloud, models, serial or real hardware."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

TEMP = tempfile.TemporaryDirectory(prefix='clarity-remote-')
os.environ.update({'DB_PATH': str(Path(TEMP.name) / 'remote.db'), 'GATEWAY_MODE': 'remote', 'REMOTE_INGEST': '1',
                   'MOCK': '1', 'SIM_NODES': '0', 'CONTROL_TOKEN': 'offline-test-token', 'BASELINE_DAYS': '7',
                   'GOOGLE_API_KEY': '', 'GEMINI_API_KEY': '', 'ANTHROPIC_API_KEY': '', 'AI_PROVIDER': '',
                   'TIGER_DATABASE_URL': '', 'DATABASE_URL': '', 'INVESTIGATOR': '0'})
import dotenv
dotenv.load_dotenv = lambda *args, **kwargs: False
from fastapi.testclient import TestClient
import gateway as G

AUTH = {'Authorization': 'Bearer offline-test-token'}

def frame(test=1, seq=1, **extra):
    return {'node': 'tank-01', 'session': 'remoteBootA', 'seq': seq, 'test': test, 'phase': 'before',
            'ph': 7.2, 'ph_est': True, 'tds': 780, 'clarity': .95, 'verdict': 'HIGH_TDS',
            'filter': 'BRITA', 'ask': 1, **extra}

class RemoteTests(unittest.TestCase):
    def setUp(self):
        with G.db_lock:
            for table in ('readings', 'tips', 'filter_changes', 'investigations'):
                G.db.execute(f'DELETE FROM {table}')
            G.db.commit()
        G._ingest_tokens, G._ingest_at = float(G.INGEST_BURST), time.monotonic()
        self.events, self.calls = [], []
        async def push(value): self.events.append(value)
        async def no_model(*args): self.calls.append('decision'); return None
        self.patches = [patch.object(G, 'broadcast', push), patch.object(G, 'ask_model', no_model),
                        patch.object(G, 'seed_baseline', side_effect=AssertionError('remote seeded a fake tank')),
                        patch.object(G, 'find_serial_ports', side_effect=AssertionError('remote searched serial')),
                        patch.object(G.mock, 'MockDevice', side_effect=AssertionError('remote started mock tank'))]
        for p in self.patches: p.start()
        self.client = TestClient(G.app)
        self.client.__enter__()
        self.assertFalse(G.MOCK)
        self.assertFalse(G.cloud_sync.enabled)
        self.assertIsNone(G.device)
        self.assertIsNone(G.cloud_sync._thread)

    def tearDown(self):
        self.client.__exit__(None, None, None)
        for p in reversed(self.patches): p.stop()

    def count(self, table):
        return G.db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]

    def test_remote_startup_and_public_read_stream_contract(self):
        health = self.client.get('/health').json()
        self.assertEqual(health['input_mode'], 'remote')
        self.assertTrue(health['ingest_ready'])
        self.assertFalse(health['mock'])
        self.assertEqual(self.count('readings'), 0)
        self.assertEqual(self.client.get('/api/readings').status_code, 200)
        with self.client.websocket_connect('/ws') as ws:
            ws.send_text('keepalive')
        self.assertEqual(self.client.post('/api/cmd?test=1&filter=BRITA').status_code, 401)
        self.assertEqual(self.client.post('/api/filters/BRITA/replace').status_code, 401)

    def test_ingestion_targets_current_decision_and_deduplicates_all_side_effects(self):
        first = self.client.post('/api/ingest', json=frame(), headers=AUTH)
        self.assertEqual(first.status_code, 200, first.text)
        data = first.json()
        self.assertFalse(data['duplicate'])
        self.assertEqual(data['command'], {'cmd': 'filter', 'node': 'tank-01', 'test': 1, 'filter': 'BRITA', 'session': 'remoteBootA', 'seq': 1})
        self.assertEqual(data['decision']['source'], 'local_rule')
        replay = self.client.post('/api/ingest', json=frame(), headers=AUTH).json()
        logical = self.client.post('/api/ingest', json=frame(seq=2), headers=AUTH).json()
        self.assertTrue(replay['duplicate'])
        self.assertTrue(logical['duplicate'])
        self.assertIsNone(logical['command'], 'new-sequence logical replay cannot obtain stale command')
        self.assertEqual(self.count('readings'), 1)
        self.assertEqual(self.count('tips'), 1)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(sum(e['type'] == 'reading' for e in self.events), 1)
        stored = self.client.get('/api/readings').json()[0]
        self.assertTrue(stored['ph_est'])
        self.assertEqual((stored['session'], stored['seq']), ('remoteBootA', 1))

    def test_concurrent_http_retries_share_one_canonical_decision(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            responses = list(pool.map(lambda _: self.client.post('/api/ingest', json=frame(), headers=AUTH), range(3)))
        self.assertEqual([r.status_code for r in responses], [200, 200, 200])
        self.assertEqual(sum(not r.json()['duplicate'] for r in responses), 1)
        self.assertEqual(self.count('readings'), 1)
        self.assertEqual(self.count('tips'), 1)
        self.assertEqual(len(self.calls), 1)

    def test_remote_mode_without_token_refuses_startup(self):
        with patch.object(G, 'CONTROL_TOKEN', ''):
            with self.assertRaisesRegex(RuntimeError, 'requires CONTROL_TOKEN'):
                asyncio.run(G.startup())

    def test_reflex_and_completed_readings_never_offer_an_actuation_command(self):
        reflex = self.client.post('/api/ingest', json=frame(ask=0), headers=AUTH).json()
        self.assertIsNone(reflex['command'])
        after = frame(seq=2, phase='after', tds=4, verdict='SAFE', ask=0)
        self.assertEqual(self.client.post('/api/ingest', json=after, headers=AUTH).status_code, 200)
        old = self.client.post('/api/ingest', json=frame(), headers=AUTH).json()
        self.assertIsNone(old['command'])
        self.assertEqual(self.count('readings'), 2)

    def test_auth_payload_and_rate_fail_closed(self):
        self.assertEqual(self.client.post('/api/ingest', json=frame()).status_code, 401)
        self.assertEqual(self.client.post('/api/ingest', json=frame(), headers={'Authorization': 'Bearer wrong'}).status_code, 401)
        self.assertEqual(self.client.post('/api/ingest', content='{}', headers=AUTH).status_code, 415)
        self.assertEqual(self.client.post('/api/ingest', content='x' * 4097, headers={**AUTH, 'content-type': 'application/json'}).status_code, 413)
        self.assertEqual(self.client.post('/api/ingest', content='x' * 4097, headers={**AUTH, 'content-type': 'application/json', 'content-length': '1'}).status_code, 413)
        for body in ([], {'node': 'tank-01'}, frame(seq=-1), frame(node='other'), frame(ph=True), frame(tds=float('inf'))):
            response = self.client.post('/api/ingest', content=json.dumps(body), headers={**AUTH, 'content-type': 'application/json'})
            self.assertEqual(response.status_code, 422, response.text)
        with patch.object(G, 'CONTROL_TOKEN', ''):
            self.assertEqual(self.client.post('/api/ingest', json=frame(), headers=AUTH).status_code, 503)
            self.assertEqual(self.client.post('/api/filters/BRITA/replace').status_code, 503)
        G._ingest_tokens, G._ingest_at = 0, time.monotonic()
        with patch.object(G, 'INGEST_RATE_PER_MINUTE', 0.000001):
            self.assertEqual(self.client.post('/api/ingest', json=frame(), headers=AUTH).status_code, 429)
        self.assertEqual(self.count('readings'), 0)

if __name__ == '__main__': unittest.main()
