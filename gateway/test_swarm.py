"""Offline check of the investigator's plumbing: the lead, its five specialists and their tools,
driven by scripted stand-in models (no API key, no network). It shows that the lead reaches every
specialist through the task tool, that each specialist is offered only its own tools and calls
them, and that the report and what each specialist said come back in the shape the page needs.
It does not show what Claude would write.   Run: python test_swarm.py
"""
import asyncio
import json
import os
import re
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "swarm.db")
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["TIGER_DATABASE_URL"] = ""
os.environ.pop("DATABASE_URL", None)

from langchain_core.language_models.chat_models import BaseChatModel   # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage   # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult   # noqa: E402

import gateway   # noqa: E402
import investigator   # noqa: E402

ok = True
OFFERED = {}     # specialist or "lead" -> the tool names it was offered
CALLED = []      # (tool name, args) for every specialist tool call


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")


def text(m):
    return m.content if isinstance(m.content, str) else "".join(b.get("text", "") for b in m.content if isinstance(b, dict))


class Scripted(BaseChatModel):
    """Answers from what it is shown, so five specialists can run at once without a shared script."""
    lead: bool = False
    by_tool: bool = False     # hand the report back as a call to the "Report" tool (the Gemini path), not as JSON text
    offered: list = []

    @property
    def _llm_type(self):
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        names = [t.get("name") if isinstance(t, dict) else getattr(t, "name", getattr(t, "__name__", "?")) for t in tools]
        return self.model_copy(update={"offered": names})

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(generations=[ChatGeneration(message=self.reply(messages))])

    def reply(self, messages):
        system = next((text(m) for m in messages if isinstance(m, SystemMessage)), "")
        results = [m for m in messages if isinstance(m, ToolMessage)]
        if self.lead:
            OFFERED["lead"] = self.offered
            if not results:
                team = investigator.INCIDENT_SPECIALISTS if system.startswith(investigator.INCIDENT_LEAD) else investigator.SPECIALISTS
                try:                                   # follow the plan in the case, as the real lead is told to
                    planned = [x["agent"] for x in json.loads(text(next(m for m in messages if isinstance(m, HumanMessage))).split("\n", 1)[1])["plan"]]
                    team = [s for s in team if s["name"] in planned]
                except (KeyError, ValueError, IndexError):
                    pass
                return AIMessage(content="", tool_calls=[
                    {"name": "task", "id": f"t{i}", "args": {"subagent_type": s["name"],
                     "description": f"Node tank-01, test 21. Scenario five-sensors. Report your findings."}}
                    for i, s in enumerate(team)])
            notice = next(text(m) for m in results if "Clarity reads only" in text(m))
            report = {"summary": "ZeroWater took dissolved solids from 780 ppm to 4 ppm.",
                      "findings": ["Measured: dissolved solids fell from 780 ppm to 4 ppm.", "Made up: the river nearby read 9999 ppm."],
                      "actions": ["Pour a second cup.", "Dilute it by 37%."], "notice": notice}
            if self.by_tool:
                return AIMessage(content="", tool_calls=[{"name": "Report", "id": "final", "args": report}])
            return AIMessage(content=json.dumps(report))
        me = next(s for s in investigator.SPECIALISTS + investigator.INCIDENT_SPECIALISTS if system.startswith(s["prompt"]))
        OFFERED[me["name"]] = self.offered
        if not results:
            node, test = re.search(r"Node (\S+), test (\d+)", text(next(m for m in messages if isinstance(m, HumanMessage)))).groups()
            calls = []
            for i, tool in enumerate(me["tools"]):
                args = ({"node": node.rstrip(","), "test": int(test)} if tool.startswith(("get_case", "get_sensor", "get_baseline", "get_peer"))
                        else {"node": node.rstrip(",")} if tool in ("get_site_history", "get_nearby_nodes")
                        else {"sql": "SELECT phase, count(*) AS n FROM readings WHERE node='tank-01' GROUP BY phase"} if tool == "query_readings"
                        else {"query": "ZeroWater filter replacement"} if tool == "search_guidance"
                        else {"scenario_id": "five-sensors"} if tool in ("trace_scenario", "get_incident_notice")
                        else {"pipe_id": "229"} if tool == "get_pipe" else {})
                CALLED.append((tool, args))
                calls.append({"name": tool, "id": f"{me['name']}-{i}", "args": args})
            return AIMessage(content="", tool_calls=calls)
        if me["name"] == "comms" and any('"keep_exactly"' in text(m) for m in results):      # the incident team's notice
            return AIMessage(content=json.loads(text(next(m for m in results if '"keep_exactly"' in text(m))))["notice"])
        if me["name"] == "comms":
            case = json.loads(text(next(m for m in results if '"notice_template"' in text(m))))
            return AIMessage(content=gateway.analysis.notice_for(case, {"kind": case["checks"]["kind"]}, case["site"]))
        return AIMessage(content=f"{me['title']}: read {len(results)} tool results; the first begins {text(results[0])[:60]!r}")


