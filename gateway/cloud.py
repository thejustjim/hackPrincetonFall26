"""Copy the base station's data to a cloud Postgres: Tiger Cloud (TimescaleDB, hosted on AWS).

The Pi stays the source of truth. Every reading is stored in SQLite first and the pages are
served from there, so nothing here is needed for the demo to work, and nothing is lost when
there is no internet. This module is the store-and-forward part:

  1. SQLite triggers note every new or changed row in an outbox table.
  2. A background thread sends those rows to Postgres in batches (idempotent upserts).
  3. The outbox is cleared only after the cloud has committed them.

With no internet the outbox grows; when the link comes back it drains, oldest first.

Turn it on by putting a connection string in .env:
    TIGER_DATABASE_URL=postgres://tsdbadmin:...@....tsdb.cloud.timescale.com:5432/tsdb?sslmode=require
    STATION_ID=base-01          # optional: which base station this is, if there are several

In the cloud it keeps:
    readings        every reading and Claude's decision for it. A TimescaleDB hypertable on ts.
    readings_5min   a continuous aggregate: per node, per 5 minutes (count, avg/max solids, pH, clarity)
    nodes           where each node is, and whether it is real or simulated
    reports         the investigator's reports (findings and actions as JSON)
On plain Postgres (no TimescaleDB extension) the same tables work as ordinary ones.

    python cloud.py check       # test the connection string, create the tables, show what is there
    python cloud.py rollup      # print the last hours from the continuous aggregate
"""
import json
import logging
import os
import sqlite3
import sys
import threading
from datetime import datetime, timezone

log = logging.getLogger("clarity.cloud")
if not log.handlers:                                 # the gateway prints rather than logs, so speak for ourselves
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[cloud] %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

BATCH = 500
READING_COLS = ["id", "ts", "node", "test", "phase", "ph", "tds", "clarity", "verdict", "filter",
                "ai_filter", "explanation", "rssi", "lat", "lon", "sim", "anomaly"]

LOCAL_SETUP = """
CREATE TABLE IF NOT EXISTS cloud_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, row_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TRIGGER IF NOT EXISTS cloud_reading_new AFTER INSERT ON readings
  BEGIN INSERT INTO cloud_outbox (kind, row_id) VALUES ('reading', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS cloud_reading_changed AFTER UPDATE ON readings
  BEGIN INSERT INTO cloud_outbox (kind, row_id) VALUES ('reading', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS cloud_report_new AFTER INSERT ON investigations
  BEGIN INSERT INTO cloud_outbox (kind, row_id) VALUES ('report', NEW.id); END;
"""
LOCAL_TEARDOWN = """
DROP TRIGGER IF EXISTS cloud_reading_new;
DROP TRIGGER IF EXISTS cloud_reading_changed;
DROP TRIGGER IF EXISTS cloud_report_new;
DROP TABLE IF EXISTS cloud_outbox;
DROP TABLE IF EXISTS cloud_state;
"""

# Every statement is safe to run again. The primary key includes ts because a hypertable's
# unique indexes must include the column it is partitioned on.
CLOUD_TABLES = [
    """CREATE TABLE IF NOT EXISTS readings (
        ts timestamptz NOT NULL, station text NOT NULL, id bigint NOT NULL, node text NOT NULL,
        test integer, phase text, ph double precision, tds integer, clarity double precision,
        verdict text, filter text, ai_filter text, explanation text, rssi integer,
        lat double precision, lon double precision,
        sim boolean NOT NULL DEFAULT false,      -- a simulated node, not a measurement
        mock boolean NOT NULL DEFAULT false,     -- the whole station was running on fake hardware
        anomaly double precision,
        PRIMARY KEY (station, id, ts))""",
    """CREATE TABLE IF NOT EXISTS nodes (
        station text NOT NULL, node text NOT NULL, name text, lat double precision, lon double precision,
        sim boolean NOT NULL DEFAULT false, PRIMARY KEY (station, node))""",
    """CREATE TABLE IF NOT EXISTS reports (
        station text NOT NULL, id bigint NOT NULL, ts timestamptz NOT NULL, node text, test integer,
        reading_id bigint, filter text, summary text, findings jsonb, actions jsonb, model text,
        mock boolean NOT NULL DEFAULT false, PRIMARY KEY (station, id))""",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS extra jsonb",    # the checks, what each agent said, the notice
    "CREATE INDEX IF NOT EXISTS readings_node_ts ON readings (node, ts DESC)",
]
# TimescaleDB features, each tried on its own so one that is unavailable does not stop the rest.
TIMESCALE_STEPS = [
    ("hypertable", ["SELECT create_hypertable('readings', 'ts', if_not_exists => TRUE, migrate_data => TRUE)"]),
    ("continuous_aggregate", [
        """CREATE MATERIALIZED VIEW IF NOT EXISTS readings_5min WITH (timescaledb.continuous) AS
           SELECT time_bucket(INTERVAL '5 minutes', ts) AS bucket, station, node,
                  count(*) AS readings, avg(tds) AS tds_avg, max(tds) AS tds_max,
                  avg(ph) AS ph_avg, avg(clarity) AS clarity_avg
           FROM readings GROUP BY 1, 2, 3 WITH NO DATA""",
        # answer from the stored buckets plus whatever has arrived since they were last refreshed
        "ALTER MATERIALIZED VIEW readings_5min SET (timescaledb.materialized_only = false)",
        """SELECT add_continuous_aggregate_policy('readings_5min', start_offset => INTERVAL '1 day',
               end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE)""",
    ]),
    ("compression", [
        "ALTER TABLE readings SET (timescaledb.compress, timescaledb.compress_segmentby = 'station, node', timescaledb.compress_orderby = 'ts DESC')",
        "SELECT add_compression_policy('readings', INTERVAL '7 days', if_not_exists => TRUE)",
    ]),
]

