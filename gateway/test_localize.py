"""Checks for localize.py. Run: python test_localize.py"""
import build_network as B     # only its standard-library half: WNTR is imported when it builds, not here
import localize as L

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")


def strings(x):
    """Every piece of text anywhere inside a result."""
    if isinstance(x, str):
        return [x]
    if isinstance(x, dict):
        return [s for k, v in x.items() for s in strings(k) + strings(v)]
    return [s for v in x for s in strings(v)] if isinstance(x, (list, tuple)) else []


def conf(result, pipe_id):
    return next((c["confidence"] for c in result["candidates"] if c["pipe"] == pipe_id), None)


truth = {s["id"]: s["truth"] for s in L.NET["scenarios"]}
listed = [s for s in L.scenarios() if not s.get("stress")]
full = {s["id"]: L.scenario_result(s["id"], top=None) for s in listed}
everything = [L.summary(), L.network(), listed, L.pipe(L.NET["pipes"][0]["id"])] + list(full.values())

# ---------------------------------------------------------------- the network and the scenarios
s = L.summary()
check("the summary counts the network and says it is simulated",
      s["simulated"] is True and (s["nodes"], s["pipes"], s["sensors"]) == (97, 117, 12) and s["snapshot_hour"] == 3, s)
check("the sensors are junctions of the network", all(L.NODES[n]["kind"] == "junction" for n in L.NET["sensors"]))
check("the four presenter scenarios remain, with one hard case", len(listed) == 4 and sum(s["hard"] for s in listed) == 1)
check("the listed scenarios do not give the answer away", not any("truth" in s for s in listed))
check("the ordinary scenarios have 2 to 5 alerting sensors and the hard one has 1 or 2",
      all((1 <= len(s["alerts"]) <= 2) if s["hard"] else (2 <= len(s["alerts"]) <= 5) for s in listed), [len(s["alerts"]) for s in listed])

# ---------------------------------------------------------------- every scenario
for s in listed:
    r = full[s["id"]]
    place = r["truth"]["rank"]
    check(f"{s['id']}: the true pipe is among the candidates", place is not None and r["truth"]["pipe"] == truth[s["id"]], r["truth"])
    if not s["hard"]:
        check(f"{s['id']}: the true pipe is in the top three", place is not None and place <= 3, r["truth"])
    total = sum(c["confidence"] for c in r["candidates"])
    check(f"{s['id']}: the confidences add up to 1", abs(total - 1) < 1e-4 and all(0 <= c["confidence"] <= 1 for c in r["candidates"]), total)
    check(f"{s['id']}: the candidates are ranked, most likely first",
          [c["confidence"] for c in r["candidates"]] == sorted((c["confidence"] for c in r["candidates"]), reverse=True)
          and len(r["candidates"]) == r["considered"])
    check(f"{s['id']}: every candidate gives its reasons as sentences that carry numbers",
          all(len(c["rationale"]) >= 3 and all(any(ch.isdigit() for ch in line) or "one alerting sensor" in line for line in c["rationale"])
              for c in r["candidates"]))
    plain = L.localize(s["alerts"], s["quiet"], top=None)
    check(f"{s['id']}: the ranking is worked out from the alerts alone, not from the answer",
          [(c["pipe"], c["confidence"]) for c in plain["candidates"]] == [(c["pipe"], c["confidence"]) for c in r["candidates"]])

first = next(s for s in listed if not s["hard"])
r = L.scenario_result(first["id"])
check("by default only the top five come back, with the count of all considered", len(r["candidates"]) == 5 and r["considered"] > 5)
check("an unknown scenario gives nothing", L.scenario_result("no-such-scenario") is None)
check("who would be affected is counted downstream of the top candidate",
      r["affected"]["junctions"] == len(r["affected"]["nodes"]) > 0 and r["affected"]["demand_lps"] > 0
      and r["candidates"][0]["to"] in r["affected"]["nodes"] and all(L.NODES[n]["kind"] == "junction" for n in r["affected"]["nodes"]), r["affected"])

# ---------------------------------------------------------------- the timing
later = L.localize([{"sensor": a["sensor"], "minute": a["minute"] + 500} for a in first["alerts"]], first["quiet"], top=None)
check("moving every alert by the same amount changes nothing, since nobody knows when it entered",
      all(abs(c["confidence"] - conf(full[first["id"]], c["pipe"])) < 1e-6 for c in later["candidates"]))
minutes = [a["minute"] for a in first["alerts"]]
wrong = L.localize([{"sensor": a["sensor"], "minute": m} for a, m in zip(first["alerts"], reversed(minutes))], first["quiet"])
check("alerts in the wrong order fit badly, and the result says the ranking is weak",
      wrong["candidates"][0]["fit_minutes"] > L.POOR_FIT_MIN and "weak" in wrong["note"], wrong["note"])