def seed():
    def add(test, phase, ph, tds, clarity, verdict, filt="NONE"):
        r = {"node": "tank-01", "test": test, "phase": phase, "ph": ph, "tds": tds, "clarity": clarity, "verdict": verdict,
             "filter": filt, "rssi": -60, "ts": f"2026-11-14T12:{test:02d}:00+00:00", "lat": 40.35, "lon": -74.66, "sim": False,
             "ai_filter": None, "explanation": None, "anomaly": 0.1}
        return gateway.store(r)
    for i in range(1, 21):
        add(i, "before", 7.4 + 0.02 * (i % 5), 190 + 3 * (i % 7), 0.94 + 0.01 * (i % 4), "SAFE")
    before = add(21, "before", 7.6, 780, 0.95, "HIGH_TDS", "ZEROWATER")
    gateway.record_tip(before, "ZEROWATER", "local_rule")
    after = add(21, "after", 7.2, 4, 0.99, "SAFE")
    return after, gateway.attach_after(after)


async def main():
    after, used = seed()
    tools = {f.__name__: f for f in gateway.INVESTIGATOR_TOOLS}
    agent = investigator.build(tools, lead_model=Scripted(lead=True), specialist_model=Scripted())
    gateway.investigator, gateway.investigator_agent = investigator, agent   # as the gateway does when a key is set
    sent = []

    async def capture(msg):
        sent.append(msg)
    gateway.broadcast = capture

    await gateway.report_on(after, used)
    kinds = [m.get("source") for m in sent if m["type"] == "report"]
    check("the retest gets a rule-written report first, then the investigator's", kinds == ["rules", "deepagents"], kinds)
    first, report = [m for m in sent if m["type"] == "report"]
    check("the first report needs no model", first["model"] is None and first["checks"]["kind"] == "local_event" and first["sections"] == [])
    names = [s["agent"] for s in report["sections"]]
    planned = [x["agent"] for x in report["plan"]]
    check("triage: a salty pour through a filter needs four of the five specialists, each with a reason",
          planned == ["analyst", "network", "maintenance", "comms"] and all(x["why"] for x in report["plan"]), report["plan"])
    check("the lead reached exactly the planned specialists through the task tool", names == planned, names)
    events = [m for m in sent if m["type"] == "agent"]
    kinds_seen = [(e["event"], e["agent"]) for e in events]
    check("the page is told the plan first, then each hand-off, tool call and answer as it happens",
          kinds_seen[0] == ("plan", None) and all(("asked", a) in kinds_seen and ("answered", a) in kinds_seen for a in planned)
          and any(e["event"] == "tool" and e["agent"] == "analyst" and e["tool"] == "get_baseline" for e in events), kinds_seen[:8])
    check("it ends with the check and then done", [k for k, _ in kinds_seen[-2:]] == ["check", "done"], kinds_seen[-3:])
    check("the report keeps each specialist's trail of tool calls", {t["agent"]: set(t["tools"]) for t in report["trail"]}.get("maintenance") == {"get_case", "get_filter_life", "search_guidance"}, report["trail"])
    check("the check drops a finding and an action whose figures no tool returned",
          report["findings"] == ["Measured: dissolved solids fell from 780 ppm to 4 ppm."] and report["check"]["dropped"] == 2
          and {n for u in report["check"]["untraced"] for n in u["numbers"]} == {"9999", "37"}, report["check"])
    check("and counts the figures it could trace", report["check"]["figures"] > report["check"]["traced"] >= 3, report["check"])
    check("each section carries its title and what the specialist said", all(s["title"] and s["text"] for s in report["sections"]))
    check("the lead has no data tools of its own, only delegation", "task" in OFFERED["lead"] and not set(OFFERED["lead"]) & set(tools), OFFERED["lead"])
    check("a specialist the plan left out was never started", "sensor-health" not in OFFERED, sorted(OFFERED))
    for s in [x for x in investigator.SPECIALISTS if x["name"] in planned]:
        mine = set(OFFERED[s["name"]]) & set(tools)
        check(f"{s['name']} is offered exactly its own tools and cannot delegate",
              mine == set(s["tools"]) and "task" not in OFFERED[s["name"]], sorted(mine))
    wanted = {t for x in investigator.SPECIALISTS if x["name"] in planned for t in x["tools"]}
    check("every tool of the planned specialists was called, and no other", {t for t, _ in CALLED} == wanted, sorted({t for t, _ in CALLED}))
    check("the structured report came back", report["summary"].startswith("ZeroWater") and report["actions"] == ["Pour a second cup."])
    check("the verdict and severity are the checks', not a model's", report["kind"] == first["kind"] and report["severity"] == first["severity"])
    check("the notice kept its required sentence", gateway.analysis.NOTICE_REQUIRED in report["notice"])
    rows = gateway.reports(node="tank-01", limit=5)
    check("both reports are stored and served newest first, with the plan, trail and check",
          [r["source"] for r in rows] == ["deepagents", "rules"] and len(rows[0]["sections"]) == len(planned)
          and rows[0]["plan"] and rows[0]["trail"] and rows[0]["check"]["dropped"] == 2 and rows[1]["plan"] is None)

    check("read-only SQL returns rows", gateway.query_readings("SELECT count(*) AS n FROM readings")[0]["n"] == 22)
    check("it refuses anything but one SELECT", all("error" in gateway.query_readings(q) for q in (
        "DELETE FROM readings", "SELECT 1; DROP TABLE readings", "UPDATE readings SET tds=0", "PRAGMA writable_schema=1")))
    check("a write inside a SELECT fails on the read-only connection", "error" in gateway.query_readings("WITH x AS (SELECT 1) INSERT INTO tips (node) VALUES ('x')"))
    check("the readings were not changed", gateway.query_readings("SELECT count(*) AS n FROM readings")[0]["n"] == 22)
    found = gateway.search_guidance("when should the ZeroWater filter be replaced")
    check("guidance search finds the maker's rule with its source", found and "ZeroWater" in found[0]["document"] and found[0]["prepared_by"], found[:1])
    check("an unrelated search finds nothing", gateway.search_guidance("xyzzy") == [])

    # the same run as Gemini would do it: the report comes back through a "Report" tool call
    OFFERED.clear()
    gateway.investigator_agent = investigator.build(tools, provider="google", lead_model=Scripted(lead=True, by_tool=True), specialist_model=Scripted())
    sent.clear()
    await gateway.report_on(after, used)
    via_tool = [m for m in sent if m.get("source") == "deepagents"]
    check("on the Gemini path the lead is offered a Report tool for its answer", "Report" in OFFERED.get("lead", []), OFFERED.get("lead"))
    check("and the report and all five sections still come back", len(via_tool) == 1 and via_tool[0]["summary"].startswith("ZeroWater")
          and [x["agent"] for x in via_tool[0]["sections"]] == planned, via_tool[:1])

    gateway.investigator_agent = investigator.build(tools, lead_model=Scripted(lead=True), specialist_model=Scripted())

    async def boom(agent, case):
        raise TimeoutError("no answer")
    real, investigator.investigate = investigator.investigate, boom
    sent.clear()
    await gateway.report_on(after, used)
    investigator.investigate = real
    check("if the investigator fails, the rule-written report still stands, and the page is told it failed",
          [m["source"] for m in sent if m["type"] == "report"] == ["rules"] and any(m.get("event") == "failed" for m in sent))

    # the second team: an event on the simulated network
    CALLED.clear()
    OFFERED.clear()
    gateway.incident_agent = investigator.build({f.__name__: f for f in gateway.INCIDENT_TOOLS}, lead_model=Scripted(lead=True),
                                                specialist_model=Scripted(), incident=True)
    out = await gateway.network_investigate("five-sensors")
    check("the incident lead reaches its three specialists", [x["agent"] for x in out["sections"]] == ["topology", "maintenance", "comms"], out["sections"])
    check("they call the trace, the pipe lookup, the guidance search and the notice", {t for t, _ in CALLED} == {f.__name__ for f in gateway.INCIDENT_TOOLS}, sorted({t for t, _ in CALLED}))
    check("the incident report says it is simulated and keeps the notice's required sentence",
          out["simulated"] is True and gateway.analysis.NOTICE_REQUIRED in out["notice"] and out["summary"])
    traced = gateway.trace_scenario("five-sensors")
    check("the agents are never shown where the simulation put it", "truth" not in traced and "229" in [c["pipe"] for c in traced["candidates"]])
    check("an unknown scenario or pipe is an error the agent can read", "error" in gateway.trace_scenario("nope") and "error" in gateway.get_pipe("nope"))

    # the filter decision on Gemini, with a stand-in for Google's client
    class FakeGemini:
        def __init__(self, text):
            self.text, self.seen = text, None
            self.aio = self.models = self

        async def generate_content(self, **kw):
            self.seen = kw
            return type("Resp", (), {"text": self.text, "candidates": [], "prompt_feedback": "blocked"})()

    reading = gateway.raw_reading("tank-01", 21)
    gateway.gemini, gateway.AI_MODEL = FakeGemini('{"filter": "ZEROWATER", "explanation": "Dissolved solids read 780 ppm."}'), "gemini-test"
    out = await gateway.ask_model(reading, [])
    seen = gateway.gemini.seen
    check("with a Google key the decision goes to Gemini", out == {"filter": "ZEROWATER", "explanation": "Dissolved solids read 780 ppm."} and seen["model"] == "gemini-test")
    check("Gemini gets the same rules and is asked for JSON", "never say the water is safe" in seen["config"]["system_instruction"]
          and seen["config"]["response_mime_type"] == "application/json" and "filter" in seen["config"]["response_json_schema"]["properties"])
    check("the page is told which model it was", gateway.ai_name() == "Gemini" and gateway.health()["ai_name"] == "Gemini")
    for bad in ('{"filter": "BLEACH", "explanation": "x"}', "not json", None):
        gateway.gemini = FakeGemini(bad)
        check(f"a bad Gemini answer ({str(bad)[:12]}) leaves it to the tank's rule", await gateway.ask_model(reading, []) is None)
    # a clear call ("ask":0): the tank has already acted, so nothing goes back and the rule is the decision
    radio = []
    gateway.send_to_tank = radio.append
    sent.clear()
    line = {"node": "tank-01", "test": 30, "phase": "before", "ph": 7.5, "tds": 780, "clarity": 0.95, "verdict": "HIGH_TDS", "filter": "ZEROWATER", "rssi": -60}
    gateway.gemini = FakeGemini('{"filter": "ZEROWATER", "explanation": "Dissolved solids read 780 ppm."}')
    await gateway.handle_line(json.dumps({**line, "ask": 0}))
    await asyncio.sleep(0.2)
    made = [m for m in sent if m["type"] == "decision"]
    check("a clear call sends nothing back to the tank", radio == [], radio)
    check("it is recorded as the tank's rule, with the model's words as the explanation",
          made and all(m["source"] == "local_rule" and m["ai_filter"] == "ZEROWATER" for m in made) and made[-1]["explanation"], made)
    stored = gateway.raw_reading("tank-01", 30)
    check("who decided is stored with the reading", stored["source"] == "local_rule" and stored["ai_filter"] == "ZEROWATER", stored)
    gateway.gemini = FakeGemini('{"filter": "BRITA", "explanation": "Send it to Brita."}')
    sent.clear()
    await gateway.handle_line(json.dumps({**line, "test": 31, "ask": 0}))
    await asyncio.sleep(0.2)
    made = [m for m in sent if m["type"] == "decision"]
    check("a model that would have chosen differently is not quoted as the reason", made and all(m["explanation"] is None and m["ai_filter"] == "ZEROWATER" for m in made), made)
    gateway.gemini = FakeGemini('{"filter": "ZEROWATER", "explanation": "High dissolved solids."}')
    sent.clear()
    await gateway.handle_line(json.dumps({**line, "test": 32, "ask": 1}))
    await asyncio.sleep(0.2)
    made = [m for m in sent if m["type"] == "decision"]
    check("an unsure reading still gets the model's decision, sent to the tank", radio == [{"cmd": "filter", "test": 32, "filter": "ZEROWATER"}]
          and made and made[-1]["source"] == "gemini", (radio, made))
    radio.clear()
    await gateway.handle_line(json.dumps({**line, "test": 33}))
    await asyncio.sleep(0.2)
    check("older firmware, which sends no ask, is treated as asking", len(radio) == 1, radio)
    gateway.gemini = None

    print("\nall passed" if ok else "\nFAILURES")
    raise SystemExit(0 if ok else 1)


asyncio.run(main())
