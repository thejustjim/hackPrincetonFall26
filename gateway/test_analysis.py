"""Checks for analysis.py. Run: python test_analysis.py"""
import random

import analysis as A

random.seed(7)
ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")


def pour(i, ph=7.5, tds=200, clarity=0.95, phase="before", verdict="SAFE"):
    return {"id": i, "ts": f"t{i}", "node": "n", "test": i, "phase": phase, "ph": ph, "tds": tds, "clarity": clarity, "verdict": verdict}


def quiet(n, tds=200, spread=10):
    return [pour(i, ph=round(random.gauss(7.5, 0.1), 2), tds=int(random.gauss(tds, spread)), clarity=round(min(1, random.gauss(0.95, 0.02)), 2)) for i in range(n)]


def peer(name, latest_tds, sim=True, base=200):
    return {"node": name, "name": name, "sim": sim, "km": 2.0, "reading": pour(99, tds=latest_tds), "history": quiet(20, tds=base)}


hist = quiet(30)

r = A.analyse(pour(31, tds=205), hist, [peer("a", 198), peer("b", 204)])
check("an ordinary pour is normal", r["kind"] == "normal" and r["severity"] == 0, r["kind"])
check("its baseline comes from its own history", all(b["source"] == "history" for b in r["baseline"]))

spike = pour(31, tds=780, verdict="HIGH_TDS")
r = A.analyse(spike, hist, [peer("a", 198), peer("b", 204), peer("c", 190)])
check("one salty pour is a local event", r["kind"] == "local_event" and r["lead"]["metric"] == "tds", r["kind"])
check("a single unusual pour is only worth a second look", r["severity"] == 1 and r["repeat"] == 1)
check("one wild reading does not trip the control charts", not any(b["ewma_signal"] or b["cusum_signal"] for b in r["baseline"]))
check("peers that did not move make it local", r["peers"]["scope"] == "local" and r["peers"]["moved"] == 0)
check("simulated peers are labelled in the evidence", any(e.startswith("Simulated:") for e in r["evidence"]), r["evidence"])

r2 = A.analyse(pour(32, tds=790, verdict="HIGH_TDS"), hist + [spike], [peer("a", 198)])
check("a second unusual pour in a row is acted on", r2["repeat"] == 2 and r2["severity"] == 2, (r2["repeat"], r2["severity"]))

r = A.analyse(spike, hist, [peer("a", 520), peer("b", 610), peer("c", 205)])
check("neighbours moving the same way make it regional", r["kind"] == "regional_shift" and r["peers"]["moved"] == 2, r["peers"])

stuck = hist + [pour(40 + i, tds=233) for i in range(4)]
r = A.analyse(pour(50, tds=233), stuck)
check("the same value five times is a sensor fault, not a water event", r["kind"] == "sensor_fault" and r["sensor"][1]["status"] == "fault", r["sensor"][1])

shifted = hist + [pour(40 + i, ph=7.4 + 0.03 * (i % 4), tds=200 + 27 + (i % 3), clarity=0.93 + 0.01 * (i % 3)) for i in range(9)]
r = A.analyse(pour(60, tds=228), shifted)
tds = r["baseline"][1]
check("a small shift that persists is caught by EWMA or CUSUM", r["kind"] == "persistent_shift" and abs(tds["z"]) < 3 and (tds["ewma_signal"] or tds["cusum_signal"]), (r["kind"], tds))

r = A.analyse(pour(3, tds=190), quiet(3))
check("a new node falls back on typical local water", all(b["source"] == "typical" for b in r["baseline"]) and r["kind"] == "normal")

drift = [pour(i, tds=180 + 3 * i) for i in range(30)]
r = A.analyse(pour(31, tds=272), drift)
check("a slow one-way trend is flagged for a calibration check", r["sensor"][1]["status"] == "check" and "trended up" in r["sensor"][1]["note"], r["sensor"][1])

check("with no history the multivariate distance is the plain distance", A.mahalanobis([3, 4, 0], []) == 5.0)
both = [[x, x, 0.0] for x in (-2, -1, -1, 0, 0, 1, 1, 2, 0.5, -0.5)]
check("it allows for readings that usually move together", A.mahalanobis([2, 2, 0], both) < A.mahalanobis([2, -2, 0], both))

