"""Placement checks against hand-worked chains and the existing frozen Net3 graph. No services."""
import json
from pathlib import Path

import localize
import placement


def node(name, kind="junction", demand=1):
    return {"id": name, "x": 0, "y": 0, "kind": kind, "demand_lps": demand}


def pipe(name, a, b, minutes):
    return {"id": name, "from": a, "to": b, "travel_min": minutes}


tiny = {"nodes": [node("R", "reservoir", 0)] + [node(n) for n in "ABCDE"],
        "pipes": [pipe("1", "R", "A", 60), pipe("2", "A", "B", 60), pipe("3", "B", "C", 60),
                  pipe("4", "R", "D", 60), pipe("5", "R", "E", None)], "pumps": [], "sensors": ["B"]}
m = placement.evaluate(["C"], tiny)
assert (m["observed"], m["localized"], m["unobserved"]) == (3, 0, 2)
assert m["median_first_alert_min"] == 90
assert m["mean_capped_first_alert_min"] == 198
assert placement.evaluate(["C", "C"], tiny) == m, "a repeated site is not an independent second sensor"
assert placement.greedy_plan(1, tiny)["sensors"] == ["C"], "the first site should cover the most source events"
second = placement.greedy_plan(2, tiny)
assert second["sensors"] == ["C", "B"] and second["metrics"]["localized"] == 2
assert placement.evaluate([], tiny)["mean_capped_first_alert_min"] == placement.HORIZON_MIN
for bad in (True, -1, 1.5, 100):
    try:
        placement.greedy_plan(bad, tiny)
        raise AssertionError("invalid budget accepted")
    except ValueError:
        pass
# Tank mixing is a boundary, even when an outgoing edge exists.
blocked = {**tiny, "nodes": [node("R", "reservoir", 0), node("T", "tank", 0), node("A")],
           "pipes": [pipe("in", "R", "T", 10), pipe("out", "T", "A", 10)], "sensors": ["A"]}
assert placement.evaluate(["A"], blocked)["observed"] == 1

net = localize.NET
data = placement.build_payload(net)
assert data == placement.build_payload(net), "the same graph must yield the same recommendations"
assert data["simulated"] and data["model"]["event_count"] == len(net["pipes"]) == 117
assert len(data["nodes"]) == len(net["nodes"]) and len(data["pipes"]) == 117
assert [p["budget"] for p in data["budgets"]] == list(placement.BUDGETS)
base = data["existing"]["metrics"]
assert (base["observed"], base["localized"], base["unobserved"]) == (87, 71, 30), base
# Match the tracer's actual reachability for every pipe, independently of the greedy score.
candidates = data["existing"]["sensors"]
for p in net["pipes"]:
    hits = [s for s in candidates if localize.arrival(p, localize.travel(s, localize.UP)) is not None]
    assert (p["id"] in base["covered_pipes"]) == bool(hits), p["id"]
    assert (p["id"] in base["two_sensor_pipes"]) == (len(hits) >= 2), p["id"]
last = []
last_score = -1
for plan in data["budgets"]:
    assert len(plan["sensors"]) == len(set(plan["sensors"])) <= plan["budget"]
    assert plan["sensors"][:len(last)] == last, "budgets should extend the same greedy recommendation"
    m = plan["metrics"]
    assert m["events"] == m["observed"] + m["unobserved"] == 117
    assert 0 <= m["localized"] <= m["observed"] <= 117
    assert m["objective_score"] >= last_score
    assert m["objective_score"] == placement.evaluate(plan["sensors"], net)["objective_score"]
    last, last_score = plan["sensors"], m["objective_score"]
assert next(p for p in data["budgets"] if p["budget"] == 12)["metrics"]["objective_score"] >= base["objective_score"]
fixture = Path(__file__).resolve().parent.parent / "web" / "network" / "placement.json"
assert json.loads(fixture.read_text()) == data, "regenerate the static placement fixture after model changes"
print("PASS hand-worked placement/travel times, independent sensor counts, tank boundary,117-event denominators, deterministic nested budgets, existing12-site baseline and fixture parity")
