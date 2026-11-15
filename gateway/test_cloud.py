"""Checks for the cloud database (cloud.py), run against the real one. Run: python test_cloud.py

It needs TIGER_DATABASE_URL in .env and the internet, and says so and stops if there is neither. It creates
whatever tables, rollups and policies are missing (as the gateway does when it starts) and otherwise only reads.
"""
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

import cloud
import incident
import localize

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")


sync = cloud.CloudSync(os.getenv("DB_PATH", "taptest.db"))
if not sync.enabled:
    print("SKIP: TIGER_DATABASE_URL is not set, so there is no cloud database to check")
    sys.exit(0)
sync.simulated = {"network": localize.NET, "incidents": [incident.report(s["id"]) for s in localize.scenarios()]}
try:
    pg = sync._connect()
except Exception as e:
    print(f"SKIP: the cloud database cannot be reached ({type(e).__name__})")
    sys.exit(0)
sync._ensure_schema(pg)
features = sync.status()["features"]
one = lambda sql, *args: pg.execute(sql, args).fetchone()
col = lambda sql, *args: [r[0] for r in pg.execute(sql, args).fetchall()]
NET = localize.NET["name"]

# ---------------------------------------------------------------- the time series
check("every part of the schema was set up", all(features.values()), {k: v for k, v in features.items() if not v})
check("readings is a hypertable", one("SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings'")[0] == 1)
aggs = col("SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1")
check("there are rollups by five minutes, by the hour and by the day", aggs == ["readings_5min", "readings_daily", "readings_hourly"], aggs)
check("every rollup keeps mock rows apart from measurements",
      all(one("SELECT count(*) FROM information_schema.columns WHERE table_name = %s AND column_name = 'mock'", v)[0] == 1 for v in aggs))
jobs = col("SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'readings' ORDER BY 1")
check("old raw rows are compressed, and dropped after a year", "policy_compression" in jobs and "policy_retention" in jobs, jobs)
drop_after = one("SELECT config->>'drop_after' FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention' AND hypertable_name = 'readings'")
check("the retention is 365 days", drop_after and drop_after[0] in ("365 days", "1 year", "@ 365 days"), drop_after)

# readings sent late are brought into the rollups at once (this is what the gateway does after each batch)
oldest = one("SELECT min(ts) FROM readings WHERE station = %s", sync.station)[0]
if oldest:
    pg.commit()
    sync._pg = pg
    sync._catch_up(oldest)
    sync._pg = None
raw = one("SELECT count(*), count(*) FILTER (WHERE mock) FROM readings WHERE station = %s", sync.station)
for bucket, (view, _, _) in cloud.BUCKETS.items():
    rolled = one(f"SELECT coalesce(sum(readings), 0), coalesce(sum(readings) FILTER (WHERE mock), 0) FROM {view} WHERE station = %s", sync.station)
    check(f"the {bucket} rollup accounts for every reading, and for every mock one as mock", (int(rolled[0]), int(rolled[1])) == (raw[0], raw[1]), (rolled, raw))
measured = sync.rollup("tank-01", hours=24 * 30, bucket="hour")
sync.mock = True
mocked = sync.rollup("tank-01", hours=24 * 30, bucket="hour")
sync.mock = False
real_rows = one("SELECT count(*) FROM readings WHERE station = %s AND node = 'tank-01' AND NOT mock AND ts > now() - INTERVAL '30 days'", sync.station)[0]
check("a station that measures is never shown the mock's readings", sum(b["readings"] for b in measured["buckets"]) == real_rows and measured["mock"] is False,
      (sum(b["readings"] for b in measured["buckets"]), real_rows))
check("the rollup comes from the continuous aggregate", measured["source"] == "continuous_aggregate" and mocked["source"] == "continuous_aggregate")

# ---------------------------------------------------------------- the detection's scores
methods = col("SELECT DISTINCT method FROM anomaly_scores ORDER BY 1")
reports = one("SELECT count(*) FROM reports WHERE jsonb_typeof(extra->'checks'->'baseline') = 'array'")[0]
check("anomaly_scores has a row for each method of each stored report",
      (not reports) or set(methods) >= {"cusum", "ewma", "mahalanobis", "robust_z"}, methods)
