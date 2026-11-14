/* TapTest dashboard. Talks to the gateway (same origin, or ?api=http://<pi>:8000);
   falls back to demo data when there is no gateway, or with ?demo. */
(function () {
  "use strict";
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const FILTER_NAME = { ZEROWATER: "ZeroWater", BRITA: "Brita Elite", NONE: "No filter" };
  const VERDICT = {
    SAFE: ["Safe", "v-safe", "--accent"],
    HIGH_TDS: ["High dissolved solids", "v-tds", "--warn"],
    CLOUDY: ["Cloudy", "v-cloudy", "--warn"],
    PH_WARN: ["pH out of range", "v-ph", "--warn"],
  };
  const STATUS = { OK: ["Fine", "s-ok"], REPLACE_SOON: ["Replace soon", "s-soon"], REPLACE: ["Replace now", "s-now"] };

  const state = { nodes: new Map(), feed: [], pour: null, filters: [], report: null, reference: [], tank: "tank-01", health: {} };
  let source = null;

  // ------------------------------------------------------------ data sources
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

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  }

  function setConn(kind) {
    const el = $("#conn");
    el.dataset.state = kind;
    $("#conn-text").textContent = {
      live: state.health.ai ? "Live from the gateway, Claude on" : "Live from the gateway, local rule only (no Anthropic key)",
      down: "Lost the gateway, reconnecting",
      demo: "Demo data: no gateway reachable",
    }[kind] || "Connecting to the gateway";
  }

  // ------------------------------------------------------------ helpers
  function ago(ts) {
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 45) return "just now";
    if (s < 90) return "a minute ago";
    if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
    if (s < 5400) return "an hour ago";
    if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
    return new Date(ts).toLocaleDateString();
  }
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const nodeName = (id) => state.nodes.get(id)?.name || id;
  const chip = (v) => { const [label, cls] = VERDICT[v] || [v, ""]; return `<p class="chip ${cls}">${esc(label)}</p>`; };
  const fmt = (v, d) => (v == null ? "–" : Number(v).toFixed(d));

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  // ------------------------------------------------------------ latest pour
  function pourFromPair(pair) {
    const before = pair.find((r) => r.phase === "before") || null;
    const after = pair.find((r) => r.phase === "after") || null;
    let decision = null;
    if (before && before.ai_filter) {
      decision = { ai_filter: before.ai_filter, explanation: before.explanation, source: before.explanation ? "claude" : "local_rule" };
    }
    return { before, after, decision, afterNote: after?.explanation || null };
  }

  function cupFigure(r, phaseLabel, emptyText, rise) {
    if (!r) {
      return `${TapCup.svg(null, { emptyLabel: emptyText })}<figcaption><p class="phase">${phaseLabel}</p><p class="empty-note">${emptyText}</p></figcaption>`;
    }
    return `${TapCup.svg(r, { rise })}
      <figcaption>
        <p class="phase">${phaseLabel}, ${esc(clock(r.ts))}</p>
        <p class="big num">${r.tds}<span class="unit">ppm</span></p>
        <dl class="mini"><div><dt>pH</dt><dd>${fmt(r.ph, 1)}</dd></div><div><dt>Clarity</dt><dd>${fmt(r.clarity, 2)}</dd></div></dl>
        ${chip(r.verdict)}
      </figcaption>`;
  }

  function pct(a, b) {   // percent drop from b to a; never rounds a partial drop up to 100
    if (!b) return 0;
    const v = (100 * (b - a)) / b;
    return v > 0 ? Math.min(Math.round(v), a > 0 ? 99 : 100) : Math.round(v);
  }

  function renderPour(rise = false) {
    const p = state.pour;
    $("#pour-meta").textContent = p?.before ? `${nodeName(p.before.node)}, pour ${p.before.test}, ${ago(p.before.ts)}` : "";
    if (!p || !p.before) {
      $("#before").innerHTML = cupFigure(null, "Before", "Pour a cup into the tank and press its button.");
      $("#decision").innerHTML = `<p class="quiet">The tank measures pH, dissolved solids and clarity, then picks a filter.</p>`;
      $("#after").innerHTML = cupFigure(null, "After", "The retest shows up here.");
      return;
    }
    const { before, after, decision } = p;
    $("#before").innerHTML = cupFigure(before, "Before", "");

    let d;
    if (!decision) {
      d = `<div class="flow idle"><span class="line"></span><b class="deciding">Choosing a filter</b><span class="line"></span><svg viewBox="0 0 12 14" aria-hidden="true"><path d="M0 0 L12 7 L0 14Z"/></svg></div>`;
    } else {
      const f = decision.ai_filter;
      const who = decision.source === "claude" ? "Claude" : "the tank's own rule";
      const head = f === "NONE"
        ? (before.verdict === "SAFE" ? "No filter needed" : "No filter helps here")
        : `Tipped into ${FILTER_NAME[f] || f}`;
      d = `<div class="flow${f === "NONE" ? " idle" : ""}"><span class="line"></span><b>${esc(FILTER_NAME[f] || f)}</b><span class="line"></span><svg viewBox="0 0 12 14" aria-hidden="true"><path d="M0 0 L12 7 L0 14Z"/></svg></div>
        <h2>${esc(head)} <span class="who">by ${who}</span></h2>
        ${decision.explanation ? `<p class="why">${esc(decision.explanation)}</p>` : `<p class="quiet">No AI explanation for this pour: the tank used its built-in thresholds.</p>`}`;
    }
    if (after) {
      const tdsDrop = pct(after.tds, before.tds);
      d += `<ul class="delta">
        <li>Dissolved solids <strong>${before.tds} → ${after.tds} ppm</strong> <span class="${tdsDrop >= 0 ? "better" : "worse"}">${tdsDrop >= 0 ? `down ${tdsDrop}%` : `up ${-tdsDrop}%`}</span></li>
        <li>Clarity <strong>${fmt(before.clarity, 2)} → ${fmt(after.clarity, 2)}</strong></li>
        <li>pH <strong>${fmt(before.ph, 1)} → ${fmt(after.ph, 1)}</strong></li>
      </ul>`;
    }
    $("#decision").innerHTML = d;

    const noFilter = decision && decision.ai_filter === "NONE";
    $("#after").innerHTML = after
      ? cupFigure(after, "After", "", rise)
      : cupFigure(null, "After", noFilter ? "No filter ran for this pour, so there is nothing to retest." : "Waiting for the retest: pour the filtered water back and press the button.");
  }

  // ------------------------------------------------------------ map
  let map = null;
  const markers = new Map();
  function initMap() {
    if (!window.L) { $("#map").innerHTML = `<p class="map-off">The map library didn't load. Readings below still update.</p>`; return; }
    map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.25 }).setView([40.35, -74.655], 12);
    // Esri dark gray canvas: no API key needed
    const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
    L.tileLayer(esri + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 16, attribution: "Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors",
    }).addTo(map);
    L.tileLayer(esri + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16 }).addTo(map);
    // the map stretches with the filters + report column, so tell Leaflet when its box changes
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($("#map"));
  }

  function popupFor(n) {
    const r = n.latest;
    const kind = n.sim ? "Simulated node" : "Measured by a TapTest";
    if (!r) return `<b>${esc(n.name)}</b><br><span class="pop-meta">${kind}. No readings yet.</span>`;
    return `<b>${esc(n.name)}</b><br><span class="pop-meta">${kind}, ${esc(ago(r.ts))}</span><br>
      ${r.tds} ppm, pH ${fmt(r.ph, 1)}, clarity ${fmt(r.clarity, 2)}<br>${esc((VERDICT[r.verdict] || [r.verdict])[0])}${r.anomaly >= 0.6 ? ", unusual for this site" : ""}`;
  }

  function placeNode(n) {
    if (!map || n.lat == null) return;
    const v = n.latest ? VERDICT[n.latest.verdict] : null;
    const color = v ? css(v[2]) : css("--neutral");
    const unusual = n.latest && n.latest.anomaly >= 0.6;
    const style = n.sim
      ? { radius: 7, color: unusual ? css("--alert") : css("--neutral"), weight: 2, dashArray: "3 3", fillColor: color, fillOpacity: 0.35 }
      : { radius: 11, color: unusual ? css("--alert") : css("--text"), weight: 2, fillColor: color, fillOpacity: 0.95 };
    let m = markers.get(n.node);
    if (!m) {
      m = L.circleMarker([n.lat, n.lon], style).addTo(map);
      m.bindTooltip(n.sim ? `${n.name} (simulated)` : n.name, { direction: "top", offset: [0, -8], permanent: !n.sim });
      markers.set(n.node, m);
    } else m.setStyle(style);
    m.bindPopup(popupFor(n));
    if (!n.sim) m.bringToFront();
  }

  function placeReference() {
    if (!map) return;
    state.reference.forEach((s) => {
      const icon = L.divIcon({ className: "", html: '<div class="ref-pin"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
      const year = String(s.date || "").slice(0, 4);
      L.marker([s.lat, s.lon], { icon, keyboard: true, title: s.site }).addTo(map)
        .bindTooltip(`${s.site}: ~${s.tds_est} ppm (${s.source}, ${year})`, { direction: "top", offset: [0, -8] })
        .bindPopup(`<b>${esc(s.site)}</b><br><span class="pop-meta">Published by ${esc(s.source)}, sampled ${esc(s.date)}</span><br>
          About ${s.tds_est} ppm dissolved solids, estimated from conductance.${s.typical_tds_est ? `<br>Typical recently: about ${s.typical_tds_est} ppm.` : ""}`);
    });
  }

  function fitMap() {
    if (!map) return;
    const pts = [...state.nodes.values()].filter((n) => n.lat != null).map((n) => [n.lat, n.lon])
      .concat(state.reference.map((s) => [s.lat, s.lon]));
    if (pts.length > 1) map.fitBounds(pts, { padding: [24, 24] });
  }

  // ------------------------------------------------------------ filters
  function renderFilters() {
    const list = state.filters;
    if (!list.length) { $("#filters").innerHTML = `<p class="quiet">No filter data yet. It starts with the first tip.</p>`; return; }
    $("#filters").innerHTML = list.map((f) => {
      const [label, cls] = STATUS[f.status] || [f.status, ""];
      const name = f.name || FILTER_NAME[f.filter] || f.filter;
      let meter;
      if (f.filter === "ZEROWATER") {
        const limit = f.replace_at_tds || 6;
        const last = f.last_after_tds;
        const w = last == null ? 0 : Math.min(100, (last / 10) * 100);
        meter = `<div class="meter ${cls}" role="img" aria-label="Last retest ${last ?? "none"} ppm, replace at ${limit} ppm"><span style="width:${w}%"></span><i style="left:${(limit / 10) * 100}%"></i></div>
          <p class="meter-note">${last == null ? "No retest yet." : `Last retest read ${last} ppm.`} Replace at ${limit} ppm, ZeroWater's own rule.</p>`;
      } else {
        const rated = f.rated_liters || 450;
        const w = Math.min(100, (f.liters / rated) * 100);
        meter = `<div class="meter ${cls}" role="img" aria-label="${f.liters} of about ${rated} liters used"><span style="width:${w}%"></span></div>
          <p class="meter-note">${Math.max(0, rated - f.liters).toFixed(1)} L left of about ${rated} L.</p>`;
      }
      return `<div class="filter">
        <div class="filter-head"><h3>${esc(name)}</h3><p class="chip ${cls}">${esc(label)}</p></div>
        <p class="liters"><span class="num">${fmt(f.liters, 1)}</span>L filtered</p>
        ${meter}
        <button class="btn" type="button" data-replace="${esc(f.filter)}">Mark as replaced</button>
      </div>`;
    }).join("");
  }

  $("#filters").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-replace]");
    if (!btn) return;
    const key = btn.dataset.replace;
    const name = FILTER_NAME[key] || key;
    if (!confirm(`Mark ${name} as replaced? Its liters and status start over.`)) return;
    try {
      const list = await source.post(`/api/filters/${key.toLowerCase()}/replace`);
      if (Array.isArray(list)) { state.filters = mergeFilters(list); renderFilters(); }
      toast(`Marked ${name} as replaced`);
    } catch (err) {
      toast(`Couldn't mark ${name} as replaced: ${err.message}`);
    }
  });

  function mergeFilters(list) {   // replace endpoint returns one tank's filters
    const keyOf = (f) => `${f.node || ""}:${f.filter}`;
    const fresh = new Map(list.map((f) => [keyOf(f), f]));
    const out = state.filters.map((f) => fresh.get(keyOf(f)) || f);
    list.forEach((f) => { if (!out.some((o) => keyOf(o) === keyOf(f))) out.push(f); });
    return out;
  }

  // ------------------------------------------------------------ investigator
  function renderReport() {
    const r = state.report;
    if (!r) {
      $("#report").innerHTML = state.health.investigator
        ? `<p class="quiet">The investigator writes a report after each retest: what changed, how this site compares, and what to do next.</p>`
        : `<p class="quiet">Reports appear after each retest once the gateway has an Anthropic key. Add it to .env and restart the gateway.</p>`;
      return;
    }
    $("#report").innerHTML = `
      <p class="report-meta">${esc(nodeName(r.node))}, pour ${esc(r.test)}${r.filter ? `, ${esc(FILTER_NAME[r.filter] || r.filter)} run` : ""}${r.ts ? `, ${esc(ago(r.ts))}` : ""}</p>
      <p class="report-summary">${esc(r.summary)}</p>
      ${r.findings?.length ? `<h3>Findings</h3><ul>${r.findings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${r.actions?.length ? `<h3>What to do next</h3><ol>${r.actions.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}`;
  }

  // ------------------------------------------------------------ feed
  function rowHTML(r, fresh) {
    const n = state.nodes.get(r.node);
    const sim = r.sim ?? n?.sim;
    return `<tr class="${fresh ? "fresh" : ""}" data-sim="${sim ? 1 : 0}">
      <td>${esc(clock(r.ts))}</td>
      <td class="site">${esc(nodeName(r.node))}${sim ? '<span class="tag-sim">sim</span>' : ""}</td>
      <td>${r.phase === "after" ? `<span class="retest">${esc(r.test)}, retest</span>` : esc(r.test)}</td>
      <td class="n">${fmt(r.ph, 2)}</td>
      <td class="n">${esc(r.tds)}</td>
      <td class="n">${fmt(r.clarity, 2)}</td>
      <td>${esc((VERDICT[r.verdict] || [r.verdict])[0])}</td>
      <td class="n${r.anomaly >= 0.6 ? " high" : ""}">${fmt(r.anomaly, 2)}</td>
    </tr>`;
  }

  function renderFeed(freshId) {
    const showSim = $("#show-sim").checked;
    $("#feed").innerHTML = state.feed
      .filter((r) => showSim || !(r.sim ?? state.nodes.get(r.node)?.sim))
      .slice(0, 40)
      .map((r) => rowHTML(r, r.id === freshId))
      .join("");
  }
  $("#show-sim").addEventListener("change", () => renderFeed());

  // ------------------------------------------------------------ live messages
  function onMessage(m) {
    if (m.type === "reading") {
      const n = state.nodes.get(m.node) || { node: m.node, name: m.node, lat: m.lat, lon: m.lon, sim: m.sim };
      n.latest = m;
      state.nodes.set(m.node, n);
      placeNode(n);
      state.feed.unshift(m);
      if (state.feed.length > 200) state.feed.length = 200;
      renderFeed(m.id);
      if (!m.sim && m.node === state.tank) {
        if (m.phase === "before") { state.pour = { before: m, after: null, decision: null }; renderPour(); }
        else if (state.pour?.before?.test === m.test) { state.pour.after = m; renderPour(true); }
      }
    } else if (m.type === "decision") {
      const row = state.feed.find((r) => r.id === m.id);
      if (row) { row.ai_filter = m.ai_filter; row.explanation = m.explanation; }
      const p = state.pour;
      if (p?.before?.id === m.id) { p.decision = m; renderPour(); }
    } else if (m.type === "filters") {
      state.filters = mergeFilters(m.filters || []);
      renderFilters();
    } else if (m.type === "report") {
      state.report = m;
      renderReport();
    }
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    const api = params.get("api");
    const base = api ? api.replace(/\/$/, "") : location.protocol.startsWith("http") ? "" : null;
    if (!params.has("demo") && base !== null) {
      try {
        const live = liveSource(base);
        state.health = await withTimeout(live.get("/health"), 2500);
        source = live;
        $("#api-link").href = base + "/docs";
        $("#api-link").hidden = false;
      } catch { /* no gateway: demo */ }
    }
    if (!source) { source = TapDemo.create(); state.health = await source.get("/health"); }

    initMap();
    const soft = (p, fallback) => source.get(p).catch(() => fallback);
    const [nodes, readings, reference, filters, reports] = await Promise.all([
      soft("/api/nodes", []), soft("/api/readings?limit=60", []), soft("/api/reference", []),
      soft("/api/filters", []), soft("/api/reports?limit=1", []),
    ]);
    nodes.forEach((n) => state.nodes.set(n.node, n));
    state.tank = (nodes.find((n) => !n.sim) || {}).node || "tank-01";
    state.feed = readings;
    state.reference = Array.isArray(reference) ? reference : [];
    state.filters = filters;
    state.report = reports[0] || null;

    const lastTank = readings.find((r) => r.node === state.tank) || state.nodes.get(state.tank)?.latest;
    if (lastTank) state.pour = pourFromPair(await soft(`/api/tests/${state.tank}/${lastTank.test}`, [lastTank]));

    renderPour();
    renderFilters();
    renderReport();
    renderFeed();
    state.nodes.forEach(placeNode);
    placeReference();
    if (map) map.invalidateSize();
    fitMap();
    source.subscribe(onMessage, setConn);
    setInterval(() => { renderFeed(); if (state.pour?.before) $("#pour-meta").textContent = `${nodeName(state.pour.before.node)}, pour ${state.pour.before.test}, ${ago(state.pour.before.ts)}`; }, 30000);
  }

  boot().catch((err) => {
    console.error(err);
    $("#conn").dataset.state = "down";
    $("#conn-text").textContent = "The dashboard failed to start: " + err.message;
  });
})();
