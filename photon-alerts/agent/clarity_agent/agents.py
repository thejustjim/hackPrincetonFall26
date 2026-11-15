"""The two deepagents: one answers residents' texts, one sends mass alerts behind operator approval."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from itertools import count
from typing import Callable

from deepagents import create_deep_agent
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from .data import LiveData
from .models import TemplateModel, gemini, has_gemini, text_of
from .safety import scrub, violates

LEGACY_PH_NOTE = ("estimated from TDS" if os.getenv("PH_ESTIMATED", "1").strip() != "0" else "marked as measured")

CHAT_PROMPT = f"""You are Clarity, a water-quality assistant people talk to over iMessage and SMS.
Clarity runs testers at sites around Princeton, NJ that measure TDS (total dissolved solids, ppm) and clarity (0 to 1); pH is measured or estimated as each reading flags,
then retest after its Brita filter (the rig has one filter). An AI investigator writes reports after each retest.

Always look up the data with your tools before answering. Never answer from memory.

HARD RULES
- Never tell anyone their water is "safe" or "safe to drink", in any wording. Only report what the readings show,
  for example "the last test at 3:10 PM read 8 ppm TDS; pH 7.0 is estimated from TDS."
- Name the site, the numbers, and how old the reading is. If the newest reading is over 2 hours old, say so and suggest a retest.
- Per-reading provenance: ph_est true/1 means pH is estimated from TDS. Explicit false/0 means measured.
  If ph_est is missing or null, treat that legacy reading as {LEGACY_PH_NOTE} for this deployment.
  Label every estimated pH as "estimated from TDS". Never give an estimate a checkmark, call it a probe measurement,
  or use it as independent acidity/corrosion evidence, an alert reason, or a reason to choose a filter.
  Independent TDS and clarity findings still count. A PH_WARN based only on estimated pH is not an independent warning.
- Limits: TDS above 500 ppm is over the EPA limit, above 300 is high; normal pH is 6.5 to 8.5. Say "simulated" for sim nodes.
- "What filter should I buy?": call get_readings first. TDS over 500 → ZeroWater (Brita barely lowers TDS). Under 500 → Brita is enough. Measured low pH → filters don't fix it. Quote the reading.
- Readings with phase "after" are the same water AFTER a filter. Judge the tap water by the newest "before" reading; mention the filtered result separately.
- "When will it be fixed?": answer from investigator reports and filter status (replace/ok). If nothing says, say you don't know yet.
- TDS sensors can't detect lead, bacteria or PFAS. Say Clarity can't rule those out and suggest a certified lab test.
- If someone feels sick, tell them to contact a doctor, Poison Control at 1-800-222-1222, or 911 in an emergency.
- Don't invent sites or numbers.
- Only talk about water: Clarity's readings, filters, what the tests mean, water quality in general. If someone asks about
  anything else, say kindly in one line that you only help with their water, and suggest a water question.
- When a reading is off, say in a few words what it means and why it matters: TDS = dissolved salts and metals (taste, scale,
  can carry contaminants); measured low pH can pull lead and copper from pipes; cloudy water has particles that can hide bacteria.

STYLE: a text read on a phone lock screen. Start with one status emoji (✅ normal, ⚠️ notice, 🚨 failed, 💧 info).
Then short lines, one fact per line, like "TDS 8 ppm ✓". At most 5 lines. Use the site name only, never its id. No markdown."""

ALERT_PROMPT = """You send Clarity water alerts by text. You get a fixed alert TEMPLATE.
Lightly polish its tone so it reads calm and human. Keep its layout: a short header line with the emoji, a blank line,
one fact per line, then the action line. At most 320 characters. You may change wording and tone ONLY.
Keep every number, the site name, the filter name, the "↳" explanation lines, any "estimated from TDS" label, and the OK / STOP line. Add no new facts and no extra sentences.
Never say the water is "safe"; say "within normal range" instead.
Then call send_mass_text exactly once with the alert_id and your message. Don't call any other tool."""


