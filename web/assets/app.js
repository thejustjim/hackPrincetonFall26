/* The page controller for /demo.
   One cup in the middle shows the latest reading and turns slowly; notes sit around it and
   explain themselves on hover; scrolling down glides slowly into the full view, which rises
   over the hero.
   demo-view.js supplies window.TapView = {
     orbit: {...options for notes.js},
     tag(item) -> html for a note,
     context(items, store)   optional: where the notes that aren't about the cup go,
     hero(store, verdict)    optional: extra hero text,
     render(store, what, payload) fills the full view,
     stackBelow              px width under which the hero stops being pinned (default 760) }. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /* typographic text: curly quotes and apostrophes, unbreakable units */
  const typo = (s) => String(s ?? "")
    .replace(/(\w)'(\w)/g, "$1’$2").replace(/(\w)'/g, "$1’").replace(/'(\w)/g, "‘$1")
    .replace(/"([^"]*)"/g, "“$1”")
    .replace(/(\d) (ppm|L|km|pH)\b/g, "$1 $2").replace(/\bpH (\d)/g, "pH $1");
  const t = (s) => esc(typo(s));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FILTER_NAME = { ZEROWATER: "ZeroWater", BRITA: "Brita Elite", NONE: "No filter" };
  // "SAFE" is the tank's word for all three readings in range. It is not a safety test, so the page never says safe.
  const VERDICT = { SAFE: "In range", HIGH_TDS: "High dissolved solids", CLOUDY: "Cloudy", PH_WARN: "pH out of range" };
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
      // once a retest reads the limit, the gateway keeps it marked for replacement until it is reset
      const latched = f.status === "REPLACE" && last != null && last < limit;
      return { frac: latched ? 1 : last == null ? 0 : last / limit,
               line: `${fmt(f.liters, 1)} L filtered. ${last == null ? "No retest yet" : `Last retest ${last} ppm`}; replace at ${limit}.${
                 latched ? ` An earlier retest reached ${limit}, so it stays marked until the cartridge is changed.` : ""}` };
    }
    const rated = f.rated_liters || 450;
    return { frac: f.liters / rated, line: `${fmt(f.liters, 1)} of about ${rated} L used.` };
  }
  /* text that changes fades out and back in, instead of snapping */
  function swapText(el, text) {
    if (!el || el.dataset.text === text) return;
    const first = el.dataset.text == null;
    el.dataset.text = text;
    if (first || reduced) { el.textContent = text; return; }
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: "ease-in", fill: "forwards" }).finished.then(() => {
      el.textContent = el.dataset.text;
      el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
        { duration: 1100, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" });
    }).catch(() => { el.textContent = el.dataset.text; });
  }
  const km = (a, b) => {
    const p = Math.PI / 180, h = Math.sin(((b.lat - a.lat) * p) / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(((b.lon - a.lon) * p) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  /* one sentence on the cloud copy, or "" when the gateway has none (see gateway/cloud.py) */
  function cloudLine(store) {
    const c = store.health?.cloud;
    if (!c?.enabled) return "";
    const where = c.timescale ? "a cloud database (TimescaleDB)" : "a cloud database", n = (v) => Number(v || 0).toLocaleString();
    if (!c.connected) return `The copy to ${where} is paused: ${n(c.pending)} readings are kept here until the link is back.`;
    return `Every reading is also copied to ${where}: ${n(c.cloud_rows)} there, ${n(c.pending)} waiting.`;
  }
  window.TapUI = { $, esc, t, typo, clamp, fmt, clock, ago, pct, ring, filterLife, swapText, cloudLine, FILTER_NAME, VERDICT, STATUS };

  const SHORT = { ZEROWATER: "ZeroWater", BRITA: "Brita" };
  const current = (store) => store.pour?.after || store.pour?.before || null;
  const usedFilter = (store) => store.pour?.decision?.ai_filter || null;

  /* The hero's words: a short verdict, and under it what is being done about it.
     tone "good" marks the payoff: a cup that was out of range and came back in range. */
  function verdict(store) {
    const p = store.pour, b = p?.before, a = p?.after, f = usedFilter(store);
    const site = b ? store.nodeName(b.node) : "Clarity";
    const when = b ? `Pour ${b.test}, ${ago((a || b).ts)}` : "";
    const name = SHORT[f] || "the filter";
    if (!b) return { title: "Waiting for a pour", sub: "", tone: null, site, when };
    if (a) {
      return a.verdict === "SAFE"
        ? { title: "Back in range", sub: `after ${name}`, tone: "good", site, when }
        : { title: `Still ${VERDICT[a.verdict].toLowerCase()}`, sub: `after ${name}`, tone: null, site, when };
    }
    const title = b.verdict === "SAFE" ? "All in range" : VERDICT[b.verdict];
    if (!p.decision) return { title, sub: "Choosing a filter", tone: null, site, when };
    if (f === "NONE") return { title, sub: b.verdict === "SAFE" ? "No filter needed" : "Neither filter helps", tone: b.verdict === "SAFE" ? "good" : null, site, when };
    return { title, sub: `Filtering through ${name}`, tone: null, site, when };
  }

  /* The notes. group "cup": about the water in the cup. group "context": everything around it.
     flag: a few words when a reading is out of range (so colour is never the only signal). */
  const SLOTS = ["tds", "filter", "ph", "nearby", "clarity", "filters", "retest", "network", "report"];
  function items(store) {
    const p = store.pour, b = p?.before, a = p?.after, r = a || b, d = p?.decision, f = d?.ai_filter;
    const out = [];
    if (r) {
      // "back in range" marks a reading the filter fixed; "warn" one that is out of range now
      const state = (bad, wasBad, why) => bad ? { flag: why, tone: "warn" } : a && wasBad ? { flag: "back in range", tone: "good" } : { flag: null, tone: null };
      const phBad = (x) => x.ph < 6.5 || x.ph > 8.5;
      out.push({ id: "ph", group: "cup", icon: "gauge", label: "Acidity", value: `pH ${fmt(r.ph, 1)}`, ...state(phBad(r), phBad(b), "outside 6.5 to 8.5"),
        detail: `Drinking water is normally between 6.5 and 8.5. Neither filter here corrects pH.` });
      out.push({ id: "clarity", group: "cup", icon: "eye", label: "Transparency", value: fmt(r.clarity, 2), ...state(r.clarity < 0.7, b.clarity < 0.7, "cloudy: below 0.70"),
        detail: `How clear the water looks, from 0 (opaque) to 1 (clear). Below 0.70 counts as cloudy, and this device sends cloudy water to Brita.` });
      out.push({ id: "tds", group: "cup", icon: "drop", label: "Dissolved solids", value: `${r.tds} ppm`, ...state(r.tds > 300, b.tds > 300, r.tds > 500 ? "over the EPA guideline of 500" : "high: above 300"),
        detail: `Minerals and salts in the water${a ? `. This cup went from ${b.tds} to ${a.tds} ppm` : ""}. Above 300 is high; the EPA guideline is 500.` });
    }
    if (d) {
      const who = d.source === "claude" ? "Claude chose it." : d.source === "sample" ? "Sample explanation, written for the demo data." : "The tank's own rule chose it.";
      out.push({ id: "filter", group: "cup", minor: true, icon: "funnel", label: f === "NONE" ? "Filter" : "Sent through", value: FILTER_NAME[f] || f,
        detail: d.explanation ? `${who} ${d.explanation}` : `${who} It uses fixed thresholds: ZeroWater above 300 ppm, Brita below 0.70 transparency.` });
    }
    if (a) {
      // report the reading the filter was chosen for, not always dissolved solids
      const forClarity = b.verdict === "CLOUDY", drop = pct(a.tds, b.tds);
      out.push({ id: "retest", group: "cup", minor: true, icon: "retest", label: "Retest",
        value: forClarity ? `Transparency ${fmt(b.clarity, 2)} → ${fmt(a.clarity, 2)}` : drop >= 0 ? `Solids down ${drop}%` : `Solids up ${-drop}%`,
        detail: `After ${FILTER_NAME[f] || "filtering"}: dissolved solids ${b.tds} to ${a.tds} ppm, transparency ${fmt(b.clarity, 2)} to ${fmt(a.clarity, 2)}, pH ${fmt(b.ph, 1)} to ${fmt(a.ph, 1)}.` });
    } else if (d && f !== "NONE") {
      out.push({ id: "retest", group: "cup", minor: true, icon: "retest", label: "Retest", value: "Awaited",
        detail: `Pour the filtered water back into the cup and press the button to see whether it helped.` });
    }
    if (store.filters.length) {
      const bad = store.filters.find((x) => x.status === "REPLACE") || store.filters.find((x) => x.status === "REPLACE_SOON");
      out.push({ id: "filters", group: "context", icon: "ring", label: "Filter life", tone: bad ? (bad.status === "REPLACE" ? "alert" : "warn") : null,
        value: !bad ? "Both filters fine" : bad.status === "REPLACE" ? `Replace ${bad.name || FILTER_NAME[bad.filter]}` : `${bad.name || FILTER_NAME[bad.filter]} running low`,
        detail: store.filters.map((x) => `${x.name || FILTER_NAME[x.filter]}: ${filterLife(x).line}`).join(" ") });
    }
    const tank = store.nodes.get(store.tank);
    if (store.reference.length && tank?.lat != null) {
      const near = [...store.reference].sort((x, y) => km(tank, x) - km(tank, y))[0];
      const typical = near.typical_tds_est ?? near.tds_est;
      out.push({ id: "nearby", group: "context", icon: "pin", label: "Nearby water", value: `${near.site}: ${typical} ppm`,
        detail: `Typical of recent samples published by ${near.source}; last sampled ${String(near.date).slice(0, 4)}, about ${km(tank, near).toFixed(1)} km away. Estimated from conductance.${r ? ` This cup reads ${r.tds} ppm.` : ""}` });
    }
    const all = [...store.nodes.values()];
    if (all.length) {
      const sims = all.filter((n) => n.sim).length, odd = all.filter((n) => !n.sim && n.latest?.anomaly >= 0.6).length;
      out.push({ id: "network", group: "context", icon: "nodes", label: "Network", value: `${all.length - sims} measured, ${sims} simulated`,
        detail: `${all.length - sims} measuring and ${sims} simulated around Princeton. Simulated nodes are always labelled. ${odd ? "The measured site's latest reading is unusual for it." : "Nothing unusual at the measured site."}${cloudLine(store) ? ` ${cloudLine(store)}` : ""}` });
    }
    out.push(store.report
      ? { id: "report", group: "context", icon: "sparkles", label: "Investigator", value: store.pour?.before && store.report.test !== store.pour.before.test ? `Report on pour ${store.report.test}, the one before` : `Report on pour ${store.report.test}`,
          detail: `${store.report.summary}${store.report.actions?.[0] ? ` Next: ${store.report.actions[0]}` : ""}` }
      : { id: "report", group: "context", icon: "sparkles", label: "Investigator", value: "No report yet",
          detail: store.health.investigator ? "A report follows each retest: what changed, how this site compares, and what to do next." : "Reports follow each retest once the gateway has an Anthropic key." });
    return out;
  }

  // ------------------------------------------------------------ the slow scroll
  function scrolling(orbit, stackBelow) {
    const hero = $("#hero"), inner = $("#hero-inner"), bar = $(".bar");
    const narrow = matchMedia(`(max-width: ${stackBelow}px)`);
    function progress() {
      if (document.documentElement.classList.contains("pitching")) return;
      if (narrow.matches) { inner.style.opacity = inner.style.transform = ""; orbit.setRunning(true); bar.classList.remove("solid"); return; }
      const p = clamp(scrollY / innerHeight, 0, 1);          // 0 on the hero, 1 once the full view covers it
      inner.style.opacity = (1 - 0.8 * p).toFixed(3);
      inner.style.transform = `translate3d(0, ${(-5 * p).toFixed(2)}vh, 0) scale(${(1 - 0.05 * p).toFixed(4)})`;
      const on = p < 0.97;
      orbit.setRunning(on);
      window.TapHero?.setRunning(on);
      hero.style.pointerEvents = p > 0.4 ? "none" : "";
      bar.classList.toggle("solid", scrollY > innerHeight - 70);
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
      if (reduced || narrow.matches) { window.scrollTo(0, y); return; }
      target = clamp(y, 0, max());
      if (!raf) { cur = scrollY; raf = requestAnimationFrame(step); }
    };
    if (!reduced && matchMedia("(pointer: fine)").matches) {
      window.addEventListener("wheel", (e) => {
        if (e.ctrlKey || narrow.matches || document.documentElement.classList.contains("pitching")) return;
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
    const M = window.TapView;
    const pitching = () => document.documentElement.classList.contains("pitching");   // set while the pitch covers the demo
    const stackBelow = M.stackBelow || 760;
    const store = await TapStore.connect();
    const params = new URLSearchParams(location.search);
    const orbit = TapNotes.create(Object.assign({ stage: $("#stage"), cup: $("#cup"), tags: $("#tags"), leaders: $("#leaders"), slots: SLOTS, stackBelow }, M.orbit));

    // the pipette over the glass holds the pour as it read before any filter, and knows whether a filter was used
    const pipette = () => { const f = usedFilter(store); window.TapHero?.setSource?.(store.pour?.before || null, !!f && f !== "NONE"); };
    function renderNotes() {
      const all = items(store);
      orbit.set(M.context ? all.filter((i) => i.group === "cup") : all, M.tag);
      M.context?.(all.filter((i) => i.group === "context"), store);
    }
    function renderHero() {
      const v = verdict(store);
      swapText($("#verdict"), typo(v.title));
      swapText($("#sub"), typo(v.sub));
      swapText($("#site"), v.site);
      swapText($("#when"), v.when);
      $("#verdict").classList.toggle("good", v.tone === "good");
      renderNotes();
      const r = current(store);
      if (window.TapHero) { if (!pitching()) { TapHero.setWater(r); pipette(); } }
      else $("#cup-fallback").innerHTML = TapCup.svg(r);
      M.hero?.(store, v);
    }
    const shape = () => { if (window.TapHero?.shape) orbit.setShape(TapHero.shape); };
    window.addEventListener("hero3d:shape", shape);
    shape();
    window.addEventListener("hero3d:ready", () => { if (!pitching()) { TapHero.setWater(current(store), true); pipette(); } });
    if (window.TapHero && !pitching()) { TapHero.setWater(current(store), true); pipette(); }

    renderHero();
    M.render(store, "all");
    document.body.classList.add("ready");                      // the cup may appear
    if (!pitching()) document.body.classList.add("live");      // the copy and notes make their entrance (the pitch does this when it ends)
    window.TapApp = { store, refresh: renderHero, current: () => current(store) };
    window.dispatchEvent(new Event("app:ready"));
    store.on((type, payload) => {
      if (type === "pour") { renderHero(); M.render(store, "pour"); if (payload === "before") window.TapHero?.drip(); }
      else if (type === "filters" || type === "report") { renderHero(); M.render(store, type); }
      else if (type === "reading") { renderNotes(); M.render(store, "feed", payload); }
      else if (type === "conn") M.render(store, "conn");
    });
    setInterval(async () => { await store.refreshHealth(); renderHero(); M.render(store, "all"); }, 30000);   // keep "x minutes ago" and the counts honest
    scrolling(orbit, stackBelow);

    // for screenshots: ?open=tds holds one note open, ?view=details shows the full view on its own
    if (params.has("open")) { orbit.pin(params.get("open")); document.querySelector(`[data-note="${CSS.escape(params.get("open"))}"]`)?.classList.add("pinned"); }
    if (params.get("view") === "details") document.body.classList.add("only-details");
  }

  boot().catch((err) => {
    console.error(err);
    const v = $("#verdict");
    if (v) v.textContent = "The page failed to start: " + err.message;
    document.body.classList.add("ready", "live");               // never leave the page hidden behind its entrance
  });
})();
