"""Checks for incident.py, the reports for the simulated network. Run: python test_incident.py"""
import json
from pathlib import Path

import guidance
import incident

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")


data = incident.payload()
reports = data["scenarios"]
check("the payload says it is simulated, and so does every report", data["simulated"] is True and all(r["simulated"] is True for r in reports))
check("there is a report for every scenario", len(reports) >= 3 and all(r["summary"] and r["actions"] and r["timeline"] for r in reports))
check("every summary says the sensors are simulated", all("simulated sensors" in r["summary"] for r in reports))
check("every report carries its caveats, the first being that it is a simulation", all(r["caveats"][0].startswith("This is a simulation") for r in reports))
check("every notice ends with what Clarity cannot detect", all(r["notice"].endswith(incident.NOTICE_REQUIRED) for r in reports))
text = json.dumps(data).lower()
check("nothing calls the water safe or says to drink it", " safe" not in text.replace("safe water", "") and "drink it" not in text)

sure = [r for r in reports if r["candidates"] and r["candidates"][0]["confidence"] >= 0.35 and r["fit_quality"] == "usable"]
unsure = [r for r in reports if r["candidates"] and (r["candidates"][0]["confidence"] < 0.35 or r["fit_quality"] != "usable")]
check("the scenarios include both a clear trace and an uncertain one", sure and unsure, (len(sure), len(unsure)))
check("a clear trace names its pipe and goes on to containing and flushing",
      all(f"pipe {r['candidates'][0]['pipe']}" in r["summary"] and any("valves" in a["do"] for a in r["actions"]) for r in sure))
check("an uncertain trace says so, samples first and isolates nothing",
      all(("too little to single out a pipe" in r["summary"] or "weak trace" in r["summary"]) and r["actions"][0]["do"].startswith("Sample before anything else")
          and any(a["do"].startswith("Do not isolate") for a in r["actions"]) for r in unsure))
check("the check against the simulation gives the true pipe's rank", all(r["check"].startswith("The simulation put the change in pipe") for r in reports))
check("a single alerting sensor is only worth a second look", all(r["severity"] == 1 for r in reports if len(r["alerts"]) == 1))

stress = [r for r in reports if r.get("stress")]
check("stress reports sample first rather than isolate despite large ranking weights", len(stress) == 3 and all(
    r["actions"][0]["do"].startswith("Sample before anything else") and any(a["do"].startswith("Do not isolate") for a in r["actions"]) for r in stress))
check("sensor dropout stays visible in the report", next(r for r in stress if r["id"] == "sensor-dropout")["unavailable"])
check("seeded robustness results accompany the simulation", data["robustness"]["simulated"] is True and len(data["robustness"]["profiles"]) == 4)

if not guidance.status()["documents"]:
    print("SKIP the citation checks: no guidance_index.json here (run python fetch_guidance.py)")
else:
    cited = [a["guidance"] for r in reports for a in r["actions"]]
    check("every recommended action cites a published passage", all(cited), sum(1 for c in cited if not c))
    check("each citation names its document and links to epa.gov", all(c["source"] and c["url"].startswith("https://www.epa.gov/") for c in cited if c))
    check("quoted passages are short", all(len(c["quote"]) <= incident.QUOTE + 5 for c in cited if c), max(len(c["quote"]) for c in cited if c))

    page = Path(__file__).resolve().parent.parent / "web" / "network" / "data.json"
    check("the page's data file is up to date (python incident.py)", page.exists() and json.loads(page.read_text()) == json.loads(json.dumps(data)))

print("\nall passed" if ok else "\nFAILURES")
raise SystemExit(0 if ok else 1)
