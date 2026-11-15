"""Builds network.json, the SIMULATED pipe network that localize.py traces sources on.

Run once at development time. It needs WNTR, which the gateway itself does not, so use a
separate environment and leave the gateway's own alone:

    uv venv /tmp/netvenv -p 3.12 && uv pip install -p /tmp/netvenv/bin/python wntr six
    /tmp/netvenv/bin/python build_network.py

(six is named because WNTR 1.5.0 imports it without installing it.)

What it does, in order:

  1. Network     Loads WNTR's bundled Net3 example (EPANET example network 3: two sources, three
                 tanks, 92 junctions, 117 pipes) and solves its hydraulics up to one snapshot
                 hour. EPANET is used if its binary loads on this machine, otherwise WNTR's own
                 pure-Python solver. No water-quality run is needed: arrival times come from
                 travel time along the flow graph.
  2. Flow graph  Every pipe is written pointing the way its water flowed at the snapshot, with a
                 travel time: length divided by speed. Pipes with no flow to speak of get null.
  3. Attributes  Net3 has no pipe materials, ages or break histories, so every pipe gets
                 synthetic ones from a seeded random rule (see attributes below). They exist
                 only to give the prior something to read. They describe no real pipe.
  4. Sensors     Twelve junctions where water is drawn, spread over the map: start from the one
                 with the largest demand, then keep adding the junction farthest from those
                 already chosen. Junctions that fewer than ten pipes feed within six hours are
                 left out, because a sensor there would rarely alert in time to help.
  5. Scenarios   A change enters halfway along a chosen pipe at minute 0. Each sensor it would
                 reach within six hours alerts at its travel time plus a few minutes of seeded
                 noise. The others stay quiet. The pipes were chosen by hand to give a spread of
                 cases: two where the tracer has plenty to go on, one where pipes in a row fit
                 equally well, and a hard one where a single sensor alerts.

The scenarios are a hand-picked few. For the whole picture, the last step runs localize.py on a
change entering at every pipe in turn and prints how often the true pipe is found.
test_localize.py repeats that check and prints the same counts.
"""
import heapq
import json
import math
import os
import random
import sys
import tempfile

SNAPSHOT_HOUR = 3        # both sources are pumping, so water moves quickly and widely
MIN_SPEED = 0.001        # metres per second; slower than this counts as no flow
N_SENSORS = 12
MIN_FEEDERS = 10         # a junction is worth a sensor only if this many pipes feed it within the horizon
HORIZON_MIN = 360        # a sensor alerts if the change reaches it within this many minutes
NOISE_MIN = 4.0          # spread of the noise added to each alert's minute
SEED = 26                # for the synthetic attributes and the alert noise
YEAR_NOW = 2026
# (id, pipe the change enters at, hard case?, name, what the case shows). None of the words give the pipe away.
SCENARIOS = (
    ("five-sensors", "229", False, "Five sensors, south and east", "Five arrival times give the tracer plenty to compare."),
    ("four-sensors", "217", False, "Four sensors, centre to south", "Four arrival times to compare."),
    ("three-sensors", "237", False, "Three sensors, south-east",
     "Several pipes in a row lead to these sensors, and pipes in a row fit the timing equally well."),
    ("one-sensor", "135", True, "One sensor, north-east",
     "A hard case: one alert gives no timing to compare, so the answer is uncertain."),
)


# ---------------------------------------------------------------- 1 and 2: the network and its flows
def solve(hour):
    """Net3 with its hydraulics solved up to `hour`. Returns the model, the flow in every link
    and the demand at every node at that hour, and the name of the solver that ran."""
    import wntr
    wn = wntr.network.WaterNetworkModel(os.path.join(os.path.dirname(wntr.__file__), "library", "networks", "Net3.inp"))
    wn.options.time.duration = hour * 3600
    try:
        with tempfile.TemporaryDirectory() as tmp:     # EPANET writes its working files here, not in the repo
            results, solver = wntr.sim.EpanetSimulator(wn).run_sim(file_prefix=os.path.join(tmp, "net3")), "EPANET"
    except Exception as e:                             # the binary did not load on this machine
        print(f"EPANET did not run ({type(e).__name__}); using WNTR's own solver")
        results, solver = wntr.sim.WNTRSimulator(wn).run_sim(), "WNTR's own solver"
    t = hour * 3600
    return wn, results.link["flowrate"].loc[t], results.node["demand"].loc[t], f"{solver} through WNTR {wntr.__version__}"


