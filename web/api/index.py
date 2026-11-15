"""Read-only cloud endpoints for the hosted site.

The base station serves /api/cloud and /api/cloud/rollup from its own machine (gateway/gateway.py).
The hosted pages have no base station behind them, so this serves the same two answers from Vercel,
read straight from the Tiger Cloud (TimescaleDB) database. The connection string is the Vercel
project's TIGER_DATABASE_URL setting, never in this file, and every session is opened read-only:
nothing here can write.

    GET /api/cloud/                       how many readings the cloud holds, and what else is there
    GET /api/cloud/rollup/?node=tank-01&hours=24&bucket=hour      buckets from a continuous aggregate
"""
import os
from datetime import timezone

import psycopg
from fastapi import FastAPI, HTTPException, Request
from psycopg.rows import dict_row

app = FastAPI(title="Clarity cloud, read-only", redirect_slashes=False, docs_url=None, redoc_url=None, openapi_url=None)
STATION = os.getenv("STATION", "base-01")
VIEWS = {"5min": "readings_5min", "hour": "readings_hourly", "day": "readings_daily"}       # the three continuous aggregates
ROLLUP = """SELECT bucket, node, readings, tds_avg, tds_max, ph_avg, clarity_avg FROM {view}
    WHERE station = %s AND node = %s AND mock = %s AND bucket > now() - make_interval(hours => %s) ORDER BY bucket"""


def connect():
    url = os.getenv("TIGER_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not url:
        raise HTTPException(503, "the cloud database is not configured for this site")
    try:
        pg = psycopg.connect(url, connect_timeout=8)
        pg.read_only = True                              # every transaction on this session is read-only
        pg.execute("SET statement_timeout = '8s'")
        return pg
    except psycopg.Error as e:
        raise HTTPException(503, f"the cloud database did not answer ({type(e).__name__})")


def status(station):
    with connect() as pg, pg.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT count(*) AS n, count(*) FILTER (WHERE NOT sim AND NOT mock) AS measured, "
                    "min(ts) AS first, max(ts) AS last FROM readings WHERE station = %s", (station,))
        r = cur.fetchone()
        also = {}
        for name, table in (("network_nodes", "network_nodes"), ("pipe_segments", "pipe_segments"),
                            ("incidents", "incidents"), ("anomaly_scores", "anomaly_scores")):
            try:
                with pg.transaction():
                    cur.execute(f"SELECT count(*) AS n FROM {table}")
                    also[name] = cur.fetchone()["n"]
            except psycopg.Error:
                pass                                     # that part of the design is not in this database
    when = lambda t: t.astimezone(timezone.utc).isoformat() if t else None
    return {"enabled": True, "connected": True, "hosted": True, "station": station, "timescale": True,
            "cloud_rows": r["n"], "measured_rows": r["measured"], "first": when(r["first"]), "last": when(r["last"]), **also}


def rollup(station, node, hours, bucket, mock):
    bucket = bucket if bucket in VIEWS else "hour"
    hours = max(1, min(int(hours), 24 * 366))
    with connect() as pg, pg.cursor(row_factory=dict_row) as cur:
        if mock is None:                                 # measured readings if the tank has sent any, else the simulated tank's
            cur.execute("SELECT count(*) AS n FROM readings WHERE station = %s AND node = %s AND NOT sim AND NOT mock", (station, node))
            mock = cur.fetchone()["n"] == 0
        cur.execute(ROLLUP.format(view=VIEWS[bucket]), (station, node, mock, hours))
        rows = cur.fetchall()
    for r in rows:
        r["bucket"] = r["bucket"].astimezone(timezone.utc).isoformat()
        for k in ("tds_avg", "ph_avg", "clarity_avg"):
            r[k] = None if r[k] is None else round(float(r[k]), 2)
    return {"enabled": True, "hosted": True, "station": station, "node": node, "hours": hours, "bucket": bucket,
            "mock": mock, "source": "continuous_aggregate", "buckets": rows}


@app.get("/{path:path}")
def answer(path: str, request: Request):
    """One function behind both addresses (vercel.json sends them here), told apart by the path asked for."""
    q = request.query_params
    station = q.get("station") or STATION
    if "rollup" in path or "bucket" in q or "node" in q:
        try:
            hours = int(q.get("hours") or 24)
        except ValueError:
            raise HTTPException(422, "hours must be a whole number")
        flag = q.get("mock")
        return rollup(station, q.get("node") or "tank-01", hours, q.get("bucket") or "hour",
                      None if flag is None else flag.lower() in ("1", "true", "yes"))
    return status(station)
