"""Pull published specific-conductance data for Princeton's water bodies and cache it.

Source: the Water Quality Portal (waterqualitydata.us), run by USGS and EPA. It holds
USGS samples plus NJ DEP monitoring. We convert conductance to an estimated TDS with
TDS (mg/L ~ ppm) ~= 0.65 x specific conductance (uS/cm at 25 C).

Run (needs internet once):
    python fetch_reference.py
Writes reference.json next to this file. The gateway serves it at GET /api/reference,
so the demo keeps working offline. Re-run to refresh. Standard library only.
"""
import csv
import io
import json
import statistics
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WQP_URL = "https://www.waterqualitydata.us/wqx3/Result/search"
TDS_FACTOR = 0.65
RECENT_N = 20          # "typical" = median of this many most recent samples
KEEP_SAMPLES = 60      # samples kept per site for history charts
OUT = Path(__file__).with_name("reference.json")

# Monitoring locations per water body (Water Quality Portal ids). The first one sets the
# map pin. Picked for the longest and most recent conductance records near Princeton.
SITES = {
    "stony-brook": {
        "name": "Stony Brook",
        "stations": [
            "USGS-01401000",          # Stony Brook at Princeton (USGS gauge, 1956-2010)
            "NJDEP_BFBM-AN0393",      # Stony Brook at Rt 206 (same spot, NJ DEP)
            "NJDEP_BFBM-01401000",
            "NJDEP_BFBM-FIBI070",     # Stony Brook at Rt 583
            "NJDEP_BFBM-AN0394A",     # Stony Brook at Alexander Rd
        ],
    },
    "millstone-river": {
        "name": "Millstone River",
        "stations": [
            "USGS-01400640",          # Millstone River near Grovers Mill (USGS, to 2025)
            "NJDEP_BFBM-01400640",
            "USGS-01401440",          # Millstone River at Kingston
            "NJDEP_BFBM-BFBM000308",  # Millstone River at Rt 518
        ],
    },
    "lake-carnegie": {
        "name": "Lake Carnegie",
        "stations": [
            "NJDEP_BFBM-NJW04459-294-3",  # Carnegie Lake-3 (mid-lake)
            "NJDEP_BFBM-NJW04459-294-1",
            "NJDEP_BFBM-NJW04459-294-2",
            "NJDEP_BFBM-NJW04459-294-4",
            "NJDEP_BFBM-BFBM000344",      # Millstone just below Carnegie Lake
        ],
    },
}


def fetch_csv(station_ids, attempts=3):
    params = [("siteid", s) for s in station_ids] + [
        ("characteristicName", "Specific conductance"),
        ("mimeType", "csv"),
        ("dataProfile", "narrow"),
    ]
    url = WQP_URL + "?" + urllib.parse.urlencode(params)
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "taptest-reference-fetch"})
            with urllib.request.urlopen(req, timeout=300) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as e:  # the portal is slow and sometimes returns 500s
            print(f"  attempt {i + 1} failed: {e}", file=sys.stderr)
            time.sleep(5 * (i + 1))
    raise RuntimeError("Water Quality Portal did not answer")


def to_us_cm(value, unit):
    unit = (unit or "").replace("µ", "u").lower()
    if unit.startswith("us/cm") or unit.startswith("umho/cm"):
        return value
    if unit.startswith("ms/cm") or unit.startswith("mmho/cm"):
        return value * 1000
    return None


def parse(text):
    """-> list of samples, and station metadata keyed by id."""
    samples, stations = [], {}
    for r in csv.DictReader(io.StringIO(text)):
        if r.get("Activity_Media") and r["Activity_Media"] != "Water":
            continue
        try:
            value = float(r["Result_Measure"])
        except (TypeError, ValueError):
            continue
        sc = to_us_cm(value, r.get("Result_MeasureUnit"))
        if sc is None or sc <= 0:
            continue
        sid = r["Location_Identifier"]
        stations.setdefault(sid, {
            "id": sid,
            "name": r.get("Location_Name") or sid,
            "org": r.get("Org_FormalName") or r.get("Org_Identifier"),
            "lat": float(r["Location_Latitude"]) if r.get("Location_Latitude") else None,
            "lon": float(r["Location_Longitude"]) if r.get("Location_Longitude") else None,
        })
        samples.append({"date": r["Activity_StartDate"], "station": sid, "conductance_us_cm": sc})
    # one value per station per day: the median (lake visits sample several depths)
    by_day = {}
    for s in samples:
        by_day.setdefault((s["date"], s["station"]), []).append(s["conductance_us_cm"])
    unique = []
    for (date, sid), vals in sorted(by_day.items()):
        sc = statistics.median(vals)
        unique.append({"date": date, "station": sid, "conductance_us_cm": round(sc, 1),
                       "tds_ppm": round(sc * TDS_FACTOR)})
    return unique, stations


def summarize(key, cfg, samples, stations):
    if not samples:
        return None
    recent = samples[-RECENT_N:]
    pin = next((stations[s] for s in cfg["stations"] if s in stations), next(iter(stations.values())))
    per_station = []
    for sid in cfg["stations"]:
        mine = [s for s in samples if s["station"] == sid]
        if mine:
            per_station.append({**stations[sid], "n": len(mine),
                                "first_date": mine[0]["date"], "last_date": mine[-1]["date"]})
    return {
        "id": key,
        "name": cfg["name"],
        "kind": "published",
        "lat": pin["lat"],
        "lon": pin["lon"],
        "latest": samples[-1],
        "typical_tds_ppm": round(statistics.median(s["tds_ppm"] for s in recent)),
        "typical_conductance_us_cm": round(statistics.median(s["conductance_us_cm"] for s in recent), 1),
        "typical_period": [recent[0]["date"], recent[-1]["date"]],
        "typical_n": len(recent),
        "n_samples": len(samples),
        "first_date": samples[0]["date"],
        "last_date": samples[-1]["date"],
        "stations": per_station,
        "samples": samples[-KEEP_SAMPLES:],
    }


def main():
    sites = []
    for key, cfg in SITES.items():
        print(f"{cfg['name']}: {len(cfg['stations'])} stations ...")
        samples, stations = parse(fetch_csv(cfg["stations"]))
        site = summarize(key, cfg, samples, stations)
        if site is None:
            print("  no data", file=sys.stderr)
            continue
        print(f"  {site['n_samples']} samples {site['first_date']}..{site['last_date']}, "
              f"latest {site['latest']['conductance_us_cm']} uS/cm ~ {site['latest']['tds_ppm']} ppm TDS, "
              f"typical ~{site['typical_tds_ppm']} ppm")
        sites.append(site)
    if not sites:
        raise SystemExit("No data fetched; keeping the existing reference.json")
    OUT.write_text(json.dumps({
        "source": "Water Quality Portal (USGS, EPA, NJ DEP) - waterqualitydata.us",
        "characteristic": "Specific conductance (uS/cm at 25 C)",
        "tds_factor": TDS_FACTOR,
        "note": "Published discrete samples, not live readings. TDS is estimated as 0.65 x specific conductance.",
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sites": sites,
    }, indent=1))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
