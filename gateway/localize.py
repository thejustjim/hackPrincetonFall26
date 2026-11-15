"""Source tracing on a SIMULATED pipe network: when several sensors alert, which pipe did the
change most likely enter from?

Nothing here is measured. Clarity's real hardware is one node and there is no real pipe network
behind it. This shows what a utility could do with many such nodes, on a textbook network:
WNTR's Net3 example (EPANET example network 3), with its flows frozen as they were at one
snapshot hour. The pipe materials, ages and break histories are synthetic, and so are the
alerts in the built-in scenarios. Every result carries "simulated": True and says so in words.

The method is the usual one for finding where a change entered, kept as simple as it goes:

  1. Flow graph      Every pipe points the way its water was flowing at the snapshot, and has a
                     travel time (its length divided by the water's speed).
  2. Candidates      From each alerting sensor, trace upstream for up to six hours of travel.
                     The pipes upstream of every alerting sensor are the candidates.
  3. Timing fit      For each candidate, predict when the change would reach each alerting
                     sensor. Nobody knows when it entered, so only the gaps between arrivals are
                     compared: subtract each set's mean, then take the root-mean-square mismatch
                     in minutes. Each alert's timing error is treated as Gaussian with a spread
                     of 10 minutes. A candidate that should also have reached a sensor that
                     stayed quiet keeps only a tenth of its weight for each such sensor.
  4. Prior           A risk score per pipe from its material, age, diameter and break count.
                     It is a hand-set score, not a trained model, and those attributes are
                     synthetic. It decides between pipes the timing cannot tell apart.
  5. Confidence      Prior times timing fit, scaled so the candidates add up to 1. It says how
                     the candidates compare with each other. It is not a probability that the
                     model is right about the real world.

What this cannot do:

  - Pipes whose water reaches the sensors through the same junction (pipes in a row, most
    often) give the same gaps, so timing never separates them. Only the risk score does, and
    the result says when that happened.
  - One alerting sensor gives no gaps at all. The ranking then rests on the risk score and on
    which sensors stayed quiet, and it is broad.
  - Real flows change through the day and these are frozen. Checked once against EPANET's own
    water-quality run: arrivals in the first hour, while the flows are still those of the
    snapshot, agreed to within a minute (35 compared). After that they drift apart, and by the
    fifth hour a far sensor was more than an hour off. A real tracer would have to follow the
    flows hour by hour.
  - The scenarios were generated with the same travel times this module predicts with, plus a
    few minutes of noise. They check the arithmetic, not the physics.

Standard library only, so the Raspberry Pi needs no WNTR. network.json is written once by
build_network.py. Test: python test_localize.py
"""
import heapq
import json
import math
import os

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "network.json")) as f:
    NET = json.load(f)

HORIZON_MIN = 360      # how far upstream the trace looks, and how long a change is followed downstream
SPREAD_MIN = 10.0      # timing spread: how far an alert may fall from its predicted minute
QUIET_WEIGHT = 0.1     # weight a candidate keeps for each quiet sensor it should have reached
POOR_FIT_MIN = 20.0    # a best mismatch above this (two spreads) means no candidate explains the timing
YEAR_NOW = 2026        # pipe ages are counted from this year
# The prior: four parts, each from 0 to 1, with hand-set weights that add up to 1.
WEIGHTS = {"material": 0.30, "age": 0.25, "diameter": 0.15, "breaks": 0.30}
MATERIAL_RISK = {"cast iron": 1.0, "asbestos cement": 0.7, "steel": 0.5, "ductile iron": 0.3, "PVC": 0.2}
DIAMETER_RISK = ((250, 1.0), (400, 0.6), (650, 0.3))   # up to this many mm scores this; anything larger scores 0.1
PRIOR_FLOOR = 0.05     # no pipe is ruled out by its attributes alone
METHOD = ("Simulated: traces upstream from every alerting sensor on a frozen snapshot of WNTR's Net3 example "
          "network, scores each pipe they share by how well its predicted gaps between arrivals match the observed "
          f"ones (spread {SPREAD_MIN:.0f} minutes) and by quiet sensors it should have reached, then weights it by a "
          "hand-set risk score built from synthetic pipe attributes.")

