import { test } from "node:test";
import assert from "node:assert/strict";
import { Alerter } from "../src/alerter.js";
import { ConsoleSender } from "../src/photon.js";
import { SubscriberStore, handleCommand, normalizePhone } from "../src/subscribers.js";
import { assess, type Reading } from "../src/rules.js";

const R = (o: Partial<Reading>): Reading => ({
  id: 1, ts: "", node: "tank-01", name: "Princeton tank", test: 1, phase: "before", ph: 7.2, tds: 150,
  clarity: 0.95, verdict: "SAFE", filter: "NONE", ai_filter: null, sim: false, explanation: null, ...o,
});
const quiet = { log: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("assess severities", () => {
  assert.equal(assess(R({})).severity, "ok");
  assert.equal(assess(R({ tds: 420, verdict: "HIGH_TDS" })).severity, "warning");
  assert.equal(assess(R({ tds: 780, verdict: "HIGH_TDS" })).severity, "unsafe");
  assert.equal(assess(R({ ph: 9.1, verdict: "PH_WARN" })).severity, "unsafe");
  assert.equal(assess(R({ clarity: 0.3, verdict: "CLOUDY" })).severity, "warning");
  assert.equal(assess(R({ tds: 520, verdict: "SAFE" })).severity, "unsafe"); // limit wins over verdict
});

test("waits for Claude's decision and includes it", async () => {
  const s = new ConsoleSender();
  const a = new Alerter(s, new SubscriberStore(null, ["+15551234567"]), { ...quiet, decisionWaitMs: 1000 });
  await a.onReading(R({ id: 9, tds: 780, verdict: "HIGH_TDS", filter: "ZEROWATER" }));
  assert.equal(s.sent.length, 0);
  await a.onDecision({ type: "decision", id: 9, node: "tank-01", test: 1, phase: "before", ai_filter: "ZEROWATER", explanation: "Use ZeroWater.", source: "claude" });
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /Water alert/);
  assert.match(s.sent[0].text, /TDS 780 ppm/);
  assert.match(s.sent[0].text, /ZeroWater/);
  assert.match(s.sent[0].text, /ZeroWater/);
  a.close();
});

test("sends without decision after timeout", async () => {
  const s = new ConsoleSender();
  const a = new Alerter(s, new SubscriberStore(null, ["+15551234567"]), { ...quiet, decisionWaitMs: 20 });
  await a.onReading(R({ ph: 5.8, verdict: "PH_WARN" }));
  await sleep(50);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /pH 5\.8/);
});

test("cooldown suppresses repeats but not escalation", async () => {
  const s = new ConsoleSender();
  let t = 0;
  const a = new Alerter(s, new SubscriberStore(null, ["+15551234567"]), { ...quiet, now: () => t, cooldownMs: 60_000 });
  await a.onReading(R({ id: 1, test: 1, tds: 400, verdict: "HIGH_TDS", explanation: "x" }));
  await a.onReading(R({ id: 2, test: 2, tds: 410, verdict: "HIGH_TDS", explanation: "x" }));
  assert.equal(s.sent.length, 1);
  await a.onReading(R({ id: 3, test: 3, tds: 700, verdict: "HIGH_TDS", explanation: "x" })); // escalates
  assert.equal(s.sent.length, 2);
  t = 61_000;
  await a.onReading(R({ id: 4, test: 4, tds: 700, verdict: "HIGH_TDS", explanation: "x" }));
  assert.equal(s.sent.length, 3);
});

test("after retest: all clear and still-bad follow ups", async () => {
  const s = new ConsoleSender();
  const a = new Alerter(s, new SubscriberStore(null, ["+15551234567"]), quiet);
  await a.onReading(R({ test: 17, tds: 780, verdict: "HIGH_TDS", explanation: "x" }));
  await a.onReading(R({ test: 17, phase: "after", tds: 8, verdict: "SAFE", filter: "ZEROWATER" }));
  assert.match(s.sent[1].text, /within normal range/);
  assert.match(s.sent[1].text, /780 → 8 ppm with ZeroWater/);
  await a.onReading(R({ node: "x", test: 5, phase: "after", tds: 600, verdict: "HIGH_TDS", filter: "BRITA" }));
  assert.match(s.sent[2].text, /Still failing/);
  await a.onReading(R({ node: "y", test: 6, phase: "after", tds: 20, verdict: "SAFE" })); // nothing to follow up
  assert.equal(s.sent.length, 3);
});

test("simulated nodes skipped by default, tagged when enabled", async () => {
  const s = new ConsoleSender();
  const store = new SubscriberStore(null, ["+15551234567"]);
  await new Alerter(s, store, quiet).onReading(R({ sim: true, tds: 900, verdict: "HIGH_TDS", explanation: "x" }));
  assert.equal(s.sent.length, 0);
  await new Alerter(s, store, { ...quiet, includeSim: true }).onReading(R({ sim: true, tds: 900, verdict: "HIGH_TDS", explanation: "x" }));
  assert.match(s.sent[0].text, /\(simulated\)/);
});