def _tools_for_chat(data: LiveData) -> list[Callable]:
    def list_sites() -> str:
        """List every site and latest reading, including ph_est provenance (1/true = estimated from TDS), node, name, verdict, TDS, pH, clarity, time and simulated."""
        return json.dumps(data.nodes(), default=str)[:6000]

    def get_readings(node: str, limit: int = 8) -> str:
        """Recent readings for one site, newest first, retaining each ph_est flag. `node` is the site id like 'tank-01'. Estimated pH is not independent evidence."""
        return json.dumps(data.readings(node, limit), default=str)[:6000]

    def get_filter_status() -> str:
        """Filter life: liters used, last after-filter TDS, and status OK / REPLACE_SOON / REPLACE."""
        return json.dumps(data.filters(), default=str)

    def get_investigator_reports(node: str) -> str:
        """The AI investigator's latest reports for a site: summary, findings, recommended actions."""
        return json.dumps(data.node_reports(node), default=str) or "[]"

    def get_photo_evidence(node: str) -> str:
        """Photos residents texted for a site and how they were classified."""
        return json.dumps(data.evidence.get(node, []), default=str)

    return [list_sites, get_readings, get_filter_status, get_investigator_reports, get_photo_evidence]


@dataclass
class PendingAlert:
    alert_id: str
    node: str
    template: str
    facts: list[str]
    recipients: list[str]
    approval_id: int = 0
    preview: str = ""
    status: str = "drafting"  # drafting | pending_approval | sent | rejected
    thread: str = ""
    result: dict = field(default_factory=dict)


