"""Seeded fake Clarity hardware, with the same addressed JSON contract as the receiver.

MOCK=1 uses it in gateway.py. MOCK_SCENARIO chooses cycle (default), duplicate,
sensor-fault, drift, regional, close-call or replay. replay plays back pours the real tank
sent earlier (MOCK_LOG, by default the gateway's own recording in logs/tank.jsonl), so a
silent tank can be stood in for by its own readings; the others are estimates. MOCK_SEED=26 repeats the values; each boot
still gets a fresh session so restarting a simulation does not reuse measurement identities.
MOCK_PERIOD controls seconds between pours (default 25). Nothing here moves hardware.
"""
import json
import os
import random
import sys
import time
import uuid

from ingest import fitted

# clean and tea are what the tank's own sensors read on 15 Nov 2026: clean water 202-204 ppm at
# transparency 1.00, water that was not clear 219 ppm at 0.59-0.61. salty and close-call are made up.
CUPS = {"clean": (7.1, 203, 1.0), "salty": (7.6, 780, 0.95), "tea": (7.14, 219, 0.60),
        "close-call": (7.3, 300, 0.95)}
SCENARIOS = ("cycle", "duplicate", "sensor-fault", "drift", "regional", "close-call", "replay")
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "tank.jsonl")
TDS_LIMIT, CLARITY_LIMIT, PH_LOW, PH_HIGH = 300, 0.70, 6.5, 8.5


def verdict_for(ph, tds, clarity):
    if tds > TDS_LIMIT:
        return "HIGH_TDS", fitted("ZEROWATER")
    if clarity < CLARITY_LIMIT:
        return "CLOUDY", "BRITA"
    if ph < PH_LOW or ph > PH_HIGH:
        return "PH_WARN", "NONE"
    return "SAFE", "NONE"


def estimated_ph(tds):
    return round(7.0 + min(1.0, max(0.0, (tds - 150) / 650)) * 1.3, 2)


def jitter(ph, tds, clarity, rng=None):
    rng = rng or random
    return (round(ph + rng.uniform(-0.15, 0.15), 2), max(0, int(tds * rng.uniform(0.93, 1.07))),
            round(min(1.0, max(0.0, clarity + rng.uniform(-0.02, 0.02))), 2))


def line(node, test, phase, ph, tds, clarity, verdict, filt, rssi=None, rng=None, **metadata):
    rng = rng or random
    d = {"node": node, "test": test, "phase": phase, "ph": ph, "tds": tds,
         "clarity": clarity, "verdict": verdict, "filter": filt,
         "rssi": rssi if rssi is not None else rng.randint(-78, -52)}
    d.update(metadata)
    return json.dumps(d, separators=(",", ":"))


def after_filter(ph, tds, clarity, filt, wear=0, rng=None):
    """An illustrative filter response, not a measured efficacy model."""
    rng = rng or random
    if filt == "ZEROWATER":
        return round(ph - rng.uniform(0.6, 1.0), 2), rng.randint(0, 2) + wear, round(min(1.0, clarity + 0.03), 2)
    if filt == "BRITA":
        # carbon: dissolved solids barely move; cloudy or coloured water comes back clearer
        return round(ph - 0.1, 2), int(tds * rng.uniform(0.95, 1.0)), round(max(clarity, rng.uniform(0.86, 0.95)), 2)
    return ph, tds, clarity


def load_log(path, node="tank-01"):
    """Recorded receiver lines -> [(epoch seconds or None, reading)] for one node, in order.
    Reads the gateway's recording ({"t": epoch, "line": "<what the receiver sent>"} per line)
    and plain captures of the serial port (one JSON reading per line). A retest is kept only
    if its first reading is in the recording, and a line sent twice is kept once."""
    rows, open_tests, seen = [], set(), set()
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except OSError:
        return rows
    for text in lines:
        try:
            d, t = json.loads(text), None
            if isinstance(d, dict) and "line" in d:
                t, d = float(d["t"]), json.loads(d["line"])
            if not isinstance(d, dict) or d.get("node") != node or d.get("phase") not in ("before", "after"):
                continue
            float(d["ph"]), float(d["tds"]), float(d["clarity"])
            key = (d.get("session"), int(d["test"]))
        except (ValueError, TypeError, KeyError):
            continue
        if (key, d["phase"]) in seen or (d["phase"] == "after" and key not in open_tests):
            continue
        seen.add((key, d["phase"]))
        open_tests.add(key)
        rows.append((t, d))
    return rows


