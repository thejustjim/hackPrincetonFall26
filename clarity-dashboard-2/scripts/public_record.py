"""What EPA's public records say about the water system that serves a place, as a small file the map can show.

    python3 scripts/public_record.py            writes public/data/public_record.json (for Princeton)

It is run ahead of time, not by the page: the records change quarterly, one of them is a 13 MB download, and
a live lookup can fail in front of an audience. Every fact carries where it came from and the period it covers,
and the file carries the day it was fetched. Standard library only.

It asks four public EPA services, with no key:
  1. Water system service areas (ArcGIS): which system serves this point, and how many people.
  2. ECHO: violations by quarter for the last three years or so.
  3. Envirofacts SDWIS: every violation on record, lead results, and the system's wells and intakes.
  4. UCMR 5 (a bulk file): the 2023 to 2025 survey of unregulated contaminants, PFAS among them.

What it must not do, and does not: call the water safe or unsafe, call a detection a violation, or treat a
record for the whole system as a test of one tap.
"""
import csv
import datetime
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

PLACE = {"name": "Princeton, New Jersey", "lon": -74.6593, "lat": 40.3573}
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "public_record.json"
UA = {"User-Agent": "Mozilla/5.0 (public-record fetch)"}
AREAS = ("https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Water_System_Boundaries/FeatureServer/0/query"
         "?geometry={lon},{lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json")
ECHO = "https://echodata.epa.gov/echo/dfr_rest_services.get_sdwis_compliance?output=JSON&p_id={pwsid}"
SDWIS = "https://data.epa.gov/efservice/{table}/PWSID/{pwsid}/JSON"
UCMR5 = "https://www.epa.gov/system/files/other-files/2023-08/ucmr5-occurrence-data-by-state.zip"
MONTHS = "January February March April May June July August September October November December".split()


