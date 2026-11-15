"""Offline ingestion/control regressions. Uses a disposable SQLite DB and no cloud/model/serial IO.
Run: gateway/.venv/bin/python gateway/test_ingest.py
"""
import asyncio
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SANDBOX = tempfile.TemporaryDirectory(prefix="clarity-ingest-")
os.environ.update({"DB_PATH": str(Path(SANDBOX.name) / "ingest.db"), "MOCK": "1", "SIM_NODES": "0",
                   "GOOGLE_API_KEY": "", "GEMINI_API_KEY": "", "ANTHROPIC_API_KEY": "", "AI_PROVIDER": "",
                   "TIGER_DATABASE_URL": "", "DATABASE_URL": "", "INVESTIGATOR": "0"})

import gateway as G
import ingest


class Receiver:
    def __init__(self):
        self.commands = []

    def write(self, body):
        self.commands.append(json.loads(body))
        return len(body)


def frame(node="tank-01", test=5, phase="before", session="bootA", seq=1, **extra):
    value = {"node": node, "test": test, "phase": phase, "ph": 7.2, "tds": 780, "clarity": 0.95,
             "verdict": "HIGH_TDS", "filter": "ZEROWATER", "ask": 1, "ph_est": True}
    if session is not None:
        value.update(session=session, seq=seq)
    value.update(extra)
    return json.dumps(value)


class IngestionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertFalse(G.cloud_sync.enabled)
        self.assertTrue(str(G.DB_PATH).startswith(SANDBOX.name))
        with G.db_lock:
            for table in ("investigations", "tips", "filter_changes", "readings"):
                G.db.execute(f"DELETE FROM {table}")
            G.db.commit()
        G.NODES["tank-02"] = {"name": "Second test tank", "lat": 40.347, "lon": -74.655, "sim": False}
        G.device = Receiver()
        self.events, self.calls = [], []
        self.originals = {k: getattr(G, k) for k in ("broadcast", "ask_model", "ai_name", "explain_only", "report_on")}

        async def push(obj):
            self.events.append(obj)

        async def model(reading, past):
            self.calls.append(("model", reading["node"], reading["test"]))
            return {"filter": "ZEROWATER", "explanation": "Dissolved solids are high."}

        async def explain(reading, past):
            self.calls.append(("explain", reading["node"], reading["test"]))

        async def report(reading, used):
            self.calls.append(("report", reading["node"], reading["test"]))

        G.broadcast, G.ask_model, G.ai_name = push, model, lambda *args: "Gemini"
        G.explain_only, G.report_on = explain, report

    async def asyncTearDown(self):
        await self.drain()
        for key, value in self.originals.items():
            setattr(G, key, value)

    async def drain(self):
        current = asyncio.current_task()
        while pending := [t for t in asyncio.all_tasks() if t is not current and not t.done()]:
            await asyncio.gather(*pending)

    def count(self, table):
        with G.db_lock:
            return G.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]

    async def test_retransmit_has_no_duplicate_effects(self):
        original = frame()
        await asyncio.gather(G.handle_line(original), G.handle_line(original), G.handle_line(original))
        await self.drain()
        self.assertEqual(self.count("readings"), 1)
        self.assertEqual(self.count("tips"), 1)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(G.device.commands), 1)
        self.assertEqual(sum(e["type"] == "reading" for e in self.events), 1)
        command = G.device.commands[0]
        self.assertEqual((command["node"], command["test"], command["session"], command["seq"]),
                         ("tank-01", 5, "bootA", 1))
        # Restarting the ingestion code against the same DB still finds the stored identity.
        ingest.prepare_local(G.db)
        await G.handle_line(original)
        await self.drain()
        self.assertEqual(self.count("tips"), 1)
        self.assertEqual(len(self.calls), 1)

    async def test_uart_replay_with_new_sequence_is_still_one_logical_sample(self):
        await G.handle_line(frame(seq=1))
        await self.drain()
        await G.handle_line(frame(seq=2))
        await self.drain()
        self.assertEqual(self.count("readings"), 1)
        self.assertEqual(self.count("tips"), 1)
        self.assertEqual(sum(c[0] == "model" for c in self.calls), 1)
        self.assertEqual(len(G.device.commands), 1)
        await G.handle_line(frame(phase="after", seq=3, tds=4, verdict="SAFE"))
        await G.handle_line(frame(phase="after", seq=4, tds=4, verdict="SAFE"))
        await self.drain()
        self.assertEqual(self.count("readings"), 2)
        self.assertEqual(sum(c[0] == "report" for c in self.calls), 1)

    async def test_duplicate_retest_reports_only_once(self):
        await G.handle_line(frame())
        await self.drain()
        retest = frame(phase="after", seq=2, tds=4, verdict="SAFE", ask=0)
        await G.handle_line(retest)
        await G.handle_line(retest)
        await self.drain()
        self.assertEqual(self.count("readings"), 2)
        self.assertEqual(sum(c[0] == "report" for c in self.calls), 1)
        self.assertEqual(sum(c[0] == "explain" for c in self.calls), 1)
        with G.db_lock:
            tip = G.db.execute("SELECT after_id, after_tds FROM tips").fetchone()
        self.assertIsNotNone(tip["after_id"])
        self.assertEqual(tip["after_tds"], 4)

    async def test_nodes_and_reboots_do_not_collide(self):
        await G.handle_line(frame())
        await G.handle_line(frame(node="tank-02"))
        await G.handle_line(frame(session="bootB"))
        await self.drain()
        self.assertEqual(self.count("readings"), 3)
        self.assertEqual(self.count("tips"), 3)
        self.assertEqual({(x["node"], x["session"]) for x in G.device.commands},
                         {("tank-01", "bootA"), ("tank-02", "bootA"), ("tank-01", "bootB")})

    async def test_late_retest_cannot_attach_to_a_new_boot(self):
        await G.handle_line(frame(session="bootA", ph_est=False))
        await self.drain()
        await G.handle_line(frame(session="bootB", ph_est=False, tds=900))
        await self.drain()
        await G.handle_line(frame(session="bootA", seq=2, phase="after", tds=4, verdict="SAFE", ph_est=False))
        await self.drain()
        with G.db_lock:
            tips = {r["session"]: dict(r) for r in G.db.execute("SELECT * FROM tips")}
        self.assertEqual(tips["bootA"]["after_tds"], 4)
        self.assertIsNone(tips["bootB"]["after_id"])
        latest_pair = G.test_pair("tank-01", 5)
        self.assertEqual(len(latest_pair), 1)
        self.assertEqual(latest_pair[0]["session"], "bootB")
        after = G.history("tank-01")[0]
        case, _ = G.case_for("tank-01", 5, after, "ZEROWATER")
        self.assertEqual(case["before"]["session"], "bootA")
        self.assertEqual(case["before"]["tds"], 780)

    async def test_legacy_identity_and_original_history_are_preserved(self):
        old = frame(session=None, ask=0)
        await G.handle_line(old)
        await self.drain()
        # Simulate a database from the earlier firmware: identity column absent on historical rows.
        with G.db_lock:
            G.db.execute("UPDATE readings SET ingest_key=NULL")
            G.db.commit()
        await G.handle_line(old)
        await G.handle_line(frame(phase="after", session=None, tds=4, verdict="SAFE"))
        await self.drain()
        self.assertEqual(self.count("readings"), 2)
        self.assertEqual(self.count("tips"), 1)
        self.assertEqual(len(self.calls), 3)  # first explanation + after explanation/report

    async def test_per_reading_provenance_survives_storage_and_api(self):
        stamp = "2026-11-15T02:00:00+00:00"
        await G.handle_line(frame(ask=0, ph_est=0, sender_ms=999, measured_ts=stamp,
                                  temp=22.2, fault=2, odd=1, v=2))
        await self.drain()
        reading = G.readings("tank-01")[0]
        self.assertIs(reading["ph_est"], False)
        self.assertEqual(reading["ts"], stamp)
        self.assertEqual(reading["measured_ts"], stamp)
        self.assertIsNotNone(reading["received_ts"])
        self.assertEqual((reading["sender_ms"], reading["temp"], reading["fault"], reading["odd"], reading["v"]),
                         (999, 22.2, 2, 1, 2))
        self.assertNotIn("ingest_key", reading)
        self.assertEqual(G.get_site_history("tank-01")[0]["ph_est"], False)
        self.assertEqual(G.nodes()[0]["latest"]["session"], "bootA")

    async def test_legacy_report_input_may_omit_optional_provenance(self):
        await G.handle_line(frame(session=None, ask=0))
        await self.drain()
        await G.handle_line(frame(session=None, phase="after", tds=4, verdict="SAFE"))
        await self.drain()
        after = G.history("tank-01")[0]
        legacy = {k: after[k] for k in (*G.CORE_READING_KEYS, "node", "id", "filter")}
        case, _ = G.case_for("tank-01", 5, legacy, "ZEROWATER")
        self.assertEqual(case["after"]["tds"], 4)
        self.assertIsNone(case["after"]["ph_est"])
        self.assertIsNone(case["after"]["session"])
        self.assertIsNone(case["after"]["seq"])
        self.assertEqual(case["before"]["tds"], 780)
        incomplete = {k: v for k, v in legacy.items() if k != "tds"}
        with self.assertRaises(KeyError):
            G.case_for("tank-01", 5, incomplete, "ZEROWATER")

    async def test_estimated_ph_does_not_make_a_water_warning(self):
        await G.handle_line(frame(ph=5.0, tds=140, verdict="PH_WARN", filter="NONE", ask=0, ph_est=True))
        await self.drain()
        reading = G.history("tank-01")[0]
        self.assertEqual(reading["verdict"], "SAFE")
        self.assertEqual(reading["device_verdict"], "PH_WARN")
        # Explicit measurement wins over an estimated-pH deployment default.
        await G.handle_line(frame(test=6, seq=2, ph=5.0, tds=140, verdict="PH_WARN", filter="NONE", ask=0, ph_est=False))
        await self.drain()
        self.assertEqual(G.history("tank-01")[0]["verdict"], "PH_WARN")

    async def test_malformed_identity_does_not_store_or_dispatch(self):
        for data in (frame(seq=1.5), frame(test=5.7), frame(seq=True), frame(ph_est="unknown"), frame(session="bad/session")):
            await G.handle_line(data)
        missing_pair = json.loads(frame())
        del missing_pair["seq"]
        await G.handle_line(json.dumps(missing_pair))
        await self.drain()
        self.assertEqual(self.count("readings"), 0)
        self.assertEqual(self.calls, [])
        self.assertEqual(G.device.commands, [])

    async def test_manual_commands_target_only_the_current_real_test(self):
        await G.handle_line(frame(ask=0))
        await self.drain()
        G.device.commands.clear()
        result = G.manual_cmd(5, "BRITA", "tank-01")
        self.assertEqual(result, {"ok": True, "node": "tank-01", "test": 5})
        self.assertEqual(G.device.commands[0], {"cmd": "filter", "node": "tank-01", "test": 5,
                                              "filter": "BRITA", "session": "bootA", "seq": 1})
        for node, test, status in (("missing", 5, 404), ("tank-02", 5, 409), ("tank-01", 50, 409)):
            with self.assertRaises(G.HTTPException) as failure:
                G.manual_cmd(test, "BRITA", node)
            self.assertEqual(failure.exception.status_code, status)
        await G.handle_line(frame(phase="after", seq=2, tds=4, verdict="SAFE"))
        await self.drain()
        with self.assertRaises(G.HTTPException) as failure:
            G.manual_cmd(5, "BRITA", "tank-01")
        self.assertEqual(failure.exception.status_code, 409)
        self.assertEqual(len(G.device.commands), 1)


