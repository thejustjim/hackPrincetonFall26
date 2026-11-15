/* /network: draws the simulated pipe network, plays one simulated event (which sensors alert, in
   what order), shows the pipes the trace ranks most likely, and lays out the incident report.

   Data: GET /api/network from the gateway, or network/data.json (the same thing, written by
   gateway/incident.py) when there is no gateway. Everything in it is simulated. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v) => `${Math.round(v * 100)}%`;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let data = null, current = null, timers = [], health = {};

  // ---------------------------------------------------------------- the drawing
  const S = 21, PAD = 26;
  function draw() {
    const xs = data.nodes.map((n) => n.x), ys = data.nodes.map((n) => n.y);
    const x0 = Math.min(...xs), y1 = Math.max(...ys);
    const W = (Math.max(...xs) - x0) * S + PAD * 2, H = (y1 - Math.min(...ys)) * S + PAD * 2;
    const at = new Map(data.nodes.map((n) => [n.id, [(n.x - x0) * S + PAD, (y1 - n.y) * S + PAD]]));
    const line = (p, cls, extra = "") => {
      const a = at.get(p.from), b = at.get(p.to);
      return a && b ? `<line class="${cls}" data-pipe="${esc(p.id)}" x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}"${extra}/>` : "";
    };
    const sensors = new Set(data.sensors);
    const parts = [
      data.pipes.map((p) => line(p, p.travel_min == null ? "pipe still" : "pipe")).join(""),
      (data.pumps || []).map((p) => line(p, "pump")).join(""),
      `<g id="cand-layer"></g>`,
      data.nodes.map((n) => {
        const [x, y] = at.get(n.id);
        if (n.kind === "junction") return sensors.has(n.id) ? "" : `<circle class="junction" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6"/>`;
        const label = n.kind === "reservoir" ? n.id : "tank";
        return `<rect class="store" x="${(x - 6).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="12" height="12"/><text class="place" x="${(x - 10).toFixed(1)}" y="${(y + 19).toFixed(1)}" text-anchor="end">${esc(label)}</text>`;
      }).join(""),
      data.sensors.map((id) => {
        const [x, y] = at.get(id);
        return `<circle class="sensor" data-sensor="${esc(id)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5"/><text class="sensor-label" data-label="${esc(id)}" x="${(x + 10).toFixed(1)}" y="${(y - 8).toFixed(1)}"></text>`;
      }).join(""),
    ];
    $("#net").innerHTML = `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Sketch of the simulated pipe network, its sensors and the pipes the trace suspects">${parts.join("")}</svg>`;
    $("#net-key").innerHTML = `<span><i class="k-sensor"></i>sensor, quiet</span><span><i class="k-alert"></i>sensor, alerting</span><span><i class="k-cand"></i>suspected pipe (thicker is likelier)</span><span><i class="k-truth"></i>where the simulation put it</span>`;
    draw.line = line;
    draw.at = at;
  }

  // ---------------------------------------------------------------- one scenario
  function show(id) {
    timers.forEach(clearTimeout);
    timers = [];
    current = data.scenarios.find((s) => s.id === id) || data.scenarios[0];
    const sc = current, fig = $("#net-fig");
    fig.classList.remove("revealed");
    document.querySelectorAll("#scenarios button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === sc.id)));

    // the pipes the trace suspects, and the one the simulation chose
    const pipes = new Map(data.pipes.map((p) => [p.id, p]));
    const layer = $("#cand-layer"), top = sc.candidates.slice(0, 5);
    const mid = (p) => { const a = draw.at.get(p.from), b = draw.at.get(p.to); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
    layer.innerHTML = top.map((c, i) => {
      const p = pipes.get(c.pipe);
      if (!p) return "";
      const share = c.confidence / (top[0].confidence || 1);
      return draw.line(p, "cand", ` style="stroke-width:${(3 + 6 * share).toFixed(1)}px;--o:${(0.35 + 0.65 * share).toFixed(2)}"`)
        + (i === 0 ? `<text class="cand-label${sc.truth?.pipe === c.pipe ? " same" : ""}" x="${(mid(p)[0] - 10).toFixed(1)}" y="${(mid(p)[1] - 10).toFixed(1)}">pipe ${esc(c.pipe)}</text>` : "");
    }).join("") + (sc.truth && pipes.get(sc.truth.pipe) ? (() => {
      const p = pipes.get(sc.truth.pipe), m = mid(p);
      return draw.line(p, "truth") + `<text class="truth-label" x="${(m[0] - 12).toFixed(1)}" y="${(m[1] + 20).toFixed(1)}">the simulation: pipe ${esc(p.id)}</text>`;
    })() : "");

    // the sensors alert in the order they did, the gaps between them kept in proportion
    document.querySelectorAll(".sensor").forEach((el) => el.classList.remove("alert"));
    document.querySelectorAll(".sensor-label").forEach((el) => { el.classList.remove("on"); el.textContent = ""; });
    const first = sc.alerts[0]?.minute ?? 0, span = Math.max(1, (sc.alerts.at(-1)?.minute ?? 0) - first);
    const PLAY = still ? 0 : 3200;
    sc.alerts.forEach((a, i) => {
      timers.push(setTimeout(() => {
        document.querySelector(`[data-sensor="${CSS.escape(a.sensor)}"]`)?.classList.add("alert");
        const label = document.querySelector(`[data-label="${CSS.escape(a.sensor)}"]`);
        if (label) { label.textContent = i === 0 ? "first" : `+${Math.round(a.minute - first)} min`; label.classList.add("on"); }
        document.querySelector(`#timeline li[data-i="${i}"]`)?.classList.add("on");
      }, 300 + (PLAY * (a.minute - first)) / span));
    });
    timers.push(setTimeout(() => layer.querySelectorAll(".cand, .cand-label").forEach((el) => el.classList.add("on")), still ? 0 : PLAY + 900));

    $("#timeline").innerHTML = sc.timeline.map((x, i) => `<li data-i="${i}"><span class="at">${i === 0 ? "0 min" : `+${Math.round(x.minute - first)} min`}</span><span>${esc(x.text)}</span></li>`).join("")
      + `<li class="quiet-row"><span class="at"></span><span>${sc.quiet.length} other sensor${sc.quiet.length === 1 ? "" : "s"} stayed quiet.</span></li>`;
    $("#cands").innerHTML = top.map((c, i) => `
      <li><div class="head"><span class="rank">${i + 1}</span><span class="name">Pipe ${esc(c.pipe)}<small>${esc(c.attributes.material)}, ${esc(c.attributes.year)}</small></span><span class="pct">${pct(c.confidence)}</span></div>
        <div class="bar-w"><span style="width:${(100 * c.confidence).toFixed(1)}%"></span></div>
        ${i === 0 ? `<div class="why">${c.rationale.map((r) => `<p>${esc(r)}</p>`).join("")}</div>` : ""}</li>`).join("")
      || `<li class="quiet">No pipe is upstream of every alerting sensor.</li>`;
    $("#considered").innerHTML = `${sc.considered} pipes are upstream of every alerting sensor. The share is each one's weight among them, not a probability that it is the cause.
      <br><button class="reveal" type="button" id="reveal">Show where the simulation put it</button><span class="checked" id="checked" hidden></span>`;
    $("#reveal").addEventListener("click", () => {
      fig.classList.add("revealed");
      $("#reveal").hidden = true;
      $("#checked").hidden = false;
      $("#checked").textContent = sc.check;
    });
    report(sc);
    try { history.replaceState(null, "", `#${sc.id}`); } catch (e) { /* opened as a file */ }
  }

  // ---------------------------------------------------------------- the incident report
  function report(sc) {
    const a = sc.affected || {};
    $("#report").innerHTML = `
      <header class="section-head"><h2>Incident report</h2><p><button class="print-btn" type="button" id="print">Print or save as PDF</button></p></header>
      <p class="about">${esc(sc.name)}. Simulated event, written from the trace by fixed rules.</p>
      ${health.investigator ? `<p class="ask"><button class="print-btn" type="button" id="ask">Ask the investigator's agents about this event</button></p><div id="agents"></div>` : ""}
      <p class="pull">${esc(sc.summary)}</p>
      <p class="rep-verdict sev-${sc.severity}"><b>${esc(sc.severity_words)}.</b></p>

      <h3>What to do next</h3>
      <ol class="steps">${sc.actions.map((x) => `<li>${esc(x.do)}${x.guidance ? `<blockquote>${esc(x.guidance.quote)}<cite><a href="${esc(x.guidance.url)}" rel="noopener">${esc(x.guidance.source)}</a></cite></blockquote>` : ""}</li>`).join("")}</ol>

      <h3>Downstream of the leading pipe</h3>
      <div class="figures-row">
        <div><b>${esc(a.junctions ?? 0)}</b><span>junctions within six hours' flow</span></div>
        <div><b>${esc(Math.round(a.demand_lps ?? 0))}</b><span>litres a second of simulated demand there</span></div>
        <div><b>${sc.alerts.length}<small style="font-size:.45em;color:var(--label2)"> of ${sc.alerts.length + sc.quiet.length}</small></b><span>sensors alerting</span></div>
      </div>

      <h3>Draft notice</h3>
      <blockquote class="notice">${esc(sc.notice)}</blockquote>
      <p class="by">A draft for a utility to adapt. Nothing sends it.</p>

      <h3>How the trace works</h3>
      <p class="quiet">${esc(sc.method)}</p>

      <h3>What this cannot tell you</h3>
      <ul class="plain">${sc.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;
    $("#print").addEventListener("click", () => { $("#net-fig").classList.add("revealed"); window.print(); });
    $("#ask")?.addEventListener("click", () => ask(sc));
  }

  /* With a model key on the gateway, a lead agent and three specialists (topology, maintenance,
     comms) write their own account of the event. It spends model credits, so it runs on request. */
  async function ask(sc) {
    const box = $("#agents"), btn = $("#ask");
    btn.disabled = true;
    box.innerHTML = `<p class="by">The agents are working: a lead and three specialists${health.ai_name ? ` on ${esc(health.ai_name)}` : ""}. This can take a minute or two.</p>`;
    try {
      const r = await fetch(`/api/network/investigate?scenario=${encodeURIComponent(sc.id)}`, { method: "POST" });
      if (!r.ok) throw new Error(r.status === 403 ? "Only the base station itself can ask: it spends model credits." : `The agents did not finish (${r.status}).`);
      const a = await r.json();
      if (current !== sc) return;
      box.innerHTML = `
        <h3>From the investigator's agents</h3>
        <p class="by">Written by a lead agent and three specialists${a.ai_name ? ` on ${esc(a.ai_name)}` : ""}, from the same simulated trace. They are not shown where the simulation put it.</p>
        <p class="pull">${esc(a.summary)}</p>
        ${a.findings?.length ? `<ul class="plain">${a.findings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${a.actions?.length ? `<h3>What they would do next</h3><ol class="steps">${a.actions.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
        ${a.sections?.length ? `<h3>What each agent found</h3><dl class="agents">${a.sections.filter((x) => x.agent !== "comms").map((x) => `<div><dt>${esc(x.title)}</dt><dd>${esc(x.text)}</dd></div>`).join("")}</dl>` : ""}
        ${a.notice ? `<h3>Their draft notice</h3><blockquote class="notice">${esc(a.notice)}</blockquote>` : ""}`;
      btn.hidden = true;
    } catch (e) {
      box.innerHTML = `<p class="by">${esc(e.message || "The agents could not be reached.")}</p>`;
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- start
  async function load() {
    for (const url of ["/api/network", "data.json"]) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) { const d = await r.json(); if (d?.scenarios?.length) return d; }
      } catch (e) { /* try the next one */ }
    }
    throw new Error("no network data");
  }
  const gateway = fetch("/health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  Promise.all([load(), gateway]).then(([d, h]) => {
    data = d;
    health = h || {};
    $("#net-note").textContent = `${d.summary.name}: ${d.summary.nodes} nodes, ${d.summary.pipes} pipes, ${d.summary.sensors} sensor nodes. ${d.note || ""}`;
    $("#scenarios").innerHTML = d.scenarios.map((s) => `<button type="button" data-id="${esc(s.id)}" aria-pressed="false">${esc(s.name)}</button>`).join("");
    $("#scenarios").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.id); });
    draw();
    show(location.hash.slice(1));
  }).catch(() => {
    $("#net").innerHTML = `<p class="quiet">The simulated network could not be loaded. Run <code>python gateway/incident.py</code> to write its data file.</p>`;
  });
})();