check("a good fit is within a few minutes", full[first["id"]]["candidates"][0]["fit_minutes"] < L.SPREAD_MIN)

# ---------------------------------------------------------------- one sensor
hard = next(s for s in listed if s["hard"])
r = full[hard["id"]]
check("the hard scenario is honestly uncertain: many candidates and no confident answer",
      r["considered"] >= 10 and r["candidates"][0]["confidence"] < 0.5, (r["considered"], r["candidates"][0]["confidence"]))
lone = L.localize([{"sensor": hard["alerts"][0]["sensor"], "minute": 0}], top=None)
check("one alerting sensor gives a broad list with low top confidence",
      lone["considered"] >= 10 and lone["candidates"][0]["confidence"] < 0.25, (lone["considered"], lone["candidates"][0]["confidence"]))
check("with one sensor there is no timing fit to report, and the result says so",
      all(c["fit_minutes"] is None for c in lone["candidates"]) and "no timing" in lone["note"], lone["note"])
check("with one sensor and nothing quiet the ranking is the risk score alone",
      [c["pipe"] for c in lone["candidates"]] == [p["id"] for p in sorted((L.PIPES[c["pipe"]] for c in lone["candidates"]), key=lambda p: (-L.risk(p), p["id"]))])

# ---------------------------------------------------------------- quiet sensors
sensor = hard["alerts"][0]["sensor"]
other = next(q for q in L.NET["sensors"] if q != sensor and any(L.arrival(L.PIPES[c["pipe"]], L.travel(q, L.UP)) for c in lone["candidates"]))
reaches = [c["pipe"] for c in lone["candidates"] if L.arrival(L.PIPES[c["pipe"]], L.travel(other, L.UP)) is not None]
misses = [c["pipe"] for c in lone["candidates"] if c["pipe"] not in reaches]
hushed = L.localize([{"sensor": sensor, "minute": 0}], quiet=[other], top=None)
check("a quiet sensor downstream lowers a candidate's confidence",
      reaches and all(conf(hushed, p) < conf(lone, p) for p in reaches), (other, reaches[:3]))
check("and raises the candidates that would not have reached it", misses and all(conf(hushed, p) > conf(lone, p) for p in misses))
check("the reason names the quiet sensor",
      any(f"stayed quiet: {other}" in line for c in hushed["candidates"] if c["pipe"] in reaches for line in c["rationale"]))

# ---------------------------------------------------------------- nothing to trace
apart = L.localize([{"sensor": "101", "minute": 0}, {"sensor": "123", "minute": 5}])    # one below each source
check("sensors with no common upstream pipe give an empty list and say why",
      apart["candidates"] == [] and apart["considered"] == 0 and "no pipe lies upstream of both" in apart["note"], apart["note"])
empties = [apart, L.localize([]), L.localize([{"sensor": "not-a-node", "minute": 3}]), L.localize([{"sensor": "15"}]),
           L.localize([{"sensor": "15", "minute": "nan"}]), L.localize(["15"]), L.localize(None)]
check("no alerts, an unknown sensor or a missing or unusable minute give an empty list, not an error",
      all(e["candidates"] == [] and e["note"] and e["affected"]["junctions"] == 0 for e in empties))
twice = L.localize(first["alerts"] + [{"sensor": first["alerts"][0]["sensor"], "minute": first["alerts"][0]["minute"] + 30}], first["quiet"], top=None)
check("a sensor listed twice counts from its first alert",
      [(c["pipe"], c["confidence"]) for c in twice["candidates"]] == [(c["pipe"], c["confidence"]) for c in full[first["id"]]["candidates"]])

# ---------------------------------------------------------------- the prior
old = {"material": "cast iron", "year": 1930, "diameter_mm": 203, "breaks": 4}
new = {"material": "PVC", "year": 2015, "diameter_mm": 203, "breaks": 0}
check("the risk score puts old cast iron with breaks above new plastic", L.risk(old) > 0.8 and L.risk(new) < 0.35, (L.risk(old), L.risk(new)))
check("every pipe's risk score is between the floor and 1", all(L.PRIOR_FLOOR <= L.risk(p) <= 1 for p in L.NET["pipes"]))
check("a pipe can be looked up, and an unknown one gives nothing",
      L.pipe(truth[first["id"]])["material"] in L.MATERIAL_RISK and L.pipe("no-such-pipe") is None)

