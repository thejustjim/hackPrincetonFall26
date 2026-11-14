"""deepagents investigator: after every "after" test (water that went through a filter and
was poured back for a retest), a LangChain deep agent looks at the evidence and writes a
short report. The gateway broadcasts it over /ws as
{"type": "report", "node", "test", "summary", "findings": [...], "actions": [...]}.

The tools are plain functions that the gateway passes in (get_site_history,
get_nearby_nodes, get_filter_life, get_reference_data), so this file has no database code.

Env vars:
    INVESTIGATOR=0          turn it off (it is on whenever ANTHROPIC_API_KEY is set)
    INVESTIGATOR_MODEL      default claude-opus-5-5
    INVESTIGATOR_EFFORT     low | medium | high (default low: fast, cheap, still uses every tool)
"""
import json
import os

from deepagents import create_deep_agent
from langchain.agents.structured_output import ProviderStrategy
from langchain_anthropic import ChatAnthropic
from pydantic import BaseModel, Field

MODEL = os.getenv("INVESTIGATOR_MODEL", "claude-opus-5-5")
EFFORT = os.getenv("INVESTIGATOR_EFFORT", "low")


class Report(BaseModel):
    summary: str = Field(description="One or two plain sentences: what happened to this water "
                                     "and whether the filter did its job.")
    findings: list[str] = Field(description="Two to four short findings, each naming its source: "
                                            "measured, published (with year) or simulated.")
    actions: list[str] = Field(description="One to three practical next steps, most important first.")


SYSTEM = """You are the investigator inside TapTest, a low-cost water tester near Princeton, NJ.
A cup of water was measured (the "before" test), tipped through a filter (ZEROWATER removes
dissolved solids; BRITA is activated carbon for colour, cloudiness and taste), then poured
back and measured again (the "after" test). You get both readings. Find out what they mean.

Start by calling all four tools in one parallel batch:
- get_site_history: this node's recent readings, to see whether today's water is unusual
- get_nearby_nodes: other monitoring nodes nearby (simulated ones are flagged sim=true)
- get_filter_life: how used up each filter is, and whether it needs replacing
- get_reference_data: published USGS / NJ DEP data for Stony Brook, Millstone River, Lake Carnegie

Then answer with the report: a summary (before -> after, did the filter work), findings
(this site's history, nearby nodes, published local data, filter life) and actions.

Rules: the sensors measure only pH, TDS (dissolved solids) and clarity, so never claim to
detect specific contaminants, bacteria or lead. Label every comparison by its source:
measured (this device), published (USGS / NJ DEP samples, give the year), or simulated
(sim nodes). TDS above 300 ppm is high (EPA secondary limit 500); pH should be 6.5-8.5;
clarity is 0-1 where 1 is as clear as clean water. Keep each item to one plain sentence
a non-expert understands, with the numbers that matter."""


def build(tools):
    model = ChatAnthropic(
        model=MODEL,
        max_tokens=16000,
        effort=EFFORT,
        # if a safety classifier declines, the API retries on a fallback model by itself
        betas=["server-side-fallback-2026-07-01"],
        model_kwargs={"fallbacks": "default"},
    )
    # ProviderStrategy = Claude's native structured output. (The tool strategy would force
    # tool_choice="any", which Opus 5.5 rejects.)
    return create_deep_agent(model=model, tools=tools, system_prompt=SYSTEM,
                             response_format=ProviderStrategy(Report),
                             name="taptest-investigator")


async def investigate(agent, case: dict) -> dict:
    """case: {"node", "site", "test", "filter", "before", "after"} -> {"summary", "findings", "actions"}."""
    result = await agent.ainvoke({"messages": [{
        "role": "user",
        "content": "Investigate this filter run:\n" + json.dumps(case, indent=1),
    }]})
    report = result.get("structured_response")
    if isinstance(report, BaseModel):
        return report.model_dump()
    if isinstance(report, dict):
        return report
    # no structured answer: keep its last message as the summary
    return {"summary": (result["messages"][-1].text or "").strip(), "findings": [], "actions": []}