test("opt-in by text: JOIN, per-node JOIN, STOP", () => {
  const st = new SubscriberStore(null);
  handleCommand(st, "+15550000001", "join");
  handleCommand(st, "+15550000002", "JOIN tap-02");
  assert.deepEqual(st.recipientsFor("tank-01"), ["+15550000001"]);
  assert.deepEqual(st.recipientsFor("tap-02").sort(), ["+15550000001", "+15550000002"]);
  handleCommand(st, "+15550000001", "STOP");
  assert.deepEqual(st.recipientsFor("tank-01"), []);
  assert.equal(normalizePhone("(609) 555-0123"), "+16095550123");

});

test("questions are not commands; STOP always is", () => {
  const st = new SubscriberStore(null);
  assert.equal(handleCommand(st, "+15550000001", "is my water safe to drink?"), null);
  assert.equal(handleCommand(st, "+15550000001", "hello"), null);
  assert.match(handleCommand(st, "+15550000001", "stop")!, /Unsubscribed/);
});

test("unacknowledged UNSAFE alert gets exactly one reminder; a reply cancels it", async () => {
  const s = new ConsoleSender();
  let t = 0;
  const a = new Alerter(s, new SubscriberStore(null, ["+15551111111", "+15552222222"]), { ...quiet, now: () => t, remindAfterMs: 60_000 });
  await a.onReading(R({ tds: 800, verdict: "HIGH_TDS", explanation: "x" }));
  assert.equal(s.sent.length, 2);
  assert.equal(a.acknowledge("+15551111111"), "tank-01");
  t = 61_000;
  await a.sendReminders();
  await a.sendReminders();
  const reminders = s.sent.filter((m) => /Reminder/.test(m.text));
  assert.deepEqual(reminders.map((m) => m.to), ["+15552222222"]);
});

test("never-say-safe filter", async () => {
  const { scrub, violates } = await import("../src/safety.js");
  for (const t of ["Your water is safe to drink.", "It's totally safe.", "verdict SAFE", "safe range"]) assert.ok(!violates(scrub(t)), t);
  assert.equal(scrub("The water is UNSAFE."), "The water is UNSAFE.");
});

test("dispatch hook receives alerts; deliver tracks acks only for failed tests", async () => {
  const s = new ConsoleSender();
  const got: any[] = [];
  const a = new Alerter(s, new SubscriberStore(null, ["+15551111111"]), { ...quiet, dispatch: async (x) => void got.push(x) });
  await a.onReading(R({ tds: 800, verdict: "HIGH_TDS", explanation: "x" }));
  assert.equal(got.length, 1);
  assert.equal(s.sent.length, 0); // nothing sent until approved
  await a.deliver(got[0].alertId, got[0].recipients, got[0].text);
  assert.equal(s.sent.length, 1);
  assert.equal(a.lastNodeFor("+15551111111"), "tank-01");
});

test("new texters are welcomed once; STOP is remembered", () => {
  const st = new SubscriberStore(null);
  assert.ok(st.isNew("+15550000009"));
  st.subscribe("+15550000009");
  assert.ok(!st.isNew("+15550000009"));
  handleCommand(st, "+15550000009", "STOP");
  assert.ok(!st.isNew("+15550000009")); // never auto-resubscribed
  assert.deepEqual(st.recipientsFor("tank-01"), []);
});

test("sender handles: iMessage prefixes and Apple ID emails", () => {
  assert.equal(normalizePhone("any;-;+17035550100"), "+17035550100");
  assert.equal(normalizePhone("Someone@iCloud.com"), "someone@icloud.com");
});

test("preset numbers can STOP, and STATUS shows them subscribed", () => {
  const store = new SubscriberStore(null, ["+15550001111"]);
  assert.match(handleCommand(store, "+15550001111", "STATUS")!, /all sites/);
  assert.deepEqual(store.recipientsFor("tank-01"), ["+15550001111"]);
  handleCommand(store, "+15550001111", "STOP");
  assert.deepEqual(store.recipientsFor("tank-01"), []);
  handleCommand(store, "+15550001111", "JOIN");
  assert.deepEqual(store.recipientsFor("tank-01"), ["+15550001111"]);
});

test("after-filter readings don't hide a failing tap", async () => {
  const { LiveState } = await import("../src/state.js");
  const { readingsSummary } = await import("../src/messages.js");
  const s = new LiveState();
  s.ingest({ type: "reading", ...R({ tds: 780, verdict: "HIGH_TDS" }) });
  s.ingest({ type: "reading", ...R({ id: 2, tds: 8, phase: "after" }) });
  const out = readingsSummary([...s.latest.values()], s.filtered);
  assert.match(out, /🚨 .*TDS 780/);
  assert.match(out, /filtered: TDS 8 ✓/);
});
