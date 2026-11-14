"""TapTest base station (runs on the Raspberry Pi 4B, or any laptop).

Reads JSON lines from the receiver ESP32 over USB serial, adds time, location and an
anomaly score, stores everything in SQLite, asks Claude which filter to use (and why),
sends that decision back to the tank over the radio, and pushes it all to the dashboard.

Run:
    pip install -r requirements.txt
    MOCK=1 python gateway.py                    # no hardware: fake tank + simulated nodes
    SERIAL_PORT=/dev/ttyUSB0 python gateway.py  # real receiver
Then open http://<pi-ip>:8000/docs  (REST)  and  ws://<pi-ip>:8000/ws  (live feed).

Env vars:
    ANTHROPIC_API_KEY   optional. Without it the gateway uses the local rule only.
    SERIAL_PORT         default: first /dev/ttyUSB* or /dev/ttyACM*
    MOCK=1              use mock.py instead of a serial port
    SIM_NODES=12        number of simulated Princeton nodes (0 to turn off)
    AI_TIMEOUT=6        seconds to wait for Claude before the tank uses its own rule
    DB_PATH=taptest.db
"""
import asyncio
import glob
import json
import math
import os
import random
import sqlite3
import statistics
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import mock

MOCK = os.getenv("MOCK") == "1"
SIM_NODES = int(os.getenv("SIM_NODES", "12"))
AI_TIMEOUT = float(os.getenv("AI_TIMEOUT", "6"))
DB_PATH = os.getenv("DB_PATH", "taptest.db")
MODEL = "claude-opus-5-5"

# ---------------------------------------------------------------- nodes
# The real tank plus simulated nodes around Princeton. Simulated ones are flagged "sim": true.
NODES = {
    "tank-01": {"name": "TapTest demo (HackPrinceton)", "lat": 40.3467, "lon": -74.6553, "sim": False},
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
db.commit()
db_lock = threading.Lock()

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


# ---------------------------------------------------------------- Claude agent
SYSTEM = (
    "You are the decision agent inside TapTest, a water tester with two filters: ZEROWATER "
    "(removes dissolved solids, best for high TDS) and BRITA (activated carbon, best for colour, "
    "cloudiness and taste). You get one water test plus that site's recent history. Choose the "
    "filter the cup should be tipped into, or NONE if the water is fine or no filter helps "
    "(pH problems and bacteria are not fixed by these filters). Then explain the result to a "
    "non-expert in at most three short sentences, mentioning the numbers that mattered and one "
    "practical next step. Guidance: TDS above 300 ppm is high (EPA secondary limit 500), pH "
    "should be 6.5 to 8.5, clarity is 0 to 1 where 1 is as clear as clean water."
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

claude = None
if os.getenv("ANTHROPIC_API_KEY"):
    from anthropic import AsyncAnthropic
    claude = AsyncAnthropic()


async def ask_claude(reading, past):
    """Returns {"filter", "explanation"} or None."""
    if claude is None:
        return None
    recent = [{k: h[k] for k in ("ts", "phase", "ph", "tds", "clarity", "verdict")} for h in past[:8]]
    prompt = (f"Site: {NODES.get(reading['node'], {}).get('name', reading['node'])}\n"
              f"New test: {json.dumps({k: reading[k] for k in ('phase', 'ph', 'tds', 'clarity', 'verdict', 'filter')})}\n"
              f"Anomaly score vs this site's history (0-1): {reading['anomaly']}\n"
              f"Recent history (newest first): {json.dumps(recent)}")
    resp = await claude.beta.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return None
    text = next((b.text for b in resp.content if b.type == "text"), None)
    return json.loads(text) if text else None


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


async def handle_line(raw: str):
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        print("not JSON:", raw)
        return
    if "ph" not in msg:          # receiver_ready, errors, echoes
        print("info:", msg)
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
        asyncio.create_task(explain_only(reading, past))


async def decide(reading, past):
    try:
        result = await asyncio.wait_for(ask_claude(reading, past), timeout=AI_TIMEOUT)
    except Exception as e:
        print("AI decision skipped:", type(e).__name__, e)
        result = None
    if result:
        send_to_tank({"cmd": "filter", "test": reading["test"], "filter": result["filter"]})
        await save_explanation(reading, result["filter"], result["explanation"], source="claude")
    else:
        # Uno falls back to its own rule; we record the same rule here
        await save_explanation(reading, reading["filter"], None, source="local_rule")


async def explain_only(reading, past):
    try:
        result = await asyncio.wait_for(ask_claude(reading, past), timeout=20)
    except Exception:
        result = None
    if result:
        await save_explanation(reading, None, result["explanation"], source="claude")


async def save_explanation(reading, ai_filter, explanation, source):
    with db_lock:
        db.execute("UPDATE readings SET ai_filter=?, explanation=? WHERE id=?",
                   (ai_filter, explanation, reading["id"]))
        db.commit()
    await broadcast({"type": "decision", "id": reading["id"], "node": reading["node"],
                     "test": reading["test"], "phase": reading["phase"], "ai_filter": ai_filter,
                     "explanation": explanation, "source": source})


# ---------------------------------------------------------------- input sources
def open_device():
    if MOCK:
        print("MOCK mode: fake tank-01")
        return mock.MockDevice()
    import serial
    port = os.getenv("SERIAL_PORT") or next(iter(sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*"))), None)
    if not port:
        raise SystemExit("No receiver found. Plug in the ESP32, set SERIAL_PORT, or run with MOCK=1")
    print("reading receiver on", port)
    return serial.Serial(port, 115200, timeout=0.5)


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
app = FastAPI(title="TapTest base station")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def startup():
    global device
    device = open_device()
    loop = asyncio.get_running_loop()
    threading.Thread(target=reader_thread, args=(loop,), daemon=True).start()
    asyncio.create_task(simulate_nodes())


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
    """Before and after readings for one pour."""
    with db_lock:
        rows = db.execute("SELECT * FROM readings WHERE node=? AND test=? ORDER BY id", (node, test)).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/cmd")
def manual_cmd(test: int, filter: str):
    """Manual override from the dashboard: tip the cup for this test."""
    send_to_tank({"cmd": "filter", "test": test, "filter": filter.upper()})
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True, "mock": MOCK, "ai": claude is not None, "clients": len(clients)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()   # keep the socket open; nothing expected from clients
    except WebSocketDisconnect:
        clients.discard(ws)


web_dir = Path(__file__).parent.parent / "web"
if web_dir.is_dir():
    app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
