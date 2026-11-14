/* Shared controller for the hero mockups (/a/ and /b/).
   One cup in the middle shows the latest reading and turns slowly; labels float around it and
   explain themselves on hover; scrolling down glides slowly into the full view, which rises over the hero.
   Each page supplies window.MOCK = { orbit: {...}, tag(item) -> html, render(store, what, payload) }. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const FILTER_NAME = { ZEROWATER: "ZeroWater", BRITA: "Brita Elite", NONE: "No filter" };
  const VERDICT = { SAFE: "Safe", HIGH_TDS: "High dissolved solids", CLOUDY: "Cloudy", PH_WARN: "pH out of range" };
  const STATUS = { OK: ["Fine", "ok"], REPLACE_SOON: ["Replace soon", "soon"], REPLACE: ["Replace now", "now"] };
  const fmt = (v, d) => (v == null ? "–" : Number(v).toFixed(d));
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function ago(ts) {
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 45) return "just now";
    if (s < 90) return "a minute ago";
    if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
    if (s < 5400) return "an hour ago";
    if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
    return new Date(ts).toLocaleDateString();
  }
  function pct(a, b) {   // percent drop from b to a; never rounds a partial drop up to 100
    if (!b) return 0;
    const v = (100 * (b - a)) / b;
    return v > 0 ? Math.min(Math.round(v), a > 0 ? 99 : 100) : Math.round(v);
  }
  function ring(frac, size = 52) {
    const r = 21, c = 2 * Math.PI * r, off = c * (1 - clamp(frac, 0, 1));
    return `<svg class="ring" viewBox="0 0 52 52" width="${size}" height="${size}" aria-hidden="true">
      <circle class="track" cx="26" cy="26" r="${r}" fill="none" stroke-width="6"/>
      <circle class="val" cx="26" cy="26" r="${r}" fill="none" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 26 26)"/></svg>`;
  }
  /* how far through its life a filter is, 0..1, and one line about it */
  function filterLife(f) {
    if (f.filter === "ZEROWATER") {
      const limit = f.replace_at_tds || 6, last = f.last_after_tds;
      return { frac: last == null ? 0 : last / limit,
               line: `${fmt(f.liters, 1)} L filtered. ${last == null ? "No retest yet" : `Last retest ${last} ppm`}; replace at ${limit}.` };
    }
    const rated = f.rated_liters || 450;
    return { frac: f.liters / rated, line: `${fmt(f.liters, 1)} of about ${rated} L used.` };
  }
  const km = (a, b) => {
    const p = Math.PI / 180, h = Math.sin(((b.lat - a.lat) * p) / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(((b.lon - a.lon) * p) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  window.TapUI = { $, esc, clamp, fmt, clock, ago, pct, ring, filterLife, FILTER_NAME, VERDICT, STATUS };

  const current = (store) => store.pour?.after || store.pour?.before || null;
  const usedFilter = (store) => store.pour?.decision?.ai_filter || null;

  /* the one line that matters most right now */
  function verdict(store) {
    const p = store.pour, b = p?.before, a = p?.after, f = usedFilter(store);
    const site = b ? store.nodeName(b.node) : "Clarity";
    const when = b ? `Pour ${b.test}, ${ago((a || b).ts)}` : "";
    let title;
    if (!b) title = "Waiting for a pour";
    else if (a) title = a.verdict === "SAFE" ? `Safe after ${FILTER_NAME[f] || "filtering"}` : `Still ${VERDICT[a.verdict].toLowerCase()} after ${FILTER_NAME[f] || "filtering"}`;
    else if (!p.decision) title = "Reading the cup";
    else if (f === "NONE") title = b.verdict === "SAFE" ? "Safe to drink" : `${VERDICT[b.verdict]}. No filter helps`;
    else title = `${VERDICT[b.verdict]}. Filtering through ${FILTER_NAME[f]}`;
    return { title, site, when };
  }

  /* the labels that orbit the cup. Hovering one should tell you enough. */
  const SLOTS = ["tds", "filter", "ph", "nearby", "clarity", "filters", "retest", "network", "report"];
  function items(store) {
    const p = store.pour, b = p?.before, a = p?.after, r = a || b, d = p?.decision, f = d?.ai_filter;
    const out = [];
    if (r) {
      out.push({ id: "tds", icon: "drop", label: "Dissolved solids", value: `${r.tds} ppm`,
        detail: `Minerals and salts in the water${a ? `. This cup went from ${b.tds} to ${a.tds} ppm` : ""}. Above 300 is high; the EPA guideline is 500.` });
      out.push({ id: "ph", icon: "gauge", label: "Acidity", value: `pH ${fmt(r.ph, 1)}`,
        detail: `Drinking water is normally between 6.5 and 8.5. Neither filter here corrects pH.` });
      out.push({ id: "clarity", icon: "eye", label: "Transparency", value: `${fmt(r.clarity, 2)} clear`,
        detail: `How clear the water looks, from 0 to 1. Below 0.70 counts as cloudy, and Brita is the filter for that.` });
    }
    if (d) {
      const who = d.source === "claude" ? "Claude" : "The tank's own rule";
      out.push({ id: "filter", icon: "funnel", label: "Filter", value: FILTER_NAME[f] || f,
        detail: d.explanation ? `${who} chose it. ${d.explanation}` : `${who} chose it from fixed thresholds: ZeroWater above 300 ppm, Brita below 0.70 transparency.` });
    }
    if (a) {
      const drop = pct(a.tds, b.tds);
      out.push({ id: "retest", icon: "retest", label: "Retest", value: drop >= 0 ? `Down ${drop}%` : `Up ${-drop}%`,
        detail: `After ${FILTER_NAME[f] || "filtering"}: dissolved solids ${b.tds} to ${a.tds} ppm, transparency ${fmt(b.clarity, 2)} to ${fmt(a.clarity, 2)}.` });
    } else if (d && f !== "NONE") {
      out.push({ id: "retest", icon: "retest", label: "Retest", value: "Awaiting retest",
        detail: `Pour the filtered water back into the cup and press the button to see if it worked.` });
    }
    if (store.filters.length) {
      const bad = store.filters.find((x) => x.status === "REPLACE") || store.filters.find((x) => x.status === "REPLACE_SOON");
      out.push({ id: "filters", icon: "ring", label: "Filter life",
        value: !bad ? "Filters fine" : bad.status === "REPLACE" ? `Replace ${bad.name || FILTER_NAME[bad.filter]}` : `${bad.name || FILTER_NAME[bad.filter]} running low`,
        detail: store.filters.map((x) => `${x.name || FILTER_NAME[x.filter]}: ${filterLife(x).line}`).join(" ") });
    }
    const tank = store.nodes.get(store.tank);
    if (store.reference.length && tank?.lat != null) {
      const near = [...store.reference].sort((x, y) => km(tank, x) - km(tank, y))[0];
      const typical = near.typical_tds_est ?? near.tds_est;
      out.push({ id: "nearby", icon: "pin", label: "Nearby water", value: `${near.site} ~${typical} ppm`,
        detail: `Published by ${near.source}, last sampled ${String(near.date).slice(0, 4)}, about ${km(tank, near).toFixed(1)} km away. Estimated from conductance.${r ? ` This cup reads ${r.tds} ppm.` : ""}` });
    }
    const all = [...store.nodes.values()];
    if (all.length) {
      const sims = all.filter((n) => n.sim).length, odd = all.filter((n) => n.latest?.anomaly >= 0.6).length;
      out.push({ id: "network", icon: "nodes", label: "Network", value: `${all.length} nodes`,
        detail: `${all.length - sims} measuring and ${sims} simulated around Princeton. Simulated nodes are always labelled. ${odd ? `${odd} reading${odd > 1 ? "s look" : " looks"} unusual right now.` : "Nothing unusual right now."}` });
    }
    if (store.report) {
      out.push({ id: "report", icon: "sparkles", label: "Investigator", value: "Report ready",
        detail: `${store.report.summary}${store.report.actions?.[0] ? ` Next: ${store.report.actions[0]}` : ""}` });
    }
    return out;
  }

  // ------------------------------------------------------------ map (shared)
  function mountMap(el, store) {
    if (!window.L || !el) return { place() {} };
    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25 }).setView([40.35, -74.655], 12);
    const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
    L.tileLayer(esri + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors" }).addTo(map);
    L.tileLayer(esri + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16 }).addTo(map);
    const markers = new Map();
    function place(n) {
      if (!n || n.lat == null) return;
      const r = n.latest, warn = r && r.verdict !== "SAFE", odd = r && r.anomaly >= 0.6;
      const fill = warn ? css("--warn") : css("--accent");
      const style = n.sim
        ? { radius: 6, color: odd ? css("--alert") : css("--neutral"), weight: 1.5, dashArray: "3 3", fillColor: fill, fillOpacity: 0.3 }
        : { radius: 10, color: css("--text"), weight: 2, fillColor: fill, fillOpacity: 0.95 };
      let m = markers.get(n.node);
      if (!m) {
        m = L.circleMarker([n.lat, n.lon], style).addTo(map);
        m.bindTooltip(n.sim ? `${n.name} (simulated)` : n.name, { direction: "top", offset: [0, -8], permanent: !n.sim });
        markers.set(n.node, m);
      } else m.setStyle(style);
      m.bindPopup(`<b>${esc(n.name)}</b><br><span class="pop-meta">${n.sim ? "Simulated node" : "Measured by Clarity"}${r ? `, ${esc(ago(r.ts))}` : ""}</span>${
        r ? `<br>${r.tds} ppm, pH ${fmt(r.ph, 1)}, transparency ${fmt(r.clarity, 2)}<br>${esc(VERDICT[r.verdict] || r.verdict)}${odd ? ", unusual for this site" : ""}` : ""}`);
      if (!n.sim) m.bringToFront();
    }
    store.nodes.forEach(place);
    store.reference.forEach((s) => {
      const icon = L.divIcon({ className: "", html: '<div class="ref-pin"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
      L.marker([s.lat, s.lon], { icon, title: s.site }).addTo(map)
        .bindTooltip(`${s.site}: ~${s.tds_est} ppm (${s.source}, ${String(s.date).slice(0, 4)})`, { direction: "top", offset: [0, -8] });
    });
    const pts = [...store.nodes.values()].filter((n) => n.lat != null).map((n) => [n.lat, n.lon]).concat(store.reference.map((s) => [s.lat, s.lon]));
    const fit = () => { map.invalidateSize(); if (pts.length > 1) map.fitBounds(pts, { padding: [24, 24] }); };
    fit();
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(el);
    return { place, fit };
  }

  // ------------------------------------------------------------ the slow scroll
  function scrolling(orbit) {
    const hero = $("#hero"), inner = $("#hero-inner");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phone = matchMedia("(max-width: 760px)");
    function progress() {
      if (phone.matches) { inner.style.opacity = inner.style.transform = ""; orbit.setRunning(true); return; }
      const p = clamp(scrollY / innerHeight, 0, 1);          // 0 on the hero, 1 once the full view covers it
      inner.style.opacity = (1 - 0.8 * p).toFixed(3);
      inner.style.transform = `translate3d(0, ${(-5 * p).toFixed(2)}vh, 0) scale(${(1 - 0.05 * p).toFixed(4)})`;
      const on = p < 0.97;
      orbit.setRunning(on);
      window.TapHero?.setRunning(on);
      hero.style.pointerEvents = p > 0.4 ? "none" : "";
      $(".bar").classList.toggle("solid", scrollY > innerHeight - 70);
    }
    let target = scrollY, cur = scrollY, raf = 0;
    const max = () => document.documentElement.scrollHeight - innerHeight;
    function step() {
      cur += (target - cur) * 0.07;                           // heavy, unhurried
      if (Math.abs(target - cur) < 0.4) cur = target;
      window.scrollTo(0, cur);
      raf = cur === target ? 0 : requestAnimationFrame(step);
    }
    const glideTo = (y) => {
      if (reduced || phone.matches) { window.scrollTo(0, y); return; }
      target = clamp(y, 0, max());
      if (!raf) { cur = scrollY; raf = requestAnimationFrame(step); }
    };
    if (!reduced && matchMedia("(pointer: fine)").matches) {
      window.addEventListener("wheel", (e) => {
        if (e.ctrlKey || phone.matches) return;
        e.preventDefault();
        if (!raf) target = cur = scrollY;
        glideTo(target + e.deltaY * (e.deltaMode === 1 ? 32 : 1) * 0.9);
      }, { passive: false });
    }
    window.addEventListener("scroll", progress, { passive: true });
    window.addEventListener("resize", progress);
    document.querySelectorAll("[data-glide]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      glideTo(a.dataset.glide === "top" ? 0 : innerHeight);
    }));
    progress();
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    const M = window.MOCK;
    const store = await TapStore.connect();
    const params = new URLSearchParams(location.search);
    const orbit = TapOrbit.create(Object.assign({ stage: $("#stage"), cup: $("#cup"), tags: $("#tags"), leaders: $("#leaders"), slots: SLOTS }, M.orbit));

    function renderHero() {
      const v = verdict(store);
      $("#verdict").textContent = v.title;
      $("#site").textContent = v.site;
      $("#when").textContent = v.when;
      orbit.set(items(store), M.tag);
      const r = current(store);
      if (window.TapHero) TapHero.setWater(r);
      else $("#cup-fallback").innerHTML = TapCup.svg(r);
      M.hero?.(store, v);
    }
    window.addEventListener("hero3d:ready", () => { TapHero.setWater(current(store), true); });
    if (window.TapHero) TapHero.setWater(current(store), true);

    renderHero();
    M.render(store, "all");
    const map = mountMap($("#map"), store);
    store.on((type, payload) => {
      if (type === "pour") { renderHero(); M.render(store, "pour"); if (payload === "before") window.TapHero?.drip(1); }
      else if (type === "filters" || type === "report") { renderHero(); M.render(store, type); }
      else if (type === "reading") { map.place(store.nodes.get(payload.node)); orbit.set(items(store), M.tag); M.render(store, "feed", payload); }
      else if (type === "conn") M.render(store, "conn");
    });
    setInterval(() => { renderHero(); M.render(store, "all"); }, 30000);   // keep "x minutes ago" honest
    scrolling(orbit);

    // for screenshots: ?open=tds opens one label, ?view=details shows the full view on its own
    if (params.has("open")) orbit.pin(params.get("open"));
    if (params.get("view") === "details") { document.body.classList.add("only-details"); map.fit(); }
  }

  boot().catch((err) => {
    console.error(err);
    const v = $("#verdict");
    if (v) v.textContent = "The page failed to start: " + err.message;
  });
})();