def get(url, raw=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
        data = r.read()
    return data if raw else json.loads(data)


def month_year(us_date):                      # "07/01/2023" -> "July 2023"
    m, _, y = us_date.split("/")
    return f"{MONTHS[int(m) - 1]} {y}"


def main():
    today = datetime.date.today()
    area = get(AREAS.format(**PLACE))["features"]
    if not area:
        sys.exit("no water system service area at this point")
    a = area[0]["attributes"]
    pwsid = a["PWSID"]
    facts = []

    # --- violations, quarter by quarter
    comp = get(ECHO.format(pwsid=pwsid))["Results"]["SDWISCompliance"]
    status = comp["Sources"][0]["Status"]
    done = [q for q in range(1, 14) if status.get(f"Qtr{q}Status") not in (None, "In Progress")]
    clean = [q for q in done if status[f"Qtr{q}Status"] == "No Violation"]
    span = f"{month_year(comp[f'Qtr{done[0]}Start'])} to {month_year(comp[f'Qtr{done[-1]}End'])}"
    facts.append({"label": "Recent violations",
                  "text": (f"None in the {len(done)} quarters from {span}." if len(clean) == len(done)
                           else f"A violation in {len(done) - len(clean)} of the {len(done)} quarters from {span}."),
                  "source": "EPA ECHO", "url": f"https://echo.epa.gov/detailed-facility-report?fid={pwsid}&sys=SDWIS"})

    # --- every violation on record
    viol = get(SDWIS.format(table="VIOLATION", pwsid=pwsid))
    if viol:
        years = sorted({v["compl_per_begin_date"][:4] for v in viol if v.get("compl_per_begin_date")})
        health = sum(v.get("is_health_based_ind") == "Y" for v in viol)
        back = sum(v.get("compliance_status_code") == "R" for v in viol)
        facts.append({"label": "Violations on record",
                      "text": f"{len(viol)}, from {' and '.join(years) if len(years) < 3 else ', '.join(years)}. "
                              + ("None was health-based" if not health else f"{health} health-based")
                              + (", and all are marked as returned to compliance." if back == len(viol) else f"; {back} are marked as returned to compliance."),
                      "source": "EPA SDWIS", "url": SDWIS.format(table="VIOLATION", pwsid=pwsid)})

    # --- lead at the tap: the 90th percentile of the latest full sampling period
    when = {s["sample_id"]: s for s in get(SDWIS.format(table="LCR_SAMPLE", pwsid=pwsid))}
    lead = []
    for r in get(SDWIS.format(table="LCR_SAMPLE_RESULT", pwsid=pwsid)):
        s = when.get(r["sample_id"])
        if s and r.get("contaminant_code") == "PB90" and s["sampling_end_date"][:10] < today.isoformat():
            lead.append((s["sampling_end_date"][:4], float(r["sample_measure"]), r["unit_of_measure"]))
    if lead:
        year = max(y for y, _, _ in lead)
        value = max(v for y, v, _ in lead if y == year)
        facts.append({"label": "Lead at the tap", "text": f"{value:g} mg/L at the 90th percentile of the homes sampled in {year}. EPA's action level is 0.015 mg/L.",
                      "source": "EPA SDWIS", "url": SDWIS.format(table="LCR_SAMPLE_RESULT", pwsid=pwsid)})

    # --- where the water comes from
    fac = get(SDWIS.format(table="WATER_SYSTEM_FACILITY", pwsid=pwsid))
    wells = [f for f in fac if f.get("facility_type_code") == "WL"]
    wells_on = sum(f.get("facility_activity_code") == "A" for f in wells)
    intakes = sum(f.get("facility_type_code") == "IN" and f.get("facility_activity_code") == "A" for f in fac)
    facts.append({"label": "Sources", "text": f"{intakes} active surface-water intakes and {wells_on} active wells ({len(wells)} wells on record, {len(wells) - wells_on} of them inactive).",
                  "source": "EPA SDWIS", "url": SDWIS.format(table="WATER_SYSTEM_FACILITY", pwsid=pwsid)})

    # --- PFAS, from the survey of unregulated contaminants
    rows = []
    with zipfile.ZipFile(io.BytesIO(get(UCMR5, raw=True))) as z:
        for name in z.namelist():
            if not name.lower().endswith(".txt"):
                continue
            with z.open(name) as fh:
                reader = csv.DictReader(io.TextIOWrapper(fh, encoding="latin-1"), delimiter="\t")
                if "Contaminant" not in (reader.fieldnames or []):
                    continue
                rows += [r for r in reader if r.get("PWSID") == pwsid and r["Contaminant"].lower() != "lithium"]
    if rows:
        years = sorted({r["CollectionDate"][-4:] for r in rows})
        found = [r for r in rows if r.get("AnalyticalResultsSign") == "="]
        top = {}
        for r in found:
            ng = float(r["AnalyticalResultValue"]) * 1000          # the file is in micrograms a litre
            if ng > top.get(r["Contaminant"], (0, ""))[0]:
                top[r["Contaminant"]] = (ng, r.get("FacilityName", ""))
        text = f"Detected in {len(found)} of {len(rows)} results from the system's plants in {' and '.join(years)}."
        if "PFOA" in top and "PFOS" in top:
            text += (f" The highest were PFOA at {top['PFOA'][0]:.1f} ng/L and PFOS at {top['PFOS'][0]:.1f} ng/L"
                     + (f", both at the {top['PFOA'][1]}." if top['PFOA'][1] == top['PFOS'][1] else "."))
        text += (" New Jersey's limits are 14 and 13 ng/L. EPA's 2024 rule sets 4.0 ng/L for each, with compliance required at a later date"
                 " (2029 in the rule as issued). A detection is not a violation.")
        facts.append({"label": "PFAS", "text": text, "source": "EPA UCMR 5", "url": "https://www.epa.gov/dwucmr/occurrence-data-unregulated-contaminant-monitoring-rule"})

    record = {"fetched": today.isoformat(), "place": PLACE["name"],
              "system": {"pwsid": pwsid, "name": a.get("PWS_Name"), "population": a.get("Population_Served_Count"),
                         "connections": a.get("Service_Connections_Count"), "source": "EPA water system service areas",
                         "url": "https://www.epa.gov/ground-water-and-drinking-water/community-water-system-service-area-boundaries"},
              "wells_active": wells_on, "wells_on_record": len(wells), "intakes_active": intakes,
              "facts": facts,
              "caveat": "These are records for the whole system, which serves many towns. They are not a test of any one tap, and they do not say the water is safe or unsafe."}
    OUT.write_text(json.dumps(record, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(OUT.parent.parent.parent)}: {pwsid}, {len(facts)} facts")
    for f in facts:
        print(" ", f["label"] + ":", f["text"])


if __name__ == "__main__":
    main()