class ClarityAgents:
    def __init__(self, data: LiveData, send: Callable[[list[str], str, str], int], mass_threshold: int | None = None):
        self.data = data
        self.send = send  # bridge call: (recipients, text, alert_id) -> number sent
        self.mass_threshold = mass_threshold if mass_threshold is not None else int(os.environ.get("MASS_THRESHOLD", "1"))
        self.alerts: dict[str, PendingAlert] = {}
        self.by_approval: dict[int, str] = {}
        self._ids = count(1)
        self.checkpointer = InMemorySaver()
        self.chat_agent = (
            create_deep_agent(model=gemini(), tools=_tools_for_chat(data), system_prompt=CHAT_PROMPT, checkpointer=self.checkpointer, name="clarity-chat")
            if has_gemini()
            else None
        )
        # Gemini rewords alerts; the template agent sends the fixed text if Gemini is missing or fails.
        self.alert_agent = self._alert_agent(gemini()) if has_gemini() else None
        self.template_agent = self._alert_agent(TemplateModel())

    # ---------- residents' questions ----------
    def chat(self, phone: str, text: str) -> str:
        if not self.chat_agent:
            return self.fallback_answer(text)
        try:
            out = self.chat_agent.invoke(
                {"messages": [{"role": "user", "content": text}]},
                {"configurable": {"thread_id": f"chat:{phone}"}},
            )
            answer = text_of(out["messages"][-1]).strip()
        except Exception as err:  # Gemini down, quota, etc.
            print(f"[agent] chat failed ({err!r}); using rule-based answers")
            return self.fallback_answer(text)
        return scrub(answer) or self.fallback_answer(text)

    def remember(self, phone: str, text: str) -> None:
        """Record an alert we texted someone, so 'what does that mean?' has context."""
        if self.chat_agent:
            self.chat_agent.update_state({"configurable": {"thread_id": f"chat:{phone}"}}, {"messages": [{"role": "assistant", "content": text}]})

    def fallback_answer(self, text: str = "") -> str:
        """No Gemini: answer the common questions from rules so it still feels like a chat."""
        from .intents import answer

        return scrub(answer(text, self.data))

    # ---------- mass alerts with operator approval ----------
    def _alert_agent(self, model):
        return create_deep_agent(
            model=model,
            tools=[self._send_mass_text_tool()],
            system_prompt=ALERT_PROMPT,
            interrupt_on={
                "send_mass_text": {
                    "allowed_decisions": ["approve", "edit", "reject"],
                    "description": "Mass text to residents. An operator must approve, edit or reject it.",
                }
            },
            checkpointer=self.checkpointer,
            name="clarity-alerts",
        )

    def _send_mass_text_tool(self):
        agents = self

        def send_mass_text(alert_id: str, message: str) -> str:
            """Text an alert to everyone subscribed to the affected site. Requires operator approval."""
            alert = agents.alerts.get(alert_id)
            if not alert:
                return f"unknown alert_id {alert_id}"
            final = agents._guard(alert, message)
            n = agents.send(alert.recipients, final, alert.alert_id)
            alert.status, alert.result = "sent", {"sent": n, "text": final}
            return f"sent to {n} people"

        return send_mass_text

    def _guard(self, alert: PendingAlert, message: str) -> str:
        """Gemini may only reword. If it dropped a fact or claimed safety, fall back to the fixed template."""
        msg = scrub(message.strip())
        missing = [f for f in alert.facts if f.lower() not in msg.lower()]
        lines = [l.strip() for l in alert.template.strip().splitlines() if l.strip()]
        keep = [lines[0], lines[-1]] if lines else []  # header (🚨 Water alert · Clarity) and the reply line
        # A model/operator rewrite must not turn a derived value into an apparent probe reading.
        keep += [line for line in lines if re.search(r"\bpH\b.*estimated", line, re.I)]
        missing += [k for k in keep if k not in msg]
        if missing or not msg or len(msg) > 600:
            print(f"[agent] alert {alert.alert_id}: reworded text dropped {missing}; using template")
            return scrub(alert.template)
        return msg

    def start_alert(self, alert_id: str, node: str, template: str, facts: list[str], recipients: list[str]) -> PendingAlert:
        alert = PendingAlert(alert_id, node, template, facts, recipients)
        self.alerts[alert_id] = alert
        if len(recipients) < self.mass_threshold:  # not a mass message: no approval needed
            final = self._guard(alert, template)
            alert.status, alert.result = "sent", {"sent": self.send(recipients, final, alert_id), "text": final}
            return alert
        prompt = f"ALERT_ID={alert_id}\nSite: {node}. Recipients: {len(recipients)}.\nTEMPLATE:\n{template}\nEND_TEMPLATE"
        out = None
        if self.alert_agent:
            try:
                alert.thread = f"alert:{alert_id}"
                out = self.alert_agent.invoke({"messages": [{"role": "user", "content": prompt}]}, {"configurable": {"thread_id": alert.thread}})
            except Exception as err:
                print(f"[agent] Gemini alert wording failed ({err!r}); using template")
                out = None
        if out is None:
            alert.thread = f"alert-template:{alert_id}"
            out = self.template_agent.invoke({"messages": [{"role": "user", "content": prompt}]}, {"configurable": {"thread_id": alert.thread}})
        interrupts = out.get("__interrupt__") or []
        if interrupts:
            req = interrupts[0].value
            args = req["action_requests"][0]["args"]
            alert.preview = self._guard(alert, args.get("message", template))
            alert.approval_id = next(self._ids)
            self.by_approval[alert.approval_id] = alert_id
            alert.status = "pending_approval"
        return alert

    def decide(self, approval_id: int, decision: str, text: str | None = None) -> PendingAlert | None:
        alert_id = self.by_approval.get(approval_id)
        alert = self.alerts.get(alert_id) if alert_id else None
        if not alert or alert.status != "pending_approval":
            return None
        if decision == "approve":
            d = {"type": "approve"}
        elif decision == "edit" and text:
            d = {"type": "edit", "edited_action": {"name": "send_mass_text", "args": {"alert_id": alert_id, "message": text}}}
        else:
            d = {"type": "reject", "message": text or "Operator rejected this alert. Do not send it."}
        agent = self.template_agent if alert.thread.startswith("alert-template") else self.alert_agent
        try:
            agent.invoke(Command(resume={"decisions": [d]}), {"configurable": {"thread_id": alert.thread}})
        except Exception as err:
            # The tool already ran on approve/edit; a failure here is Gemini's closing remark. Send directly if it didn't.
            print(f"[agent] resume error ({err!r})")
            if d["type"] != "reject" and alert.status != "sent":
                final = self._guard(alert, text if d["type"] == "edit" else alert.preview)
                alert.status, alert.result = "sent", {"sent": self.send(alert.recipients, final, alert.alert_id), "text": final}
        if d["type"] == "reject":
            alert.status = "rejected"
        return alert

    def pending(self) -> list[dict]:
        return [
            {"approval_id": a.approval_id, "alert_id": a.alert_id, "node": a.node, "recipients": len(a.recipients), "preview": a.preview}
            for a in self.alerts.values()
            if a.status == "pending_approval"
        ]


def facts_from(text: str) -> list[str]:
    """Numbers (e.g. '780 ppm', '5.9') that a reworded alert must keep."""
    return sorted(set(re.findall(r"\d+(?:\.\d+)?", text)))