UPSERT_READING = """INSERT INTO readings (ts, station, id, node, test, phase, ph, tds, clarity, verdict, filter,
        ai_filter, explanation, rssi, lat, lon, sim, mock, anomaly)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (station, id, ts) DO UPDATE SET
        ai_filter = EXCLUDED.ai_filter, explanation = EXCLUDED.explanation, anomaly = EXCLUDED.anomaly"""
UPSERT_REPORT = """INSERT INTO reports (station, id, ts, node, test, reading_id, filter, summary, findings, actions, model, mock, extra)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s::jsonb)
    ON CONFLICT (station, id) DO UPDATE SET summary = EXCLUDED.summary, findings = EXCLUDED.findings,
        actions = EXCLUDED.actions, extra = EXCLUDED.extra"""
UPSERT_NODE = """INSERT INTO nodes (station, node, name, lat, lon, sim) VALUES (%s,%s,%s,%s,%s,%s)
    ON CONFLICT (station, node) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon, sim = EXCLUDED.sim"""

ROLLUP_FAST = """SELECT bucket, node, readings, tds_avg, tds_max, ph_avg, clarity_avg FROM readings_5min
    WHERE station = %s AND node = %s AND bucket > now() - make_interval(hours => %s) ORDER BY bucket"""
ROLLUP_PLAIN = """SELECT date_bin(INTERVAL '5 minutes', ts, TIMESTAMPTZ '2000-01-01') AS bucket, node, count(*) AS readings,
        avg(tds) AS tds_avg, max(tds) AS tds_max, avg(ph) AS ph_avg, avg(clarity) AS clarity_avg FROM readings
    WHERE station = %s AND node = %s AND ts > now() - make_interval(hours => %s) GROUP BY 1, 2 ORDER BY 1"""


def database_url():
    return (os.getenv("TIGER_DATABASE_URL") or os.getenv("DATABASE_URL") or "").strip()


def _when(ts):
    """The gateway's ISO text -> a datetime with a zone."""
    d = datetime.fromisoformat(ts)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _short(err):
    """An error in plain words for /health. No host names, users or connection strings: /health is open to the network."""
    text = str(err).lower()
    if "password authentication" in text or "no pg_hba" in text:
        why = "the database refused the user or password"
    elif "translate host name" in text or "name or service not known" in text or "nodename nor servname" in text:
        why = "no internet, or the host name is wrong"
    elif "refused" in text or "timeout" in text or "timed out" in text or "closed the connection" in text or "unreachable" in text:
        why = "the database cannot be reached"
    elif "does not exist" in text and "database" in text:
        why = "that database does not exist"
    else:
        why = "see the gateway's console"
    return f"{type(err).__name__}: {why}"


def _first_line(err):
    return (str(err).strip().splitlines() or [type(err).__name__])[0][:300]


