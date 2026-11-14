/* One place that talks to the gateway and holds the current state, for any page.
   Live: same origin, or ?api=http://<pi>:8000. Falls back to demo data (demo.js) when no
   gateway answers, or with ?demo.

   const store = await TapStore.connect();
   store.on((type, payload) => ...)   // "reading" | "pour" | "filters" | "report" | "conn"
   store.nodes (Map), .feed [], .pour {before, after, decision}, .filters [], .report,
   .reference [], .tank, .health, .conn ("live" | "demo" | "down") */
(function () {
  "use strict";

  function liveSource(base) {
    const req = (path, init) => fetch(base + path, init).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status + " " + path))));
    return {
      kind: "live",
      get: (path) => req(path),
      post: (path) => req(path, { method: "POST" }),
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

  function pourFromPair(pair) {
    const before = pair.find((r) => r.phase === "before") || null;
    const after = pair.find((r) => r.phase === "after") || null;
    let decision = null;
    if (before && before.ai_filter) {
      decision = { ai_filter: before.ai_filter, explanation: before.explanation, source: before.explanation ? "claude" : "local_rule" };
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
    if (!source) { source = TapDemo.create(); health = await source.get("/health"); }

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
    const lastTank = readings.find((r) => r.node === s.tank) || s.nodes.get(s.tank)?.latest;
    if (lastTank) s.pour = pourFromPair(await soft(`/api/tests/${s.tank}/${lastTank.test}`, [lastTank]));

    source.subscribe((m) => {
      if (m.type === "reading") {
        const n = s.nodes.get(m.node) || { node: m.node, name: m.node, lat: m.lat, lon: m.lon, sim: m.sim };
        n.latest = m;
        s.nodes.set(m.node, n);
        s.feed.unshift(m);
        if (s.feed.length > 200) s.feed.length = 200;
        emit("reading", m);
        if (!m.sim && m.node === s.tank) {
          if (m.phase === "before") { s.pour = { before: m, after: null, decision: null }; emit("pour", "before"); }
          else if (s.pour?.before?.test === m.test) { s.pour.after = m; emit("pour", "after"); }
        }
      } else if (m.type === "decision") {
        const row = s.feed.find((r) => r.id === m.id);
        if (row) { row.ai_filter = m.ai_filter; row.explanation = m.explanation; }
        if (s.pour?.before?.id === m.id) { s.pour.decision = m; emit("pour", "decision"); }
      } else if (m.type === "filters") {
        s.filters = mergeFilters(m.filters || []);
        emit("filters");
      } else if (m.type === "report") {
        s.report = m;
        emit("report");
      }
    }, (kind) => { s.conn = kind; emit("conn"); });

    return s;
  }

  window.TapStore = { connect };
})();
