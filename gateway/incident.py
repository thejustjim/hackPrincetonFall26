"""Incident reports for the simulated network: what a utility would be handed when several
nodes alert at once.

Everything here is simulation. Clarity has one real node; localize.py traces a made-up event
on WNTR's Net3 example network. This file turns one traced scenario into a report, by fixed
rules: a summary and severity, the timeline of alerts, the ranked pipe segments, what to do
next, who is downstream, a draft notice and the caveats.

Each recommended action carries a passage from the published guidance (guidance.py: EPA
documents and the issue papers AWWA and American Water prepared for EPA), quoted with its
document and page, when the guidance index has been built on this machine.

    python incident.py      writes ../web/network/data.json, so the page works with no gateway
"""
import json
from pathlib import Path

import analysis
import guidance
import localize

NOTICE_REQUIRED = analysis.NOTICE_REQUIRED        # the same closing sentence as every other notice (it leaves pH out while pH is an estimate)
SEVERITY_WORDS = ["No action needed", "Worth a second look", "Act on it"]
CAVEATS = [
    "This is a simulation. The network is WNTR's Net3 example (EPANET example network 3), the event was injected by the simulation, and no real sensor or pipe is involved.",
    "Flow directions and travel times are frozen at one hour of the simulated day. In a real network they change with demand, so a trace has to use the hour the event happened.",
    "Pipe material, age and break history are synthetic, and the risk score built from them is set by hand, not learned from failures.",
    "Travel time assumes the change moves with the water and does not spread, mix or decay on the way.",
    "The downstream count is junctions and their simulated demand, a stand-in for people served. It is not a customer count.",
]
# What to do, most urgent first: the action (with {pipe} filled in) and the guidance search behind it.
ACTIONS = [
    ("Confirm it with samples. Take grab samples at the alerting nodes and just upstream of pipe {pipe}, and send them to a certified laboratory: the sensors show that something changed, not what.",
     "site characterization sampling field and laboratory analysis to confirm or rule out contamination"),
    ("Contain it. If the samples confirm a problem, close the valves either side of pipe {pipe} so the water stops moving on from it.",
     "operational response isolate affected area of the distribution system valves contain contaminated water"),
    ("Flush downstream of the segment once it is isolated, working outward from clean water, and retest before putting it back in service.",
     "flushing to remove contaminated or stagnant water unidirectional flushing velocity"),
    ("Inspect pipe {pipe} itself ({what}). If it is opened or repaired, disinfect and test it before it goes back in service.",
     "main repair disinfection flushing bacteriological testing before returning main to service"),
    ("Tell the people downstream what is known, what is not, and when they will hear more.",
     "public notification risk communication message to customers during a contamination incident"),
]
QUOTE = 420       # characters of a passage to show


_whole = {}


def whole_network():
    """How the trace does when a change enters at every pipe in turn, not only in the four chosen
    events: one sentence with the counts. (build_network.check_every_pipe does the run.)"""
    if "line" not in _whole:
        try:
            import build_network
            rows = build_network.check_every_pipe(localize.NET, localize.localize)      # (pipe, sensors alerting, rank, candidates)
            pipes = len(localize.NET["pipes"])
            many = [r for r in rows if r[1] >= 2]
            one = [r for r in rows if r[1] == 1]
            _whole["line"] = (
                f"The four events here were chosen by hand. Run for a change entering at every pipe in turn: {pipes - len(rows)} of the "
                f"{pipes} pipes reach no sensor within six hours, so a change there goes unseen. Of the rest, when two or more sensors "
                f"alert ({len(many)} pipes) the true pipe is ranked first for {sum(r[2] == 1 for r in many)} and in the top three for "
                f"{sum(r[2] is not None and r[2] <= 3 for r in many)}; when only one alerts ({len(one)} pipes), first for {sum(r[2] == 1 for r in one)}.")
            # the same run with the fitted break-rate model as the prior in place of the hand-set score
            fitted = build_network.check_every_pipe(localize.NET, lambda a, q, top=None: localize.localize(a, q, top=top, prior="fitted"))
            f_many = [r for r in fitted if r[1] >= 2]
            _whole["line"] += (f" With a break-rate model fitted to the same synthetic break history as the prior, in place of the hand-set score, "
                               f"it is first for {sum(r[2] == 1 for r in f_many)} and in the top three for {sum(r[2] is not None and r[2] <= 3 for r in f_many)}. "
                               "Fitted to synthetic history, that model learns only the rule the history was drawn from, so the hand-set score stays the default.")
        except Exception:
            _whole["line"] = "The four events here were chosen by hand, so they say little about how often the trace is right in general."
    return _whole["line"]


def excerpt(text):
    """The start of a passage, cut at the end of a sentence where there is one."""
    if len(text) <= QUOTE:
        return text
    cut = text[:QUOTE]
    stop = max(cut.rfind(". "), cut.rfind("; "))
    return (cut[: stop + 1] if stop > QUOTE * 0.45 else cut.rsplit(" ", 1)[0] + " ...").strip()


def cite(query):
    """The best passage for a query from a published document (not a team note), or None."""
    for hit in guidance.search(query, 4):
        if hit["url"]:
            where = f"{hit['document']}, {hit['prepared_by']}" + (f", {hit['year']}" if hit["year"] else "") + (f", p. {hit['page']}" if hit["page"] else "")
            return {"quote": excerpt(hit["text"]), "source": where, "url": hit["url"]}
    return None


