"""Local-only radio identity and provenance. No cloud connection or schema changes.

New nodes identify transport samples by (node, session, seq), and one logical reading is
(node, session, test, phase). Retries must not repeat either identity. A test counter reset or
wrap needs a new session; a repeated UART line with a new sequence is still the same reading.
Legacy firmware has no boot nonce, so its best available identity is (node, test, phase).
Existing history is never deleted or rewritten by the additive migration.
"""
import json
import os
import math
import re
from datetime import datetime, timezone

# The filters fitted to the rig. The tank has one, a Brita, and its servo always tips the cup
# there: whatever filter a rule, an older sketch or a model names, that is where the cup goes.
# FILTERS=ZEROWATER,BRITA brings the second one back.
FITTED = tuple(f for f in os.getenv("FILTERS", "BRITA").upper().replace(" ", "").split(",")
               if f in ("ZEROWATER", "BRITA"))


def fitted(choice):
    """The filter the cup really goes to for this choice: itself if fitted, else the fitted one."""
    if choice == "NONE" or choice in FITTED:
        return choice
    return FITTED[0] if FITTED else "NONE"


EXTRA_COLUMNS = {
    "ph_est": "INTEGER", "session": "TEXT", "seq": "INTEGER", "sender_ms": "INTEGER",
    "measured_ts": "TEXT", "received_ts": "TEXT", "temp": "REAL", "fault": "INTEGER",
    "odd": "INTEGER", "v": "INTEGER", "device_verdict": "TEXT", "ingest_key": "TEXT",
}
PUBLIC_COLUMNS = tuple(k for k in EXTRA_COLUMNS if k != "ingest_key")
SESSION = re.compile(r"[A-Za-z0-9_-]{1,32}\Z")


def uint(value, name, maximum=0xffffffff):
    """An exact integer, never truncating a fractional test/sequence into another sample."""
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    if isinstance(value, str) and not value.isascii():
        raise ValueError(f"{name} must be an integer")
    n = int(value)
    if isinstance(value, float) and (not math.isfinite(value) or value != n):
        raise ValueError(f"{name} must be an integer")
    if isinstance(value, str) and not re.fullmatch(r"[0-9]+", value):
        raise ValueError(f"{name} must be an integer")
    if not 0 <= n <= maximum:
        raise ValueError(f"{name} is out of range")
    return n


def flag(value, name):
    if value in (False, 0, "0"):
        return False
    if value in (True, 1, "1"):
        return True
    raise ValueError(f"{name} must be 0 or 1")


def metadata(msg):
    out = {k: None for k in PUBLIC_COLUMNS}
    if msg.get("ph_est") is not None:
        out["ph_est"] = flag(msg["ph_est"], "ph_est")
    session, seq = msg.get("session"), msg.get("seq")
    if (session is None) != (seq is None):
        raise ValueError("session and seq must be supplied together")
    if session is not None:
        if not isinstance(session, str) or not SESSION.fullmatch(session):
            raise ValueError("invalid session")
        out.update(session=session, seq=uint(seq, "seq"))
    for k, maximum in (("sender_ms", 0xffffffff), ("fault", 65535), ("v", 255)):
        if msg.get(k) is not None:
            out[k] = uint(msg[k], k, maximum)
    if msg.get("odd") is not None:
        out["odd"] = flag(msg["odd"], "odd")
    if msg.get("temp") is not None:
        temp = float(msg["temp"])
        if not math.isfinite(temp) or not -50 <= temp <= 150:
            raise ValueError("invalid temperature")
        out["temp"] = round(temp, 2)
    if msg.get("measured_ts") is not None:
        stamp = datetime.fromisoformat(str(msg["measured_ts"]).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("measured_ts needs a timezone")
        out["measured_ts"] = stamp.astimezone(timezone.utc).isoformat()
    # sender_ms is uptime, not UTC. Missing measurement time stays unknown; received_ts is
    # assigned by the gateway, never accepted from the radio.
    return out


def identity(reading):
    if reading.get("session") is not None:
        parts = ["radio", reading["node"], reading["session"], reading["seq"]]
    else:
        parts = ["legacy", reading["node"], reading["test"], reading["phase"]]
    return json.dumps(parts, separators=(",", ":"))


def prepare_local(db):
    have = {r[1] for r in db.execute("PRAGMA table_info(readings)")}
    for name, kind in EXTRA_COLUMNS.items():
        if name not in have:
            db.execute(f"ALTER TABLE readings ADD COLUMN {name} {kind}")
    # SQLite permits multiple NULL keys, preserving every historical row, including any old duplicates.
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS readings_ingest_identity ON readings(ingest_key)")
    db.execute("CREATE INDEX IF NOT EXISTS readings_pour_identity ON readings(node, test, phase)")
    db.commit()


def insert(db, reading, columns):
    """Insert atomically while the caller holds its DB lock. Duplicate => None, no UPDATE.

    Both logical and transport identities are checked: UART replay may get a new radio sequence.
    Legacy arrivals also match pre-migration history, whose session/ingest_key are NULL.
    A reset/wrapped test counter needs a new session; legacy firmware cannot disambiguate it.
    """
    if db.execute(
        "SELECT 1 FROM readings WHERE node=? AND test=? AND phase=? AND session IS ? LIMIT 1",
        (reading["node"], reading["test"], reading["phase"], reading.get("session")),
    ).fetchone():
        return None
    values = {**reading, "ingest_key": identity(reading)}
    cur = db.execute(
        f"INSERT INTO readings ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)}) "
        "ON CONFLICT(ingest_key) DO NOTHING", [values.get(c) for c in columns],
    )
    if not cur.rowcount:
        return None
    reading["id"] = cur.lastrowid
    return reading


def command(reading, choice):
    obj = {"cmd": "filter", "node": reading["node"], "test": reading["test"], "filter": choice}
    if reading.get("session") is not None:
        obj.update(session=reading["session"], seq=reading["seq"])
    return obj
