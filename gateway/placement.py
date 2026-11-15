"""Greedy sensor placement on the frozen SIMULATED Net3 flow graph.

No network, WNTR, cloud or model calls. This is an equal-cost placement heuristic for a
synthetic graph, not an optimal placement proof or locations in Princeton. Every one of the
117 source-pipe events remains in the denominator, including events no sensor can observe.

Run explicitly to refresh the static fixture: python gateway/placement.py
The gateway may call payload(); that is cached and never writes a file.
"""
from functools import lru_cache
import heapq
import json
import math
from pathlib import Path
import statistics

BUDGETS = (4, 8, 12, 16, 20)
HORIZON_MIN = 360.0
SECOND_WEIGHT = 0.6
EARLY_WEIGHT = 0.1
SOURCE = Path(__file__).with_name("network.json")


def _network(net=None):
    return net if net is not None else json.loads(SOURCE.read_text())


def _model(net):
    nodes = {n["id"]: n for n in net["nodes"]}
    # Positive-demand junctions stand in for places a utility could actually sample.
    candidates = sorted(n["id"] for n in net["nodes"] if n["kind"] == "junction" and n.get("demand_lps", 0) > 0)
    edges = {}
    for pipe in net["pipes"] + net.get("pumps", []):
        minutes = pipe.get("travel_min")
        if minutes is not None and math.isfinite(minutes) and minutes >= 0:
            edges.setdefault(pipe["from"], []).append((pipe["to"], minutes))
    arrivals = {}
    for pipe in net["pipes"]:
        minutes = pipe.get("travel_min")
        reach = {}
        if minutes is not None and math.isfinite(minutes) and minutes >= 0:
            first = minutes / 2
            heap, reach = [(first, pipe["to"])], {pipe["to"]: first} if first <= HORIZON_MIN else {}
            while heap:
                elapsed, node = heapq.heappop(heap)
                if elapsed > HORIZON_MIN or elapsed != reach.get(node) or nodes[node]["kind"] != "junction":
                    continue
                for nxt, duration in edges.get(node, ()):
                    at = elapsed + duration
                    if at <= HORIZON_MIN and at < reach.get(nxt, math.inf):
                        reach[nxt] = at
                        heapq.heappush(heap, (at, nxt))
        arrivals[pipe["id"]] = {s: reach[s] for s in candidates if s in reach}
    return candidates, arrivals


def _evaluate(sensors, arrivals):
    sensors = set(sensors)          # two copies of one sensor do not make independent coverage
    first, covered, two, missing = [], [], [], []
    capped = 0.0
    for pipe, reach in arrivals.items():
        times = [reach[s] for s in sensors if s in reach]
        if times:
            covered.append(pipe)
            first.append(min(times))
            capped += min(times)
            if len(times) >= 2:
                two.append(pipe)
        else:
            missing.append(pipe)
            capped += HORIZON_MIN
    events = len(arrivals)
    early = events - capped / HORIZON_MIN
    return {"events": events, "observed": len(covered), "localized": len(two), "unobserved": len(missing),
            "median_first_alert_min": round(statistics.median(first), 2) if first else None,
            "mean_capped_first_alert_min": round(capped / events, 2) if events else None,
            "objective_score": round(len(covered) + SECOND_WEIGHT * len(two) + EARLY_WEIGHT * early, 6),
            "covered_pipes": covered, "two_sensor_pipes": two, "unobserved_pipes": missing}


def evaluate(sensor_ids, net=None):
    """Counts/time for selected sites. 'localized' means >=2 sensors, not correct localization."""
    candidates, arrivals = _model(_network(net))
    unknown = set(sensor_ids) - set(candidates)
    if unknown:
        raise ValueError("sensor sites must be positive-demand junctions of the simulated graph")
    return _evaluate(sensor_ids, arrivals)


