// Clarity Photon bridge: the iMessage line (spectrum-ts) <-> gateway feed <-> Python agent (deepagents + Gemini).
import "dotenv/config";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { agentClient } from "./agentClient.js";
import { Alerter, mask, type OutgoingAlert, type Sender } from "./alerter.js";
import { ConsoleSender, PhotonSender, type Inbound } from "./photon.js";
import { WELCOME, approvalRequest, readingsSummary } from "./messages.js";
import { scrub } from "./safety.js";
import { LiveState } from "./state.js";
import { SubscriberStore, handleCommand, normalizePhone } from "./subscribers.js";

const env = process.env;
const WS_URL = env.GATEWAY_WS ?? "ws://localhost:8000/ws";
const BRIDGE_PORT = Number(env.BRIDGE_PORT ?? 8787);
const DRY_RUN = env.DRY_RUN === "1";

const phones = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => normalizePhone(s))
    .filter((s): s is string => !!s);
const seeded = phones(env.ALERT_NUMBERS);
// Who approves mass texts. Defaults to ALERT_NUMBERS so a one-phone demo still works.
const operators = phones(env.OPERATOR_NUMBERS).length ? phones(env.OPERATOR_NUMBERS) : seeded;
const store = new SubscriberStore(env.SUBSCRIBERS_FILE ?? "subscribers.json", seeded);
const state = new LiveState();

// Every text leaves through here, after the "never say safe" filter.
let raw: Sender;
let photon: PhotonSender | null = null;
if (DRY_RUN) {
  raw = new ConsoleSender();
  console.log("[clarity] DRY_RUN=1: printing texts. Type '<phone> <message>' to fake an inbound text.");
} else {
  photon = await PhotonSender.connect();
  raw = photon;
  console.log("[clarity] connected to Photon");
}
const sender: Sender = { send: (to, text) => raw.send(to, scrub(text)) };

let agentUp = false;
async function checkAgent(): Promise<void> {
  const was = agentUp;
  agentUp = await agentClient.health().then((h) => h.ok, () => false);
  if (agentUp !== was) console.log(`[clarity] agent at ${agentClient.url} is ${agentUp ? "up" : "DOWN (alerts go to operators only, replies are raw readings)"}`);
}
await checkAgent();
setInterval(() => void checkAgent(), 15_000).unref();

const textOps = (text: string) => Promise.all(operators.map((p) => sender.send(p, text)));

/** Mass alerts go to the agent: Gemini rewords the template, then an operator approves by text. */
async function dispatch(a: OutgoingAlert): Promise<void> {
  if (!agentUp) {
    // No agent means no approval step, so never mass-text: only operators get it.
    await textOps(`(Agent offline: sent to operators only)\n\n${a.text}`);
    return;
  }
  const res = await agentClient.alert({ alert_id: a.alertId, node: a.node, template: a.text, recipients: a.recipients });
  if (res.status === "pending_approval") {
    await textOps(approvalRequest(res.approval_id, a.recipients.length, a.node, res.preview));
  }
}

const alerter = new Alerter(sender, store, {
  minSeverity: env.MIN_SEVERITY === "unsafe" ? "unsafe" : "warning",
  cooldownMs: Number(env.ALERT_COOLDOWN_MIN ?? 10) * 60_000,
  decisionWaitMs: Number(env.DECISION_WAIT_SEC ?? 8) * 1000,
  includeSim: env.ALERT_ON_SIM === "1",
  remindAfterMs: Number(env.REMIND_AFTER_MIN ?? 15) * 60_000,
  dispatch,
  onSent: (to, text) => void agentClient.remember(to, text).catch(() => {}),
});
setInterval(() => void alerter.sendReminders(), 30_000).unref();

const ACK = /^(ok(ay)?|k|got it|seen|thanks?|thank you|done|👍|✅)[.!]*$/i;
const OP_CMD = /^(APPROVE|REJECT|EDIT)\s+#?(\d+)\s*([\s\S]*)$/i;