class CloudSync:
    def __init__(self, db_path, url=None, station=None, mock=False, nodes=None):
        self.db_path = db_path
        self.url = url if url is not None else database_url()
        self.station = station or os.getenv("STATION_ID", "base-01")
        self.mock = bool(mock)
        self.nodes = nodes or {}
        self.enabled = bool(self.url)
        self._pg = None
        self._schema_ready = False
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._state = {"connected": False, "pending": 0, "sent": 0, "last_sync": None, "error": None,
                       "timescale": None, "features": {}, "cloud_rows": None}
        self._logged_offline = False
        if self.enabled:
            try:
                import psycopg  # noqa: F401
            except ImportError:
                self.enabled = False
                self._state["error"] = "psycopg is not installed: pip install -r requirements.txt"
                log.warning("TIGER_DATABASE_URL is set but psycopg is not installed; the cloud copy is off")

    # ------------------------------------------------------------ this machine
    def prepare_local(self, db):
        """Install (or remove) the outbox and its triggers. Call once, on the gateway's own connection."""
        if not self.enabled:
            db.executescript(LOCAL_TEARDOWN)             # no outbox quietly growing while the copy is off
            db.commit()
            return
        db.executescript(LOCAL_SETUP)
        if not db.execute("SELECT 1 FROM cloud_state WHERE key = 'backfill_queued'").fetchone():
            # first time on: queue everything already stored, so the cloud gets the history too
            db.execute("INSERT INTO cloud_outbox (kind, row_id) SELECT 'reading', id FROM readings ORDER BY id")
            db.execute("INSERT INTO cloud_outbox (kind, row_id) SELECT 'report', id FROM investigations ORDER BY id")
            db.execute("INSERT INTO cloud_state (key, value) VALUES ('backfill_queued', ?)",
                       (datetime.now(timezone.utc).isoformat(),))
        db.commit()

    def start(self):
        if self.enabled and not self._thread:
            self._thread = threading.Thread(target=self._run, name="cloud-sync", daemon=True)
            self._thread.start()
            log.info("cloud copy on: station %s", self.station)

    def stop(self):
        self._stop.set()

    def status(self):
        with self._lock:
            return {"enabled": self.enabled, "station": self.station, **self._state}

    # ------------------------------------------------------------ the cloud
    def _connect(self):
        import psycopg
        return psycopg.connect(self.url, connect_timeout=8, application_name="clarity-gateway")

    def _ensure_schema(self, pg):
        features = {}
        with pg.cursor() as cur:
            for sql in CLOUD_TABLES:
                cur.execute(sql)
        pg.commit()
        pg.autocommit = True                             # a continuous aggregate cannot be created inside a transaction
        try:
            timescale = True
            try:
                pg.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
            except Exception as e:
                timescale = False
                log.info("no TimescaleDB extension here (%s): using plain Postgres tables", _first_line(e))
            for name, statements in TIMESCALE_STEPS:
                if not timescale:
                    features[name] = False
                    continue
                try:
                    for sql in statements:
                        pg.execute(sql)
                    features[name] = True
                except Exception as e:
                    features[name] = False
                    log.warning("TimescaleDB %s not set up: %s", name, _first_line(e))
        finally:
            pg.autocommit = False
        with pg.cursor() as cur:
            cur.executemany(UPSERT_NODE, [(self.station, node, n.get("name"), n.get("lat"), n.get("lon"), bool(n.get("sim")))
                                          for node, n in self.nodes.items()])
        pg.commit()
        with self._lock:
            self._state.update(timescale=timescale, features=features)
        log.info("cloud tables ready (TimescaleDB: %s, %s)", timescale,
                 ", ".join(k for k, v in features.items() if v) or "no extras")

    def _drain_once(self, local):
        top = local.execute("SELECT max(seq) FROM cloud_outbox").fetchone()[0]
        if self._pg is None:                             # connect even when idle, so /health tells the truth
            self._pg = self._connect()
        if not self._schema_ready:
            self._ensure_schema(self._pg)
            self._schema_ready = True
        if top is None:
            return 0
        batch = local.execute("SELECT kind, row_id FROM cloud_outbox WHERE seq <= ? GROUP BY kind, row_id "
                              "ORDER BY min(seq) LIMIT ?", (top, BATCH)).fetchall()
        ids = {"reading": [], "report": []}
        for kind, row_id in batch:
            ids.setdefault(kind, []).append(row_id)
        marks = lambda n: ",".join("?" * n)
        readings = local.execute(f"SELECT {','.join(READING_COLS)} FROM readings WHERE id IN ({marks(len(ids['reading']))})",
                                 ids["reading"]).fetchall() if ids["reading"] else []
        reports = local.execute("SELECT id, ts, node, test, reading_id, filter, summary, findings, actions, model, extra "
                                f"FROM investigations WHERE id IN ({marks(len(ids['report']))})", ids["report"]).fetchall() if ids["report"] else []
        with self._pg.cursor() as cur:
            if readings:
                cur.executemany(UPSERT_READING, [
                    (_when(r[1]), self.station, r[0], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11],
                     r[12], r[13], r[14], bool(r[15]), self.mock, r[16]) for r in readings])
            if reports:
                cur.executemany(UPSERT_REPORT, [
                    (self.station, r[0], _when(r[1]), r[2], r[3], r[4], r[5], r[6], r[7] or "[]", r[8] or "[]", r[9], self.mock, r[10])
                    for r in reports])
        self._pg.commit()
        # Only now forget them here. A row that changed again meanwhile has a newer seq and stays queued.
        for kind, row_ids in ids.items():
            if row_ids:
                local.execute(f"DELETE FROM cloud_outbox WHERE seq <= ? AND kind = ? AND row_id IN ({marks(len(row_ids))})",
                              [top, kind, *row_ids])
        local.commit()
        return len(batch)

    def _count_cloud(self):
        with self._pg.cursor() as cur:
            cur.execute("SELECT count(*) FROM readings WHERE station = %s", (self.station,))
            n = cur.fetchone()[0]
        self._pg.commit()
        return n

    def _run(self):
        local = sqlite3.connect(self.db_path, timeout=10)
        backoff, counted = 2.0, 0.0
        while not self._stop.is_set():
            wait = 2.0
            try:
                sent = self._drain_once(local)
                pending = local.execute("SELECT count(*) FROM cloud_outbox").fetchone()[0]
                now = datetime.now(timezone.utc)
                update = {"connected": True, "pending": pending, "error": None}
                if sent:
                    update["last_sync"] = now.isoformat()
                if sent or now.timestamp() - counted > 30:
                    update["cloud_rows"] = self._count_cloud()
                    counted = now.timestamp()
                with self._lock:
                    self._state.update(update)
                    self._state["sent"] += sent
                if self._logged_offline:
                    log.info("cloud link is back; %d rows waiting", pending)
                    self._logged_offline = False
                backoff = 2.0
                if pending:
                    wait = 0.05                           # more to send: keep going
            except Exception as e:
                try:
                    local.rollback()
                    pending = local.execute("SELECT count(*) FROM cloud_outbox").fetchone()[0]
                except Exception:
                    pending = None
                if self._pg is not None:
                    try:
                        self._pg.close()
                    except Exception:
                        pass
                    self._pg = None
                with self._lock:
                    self._state.update(connected=False, error=_short(e))
                    if pending is not None:
                        self._state["pending"] = pending
                if not self._logged_offline:
                    log.warning("cloud copy paused (%s). Readings are kept here and sent when it is back.", _first_line(e))
                    self._logged_offline = True
                wait, backoff = backoff, min(backoff * 2, 30.0)
            self._stop.wait(wait)

    # ------------------------------------------------------------ reading it back
    def rollup(self, node, hours=24):
        """5-minute buckets for one node, read back from the cloud (the continuous aggregate if there is one)."""
        if not self.enabled:
            return {"enabled": False, "buckets": []}
        with self._lock:
            fast = bool(self._state["features"].get("continuous_aggregate"))
        from psycopg.rows import dict_row
        with self._connect() as pg, pg.cursor(row_factory=dict_row) as cur:
            cur.execute(ROLLUP_FAST if fast else ROLLUP_PLAIN, (self.station, node, int(hours)))
            rows = cur.fetchall()
        for r in rows:
            r["bucket"] = r["bucket"].astimezone(timezone.utc).isoformat()
            for k in ("tds_avg", "ph_avg", "clarity_avg"):
                r[k] = None if r[k] is None else round(float(r[k]), 2)
        return {"enabled": True, "station": self.station, "node": node, "hours": int(hours),
                "source": "continuous_aggregate" if fast else "plain_query", "buckets": rows}