# ---------------------------------------------------------------- the prior, fitted
rates = {m: round(v * 50, 2) for m, v in L.BREAK_RATES.items()}
drawn = {"cast iron": 1.6, "asbestos cement": 1.0, "steel": 0.5, "ductile iron": 0.5, "PVC": 0.2}      # the rule in build_network.py, breaks per 50 years
check("the fitted break rates come out near the rule the synthetic history was drawn from",
      all(abs(rates[m] - drawn[m]) < 0.45 for m in drawn if m in rates) and rates["cast iron"] > rates["asbestos cement"] > rates["PVC"], rates)
same = {"material": "cast iron", "year": 1950, "diameter_mm": 203}
check("a pipe with more breaks than its like scores higher, and one that has lasted with none scores lower",
      L.fitted_risk({**same, "breaks": 5}) > L.fitted_risk({**same, "breaks": 1}) > L.fitted_risk({**same, "breaks": 0}))
check("old cast iron with breaks is above new plastic", L.fitted_risk(old) > L.fitted_risk(new) + 0.2, (L.fitted_risk(old), L.fitted_risk(new)))
check("every pipe's fitted risk is between the floor and 1", all(L.PRIOR_FLOOR <= L.fitted_risk(p) <= 1 for p in L.NET["pipes"]))
check("a material it has never seen gets the overall rate", L.PRIOR_FLOOR < L.fitted_risk({"material": "copper", "year": 1980, "diameter_mm": 100, "breaks": 0}) < 1)
for s in listed:
    f = L.localize(s["alerts"], s["quiet"], top=None, prior="fitted")
    h = full[s["id"]]
    check(f"{s['id']}: with the fitted prior the same pipes are candidates, the weights add up to 1, and the reasons say which prior",
          {c["pipe"] for c in f["candidates"]} == {c["pipe"] for c in h["candidates"]} and abs(sum(c["confidence"] for c in f["candidates"]) - 1) < 1e-4
          and all(any("Fitted break-rate risk" in line for line in c["rationale"]) for c in f["candidates"]))
fit_rows = B.check_every_pipe(L.NET, lambda a, q, top=None: L.localize(a, q, top=top, prior="fitted"))
check("with the fitted prior a change entering at any pipe a sensor can see is still among the candidates",
      len(fit_rows) > 50 and all(place is not None for _, _, place, _ in fit_rows))
many = lambda rows: [r for r in rows if r[1] >= 2]
print("INFO two or more sensors alerting,", len(many(fit_rows)), "pipes: the true pipe is first for",
      sum(r[2] == 1 for r in many(B.check_every_pipe(L.NET, L.localize))), "with the hand-set score and", sum(r[2] == 1 for r in many(fit_rows)), "with the fitted model")

# ---------------------------------------------------------------- honesty
everything += empties + [later, wrong, lone, hushed]
check("every result says it is simulated", all(x["simulated"] is True for x in everything if isinstance(x, dict)))
check("the method and the note of every result say it is simulated in words",
      all(x["method"].startswith("Simulated") and x["note"].startswith("Simulated") for x in everything if isinstance(x, dict) and "method" in x))
check("the network file says which parts are synthetic", L.NET["simulated"] is True and "synthetic" in L.NET["note"])
text = " ".join(strings(everything) + strings(L.NET)).lower()
check('no output text contains the word "safe"', "safe" not in text)
check("no output text promises anything about drinking or health", not any(w in text for w in ("drink", "healthy", "contaminat")))

# ---------------------------------------------------------------- stress cases: missing is not quiet, and bad timing is not a diagnosis
stress = {s["id"]: L.scenario_result(s["id"]) for s in L.scenarios() if s.get("stress")}
check("three observation-failure cases are available", set(stress) == {"sensor-dropout", "delayed-sensor", "conflicting-alerts"})
drop = stress["sensor-dropout"]
check("offline sensors are not evidence of quiet water", len(drop["unavailable"]) == 4 and not set(drop["unavailable"]) & set(drop["quiet"]))
check("one surviving sensor remains insufficient", drop["fit_quality"] == "insufficient" and drop["candidates"][0]["confidence"] < 0.35)
check("a delayed sensor exposes a poor timing fit", stress["delayed-sensor"]["fit_quality"] == "poor")
check("an unrelated alert can exclude the actual source", stress["conflicting-alerts"]["truth"]["rank"] is None)
check("conflicting timing stays labeled weak despite concentrated weight", stress["conflicting-alerts"]["fit_quality"] == "poor")

# ---------------------------------------------------------------- the whole network, not only the chosen scenarios
rows = B.check_every_pipe(L.NET, L.localize)
check(f"a change entering at any of the {len(rows)} pipes a sensor can see is always among the candidates",
      len(rows) > 50 and all(place is not None for _, _, place, _ in rows), [r for r in rows if r[2] is None])
for line in B.check_lines(L.NET, rows):
    print("INFO", line)

print("\nall passed" if ok else "\nFAILURES")
raise SystemExit(0 if ok else 1)
