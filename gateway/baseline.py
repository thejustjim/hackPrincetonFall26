"""A week of estimated history for a tank that has none.

The checks read every pour against the site's own past (analysis.py), and a tank switched on
for the first time has no past to be read against. estimate() writes one: tap water in range,
a pour every hour, dissolved solids a little higher in the afternoon. These are
estimates, not measurements. Every row carries the session "baseline-est", so it can be told
apart from what the tank sent, is left out of the cloud copy, and can be removed:

    sqlite3 taptest.db "DELETE FROM readings WHERE session = 'baseline-est'"

The gateway seeds it once, at startup, for a tank with no estimated rows yet (BASELINE_DAYS,
default 7; 0 turns it off). BASELINE_TDS sets what tap water reads on this tank; without it
the centre is the median of the tank's own in-range pours if it has a few, else 160 ppm.
"""
import math
import random
from datetime import datetime, timedelta, timezone

SESSION = "baseline-est"
TDS, CLARITY = 160, 0.95          # tap water on this tank, where nothing better is known
EVERY_HOURS = 1                    # hourly: enough pours at each time of day for a steady spread


def estimate(days=7, now=None, tds=TDS, clarity=CLARITY, seed=26, every_hours=EVERY_HOURS):
    """-> [{"ts", "tds", "clarity"}], oldest first, the last one about an hour before `now`.
    Dissolved solids swing about 4% through the day around `tds`, with about 18% of scatter.
    The scatter is wide on purpose: what the tank really reads for tap water is not known in
    advance, and tap water a quarter either side of the centre should still read as usual."""
    rng = random.Random(seed)
    now = now or datetime.now(timezone.utc)
    out = []
    for k in range(int(days * 24 / every_hours), 0, -1):
        at = now - timedelta(hours=k * every_hours, minutes=rng.uniform(-40, 40))
        local_hour = at.astimezone().hour + at.minute / 60
        swing = 1 + 0.04 * math.sin(2 * math.pi * (local_hour - 9) / 24)        # highest mid-afternoon
        value = tds * swing * (1 + rng.gauss(0, 0.18))
        out.append({"ts": at.isoformat(),
                    "tds": int(round(min(1.45 * tds, 295, max(0.55 * tds, value)))),      # never over the 300 ppm line
                    "clarity": round(min(1.0, max(0.86, rng.gauss(clarity, 0.035))), 2)})
    out.sort(key=lambda r: r["ts"])
    return out