# ---------------------------------------------------------------- command line
def _main(argv):
    try:
        from dotenv import load_dotenv
        from pathlib import Path
        load_dotenv(Path(__file__).resolve().parent.parent / ".env")
        load_dotenv(Path(__file__).resolve().parent / ".env")
    except ImportError:
        pass
    cmd = argv[1] if len(argv) > 1 else "check"
    sync = CloudSync(os.getenv("DB_PATH", "taptest.db"))
    if not sync.enabled:
        print(sync.status()["error"] or "TIGER_DATABASE_URL is not set in .env")
        return 1
    if cmd == "check":
        pg = sync._connect()
        sync._ensure_schema(pg)
        with pg.cursor() as cur:
            cur.execute("SELECT count(*), count(*) FILTER (WHERE NOT sim AND NOT mock), min(ts), max(ts) FROM readings WHERE station = %s", (sync.station,))
            total, measured, first, last = cur.fetchone()
        pg.close()
        st = sync.status()
        print(f"connected. TimescaleDB: {st['timescale']}. " + ", ".join(f"{k}: {'yes' if v else 'no'}" for k, v in st["features"].items()))
        print(f"station {sync.station}: {total} readings in the cloud ({measured} measured), {first} to {last}")
        return 0
    if cmd == "rollup":
        node = argv[2] if len(argv) > 2 else "tank-01"
        pg = sync._connect()
        sync._ensure_schema(pg)
        pg.close()
        out = sync.rollup(node, hours=int(argv[3]) if len(argv) > 3 else 6)
        print(f"{node}, last {out['hours']} h, from {out['source']}:")
        for b in out["buckets"]:
            print(f"  {b['bucket'][:16]}  n={b['readings']:<3} solids avg {b['tds_avg']} max {b['tds_max']}  pH {b['ph_avg']}  clarity {b['clarity_avg']}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
