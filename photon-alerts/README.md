# Clarity on Photon

Clarity's messaging agent for the Photon 2.0 track. It lives on a Photon iMessage line and has two halves:

* **Photon bridge (Node, `src/`)**: the iMessage line via `spectrum-ts` (Photon's SDK, TypeScript only). It watches the gateway's `/ws` feed, decides when a site failed, handles JOIN/STOP, acknowledgements and operator approvals, and sends every text.
* **Agent (Python, `agent/`)**: `deepagents` with Gemini via `langchain-google-genai`. It answers residents' questions, words alerts, holds mass texts for operator approval, and classifies photos.

```
gateway /ws ──> bridge ──(reading/decision/report)──> agent
residents ⇄ iMessage ⇄ bridge ──(question/photo)──> agent (Gemini + tools: nodes, readings, filters, reports, evidence)
bridge ──(failed test)──> agent: Gemini rewords template ──> interrupt ──> operator texts APPROVE n ──> bridge /send
```

## Run it (three terminals)

```bash
npm install && npm run agent:setup      # once
cp .env.example .env                    # Photon keys, GOOGLE_API_KEY, ALERT_NUMBERS

npm run mock-gateway                    # 1: fake gateway (ws + /api/nodes, /api/readings, /api/filters). Skip when Jim's gateway runs.
npm run agent                           # 2: Python agent on :8001   (uses agent/.venv: run `source agent/.venv/bin/activate` first)
npm start                               # 3: Photon bridge
```

Then text **JOIN** to the Photon line. The operator (ALERT_NUMBERS by default) gets "Clarity approval #1 … Reply APPROVE 1", and after APPROVE 1 everyone subscribed gets the alert.

Without Photon: `npm run dev` prints texts instead; type `+16095550123 is the tank ok?` to fake an inbound text.
Tests: `npm test` (Node + Python).

## What it does

| Feature | How |
|---|---|
| Outbound alerts | A failed reading (HIGH_TDS, CLOUDY, PH_WARN, TDS > 500, pH outside 6.5 to 8.5) builds a **fixed template**. Gemini may only reword it; if the rewrite drops any number or claims safety, the template is sent instead. |
| Operator approval | Mass texts go through the deepagents `send_mass_text` tool with `interrupt_on` (LangGraph interrupt, approve / edit / reject). The bridge texts operators the preview; they reply `APPROVE 3`, `REJECT 3`, or `EDIT 3 <text>`. `GET /approvals` lists pending ones. |
| Inbound questions | "Is it OK to drink?", "When will it be fixed?": the deepagent calls `list_sites`, `get_readings`, `get_filter_status`, `get_investigator_reports`, `get_photo_evidence`. It remembers each person's thread, including the alerts it sent them. |
| Photo evidence | A resident texts a photo; Gemini classifies it (clear, cloudy, discolored, particles…) and it's attached to their site in `evidence.json` and `POST /api/evidence` on the gateway if Jim adds it. `GET /evidence?node=` on the agent for the dashboard. |
| Never says "safe" | Prompt rule, plus a filter on every outgoing text in both Python and Node that rewrites any "safe" claim to "within normal range". Dashboard can keep its SAFE label. |
| Human in the loop | Reply OK to acknowledge; one reminder after 15 minutes if not; per-site JOIN; STOP never goes through the AI. |
| Fallbacks | No Gemini key or Gemini down: alerts use the template (still needs approval), replies are raw readings. Agent down: alerts go to operators only (no unapproved mass text), replies are raw readings. |

For Jim: the bridge also accepts gateway frames at `POST http://localhost:8787/events` (same JSON as `/ws`) if you'd rather push than have it listen.

## Photon 2.0 track checklist

| Requirement / judging point | Where |
|---|---|
| Built on Photon 2.0, live on a channel | `spectrum-ts` iMessage provider, project line from app.photon.codes |
| Agent that participates | deepagents chat with live data and memory; photo intake |
| Human in the loop | Operator approval of every mass text; resident OK acks and reminders |
| Thoughtful safety and fallbacks | Never-say-safe filter, template guard, offline modes, STOP outside the AI |

Photon's shared line can't send the first message, so every phone (operators too) must text the line once (JOIN) before it can get alerts. Limits: 50 new conversations per line per day, 5,000 messages per day.