NODES = {n["id"]: n for n in NET["nodes"]}
PIPES = {p["id"]: p for p in NET["pipes"]}
DOWN, UP = {}, {}      # node -> [(next node, minutes)], along the flow and against it
for link in NET["pipes"] + NET.get("pumps", []):
    if link["travel_min"] is not None:
        DOWN.setdefault(link["from"], []).append((link["to"], link["travel_min"]))
        UP.setdefault(link["to"], []).append((link["from"], link["travel_min"]))


# ---------------------------------------------------------------- the prior: a hand-set risk score
def risk(p):
    """A pipe's risk score from 0.05 to 1. Hand-set, not trained, and its inputs are synthetic.
    Old cast iron, small diameters and a history of breaks score high."""
    parts = {"material": MATERIAL_RISK.get(p["material"], 0.5),
             "age": max(0, min(100, YEAR_NOW - p["year"])) / 100,
             "diameter": next((score for limit, score in DIAMETER_RISK if p["diameter_mm"] <= limit), 0.1),
             "breaks": min(5, p["breaks"]) / 5}
    return round(PRIOR_FLOOR + (1 - PRIOR_FLOOR) * sum(WEIGHTS[k] * parts[k] for k in WEIGHTS), 3)


# ---------------------------------------------------------------- steps 1 and 2: travel times
def travel(start, edges, limit=HORIZON_MIN):
    """Shortest travel time in minutes from `start` to every node within `limit`, following
    `edges` (DOWN for where the water goes, UP for where it came from). The fastest path is
    when a change first arrives. A tank or reservoir is an end: water that enters one mixes
    with what is stored, so nothing is traced through it."""
    best, heap = {start: 0.0}, [(0.0, start)]
    while heap:
        t, node = heapq.heappop(heap)
        if t > best[node] or (node != start and NODES[node]["kind"] != "junction"):
            continue
        for nxt, minutes in edges.get(node, ()):
            if t + minutes <= limit and t + minutes < best.get(nxt, math.inf):
                best[nxt] = t + minutes
                heapq.heappush(heap, (t + minutes, nxt))
    return best


def arrival(p, upstream):
    """Minutes for a change entering halfway along pipe `p` to reach the node that `upstream`
    was traced from, or None when it would not get there within the horizon."""
    if p["travel_min"] is None or p["to"] not in upstream:
        return None
    t = p["travel_min"] / 2 + upstream[p["to"]]
    return t if t <= HORIZON_MIN else None


def affected(p):
    """Junctions the change would reach within the horizon if it entered at pipe `p`:
    a stand-in for who would be affected."""
    reach = travel(p["to"], DOWN, HORIZON_MIN - p["travel_min"] / 2)
    nodes = sorted(n for n in reach if NODES[n]["kind"] == "junction")
    return {"junctions": len(nodes), "demand_lps": round(sum(NODES[n]["demand_lps"] for n in nodes), 1), "nodes": nodes}


# ---------------------------------------------------------------- steps 3 to 5: the ranking
def _empty(why):
    return {"simulated": True, "candidates": [], "considered": 0,
            "affected": {"junctions": 0, "demand_lps": 0.0, "nodes": []}, "method": METHOD, "note": why}


