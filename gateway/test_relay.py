"""Offline only: fake transport and UART, no gateway import, secrets, cloud or hardware."""
import json
import unittest
from relay import Relay, RelayHTTPError, PacketReader, endpoint, targeted_command


class Serial:
    in_waiting = 0
    def __init__(self): self.writes = []
    def write(self, wire): self.writes.append(wire); return len(wire)


def frame(**changes):
    return dict(node='tank-01', test=7, phase='before', session='bootA', seq=8, ask=1, ph_est=1, ph=7, tds=400, clarity=.9, **changes)


def response(p):
    return {'ok': True, 'duplicate': False, 'command': dict(cmd='filter', filter='BRITA', **{k:p[k] for k in ('node','test','session','seq')})}


class RelayTests(unittest.TestCase):
    def test_exact_and_duplicate(self):
        p=frame(); s=Serial(); r=Relay(s,lambda p,timeout:response(p))
        self.assertEqual(r.process_line(json.dumps(p)), 'command-sent')
        self.assertEqual(r.process_line(json.dumps(p)), 'duplicate-command')
        self.assertEqual(len(s.writes),1); self.assertTrue(s.writes[0].endswith(b'\n'))
        self.assertEqual(json.loads(s.writes[0]),response(p)['command'])

    def test_every_target_field_and_unsafe_command(self):
        p=frame()
        for key,value in [('node','tank-02'),('test',8),('session','bootB'),('seq',9),('seq',True),('seq',8.0),('filter','RETEST'),('cmd','tip')]:
            out=response(p); out['command'][key]=value
            self.assertIsNone(targeted_command(p,out),(key,value))
        for updates in ({'ask':0},{'ask':'1'},{'phase':'after'},{'phase':'pending'},{'seq':True}):
            altered={**p,**updates}; self.assertIsNone(targeted_command(altered,response(p)))
        self.assertIsNone(targeted_command(p,{**response(p),'pending':True}))

    def test_retry_same_identity_and_deadline(self):
        p=frame(); s=Serial(); calls=[]; now=[0.]
        def post(packet,timeout):
            calls.append((packet.copy(),timeout))
            if len(calls)==1: now[0]+=3; raise TimeoutError()
            return response(packet)
        r=Relay(s,post,clock=lambda:now[0]); self.assertEqual(r.process_line(json.dumps(p)),'command-sent')
        self.assertEqual(len(calls),2); self.assertEqual(calls[0][0],calls[1][0]); self.assertLessEqual(calls[1][1],6.5)
        def late(packet,timeout): now[0]+=10; return response(packet)
        self.assertEqual(Relay(s,late,clock=lambda:now[0]).process_line(json.dumps(p)),'late')
        self.assertEqual(len(s.writes),1)

    def test_uart_replay_does_not_restart_window(self):
        now=[0.]; calls=[]; s=Serial()
        def post(p,timeout): calls.append(1); raise TimeoutError()
        r=Relay(s,post,clock=lambda:now[0]); body=json.dumps(frame())
        self.assertEqual(r.process_line(body),'offline')
        now[0]=10
        self.assertEqual(r.process_line(body),'late')
        self.assertEqual(len(calls),2); self.assertEqual(s.writes,[])

    def test_permanent_errors_not_retried(self):
        for code in (301,401,403,413,415,422):
            calls=[]; s=Serial()
            def post(p,timeout): calls.append(1); raise RelayHTTPError(code)
            self.assertEqual(Relay(s,post).process_line(json.dumps(frame())),'http-rejected')
            self.assertEqual(len(calls),1); self.assertEqual(s.writes,[])
        for code in (429,500,503):
            calls=[]
            def post(p,timeout): calls.append(1); raise RelayHTTPError(code)
            self.assertEqual(Relay(Serial(),post).process_line(json.dumps(frame())),'offline')
            self.assertEqual(len(calls),2)

    def test_ambiguous_frames_and_buffered_new_data(self):
        s=Serial(); calls=[]
        r=Relay(s,lambda p,timeout:calls.append(p) or response(p))
        for line in ('{"node":"a","node":"b"}', '{"x":NaN}', '[]', 'not JSON', 'x'*4097):
            self.assertEqual(r.process_line(line),'invalid')
        self.assertEqual(calls,[])
        s.in_waiting=10; self.assertEqual(r.process_line(json.dumps(frame())),'superseded'); self.assertEqual(s.writes,[])

    def test_partial_uart_write_consumed(self):
        s=Serial(); s.write=lambda wire:0
        r=Relay(s,lambda p,timeout:response(p))
        self.assertEqual(r.process_line(json.dumps(frame())),'serial-write-failed')
        self.assertEqual(r.process_line(json.dumps(frame())),'duplicate-command')

    def test_serial_partial_and_oversize_drain(self):
        class Input:
            chunks=iter((b'{"a":',b'1}\n',b'x'*4097,b'junk\n',b'{}\n'))
            def read_until(self,*args): return next(self.chunks)
        r=PacketReader(Input())
        self.assertIsNone(r.poll()); self.assertEqual(r.poll(),b'{"a":1}\n')
        self.assertIsNone(r.poll()); self.assertIsNone(r.poll()); self.assertEqual(r.poll(),b'{}\n')

    def test_https_destination(self):
        self.assertEqual(endpoint('https://example.org/'),'https://example.org/api/ingest')
        for url in ('http://example.org','https://secret@example.org','https://example.org/?token=x','https://example.org/other',''):
            with self.assertRaises(ValueError): endpoint(url)


if __name__ == '__main__': unittest.main()
