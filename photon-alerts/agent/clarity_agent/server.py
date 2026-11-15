"""HTTP API the Photon bridge (Node, spectrum-ts) calls. Run: uvicorn clarity_agent.server:app --port 8001"""
from __future__ import annotations

import os

import httpx
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parents[2] / ".env")  # one .env at the project root for both halves

from .agents import ClarityAgents, facts_from  # noqa: E402
from .data import LiveData  # noqa: E402
from . import photos  # noqa: E402
from .photos import classify, reply_for  # noqa: E402
from .safety import scrub  # noqa: E402

BRIDGE = os.environ.get("BRIDGE_URL", "http://localhost:8787")


def bridge_send(recipients: list[str], text: str, alert_id: str | None = None) -> int:
    r = httpx.post(f"{BRIDGE}/send", json={"to": recipients, "text": scrub(text), "alert_id": alert_id}, timeout=60)
    r.raise_for_status()
    return r.json().get("sent", 0)


data = LiveData()
agents = ClarityAgents(data, bridge_send)
app = FastAPI(title="Clarity agent")


@app.get("/welcome")
def welcome():
    from .intents import WELCOME
    return {"text": WELCOME}


class Chat(BaseModel):
    phone: str
    text: str


class AlertIn(BaseModel):
    alert_id: str
    node: str
    template: str
    recipients: list[str]


class DecisionIn(BaseModel):
    decision: str  # approve | edit | reject
    text: str | None = None


class PhotoIn(BaseModel):
    phone: str
    image_b64: str
    mime: str = "image/jpeg"
    node: str | None = None  # bridge's best guess: the site this person subscribes to or was last alerted about
    text: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "gemini": agents.chat_agent is not None}


@app.post("/events")
def events(frame: dict):
    data.ingest(frame)
    return {"ok": True}


@app.post("/chat")
def chat(body: Chat):
    return {"reply": agents.chat(body.phone, body.text)}


@app.post("/remember")
def remember(body: Chat):
    agents.remember(body.phone, body.text)
    return {"ok": True}


@app.post("/alerts")
def alerts(body: AlertIn):
    a = agents.start_alert(body.alert_id, body.node, body.template, facts_from(body.template), body.recipients)
    return {"status": a.status, "approval_id": a.approval_id, "preview": a.preview, "result": a.result}


@app.get("/approvals")
def approvals():
    return agents.pending()


@app.post("/approvals/{approval_id}")
def decide(approval_id: int, body: DecisionIn):
    a = agents.decide(approval_id, body.decision, body.text)
    if not a:
        raise HTTPException(404, "no pending approval with that number")
    return {"status": a.status, "result": a.result}


@app.post("/photo")
def photo(body: PhotoIn):
    v = classify(body.image_b64, body.mime)
    node = body.node
    latest = data.latest.get(node) if node else None
    if node and v is not None and v.is_water:  # only real water photos become evidence
        data.attach_evidence(node, {"from": body.phone[-4:], "mime": body.mime, "caption": body.text,
                                    "classification": v.model_dump()})
    reply = reply_for(v, (latest or {}).get("name") or node, latest)
    if v is None and photos.LAST_ERROR and photos.LAST_ERROR != "no Gemini key":
        # Gemini failed (usually quota), so don't claim the photo isn't water.
        reply = "📷 Got your photo, but I can't check it right now. Try again in a few minutes."
    return {"reply": reply, "node": node,
            "classification": v.model_dump() if v else None, "error": None if v else photos.LAST_ERROR}


@app.get("/evidence")
def evidence(node: str | None = None):
    return data.evidence.get(node, []) if node else data.evidence