def localize(alerts, quiet=(), top=5):
    """alerts: [{"sensor": node id, "minute": when it alerted, on any clock}]. quiet: ids of
    sensors that did not alert. top: how many candidates to return (None for all of them).
    Returns the ranked candidates with a confidence each, and the reasons as sentences."""
    seen = {}
    try:
        for a in alerts or ():
            sensor, minute = str(a["sensor"]), float(a["minute"])
            if not math.isfinite(minute):
                raise ValueError(minute)
            if sensor not in NODES:
                return _empty(f"Simulated: {sensor} is not a node of this network, so there is nothing to trace.")
            seen[sensor] = min(minute, seen.get(sensor, math.inf))    # a sensor listed twice counts from its first alert
    except (KeyError, TypeError, ValueError):
        return _empty("Simulated: every alert needs a sensor and the minute it alerted, so there is nothing to trace.")
    if not seen:
        return _empty("Simulated: no sensor is alerting, so there is nothing to trace.")
    sensors = sorted(seen, key=lambda s: (seen[s], s))
    observed = [seen[s] for s in sensors]
    upstream = {s: travel(s, UP) for s in sensors}
    silent = {q: travel(q, UP) for q in dict.fromkeys(str(q) for q in quiet or ()) if q in NODES and q not in seen}
    n, mean_obs = len(sensors), sum(observed) / len(observed)
    group = "the alerting sensor" if n == 1 else "both alerting sensors" if n == 2 else f"all {n} alerting sensors"

    rows = []
    for p in NET["pipes"]:
        predicted = [arrival(p, upstream[s]) for s in sensors]
        if None in predicted:
            continue                                   # not upstream of every alerting sensor
        mean_pred = sum(predicted) / n
        fit = math.sqrt(sum((o - mean_obs - t + mean_pred) ** 2 for o, t in zip(observed, predicted)) / n)
        missed = [(q, t) for q, t in ((q, arrival(p, up)) for q, up in silent.items()) if t is not None]
        prior = risk(p)
        log_weight = math.log(prior) - n * fit ** 2 / (2 * SPREAD_MIN ** 2) + len(missed) * math.log(QUIET_WEIGHT)
        rows.append({"p": p, "predicted": predicted, "fit": fit, "missed": sorted(missed, key=lambda m: m[1]),
                     "prior": prior, "log": log_weight, "entered": mean_obs - mean_pred})
    if not rows:
        if n == 1:
            return _empty(f"Simulated: no pipe with flowing water lies within {HORIZON_MIN // 60} hours upstream of "
                          f"sensor {sensors[0]}, so there is nothing to rank.")
        return _empty(f"Simulated: no pipe lies upstream of {group} within {HORIZON_MIN // 60} hours of travel, "
                      "so no single entry point explains these alerts. They may be separate events.")

    # Work with logarithms and take off the largest, so a poor fit everywhere still divides cleanly.
    peak = max(r["log"] for r in rows)
    total = sum(math.exp(r["log"] - peak) for r in rows)
    for r in rows:
        r["confidence"] = math.exp(r["log"] - peak) / total
    rows.sort(key=lambda r: (-r["confidence"], r["p"]["id"]))

    out = []
    for r in rows[:None if top is None else max(0, int(top))]:
        p = r["p"]
        first, last = min(r["predicted"]), max(r["predicted"])
        why = [f"It is upstream of {group}: a change entering here would arrive after about {first:.0f} minutes"
               + ("." if n == 1 else f" at the nearest and {last:.0f} at the farthest.")]
        if n == 1:
            why.append("With one alerting sensor there are no gaps between arrivals to compare, so the timing "
                       "cannot tell the candidates apart.")
        else:
            why.append(f"The predicted gaps between arrivals match the observed ones to within {r['fit']:.1f} minutes "
                       f"(root mean square, against a spread of {SPREAD_MIN:.0f}). If it entered here, that was about "
                       f"{max(0.0, observed[0] - r['entered']):.0f} minutes before the first alert.")
        if r["missed"]:
            names = ", ".join(f"{q} (after about {t:.0f} minutes)" for q, t in r["missed"][:3])
            more = f" and {len(r['missed']) - 3} more" if len(r["missed"]) > 3 else ""
            why.append(f"It should also have reached {len(r['missed'])} sensor{'s' if len(r['missed']) != 1 else ''} "
                       f"that stayed quiet: {names}{more}. That counts against it.")
        elif silent:
            why.append(f"None of the {len(silent)} quiet sensor{'s' if len(silent) != 1 else ''} is within "
                       f"{HORIZON_MIN // 60} hours downstream of it, which agrees with their staying quiet.")
        why.append(f"Hand-set risk score {r['prior']:.2f} from synthetic attributes: {p['material']}, laid in {p['year']}, "
                   f"{p['diameter_mm']:.0f} mm across, {p['breaks']} recorded break{'s' if p['breaks'] != 1 else ''}.")
        out.append({"pipe": p["id"], "from": p["from"], "to": p["to"], "confidence": round(r["confidence"], 6),
                    "fit_minutes": None if n == 1 else round(r["fit"], 1), "prior": r["prior"],
                    "attributes": {k: p[k] for k in ("material", "year", "breaks", "diameter_mm", "length_m")},
                    "rationale": why})

    best = rows[0]
    note = (f"Simulated: {len(rows)} pipe{'s lie' if len(rows) != 1 else ' lies'} upstream of {group}. "
            f"The most likely entry point is pipe {best['p']['id']}, with {best['confidence']:.0%} of the confidence.")
    # How many candidates the alerts cannot tell apart from the top one: the same weight before the prior.
    level = sum(abs((r["log"] - math.log(r["prior"])) - (best["log"] - math.log(best["prior"]))) < 1e-6 for r in rows)
    if n == 1:
        note += (" One sensor gives no timing to compare, so this ranking rests on the risk score and on which "
                 "sensors stayed quiet, and it is broad.")
    elif min(r["fit"] for r in rows) > POOR_FIT_MIN:
        note += (f" No candidate explains the timing well (the best mismatch is {min(r['fit'] for r in rows):.0f} "
                 "minutes), so treat this ranking as weak.")
    elif level > 1:
        note += (f" {level} candidates explain the alerts equally well, usually because their water reaches the "
                 "sensors through the same junction, so the hand-set risk score is all that separates them.")
    return {"simulated": True, "candidates": out, "considered": len(rows), "affected": affected(best["p"]),
            "method": METHOD, "note": note}