def _greedy(budget, candidates, arrivals):
    if type(budget) is not int or not 0 <= budget <= len(candidates):
        raise ValueError("budget must be an integer within the available candidate count")
    selected, steps = [], []
    counts = {p: 0 for p in arrivals}
    earliest = {p: HORIZON_MIN for p in arrivals}
    for _ in range(budget):
        best = None
        for sensor in candidates:
            if sensor in selected:
                continue
            first = second = 0
            delay = 0.0
            for pipe, reach in arrivals.items():
                if sensor in reach:
                    first += counts[pipe] == 0
                    second += counts[pipe] == 1
                    delay += max(0, earliest[pipe] - reach[sensor])
            score = first + SECOND_WEIGHT * second + EARLY_WEIGHT * delay / HORIZON_MIN
            # Sorted IDs plus a strict comparison provide deterministic ties without randomness.
            if best is None or score > best[0] + 1e-12:
                best = (score, sensor, first, second, delay)
        if best is None or best[0] <= 1e-12:
            break                  # never spend a spare slot on a site with no modeled benefit
        score, sensor, first, second, delay = best
        selected.append(sensor)
        for pipe, reach in arrivals.items():
            if sensor in reach:
                counts[pipe] += 1
                earliest[pipe] = min(earliest[pipe], reach[sensor])
        steps.append({"node": sensor, "newly_observed_events": first, "newly_two_sensor_events": second,
                      "total_first_alert_minutes_saved": round(delay, 2), "marginal_score": round(score, 6)})
    return {"budget": budget, "sensors": selected, "installed_count": len(selected),
            "unused_budget": budget - len(selected), "metrics": _evaluate(selected, arrivals), "steps": steps}


def greedy_plan(budget, net=None):
    candidates, arrivals = _model(_network(net))
    return _greedy(budget, candidates, arrivals)


def build_payload(net=None):
    net = _network(net)
    candidates, arrivals = _model(net)
    existing = list(net["sensors"])
    plans = [_greedy(b, candidates, arrivals) for b in BUDGETS if b <= len(candidates)]
    previous = []
    for plan in plans:
        plan["added_from_previous"] = [s for s in plan["sensors"] if s not in previous]
        previous = plan["sensors"]
    maximum = _evaluate(candidates, arrivals)
    return {"simulated": True,
            "model": {"name": net["name"], "source": net["source"], "snapshot_hour": net["snapshot_hour"],
                      "horizon_min": HORIZON_MIN, "event_count": len(arrivals), "candidate_count": len(candidates),
                      "budget_kind": "total_sensors", "maximum_observable_events": maximum["observed"],
                      "never_observable_pipes": maximum["unobserved_pipes"],
                      "objective": "A newly observed source-pipe event adds 1 point; coverage by a second independent sensor adds 0.6; earlier first detection adds up to 0.1 per event over six hours. Each step takes the largest marginal gain; node ID breaks ties. Each site has the same assumed cost.",
                      "note": "Simulated Net3 graph in its own drawing coordinates, not real Princeton sensor locations. Flows and travel times are frozen at one hour. Events enter halfway along each pipe; tanks/reservoirs stop the trace. A greedy recommendation is not guaranteed optimal. Two-sensor coverage is an opportunity to compare arrival times, not successful localization. Median detection time includes observed events only; capped mean assigns six hours to unobserved events. No sensor failures are injected into this placement calculation.",
                      "weights": {"first_sensor": 1.0, "second_sensor": SECOND_WEIGHT, "early_detection": EARLY_WEIGHT}},
            "nodes": [{k: n[k] for k in ("id", "x", "y", "kind", "demand_lps")} for n in net["nodes"]],
            "pipes": [{k: p[k] for k in ("id", "from", "to", "travel_min")} for p in net["pipes"]],
            "pumps": [{k: p[k] for k in ("id", "from", "to", "travel_min")} for p in net.get("pumps", [])],
            "existing": {"sensors": existing, "metrics": _evaluate(existing, arrivals)}, "budgets": plans}


@lru_cache(maxsize=1)
def payload():
    """Cached, read-only API entry point. Regeneration is explicit CLI work, never a GET side effect."""
    return build_payload()


if __name__ == "__main__":
    output = SOURCE.parent.parent / "web" / "network" / "placement.json"
    data = build_payload()
    output.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {output}: {data['model']['event_count']} pipe events, {len(data['budgets'])} budgets")
    for plan in data["budgets"]:
        m = plan["metrics"]
        print(f"{plan['installed_count']} sites: {m['observed']}/{m['events']} observed, {m['localized']} with two sensors, median {m['median_first_alert_min']} min")