forest = one("SELECT count(*) FROM reports WHERE jsonb_typeof(extra->'checks'->'multivariate'->'isolation') = 'number'")[0]
check("three readings by three methods, one combined distance, and the isolation forest where a report has it",
      one("SELECT count(*) FROM anomaly_scores")[0] == reports * 10 + forest, (one("SELECT count(*) FROM anomaly_scores")[0], reports, forest))

# ---------------------------------------------------------------- the simulated network and its incidents
check("the simulated network is there, node for node and pipe for pipe",
      (one("SELECT count(*) FROM network_nodes WHERE network = %s", NET)[0], one("SELECT count(*) FROM pipe_segments WHERE network = %s AND kind = 'pipe'", NET)[0])
      == (len(localize.NET["nodes"]), len(localize.NET["pipes"])))
check("every row of it says it is simulated",
      one("SELECT count(*) FROM network_nodes WHERE NOT simulated")[0] + one("SELECT count(*) FROM pipe_segments WHERE NOT simulated")[0]
      + one("SELECT count(*) FROM incidents WHERE NOT simulated")[0] == 0)
check("the sensors are marked", sorted(col("SELECT node_id FROM network_nodes WHERE network = %s AND sensor", NET)) == sorted(localize.NET["sensors"]))
check("with PostGIS, every node is a point and every pipe a line between its ends",
      one("SELECT count(*) FROM network_nodes WHERE network = %s AND geom IS NULL", NET)[0] == 0
      and one("SELECT count(*) FROM pipe_segments WHERE network = %s AND (geom IS NULL OR ST_NumPoints(geom) <> 2)", NET)[0] == 0)
wrong = []
for p in localize.NET["pipes"]:
    if p["travel_min"] is None:
        continue
    there = col("SELECT node_id FROM downstream_of(%s, %s, %s)", NET, p["id"], float(localize.HORIZON_MIN))
    if sorted(there) != localize.affected(p)["nodes"]:
        wrong.append(p["id"])
check(f"downstream_of() in SQL agrees with the tracer for every pipe ({sum(p['travel_min'] is not None for p in localize.NET['pipes'])} of them)", not wrong, wrong[:6])
stored = {r[0]: r for r in pg.execute("SELECT incident_id, severity, suspected_segments->0->>'pipe', jsonb_array_length(suspected_segments) FROM incidents").fetchall()}
want = {f"sim-{r['id']}": r for r in sync.simulated["incidents"]}
check("each simulated incident is stored with its severity and its ranked pipes",
      set(stored) == set(want) and all(stored[k][1] == want[k]["severity"] and stored[k][2] == (want[k]["candidates"][0]["pipe"] if want[k]["candidates"] else None)
                                       and stored[k][3] == len(want[k]["candidates"]) for k in want))
joined = one("""SELECT count(*) FROM incidents i, jsonb_array_elements(i.suspected_segments) c
                JOIN pipe_segments p ON p.segment_id = c->>'pipe' AND p.kind = 'pipe' WHERE p.network = i.network""")[0]
check("an incident's suspected pipes join to the pipe table", joined == sum(len(r["candidates"]) for r in sync.simulated["incidents"]), joined)

# ---------------------------------------------------------------- people, kept apart
check("the people schema exists and holds nobody", col("SELECT table_name FROM information_schema.tables WHERE table_schema = 'people' ORDER BY 1") == ["contacts", "notifications", "premises"]
      and one("SELECT (SELECT count(*) FROM people.premises) + (SELECT count(*) FROM people.contacts) + (SELECT count(*) FROM people.notifications)")[0] == 0)
can = lambda table: one("SELECT has_table_privilege('clarity_reader', %s, 'SELECT')", table)[0]
check("the reading role can read the readings, the rollups, the scores, the network and the incidents",
      all(can(x) for x in ("readings", "readings_hourly", "readings_daily", "readings_5min", "anomaly_scores", "network_nodes", "pipe_segments", "incidents")))
check("the reading role cannot see people, or write anything",
      not one("SELECT has_schema_privilege('clarity_reader', 'people', 'USAGE')")[0]
      and not any(one("SELECT has_table_privilege('clarity_reader', %s, 'INSERT')", x)[0] for x in ("readings", "incidents"))
      and not one("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'clarity_reader'")[0])

pg.close()
print("\nall passed" if ok else "\nFAILURES")
raise SystemExit(0 if ok else 1)
