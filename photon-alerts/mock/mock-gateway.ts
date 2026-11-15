// Fake gateway: serves ws://localhost:8000/ws and plays a scripted demo using Jim's frame shapes.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8000);
const played: any[] = []; // readings sent so far, served by the REST endpoints

// REST endpoints in the agreed shapes, so the agent's tools have data during the demo.
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  const readings = played.filter((f) => f.type === "reading");
  if (url.pathname === "/api/nodes") {
    const latest = new Map<string, any>();
    for (const r of readings) latest.set(r.node, r);
    return json([...latest.values()].map((r) => ({ node: r.node, name: r.name, lat: r.lat, lon: r.lon, sim: r.sim, latest: r })));
  }
  if (url.pathname === "/api/readings") {
    const node = url.searchParams.get("node");
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return json(readings.filter((r) => !node || r.node === node).reverse().slice(0, limit));
  }
  if (url.pathname === "/api/filters") {
    return json([
      { filter: "ZEROWATER", liters: 3.2, last_after_tds: 8, status: "OK" },
      { filter: "BRITA", liters: 431, last_after_tds: 190, status: "REPLACE_SOON" },
    ]);
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server: http, path: "/ws" });
http.listen(PORT);

const base = { ts: "", rssi: -61, lat: 40.3467, lon: -74.6553, anomaly: 0.42, explanation: null, ai_filter: null };
const script: [number, object][] = [
  // 1. Contaminated "before" on the real tank, then Claude's decision
  [500, { ...base, type: "reading", id: 41, node: "tank-01", name: "Clarity tank", test: 17, phase: "before", ph: 7.21, tds: 780, clarity: 0.83, verdict: "HIGH_TDS", filter: "ZEROWATER", sim: false }],
  [2500, { type: "decision", id: 41, node: "tank-01", test: 17, phase: "before", ai_filter: "ZEROWATER", explanation: "TDS is 780 ppm, well above the EPA 500 ppm limit. ZeroWater's 5-stage ion-exchange filter is the right pick for dissolved solids; Brita won't bring it down enough.", source: "claude" }],
  // 2. Simulated node goes bad (ignored unless ALERT_ON_SIM=1)
  [1000, { ...base, type: "reading", id: 42, node: "sim-03", name: "Rocky Hill", test: 4, phase: "before", ph: 6.1, tds: 220, clarity: 0.9, verdict: "PH_WARN", filter: "BRITA", sim: true }],
  // 3. Same tank again within cooldown: suppressed
  [1000, { ...base, type: "reading", id: 43, node: "tank-01", name: "Clarity tank", test: 18, phase: "before", ph: 7.2, tds: 760, clarity: 0.84, verdict: "HIGH_TDS", filter: "ZEROWATER", sim: false }],
  // 4. After-filter retest of test 17: all clear
  [1000, { ...base, type: "reading", id: 44, node: "tank-01", name: "Clarity tank", test: 17, phase: "after", ph: 7.0, tds: 8, clarity: 0.98, verdict: "SAFE", filter: "ZEROWATER", sim: false }],
  // 5. A safe reading: no text
  [1000, { ...base, type: "reading", id: 45, node: "tap-02", name: "Nassau St tap", test: 3, phase: "before", ph: 7.4, tds: 140, clarity: 0.97, verdict: "SAFE", filter: "NONE", sim: false }],
  // Investigator report after the retest
  [500, { type: "report", node: "tank-01", test: 17, summary: "High TDS at the tank matches Stony Brook's USGS conductance; ZeroWater brought it to 8 ppm. Cartridge has ~37 L left.", findings: ["TDS 780 before, 8 after"], actions: ["Keep using ZeroWater", "Replace cartridge after ~37 L"] }],
  // 6. pH problem with no decision arriving: alert goes out after DECISION_WAIT_SEC
  [1000, { ...base, type: "reading", id: 46, node: "tap-02", name: "Nassau St tap", test: 4, phase: "before", ph: 5.9, tds: 160, clarity: 0.95, verdict: "PH_WARN", filter: "NONE", sim: false }],
];

wss.on("connection", async (ws) => {
  console.log("[mock-gateway] client connected, playing demo script");
  for (const [delay, frame] of script) {
    await new Promise((r) => setTimeout(r, delay));
    if (ws.readyState !== ws.OPEN) return;
    const out = { ...frame, ts: new Date().toISOString() };
    played.push(out);
    ws.send(JSON.stringify(out));
    console.log(`[mock-gateway] -> ${(frame as any).type} ${(frame as any).node} id=${(frame as any).id}`);
  }
  console.log("[mock-gateway] script done");
});
console.log(`[mock-gateway] ws://localhost:${PORT}/ws`);