class MigrationTests(unittest.TestCase):
    def test_dotenv_legacy_ph_setting_loads_before_analysis(self):
        # Stub only the dotenv loader; never read the user's saved secrets. This reproduces a
        # deployment configured through .env rather than shell variables in a fresh interpreter.
        script = """
import os, sys, types
sys.path.insert(0, sys.argv[1])
loader = types.ModuleType('dotenv')
loader.load_dotenv = lambda path: os.environ.setdefault('PH_ESTIMATED', '0')
sys.modules['dotenv'] = loader
import gateway
assert gateway.analysis.PH_ESTIMATED is False
assert gateway.cloud_sync.enabled is False
gateway.db.close()
"""
        env = {**os.environ, "DB_PATH": str(Path(SANDBOX.name) / "config.db")}
        env.pop("PH_ESTIMATED", None)
        run = subprocess.run([sys.executable, "-c", script, str(Path(__file__).resolve().parent)],
                             env=env, text=True, capture_output=True, timeout=15)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    def test_additive_migration_keeps_existing_duplicate_history(self):
        old = sqlite3.connect(":memory:")
        old.execute("CREATE TABLE readings (id INTEGER PRIMARY KEY, node TEXT, test INTEGER, phase TEXT, ph REAL)")
        old.executemany("INSERT INTO readings VALUES(?,?,?,?,?)", [(1,"tank-01",5,"before",7.0),(2,"tank-01",5,"before",7.0)])
        ingest.prepare_local(old)
        ingest.prepare_local(old)
        self.assertEqual(old.execute("SELECT count(*) FROM readings").fetchone()[0], 2)
        self.assertIn("ph_est", {r[1] for r in old.execute("PRAGMA table_info(readings)")})
        self.assertTrue(all(x[0] is None for x in old.execute("SELECT ph_est FROM readings")))
        old.close()


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        G.db.close()
        SANDBOX.cleanup()
