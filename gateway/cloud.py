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
    readings_hourly, readings_daily   the same rollup by the hour and by the day (continuous aggregates too)
    nodes           where each node is, and whether it is real or simulated
    reports         the investigator's reports (findings and actions as JSON)
    anomaly_scores  a view over the reports: one row per pour, reading and method (robust z, EWMA, CUSUM, Mahalanobis,
                    and the experimental isolation forest)
    network_nodes, pipe_segments, incidents   the simulated pipe network and the incidents traced on it, every row
                    marked simulated; with PostGIS, as points and lines. downstream_of(network, pipe, minutes)
                    walks the flow in SQL.
    people.*        premises, contacts and notifications, in their own schema. Nothing writes to it yet.
    clarity_reader  a role that can read everything above except people, and write nothing
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
from datetime import datetime, timedelta, timezone

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
           SELECT time_bucket(INTERVAL '5 minutes', ts) AS bucket, station, node, mock,
                  count(*) AS readings, avg(tds) AS tds_avg, max(tds) AS tds_max,
                  avg(ph) AS ph_avg, avg(clarity) AS clarity_avg
           FROM readings GROUP BY 1, 2, 3, 4 WITH NO DATA""",
        # answer from the stored buckets plus whatever has arrived since they were last refreshed
        "ALTER MATERIALIZED VIEW readings_5min SET (timescaledb.materialized_only = false)",
        """SELECT add_continuous_aggregate_policy('readings_5min', start_offset => INTERVAL '1 day',
               end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE)""",
    ]),
    # The same rollup by the hour and by the day, for looking back over weeks without touching the raw rows.
    ("hourly_daily", [
        """CREATE MATERIALIZED VIEW IF NOT EXISTS readings_hourly WITH (timescaledb.continuous) AS
           SELECT time_bucket(INTERVAL '1 hour', ts) AS bucket, station, node, mock,
                  count(*) AS readings, avg(tds) AS tds_avg, max(tds) AS tds_max,
                  avg(ph) AS ph_avg, avg(clarity) AS clarity_avg
           FROM readings GROUP BY 1, 2, 3, 4 WITH NO DATA""",
        "ALTER MATERIALIZED VIEW readings_hourly SET (timescaledb.materialized_only = false)",
        """SELECT add_continuous_aggregate_policy('readings_hourly', start_offset => INTERVAL '7 days',
               end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)""",
        """CREATE MATERIALIZED VIEW IF NOT EXISTS readings_daily WITH (timescaledb.continuous) AS
           SELECT time_bucket(INTERVAL '1 day', ts) AS bucket, station, node, mock,
                  count(*) AS readings, avg(tds) AS tds_avg, max(tds) AS tds_max,
                  avg(ph) AS ph_avg, avg(clarity) AS clarity_avg
           FROM readings GROUP BY 1, 2, 3, 4 WITH NO DATA""",
        "ALTER MATERIALIZED VIEW readings_daily SET (timescaledb.materialized_only = false)",
        """SELECT add_continuous_aggregate_policy('readings_daily', start_offset => INTERVAL '30 days',
               end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '1 day', if_not_exists => TRUE)""",
    ]),
    ("compression", [
        "ALTER TABLE readings SET (timescaledb.compress, timescaledb.compress_segmentby = 'station, node', timescaledb.compress_orderby = 'ts DESC')",
        "SELECT add_compression_policy('readings', INTERVAL '7 days', if_not_exists => TRUE)",
    ]),
    # Raw rows are dropped after a year. The hourly and daily rollups are kept, so the history stays.
    ("retention", ["SELECT add_retention_policy('readings', INTERVAL '365 days', if_not_exists => TRUE)"]),
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

# A rollup is read from the continuous aggregate for its bucket size, or worked out from the raw rows where
# that aggregate is not there. (bucket: the aggregate, the feature that provides it, the interval.)
BUCKETS = {"5min": ("readings_5min", "continuous_aggregate", "5 minutes"),
           "hour": ("readings_hourly", "hourly_daily", "1 hour"),
           "day": ("readings_daily", "hourly_daily", "1 day")}
ROLLUP_FAST = """SELECT bucket, node, readings, tds_avg, tds_max, ph_avg, clarity_avg FROM {view}
    WHERE station = %s AND node = %s AND mock = %s AND bucket > now() - make_interval(hours => %s) ORDER BY bucket"""
ROLLUP_PLAIN = """SELECT date_bin(INTERVAL '{every}', ts, TIMESTAMPTZ '2000-01-01') AS bucket, node, count(*) AS readings,
        avg(tds) AS tds_avg, max(tds) AS tds_max, avg(ph) AS ph_avg, avg(clarity) AS clarity_avg FROM readings
    WHERE station = %s AND node = %s AND mock = %s AND ts > now() - make_interval(hours => %s) GROUP BY 1, 2 ORDER BY 1"""

# The layered detection's scores, one row per pour, reading and method, so they can be queried in SQL. It is a
# view over what each report already stores (reports.extra), not a second copy. Tried on its own: if it cannot
# be made, nothing else stops.
ANOMALY_VIEW = """CREATE OR REPLACE VIEW anomaly_scores AS
    WITH per AS (
        SELECT r.ts, r.station, r.node, r.test, b
        FROM reports r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.extra->'checks'->'baseline') = 'array'
                                                  THEN r.extra->'checks'->'baseline' ELSE '[]'::jsonb END) AS b)
    SELECT ts, station, node, test, b->>'metric' AS metric, 'robust_z' AS method,
           (b->>'z')::double precision AS score, abs((b->>'z')::double precision) >= 3 AS flag FROM per
    UNION ALL
    SELECT ts, station, node, test, b->>'metric', 'ewma', (b->>'ewma')::double precision, (b->>'ewma_signal')::boolean FROM per
    UNION ALL
    SELECT ts, station, node, test, b->>'metric', 'cusum', (b->>'cusum')::double precision, (b->>'cusum_signal')::boolean FROM per
    UNION ALL
    SELECT r.ts, r.station, r.node, r.test, 'all', 'mahalanobis',
           (r.extra->'checks'->'multivariate'->>'distance')::double precision, (r.extra->'checks'->'multivariate'->>'flag')::boolean
    FROM reports r WHERE jsonb_typeof(r.extra->'checks'->'multivariate') = 'object'
    UNION ALL
    SELECT r.ts, r.station, r.node, r.test, 'all', 'isolation_forest',
           (r.extra->'checks'->'multivariate'->>'isolation')::double precision, NULL::boolean
    FROM reports r WHERE jsonb_typeof(r.extra->'checks'->'multivariate'->'isolation') = 'number'"""


# The simulated pipe network and the incidents traced on it, as tables that can be joined to. Everything in
# them is simulated and every row says so. With PostGIS they also get geometry (the network's own coordinates,
# not places on Earth).
NETWORK_TABLES = [
    """CREATE TABLE IF NOT EXISTS network_nodes (
        network text NOT NULL, node_id text NOT NULL, kind text, x double precision, y double precision,
        demand_lps double precision, sensor boolean NOT NULL DEFAULT false,
        simulated boolean NOT NULL DEFAULT true, PRIMARY KEY (network, node_id))""",
    """CREATE TABLE IF NOT EXISTS pipe_segments (
        network text NOT NULL, segment_id text NOT NULL, kind text NOT NULL DEFAULT 'pipe', from_node text, to_node text,
        length_m double precision, diameter_mm double precision, material text, install_year integer,
        break_history integer, travel_min double precision, flow_lps double precision,
        simulated boolean NOT NULL DEFAULT true, PRIMARY KEY (network, kind, segment_id))""",
    """CREATE TABLE IF NOT EXISTS incidents (
        incident_id text PRIMARY KEY, network text, opened_at timestamptz NOT NULL DEFAULT now(), status text,
        severity integer, type text, suspected_segments jsonb, evidence jsonb, report jsonb,
        simulated boolean NOT NULL DEFAULT true)""",
    # Who a change entering at a pipe would reach within `horizon` minutes: the same walk as localize.affected(),
    # along the flow, fastest path first, not through tanks or reservoirs. In SQL so it can be joined to the rest.
    """CREATE OR REPLACE FUNCTION downstream_of(net text, seg text, horizon double precision DEFAULT 360)
       RETURNS TABLE(node_id text, minutes double precision) LANGUAGE plpgsql AS $fn$
       #variable_conflict use_column
       DECLARE start_node text; half double precision; changed integer;
       BEGIN
         SELECT p.to_node, coalesce(p.travel_min, 0) / 2 INTO start_node, half
           FROM pipe_segments p WHERE p.network = net AND p.segment_id = seg AND p.kind = 'pipe';
         IF start_node IS NULL THEN RETURN; END IF;
         CREATE TEMP TABLE IF NOT EXISTS reach_tmp (node_id text PRIMARY KEY, minutes double precision);
         TRUNCATE reach_tmp;
         INSERT INTO reach_tmp VALUES (start_node, 0);
         LOOP
           INSERT INTO reach_tmp
             SELECT p.to_node, min(r.minutes + p.travel_min)
               FROM reach_tmp r
               JOIN network_nodes n ON n.network = net AND n.node_id = r.node_id
               JOIN pipe_segments p ON p.network = net AND p.from_node = r.node_id
              WHERE p.travel_min IS NOT NULL AND (r.node_id = start_node OR n.kind = 'junction')
                AND r.minutes + p.travel_min <= horizon - half
              GROUP BY p.to_node
           ON CONFLICT (node_id) DO UPDATE SET minutes = EXCLUDED.minutes WHERE reach_tmp.minutes > EXCLUDED.minutes;
           GET DIAGNOSTICS changed = ROW_COUNT;
           EXIT WHEN changed = 0;
         END LOOP;
         RETURN QUERY SELECT r.node_id, r.minutes FROM reach_tmp r
           JOIN network_nodes n ON n.network = net AND n.node_id = r.node_id WHERE n.kind = 'junction' ORDER BY 2, 1;
       END $fn$""",
]
POSTGIS_STEPS = [
    "CREATE EXTENSION IF NOT EXISTS postgis",
    "ALTER TABLE network_nodes ADD COLUMN IF NOT EXISTS geom geometry(Point)",
    "ALTER TABLE pipe_segments ADD COLUMN IF NOT EXISTS geom geometry(LineString)",
]
POSTGIS_FILL = [
    "UPDATE network_nodes SET geom = ST_MakePoint(x, y) WHERE x IS NOT NULL AND y IS NOT NULL",
    """UPDATE pipe_segments p SET geom = ST_MakeLine(a.geom, b.geom) FROM network_nodes a, network_nodes b
       WHERE a.network = p.network AND b.network = p.network AND a.node_id = p.from_node AND b.node_id = p.to_node
         AND a.geom IS NOT NULL AND b.geom IS NOT NULL""",
]
# People are kept apart from everything else, in their own schema. Nothing writes to it yet: the gateway stores
# no personal data, and the Photon agent keeps its own list of who has joined. It is here so that when
# residents are contacted, consent and opt-outs have a home that the reading role below cannot see.
PEOPLE_TABLES = [
    "CREATE SCHEMA IF NOT EXISTS people",
    """CREATE TABLE IF NOT EXISTS people.premises (premise_id bigserial PRIMARY KEY, address text,
        lat double precision, lon double precision, node text)""",
    """CREATE TABLE IF NOT EXISTS people.contacts (contact_id bigserial PRIMARY KEY,
        premise_id bigint REFERENCES people.premises, channel text, phone text, language text,
        consent_at timestamptz, opted_out boolean NOT NULL DEFAULT false)""",
    """CREATE TABLE IF NOT EXISTS people.notifications (notif_id bigserial PRIMARY KEY, incident_id text,
        contact_id bigint REFERENCES people.contacts, template text, sent_at timestamptz, status text)""",
]
# A role for anything that only reads (an agent, a dashboard): readings, rollups, scores, the network and
# incidents, and nothing in `people`. It cannot log in by itself; grant it to a user that should be limited.
READER_ROLE = [
    """DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'clarity_reader') THEN
           CREATE ROLE clarity_reader NOLOGIN; END IF; END $do$""",
    "GRANT USAGE ON SCHEMA public TO clarity_reader",
    "GRANT SELECT ON readings, nodes, reports, anomaly_scores, network_nodes, pipe_segments, incidents TO clarity_reader",
    "REVOKE ALL ON SCHEMA people FROM clarity_reader",
]
READER_ROLLUPS = "GRANT SELECT ON readings_5min, readings_hourly, readings_daily TO clarity_reader"
UPSERT_NET_NODE = """INSERT INTO network_nodes (network, node_id, kind, x, y, demand_lps, sensor) VALUES (%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (network, node_id) DO UPDATE SET kind = EXCLUDED.kind, x = EXCLUDED.x, y = EXCLUDED.y,
        demand_lps = EXCLUDED.demand_lps, sensor = EXCLUDED.sensor"""
UPSERT_SEGMENT = """INSERT INTO pipe_segments (network, segment_id, kind, from_node, to_node, length_m, diameter_mm, material,
        install_year, break_history, travel_min, flow_lps) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (network, kind, segment_id) DO UPDATE SET from_node = EXCLUDED.from_node, to_node = EXCLUDED.to_node,
        length_m = EXCLUDED.length_m, diameter_mm = EXCLUDED.diameter_mm, material = EXCLUDED.material,
        install_year = EXCLUDED.install_year, break_history = EXCLUDED.break_history,
        travel_min = EXCLUDED.travel_min, flow_lps = EXCLUDED.flow_lps"""
UPSERT_INCIDENT = """INSERT INTO incidents (incident_id, network, status, severity, type, suspected_segments, evidence, report)
        VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb)
    ON CONFLICT (incident_id) DO UPDATE SET status = EXCLUDED.status, severity = EXCLUDED.severity,
        suspected_segments = EXCLUDED.suspected_segments, evidence = EXCLUDED.evidence, report = EXCLUDED.report"""


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
        self.simulated = None      # {"network": the simulated pipe network, "incidents": its incident reports}, if any
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
        def attempt(name, statements):                    # each on its own: one that fails stops nothing else
            try:
                for sql in statements:
                    pg.execute(sql)
                features[name] = True
            except Exception as e:
                features[name] = False
                log.warning("cloud: %s not set up: %s", name, _first_line(e))
            return features[name]
        attempt("anomaly_view", [ANOMALY_VIEW])
        attempt("network_tables", NETWORK_TABLES)
        attempt("postgis", POSTGIS_STEPS)
        attempt("people_schema", PEOPLE_TABLES)
        try:
            timescale = True
            try:
                pg.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
            except Exception as e:
                timescale = False
                log.info("no TimescaleDB extension here (%s): using plain Postgres tables", _first_line(e))
            if timescale:                                 # a rollup made before mock rows were kept apart is made again
                for view in ("readings_5min", "readings_hourly", "readings_daily"):
                    try:
                        old = pg.execute("""SELECT 1 FROM timescaledb_information.continuous_aggregates c
                            WHERE c.view_name = %s AND NOT EXISTS (SELECT 1 FROM information_schema.columns k
                                WHERE k.table_name = c.view_name AND k.column_name = 'mock')""", (view,)).fetchone()
                        if old:
                            pg.execute(f"DROP MATERIALIZED VIEW IF EXISTS {view} CASCADE")
                    except Exception as e:
                        log.warning("cloud: could not check %s: %s", view, _first_line(e))
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
            if attempt("reader_role", READER_ROLE) and features.get("continuous_aggregate") and features.get("hourly_daily"):
                attempt("reader_rollups", [READER_ROLLUPS])
        finally:
            pg.autocommit = False
        sim = self.simulated
        if sim and features.get("network_tables"):
            try:
                net, name = sim["network"], sim["network"].get("name", "simulated")
                sensors = set(net.get("sensors", []))
                with pg.cursor() as cur:
                    cur.executemany(UPSERT_NET_NODE, [(name, n["id"], n.get("kind"), n.get("x"), n.get("y"), n.get("demand_lps"), n["id"] in sensors)
                                                      for n in net["nodes"]])
                    cur.executemany(UPSERT_SEGMENT, [(name, p["id"], kind, p.get("from"), p.get("to"), p.get("length_m"), p.get("diameter_mm"),
                                                      p.get("material"), p.get("year"), p.get("breaks"), p.get("travel_min"), p.get("flow_lps"))
                                                     for kind, links in (("pipe", net["pipes"]), ("pump", net.get("pumps", []))) for p in links])
                    cur.executemany(UPSERT_INCIDENT, [(f"sim-{r['id']}", name, "simulated", r.get("severity"), "simulated change in water quality",
                                                       json.dumps(r.get("candidates", [])),
                                                       json.dumps({"alerts": r.get("alerts"), "quiet": r.get("quiet"), "timeline": r.get("timeline"), "affected": r.get("affected")}),
                                                       json.dumps({k: r.get(k) for k in ("name", "summary", "actions", "notice", "caveats", "check")}))
                                                      for r in sim.get("incidents", [])])
                    if features.get("postgis"):
                        for sql in POSTGIS_FILL:
                            cur.execute(sql)
                pg.commit()
            except Exception as e:
                pg.rollback()
                features["network_tables"] = False
                log.warning("cloud: the simulated network was not stored: %s", _first_line(e))
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
        if readings:
            self._catch_up(min(_when(r[1]) for r in readings))
        # Only now forget them here. A row that changed again meanwhile has a newer seq and stays queued.
        for kind, row_ids in ids.items():
            if row_ids:
                local.execute(f"DELETE FROM cloud_outbox WHERE seq <= ? AND kind = ? AND row_id IN ({marks(len(row_ids))})",
                              [top, kind, *row_ids])
        local.commit()
        return len(batch)

    def _catch_up(self, oldest):
        """Readings sent late (the first sync of what the Pi already held, or a backlog after an outage) land in
        hours the rollups have already been worked out for, and would only show at the next scheduled refresh.
        This brings the rollups up to date at once, from the oldest reading just sent to the start of the
        bucket that is still filling (which is always read live)."""
        with self._lock:
            features = dict(self._state["features"])
        now = datetime.now(timezone.utc)
        todo = [(view, every) for view, feature, every, late in (
                    ("readings_5min", "continuous_aggregate", "5 minutes", now - oldest > timedelta(minutes=10)),
                    ("readings_hourly", "hourly_daily", "1 hour", oldest < now.replace(minute=0, second=0, microsecond=0)),
                    ("readings_daily", "hourly_daily", "1 day", oldest < now.replace(hour=0, minute=0, second=0, microsecond=0)))
                if features.get(feature) and late]
        if not todo:
            return
        self._pg.autocommit = True                       # a refresh cannot run inside a transaction
        try:
            for view, every in todo:
                try:
                    self._pg.execute(f"CALL refresh_continuous_aggregate('{view}', %s::timestamptz - INTERVAL '{every}', "
                                     f"time_bucket(INTERVAL '{every}', now()))", (oldest,))
                except Exception as e:
                    log.info("cloud: %s will catch up at its next refresh (%s)", view, _first_line(e))
        finally:
            self._pg.autocommit = False

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
    def rollup(self, node, hours=24, bucket="5min"):
        """Buckets for one node (5 minutes, an hour or a day), read back from the cloud: from the continuous
        aggregate for that size if there is one, else worked out from the raw rows."""
        if not self.enabled:
            return {"enabled": False, "buckets": []}
        view, feature, every = BUCKETS[bucket if bucket in BUCKETS else "5min"]
        with self._lock:
            fast = bool(self._state["features"].get(feature))
        from psycopg.rows import dict_row
        with self._connect() as pg, pg.cursor(row_factory=dict_row) as cur:
            cur.execute(ROLLUP_FAST.format(view=view) if fast else ROLLUP_PLAIN.format(every=every), (self.station, node, self.mock, int(hours)))
            rows = cur.fetchall()
        for r in rows:
            r["bucket"] = r["bucket"].astimezone(timezone.utc).isoformat()
            for k in ("tds_avg", "ph_avg", "clarity_avg"):
                r[k] = None if r[k] is None else round(float(r[k]), 2)
        return {"enabled": True, "station": self.station, "node": node, "hours": int(hours), "bucket": bucket if bucket in BUCKETS else "5min", "mock": self.mock,
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
    try:                                                  # the simulated network and its incidents go up too
        import incident
        import localize
        sync.simulated = {"network": localize.NET, "incidents": [incident.report(s["id"]) for s in localize.scenarios()]}
    except Exception as e:
        print(f"(the simulated network was not loaded: {_first_line(e)})")
    if not sync.enabled:
        print(sync.status()["error"] or "TIGER_DATABASE_URL is not set in .env")
        return 1
    if cmd == "check":
        pg = sync._connect()
        sync._ensure_schema(pg)
        with pg.cursor() as cur:
            cur.execute("SELECT count(*), count(*) FILTER (WHERE NOT sim AND NOT mock), min(ts), max(ts) FROM readings WHERE station = %s", (sync.station,))
            total, measured, first, last = cur.fetchone()
            extra = []
            for label, sql in (("network nodes", "SELECT count(*) FROM network_nodes"), ("pipe segments", "SELECT count(*) FROM pipe_segments"),
                               ("incidents", "SELECT count(*) FROM incidents"), ("anomaly scores", "SELECT count(*) FROM anomaly_scores")):
                try:
                    cur.execute(sql)
                    extra.append(f"{cur.fetchone()[0]} {label}")
                except Exception:
                    pg.rollback()
        pg.close()
        st = sync.status()
        print(f"connected. TimescaleDB: {st['timescale']}. " + ", ".join(f"{k}: {'yes' if v else 'no'}" for k, v in st["features"].items()))
        print(f"station {sync.station}: {total} readings in the cloud ({measured} measured), {first} to {last}")
        if extra:
            print("also there: " + ", ".join(extra))
        return 0
    if cmd == "rollup":
        node = argv[2] if len(argv) > 2 else "tank-01"
        pg = sync._connect()
        sync._ensure_schema(pg)
        pg.close()
        out = sync.rollup(node, hours=int(argv[3]) if len(argv) > 3 else 6, bucket=argv[4] if len(argv) > 4 else "5min")
        print(f"{node}, last {out['hours']} h, from {out['source']}:")
        for b in out["buckets"]:
            print(f"  {b['bucket'][:16]}  n={b['readings']:<3} solids avg {b['tds_avg']} max {b['tds_max']}  pH {b['ph_avg']}  clarity {b['clarity_avg']}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