def report(scenario_id):
    """The incident report for one simulated scenario: the trace plus everything written around it."""
    r = localize.scenario_result(scenario_id)
    alerts = sorted(r["alerts"], key=lambda a: a["minute"])
    unavailable = r.get("unavailable", [])
    total = len(alerts) + len(r["quiet"]) + len(unavailable)
    top = r["candidates"][0] if r["candidates"] else None
    span = alerts[-1]["minute"] - alerts[0]["minute"] if alerts else 0
    heard = f"{len(alerts)} of the {total} simulated sensors alerted" + (f" over {span:.0f} minutes" if len(alerts) > 1 else "")

    weak_fit = r.get("fit_quality") in ("poor", "insufficient")
    if not top:
        summary, severity = f"{heard}, but no pipe is upstream of all of them, so the trace found no single entry point.", 1
    elif r.get("fit_quality") == "poor":
        summary = (f"{heard}, but the arrival times fit the model poorly. Pipe {top['pipe']} leads the ranking "
                   f"with {top['confidence']:.0%} of its weight; that does not make the weak trace reliable. Check sensor timing and take samples first.")
        severity = 1
    elif top["confidence"] >= 0.35 and not weak_fit:
        second = r["candidates"][1] if len(r["candidates"]) > 1 else None
        summary = (f"{heard}. Tracing upstream from each puts the most likely entry point at pipe {top['pipe']} "
                   f"({top['confidence']:.0%} of the weight among {r['considered']} candidates)"
                   + (f", ahead of pipe {second['pipe']} at {second['confidence']:.0%}." if second else "."))
        severity = 2
    else:
        summary = (f"{heard}, which is too little to single out a pipe: the leading candidate, pipe {top['pipe']}, has only "
                   f"{top['confidence']:.0%} of the weight among {r['considered']} candidates. Treat the list as where to sample first, not as an answer.")
        severity = 2 if len(alerts) >= 3 else 1

    actions = []
    if top and (top["confidence"] < 0.35 or weak_fit):               # no pipe stands out: sample along the list, isolate nothing yet
        names = ", ".join(c["pipe"] for c in r["candidates"][:3])
        actions = [
            {"do": f"Sample before anything else. Take grab samples at the alerting node{'s' if len(alerts) != 1 else ''} and along the leading "
                   f"candidates (pipes {names}), in that order, and send them to a certified laboratory.", "guidance": cite(ACTIONS[0][1])},
            {"do": "Do not isolate or flush yet. The timing or sensor coverage does not support a pipe-level conclusion. Wait for the samples, "
                   "or for a second sensor to alert, which would narrow the list.", "guidance": cite(ACTIONS[1][1])},
            {"do": ACTIONS[4][0], "guidance": cite(ACTIONS[4][1])},
        ]
    elif top:
        a = top["attributes"]
        what = f"{a['material']}, laid in {a['year']}, {a['diameter_mm']} mm across, {a['breaks']} recorded break{'' if a['breaks'] == 1 else 's'}; these attributes are synthetic"
        for do, query in ACTIONS:
            actions.append({"do": do.format(pipe=top["pipe"], what=what), "guidance": cite(query)})
    else:
        actions.append({"do": "Sample at each alerting node separately: they may be seeing different things.", "guidance": cite(ACTIONS[0][1])})

    first = alerts[0] if alerts else None
    notice = ("Sensors in part of the water network picked up a change in water quality"
              + (f", first at node {first['sensor']}" if first else "") + ". Samples are being taken to find out what changed, and "
              "this notice will be updated when their results are in. " + NOTICE_REQUIRED)
    timeline = [{"minute": a["minute"], "sensor": a["sensor"],
                 "text": f"Sensor at node {a['sensor']} alerts" + ("" if i == 0 else f", {a['minute'] - alerts[0]['minute']:.0f} minutes after the first")}
                for i, a in enumerate(alerts)]
    truth = r["truth"]
    check = (f"The simulation put the change in pipe {truth['pipe']}. The trace ranked it "
             + (f"number {truth['rank']} of {r['considered']}, with {truth['confidence']:.0%} of the weight." if truth.get("rank")
                else "outside its candidates.")) if truth else ""
    return {"simulated": True, "id": r["id"], "name": r["name"], "description": r["description"], "hard": r.get("hard", False),
            "summary": summary, "severity": severity, "severity_words": SEVERITY_WORDS[severity],
            "alerts": alerts, "quiet": r["quiet"], "unavailable": unavailable, "stress": r.get("stress", False), "fit_quality": r.get("fit_quality"), "timeline": timeline,
            "candidates": r["candidates"], "considered": r["considered"], "method": r["method"],
            "affected": r["affected"], "actions": actions, "notice": notice, "caveats": CAVEATS[:1] + [whole_network()] + ([r["description"]] if r.get("stress") else []) + CAVEATS[1:],
            "truth": truth, "check": check}


_robustness = None


def robustness():
    global _robustness
    if _robustness is None:
        import simulation
        _robustness = simulation.network_benchmark(localize.NET, localize.localize)
    return _robustness


def payload():
    """Everything the /network/ page draws: the network and a report for every scenario."""
    net = json.loads(Path(localize.__file__).with_name("network.json").read_text())
    return {"simulated": True, "summary": localize.summary(), "note": net.get("note"),
            "nodes": net["nodes"], "pipes": net["pipes"], "pumps": net.get("pumps", []), "sensors": net["sensors"],
            "guidance": guidance.status()["documents"], "robustness": robustness(),
            "scenarios": [report(s["id"]) for s in localize.scenarios()]}


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "web" / "network" / "data.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    data = payload()
    out.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    cited = sum(1 for s in data["scenarios"] for a in s["actions"] if a["guidance"])
    print(f"wrote {out.relative_to(out.parent.parent.parent)}: {len(data['scenarios'])} scenarios, {cited} cited actions, {out.stat().st_size // 1024} KB")
