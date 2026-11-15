"""Offline checks of the estimated week a new tank is given to be read against. No key, network or serial.
Run: gateway/.venv/bin/python gateway/test_baseline.py
"""
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SANDBOX = tempfile.TemporaryDirectory(prefix="clarity-baseline-")
for k in ("FILTERS", "BASELINE_DAYS", "BASELINE_TDS"):
    os.environ.pop(k, None)
os.environ.update({"DB_PATH": str(Path(SANDBOX.name) / "baseline.db"), "MOCK": "0", "SIM_NODES": "0",
                   "GOOGLE_API_KEY": "", "GEMINI_API_KEY": "", "ANTHROPIC_API_KEY": "", "AI_PROVIDER": "",
                   "TIGER_DATABASE_URL": "", "DATABASE_URL": "", "INVESTIGATOR": "0"})

import baseline   # noqa: E402
import gateway as G   # noqa: E402

# ---- the estimate itself
now = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
week = baseline.estimate(days=7, now=now)
assert len(week) == 168 and week == baseline.estimate(days=7, now=now), "a fixed seed and clock repeat the week"
assert [r["ts"] for r in week] == sorted(r["ts"] for r in week) and week[-1]["ts"] < now.isoformat()
assert (now - datetime.fromisoformat(week[0]["ts"])).days in (6, 7)
assert all(0.55 * 160 - 1 <= r["tds"] <= 1.45 * 160 + 1 and r["tds"] < 300 and 0.86 <= r["clarity"] <= 1.0 for r in week), "every pour in range"
assert len({r["tds"] for r in week}) > 20, "not a flat line: a stuck-sensor check must not trip on it"
assert baseline.estimate(days=7, now=now, tds=220)[0]["tds"] != week[0]["tds"]
assert max(r["tds"] for r in baseline.estimate(days=7, now=now, tds=280)) < 300, "a hard-water tank still gets an in-range week"

# ---- seeding the tank's database
G.BASELINE_DAYS = 0
assert G.seed_baseline() == 0 and G.history("tank-01") == [], "BASELINE_DAYS=0 leaves the database alone"
G.BASELINE_DAYS = 7
assert G.seed_baseline() == 168
assert G.seed_baseline() == 0, "seeding happens once per database"
rows = G.db.execute("SELECT * FROM readings WHERE node='tank-01' ORDER BY id").fetchall()
assert len(rows) == 168
assert all(r["session"] == baseline.SESSION and r["phase"] == "before" and r["verdict"] == "SAFE" and r["filter"] == "NONE"
           and r["ai_filter"] == "NONE" and r["source"] == "local_rule" and r["ph_est"] == 1 and not r["sim"] for r in rows)
assert [r["ts"] for r in rows] == sorted(r["ts"] for r in rows), "oldest first, so the newest estimate has the highest id"
assert G.health()["estimated_history"] == 168
assert G.filter_life()[0]["tips"] == 0, "an estimated week uses no filter"


def pour(test, tds, clarity, verdict):
    msg, why = G.clean_reading({"node": "tank-01", "test": test, "phase": "before", "ph": 7.1, "tds": tds, "clarity": clarity,
                                "verdict": verdict, "filter": "NONE", "ph_est": 1, "session": "tank-boot", "seq": test})
    assert why is None
    reading = {**msg, "ts": G.now_iso(), "received_ts": G.now_iso(), "lat": None, "lon": None, "sim": False,
               "ai_filter": None, "explanation": None}
    reading["anomaly"] = G.anomaly_score("tank-01", reading)
    assert G.store(reading) is not None
    return reading, G.analyse_reading(reading)


# an ordinary cup of tap water is read against the week, at this time of day, and is usual for the site
for test, (tds, clarity) in enumerate([(160, 0.96), (125, 0.99), (190, 0.9), (200, 1.0)], 1):
    reading, result = pour(test, tds, clarity, "SAFE")
    assert result["kind"] == "normal", (tds, clarity, result["kind"], result["lead"])
    assert reading["anomaly"] < 0.6, (tds, clarity, reading["anomaly"])
tds_row = next(r for r in result["baseline"] if r["metric"] == "tds")
assert tds_row["source"] == "history" and tds_row["n"] >= 30 and 140 <= tds_row["median"] <= 180, tds_row
assert result["scope"]["kind"] == "time_of_day", result["scope"]

# and a salty one stands out against it
reading, result = pour(9, 780, 0.95, "HIGH_TDS")
assert result["kind"] != "normal" and result["lead"]["metric"] == "tds" and reading["anomaly"] == 1.0, (result["kind"], result["lead"])

# a tank that already has a few pours of its own is given a week centred on them
G.db.execute("DELETE FROM readings"); G.db.commit()
for test, tds in enumerate([232, 240, 236, 228], 1):
    pour(test, tds, 0.97, "SAFE")
assert G.seed_baseline() == 168
seeded = [r["tds"] for r in G.db.execute("SELECT tds FROM readings WHERE session=?", (baseline.SESSION,))]
assert 215 <= sorted(seeded)[len(seeded) // 2] <= 250, "centred on what this tank reads for its own water"

print("PASS an in-range estimated week, seeded once and marked, read at the time of day; tap water usual, salt unusual")