/** Every inbound message: operator approvals, commands, acknowledgements, photos, then the agent. */
async function onInbound(m: Inbound): Promise<string | null> {
  const phone = normalizePhone(m.phone);
  console.log(`[clarity] ← ${phone ? mask(phone) : `unrecognized sender "${m.phone}"`}: ${m.image ? "[photo]" : m.text}`);
  if (!phone) return null;
  const text = (m.text ?? "").trim();

  const op = text.match(OP_CMD);
  if (op && operators.includes(phone)) {
    const [, verb, id, rest] = op;
    const decision = verb.toLowerCase() as "approve" | "edit" | "reject";
    if (decision === "edit" && !rest.trim()) return `Send the new text after the number, like: EDIT ${id} Clarity alert: ...`;
    try {
      const r = await agentClient.decide(Number(id), decision, rest.trim() || undefined);
      return r.status === "sent" ? `✅ #${id} sent` : r.status === "rejected" ? `❌ #${id} rejected, nothing sent` : `#${id}: ${r.status}`;
    } catch {
      return `No pending approval #${id}`;
    }
  }

  if (m.image) {
    if (store.isNew(phone)) store.subscribe(phone, "*");
    const node = alerter.lastNodeFor(phone) ?? (store.list(phone).length === 1 && store.list(phone)[0] !== "*" ? store.list(phone)[0] : null);
    if (!agentUp) return "📷 Got your photo, but the assistant is offline. Try again in a bit.";
    try {
      return (await agentClient.photo({ phone, image_b64: m.image.b64, mime: m.image.mime, node, text })).reply;
    } catch (err) {
      console.error("[clarity] photo check failed:", (err as Error).message);
      return "📷 Got your photo, but I couldn't check it right now. Try again in a minute.";
    }
  }

  const ackNode = alerter.acknowledge(phone);
  const cmd = handleCommand(store, phone, text);
  if (cmd) return cmd;

  // First text ever: welcome them and turn on alerts (chatbot first, notifications built in).
  if (store.isNew(phone)) {
    store.subscribe(phone, "*");
    if (!text || /^(hi|hey|hello|yo|hiya|start|sup)\b/i.test(text)) return WELCOME;
    const answer = agentUp ? await agentClient.chat(phone, text).then((r) => r.reply, () => offlineReply()) : offlineReply();
    return `${WELCOME}\n\n────\n\n${answer}`;
  }
  if (ackNode && ACK.test(text)) {
    return `👍 Got it. I'll text you the retest result.`;
  }
  if (agentUp) {
    try {
      return (await agentClient.chat(phone, text)).reply;
    } catch (err) {
      console.error("[clarity] agent chat failed:", (err as Error).message);
    }
  }
  return offlineReply();
}

function offlineReply(): string {
  return readingsSummary([...state.latest.values()].filter((r) => !r.sim), state.filtered);
}

if (photon) {
  photon.listen(onInbound).catch((e) => console.error("[photon] listener stopped:", e));
} else {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const mm = line.match(/^(\S+)\s+(.+)$/);
    if (!mm) return;
    const reply = await onInbound({ phone: mm[1], text: mm[2] });
    if (reply) await sender.send(normalizePhone(mm[1]) ?? mm[1], reply);
  });
}

// ---- gateway frames (from /ws, or pushed to POST /events) ----
function onFrame(frame: { type?: string } & Record<string, unknown>): void {
  state.ingest(frame);
  void agentClient.event(frame).catch(() => {});
  alerter.handle(frame).catch((e) => console.error("[clarity]", e));
}

// ---- local HTTP: the agent sends approved alerts here; the gateway can push frames here ----
createServer(async (req, res) => {
  const body = await new Promise<string>((ok) => {
    let b = "";
    req.on("data", (c) => (b += c)).on("end", () => ok(b));
  });
  const reply = (code: number, obj: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
  try {
    if (req.method === "POST" && req.url === "/send") {
      const { to, text, alert_id } = JSON.parse(body) as { to: string[]; text: string; alert_id?: string };
      const sent = await alerter.deliver(alert_id ?? null, to, text);
      return reply(200, { sent: sent.length });
    }
    if (req.method === "POST" && req.url === "/events") {
      onFrame(JSON.parse(body));
      return reply(200, { ok: true });
    }
    reply(404, { error: "not found" });
  } catch (err) {
    reply(400, { error: (err as Error).message });
  }
}).listen(BRIDGE_PORT, "127.0.0.1", () => console.log(`[clarity] bridge on http://127.0.0.1:${BRIDGE_PORT}`));

console.log(`[clarity] ${seeded.length} alert number(s), ${operators.length} operator(s); gateway ${WS_URL}`);

let backoff = 1000;
function connect(): void {
  const ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    backoff = 1000;
    console.log("[clarity] connected to gateway");
  });
  ws.on("message", (buf) => {
    try {
      onFrame(JSON.parse(buf.toString()));
    } catch {
      /* ignore bad frames */
    }
  });
  ws.on("close", () => {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  ws.on("error", () => {});
}
connect();

async function shutdown(): Promise<void> {
  alerter.close();
  await photon?.stop();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