class MockDevice:
    """Serial-like readline/write, with injectable time for no-wait deterministic tests."""

    def __init__(self, node="tank-01", period=None, seed=None, scenario=None, session=None,
                 clock=None, sleeper=None, ph_estimated=True, log=None):
        self.node = node
        self.period = float(os.getenv("MOCK_PERIOD", "25")) if period is None else period
        self.scenario = scenario or os.getenv("MOCK_SCENARIO", "cycle")
        if self.scenario not in SCENARIOS or self.period <= 0:
            raise ValueError("MOCK_SCENARIO or MOCK_PERIOD is not valid")
        self.rng = random.Random(int(os.getenv("MOCK_SEED", "26")) if seed is None else seed)
        self.clock, self.sleeper = clock or time.time, sleeper or time.sleep
        self.started = self.clock()
        self.session = session or uuid.uuid4().hex[:16]
        self.seq, self.test = 0, 0
        self.ph_estimated = bool(ph_estimated)
        self.queue, self.ai_choice, self.before_identity = [], {}, {}
        self.next_test_at = self.started + 3
        self.cup_cycle = ["clean", "salty", "tea"]
        self.zw_runs = 0
        self.recorded = []
        if self.scenario == "replay":
            path = str(log or os.getenv("MOCK_LOG") or LOG_PATH)
            self.recorded = load_log(path, node)
            if not self.recorded:
                raise ValueError("MOCK_SCENARIO=replay needs recorded pours: none in " + path)

    def write(self, data: bytes):
        try:
            msg = json.loads(data.decode().strip())
            test = msg.get("test")
            identity = self.before_identity.get(test) if type(test) is int else None
            if (msg.get("cmd") != "filter" or msg.get("node") != self.node or test != self.test
                    or identity is None or msg.get("filter") not in ("NONE", "ZEROWATER", "BRITA")
                    or self.clock() > identity["deadline"]):
                return len(data)
            # Every mock reading is session-aware, like the new Feather packets. Missing,
            # partial or malformed identity must not be accepted as a legacy command.
            seq = msg.get("seq")
            if (msg.get("session") != self.session or type(seq) is not int
                    or not 0 <= seq <= 0xffffffff or seq != identity["seq"]
                    or identity.get("answered", False)):
                return len(data)
            self.ai_choice[test] = msg["filter"]
            identity["answered"] = True             # a second command cannot change the first choice
        except (ValueError, TypeError, UnicodeError, AttributeError):
            pass
        return len(data)

    def _encode(self, node, test, phase, ph, tds, clr, verdict, filt, now, ask=0):
        self.seq += 1
        if self.ph_estimated:
            ph = estimated_ph(tds)
        text = line(node, test, phase, ph, tds, clr, verdict, filt, rng=self.rng,
                    session=self.session, seq=self.seq, ph_est=int(self.ph_estimated), ask=ask,
                    sender_ms=max(0, int((now - self.started) * 1000)) & 0xffffffff)
        if phase == "before" and node == self.node:
            self.before_identity[test] = {"seq": self.seq, "deadline": now + 10.5}
            # The serial simulator need not keep every old command identity forever.
            self.before_identity = {k: v for k, v in self.before_identity.items() if k >= test - 2}
        return text

    def _schedule_replay(self, now):
        """Queue one pass over the recording and return how long it lasts. The gaps between
        lines are the recorded ones, but never longer than the period, so idle hours are skipped."""
        at, last, first, numbers = now, None, True, {}
        for t, d in self.recorded:
            key = (d.get("session"), int(d["test"]))
            if d["phase"] == "before":
                self.test += 1
                numbers[key] = self.test
            if not first:
                gap = t - last if t is not None and last is not None else (15 if d["phase"] == "after" else self.period)
                at += min(max(gap, 0.3), self.period)
            first, last = False, t
            self.queue.append((at, ("REPLAY", numbers[key], d)))
        return at - now

    def _replayed(self, test, d, now):
        """A recorded reading as this session's own: the values as the tank sent them, a new
        identity, and no question for the model (the filter is the one the tank's rule chose)."""
        self.seq += 1
        out = {k: v for k, v in d.items() if k not in ("measured_ts", "received_ts")}
        out.update(test=test, session=self.session, seq=self.seq, ask=0,
                   sender_ms=max(0, int((now - self.started) * 1000)) & 0xffffffff)
        return json.dumps(out, separators=(",", ":"))

    def _schedule_test(self, now):
        self.test += 1
        cup = "close-call" if self.scenario == "close-call" else self.cup_cycle[(self.test - 1) % len(self.cup_cycle)]
        ph, tds, clr = jitter(*CUPS[cup], rng=self.rng)
        if self.scenario == "sensor-fault":
            ph, tds, clr = 7.2, 233, round(self.rng.uniform(0.94, 0.98), 3)
        elif self.scenario == "drift":
            ph, tds, clr = 7.2, 200 + max(0, self.test - 10) * 2 + self.rng.randrange(-2, 3), round(self.rng.uniform(0.94, 0.98), 3)
        elif self.scenario == "regional":
            ph, tds, clr = 7.2, (200 if self.test <= 10 else 520) + self.rng.randrange(-8, 9), round(self.rng.uniform(0.94, 0.98), 3)
            # Send peer observations before the tank, so a report can see the same event.
            for peer in ("sim-01", "sim-02"):
                pt = tds + self.rng.randrange(-8, 9)
                pv, pf = verdict_for(estimated_ph(pt), pt, clr)
                self.queue.append((now, self._encode(peer, self.test, "before", ph, pt, clr, pv, pf, now)))
        if self.ph_estimated:
            ph = estimated_ph(tds)
        v, f = verdict_for(ph, tds, clr)
        ask = int(abs(tds - TDS_LIMIT) <= 45 or abs(clr - CLARITY_LIMIT) <= 0.08 or (tds > TDS_LIMIT and clr < CLARITY_LIMIT))
        before = self._encode(self.node, self.test, "before", ph, tds, clr, v, f, now, ask)
        self.queue.append((now, before))
        if self.scenario == "duplicate":
            self.queue.append((now + 0.3, before))       # exactly the same identity and body, not a new reading
        if f != "NONE":
            self.queue.append((now + 15, ("AFTER", self.test, ph, tds, clr, f)))

    def readline(self) -> bytes:
        now = self.clock()
        if now >= self.next_test_at:
            if self.scenario == "replay":
                self.next_test_at = now + self._schedule_replay(now) + self.period
            else:
                self._schedule_test(now)
                self.next_test_at = now + self.period
        self.queue.sort(key=lambda x: x[0])
        if self.queue and self.queue[0][0] <= now:
            _, item = self.queue.pop(0)
            if isinstance(item, tuple) and item[0] == "REPLAY":
                item = self._replayed(item[1], item[2], now)
            elif isinstance(item, tuple):
                _, test, ph, tds, clr, rule_f = item
                f = self.ai_choice.pop(test, rule_f)
                ph2, tds2, clr2 = after_filter(ph, tds, clr, f, wear=self.zw_runs // 2, rng=self.rng)
                if f == "ZEROWATER":
                    self.zw_runs += 1
                if self.ph_estimated:
                    ph2 = estimated_ph(tds2)
                v2, _ = verdict_for(ph2, tds2, clr2)
                item = self._encode(self.node, test, "after", ph2, tds2, clr2, v2, "NONE", now)
            return (item + "\n").encode()
        self.sleeper(0.2)
        return b""


if __name__ == "__main__":
    dev = MockDevice()
    print('{"type":"receiver_ready"}')
    while True:
        out = dev.readline()
        if out:
            sys.stdout.write(out.decode())
            sys.stdout.flush()
