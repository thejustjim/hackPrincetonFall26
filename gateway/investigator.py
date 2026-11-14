"""deepagents investigator: after every "after" test (water that went through a filter and
was poured back for a retest), a LangChain deep agent looks at the evidence and writes a
short report. The gateway broadcasts it over /ws as {"type": "report", ...}.

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
from deepagents.backends.utils import file_data_to_string
from langchain_anthropic import ChatAnthropic

MODEL = os.getenv("INVESTIGATOR_MODEL", "claude-opus-5-5")
EFFORT = os.getenv("INVESTIGATOR_EFFORT", "low")
REPORT_PATH = "/report.md"

SYSTEM = f"""You are the investigator inside TapTest, a low-cost water tester near Princeton, NJ.
A cup of water was measured (the "before" test), tipped through a filter (ZEROWATER removes
dissolved solids; BRITA is activated carbon for colour, cloudiness and taste), then poured
back and measured again (the "after" test). You get both readings. Find out what they mean.

Start by calling all four tools in one parallel batch:
- get_site_history: this node's recent readings, to see whether today's water is unusual
- get_nearby_nodes: other monitoring nodes nearby (simulated ones are flagged sim=true)
- get_filter_life: how used up each filter is, and whether it needs replacing
- get_reference_data: published USGS / NJ DEP data for Stony Brook, Millstone River, Lake Carnegie

Then write a report of at most 180 words in Markdown with these sections:
## Result  (before -> after for TDS, pH, clarity; did the filter do its job?)
## Context  (this site's history, nearby nodes, published local data)
## Filter  (life used, status, replace or not)
## Next step  (one practical action)

Rules: the sensors measure only pH, TDS (dissolved solids) and clarity, so never claim to
detect specific contaminants, bacteria or lead. Label every comparison by its source:
measured (this device), published (USGS / NJ DEP samples, give the year), or simulated
(sim nodes). TDS above 300 ppm is high (EPA secondary limit 500); pH should be 6.5-8.5;
clarity is 0-1 where 1 is as clear as clean water. Be plain and specific, for a non-expert.

Save the report with write_file to {REPORT_PATH}, then reply with just "done"."""


def build(tools):
    model = ChatAnthropic(
        model=MODEL,
        max_tokens=16000,
        effort=EFFORT,
        # if a safety classifier declines, the API retries on a fallback model by itself
        betas=["server-side-fallback-2026-07-01"],
        model_kwargs={"fallbacks": "default"},
    )
    return create_deep_agent(model=model, tools=tools, system_prompt=SYSTEM,
                             name="taptest-investigator")


async def investigate(agent, case: dict) -> str:
    """case: {"node", "site", "test", "filter", "before", "after"} -> Markdown report."""
    result = await agent.ainvoke({"messages": [{
        "role": "user",
        "content": "Investigate this filter run:\n" + json.dumps(case, indent=1),
    }]})
    report = (result.get("files") or {}).get(REPORT_PATH)
    if report:
        return file_data_to_string(report).strip()
    # it did not save a file: fall back to its last message
    return (result["messages"][-1].text or "").strip()
