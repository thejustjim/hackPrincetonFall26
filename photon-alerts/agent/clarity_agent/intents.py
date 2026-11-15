"""Rule-based answers for the common questions, used when Gemini isn't available.

Keeps Clarity feeling like a chatbot with no API key: status, what the tests mean, filters,
"when will it be fixed", greetings, and a polite no for anything that isn't about water.
"""
from __future__ import annotations

import os
import re

from .data import LiveData

WELCOME = (
    "💧 Hi, I'm Clarity\n\n"
    "I watch your water tests and text you if one fails.\n\n"
    "Ask me things like:\n"
    "• is my water ok?\n"
    "• what's TDS?\n"
    "• do I need a new filter?\n"
    "Or send a photo of a glass of your water."
)

EXPLAIN = {
    "tds": "💧 TDS (total dissolved solids)\n\nSalts and metals dissolved in the water, in ppm.\nNormal: under 300 · EPA limit: 500\n↳ High TDS tastes bad, leaves scale, and can carry contaminants.",
    "ph": "💧 pH\n\nHow acidic the water is.\nNormal: 6.5–8.5\n↳ Low pH can pull lead and copper out of pipes. High pH tastes bitter and leaves scale.",
    "clarity": "💧 Clarity\n\nHow clear the water is, from 0 to 100%.\n↳ Cloudy water has particles that can hide bacteria.",
    "retest": "💧 Retest\n\nThe same water tested again after a filter.\n↳ It shows whether the filter actually fixes the problem.",
}


def ph_is_estimated(r: dict) -> bool:
    flag = r.get("ph_est")
    if flag is True or flag == 1:
        return True
    if flag is False or flag == 0:
        return False
    return os.getenv("PH_ESTIMATED", "1").strip() != "0"


def _icon(r: dict) -> str:
    tds, ph = r.get("tds", 0), float(r.get("ph", 7))
    estimated = ph_is_estimated(r)
    if tds > 500 or (not estimated and not 6.5 <= ph <= 8.5):
        return "🚨"
    cloudy = float(r.get("clarity", 1)) < 0.7 or r.get("verdict") == "CLOUDY"
    warning = tds > 300 or cloudy or r.get("verdict") == "HIGH_TDS" or (not estimated and r.get("verdict") == "PH_WARN")
    return "⚠️" if warning else "✅"


def _status(data: LiveData) -> str:
    rows = []
    for site in data.sites():
        r, f = site["raw"], site["filtered"]
        label = " (estimated from TDS)" if ph_is_estimated(r) else ""
        row = f"{_icon(r)} {site['name']}: TDS {round(r.get('tds', 0))} · pH {float(r.get('ph', 0)):.1f}{label}"
        if f:
            row += f"\n   ↳ filtered: TDS {round(f.get('tds', 0))} {'✓' if _icon(f) == '✅' else '⚠️'}"
        rows.append(row)
    if not rows:
        return "💧 No test results yet\n\nI'll text you as soon as one comes in."
    bad = any(row.startswith(("🚨", "⚠️")) for row in rows)
    tail = "Don't drink from 🚨 sites unfiltered." if bad else "All measured readings within normal range."
    return "💧 Latest tests\n\n" + "\n".join(rows) + f"\n\n{tail}"


def _filters(data: LiveData) -> str:
    fs = data.filters()
    if not fs:
        return "🫗 No filter data yet."
    icon = {"OK": "✅", "REPLACE_SOON": "⚠️", "REPLACE": "🚨"}
    label = {"OK": "OK", "REPLACE_SOON": "replace soon", "REPLACE": "replace now"}
    names = {"ZEROWATER": "ZeroWater", "BRITA": "Brita"}
    rows = [f"{icon.get(f.get('status'), '•')} {names.get(f['filter'], f['filter'].title())}: {label.get(f.get('status'), f.get('status'))} ({f.get('liters', 0):g} L used)" for f in fs]
    return "🫗 Filters\n\n" + "\n".join(rows)


def _buy(data: LiveData) -> str:
    """Recommend a filter from the latest readings, not just list filter status."""
    worst_tds, low_ph, after = 0.0, False, None
    for site in data.sites():
        r = site["raw"]
        if float(r.get("tds", 0)) > worst_tds:
            worst_tds = float(r.get("tds", 0))
            after = site["filtered"]
        low_ph = low_ph or (not ph_is_estimated(r) and float(r.get("ph", 7)) < 6.5)
    if worst_tds > 500:
        out = (f"🫗 Get a ZeroWater filter\n\nYour water hit TDS {round(worst_tds)} ppm (limit 500).\n"
               + (f"↳ Our retest with {str(after.get('filter') or 'the filter').title().replace('Zerowater', 'ZeroWater')} brought it to {round(after.get('tds', 0))} ppm. " if after else "↳ ")
               + "Brita mostly fixes taste and won't lower TDS much.")
    elif worst_tds:
        out = (f"🫗 A Brita is enough for now\n\nTDS is {round(worst_tds)} ppm, under the 500 limit.\n"
               "↳ Brita improves taste and odor. Get ZeroWater if TDS goes over 500.")
    else:
        out = "🫗 Filters\n\nZeroWater removes almost all dissolved solids. Brita mainly improves taste.\nText me after a test and I'll recommend one."
    if low_ph:
        out += "\n\n⚠️ pH is low. Filters don't fix acidic water, so run the tap 30 sec before drinking and ask about a pipe check."
    return out + "\n\nNote: neither is certified for every contaminant. A lab test checks lead and bacteria."


def _fixed(data: LiveData) -> str:
    reports = [rep for n in data.nodes() for rep in data.node_reports(n["node"])]
    if not reports:
        return "🛠️ No update yet\n\nI'll text you when the next retest comes in."
    rep = reports[-1]
    acts = rep.get("actions") or []
    return "🛠️ Latest update\n\n" + rep.get("summary", "") + ("\n\nNext: " + "; ".join(acts[:2]) if acts else "")


RULES: list[tuple[str, object]] = [
    (r"^(hi|hey|hello|yo|sup|hiya|start)\b", lambda d: WELCOME),
    (r"\b(tds|dissolved|ppm)\b", lambda d: EXPLAIN["tds"]),
    (r"\bph\b|acid", lambda d: EXPLAIN["ph"]),
    (r"\b(clarity|cloudy|clear|murky)\b", lambda d: EXPLAIN["clarity"]),
    (r"retest|before.*after", lambda d: EXPLAIN["retest"]),
    (r"\b(buy|get|recommend|which|best|should i)\b.*\b(filter|zerowater|brita)|\bwhat filter", _buy),
    (r"filter|cartridge|zerowater|brita|replace", _filters),
    (r"fix|fixed|when|repair|update", _fixed),
    (r"photo|picture|pic|image", lambda d: "📷 Send me a photo of a clear glass of your tap water, against something white. I'll check how it looks."),
    (r"safe|ok|okay|drink|status|quality|water|test|result|reading|lead|bacteria|sick", _status),
]


def answer(text: str, data: LiveData) -> str:
    t = text.lower().strip()
    for pattern, fn in RULES:
        if re.search(pattern, t):
            out = fn(data)  # type: ignore[operator]
            if "lead" in t or "bacteria" in t:
                out += "\n\nNote: these sensors can't detect lead or bacteria directly. A certified lab test can."
            if "sick" in t:
                out += "\n\nIf you feel sick, call a doctor or Poison Control: 1-800-222-1222. In an emergency, 911."
            return out
    return "💧 I can only help with your water.\n\nTry: is my water ok? · what's TDS? · do I need a new filter?"
