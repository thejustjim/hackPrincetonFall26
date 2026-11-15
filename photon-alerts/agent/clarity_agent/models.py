"""Model setup: Gemini through langchain-google-genai, or a no-LLM template model when there's no key."""
from __future__ import annotations

import os
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")


def has_gemini() -> bool:
    return bool(os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"))


def gemini() -> BaseChatModel:
    from langchain_google_genai import ChatGoogleGenerativeAI

    key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    return ChatGoogleGenerativeAI(model=GEMINI_MODEL, google_api_key=key, temperature=0.3, timeout=30, max_retries=2)


class TemplateModel(BaseChatModel):
    """Stand-in for Gemini on the alert path: sends the fixed template unchanged.

    Lets alerts (and the operator-approval interrupt) work with no API key, and in tests.
    """

    @property
    def _llm_type(self) -> str:
        return "clarity-template"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "TemplateModel":
        return self

    def _generate(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        last = messages[-1]
        if isinstance(last, ToolMessage):
            msg = AIMessage(content=f"Done: {last.content}")
        else:
            text = str(last.content)
            alert_id = _between(text, "ALERT_ID=", "\n")
            template = text.split("TEMPLATE:\n", 1)[-1].split("\nEND_TEMPLATE", 1)[0]
            msg = AIMessage(
                content="",
                tool_calls=[{"name": "send_mass_text", "args": {"alert_id": alert_id, "message": template}, "id": f"call_{alert_id}"}],
            )
        return ChatResult(generations=[ChatGeneration(message=msg)])


def _between(s: str, a: str, b: str) -> str:
    return s.split(a, 1)[1].split(b, 1)[0].strip() if a in s else ""


def text_of(message: BaseMessage) -> str:
    """Gemini may return a list of content parts; flatten to plain text."""
    c = message.content
    if isinstance(c, str):
        return c
    return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
