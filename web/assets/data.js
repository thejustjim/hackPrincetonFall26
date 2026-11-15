/* One place that talks to the gateway and holds the current state, for any page.
   Live: same origin, or ?api=http://<pi>:8000. Falls back to sample data (sample.js) when no
   gateway answers, or with ?demo. Sample decisions and reports carry source "sample", never a model's name.

   const store = await TapStore.connect();
   store.on((type, payload) => ...)   // "reading" | "pour" | "filters" | "report" | "conn"
   store.nodes (Map), .feed [], .pour {before, after, decision}, .filters [], .report,
   .reference [], .tank, .health, .conn ("live" | "demo" | "down"), .history [], .pours() */
(function () {
  "use strict";

  function liveSource(base) {
    const req = (path, init) => fetch(base + path, init).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status + " " + path))));
    return {
      kind: "live",
      get: (path) => req(path),
      /* Controls (reset a filter, tip the cup) are guarded by the gateway. If it asks for its
         control token, ask the person once and remember it on this device. */
      async post(path) {
        const KEY = "clarity-control-token";
        const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
        const send = () => fetch(base + path, { method: "POST", headers: read() ? { "X-Clarity-Token": read() } : {} });
        let r = await send();
        if (r.status === 401) {
          const token = prompt("This gateway needs its control token for that (CONTROL_TOKEN in its .env file).\nEnter the control token:");
          if (!token) throw new Error("the control token is needed");
          try { localStorage.setItem(KEY, token.trim()); } catch { /* private window: ask again next time */ }
          r = await send();
          if (r.status === 401) { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } throw new Error("that control token was not accepted"); }
        }
        if (r.status === 403) throw new Error("controls only work on the gateway's own machine until CONTROL_TOKEN is set in its .env file");
        if (!r.ok) throw new Error(r.status + " " + path);
        return r.json();
      },
      subscribe(onMessage, onStatus) {
        const origin = base ? new URL(base) : location;
        const url = (origin.protocol === "https:" ? "wss://" : "ws://") + origin.host + "/ws";
        let wait = 1000;
        const open = () => {
          const ws = new WebSocket(url);
          ws.onopen = () => { wait = 1000; onStatus("live"); };
          ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
          ws.onclose = () => { onStatus("down"); setTimeout(open, wait); wait = Math.min(wait * 2, 15000); };
        };
        open();
      },
    };
  }

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

  let aiName = null;   // the model the gateway says it is using ("Gemini" or "Claude"), once known
  function pourFromPair(pair, kind) {
    const before = pair.find((r) => r.phase === "before") || null;
    const after = pair.find((r) => r.phase === "after") || null;
    let decision = null;
    if (before && before.ai_filter) {
      decision = { ai_filter: before.ai_filter, explanation: before.explanation, source: before.source || (!before.explanation ? "local_rule" : kind === "demo" ? "sample" : (aiName || "Claude").toLowerCase()) };
    }
    return { before, after, decision };
  }

  async function connect() {
    const params = new URLSearchParams(location.search);
    const api = params.get("api");
    const base = api ? api.replace(/\/$/, "") : location.protocol.startsWith("http") ? "" : null;
    let source = null, health = {};
    if (!params.has("demo") && base !== null) {
      try {
        const live = liveSource(base);
        health = await withTimeout(live.get("/health"), 2500);
        source = live;
      } catch { /* no gateway: demo */ }
    }
    if (!source) { source = TapSample.create(); health = await source.get("/health"); }
    aiName = health.ai_name || null;

    const s = { kind: source.kind, conn: source.kind === "live" ? "live" : "demo", health,
                nodes: new Map(), feed: [], pour: null, filters: [], report: null, reference: [], tank: "tank-01" };
    const subs = new Set();
    const emit = (type, payload) => subs.forEach((fn) => { try { fn(type, payload); } catch (err) { console.error(err); } });
    s.on = (fn) => { subs.add(fn); return () => subs.delete(fn); };

    const keyOf = (f) => `${f.node || ""}:${f.filter}`;
    function mergeFilters(list) {            // the replace endpoint returns one tank's filters
      const fresh = new Map(list.map((f) => [keyOf(f), f]));
      const out = s.filters.map((f) => fresh.get(keyOf(f)) || f);
      list.forEach((f) => { if (!out.some((o) => keyOf(o) === keyOf(f))) out.push(f); });
      return out;
    }
    s.replaceFilter = async (key) => {
      const list = await source.post(`/api/filters/${key.toLowerCase()}/replace`);
      if (Array.isArray(list)) { s.filters = mergeFilters(list); emit("filters"); }
    };
    s.isSim = (r) => r.sim ?? s.nodes.get(r.node)?.sim ?? false;
    s.get = (path) => source.get(path);                       // anything else the gateway can be asked (the cloud rollup)
    s.refreshHealth = () => source.get("/health").then((h) => { s.health = h; aiName = h.ai_name || null; }).catch(() => {});   // e.g. the cloud copy's counts
    s.nodeName = (id) => s.nodes.get(id)?.name || id;

    const soft = (p, fallback) => source.get(p).catch(() => fallback);
    const [nodes, readings, reference, filters, reports] = await Promise.all([
      soft("/api/nodes", []), soft("/api/readings?limit=60", []), soft("/api/reference", []),
      soft("/api/filters", []), soft("/api/reports?limit=1", []),
    ]);
    nodes.forEach((n) => s.nodes.set(n.node, n));
    s.tank = (nodes.find((n) => !n.sim) || {}).node || "tank-01";
    s.feed = readings;
    s.reference = Array.isArray(reference) ? reference : [];
    s.filters = filters;
    s.report = reports[0] || null;
    s.history = (await soft(`/api/readings?node=${encodeURIComponent(s.tank)}&limit=80`, [])).slice().reverse();   // this tank's readings, oldest first
    /* this tank's pours, oldest first: [{test, before, after}] */
    s.pours = () => {
      const out = [];
      for (const r of s.history) {
        if (r.phase === "before") out.push({ test: r.test, before: r, after: null });
        else { const p = [...out].reverse().find((x) => x.test === r.test && !x.after); if (p) p.after = r; }
      }
      return out;
    };
    const lastTank = readings.find((r) => r.node === s.tank) || s.nodes.get(s.tank)?.latest;
    if (lastTank) s.pour = pourFromPair(await soft(`/api/tests/${s.tank}/${lastTank.test}`, [lastTank]), source.kind);

    source.subscribe((m) => {
      if (m.type === "reading") {
        const n = s.nodes.get(m.node) || { node: m.node, name: m.node, lat: m.lat, lon: m.lon, sim: m.sim };
        n.latest = m;
        s.nodes.set(m.node, n);
        s.feed.unshift(m);
        if (s.feed.length > 200) s.feed.length = 200;
        if (m.node === s.tank) { s.history.push(m); if (s.history.length > 200) s.history.shift(); }
        emit("reading", m);
        if (!m.sim && m.node === s.tank) {
          if (m.phase === "before") { s.pour = { before: m, after: null, decision: null }; emit("pour", "before"); }
          else if (s.pour?.before?.test === m.test) { s.pour.after = m; emit("pour", "after"); }
        }
      } else if (m.type === "decision") {
        const row = s.feed.find((r) => r.id === m.id);
        if (row) { row.ai_filter = m.ai_filter; row.explanation = m.explanation; }
      const past = s.history.find((r) => r.id === m.id);
      if (past && past !== row) { past.ai_filter = m.ai_filter; past.explanation = m.explanation; }
        if (s.pour?.before?.id === m.id) { s.pour.decision = m; emit("pour", "decision"); }
      } else if (m.type === "filters") {
        s.filters = mergeFilters(m.filters || []);
        emit("filters");
      } else if (m.type === "report") {
        s.report = m;
        emit("report");
      } else if (m.type === "agent") {
        // the investigator at work: the plan first, then each hand-off, tool call and answer as it happens
        if (m.event === "plan") {
          s.swarm = { test: m.test, state: "working", check: null,
                      rows: new Map((m.plan || []).map((x) => [x.agent, { agent: x.agent, why: x.why, tools: [], state: "waiting" }])) };
        } else if (s.swarm) {
          let row = m.agent ? s.swarm.rows.get(m.agent) : null;
          if (m.agent && !row) s.swarm.rows.set(m.agent, (row = { agent: m.agent, why: "added by the lead", tools: [], state: "waiting" }));
          if (m.event === "asked" && row) row.state = "asked";
          else if (m.event === "tool" && row) { row.state = "working"; row.tools.push(m.tool); }
          else if (m.event === "answered" && row) row.state = "answered";
          else if (m.event === "check") { s.swarm.state = "checking"; s.swarm.check = m.check; }
          else if (m.event === "failed" || m.event === "done") s.swarm.state = m.event;
        }
        emit("swarm");
      }
    }, (kind) => { s.conn = kind; emit("conn"); });

    return s;
  }

  window.TapStore = { connect };
})();
