"""Residents text a photo of their water; Gemini classifies it and we attach it to the site as evidence."""
from __future__ import annotations

import time
from typing import Literal

from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field

from .intents import ph_is_estimated
from .models import gemini, has_gemini
from .safety import scrub


class PhotoVerdict(BaseModel):
    is_water: bool = Field(
        description="True ONLY if the photo is about drinking water: water in a glass, bottle, sink or tank, a running tap, "
        "a water filter or pitcher, a water tester, or stains/scale/rust from water. False for anything else (people, food, "
        "pets, screenshots, memes, documents, scenery, other drinks)."
    )
    appearance: Literal["clear", "cloudy", "discolored", "particles", "foamy", "unclear"]
    color: str = Field(description="Short color description, e.g. 'colorless', 'light brown', 'yellow tint'")
    confidence: float = Field(ge=0, le=1)
    note: str = Field(description="One short sentence describing what is visible. Never call the water safe.")


PROMPT = (
    "A resident texted this photo to Clarity, a water-testing service. First decide if it is about their drinking water; "
    "if not, set is_water=false and appearance='unclear'. "
    "Classify only what is visible. Do not judge whether it is safe to drink: a photo cannot show dissolved solids, lead or bacteria."
)


LAST_ERROR: str | None = None  # why the last classify returned None (shown by npm run photo-test)


def classify(image_b64: str, mime: str) -> PhotoVerdict | None:
    global LAST_ERROR
    LAST_ERROR = None
    if not has_gemini():
        LAST_ERROR = "no Gemini key"
        return None
    model = gemini().with_structured_output(PhotoVerdict)
    msg = HumanMessage(content=[{"type": "text", "text": PROMPT}, {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}}])
    for attempt in range(3):  # retry rate limits / blips: 0s, 2s, 6s
        try:
            out = model.invoke([msg])
            if out is not None:
                return out
            LAST_ERROR = "Gemini returned no structured answer"
        except Exception as err:
            LAST_ERROR = f"{type(err).__name__}: {str(err)[:200]}"
        print(f"[photos] classify attempt {attempt + 1} failed: {LAST_ERROR}")
        time.sleep(2 * attempt + 2 if attempt < 2 else 0)
    return None


DECLINE = "📷 I can only check photos of your water\n\nSend a clear glass of tap water against something white, or a photo of your tap or filter."


def _failing(r: dict | None) -> bool:
    if not r:
        return False
    return float(r.get("tds", 0)) > 500 or (not ph_is_estimated(r) and not 6.5 <= float(r.get("ph", 7)) <= 8.5)


def reply_for(v: PhotoVerdict | None, site_name: str | None, latest: dict | None) -> str:
    # Gemini declines or errors on many non-water photos (people, screenshots); answer those the same way.
    if v is None or not v.is_water:
        return DECLINE
    appearance = v.appearance if v.confidence >= 0.5 else "unclear"
    icon = "✅" if appearance == "clear" else "⚠️"
    seen = {"clear": "Looks clear", "cloudy": "Looks cloudy", "discolored": f"Discolored ({v.color})",
            "particles": "Visible particles", "foamy": "Looks foamy", "unclear": "Hard to tell from this photo"}[appearance]
    lines = [f"📷 Photo check{' · ' + site_name if site_name else ''}", "", f"{icon} {seen}"]
    if v.note:
        lines.append(f"↳ {v.note.strip()}")
    if latest:
        estimated, alarm = ph_is_estimated(latest), " 🚨" if _failing(latest) else ""
        ph = f"pH {float(latest.get('ph', 0)):.1f}{' (estimated from TDS)' if estimated else ''}"
        # An alarm beside a derived pH would imply that estimate triggered it. On estimated
        # readings the alarm belongs to the independently measured TDS instead.
        lines.append(f"Last sensor test: TDS {round(latest.get('tds', 0))} ppm{alarm if estimated else ''} · {ph}{alarm if not estimated else ''}")
    lines.append("")
    if appearance in ("discolored", "particles", "foamy", "cloudy"):
        lines.append("Don't drink it unfiltered. We'll flag it for a retest.")
    elif appearance == "clear" and _failing(latest):
        lines.append("Clear water can still fail. The last sensor test was over the limit, so filter it.")
    elif appearance == "unclear":
        lines.append("Try a clear glass against something white, in good light.")
    lines.append("A photo can't show dissolved metals, lead or bacteria. The sensor test is what counts.")
    return scrub("\n".join(lines))
