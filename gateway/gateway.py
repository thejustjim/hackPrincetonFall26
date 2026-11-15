"""Clarity base station (runs on the Raspberry Pi 4B, or any laptop).

Reads JSON lines from the receiver ESP32 over USB serial, adds time, location and an
anomaly score, stores everything in SQLite, asks Claude which filter to use (and why),
sends that decision back to the tank over the radio, and pushes it all to the dashboard.

Run:
    pip install -r requirements.txt
    MOCK=1 python gateway.py                    # no hardware: fake tank + simulated nodes
    SERIAL_PORT=/dev/ttyUSB0 python gateway.py  # real receiver
Then open http://<pi-ip>:8000/docs  (REST)  and  ws://<pi-ip>:8000/ws  (live feed).

Env vars (also read from ../.env or ./.env; see .env.example):
    ANTHROPIC_API_KEY   optional. Without it the gateway uses the local rule only.
    SERIAL_PORT         default: first /dev/ttyUSB* or /dev/ttyACM*
    MOCK=1              use mock.py instead of a serial port
    SIM_NODES=12        number of simulated Princeton nodes (0 to turn off)
    AI_TIMEOUT=6        seconds to wait for Claude before the tank uses its own rule
    LITERS_PER_TIP=0.1  water through a filter each time the cup tips
    INVESTIGATOR=0      turn off the deepagents report after each "after" test
    CONTROL_TOKEN       secret for the routes that move the cup or reset a filter. Without it,
                        only this machine may call them.
    ALLOW_UNKNOWN_NODES=1  accept readings from node ids that are not in NODES
    DB_PATH=taptest.db
"""
import asyncio
import glob
import hmac
import json
import math
import os
import random
import re
import sqlite3
import statistics
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import analysis
import cloud
import guidance
import mock

try:  # secrets live in .env (git-ignored), never in the code
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

MOCK = os.getenv("MOCK") == "1"
SIM_NODES = int(os.getenv("SIM_NODES", "12"))
AI_TIMEOUT = float(os.getenv("AI_TIMEOUT", "6"))
DB_PATH = os.getenv("DB_PATH", "taptest.db")
MODEL = "claude-opus-5-5"

# ---------------------------------------------------------------- nodes
# The real tank plus simulated nodes around Princeton. Simulated ones are flagged "sim": true.
NODES = {
    "tank-01": {"name": "Clarity demo (HackPrinceton)", "lat": 40.3467, "lon": -74.6553, "sim": False},
}
SIM_SITES = [
    ("Carnegie Lake", 40.3380, -74.6380, 180), ("Kingston", 40.3762, -74.6143, 230),
    ("Rocky Hill", 40.3990, -74.6385, 260), ("Lawrenceville", 40.2973, -74.7296, 210),
    ("Plainsboro", 40.3335, -74.5927, 170), ("Hopewell (well)", 40.3893, -74.7621, 420),
    ("Penns Neck", 40.3290, -74.6370, 190), ("Montgomery (well)", 40.4268, -74.6810, 380),
    ("West Windsor", 40.2915, -74.6360, 200), ("Witherspoon St", 40.3530, -74.6640, 150),
    ("Princeton Junction", 40.3168, -74.6235, 220), ("Mercer Oaks", 40.2770, -74.6760, 240),
    ("Stony Brook", 40.3302, -74.6890, 310), ("Griggstown", 40.4395, -74.6119, 290),
]
for i, (name, lat, lon, base) in enumerate(SIM_SITES[:SIM_NODES]):
    NODES[f"sim-{i+1:02d}"] = {"name": name, "lat": lat, "lon": lon, "sim": True, "base_tds": base}

# ---------------------------------------------------------------- database
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, node TEXT, test INTEGER, phase TEXT,
    ph REAL, tds INTEGER, clarity REAL, verdict TEXT, filter TEXT, ai_filter TEXT,
    rssi INTEGER, lat REAL, lon REAL, sim INTEGER, anomaly REAL, explanation TEXT)""")
# one row per cup tipped into a filter; after_* is filled when the retest comes in
db.execute("""CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, node TEXT, test INTEGER, filter TEXT,
    liters REAL, source TEXT, after_id INTEGER, after_tds INTEGER)""")
db.execute("""CREATE TABLE IF NOT EXISTS filter_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, node TEXT, filter TEXT)""")
db.execute("""CREATE TABLE IF NOT EXISTS investigations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, node TEXT, test INTEGER, reading_id INTEGER,
    filter TEXT, summary TEXT, findings TEXT, actions TEXT, model TEXT)""")
if "extra" not in [c[1] for c in db.execute("PRAGMA table_info(investigations)")]:
    # the verdict of the checks, the checks themselves, what each agent said, and the notice (JSON)
    db.execute("ALTER TABLE investigations ADD COLUMN extra TEXT")
db.commit()
db_lock = threading.Lock()

# Optional: copy everything to a cloud Postgres (Tiger Cloud on AWS). Off unless TIGER_DATABASE_URL is set.
# SQLite here stays the source of truth; see cloud.py.
cloud_sync = cloud.CloudSync(DB_PATH, mock=MOCK, nodes=NODES)
cloud_sync.prepare_local(db)

COLS = ["id", "ts", "node", "test", "phase", "ph", "tds", "clarity", "verdict", "filter",
        "ai_filter", "rssi", "lat", "lon", "sim", "anomaly", "explanation"]


def row_to_dict(r):
    d = dict(r)
    d["sim"] = bool(d["sim"])
    return d


def history(node, n=50):
    with db_lock:
        rows = db.execute("SELECT * FROM readings WHERE node=? ORDER BY id DESC LIMIT ?", (node, n)).fetchall()
    return [row_to_dict(r) for r in rows]


# ---------------------------------------------------------------- anomaly score
TYPICAL = {"ph": (7.5, 0.5), "tds": (180, 120), "clarity": (0.95, 0.06)}


def anomaly_score(node, reading):
    """0 = normal for this node, 1 = very unusual. Robust z-score against the node's own history."""
    past = [h for h in history(node, 50) if h["phase"] == "before"]
    zs = []
    for k in ("ph", "tds", "clarity"):
        vals = [h[k] for h in past if h[k] is not None]
        if len(vals) >= 5:
            med = statistics.median(vals)
            mad = statistics.median([abs(v - med) for v in vals]) * 1.4826 or TYPICAL[k][1] / 3
        else:
            med, mad = TYPICAL[k]
        zs.append(abs(reading[k] - med) / mad)
    return round(min(1.0, max(zs) / 6), 2)


