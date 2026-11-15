"""Offline checks of the one-filter rig and of the fallback tank: every filtered cup goes to the
Brita, and a quiet tank can be stood in for by its own recorded pours. No key, no network, no serial.
Run: gateway/.venv/bin/python gateway/test_fallback.py
"""
import json
import os
import random
import tempfile
from pathlib import Path

SANDBOX = tempfile.TemporaryDirectory(prefix="clarity-fallback-")
os.environ.pop("FILTERS", None)
os.environ.update({"DB_PATH": str(Path(SANDBOX.name) / "fallback.db"), "MOCK": "1", "SIM_NODES": "0",
                   "GOOGLE_API_KEY": "", "GEMINI_API_KEY": "", "ANTHROPIC_API_KEY": "", "AI_PROVIDER": "",
                   "TIGER_DATABASE_URL": "", "DATABASE_URL": "", "INVESTIGATOR": "0"})

import analysis   # noqa: E402
import gateway as G   # noqa: E402
import ingest   # noqa: E402
import mock   # noqa: E402

# ---- one filter on the rig
assert ingest.FITTED == ("BRITA",)
assert [ingest.fitted(f) for f in ("ZEROWATER", "BRITA", "NONE")] == ["BRITA", "BRITA", "NONE"]
assert mock.verdict_for(7.2, 780, 0.95) == ("HIGH_TDS", "BRITA")
assert mock.verdict_for(7.2, 210, 0.42) == ("CLOUDY", "BRITA")
assert mock.verdict_for(7.2, 180, 0.96) == ("SAFE", "NONE")
old_sketch = {"node": "tank-01", "test": 1, "phase": "before", "ph": 7.5, "tds": 780, "clarity": 0.95,
              "verdict": "HIGH_TDS", "filter": "ZEROWATER"}
reading, problem = G.clean_reading(old_sketch)
assert problem is None and reading["filter"] == "BRITA", "a sketch that still names ZeroWater is recorded as the Brita"
assert G.checked('{"filter":"ZEROWATER","explanation":"High dissolved solids."}', "test")["filter"] == "BRITA"
assert [f["filter"] for f in G.filter_life()] == ["BRITA"], "only the fitted filter has a life to show"
assert "ZEROWATER" not in G.SYSTEM and G.SCHEMA["properties"]["filter"]["enum"] == ["BRITA", "NONE"]

# a Brita barely moves dissolved solids, and clears cloudy water
rng = random.Random(4)
for _ in range(50):
    _, tds, clr = mock.after_filter(7.5, 780, 0.95, "BRITA", rng=rng)
    assert 0.95 * 780 - 1 <= tds <= 780 and clr >= 0.95, (tds, clr)
    _, tds, clr = mock.after_filter(7.0, 210, 0.42, "BRITA", rng=rng)
    assert tds <= 210 and 0.86 <= clr <= 0.95, (tds, clr)

# the report names what the filter was sent for, and says so when the retest is still out of range
before = {"ph": 7.5, "tds": 780, "clarity": 0.95, "verdict": "HIGH_TDS", "ph_est": True, "phase": "before"}
after = {"ph": 7.4, "tds": 760, "clarity": 0.95, "verdict": "HIGH_TDS", "ph_est": True, "phase": "after"}
case = {"filter": "BRITA", "before": before, "after": after}
result = analysis.analyse(before, [])
summary = analysis.rule_report(case, result, [])["summary"]
assert "dissolved solids from 780 ppm to 760 ppm" in summary and "still out of range" in summary, summary

# ---- replay of recorded pours
log = Path(SANDBOX.name) / "tank.jsonl"
def sent(t, test, phase, tds, clarity, verdict, filt, **more):
    line = {"node": "tank-01", "test": test, "phase": phase, "ph": 7.2, "tds": tds, "clarity": clarity,
            "verdict": verdict, "filter": filt, "rssi": -60, "session": "pi-boot-1", "seq": test * 2 + (phase == "after"),
            "ph_est": 1, "ask": 1, **more}
    return json.dumps({"t": t, "line": json.dumps(line)})
log.write_text("\n".join([
    json.dumps({"t": 990, "line": '{"type":"receiver_ready"}'}),
    sent(1000, 7, "before", 212, 0.96, "SAFE", "NONE"),
    sent(1000.4, 7, "before", 212, 0.96, "SAFE", "NONE"),            # the radio sent it twice
    sent(4600, 8, "before", 233, 0.41, "CLOUDY", "BRITA"),           # an hour later
    sent(4672, 8, "after", 229, 0.88, "SAFE", "NONE"),
    sent(4700, 3, "after", 5, 0.9, "SAFE", "NONE"),                  # a retest whose first reading was not recorded
    json.dumps({"t": 4701, "line": '{"node":"sim-01","test":1,"phase":"before","ph":7,"tds":200,"clarity":0.9,"verdict":"SAFE","filter":"NONE"}'}),
    "not json",
]) + "\n")
rows = mock.load_log(log)
assert [(d["test"], d["phase"]) for _, d in rows] == [(7, "before"), (8, "before"), (8, "after")], rows


class Clock:
    now = 0.0
    def __call__(self):
        return self.now


clock = Clock()
dev = mock.MockDevice(period=25, scenario="replay", seed=26, session="replay-session", clock=clock,
                      sleeper=lambda _: None, log=log)
out = []
for tick in range(0, 1400):                       # 140 seconds, in tenths
    clock.now = tick / 10
    raw = dev.readline()
    if raw:
        out.append((clock.now, json.loads(raw)))
first_pass = out[:3]
assert [(d["test"], d["phase"], d["tds"], d["clarity"]) for _, d in first_pass] == \
    [(1, "before", 212, 0.96), (2, "before", 233, 0.41), (2, "after", 229, 0.88)], first_pass
assert [t for t, _ in first_pass] == [3.0, 28.0, 53.0], "an hour's wait is cut to the period; 72 s to the period too"
assert all(d["session"] == "replay-session" and d["ask"] == 0 for _, d in out)
assert [d["seq"] for _, d in out] == list(range(1, len(out) + 1)), "each replayed line gets a new identity"
assert len(out) >= 6 and out[3][1]["test"] == 3 and out[3][1]["tds"] == 212, "the recording comes round again as new pours"
for _, d in out:
    cleaned, why = G.clean_reading(d)
    assert why is None and cleaned["filter"] in ("BRITA", "NONE"), (why, d)

try:
    mock.MockDevice(scenario="replay", log=Path(SANDBOX.name) / "none.jsonl")
    raise AssertionError("a replay with nothing recorded must say so")
except ValueError as e:
    assert "recorded pours" in str(e)

# ---- the recorder keeps the real receiver's lines, and nothing when the tank is the mock
assert G.RECORD == "", "a mock run records nothing"
G.RECORD = str(Path(SANDBOX.name) / "logs" / "kept.jsonl")
G.record('{"node":"tank-01","test":1,"phase":"before","ph":7.1,"tds":190,"clarity":0.97,"verdict":"SAFE","filter":"NONE"}')
G.RECORD = ""
kept = mock.load_log(Path(SANDBOX.name) / "logs" / "kept.jsonl")
assert len(kept) == 1 and kept[0][1]["tds"] == 190 and kept[0][0] > 1e9

print("PASS one filter (Brita) at every choice point, an honest Brita retest, replay of recorded pours, and the recorder")