def links(wn, flow):
    pipes, pumps = [], []
    for name, p in wn.pipes():
        q = float(flow[name])
        speed = abs(q) / (math.pi * p.diameter ** 2 / 4)
        a, b = (p.start_node_name, p.end_node_name) if q >= 0 else (p.end_node_name, p.start_node_name)
        pipes.append({"id": name, "from": a, "to": b, "length_m": round(p.length, 1), "diameter_mm": round(p.diameter * 1000),
                      "travel_min": round(p.length / speed / 60, 2) if speed >= MIN_SPEED else None,
                      "flow_lps": round(abs(q) * 1000, 2)})
    for name, p in wn.pumps():                         # a running pump passes water on at once
        q = float(flow[name])
        pumps.append({"id": name, "from": p.start_node_name, "to": p.end_node_name,
                      "travel_min": 0.0 if q > 1e-6 else None, "flow_lps": round(abs(q) * 1000, 2)})
    return pipes, pumps


def nodes(wn, demand):
    kinds = {**{n: "junction" for n in wn.junction_name_list}, **{n: "tank" for n in wn.tank_name_list},
             **{n: "reservoir" for n in wn.reservoir_name_list}}
    return [{"id": name, "x": round(float(n.coordinates[0]), 2), "y": round(float(n.coordinates[1]), 2), "kind": kinds[name],
             "demand_lps": round(float(demand[name]) * 1000, 2) if kinds[name] == "junction" else 0.0}
            for name, n in wn.nodes()]


# ---------------------------------------------------------------- 3: synthetic attributes
def attributes(pipes, rng):
    """Synthetic install year, material and break count for every pipe. The rule: a year drawn
    evenly from 1925 to 2015; the material that was common for that year and size; and a break
    count drawn at random, more for old pipes and for brittle materials."""
    breaks_per_50_years = {"cast iron": 1.6, "asbestos cement": 1.0, "steel": 0.5, "ductile iron": 0.5, "PVC": 0.2}
    for p in pipes:
        year = rng.randint(1925, 2015)
        if p["diameter_mm"] >= 700:
            material = "steel"                         # the big transmission mains
        elif year < 1950:
            material = "cast iron"
        elif year < 1975:
            material = "cast iron" if rng.random() < 0.4 else "asbestos cement"
        elif year < 1995 or p["diameter_mm"] > 305:
            material = "ductile iron"
        else:
            material = "PVC"
        expected, count, product = breaks_per_50_years[material] * (YEAR_NOW - year) / 50, 0, rng.random()
        while product > math.exp(-expected):           # a Poisson draw, by Knuth's method
            count, product = count + 1, product * rng.random()
        p.update({"material": material, "year": year, "breaks": min(count, 6)})


# ---------------------------------------------------------------- 4: sensors
def pick_sensors(node_list, pipes, pumps, count):
    """Junctions where water is drawn, spread over the map. Only junctions that at least
    MIN_FEEDERS pipes feed within the horizon are considered: a sensor at a dead end that the
    water takes days to reach would never alert in time to help."""
    kinds = {n["id"]: n["kind"] for n in node_list}
    feeders = {}
    for p in pipes:
        if p["travel_min"] is not None:
            for node in spread_from(p, pipes, pumps, kinds):
                feeders[node] = feeders.get(node, 0) + 1
    taps = [n for n in node_list if n["kind"] == "junction" and n["demand_lps"] > 0 and feeders.get(n["id"], 0) >= MIN_FEEDERS]
    chosen = [max(taps, key=lambda n: (n["demand_lps"], n["id"]))]
    while len(chosen) < count:
        gap = lambda n: min(math.hypot(n["x"] - c["x"], n["y"] - c["y"]) for c in chosen)
        chosen.append(max((n for n in taps if n not in chosen), key=lambda n: (round(gap(n), 6), n["id"])))
    return [n["id"] for n in chosen]


# ---------------------------------------------------------------- 5: scenarios
def spread_from(pipe, pipes, pumps, kinds):
    """Minutes for a change entering halfway along `pipe` to first reach each node downstream
    within the horizon. Nothing is followed through a tank, where it would mix with stored water."""
    down = {}
    for l in pipes + pumps:
        if l["travel_min"] is not None:
            down.setdefault(l["from"], []).append((l["to"], l["travel_min"]))
    best, heap = {pipe["to"]: pipe["travel_min"] / 2}, [(pipe["travel_min"] / 2, pipe["to"])]
    while heap:
        t, node = heapq.heappop(heap)
        if t > best[node] or kinds[node] != "junction":
            continue
        for nxt, minutes in down.get(node, ()):
            if t + minutes < best.get(nxt, math.inf):
                best[nxt] = t + minutes
                heapq.heappush(heap, (t + minutes, nxt))
    return {n: t for n, t in best.items() if t <= HORIZON_MIN}


def reports(pipe, pipes, pumps, kinds, sensors, rng):
    """What the sensors would report: which alert and at what minute, and which stay quiet."""
    if pipe["travel_min"] is None:
        return [], list(sensors)
    reached = spread_from(pipe, pipes, pumps, kinds)
    alerts = [{"sensor": s, "minute": round(reached[s] + rng.gauss(0, NOISE_MIN))} for s in sensors if s in reached]
    return sorted(alerts, key=lambda a: (a["minute"], a["sensor"])), [s for s in sensors if s not in reached]


