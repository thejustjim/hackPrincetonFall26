const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function sample(seed) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "assets/sample.js"), "utf8"), {
    window, location: { search: "" }, URL, URLSearchParams, Math, Date,
    setTimeout() {}, setInterval() {},
  });
  return window.TapSample.create({ seed });
}
const profile = rows => JSON.parse(JSON.stringify(rows.map(({ node, test, phase, ph, ph_est, tds, clarity }) =>
  ({ node, test, phase, ph, ph_est, tds, clarity }))));

test("sample seed reproduces readings and a different seed changes them", async () => {
  const a = await sample(26).get("/api/readings?limit=1000");
  const b = await sample(26).get("/api/readings?limit=1000");
  const c = await sample(27).get("/api/readings?limit=1000");
  assert.deepEqual(profile(a), profile(b));
  assert.notDeepEqual(profile(a), profile(c));
});

test("tank estimates and independently simulated peer pH retain separate provenance", async () => {
  const rows = await sample(26).get("/api/readings?limit=1000");
  const tank = rows.filter(r => r.node === "tank-01");
  assert.ok(tank.length > 0 && rows.some(r => r.sim));
  for (const r of tank) {
    assert.equal(r.ph_est, true);
    assert.ok(Math.abs(r.ph - Math.max(7, Math.min(8.3, 7 + (r.tds - 150) * 1.3 / 650))) < 0.02);
  }
  assert.ok(rows.filter(r => r.sim).every(r => r.ph_est === false));
});

test("sample reports exclude estimated pH from independent evidence", async () => {
  const api = sample(26);
  for (const report of await api.get("/api/reports")) {
    assert.notEqual(report.checks.lead.metric, "ph");
    assert.deepEqual(JSON.parse(JSON.stringify(report.checks.measured_metrics)), ["tds", "clarity"]);
    assert.equal(report.checks.baseline.find(r => r.metric === "ph").included, false);
    assert.doesNotMatch(report.notice, /pH.*read in range/);
  }
  assert.equal((await api.get("/health")).simulation_seed, 26);
});


test("live replay cannot attach an old-boot retest to a new-boot cup", async () => {
  const base = { node: "tank-01", test: 5, phase: "before", ph: 7, ph_est: true, tds: 780, clarity: 0.95, verdict: "HIGH_TDS", filter: "ZEROWATER", sim: false, ts: "2026-11-15T01:00:00Z" };
  const old = { ...base, id: 1, session: "bootA", seq: 0 };
  const current = { ...base, id: 2, session: "bootB", seq: 0 };
  const history = [current, old];
  const window = {};
  let socket;
  class Socket { constructor() { socket = this; } }
  const fetch = async url => {
    const u = new URL(url, "http://local.test");
    let body = [];
    if (u.pathname === "/health") body = { ph_estimated: true };
    else if (u.pathname === "/api/nodes") body = [{ node: "tank-01", sim: false, latest: current }];
    else if (u.pathname === "/api/readings") body = history;
    else if (u.pathname === "/api/tests/tank-01/5") body = [current];
    return { ok: true, json: async () => body };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "assets/data.js"), "utf8"), {
    window, location: { protocol: "http:", host: "local.test", search: "" },
    URL, URLSearchParams, fetch, WebSocket: Socket, setTimeout() {}, console,
  });
  const store = await window.TapStore.connect();
  const late = { ...base, id: 3, session: "bootA", seq: 1, phase: "after", tds: 4, verdict: "SAFE" };
  socket.onmessage({ data: JSON.stringify({ type: "reading", ...late }) });
  assert.equal(store.pour.before.session, "bootB");
  assert.equal(store.pour.after, null);
  assert.equal(store.pours().find(p => p.before.session === "bootA").after.id, 3);
  const count = store.feed.length;
  socket.onmessage({ data: JSON.stringify({ type: "reading", ...late }) });
  assert.equal(store.feed.length, count);
  const after = { ...late, id: 4, session: "bootB" };
  socket.onmessage({ data: JSON.stringify({ type: "reading", ...after }) });
  assert.equal(store.pour.after.id, 4);
});


test("prototype mode never substitutes sample readings for missing hardware", async () => {
  for (const mockedGateway of [false, true]) {
    const window = {
      ClaritySetup: { read: () => ({ mode: "prototype", location: { name: "Princeton" } }) },
      TapSample: { create: () => { throw new Error("Sample fallback is forbidden for prototype mode"); } },
    };
    const fetch = async () => {
      if (!mockedGateway) throw new Error("No gateway");
      return { ok: true, json: async () => ({ mock: true }) };
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "assets/data.js"), "utf8"), {
      window, location: { protocol: "http:", host: "local.test", search: "?mode=prototype" },
      URL, URLSearchParams, fetch, setTimeout() {}, console,
    });
    const store = await window.TapStore.connect();
    assert.equal(store.kind, "offline");
    assert.equal(store.conn, "offline");
    assert.equal(store.feed.length, 0);
    assert.equal(store.pour, null);
    assert.match(store.health.prototype_reason, mockedGateway ? /simulation/ : /unavailable/);
  }
});


test("a prototype reconnect cannot admit readings from a gateway restarted in mock mode", async () => {
  const window = {};
  let mock = false;
  const sockets = [], timers = [];
  class Socket {
    constructor() { sockets.push(this); }
    close() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
  }
  const fetch = async url => ({ ok: true, json: async () => new URL(url, "http://local.test").pathname === "/health" ? { mock } : [] });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "assets/data.js"), "utf8"), {
    window, location: { protocol: "http:", host: "local.test", search: "?mode=prototype" },
    URL, URLSearchParams, fetch, WebSocket: Socket, setTimeout: fn => timers.push(fn), console,
  });
  const store = await window.TapStore.connect();
  await sockets[0].onopen();
  assert.equal(store.conn, "live");
  sockets[0].close();
  mock = true;
  timers[timers.length - 1]();
  const reconnected = sockets[sockets.length - 1];
  await reconnected.onopen();
  reconnected.onmessage({ data: JSON.stringify({ type: "reading", id: 99, node: "tank-01", phase: "before", test: 1, tds: 900, ph: 7, clarity: 1, sim: false }) });
  assert.equal(store.conn, "offline");
  assert.equal(store.feed.length, 0);
  assert.equal(store.pour, null);
});
