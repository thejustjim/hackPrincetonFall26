"""deepagents investigator: a lead agent and five specialists.

After every "after" test (water that went through a filter and was poured back for a retest)
the gateway has already worked out the numbers (analysis.py: sensor checks, the node's own
baseline, the control charts, the peer comparison and a verdict). This file is the part that
reads them. A LangChain deep agent, the lead, hands the case to five specialists at once
through deepagents' `task` tool, each with its own narrow tools, then writes the report:

    sensor-health   is the sensor believable?            get_sensor_checks
    analyst         is this unusual for this site?       get_baseline, get_site_history, query_readings (read-only SQL)
    network         local or regional? what is published get_peer_comparison, get_nearby_nodes, get_reference_data
    maintenance     filters and upkeep                   get_filter_life, search_guidance
    comms           a short notice from fixed templates  get_notice_templates

The agents explain and decide what to do next. They do not compute: every number comes from
a tool, and the verdict and severity come from analysis.py, not from a model.

The tools are plain functions the gateway passes in, so this file has no database code.

Env vars:
    INVESTIGATOR=0               turn it off (it is on whenever ANTHROPIC_API_KEY is set)
    INVESTIGATOR_MODEL           the lead's model, default claude-opus-5-5
    INVESTIGATOR_SUBAGENT_MODEL  the specialists' model, default the same as the lead's
    INVESTIGATOR_EFFORT          low | medium | high (default low: fast, and it still uses every tool)
"""
import json
import os

from deepagents import create_deep_agent
from langchain.agents.structured_output import ProviderStrategy
from langchain_anthropic import ChatAnthropic
from pydantic import BaseModel, Field

MODEL = os.getenv("INVESTIGATOR_MODEL", "claude-opus-5-5")
SUBAGENT_MODEL = os.getenv("INVESTIGATOR_SUBAGENT_MODEL", MODEL)
EFFORT = os.getenv("INVESTIGATOR_EFFORT", "low")


class Report(BaseModel):
    summary: str = Field(description="One or two plain sentences: what happened to this water "
                                     "and whether the filter did its job.")
    findings: list[str] = Field(description="Three to five short findings, each naming its source: "
                                            "measured, published (with year) or simulated.")
    actions: list[str] = Field(description="One to three practical next steps, most important first.")
    notice: str = Field(description="The comms specialist's draft notice, copied without changes.")


RULES = """Rules, which have no exceptions:
- The sensors measure only pH, TDS (dissolved solids) and clarity (shown as transparency, 0-1
  where 1 is as clear as clean water). Never claim to detect a specific contaminant, bacteria
  or lead. Never call the water safe and never tell anyone to drink it: say the readings are
  in range or out of range.
- Do not compute, estimate or round numbers yourself. Every number you give must come from a
  tool result or the case, unchanged.
- Label every comparison by its source: measured (this device), published (USGS / NJ DEP
  samples; give the year) or simulated (nodes flagged sim=true).
- TDS above 300 ppm counts as high here (the EPA's secondary guideline is 500). pH should be
  6.5 to 8.5. Transparency below 0.70 counts as cloudy.
- Write for someone who is not an expert: one plain sentence per point, with the numbers that
  matter."""

LEAD = """You lead the investigation inside Clarity, a low-cost water tester near Princeton, NJ.
A cup of water was measured (the "before" test), tipped through a filter (ZEROWATER removes
dissolved solids; BRITA is activated carbon for colour, cloudiness and taste), then poured
back and measured again (the "after" test). You get both readings, plus the verdict of the
gateway's own statistical checks.

You have five specialists. Start by calling the task tool five times in one message, once for
each of: sensor-health, analyst, network, maintenance, comms. Each specialist sees only the
description you write, so give every one the node id and the test number and ask for its
findings on this filter run. Do not do their work yourself and do not skip any of them.

When all five have answered, write the report: a summary (before to after, and whether the
filter did its job), findings drawn from the specialists (keep each one's source label and
numbers exactly), actions (most important first) and the notice, copied from the comms
specialist without changes. If a specialist says the sensor is at fault, say so first: a
sensor fault is not a water event. Do not change the verdict or the severity you were given.

""" + RULES