# ---------------------------------------------------------------- what the web server asks for
def summary():
    return {"simulated": True, "name": NET["name"], "source": NET["source"], "snapshot_hour": NET["snapshot_hour"],
            "note": NET["note"], "nodes": len(NET["nodes"]), "pipes": len(NET["pipes"]), "sensors": len(NET["sensors"]),
            "scenarios": len(NET["scenarios"]), "horizon_min": HORIZON_MIN}


def network():
    """The map to draw: nodes, pipes (each with its risk score), pumps and sensors.
    The scenarios are left out because they hold the answers."""
    return {"simulated": True, "name": NET["name"], "nodes": NET["nodes"],
            "pipes": [dict(p, prior=risk(p)) for p in NET["pipes"]],
            "pumps": NET.get("pumps", []), "sensors": NET["sensors"]}


def scenarios():
    """The built-in scenarios, without the pipe each change really entered from."""
    return [{k: s[k] for k in ("id", "name", "description", "hard", "alerts", "quiet")} for s in NET["scenarios"]]


def scenario_result(scenario_id, top=5):
    """The ranking for one scenario, with the pipe the change really entered from and where
    that pipe came in the ranking (counted over every candidate, not only the ones returned).
    None for an unknown id."""
    s = next((s for s in NET["scenarios"] if s["id"] == scenario_id), None)
    if s is None:
        return None
    out = localize(s["alerts"], s["quiet"], top=None)
    place = next((i for i, c in enumerate(out["candidates"]) if c["pipe"] == s["truth"]), None)
    out["truth"] = {"pipe": s["truth"], "rank": None if place is None else place + 1,
                    "confidence": None if place is None else out["candidates"][place]["confidence"]}
    out["candidates"] = out["candidates"][:None if top is None else max(0, int(top))]
    out.update({k: s[k] for k in ("id", "name", "description", "hard", "alerts", "quiet")})
    return out


def pipe(pipe_id):
    """One pipe's attributes and its risk score, or None if there is no such pipe."""
    p = PIPES.get(pipe_id)
    return None if p is None else dict(p, prior=risk(p), simulated=True)