r = A.analyse(pour(31, tds=0), hist)
check("zero dissolved solids on unfiltered water is questioned", r["sensor"][1]["status"] == "check")

case = {"filter": "ZEROWATER", "before": spike, "after": pour(31, tds=4, phase="after")}
rep = A.rule_report(case, A.analyse(spike, hist, [peer("a", 198)]), [{"filter": "ZEROWATER", "status": "OK"}])
text = " ".join([rep["summary"]] + rep["findings"] + rep["actions"]).lower()
check("the rule-written report gives the before and after", "780 ppm to 4 ppm" in rep["summary"] and "back in range" in rep["summary"], rep["summary"])
check("it never calls the water safe or says to drink it", "safe" not in text and "drink" not in text)
check("it asks for a second pour and a lab test", any("second cup" in a for a in rep["actions"]) and any("lab" in a for a in rep["actions"]), rep["actions"])
still = {"filter": "BRITA", "before": pour(5, clarity=0.4, verdict="CLOUDY"), "after": pour(5, clarity=0.55, phase="after", verdict="CLOUDY")}
rep = A.rule_report(still, A.analyse(still["before"], hist), [])
check("a retest still out of range is acted on", rep["severity"] == 2 and "still out of range" in rep["summary"], rep)

# ---- triage: who a case needs
salty = A.analyse(spike, hist, [peer("a", 198)])
agents = lambda c, r: [x["agent"] for x in A.plan(c, r)]
check("a salty pour through a filter needs the analyst, the network, maintenance and comms", agents(case, salty) == ["analyst", "network", "maintenance", "comms"], agents(case, salty))
plain = {"filter": "BRITA", "before": pour(40, tds=205), "after": pour(40, tds=198, phase="after")}
check("an ordinary filtered pour needs only maintenance and comms", agents(plain, A.analyse(plain["before"], hist)) == ["maintenance", "comms"])
unfiltered = {"filter": "NONE", "before": pour(41, tds=205), "after": pour(41, tds=204, phase="after")}
check("an ordinary pour that was not filtered needs only the notice", agents(unfiltered, A.analyse(unfiltered["before"], hist)) == ["comms"])
fault = A.analyse(pour(50, tds=233), stuck)
check("a sensor fault is looked at first, and the water is not explained", agents({"filter": "NONE", "before": pour(50, tds=233), "after": None}, fault)[:1] == ["sensor-health"]
      and "analyst" not in agents({"filter": "NONE", "before": pour(50, tds=233), "after": None}, fault))
check("every planned specialist comes with a reason", all(x["why"] for x in A.plan(case, salty)))

# ---- the check on what the agents wrote
written = {"summary": "ZeroWater took it from 780 ppm to 4 ppm.", "findings": ["It read 780 ppm against a median of 204 ppm.", "The river read 9999 ppm."],
           "actions": ["Pour 2 more cups.", "Dilute it by 37%."], "sections": [{"agent": "analyst", "text": "z is 5.5"}, {"agent": "network", "text": "61 km away"}]}
kept, record = A.ground(written, '{"tds": 780, "after": 4, "median": 204.0, "z": 5.53}')
check("a finding whose figure no tool returned is dropped, and the others are kept", kept["findings"] == ["It read 780 ppm against a median of 204 ppm."])
check("so is an action; small counts are not treated as figures", kept["actions"] == ["Pour 2 more cups."])
check("a figure rounded from a tool's value still counts as traced", kept["sections"][0]["traced"] is True and kept["sections"][1]["traced"] is False)
check("the record says how many figures there were, how many traced and what was dropped",
      record["figures"] == 7 and record["traced"] == 4 and record["dropped"] == 2 and record["summary_ok"], record)
check("the limits the agents are told about are allowed", A.ground({"summary": "", "findings": ["It is above the 500 ppm guideline and outside 6.5 to 8.5."]}, "")[1]["dropped"] == 0)

print("\nall passed" if ok else "\nFAILURES")
raise SystemExit(0 if ok else 1)
