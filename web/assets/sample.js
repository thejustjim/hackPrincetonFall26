/* Sample data for when no gateway is reachable (static hosting, or ?demo).
   Same API shapes as gateway.py, so the page code doesn't care which it talks to.
   Everything here is made up except the published reference values. Its decisions and reports
   are written by hand, so they are marked source "sample" and the page says so. */
(function () {
  "use strict";

  const SITES = [
    ["tank-01", "Clarity demo (HackPrinceton)", 40.3467, -74.6553, false, 0],
    ["sim-01", "Carnegie Lake", 40.3380, -74.6380, true, 180], ["sim-02", "Kingston", 40.3762, -74.6143, true, 230],
    ["sim-03", "Rocky Hill", 40.3990, -74.6385, true, 260], ["sim-04", "Lawrenceville", 40.2973, -74.7296, true, 210],
    ["sim-05", "Plainsboro", 40.3335, -74.5927, true, 170], ["sim-06", "Hopewell (well)", 40.3893, -74.7621, true, 420],
    ["sim-07", "Penns Neck", 40.3290, -74.6370, true, 190], ["sim-08", "Montgomery (well)", 40.4268, -74.6810, true, 380],
    ["sim-09", "West Windsor", 40.2915, -74.6360, true, 200], ["sim-10", "Witherspoon St", 40.3530, -74.6640, true, 150],
    ["sim-11", "Princeton Junction", 40.3168, -74.6235, true, 220], ["sim-12", "Mercer Oaks", 40.2770, -74.6760, true, 240],
  ].map(([node, name, lat, lon, sim, base]) => ({ node, name, lat, lon, sim, base }));

  // Real values, from gateway/reference.json (Water Quality Portal).
  const REFERENCE = [
    { site: "Stony Brook", lat: 40.3331, lon: -74.6819, tds_est: 109, date: "2023-07-27", source: "NJ DEP", typical_tds_est: 180 },
    { site: "Millstone River", lat: 40.3133, lon: -74.5892, tds_est: 299, date: "2025-11-24", source: "NJ DEP", typical_tds_est: 248 },
    { site: "Lake Carnegie", lat: 40.3446, lon: -74.6295, tds_est: 92, date: "2023-11-29", source: "NJ DEP", typical_tds_est: 177 },
  ];

  const CUPS = { clean: [7.4, 140, 0.97], salty: [7.6, 780, 0.95], tea: [6.9, 210, 0.42] };
  const gauss = (m, s) => m + s * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

  function verdictFor(ph, tds, clarity) {
    if (tds > 300) return ["HIGH_TDS", "ZEROWATER"];
    if (clarity < 0.7) return ["CLOUDY", "BRITA"];
    if (ph < 6.5 || ph > 8.5) return ["PH_WARN", "NONE"];
    return ["SAFE", "NONE"];
  }

  function explain(r, filt) {
    if (filt === "ZEROWATER") return `Dissolved solids read ${r.tds} ppm, above the 300 ppm comfort level and over the EPA's 500 ppm guideline. ZeroWater removes dissolved solids, so the cup goes there. Pour it back afterwards to see whether it helped.`;
    if (filt === "BRITA") return `Transparency is ${r.clarity.toFixed(2)}, below the 0.70 cutoff, so this water is cloudy or coloured. Brita is this device's filter for cloudy or coloured water. Pour it back afterwards to see whether it helped.`;
    if (r.verdict === "PH_WARN") return `pH is ${r.ph}, outside 6.5 to 8.5. Neither filter fixes pH, so no filter this time. Check the source.`;
    return `pH ${r.ph}, ${r.tds} ppm and transparency ${r.clarity.toFixed(2)} are all in the normal range. No filter needed.`;
  }

  function create() {
    const readings = [];
    const listeners = [];
    let nextId = 1, test = 0, reportId = 0;
    const reports = [];
    // start the filters part-used so status changes show up within a few minutes
    const filt = {
      ZEROWATER: { liters: 2.9, tips: 29, runs: 1, last: 2, bad: null },
      BRITA: { liters: 404.4, tips: 4044, last: null },
    };
    const emit = (m) => listeners.forEach((fn) => fn(m));
    const now = (ago = 0) => new Date(Date.now() - ago * 1000).toISOString().replace(/\.\d+Z$/, "+00:00");

    function add(site, testNo, phase, ph, tds, clarity, ago = 0) {
      const [verdict, rule] = verdictFor(ph, tds, clarity);
      const r = {
        id: nextId++, ts: now(ago), node: site.node, test: testNo, phase, ph: round(ph, 2), tds: Math.round(tds),
        clarity: round(clarity, 2), verdict, filter: phase === "after" ? "NONE" : rule, ai_filter: null,
        rssi: Math.round(site.sim ? gauss(-80, 8) : gauss(-62, 4)), lat: site.lat, lon: site.lon, sim: site.sim,
        anomaly: round(Math.min(1, site.sim ? Math.abs(tds - site.base) / (site.base * 1.6) : Math.abs(tds - 180) / 700), 2),
        explanation: null,
      };
      readings.push(r);
      if (readings.length > 1500) readings.shift();
      return r;
    }

    const simTests = {};
    function simReading(site, ago = 0) {
      let tds = Math.max(20, gauss(site.base, 14));
      if (Math.random() < 0.03) tds *= 1.8 + Math.random() * 0.8;   // rare spike
      const ph = gauss(site.name.includes("well") ? 7.0 : 7.5, 0.15);
      simTests[site.node] = (simTests[site.node] || 0) + 1;
      return add(site, simTests[site.node], "before", ph, tds, Math.min(1, gauss(0.95, 0.03)), ago);
    }

    function filterList() {
      const z = filt.ZEROWATER, b = filt.BRITA;
      return [
        { node: "tank-01", filter: "ZEROWATER", name: "ZeroWater", liters: round(z.liters, 2), tips: z.tips,
          last_after_tds: z.last, replace_at_tds: 6, status: z.bad ? "REPLACE" : "OK",
          rule: "Replace when filtered water reads 6 ppm or more (ZeroWater's own rule)" },
        { node: "tank-01", filter: "BRITA", name: "Brita Elite", liters: round(b.liters, 2), tips: b.tips,
          last_after_tds: b.last, rated_liters: 450, liters_left: round(450 - b.liters, 2),
          percent_used: round((100 * b.liters) / 450, 2),
          status: b.liters >= 450 ? "REPLACE" : b.liters >= 405 ? "REPLACE_SOON" : "OK",
          rule: "Rated for about 450 L: REPLACE_SOON at 90%, REPLACE at 100%" },
      ];
    }

    // a simple version of the gateway's checks for the sample tank: robust z-scores against its own earlier pours
    const middle = (a) => { const v = [...a].sort((x, y) => x - y), n = v.length; return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; };
    function sampleChecks(before) {
      const raw = readings.filter((r) => r.node === before.node && r.phase === "before" && r.id < before.id);
      const floor = { ph: 0.1, tds: 10, clarity: 0.02 }, typical = { ph: [7.5, 0.3], tds: [180, 70], clarity: [0.95, 0.04] };
      const baseline = ["ph", "tds", "clarity"].map((k) => {
        const vals = raw.map((r) => r[k]);
        const [median, sigma] = vals.length < 8 ? typical[k] : [middle(vals), Math.max(1.4826 * middle(vals.map((v) => Math.abs(v - middle(vals)))), floor[k])];
        return { metric: k, value: before[k], median, sigma, n: vals.length, source: vals.length < 8 ? "typical" : "history",
                 z: round((before[k] - median) / sigma, 1), ewma_signal: false, cusum_signal: false, direction: "up" };
      });
      const lead = baseline.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a));
      const sims = SITES.filter((x) => x.sim).length;
      return { sensor: ["ph", "tds", "clarity"].map((k) => ({ metric: k, status: "ok", note: "" })), baseline,
               lead: { metric: lead.metric, z: lead.z, direction: lead.z >= 0 ? "up" : "down" }, repeat: 1,
               peers: { scope: "local", n: sims, moved: 0, simulated: sims }, kind: Math.abs(lead.z) >= 3 ? "local_event" : "normal" };
    }

    function makeReport(before, after, used) {
      const sims = SITES.filter((s) => s.sim).map((s) => latest(s.node)).filter(Boolean);
      const lo = Math.min(...sims.map((r) => r.tds)), hi = Math.max(...sims.map((r) => r.tds));
      const f = filterList().find((x) => x.filter === used);
      const zw = used === "ZEROWATER";
      const findings = zw
        ? [`Measured: dissolved solids fell from ${before.tds} to ${after.tds} ppm; pH moved from ${before.ph.toFixed(1)} to ${after.ph.toFixed(1)}.`,
           `Published: the Millstone River typically runs about 248 ppm (NJ DEP, 2024 to 2025), so ${before.tds} ppm is far saltier than local surface water.`,
           `Simulated: the simulated nodes nearby read ${lo} to ${hi} ppm.`,
           `Filter: ZeroWater has filtered ${f.liters} L; this retest read ${after.tds} ppm against its 6 ppm replace point.`]
        : [`Measured: transparency went from ${before.clarity.toFixed(2)} to ${after.clarity.toFixed(2)}; dissolved solids ${before.tds} to ${after.tds} ppm.`,
           `Published: Lake Carnegie typically reads about 177 ppm (NJ DEP, 2022 to 2023), similar to this sample.`,
           `Simulated: the simulated nodes nearby read ${lo} to ${hi} ppm.`,
           `Filter: Brita Elite has filtered ${f.liters} L of its ~450 L rating (${f.percent_used}%).`];
      const actions = zw
        ? (after.tds >= 6
            ? ["Replace the ZeroWater cartridge: the retest read 6 ppm or more.", "Keep high-TDS water out of the tank until the new cartridge is in."]
            : ["Find out where the salty sample came from.", "Have that source tested by a lab before relying on it: this device reads only pH, dissolved solids and transparency."])
        : (f.status === "OK"
            ? ["Retest the source tomorrow to see if the cloudiness persists.", "If it does, have it tested by a lab: cloudiness has many causes this device cannot tell apart."]
            : ["Order a replacement Brita Elite cartridge; this one is past 90% of its rating.", "Retest the source tomorrow to see if the cloudiness persists."]);
      const summary = zw
        ? `ZeroWater took this cup from ${before.tds} ppm to ${after.tds} ppm of dissolved solids${after.tds >= 6 ? ", but that is at its replace point" : ", so the filter did its job"}.`
        : `Brita took the cup's transparency from ${before.clarity.toFixed(2)} to ${after.clarity.toFixed(2)}, so the filter did its job.`;
      // the same extra fields the gateway sends (gateway/analysis.py and investigator.py), worked out simply here
      const checks = sampleChecks(before), lead = checks.baseline.find((x) => x.metric === checks.lead.metric);
      const val = (k, v) => (k === "tds" ? `${Math.round(v)} ppm` : v.toFixed(k === "clarity" ? 2 : 1));
      const far = Math.abs(lead.z) >= 3, name = zw ? "ZeroWater" : "Brita Elite", back = after.verdict === "SAFE";
      const problem = { HIGH_TDS: `high in dissolved solids (${before.tds} ppm)`, CLOUDY: `cloudy (transparency ${before.clarity.toFixed(2)})`, PH_WARN: `outside the usual pH range (pH ${before.ph.toFixed(1)})` }[before.verdict];
      const notice = `Clarity measured a cup of water at ${tank.name}. It read ${problem}${back ? ` and was sent through ${name}. On the retest, pH, dissolved solids and transparency all read in range.`
        : `, and after ${name} the retest was still out of range. Have this source tested by a certified lab before relying on it.`} Clarity reads only pH, dissolved solids and transparency. It cannot detect lead, bacteria or any specific contaminant.`;
      const sections = [
        { agent: "sensor-health", title: "Sensor health", text: "Measured: pH, dissolved solids and transparency all read plausibly. None is stuck, out of range or trending, so this is a water event, not a sensor fault." },
        { agent: "analyst", title: "This site's history", text: `Measured: ${{ ph: "pH", tds: "dissolved solids", clarity: "transparency" }[lead.metric]} read ${val(lead.metric, lead.value)}, ${Math.abs(lead.z).toFixed(1)} spreads ${lead.z >= 0 ? "above" : "below"} this site's median of ${val(lead.metric, lead.median)} over ${lead.n} pours. It is the only unusual pour in a row, and the control charts show no shift that has persisted.` },
        { agent: "network", title: "Nearby and published", text: `Simulated: none of the ${checks.peers.n} simulated nodes nearby moved the same way, so this looks local to this site. ${findings[1]}` },
        { agent: "maintenance", title: "Filters and upkeep", text: `${findings[3].replace(/^Filter: /, "Measured: ")} ${zw ? "ZeroWater says to replace its filter once filtered water reads 6 ppm or more (ZeroWater, filter instructions)." : "Brita rates the Elite filter for about 450 litres (Brita, Elite filter specifications)."}` },
        { agent: "comms", title: "Draft notice", text: notice },
      ];
      // the same triage, tool trail and figure check the gateway reports (analysis.plan, investigator.py, analysis.ground)
      const plan = (far ? [["analyst", "the pour is unusual for this site"], ["network", "to tell a local change from a regional one, and to set it against published samples"]] : [])
        .concat([["maintenance", "a filter was used"], ["comms", "every report carries a notice"]]).map(([agent, why]) => ({ agent, why }));
      const TOOLS = { analyst: ["get_case", "get_baseline", "get_site_history"], network: ["get_case", "get_peer_comparison", "get_reference_data"],
                      maintenance: ["get_case", "get_filter_life", "search_guidance"], comms: ["get_case", "get_notice_templates"] };
      const asked = sections.filter((x) => plan.some((q) => q.agent === x.agent));
      const figures = (asked.map((x) => x.text).concat(findings, [summary]).join(" ").match(/(?<![\w.])\d+(?:\.\d+)?/g) || []).filter((n) => n.includes(".") || +n >= 13).length;
      return { type: "report", id: ++reportId, ts: now(), node: after.node, test: after.test, reading_id: after.id,
               filter: used, summary, findings, actions, source: "sample", model: "sample",
               plan, trail: plan.map((q, i) => ({ agent: q.agent, tools: TOOLS[q.agent], seconds: 3 + i * 0.3 })),
               check: { figures, traced: figures, dropped: 0, summary_ok: true, untraced: [] }, seconds: 5,
               kind: checks.kind, kind_words: far ? "Unusual for this site" : "Nothing unusual", severity: back ? (far ? 1 : 0) : 2,
               severity_words: back ? (far ? "Worth a second look" : "No action needed") : "Act on it", checks, notice, sections: asked };
    }

    const latest = (node) => { for (let i = readings.length - 1; i >= 0; i--) if (readings[i].node === node) return readings[i]; return null; };
    const tank = SITES[0];

    // the sample investigator at work: the same events the gateway sends while its agents run, then the report
    function playAgents(report) {
      const who = { type: "agent", node: report.node, test: report.test };
      const at = (ms, e) => setTimeout(() => emit({ ...who, ...e }), ms);
      at(500, { event: "plan", agent: null, plan: report.plan });
      report.plan.forEach((q, i) => {
        at(900, { event: "asked", agent: q.agent });
        report.trail[i].tools.forEach((tool, k) => at(1400 + i * 260 + k * 620, { event: "tool", agent: q.agent, tool }));
        at(3300 + i * 300, { event: "answered", agent: q.agent });
      });
      at(4500, { event: "check", agent: null, check: report.check });
      setTimeout(() => emit(report), 5200);
      at(5300, { event: "done", agent: null });
    }

    // a tank pour: before -> decision -> tip -> after -> filters -> report
    function pour(cupName, opts = {}) {
      test += 1;
      const [ph, tds, clarity] = CUPS[cupName];
      const before = add(tank, test, "before", gauss(ph, 0.08), tds * (0.95 + Math.random() * 0.1), Math.min(1, clarity + gauss(0, 0.02)), opts.ago || 0);
      const quiet = opts.quiet;   // seeding history: no events
      if (!quiet) emit({ type: "reading", ...before });
      const decide = () => {
        const used = before.filter;
        before.ai_filter = used;
        before.explanation = explain(before, used);
        if (!quiet) emit({ type: "decision", id: before.id, node: before.node, test: before.test, phase: "before", ai_filter: used, explanation: before.explanation, source: "sample" });
        if (used === "NONE") return;
        const f = filt[used];
        f.liters += 0.1; f.tips += 1;
        if (!quiet) emit({ type: "filters", filters: filterList() });
        const retest = () => {
          let a;
          if (used === "ZEROWATER") {
            const out = Math.floor(Math.random() * 3) + Math.floor(f.runs / 2); f.runs += 1;
            a = add(tank, before.test, "after", before.ph - 0.6 - Math.random() * 0.4, out, Math.min(1, before.clarity + 0.03), opts.ago ? opts.ago - 20 : 0);
            if (out >= 6 && !f.bad) f.bad = a.test;
          } else {
            a = add(tank, before.test, "after", before.ph - 0.1, before.tds * 0.9, 0.86 + Math.random() * 0.09, opts.ago ? opts.ago - 20 : 0);
          }
          f.last = a.tds;
          const report = makeReport(before, a, used);
          reports.push(report);
          if (quiet) return;
          emit({ type: "reading", ...a });
          emit({ type: "filters", filters: filterList() });
          playAgents(report);
        };
        quiet ? retest() : setTimeout(retest, 11000);
      };
      quiet ? decide() : setTimeout(decide, 4000);      // long enough to see the cup as it was poured
    }

    // seed: some history for every sim node, and one finished tank pour
    SITES.filter((s) => s.sim).forEach((s) => { for (let k = 6; k >= 1; k--) simReading(s, k * 120 + Math.random() * 60); });
    // an hour of earlier pours, so the history has something to show
    ["salty", "tea", "clean", "salty", "tea", "clean", "salty", "tea"].forEach((cupName, k) => pour(cupName, { quiet: true, ago: 3600 - k * 400 }));
    pour("clean", { quiet: true, ago: 150 });
    pour("salty", { quiet: true, ago: 70 });
    readings.sort((a, b) => a.ts.localeCompare(b.ts));   // seeded out of order; the API is oldest -> newest

    function start() {
      const order = ["tea", "clean", "salty"];
      let i = 0;
      const next = () => pour(order[i++ % order.length]);
      // let the opening settle first, then a pour every 24 s: long enough for each one's decision, retest and report
      setTimeout(() => { next(); setInterval(next, 24000); }, 16000);
      const sims = SITES.filter((s) => s.sim);
      let j = 0;
      setInterval(() => emit({ type: "reading", ...simReading(sims[j++ % sims.length]) }), 1700);
    }

    function get(path) {
      const url = new URL(path, "http://demo");
      const q = url.searchParams, p = url.pathname;
      const limit = Number(q.get("limit") || 200);
      let m;
      if (p === "/health") return Promise.resolve({ ok: true, mock: true, ai: true, investigator: true, demo: true, ph_estimated: true });
      if (p === "/api/nodes") return Promise.resolve(SITES.map(({ base, ...s }) => ({ ...s, latest: latest(s.node) })));
      if (p === "/api/readings") {
        const node = q.get("node");
        return Promise.resolve(readings.filter((r) => !node || r.node === node).slice(-limit).reverse());
      }
      if ((m = p.match(/^\/api\/tests\/([^/]+)\/(\d+)$/))) {
        const pair = readings.filter((r) => r.node === m[1] && r.test === Number(m[2]));
        return Promise.resolve(["before", "after"].map((ph) => pair.filter((r) => r.phase === ph).pop()).filter(Boolean));
      }
      if (p === "/api/filters") return Promise.resolve(filterList());
      if (p === "/api/reference") return Promise.resolve(REFERENCE);
      if (p === "/api/reports") return Promise.resolve(reports.slice(-limit).reverse());
      return Promise.reject(new Error("404 " + p));
    }

    function post(path) {
      const m = path.match(/^\/api\/filters\/(\w+)\/replace/);
      if (!m) return Promise.reject(new Error("404 " + path));
      const key = m[1].toUpperCase();
      if (key === "ZEROWATER") Object.assign(filt.ZEROWATER, { liters: 0, tips: 0, runs: 0, last: null, bad: null });
      if (key === "BRITA") Object.assign(filt.BRITA, { liters: 0, tips: 0, last: null });
      const list = filterList();
      emit({ type: "filters", filters: list });
      return Promise.resolve(list);
    }

    let started = false;
    function subscribe(onMessage, onStatus) {
      listeners.push(onMessage);
      onStatus("demo");
      if (!started) { started = true; start(); }
    }

    return { kind: "demo", get, post, subscribe };
  }

  window.TapSample = { create, SITES, REFERENCE };
})();