# ---------------------------------------------------------------- write, then check against every pipe
def dump(net):
    """JSON with one node, pipe or scenario to a line, so the committed file can be read and diffed."""
    rows = lambda items: "[\n" + ",\n".join("    " + json.dumps(i) for i in items) + "\n  ]"
    parts = [f'  {json.dumps(k)}: {rows(v) if k in ("nodes", "pipes", "pumps", "scenarios") else json.dumps(v)}' for k, v in net.items()]
    return "{\n" + ",\n".join(parts) + "\n}\n"


def build():
    wn, flow, demand, solver = solve(SNAPSHOT_HOUR)
    rng = random.Random(SEED)
    node_list = nodes(wn, demand)
    pipes, pumps = links(wn, flow)
    attributes(pipes, rng)
    sensors = pick_sensors(node_list, pipes, pumps, N_SENSORS)
    kinds, by_id = {n["id"]: n["kind"] for n in node_list}, {p["id"]: p for p in pipes}
    scenarios = []
    for sid, truth, hard, name, shows in SCENARIOS:
        alerts, quiet = reports(by_id[truth], pipes, pumps, kinds, sensors, rng)
        if not (1 <= len(alerts) <= 2 if hard else 2 <= len(alerts) <= 5) or min(a["minute"] for a in alerts) < 0:
            raise SystemExit(f"scenario {sid} no longer fits: pipe {truth} gives {len(alerts)} alerts {alerts}. Choose another pipe.")
        span = alerts[-1]["minute"] - alerts[0]["minute"]
        seen = (f"{len(alerts)} sensors alert over {span} minutes, the first at node {alerts[0]['sensor']}" if len(alerts) > 1
                else f"1 sensor alerts, at node {alerts[0]['sensor']}")
        scenarios.append({"id": sid, "name": name, "description": f"Simulated: {seen}, and {len(quiet)} stay quiet. {shows}",
                          "hard": hard, "truth": truth, "alerts": alerts, "quiet": quiet})
    return {"simulated": True, "name": "Net3 example network (simulated)",
            "source": f"WNTR's bundled Net3 example (EPANET example network 3), with hydraulics solved by {solver}.",
            "snapshot_hour": SNAPSHOT_HOUR,
            "note": "Pipe material, install year and break history are synthetic, from a seeded random rule; Net3 has none.",
            "nodes": node_list, "pipes": pipes, "pumps": pumps, "sensors": sensors, "scenarios": scenarios}


def check_every_pipe(net, localize, seed=SEED + 1):
    """A change entering at each pipe in turn, traced by `localize`. Returns one row per pipe
    that any sensor would see: (pipe, sensors alerting, rank of the true pipe or None, candidates)."""
    rng, kinds, rows = random.Random(seed), {n["id"]: n["kind"] for n in net["nodes"]}, []
    for p in net["pipes"]:
        alerts, quiet = reports(p, net["pipes"], net["pumps"], kinds, net["sensors"], rng)
        if alerts:
            ranked = localize(alerts, quiet, top=None)["candidates"]
            rows.append((p["id"], len(alerts), next((i + 1 for i, c in enumerate(ranked) if c["pipe"] == p["id"]), None), len(ranked)))
    return rows


def check_lines(net, rows):
    """The check as sentences, grouped by how many sensors alerted."""
    out = [f"{len(net['pipes']) - len(rows)} of the {len(net['pipes'])} pipes reach no sensor within {HORIZON_MIN // 60} hours, so a change there goes unseen."]
    for label, lo, hi in (("1 sensor", 1, 1), ("2 to 5 sensors", 2, 5), ("6 or more sensors", 6, 99)):
        g = [r for r in rows if lo <= r[1] <= hi]
        if g:
            out.append(f"{label} alerting: {len(g)} pipes; the true pipe is ranked first for {sum(r[2] == 1 for r in g)}, in the top three "
                       f"for {sum(r[2] is not None and r[2] <= 3 for r in g)} and among the candidates for {sum(r[2] is not None for r in g)}; "
                       f"the median number of candidates is {sorted(r[3] for r in g)[len(g) // 2]}.")
    return out


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "network.json")
    net = build()
    with open(out, "w") as f:
        f.write(dump(net))
    print(f"wrote {out}: {len(net['nodes'])} nodes, {len(net['pipes'])} pipes, {len(net['sensors'])} sensors, "
          f"{len(net['scenarios'])} scenarios, {os.path.getsize(out) / 1024:.0f} KB")
    for s in net["scenarios"]:
        print(f"  {s['id']}: enters at pipe {s['truth']}, {len(s['alerts'])} alerting, {len(s['quiet'])} quiet")
    if os.path.abspath(out) == os.path.join(here, "network.json"):   # localize.py reads the file beside itself
        sys.path.insert(0, here)
        import localize
        print("A change entering at every pipe in turn (simulated, with the same travel times the tracer uses):")
        for line in check_lines(net, check_every_pipe(net, localize.localize)):
            print("  " + line)
