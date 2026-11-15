"""Seeded stress cases for the existing Net3 snapshot; no WNTR, network or model calls.

These deliberately perturb sensor observations and travel times. They are sensitivity tests
of a frozen synthetic model, not independent hydraulic validation or field performance.
"""
import copy
import random

import build_network


def stress_scenarios(net):
    """Keep the presenter cases intact and add failures with their ground truth held separately.
    Unavailable sensors are never silently treated as observed-quiet sensors.
    """
    base = next(s for s in net["scenarios"] if s["id"] == "five-sensors")
    make = lambda: copy.deepcopy(base)
    dropout = make()
    dropout.update(id="sensor-dropout", name="Stress: four sensors offline", hard=True, stress=True,
                   alerts=base["alerts"][:1], unavailable=[a["sensor"] for a in base["alerts"][1:]],
                   description="Simulated stress test: four sensors that would have alerted are unavailable. Only one alert remains; unavailable sensors are not evidence of quiet water.")
    delayed = make()
    delayed["alerts"][-1]["minute"] += 120
    delayed["alerts"].sort(key=lambda a: (a["minute"], a["sensor"]))
    delayed.update(id="delayed-sensor", name="Stress: one late sensor", hard=True, stress=True,
                   description="Simulated stress test: the last sensor reports 120 minutes late. Relative arrival times no longer fit the frozen-flow model; a large ranking weight is not a reliable answer.")
    conflict = make()
    false_sensor = base["quiet"][0]
    conflict["alerts"].append({"sensor": false_sensor, "minute": base["alerts"][0]["minute"] + 5})
    conflict["alerts"].sort(key=lambda a: (a["minute"], a["sensor"]))
    conflict["quiet"].remove(false_sensor)
    conflict.update(id="conflicting-alerts", name="Stress: an unrelated alert", hard=True, stress=True,
                    description="Simulated stress test: a sensor outside this event reports an unrelated alert. Forcing every alert into one source can exclude the true pipe; investigate the disagreement rather than act on the leading weight.")
    return [dropout, delayed, conflict]


def observations(net, pipe_id, rng, noise=4.0, dropout=0.0, mismatch=0.0):
    """Return alerts, observed-quiet and unavailable sensors for a source pipe.
    Mismatch perturbs each edge's travel time independently; the inverse tracer still uses
    the original snapshot. It does not simulate changing flow direction or water chemistry.
    """
    pipes = [dict(p) for p in net["pipes"]]
    pumps = [dict(p) for p in net.get("pumps", [])]
    if mismatch:
        for link in pipes + pumps:
            if link["travel_min"] is not None:
                link["travel_min"] *= rng.uniform(1 - mismatch, 1 + mismatch)
    p = next(p for p in pipes if p["id"] == pipe_id)
    reached = {} if p["travel_min"] is None else build_network.spread_from(
        p, pipes, pumps, {n["id"]: n["kind"] for n in net["nodes"]})
    alerts, quiet, unavailable = [], [], []
    for sensor in net["sensors"]:
        if rng.random() < dropout:
            unavailable.append(sensor)
        elif sensor in reached:
            alerts.append({"sensor": sensor, "minute": round(reached[sensor] + rng.gauss(0, noise), 2)})
        else:
            quiet.append(sensor)
    return sorted(alerts, key=lambda a: (a["minute"], a["sensor"])), quiet, unavailable


def network_benchmark(net, trace, trials=2, seed=20261115):
    """Every pipe is tested in every profile. Counts include unobserved cases explicitly."""
    profiles = [
        ("baseline", "Four-minute sensor noise", 4.0, 0.0, 0.0),
        ("noisy", "Eighteen-minute sensor noise", 18.0, 0.0, 0.0),
        ("dropout", "Thirty-five percent sensor dropout", 4.0, 0.35, 0.0),
        ("mismatch", "Travel times perturbed by up to fifty percent", 4.0, 0.0, 0.5),
    ]
    rows = []
    for index, (key, label, noise, dropout, mismatch) in enumerate(profiles):
        rng = random.Random(seed + index)
        row = dict(id=key, label=label, trials=trials * len(net["pipes"]), observed=0,
                   multi_sensor=0, top1=0, top3=0, source_in_candidates=0, weak=0)
        for _ in range(trials):
            for pipe in net["pipes"]:
                alerts, quiet, _ = observations(net, pipe["id"], rng, noise, dropout, mismatch)
                if not alerts:
                    continue
                row["observed"] += 1
                row["multi_sensor"] += len(alerts) >= 2
                result = trace(alerts, quiet, top=None)
                rank = next((i + 1 for i, c in enumerate(result["candidates"]) if c["pipe"] == pipe["id"]), None)
                row["source_in_candidates"] += rank is not None
                row["top1"] += rank == 1
                row["top3"] += rank is not None and rank <= 3
                row["weak"] += result.get("fit_quality") != "usable"
        rows.append(row)
    return {"simulated": True, "seed": seed, "repeats_per_pipe": trials,
            "note": "Seeded synthetic sensitivity check on the frozen Net3 snapshot. Top-one and top-three counts are out of observed cases, not all events; unobserved events are reported separately. Travel-time perturbation is a model-mismatch stress test, not an independent hydraulic simulation or field accuracy.",
            "profiles": rows}
