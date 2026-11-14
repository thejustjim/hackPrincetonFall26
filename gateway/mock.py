"""Fake TapTest hardware. Produces exactly the lines the receiver ESP32 prints.

Run on its own to see the format:   python mock.py
The gateway uses it with:           MOCK=1 python gateway.py
"""
import json
import random
import sys
import time

# Demo cups we pour at the table: name -> (ph, tds, clarity)
CUPS = {
    "clean": (7.4, 140, 0.97),
    "salty": (7.6, 780, 0.95),
    "tea":   (6.9, 210, 0.42),
}
TDS_LIMIT, CLARITY_LIMIT, PH_LOW, PH_HIGH = 300, 0.70, 6.5, 8.5


def verdict_for(ph, tds, clarity):
    if tds > TDS_LIMIT:
        return "HIGH_TDS", "ZEROWATER"
    if clarity < CLARITY_LIMIT:
        return "CLOUDY", "BRITA"
    if ph < PH_LOW or ph > PH_HIGH:
        return "PH_WARN", "NONE"
    return "SAFE", "NONE"


def jitter(ph, tds, clarity):
    return (round(ph + random.uniform(-0.15, 0.15), 2),
            max(0, int(tds * random.uniform(0.93, 1.07))),
            round(min(1.0, max(0.0, clarity + random.uniform(-0.03, 0.03))), 2))


def line(node, test, phase, ph, tds, clarity, verdict, filt, rssi=None):
    d = {"node": node, "test": test, "phase": phase, "ph": ph, "tds": tds,
         "clarity": clarity, "verdict": verdict, "filter": filt,
         "rssi": rssi if rssi is not None else random.randint(-78, -52)}
    return json.dumps(d, separators=(",", ":"))


def after_filter(ph, tds, clarity, filt):
    """What the water looks like after the filter (rough real behaviour)."""
    if filt == "ZEROWATER":   # strips nearly all dissolved solids, pH drifts a bit acidic
        return round(ph - random.uniform(0.6, 1.0), 2), random.randint(0, 15), round(min(1.0, clarity + 0.03), 2)
    if filt == "BRITA":       # carbon clears colour, small TDS drop
        return round(ph - 0.1, 2), int(tds * 0.9), round(random.uniform(0.86, 0.95), 2)
    return ph, tds, clarity


class MockDevice:
    """Behaves like the receiver serial port: readline() and write()."""

    def __init__(self, node="tank-01", period=25.0):
        self.node, self.period = node, period
        self.test = 0
        self.queue = []          # (time_due, line)
        self.ai_choice = {}      # test -> filter chosen by the gateway
        self.next_test_at = time.time() + 3
        self.cup_cycle = ["clean", "salty", "tea"]

    def write(self, data: bytes):
        try:
            msg = json.loads(data.decode().strip())
            if msg.get("cmd") == "filter":
                self.ai_choice[msg["test"]] = msg["filter"]
        except Exception:
            pass

    def _schedule_test(self, now):
        self.test += 1
        cup = self.cup_cycle[(self.test - 1) % len(self.cup_cycle)]
        ph, tds, clr = jitter(*CUPS[cup])
        v, f = verdict_for(ph, tds, clr)
        self.queue.append((now, line(self.node, self.test, "before", ph, tds, clr, v, f)))
        if f != "NONE":
            # retest ~15 s later, using the AI's choice if it answered
            self.queue.append((now + 15, ("AFTER", self.test, ph, tds, clr, f)))

    def readline(self) -> bytes:
        """Blocking-ish: returns one line, or b'' after a short wait."""
        now = time.time()
        if now >= self.next_test_at:
            self._schedule_test(now)
            self.next_test_at = now + self.period
        self.queue.sort(key=lambda x: x[0])
        if self.queue and self.queue[0][0] <= now:
            _, item = self.queue.pop(0)
            if isinstance(item, tuple):
                _, test, ph, tds, clr, rule_f = item
                f = self.ai_choice.get(test, rule_f)
                ph2, tds2, clr2 = after_filter(ph, tds, clr, f)
                v2, _ = verdict_for(ph2, tds2, clr2)
                item = line(self.node, test, "after", ph2, tds2, clr2, v2, "NONE")
            return (item + "\n").encode()
        time.sleep(0.2)
        return b""


if __name__ == "__main__":
    dev = MockDevice(period=8)
    print('{"type":"receiver_ready"}')
    while True:
        out = dev.readline()
        if out:
            sys.stdout.write(out.decode())
            sys.stdout.flush()