SPECIALISTS = [
    {"name": "sensor-health", "title": "Sensor health",
     "tools": ["get_case", "get_sensor_checks"],
     "description": "Judges whether the sensor's readings can be believed (stuck, out of range, reading zero, drifting). "
                    "Give it the node id and test number.",
     "prompt": "You check whether Clarity's sensors can be believed for one filter run. Call get_case and "
               "get_sensor_checks for the node and test you are given. Say, for pH, dissolved solids and "
               "transparency, whether each reading can be trusted, and if not, why and what to check. A sensor "
               "fault is not a water event: say which this is."},
    {"name": "analyst", "title": "This site's history",
     "tools": ["get_case", "get_baseline", "get_site_history", "query_readings"],
     "description": "Compares the pour with this node's own history: robust z-scores, EWMA and CUSUM charts, the "
                    "multivariate distance, and read-only SQL over the readings. Give it the node id and test number.",
     "prompt": "You compare one pour with its own site's history. Call get_case and get_baseline for the node and "
               "test you are given, then get_site_history or query_readings if you need the rows behind them. "
               "Say how unusual the pour is for this site (give the z-score and the site's median), whether it "
               "is a one-off or has repeated, and whether the control charts show a small shift that persists."},
    {"name": "network", "title": "Nearby and published",
     "tools": ["get_case", "get_peer_comparison", "get_nearby_nodes", "get_reference_data"],
     "description": "Decides whether a change is local or regional by comparing nearby nodes, and sets the reading "
                    "against published USGS / NJ DEP samples. Give it the node id and test number.",
     "prompt": "You decide whether what one node saw is local or regional. Call get_case, get_peer_comparison and "
               "get_reference_data for the node and test you are given (get_nearby_nodes lists the neighbours' "
               "latest readings). Say how many nearby nodes moved the same way and what that means, and how the "
               "pour compares with the nearest published water body. Most nearby nodes are simulated: say so "
               "every time you use one."},
    {"name": "maintenance", "title": "Filters and upkeep",
     "tools": ["get_case", "get_filter_life", "search_guidance"],
     "description": "Reports filter life and what upkeep the case calls for, from the makers' rules and a small "
                    "set of guidance notes. Give it the node id and test number.",
     "prompt": "You look after the filters and the sensor's upkeep. Call get_case and get_filter_life for the node "
               "and test you are given, then search_guidance for what the case calls for (for example the filter "
               "that was used, a lab test, or calibration). Say whether the filter that was used needs replacing "
               "and why, and name one upkeep step if the guidance supports it, with the guidance note's source."},
    {"name": "comms", "title": "Draft notice",
     "tools": ["get_case", "get_notice_templates"],
     "description": "Drafts a short notice about this run for the people who use this water, from fixed templates. "
                    "Give it the node id and test number.",
     "prompt": "You draft one short notice for the people who use this water. Call get_case and "
               "get_notice_templates for the node and test you are given. Pick the template that fits the "
               "outcome and fill in its blanks from the case. You may make the wording plainer, but keep every "
               "sentence the template marks as required exactly as written, and add no numbers of your own. "
               "Answer with the notice only, nothing before or after it."},
]
TITLES = {s["name"]: s["title"] for s in SPECIALISTS}


def chat(model):
    """A Claude chat model for the lead or a specialist."""
    extra = {}
    if not model.startswith("claude-haiku"):
        # if a safety classifier declines, the API retries on a fallback model by itself
        # (Claude Haiku has no server-side fallback, so it is left out there)
        extra = {"betas": ["server-side-fallback-2026-07-01"], "model_kwargs": {"fallbacks": "default"}}
    return ChatAnthropic(model=model, max_tokens=16000, effort=EFFORT, **extra)


def build(tools, lead_model=None, specialist_model=None):
    """tools: {name: function}. The two model arguments are for tests; left out, Claude is used."""
    lead = lead_model or chat(MODEL)
    worker = specialist_model or (lead if SUBAGENT_MODEL == MODEL and lead_model is None else chat(SUBAGENT_MODEL))
    subagents = [{"name": s["name"], "description": s["description"],
                  "system_prompt": s["prompt"] + " Answer in at most three sentences.\n\n" + RULES,
                  "tools": [tools[t] for t in s["tools"]], "model": worker} for s in SPECIALISTS]
    # ProviderStrategy = Claude's native structured output. (The tool strategy would force
    # tool_choice="any", which Opus 5.5 rejects.)
    return create_deep_agent(model=lead, tools=[], system_prompt=LEAD, subagents=subagents,
                             response_format=ProviderStrategy(Report), name="clarity-investigator")


def text_of(message):
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content.strip()
    return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()


def sections_from(messages):
    """What each specialist told the lead, in the order they were asked: [{"agent", "title", "text"}]."""
    asked, out = {}, []
    for m in messages:
        for call in getattr(m, "tool_calls", None) or []:
            if call.get("name") == "task":
                asked[call["id"]] = (call.get("args") or {}).get("subagent_type")
        agent = asked.get(getattr(m, "tool_call_id", None))
        if agent in TITLES and text_of(m):
            out.append({"agent": agent, "title": TITLES[agent], "text": text_of(m)})
    return out


async def investigate(agent, case: dict) -> dict:
    """case: {"node", "site", "test", "filter", "before", "after", "checks"} ->
    {"summary", "findings", "actions", "notice", "sections"}."""
    result = await agent.ainvoke({"messages": [{
        "role": "user",
        "content": "Investigate this filter run:\n" + json.dumps(case, indent=1),
    }]})
    report = result.get("structured_response")
    if isinstance(report, BaseModel):
        report = report.model_dump()
    if not isinstance(report, dict):
        # no structured answer: keep its last message as the summary
        report = {"summary": text_of(result["messages"][-1]), "findings": [], "actions": [], "notice": ""}
    report["sections"] = sections_from(result["messages"])
    return report