# ---------------------------------------------------------------- filter life
LITERS_PER_TIP = float(os.getenv("LITERS_PER_TIP", "0.1"))   # one cup through the filter
FILTERS = {
    "ZEROWATER": {"name": "ZeroWater", "replace_tds": 6,
                  "rule": "Replace when filtered water reads 6 ppm or more (ZeroWater's own rule)"},
    "BRITA": {"name": "Brita Elite", "rated_liters": 450,
              "rule": "Rated for about 450 L: REPLACE_SOON at 90%, REPLACE at 100%"},
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()   # microseconds, so tips and changes order cleanly


def record_tip(reading, filt, source):
    with db_lock:
        db.execute("INSERT INTO tips (ts, node, test, filter, liters, source) VALUES (?,?,?,?,?,?)",
                   (now_iso(), reading["node"], reading["test"], filt, LITERS_PER_TIP, source))
        db.commit()


def attach_after(reading):
    """Link an "after" retest to the tip it followed. Returns the filter used, or None."""
    with db_lock:
        tip = db.execute("SELECT id, filter FROM tips WHERE node=? AND test=? AND after_id IS NULL "
                         "ORDER BY id DESC LIMIT 1", (reading["node"], reading["test"])).fetchone()
        if tip:
            db.execute("UPDATE tips SET after_id=?, after_tds=? WHERE id=?",
                       (reading["id"], reading["tds"], tip["id"]))
            db.commit()
    return tip["filter"] if tip else None


def filter_life(node="tank-01"):
    out = []
    for key, spec in FILTERS.items():
        with db_lock:
            ch = db.execute("SELECT ts FROM filter_changes WHERE node=? AND filter=? ORDER BY id DESC LIMIT 1",
                            (node, key)).fetchone()
            since = ch["ts"] if ch else ""
            used = db.execute("SELECT COUNT(*) AS n, COALESCE(SUM(liters), 0) AS l FROM tips "
                              "WHERE node=? AND filter=? AND ts>=?", (node, key, since)).fetchone()
            last = db.execute("SELECT test, after_tds FROM tips WHERE node=? AND filter=? AND ts>=? "
                              "AND after_tds IS NOT NULL ORDER BY id DESC LIMIT 1", (node, key, since)).fetchone()
        liters = round(used["l"], 2)
        item = {"node": node, "filter": key, "name": spec["name"], "installed_at": since or None,
                "tips": used["n"], "liters": liters, "liters_per_tip": LITERS_PER_TIP,
                "last_after_test": last["test"] if last else None,
                "last_after_tds": last["after_tds"] if last else None, "rule": spec["rule"]}
        if key == "ZEROWATER":
            # ZeroWater's rule: once filtered water reads 006 the filter is spent (stays REPLACE until swapped)
            with db_lock:
                bad = db.execute("SELECT test, after_tds FROM tips WHERE node=? AND filter=? AND ts>=? "
                                 "AND after_tds>=? ORDER BY id LIMIT 1",
                                 (node, key, since, spec["replace_tds"])).fetchone()
            item.update(replace_at_tds=spec["replace_tds"], status="REPLACE" if bad else "OK",
                        reason=f"after test {bad['test']} read {bad['after_tds']} ppm" if bad else None)
        else:
            rated = spec["rated_liters"]
            frac = liters / rated
            item.update(rated_liters=rated, liters_left=round(max(0.0, rated - liters), 2),
                        percent_used=round(100 * frac, 2),
                        status="REPLACE" if frac >= 1 else "REPLACE_SOON" if frac >= 0.9 else "OK")
        out.append(item)
    return out


def all_filters():
    return [f for key, n in NODES.items() if not n["sim"] for f in filter_life(key)]


# ---------------------------------------------------------------- published reference data
REFERENCE_PATH = Path(__file__).with_name("reference.json")   # written by fetch_reference.py


def load_reference():
    try:
        return json.loads(REFERENCE_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------- the decision agent (Gemini or Claude)
SYSTEM = (
    "You are the decision agent inside Clarity, a water tester with two filters: ZEROWATER "
    "(ion exchange: removes dissolved solids, the choice for high TDS) and BRITA (activated carbon: "
    "certified for chlorine taste and fine particles; this device also sends cloudy or coloured "
    "water to it, which is the team's rule rather than a certified claim). You get one water test "
    "plus that site's recent history. Choose the filter the cup should be tipped into, or NONE if "
    "all three readings are in range or no filter helps (neither filter corrects pH). Then explain "
    "the result to a non-expert in at most three short sentences, mentioning the numbers that "
    "mattered and one practical next step. Guidance: TDS above 300 ppm is high (EPA secondary "
    "standard 500), pH should be 6.5 to 8.5, clarity is 0 to 1 where 1 is as clear as clean water. "
    "The device measures only pH, dissolved solids and clarity. It cannot detect bacteria, lead or "
    "any specific contaminant, so never say the water is safe or tell anyone to drink it: say the "
    "readings are in range or out of range."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "filter": {"type": "string", "enum": ["ZEROWATER", "BRITA", "NONE"]},
        "explanation": {"type": "string"},
    },
    "required": ["filter", "explanation"],
    "additionalProperties": False,
}

# Which model answers. Gemini (Google's Gemini API) when GOOGLE_API_KEY or GEMINI_API_KEY is set,
# otherwise Claude when ANTHROPIC_API_KEY is set, otherwise none: the tank's own rule decides and
# reports are written from the checks. AI_PROVIDER=google|anthropic chooses when both keys are set.
GOOGLE_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
AI_PROVIDER = (os.getenv("AI_PROVIDER") or ("google" if GOOGLE_KEY else "anthropic" if os.getenv("ANTHROPIC_API_KEY") else "")).lower()
GEMINI_CHOICES = [m for m in (os.getenv("GEMINI_MODEL"), "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash",
                              "gemini-3.5-flash-lite") if m]


def pick_gemini_model(client):
    """The first model on our list that this key can use. Asking is free and saves a refused first pour."""
    try:
        have = {m.name.split("/")[-1] for m in client.models.list(config={"http_options": {"timeout": 8000}})}
    except Exception as e:
        print("could not list Gemini models, using", GEMINI_CHOICES[0], "-", type(e).__name__)
        return GEMINI_CHOICES[0]
    return next((m for m in GEMINI_CHOICES if m in have), GEMINI_CHOICES[0])


claude = gemini = AI_MODEL = None
if AI_PROVIDER == "google" and GOOGLE_KEY:
    from google import genai
    gemini = genai.Client(api_key=GOOGLE_KEY)
    AI_MODEL = pick_gemini_model(gemini)
elif AI_PROVIDER == "anthropic" and os.getenv("ANTHROPIC_API_KEY"):
    from anthropic import AsyncAnthropic
    claude = AsyncAnthropic()
    AI_MODEL = MODEL
elif AI_PROVIDER:
    print(f"AI_PROVIDER={AI_PROVIDER} but its key is not set: the tank's own rule will decide")


def ai_name():
    return "Gemini" if gemini is not None else "Claude" if claude is not None else None


def decision_prompt(reading, past):
    recent = [{k: h[k] for k in ("ts", "phase", "ph", "tds", "clarity", "verdict")} for h in past[:8]]
    return (f"Site: {NODES.get(reading['node'], {}).get('name', reading['node'])}\n"
            f"New test: {json.dumps({k: reading[k] for k in ('phase', 'ph', 'tds', 'clarity', 'verdict', 'filter')})}\n"
            f"Anomaly score vs this site's history (0-1): {reading['anomaly']}\n"
            f"Recent history (newest first): {json.dumps(recent)}")


def checked(text, who):
    """A model's answer is used only if it is the JSON we asked for and names a real filter."""
    try:
        result = json.loads(text) if text else None
    except json.JSONDecodeError:
        print(f"{who}'s answer was not JSON:", (text or "")[:120])
        return None
    if not isinstance(result, dict) or result.get("filter") not in ("ZEROWATER", "BRITA", "NONE"):
        return None
    return result


async def ask_claude(reading, past):
    """Returns {"filter", "explanation"} or None."""
    if claude is None:
        return None
    resp = await claude.beta.messages.create(
        model=MODEL,
        max_tokens=4000,           # thinking is always on for this model and counts against this
        system=SYSTEM,
        messages=[{"role": "user", "content": decision_prompt(reading, past)}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if resp.stop_reason != "end_turn":          # refusal, max_tokens, ...: let the tank's rule decide
        print("Claude gave no decision:", resp.stop_reason)
        return None
    return checked(next((b.text for b in resp.content if b.type == "text"), None), "Claude")


async def ask_gemini(reading, past):
    """Returns {"filter", "explanation"} or None."""
    if gemini is None:
        return None
    resp = await gemini.aio.models.generate_content(
        model=AI_MODEL,
        contents=decision_prompt(reading, past),
        config={"system_instruction": SYSTEM, "response_mime_type": "application/json", "max_output_tokens": 4000,
                "response_json_schema": {k: v for k, v in SCHEMA.items() if k != "additionalProperties"}},
    )
    text = resp.text                               # None when the answer was blocked or cut off
    if not text:
        print("Gemini gave no decision:", getattr(resp.candidates[0], "finish_reason", None) if resp.candidates else resp.prompt_feedback)
        return None
    return checked(text, "Gemini")


async def ask_model(reading, past):
    """Whichever model is configured. Returns {"filter", "explanation"} or None."""
    return await (ask_gemini if gemini is not None else ask_claude)(reading, past)


# ---------------------------------------------------------------- live push
clients: set[WebSocket] = set()


async def broadcast(msg):
    dead = []
    for ws in clients:
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


# ---------------------------------------------------------------- pipeline
device = None  # serial port or MockDevice


def send_to_tank(obj):
    if device is None:
        return
    try:
        device.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
    except Exception as e:
        print("send to tank failed:", e)


def store(reading):
    with db_lock:
        cur = db.execute(
            f"INSERT INTO readings ({','.join(COLS[1:])}) VALUES ({','.join('?' * (len(COLS) - 1))})",
            [reading.get(c) for c in COLS[1:]])
        db.commit()
        reading["id"] = cur.lastrowid
    return reading


VERDICTS = ("SAFE", "HIGH_TDS", "CLOUDY", "PH_WARN")
ALLOW_UNKNOWN_NODES = os.getenv("ALLOW_UNKNOWN_NODES") == "1"


def clean_reading(msg):
    """-> (reading, None) with typed, range-checked fields, or (None, why it was dropped).
    The radio link is open, so anything can arrive on it."""
    try:
        node, phase = str(msg["node"]), msg["phase"]
        test = int(msg["test"])
        ph, tds, clarity = float(msg["ph"]), float(msg["tds"]), float(msg["clarity"])
    except (KeyError, TypeError, ValueError):
        return None, "missing or non-numeric field"
    if node not in NODES and not ALLOW_UNKNOWN_NODES:
        return None, f"unknown node {node!r} (add it to NODES or set ALLOW_UNKNOWN_NODES=1)"
    if phase not in ("before", "after") or test < 0:
        return None, "bad phase or test number"
    if not (0 <= ph <= 14 and 0 <= tds <= 5000 and -0.05 <= clarity <= 1.5):
        return None, "value outside what the sensors can read"
    if msg.get("verdict") not in VERDICTS:
        return None, "unknown verdict"
    rssi = msg.get("rssi")
    return {"node": node, "test": test, "phase": phase, "ph": round(ph, 2), "tds": int(round(tds)),
            "clarity": round(min(1.0, max(0.0, clarity)), 2), "verdict": msg["verdict"],
            "filter": msg.get("filter") if msg.get("filter") in ("ZEROWATER", "BRITA", "NONE") else "NONE",
            "rssi": int(rssi) if isinstance(rssi, (int, float)) else None}, None


async def handle_line(raw: str):
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        print("not JSON:", raw)
        return
    if not isinstance(msg, dict) or "ph" not in msg:          # receiver_ready, errors, echoes
        print("info:", msg)
        return
    msg, problem = clean_reading(msg)
    if msg is None:
        print("dropped reading:", problem, "|", raw[:140])
        return
    node = NODES.get(msg["node"], {"lat": None, "lon": None, "sim": False})
    reading = {
        **msg,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "lat": node["lat"], "lon": node["lon"], "sim": node["sim"],
        "ai_filter": None, "explanation": None,
    }
    reading["anomaly"] = anomaly_score(msg["node"], reading)
    past = history(msg["node"], 8)
    store(reading)
    await broadcast({"type": "reading", **reading})
    print("reading:", {k: reading[k] for k in ("node", "test", "phase", "ph", "tds", "clarity", "verdict", "anomaly")})

    # Before-filter tests from the real tank: the agent decides, the tank acts.
    if reading["phase"] == "before" and not reading["sim"]:
        asyncio.create_task(decide(reading, past))
    elif not reading["sim"]:
        # Retest after filtering: update filter life, explain, and investigate.
        used = attach_after(reading)
        await broadcast({"type": "filters", "filters": filter_life(reading["node"])})
        asyncio.create_task(explain_only(reading, past))
        asyncio.create_task(report_on(reading, used))


async def decide(reading, past):
    try:
        result = await asyncio.wait_for(ask_model(reading, past), timeout=AI_TIMEOUT)
    except Exception as e:
        print("AI decision skipped:", type(e).__name__, e)
        result = None
    if result:
        send_to_tank({"cmd": "filter", "test": reading["test"], "filter": result["filter"]})
        source = ai_name().lower()
        await save_explanation(reading, result["filter"], result["explanation"], source=source)
        used = result["filter"]
    else:
        # Uno falls back to its own rule; we record the same rule here
        await save_explanation(reading, reading["filter"], None, source="local_rule")
        used, source = reading["filter"], "local_rule"
    if used in FILTERS:   # the tank tips the cup into this filter
        record_tip(reading, used, source)
        await broadcast({"type": "filters", "filters": filter_life(reading["node"])})


async def explain_only(reading, past):
    try:
        result = await asyncio.wait_for(ask_model(reading, past), timeout=20)
    except Exception:
        result = None
    if result:
        await save_explanation(reading, None, result["explanation"], source=ai_name().lower())


async def save_explanation(reading, ai_filter, explanation, source):
    with db_lock:
        db.execute("UPDATE readings SET ai_filter=?, explanation=? WHERE id=?",
                   (ai_filter, explanation, reading["id"]))
        db.commit()
    await broadcast({"type": "decision", "id": reading["id"], "node": reading["node"],
                     "test": reading["test"], "phase": reading["phase"], "ai_filter": ai_filter,
                     "explanation": explanation, "source": source})


# ---------------------------------------------------------------- deepagents investigator
# Tools the investigator can call. Docstrings are what the agent reads.
READING_KEYS = ("ts", "test", "phase", "ph", "tds", "clarity", "verdict", "anomaly")


def km_between(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    h = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def get_site_history(node: str, limit: int = 20) -> list[dict]:
    """Recent readings for one node, newest first. Fields: ts, test, phase ("before" = raw
    water, "after" = retest after filtering), ph, tds (ppm), clarity (0-1, 1 = clear),
    verdict, anomaly (0-1, how unusual vs this node's own history)."""
    return [{k: r[k] for k in READING_KEYS} for r in history(node, max(1, min(int(limit), 100)))]


def get_nearby_nodes(node: str, radius_km: float = 8.0) -> list[dict]:
    """Other monitoring nodes within radius_km of this node, nearest first, each with its
    latest reading. sim=true means a simulated node, not a real measurement."""
    here = NODES.get(node)
    if not here:
        return []
    out = []
    for key, n in NODES.items():
        if key == node:
            continue
        d = km_between(here["lat"], here["lon"], n["lat"], n["lon"])
        if d <= radius_km:
            latest = history(key, 1)
            out.append({"node": key, "name": n["name"], "sim": n["sim"], "km": round(d, 1),
                        "latest": {k: latest[0][k] for k in READING_KEYS} if latest else None})
    return sorted(out, key=lambda x: x["km"])


def get_filter_life() -> list[dict]:
    """Filter usage and status for the tank: liters through each filter (about 0.1 L per tip).
    ZeroWater is REPLACE once an after test reads 6 ppm or more (ZeroWater's own rule).
    Brita Elite is rated for about 450 L."""
    return all_filters()


def get_reference_data() -> dict:
    """Published water data near Princeton (USGS and NJ DEP samples via the Water Quality
    Portal) for Stony Brook, Millstone River and Lake Carnegie: latest sample and typical
    TDS, estimated as 0.65 x specific conductance. These are past samples, not live data."""
    ref = load_reference()
    if not ref:
        return {"error": "no reference data cached (run fetch_reference.py)"}
    return {"source": ref["source"], "note": ref["note"], "sites": [
        {k: s[k] for k in ("name", "lat", "lon", "latest", "typical_tds_ppm", "typical_period",
                           "n_samples", "first_date", "last_date")} for s in ref["sites"]]}


# ---------------------------------------------------------------- layered detection (analysis.py)
def peers_for(node, radius_km=8.0):
    """Nearby nodes, each with its latest raw-water reading and the ones before it."""
    here, out = NODES.get(node), []
    for key, n in NODES.items():
        if not here or key == node:
            continue
        d = km_between(here["lat"], here["lon"], n["lat"], n["lon"])
        if d <= radius_km:
            rows = [h for h in history(key, 40) if h["phase"] == "before"]      # newest first
            if rows:
                out.append({"node": key, "name": n["name"], "sim": n["sim"], "km": round(d, 1),
                            "reading": rows[0], "history": rows[:0:-1]})
    return out


def raw_reading(node, test=None, before_id=None):
    """The raw-water ("before") reading of one test at a node, or the node's latest one."""
    q, args = "SELECT * FROM readings WHERE node=? AND phase='before'", [node]
    if test is not None:
        q, args = q + " AND test=?", args + [int(test)]
    if before_id is not None:
        q, args = q + " AND id<?", args + [before_id]
    with db_lock:
        row = db.execute(q + " ORDER BY id DESC LIMIT 1", args).fetchone()
    return row_to_dict(row) if row else None


def analyse_reading(reading):
    """Every layer of analysis.py for one raw-water reading: sensor checks, baseline, peers, verdict."""
    with db_lock:
        rows = db.execute("SELECT * FROM readings WHERE node=? AND id<? ORDER BY id DESC LIMIT 150",
                          (reading["node"], reading["id"])).fetchall()
    return analysis.analyse(reading, [row_to_dict(r) for r in reversed(rows)], peers_for(reading["node"]))


def case_for(node, test, after=None, filter_used=None):
    """One filter run: its before and after readings, the filter used and the checks' verdict."""
    before = raw_reading(node, test, after["id"] if after else None)
    if before is None:
        return None, None
    with db_lock:
        if after is None:
            row = db.execute("SELECT * FROM readings WHERE node=? AND test=? AND phase='after' AND id>? "
                             "ORDER BY id LIMIT 1", (node, before["test"], before["id"])).fetchone()
            after = row_to_dict(row) if row else None
        if filter_used is None and after is not None:
            tip = db.execute("SELECT filter FROM tips WHERE after_id=?", (after["id"],)).fetchone()
            filter_used = tip["filter"] if tip else None
    result = analyse_reading(before)
    case = {"node": node, "site": NODES.get(node, {}).get("name"), "test": before["test"], "filter": filter_used,
            "before": {k: before[k] for k in READING_KEYS}, "after": {k: after[k] for k in READING_KEYS} if after else None,
            "checks": {"kind": result["kind"], "verdict": result["kind_words"], "severity": result["severity_words"],
                       "evidence": result["evidence"]}}
    return case, result


# More tools for the investigator's specialists. Each returns numbers worked out by analysis.py.
def get_case(node: str, test: int) -> dict:
    """The filter run under investigation: the before and after readings of one test at a node
    (verdict SAFE means in range), the filter used, the verdict of the gateway's statistical
    checks with its evidence, and the notice template that fits the outcome."""
    case, result = case_for(node, test)
    if case is None:
        return {"error": f"no reading for node {node} test {test}"}
    if case["after"]:
        case["notice_template"] = analysis.notice_template(case, result)
    return case


def get_sensor_checks(node: str, test: int) -> dict:
    """Whether each sensor can be believed for this test: status ok, check or fault per reading
    (pH, tds, clarity) with the reason. A fault means the reading is not a water event."""
    reading = raw_reading(node, test)
    if reading is None:
        return {"error": f"no reading for node {node} test {test}"}
    result = analyse_reading(reading)
    return {"sensor": result["sensor"], "verdict": result["kind_words"]}


def get_baseline(node: str, test: int) -> dict:
    """This test against the node's own history. Per reading: value, the node's median and
    spread (sigma) over n earlier pours, z (spreads from the median; 3 or more is unusual),
    and EWMA and CUSUM control charts with their limits (a signal means a small shift that
    has persisted). Also the multivariate distance across all three (3.4 or more is unusual)
    and repeat: how many pours in a row were unusual the same way."""
    reading = raw_reading(node, test)
    if reading is None:
        return {"error": f"no reading for node {node} test {test}"}
    result = analyse_reading(reading)
    return {k: result[k] for k in ("baseline", "multivariate", "lead", "repeat", "kind_words", "severity_words")}


def get_peer_comparison(node: str, test: int) -> dict:
    """Did the neighbours move too? scope is regional (at least two nearby nodes, and at least
    half of them, are unusual the same way), local, or unknown (no neighbours). Each node has
    its value, its z against its own history and sim=true when it is simulated."""
    reading = raw_reading(node, test)
    if reading is None:
        return {"error": f"no reading for node {node} test {test}"}
    result = analyse_reading(reading)
    return {"compared": analysis.LABEL[result["lead"]["metric"]], "direction": result["lead"]["direction"], **result["peers"]}


def query_readings(sql: str) -> list[dict] | dict:
    """Run one read-only SQL SELECT over the `readings` table; up to 200 rows come back.
    Columns: id, ts (UTC), node, test, phase ('before' = raw water, 'after' = retest), ph,
    tds (ppm), clarity (0-1), verdict ('SAFE' means in range; 'HIGH_TDS', 'CLOUDY', 'PH_WARN'),
    filter, ai_filter, sim (1 = simulated node), anomaly (0-1).
    Example: SELECT phase, count(*), round(avg(tds)) FROM readings WHERE node='tank-01' GROUP BY phase"""
    text = (sql or "").strip().rstrip(";")
    if ";" in text or not re.match(r"(?is)^(select|with)\b", text):
        return {"error": "only a single SELECT statement is allowed"}
    ro = None
    try:
        ro = sqlite3.connect(Path(DB_PATH).resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
        ro.row_factory = sqlite3.Row
        steps = [0]

        def tick():                                  # give up on a query that runs away
            steps[0] += 1
            return steps[0] > 3000
        ro.set_progress_handler(tick, 1000)
        return [dict(r) for r in ro.execute(text).fetchmany(200)]
    except sqlite3.Error as e:
        return {"error": str(e)}
    finally:
        if ro is not None:
            ro.close()


def search_guidance(query: str) -> list[dict]:
    """Search published guidance: EPA documents on monitoring water quality in distribution
    systems, responding to contamination, flushing and risk communication; the issue papers
    AWWA and American Water prepared for EPA on water mains, water age, storage, leaching and
    ageing pipes; and the team's notes on the filter makers' replacement rules. Returns up to
    three passages, each with its document, who prepared it, year, page and URL. When you use
    one, name the document and the page."""
    return guidance.search(query, 3)


def get_notice_templates() -> dict:
    """The fixed notice templates, by outcome, and the sentence every notice must end with,
    word for word. Blanks: {site}, {problem}, {filter}."""
    return {"templates": analysis.NOTICE_TEMPLATES, "required_last_sentence": analysis.NOTICE_REQUIRED}


# Tools for the incident team, which works on the simulated network (localize.py). The scenario's
# true pipe is never in what they return: the agents see what a utility would see.
def trace_scenario(scenario_id: str) -> dict:
    """One simulated event on the simulated pipe network: which sensors alerted and when, which
    stayed quiet, and the pipes the upstream trace ranks most likely (each with its share of
    the weight, how well its timing fits in minutes, its synthetic attributes and the reasons),
    plus the junctions downstream of the leading pipe. Everything here is simulated."""
    import localize
    sc = next((x for x in localize.scenarios() if x["id"] == scenario_id), None)
    if sc is None:
        return {"error": f"no scenario {scenario_id!r}", "scenarios": [x["id"] for x in localize.scenarios()]}
    traced = localize.localize(sc["alerts"], sc["quiet"])
    traced["affected"] = {k: v for k, v in traced["affected"].items() if k != "nodes"}
    return {"scenario": sc["id"], "name": sc["name"], "alerts": sc["alerts"], "quiet": sc["quiet"], **traced}


def get_pipe(pipe_id: str) -> dict:
    """One pipe of the simulated network: its ends in the direction of flow, length, diameter,
    travel time, and its synthetic material, install year, break count and hand-set risk score."""
    import localize
    return localize.pipe(str(pipe_id)) or {"error": f"no pipe {pipe_id!r}"}


def get_incident_notice(scenario_id: str) -> dict:
    """The fixed draft notice for a simulated event. Its last two sentences must be kept word for word."""
    import incident
    try:
        return {"notice": incident.report(scenario_id)["notice"], "keep_exactly": incident.NOTICE_REQUIRED}
    except Exception:
        return {"error": f"no scenario {scenario_id!r}"}


INCIDENT_TOOLS = [trace_scenario, get_pipe, search_guidance, get_incident_notice]
INVESTIGATOR_TOOLS = [get_site_history, get_nearby_nodes, get_filter_life, get_reference_data, get_case,
                      get_sensor_checks, get_baseline, get_peer_comparison, query_readings, search_guidance,
                      get_notice_templates]
investigator_agent = None
if ai_name() and os.getenv("INVESTIGATOR", "1") != "0":
    try:
        import investigator
        investigator_agent = investigator.build({f.__name__: f for f in INVESTIGATOR_TOOLS},
                                                provider=AI_PROVIDER, model=AI_MODEL if gemini is not None else None, key=GOOGLE_KEY)
    except Exception as e:
        print("investigator off:", type(e).__name__, e)
incident_agent = None
if investigator_agent is not None:
    try:
        incident_agent = investigator.build({f.__name__: f for f in INCIDENT_TOOLS}, provider=AI_PROVIDER,
                                            model=AI_MODEL if gemini is not None else None, key=GOOGLE_KEY, incident=True)
    except Exception as e:
        print("incident team off:", type(e).__name__, e)
investigate_lock = asyncio.Lock()   # one report at a time; later ones wait their turn


async def save_report(after, filter_used, report, extra, model):
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db_lock:
        cur = db.execute(
            "INSERT INTO investigations (ts, node, test, reading_id, filter, summary, findings, actions, model, extra) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ts, after["node"], after["test"], after["id"], filter_used, report["summary"],
             json.dumps(report["findings"]), json.dumps(report["actions"]), model, json.dumps(extra)))
        db.commit()
    await broadcast(report_message(cur.lastrowid, ts, after["node"], after["test"], after["id"],
                                   filter_used, report, model, extra))


async def report_on(after, filter_used):
    """Every retest gets a report at once, written from the checks by fixed rules, so the page
    never waits on a model. If the investigator is on, its agents then write a fuller one for
    the same pour, which takes the first one's place on the page."""
    case, result = case_for(after["node"], after["test"], after, filter_used or "NONE")
    if case is None:
        return
    rules = analysis.rule_report(case, result, filter_life(after["node"]))
    extra = {"source": "rules", "kind": result["kind"], "kind_words": result["kind_words"],
             "severity": rules["severity"], "severity_words": analysis.SEVERITY_WORDS[rules["severity"]],
             "checks": result, "notice": analysis.notice_for(case, result, case["site"]), "sections": []}
    await save_report(after, filter_used, rules, extra, None)
    if investigator_agent is None:
        return
    async with investigate_lock:
        t0 = time.time()
        try:
            report = await asyncio.wait_for(investigator.investigate(investigator_agent, case), timeout=240)
        except Exception as e:
            print("investigation failed:", type(e).__name__, e)
            return
        if not report.get("summary"):
            return
        notice = report.get("notice") if analysis.notice_ok(report.get("notice")) else extra["notice"]
        print(f"report for {after['node']} test {after['test']} in {time.time() - t0:.0f}s "
              f"from {len(report['sections'])} specialists")
        await save_report(after, filter_used, report,
                          {**extra, "source": "deepagents", "notice": notice, "sections": report["sections"]},
                          AI_MODEL or investigator.MODEL)


def report_message(rid, ts, node, test, reading_id, filter_used, report, model, extra=None):
    extra = extra or {}
    return {"type": "report", "id": rid, "ts": ts, "node": node, "test": test,
            "reading_id": reading_id, "filter": filter_used, "summary": report["summary"],
            "findings": report["findings"], "actions": report["actions"],
            "source": extra.get("source", "deepagents"), "model": model,
            **{k: extra.get(k) for k in ("kind", "kind_words", "severity", "severity_words", "checks", "notice", "sections")}}


# ---------------------------------------------------------------- input sources
def open_device():
    if MOCK:
        print("MOCK mode: fake tank-01")
        return mock.MockDevice()
    import serial
    port = os.getenv("SERIAL_PORT")
    if not port:
        found = find_serial_ports()
        if not found:
            raise SystemExit("No receiver found. Plug in the ESP32, set SERIAL_PORT, or run with MOCK=1")
        port = found[0]
        if len(found) > 1:
            print(f"several serial devices: {found}. Using {port}; set SERIAL_PORT if that is not the receiver.")
    print("reading receiver on", port)
    return serial.Serial(port, 115200, timeout=0.5)


def find_serial_ports():
    """Serial devices, the receiver first. The receiver ESP32 is a USB-serial bridge (ttyUSB on
    Linux; cu.usbserial, cu.SLAB_USBtoUART or cu.wchusbserial on a Mac). An Arduino Uno shows up
    as ttyACM / cu.usbmodem, so those come last: plugging the Uno into the same machine must not
    make the gateway read the wrong board."""
    patterns = ["/dev/ttyUSB*", "/dev/cu.usbserial*", "/dev/cu.SLAB_USBtoUART*", "/dev/cu.wchusbserial*",
                "/dev/ttyACM*", "/dev/cu.usbmodem*"]
    return [p for pattern in patterns for p in sorted(glob.glob(pattern))]


def reader_thread(loop):
    buf = b""
    while True:
        try:
            chunk = device.readline()
        except Exception as e:
            print("serial error:", e)
            time.sleep(1)
            continue
        if not chunk:
            continue
        buf += chunk
        if buf.endswith(b"\n"):
            text = buf.decode(errors="ignore").strip()
            buf = b""
            if text:
                asyncio.run_coroutine_threadsafe(handle_line(text), loop)


async def simulate_nodes():
    """Simulated network around Princeton, one reading per node about every 20 s."""
    sims = [(k, v) for k, v in NODES.items() if v["sim"]]
    tests = {k: 0 for k, _ in sims}
    while sims:
        for key, n in sims:
            tests[key] += 1
            t = time.time() / 600 + hash(key) % 10
            tds = max(20, int(n["base_tds"] * (1 + 0.15 * math.sin(t)) + random.gauss(0, 12)))
            if random.random() < 0.03:           # rare contamination event
                tds = int(tds * random.uniform(1.8, 2.6))
            ph = round(random.gauss(7.5 if "well" not in n["name"] else 7.0, 0.15), 2)
            clr = round(min(1.0, random.gauss(0.95, 0.03)), 2)
            v, f = mock.verdict_for(ph, tds, clr)
            await handle_line(mock.line(key, tests[key], "before", ph, tds, clr, v, f,
                                        rssi=random.randint(-95, -60)))
            await asyncio.sleep(20 / max(1, len(sims)))


# ---------------------------------------------------------------- web app
app = FastAPI(title="Clarity base station")
# Reading is open to any page (a dashboard hosted elsewhere can point at this gateway).
# The routes that move hardware are guarded by require_control below.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"],
                   allow_headers=["X-Clarity-Token", "Content-Type"])

CONTROL_TOKEN = os.getenv("CONTROL_TOKEN", "").strip()


def require_control(request: Request):
    """Guards the routes that tip the cup or reset a filter.
    With CONTROL_TOKEN set, the caller must send it in the X-Clarity-Token header.
    Without one, only this machine may call them, and only from a page this gateway served."""
    if CONTROL_TOKEN:
        if not hmac.compare_digest(request.headers.get("x-clarity-token", ""), CONTROL_TOKEN):
            raise HTTPException(401, "control token required: send it in the X-Clarity-Token header")
        return
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "controls are limited to this machine; set CONTROL_TOKEN in .env to allow other devices")
    origin = request.headers.get("origin")
    if origin and urlparse(origin).netloc != request.headers.get("host"):
        raise HTTPException(403, "controls are not available to other sites")


@app.on_event("startup")
async def startup():
    global device
    device = open_device()
    loop = asyncio.get_running_loop()
    threading.Thread(target=reader_thread, args=(loop,), daemon=True).start()
    asyncio.create_task(simulate_nodes())
    cloud_sync.start()


@app.get("/api/nodes")
def nodes():
    """Every node with its location and latest reading."""
    out = []
    for key, n in NODES.items():
        with db_lock:
            r = db.execute("SELECT * FROM readings WHERE node=? ORDER BY id DESC LIMIT 1", (key,)).fetchone()
        out.append({"node": key, **{k: v for k, v in n.items() if k != "base_tds"},
                    "latest": row_to_dict(r) if r else None})
    return out


@app.get("/api/readings")
def readings(node: str | None = None, limit: int = 200):
    q, args = "SELECT * FROM readings", []
    if node:
        q += " WHERE node=?"
        args.append(node)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(min(limit, 5000))
    with db_lock:
        return [row_to_dict(r) for r in db.execute(q, args).fetchall()]


@app.get("/api/tests/{node}/{test}")
def test_pair(node: str, test: int):
    """[before, after] for one pour (just [before] until the retest arrives). If the tank's
    test counter was reset, this is the most recent pour with that number."""
    with db_lock:
        before = db.execute("SELECT * FROM readings WHERE node=? AND test=? AND phase='before' "
                            "ORDER BY id DESC LIMIT 1", (node, test)).fetchone()
        if before is None:
            return []
        after = db.execute("SELECT * FROM readings WHERE node=? AND test=? AND phase='after' AND id>? "
                           "ORDER BY id LIMIT 1", (node, test, before["id"])).fetchone()
    return [row_to_dict(r) for r in (before, after) if r is not None]


@app.post("/api/cmd", dependencies=[Depends(require_control)])
def manual_cmd(test: int, filter: str):
    """Manual override from the dashboard: tip the cup for this test."""
    choice = filter.upper()
    if choice not in ("ZEROWATER", "BRITA", "NONE") or test < 0:
        raise HTTPException(422, "filter must be ZEROWATER, BRITA or NONE, and test a pour number")
    send_to_tank({"cmd": "filter", "test": test, "filter": choice})
    return {"ok": True}


@app.get("/api/filters")
def filters():
    """Filter life per tank: liters through each filter, status OK / REPLACE_SOON / REPLACE."""
    return all_filters()


@app.post("/api/filters/{name}/replace", dependencies=[Depends(require_control)])
async def replace_filter(name: str, node: str = "tank-01"):
    """Call after fitting a new filter: starts its liters and status over."""
    key = name.upper()
    if key not in FILTERS:
        raise HTTPException(404, f"unknown filter {name}; use one of {list(FILTERS)}")
    if node not in NODES or NODES[node]["sim"]:
        raise HTTPException(404, f"unknown tank {node}")
    with db_lock:
        db.execute("INSERT INTO filter_changes (ts, node, filter) VALUES (?,?,?)", (now_iso(), node, key))
        db.commit()
    life = filter_life(node)
    await broadcast({"type": "filters", "filters": life})
    return life


def sample_source(station_id):
    return "USGS" if station_id.startswith("USGS-") else "NJ DEP"


@app.get("/api/reference")
def reference():
    """Published data per site: the latest sample's estimated TDS (0.65 x specific conductance),
    plus the typical value and history. USGS and NJ DEP samples via the Water Quality Portal."""
    ref = load_reference()
    if ref is None:
        raise HTTPException(404, "reference.json missing: run python fetch_reference.py")
    out = []
    for s in ref["sites"]:
        latest = s["latest"]
        out.append({
            "site": s["name"], "lat": round(s["lat"], 4), "lon": round(s["lon"], 4),
            "tds_est": latest["tds_ppm"], "date": latest["date"], "source": sample_source(latest["station"]),
            "station": latest["station"], "conductance": latest["conductance_us_cm"],
            "typical_tds_est": s["typical_tds_ppm"], "typical_period": s["typical_period"],
            "n_samples": s["n_samples"], "first_date": s["first_date"],
            "history": [{"date": x["date"], "tds_est": x["tds_ppm"], "source": sample_source(x["station"])}
                        for x in s["samples"]],
        })
    return out


@app.get("/api/reports")
def reports(node: str | None = None, limit: int = 20):
    """Investigator reports, newest first, in the same shape as the /ws "report" message."""
    q, args = "SELECT * FROM investigations", []
    if node:
        q += " WHERE node=?"
        args.append(node)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(min(limit, 500))
    with db_lock:
        rows = db.execute(q, args).fetchall()
    return [report_message(r["id"], r["ts"], r["node"], r["test"], r["reading_id"], r["filter"],
                           {"summary": r["summary"], "findings": json.loads(r["findings"]),
                            "actions": json.loads(r["actions"])}, r["model"],
                           json.loads(r["extra"]) if r["extra"] else None) for r in rows]


@app.get("/api/analysis")
def analysis_for(node: str = "tank-01", test: int | None = None):
    """The layered checks for one raw-water reading (the node's latest unless `test` is given):
    sensor checks, its own baseline and control charts, the peer comparison and the verdict."""
    reading = raw_reading(node, test)
    if reading is None:
        raise HTTPException(404, "no reading for that node and test")
    return analyse_reading(reading)


@app.get("/api/network")
def network():
    """The simulated pipe network and an incident report for each simulated event (localize.py,
    incident.py). Simulation only: Clarity's one real node is not on it."""
    try:
        import incident
        return incident.payload()
    except Exception as e:
        raise HTTPException(503, f"the simulated network is not available: {type(e).__name__}")


@app.post("/api/network/investigate", dependencies=[Depends(require_control)])
async def network_investigate(scenario: str):
    """Hand one simulated event to the incident team (a lead agent and three specialists). It is
    a control, because it spends model credits. Returns their report and what each one said."""
    if incident_agent is None:
        raise HTTPException(503, "the investigator is off: no model key is set")
    import incident
    try:
        rules = incident.report(scenario)
    except Exception:
        raise HTTPException(404, "no such scenario")
    async with investigate_lock:
        try:
            report = await asyncio.wait_for(investigator.investigate(
                incident_agent, {"scenario": scenario, "name": rules["name"], "simulated": True},
                ask="Investigate this simulated event:"), timeout=240)
        except Exception as e:
            raise HTTPException(502, f"the agents did not finish: {type(e).__name__}")
    notice = report.get("notice") if analysis.notice_ok(report.get("notice")) else rules["notice"]
    return {"simulated": True, "scenario": scenario, "source": "deepagents", "model": AI_MODEL, "ai_name": ai_name(),
            "summary": report.get("summary"), "findings": report.get("findings", []), "actions": report.get("actions", []),
            "notice": notice, "sections": report.get("sections", [])}


@app.get("/health")
def health():
    return {"ok": True, "mock": MOCK, "ai": ai_name() is not None, "ai_name": ai_name(), "ai_model": AI_MODEL, "control": "token" if CONTROL_TOKEN else "local",
            "investigator": investigator_agent is not None,
            "agents": [a["name"] for a in investigator.SPECIALISTS] if investigator_agent is not None else [],
            "guidance": {k: guidance.status()[k] for k in ("documents", "passages", "notes")},
            "clients": len(clients),
            "cloud": cloud_sync.status() if cloud_sync.enabled else {"enabled": False}}


@app.get("/api/cloud")
def cloud_status():
    """The cloud copy: is it on, is it connected, how many rows are sent and how many are waiting."""
    return cloud_sync.status()


@app.get("/api/cloud/rollup")
def cloud_rollup(node: str = "tank-01", hours: int = 24):
    """5-minute buckets for one node, read back from the cloud database (a TimescaleDB continuous aggregate)."""
    if not cloud_sync.enabled:
        raise HTTPException(404, "the cloud copy is off: set TIGER_DATABASE_URL in .env")
    try:
        return cloud_sync.rollup(node, max(1, min(hours, 24 * 14)))
    except Exception as e:
        raise HTTPException(503, f"the cloud database did not answer ({type(e).__name__})")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()   # keep the socket open; nothing expected from clients
    except WebSocketDisconnect:
        clients.discard(ws)


@app.middleware("http")
async def revalidate_web_files(request, call_next):
    """Browsers re-check the dashboard files on every load, so edits to web/ show up at once."""
    response = await call_next(request)
    if not request.url.path.startswith(("/api", "/ws", "/docs", "/openapi")):
        response.headers["Cache-Control"] = "no-cache"
    return response


web_dir = Path(__file__).parent.parent / "web"
if web_dir.is_dir():
    app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
