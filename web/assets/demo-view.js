/* The /demo page's own rendering. Supplies the annotations, the context strip, the standfirst,
   and fills the full account: before/after plate, figures, pour history, report, filters,
   nearby water, readings. */
(function () {
  "use strict";

  /* A short account of the pour: what was wrong, what was done, how it turned out.
     The numbers themselves are in the notes around the glass, so they aren't repeated here. */
  function account(store) {
    const { FILTER_NAME } = TapUI;
    const p = store.pour, b = p?.before, a = p?.after, d = p?.decision;
    if (!b) return "No cup has been poured yet. Pour one into the tank and press its button.";
    const what = { SAFE: "All three readings came back in range.", HIGH_TDS: "This cup is high in dissolved solids: minerals and salts.",
                   CLOUDY: "This cup is cloudy.", PH_WARN: "This cup's pH is outside the usual range." }[b.verdict];
    if (!d) return `${what} ${b.verdict === "SAFE" ? "It may not need a filter; that is being decided." : "A filter is being chosen."}`;
    const f = d.ai_filter;
    const who = TapUI.AI[d.source] || (d.source === "sample" ? "The demo data" : "The tank's own rule");
    if (f === "NONE") {
      return b.verdict === "SAFE"
        ? `${what} No filter was needed. That is not a safety test: these readings can't show lead or bacteria.`
        : `${what} Neither filter corrects pH, so none was used.`;
    }
    const did = `${who} sent it through ${FILTER_NAME[f] || f}`;
    if (!a) return `${what} ${did}. Pour it back to see whether that helped.`;
    return a.verdict === "SAFE" ? `${what} ${did}, and the retest came back in range.` : `${what} ${did}, but the retest is still out of range.`;
  }

  /* What the pours in the history chart add up to: how many were left alone because they read in
     range, and how many of the filtered ones the retest found back in range. */
  const SHOWN = 14;
  function tally(store) {
    const pours = store.pours().slice(-SHOWN);
    const decided = pours.filter((p) => p.before.ai_filter);
    return {
      n: pours.length, decided: decided.length,
      skipped: decided.filter((p) => p.before.ai_filter === "NONE" && p.before.verdict === "SAFE").length,
      tried: pours.filter((p) => p.after).length,
      fixed: pours.filter((p) => p.after && p.before.verdict !== "SAFE" && p.after.verdict === "SAFE").length,
    };
  }
  /* the live half of the hero's one-sentence account of Clarity; empty until there are a few pours */
  function tallyLine(store) {
    const t = tally(store);
    if (t.decided < 3) return "";
    if (!t.skipped) return `None of the last ${t.decided} pours here read in range.`;
    if (t.skipped === t.decided) return `All of the last ${t.decided} pours here read in range.`;
    return `${t.skipped} of the last ${t.decided} pours here needed no filter.`;
  }
  /* Fade an element out and back in on swapText's timing, so it is unseen at the moment the lines
     above it change height and it lands in its new place. `mid` runs while it is out. */
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function dip(el, mid) {
    if (still) { mid?.(); return; }
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: "ease-in", fill: "forwards" }).finished.then(() => {
      mid?.();
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1100, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" });
    }).catch(() => { mid?.(); });
  }
  let heroWas = null;

  /* The report's own evidence, in words: the base station's checks (gateway/analysis.py), what each
     of the investigator's agents found, and the draft notice. All three are optional. */
  const NAMES = { ph: "pH", tds: "Dissolved solids", clarity: "Transparency" };
  const shown = (m, v) => (m === "tds" ? `${Math.round(v)} ppm` : Number(v).toFixed(m === "clarity" ? 2 : 1));
  function checkRows(c) {
    const faults = c.sensor.filter((x) => x.status !== "ok");
    const lead = c.baseline.find((x) => x.metric === c.lead.metric);
    const drift = c.baseline.filter((x) => x.ewma_signal || x.cusum_signal);
    const far = Math.abs(lead.z) >= 3, p = c.peers;
    return [
      ["Sensors", faults.length ? faults.map((x) => x.note).join(" ") : "All three read plausibly: none is stuck, out of range or trending.", faults.some((x) => x.status === "fault")],
      ["This site", `${NAMES[lead.metric]} read ${shown(lead.metric, lead.value)}, ${Math.abs(lead.z).toFixed(1)} spreads ${lead.z >= 0 ? "above" : "below"} ${
        lead.source === "history" ? `its own median of ${shown(lead.metric, lead.median)} over ${lead.n} pours` : `a typical ${shown(lead.metric, lead.median)} for local water (too few pours here yet)`}. ${
        far ? (c.repeat > 1 ? `${c.repeat} pours in a row have been unusual the same way.` : "Three or more is unusual; this is the only one in a row.") : "Three or more would be unusual."}`, far],
      ["Trend", drift.length ? `${drift.map((x) => NAMES[x.metric]).join(" and ")} ${drift.length > 1 ? "have" : "has"} run ${drift[0].direction === "up" ? "high" : "low"} for several pours: a small shift that persists.`
        : "No small shift has persisted across recent pours.", drift.length > 0],
      ["Neighbours", !p.n ? "No nodes nearby to compare with." : !far ? "Not needed: this pour was ordinary for the site."
        : `${p.moved || "None"} of the ${p.n} ${p.simulated === p.n ? "simulated " : ""}nodes nearby ${p.moved === 1 ? "is" : "are"} unusual the same way, so this looks ${p.scope === "regional" ? "regional, not local" : "local to this site"}.`, false],
    ];
  }
  const AGENT = { "sensor-health": "Sensor health", analyst: "This site's history", network: "Nearby and published",
                  maintenance: "Filters and upkeep", comms: "Draft notice" };
  const toolName = (n) => String(n).replace(/^get_/, "").replace(/_/g, " ");
  /* The investigator while it works: which specialists the checks chose, and what each is doing. */
  function swarmBlock(sw) {
    if (!sw || sw.state === "done") return "";
    const { esc } = TapUI;
    const head = sw.state === "failed" ? "The investigator's agents did not finish, so the report here is the one written from the checks."
      : sw.state === "checking" ? "The agents have answered. Their figures are being checked against what the tools returned."
      : `The investigator is working: ${sw.rows.size} of its five specialists, chosen by the checks.`;
    const rows = sw.state === "failed" ? "" : [...sw.rows.values()].map((r) => `
      <li class="${r.state}"><b>${esc(AGENT[r.agent] || r.agent)}</b><span>${esc(r.state === "waiting" ? "waiting" : r.tools.map(toolName).concat(r.state === "answered" ? "answered" : "working").join(" · "))}</span></li>`).join("");
    return `<div class="swarm" aria-live="polite"><p class="by">${esc(head)}</p>${rows ? `<ul>${rows}</ul>` : ""}</div>`;
  }
  function reportExtras(rep, health) {
    const { esc, t } = TapUI;
    const trail = new Map((rep.trail || []).map((x) => [x.agent, x])), why = new Map((rep.plan || []).map((x) => [x.agent, x.why]));
    const left = rep.plan ? Object.keys(AGENT).filter((a) => !why.has(a)).map((a) => AGENT[a]) : [];
    const c = rep.check;
    const checked = c ? `Checked ${c.figures} figure${c.figures === 1 ? "" : "s"} against what the tools returned: ${c.traced === c.figures ? "all traced" : `${c.traced} traced`}${
      c.dropped ? `, and ${c.dropped} statement${c.dropped === 1 ? " was" : "s were"} dropped for giving a figure no tool returned` : ""}.${rep.seconds ? ` The agents took ${Math.round(rep.seconds)} seconds.` : ""}` : "";
    const by = rep.source === "deepagents" ? `Written by the investigator: a lead agent and the specialists the checks called for${health.agent_name ? `, on ${health.agent_name}` : ""}.`
      : rep.source === "rules" ? `Written from the base station's own checks, by fixed rules. ${health.investigator ? "The investigator's agents are adding to it." : "With a model key, the investigator's agents add to it."}`
      : rep.source === "sample" ? "Sample report written for the demo data, not by the investigator." : "";
    return {
      by: by ? `<p class="${rep.source === "sample" ? "sample-note" : "by"}">${esc(by)}</p>` : "",
      verdict: rep.kind_words ? `<p class="rep-verdict sev-${rep.severity || 0}"><b>${t(rep.kind_words)}.</b> ${t(rep.severity_words || "")}.</p>` : "",
      checks: rep.checks ? `<h3>The checks behind it</h3><table class="checks"><tbody>${checkRows(rep.checks).map(([k, v, warn]) =>
        `<tr${warn ? ' class="warn"' : ""}><th scope="row">${k}</th><td>${t(v)}</td></tr>`).join("")}</tbody></table>` : "",
      agents: rep.sections?.length ? `<h3>What each agent found</h3>${checked ? `<p class="by checked">${esc(checked)}</p>` : ""}<dl class="agents">${rep.sections.filter((x) => x.agent !== "comms").map((x) =>
        `<div><dt>${t(x.title)}${why.get(x.agent) ? `<small>asked because ${t(why.get(x.agent))}</small>` : ""}</dt><dd>${t(x.text)}${x.traced === false ? ' <em class="untraced">This gives a figure no tool returned.</em>' : ""}</dd>${
          trail.get(x.agent)?.tools?.length ? `<dd class="trail">called ${esc(trail.get(x.agent).tools.map(toolName).join(" · "))}</dd>` : ""}</div>`).join("")}</dl>${
        left.length ? `<p class="by">Not asked this time: ${esc(left.join(", "))}. The checks found no reason to.</p>` : ""}` : "",
      notice: rep.notice ? `<h3>Draft notice</h3><blockquote class="notice">${t(rep.notice)}</blockquote><p class="by">Filled in from fixed templates. Nothing sends it.</p>` : "",
    };
  }

  /* Each pour as a pair: a ring where it started, a dot where it ended, on one ppm scale. */
  function historyChart(pours) {
    const { esc, clock, FILTER_NAME } = TapUI;
    const W = 1100, H = 250, L = 70, R = 190, T = 22, B = 40;
    const top = Math.max(600, Math.ceil(Math.max(...pours.map((p) => Math.max(p.before.tds, p.after?.tds ?? 0))) / 100) * 100);
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const step = (W - L - R) / Math.max(pours.length, 6);
    const x = (i) => L + step * (i + 0.5);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="hist-desc"><desc id="hist-desc">Dissolved solids for each of the last ${pours.length} pours at this site, before and after filtering, against the 300 and 500 parts per million lines.</desc>`;
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/><text x="${L - 10}" y="${y(0) + 4}" text-anchor="end">0</text>`;
    [[300, "300: counted as high"], [500, "500: EPA guideline"]].forEach(([v, label]) => {
      s += `<line class="limit" x1="${L}" x2="${W - R + 10}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
      s += `<text class="limit-label" x="${W - R + 20}" y="${y(v) + 5}">${label}</text>`;
    });
    s += `<text x="${L - 10}" y="${y(top) + 4}" text-anchor="end">${top} ppm</text>`;
    pours.forEach((p, i) => {
      const last = i === pours.length - 1, cx = x(i), yb = y(p.before.tds);
      const f = p.before.ai_filter;
      const tip = `Pour ${p.test}, ${clock(p.before.ts)}|${p.after ? `${p.before.tds} → ${p.after.tds} ppm through ${FILTER_NAME[f] || "a filter"}` : `${p.before.tds} ppm, ${f && f !== "NONE" ? "awaiting retest" : "no filter used"}`}`;
      s += `<g class="col${last ? " now" : ""}" data-tip="${esc(tip)}">`;
      // when a filter barely changes the reading, the two marks sit side by side instead of on top of each other
      const near = p.after && Math.abs(y(p.after.tds) - yb) < 13, dx = near ? 7 : 0;
      if (p.after) {
        const ya = y(p.after.tds);
        s += near ? `<line class="stem" x1="${cx - dx}" x2="${cx + dx}" y1="${yb}" y2="${ya}"/>` : `<line class="stem" x1="${cx}" x2="${cx}" y1="${yb}" y2="${ya}"/>`;
        s += `<circle class="after" cx="${cx + dx}" cy="${ya}" r="5.5"/>`;
        if (last) s += `<text class="value" x="${cx + dx + 12}" y="${ya + (near ? 14 : 5)}">${p.after.tds}</text>`;
      }
      s += `<circle class="before" cx="${cx - dx}" cy="${yb}" r="5.5"/>`;
      if (last) s += `<text class="value" x="${cx + dx + 12}" y="${yb + (near ? -6 : 5)}">${p.before.tds}</text>`;
      s += `<text x="${cx}" y="${H - 14}" text-anchor="middle">${last ? `Pour ${esc(p.test)}` : esc(p.test)}</text>`;
      s += `<rect class="hit" x="${cx - step / 2}" y="${T}" width="${step}" height="${H - T}"/></g>`;
    });
    s += `</svg>`;
    s += `<table class="visually-hidden"><caption>Dissolved solids per pour, ppm</caption><tr><th>Pour</th><th>Before</th><th>After</th></tr>${
      pours.map((p) => `<tr><td>${esc(p.test)}</td><td>${p.before.tds}</td><td>${p.after ? p.after.tds : "none"}</td></tr>`).join("")}</table>`;
    return s;
  }

  window.TapView = {
    stackBelow: 1180,
    orbit: {
      stackBelow: 1180, drift: 3, openWidth: 232, keepLeftEl: document.querySelector(".hero-copy"),
      margin: () => document.querySelector(".context").offsetLeft,
      // Places are relative to the glass (0 = rim, 1 = base).
      // Left: the three readings, top to bottom as they sit in the water. Right: what was done.
      slots: [
        { id: "ph",      side: -1, y: 0.18, gap: 0.15, at: "surface", ax: 0.93 },   // the water's surface
        { id: "clarity", side: -1, y: 0.52, gap: 0.20, at: 0.57, ax: 0.42 },        // the body of the water
        { id: "tds",     side: -1, y: 0.88, gap: 0.15, at: 0.85, ax: 0.5 },         // the specks near the bottom
        { id: "filter",  side: 1,  y: 0.08, gap: 0.14, at: 0.0, ax: 1 },            // over the rim
        { id: "retest",  side: 1,  y: 0.62, gap: 0.17, at: 0.62, ax: 1 },
      ],
    },

    tag(item) {
      const { t } = TapUI;
      return `<span class="head"><span class="lab">${t(item.label)}</span><span class="val">${t(item.value)}</span>${item.flag ? `<span class="flag">${t(item.flag)}</span>` : ""}</span>
        <span class="more"><span><span class="txt">${t(item.detail)}</span></span></span>`;
    },

    /* The strip under the glass. Cells are updated in place, so an open note, its transition and
       the keyboard focus all survive new data. */
    context(items) {
      const { typo } = TapUI;
      const row = document.getElementById("context");
      const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
      items.forEach((i) => {
        let el = row.querySelector(`[data-note="${i.id}"]`);
        if (!el) {
          el = document.createElement("button");
          el.type = "button";
          el.dataset.note = i.id;
          el.innerHTML = '<span class="lab"></span><span class="val"></span><span class="pop"></span>';
          row.append(el);
        }
        const [lab, val, pop] = el.children;
        put(lab, typo(i.label)); put(val, typo(i.value)); put(pop, typo(i.detail));
        el.className = `cx${i.tone ? ` ${i.tone}` : ""}${el.classList.contains("pinned") ? " pinned" : ""}`;
        el.setAttribute("aria-label", `${i.label}: ${i.value}. ${i.detail}`);
      });
      row.querySelectorAll(".cx").forEach((el) => { if (!items.some((i) => i.id === el.dataset.note)) el.remove(); });
    },

    hero(store, v) {
      const text = TapUI.typo(account(store));
      const now = `${v?.title}|${v?.sub}|${text}`, moved = heroWas != null && now !== heroWas;
      heroWas = now;
      TapUI.swapText(document.getElementById("standfirst"), text);
      // the headline and account above can change height: what sits under them steps out while they do
      const when = document.getElementById("when"), about = document.getElementById("about");
      if (moved && when && when.dataset.text === when.textContent) dip(when);   // unless its own text is already fading over
      const live = document.getElementById("about-tally"), line = tallyLine(store);
      const put = () => { if (live && live.textContent !== line) live.textContent = line; };
      if (moved && about) dip(about, put); else put();
    },

    render(store, what) {
      const { $, esc, t, fmt, ago, clock, filterLife, cloudLine, FILTER_NAME, VERDICT, STATUS } = TapUI;
      const p = store.pour, b = p?.before, a = p?.after, d = p?.decision;

      if (what === "all" || what === "conn") {
        const line = cloudLine(store), el = $("#cloud-line");
        if (el) { el.hidden = !line; el.textContent = line ? `Readings are stored on the base station first. ${line}` : ""; }
      }

      if (what === "all") {
        $("#dateline").textContent = `Princeton, ${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`;
        if (store.kind === "live") { const api = $("#api-link"); api.hidden = false; }
      }
      if (what === "all" || what === "conn") {
        const [short, long] = {
          live: store.health.ai ? [`Live, ${store.health.ai_name || "AI"} on`, `Live from the gateway; ${store.health.ai_name || "the AI model"} picks filters`] : ["Live, local rule", "Live from the gateway; no model key, so the tank's own rule picks filters"],
          down: ["Reconnecting", "Lost the gateway; reconnecting"],
          demo: ["Demo data", "No gateway reachable, so this is demo data"],
        }[store.conn] || ["Connecting", ""];
        $("#conn").dataset.state = store.conn;
        // the map dashboard shows only what a gateway sends; with none, open it on its own labelled demo data
        document.querySelector("a[data-map]")?.setAttribute("href", store.kind === "demo" ? "../map/?mock=1" : "../map/");
        $("#conn").title = long;
        $("#conn-text").textContent = short;
      }

      if (what === "all" || what === "pour") {
        $("#sheet-when").textContent = b ? `${store.nodeName(b.node)}, pour ${b.test}, ${ago((a || b).ts)}` : "";
        const f = d?.ai_filter;

        // the plate: the two cups, drawn from the readings
        const afterNote = a ? clock(a.ts) : !d ? "being decided" : f === "NONE" ? "no filter was used" : "awaiting the retest";
        const untouched = d && f === "NONE";
        $("#plate").innerHTML = !b ? "" : untouched ? `
          <div class="pair single">${TapCup.svg(b)}</div>
          <div class="pair-labels single"><div><b>As poured</b><span>${esc(clock(b.ts))}</span></div></div>
          <figcaption>No filter was used, so there is no retest. The amber tint and specks follow dissolved solids; the brown murk follows transparency.</figcaption>` : `
          <div class="pair">${TapCup.svg(b)}<svg class="arrow" viewBox="0 0 54 12" aria-hidden="true"><path d="M0 6 H52 M46 1 L52 6 L46 11"/></svg>${TapCup.svg(a)}</div>
          <div class="pair-labels"><div><b>Before</b><span>${esc(clock(b.ts))}</span></div><i></i><div><b>After</b><span>${esc(afterNote)}</span></div></div>
          <figcaption>Drawn from the readings. The amber tint and specks follow dissolved solids; the brown murk follows transparency.</figcaption>`;
        // the same two cups in 3D, laid over the flat ones (plate3d.js); `after` undefined means no second glass
        window.TapPlateState = !b ? null : { before: b, after: untouched ? undefined : a || null };
        window.TapPlate?.set(window.TapPlateState);

        $("#why").innerHTML = !b
          ? `<p class="lede">No cup has been poured yet.</p>`
          : `<p class="lede">${t(!d ? (b.verdict === "SAFE" ? "Whether it needs a filter is being decided." : "A filter is being chosen.") : f === "NONE" ? (b.verdict === "SAFE" ? "No filter was needed." : "No filter would help.") : `It went through ${FILTER_NAME[f] || f}.`)}</p>
             <p>${t(!d ? `The tank waits a few seconds for ${store.health.ai_name || "the AI model"}, then falls back on its own thresholds.` : d.explanation || "There is no AI explanation for this pour: the tank used its built-in thresholds, ZeroWater above 300 ppm and Brita below 0.70 transparency.")}</p>
             ${d?.source === "sample" ? '<p class="sample-note">Sample explanation written for the demo data, not by a model.</p>' : ""}`;

        const warn = { tds: (r) => r && r.tds > 300, ph: (r) => r && (r.ph < 6.5 || r.ph > 8.5), clarity: (r) => r && r.clarity < 0.7 };
        const cell = (r, key, digits) => `<td class="n${warn[key](r) ? " warn" : ""}">${r ? (digits == null ? esc(r[key]) : fmt(r[key], digits)) : "–"}</td>`;
        $("#figures").innerHTML = !b ? "" : `<table class="figures">
          <thead><tr><th></th><th class="n">Before</th><th class="n">After</th></tr></thead>
          <tbody>
            <tr><td>Dissolved solids <span class="unit">ppm</span></td>${cell(b, "tds")}${cell(a, "tds")}</tr>
            <tr><td>Acidity <span class="unit">pH</span></td>${cell(b, "ph", 1)}${cell(a, "ph", 1)}</tr>
            <tr><td>Transparency <span class="unit">0 to 1</span></td>${cell(b, "clarity", 2)}${cell(a, "clarity", 2)}</tr>
            <tr><td>Verdict</td><td class="n word${b.verdict !== "SAFE" ? " warn" : ""}">${esc(VERDICT[b.verdict] || b.verdict)}</td><td class="n word${a && a.verdict !== "SAFE" ? " warn" : ""}">${a ? esc(VERDICT[a.verdict] || a.verdict) : "–"}</td></tr>
          </tbody></table>`;

        const pours = store.pours().slice(-SHOWN);
        $("#history-fig").hidden = pours.length < 2;
        if (pours.length >= 2) {
          const sum = tally(store);
          $("#tally").innerHTML = `
            <li><b>${sum.n}</b><span>pours in this chart</span></li>
            <li${sum.skipped ? ' class="good"' : ""}><b>${sum.skipped}</b><span>needed no filter</span></li>
            <li${sum.fixed ? ' class="good"' : ""}><b>${sum.tried ? `${sum.fixed}<small> of ${sum.tried}</small>` : "0"}</b><span>${sum.tried ? "came back in range after filtering" : "filtered and retested so far"}</span></li>`;
          $("#history").innerHTML = historyChart(pours);
          $("#history-cap").textContent = `Dissolved solids for the last ${pours.length} pours at ${store.nodeName(store.tank)}. Pours without a dot were not filtered.`;
        }
      }

      if (what === "all" || what === "report") {
        const rep = store.report;
        const earlier = rep && b && rep.test !== b.test;
        $("#report").innerHTML = `<h2>From the investigator</h2>${rep ? `<p class="about">On pour ${esc(rep.test)}${earlier ? ", the one before this" : ""}${rep.ts ? `, ${esc(ago(rep.ts))}` : ""}</p>` : ""}` + (!rep
          ? `<p class="quiet" style="margin-top:16px">${store.health.investigator ? "After each retest, the investigator sets out what changed, how this site compares, and what to do next." : "A report follows each retest: what changed, how this site compares, and what to do next."}</p>`
          : (() => { const x = reportExtras(rep, store.health); return `${swarmBlock(store.swarm)}${x.by}<p class="pull">${t(rep.summary)}</p>${x.verdict}
             ${rep.findings?.length ? `<h3>Findings</h3><ul>${rep.findings.map((f) => `<li>${t(f)}</li>`).join("")}</ul>` : ""}
             ${rep.actions?.length ? `<h3>What to do next</h3><ol>${rep.actions.map((f) => `<li>${t(f)}</li>`).join("")}</ol>` : ""}
             ${x.checks}${x.agents}${x.notice}`; })());
      }

      if (what === "all" || what === "filters") {
        $("#filters").innerHTML = `<h3>Filters</h3>` + (store.filters.length ? `<table><tbody>${store.filters.map((f) => {
          const [label, cls] = STATUS[f.status] || [f.status, "ok"];
          const life = filterLife(f);
          return `<tr><td>${esc(f.name || FILTER_NAME[f.filter])}<br><span class="unit">${t(life.line)}</span>
              <div class="life status-${cls}" role="img" aria-label="${Math.round(100 * Math.min(1, life.frac))}% of its life used"><span style="width:${(100 * Math.min(1, life.frac)).toFixed(1)}%"></span></div></td>
            <td class="n"><span class="status-${cls}">${esc(label)}</span><br><button class="link-btn" type="button" data-replace="${esc(f.filter)}">Mark as replaced</button></td></tr>`;
        }).join("")}</tbody></table>` : `<p class="quiet">No filter data yet. It starts with the first tip.</p>`);
      }

      if (what === "all") {
        $("#nearby").innerHTML = store.reference.length ? `<h3>Nearby water, as published</h3><table>
          <thead><tr><th>Site</th><th class="n">Typical</th><th class="n hide-s">Last sample</th></tr></thead>
          <tbody>${store.reference.map((s) => `<tr><td>${esc(s.site)}<br><span class="unit">${esc(s.source)}</span></td>
            <td class="n">${esc(s.typical_tds_est ?? s.tds_est)} <span class="unit">ppm</span></td>
            <td class="n hide-s">${esc(s.tds_est)} <span class="unit">ppm, ${esc(String(s.date).slice(0, 4))}</span></td></tr>`).join("")}</tbody></table>` : "";
      }

      if (what === "all" || what === "feed" || what === "pour") {
        const showSim = $("#show-sim").checked;
        const rows = store.feed.filter((x) => showSim || !store.isSim(x)).slice(0, 12);
        $("#ledger").innerHTML = `<table class="ledger">
          <thead><tr><th>Time</th><th>Site</th><th class="hide-s">Pour</th><th class="n">pH</th><th class="n hide-s">Transparency</th><th class="n">Solids, ppm</th><th class="n">Note</th></tr></thead>
          <tbody>${rows.map((x) => `<tr>
            <td class="t">${esc(clock(x.ts))}</td>
            <td class="site">${esc(store.nodeName(x.node))}${store.isSim(x) ? ' <span class="sim">simulated</span>' : ""}</td>
            <td class="hide-s">${esc(x.test)}${x.phase === "after" ? ' <span class="sim">retest</span>' : ""}</td>
            <td class="n">${fmt(x.ph, 1)}</td>
            <td class="n hide-s">${fmt(x.clarity, 2)}</td>
            <td class="n">${esc(x.tds)}</td>
            <td class="n">${x.anomaly >= 0.6 ? '<span class="note-odd">unusual here</span>' : x.verdict !== "SAFE" ? `<span class="note-warn">${esc((VERDICT[x.verdict] || x.verdict).toLowerCase())}</span>` : ""}</td></tr>`).join("")}</tbody></table>`;
      }

      if (!window.TapView.wired) {
        window.TapView.wired = true;
        $("#show-sim").addEventListener("change", () => window.TapView.render(store, "feed"));
        $("#filters").addEventListener("click", async (e) => {
          const btn = e.target.closest("[data-replace]");
          if (!btn) return;
          const name = FILTER_NAME[btn.dataset.replace] || btn.dataset.replace;
          if (!confirm(`Mark ${name} as replaced? Its liters and status start over.`)) return;
          try { await store.replaceFilter(btn.dataset.replace); }
          catch (err) { alert(`Couldn't mark ${name} as replaced: ${err.message}`); }
        });
        // context notes: a tap pins one open; a tap elsewhere or Escape closes it
        document.addEventListener("click", (e) => {
          const cx = e.target.closest(".cx");
          document.querySelectorAll(".cx.pinned").forEach((el) => { if (el !== cx) el.classList.remove("pinned"); });
          if (cx) cx.classList.toggle("pinned");
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".cx.pinned").forEach((el) => { el.classList.remove("pinned"); el.blur(); }); });
        // history chart: one tooltip per pour
        const tip = $("#tip"), hist = $("#history");
        hist.addEventListener("pointermove", (e) => {
          const col = e.target.closest?.(".col");
          hist.querySelectorAll(".col.hot").forEach((c) => c.classList.remove("hot"));
          if (!col) { tip.hidden = true; return; }
          col.classList.add("hot");
          const [head, body] = col.dataset.tip.split("|");
          tip.innerHTML = `<i>${esc(head)}</i><br>${esc(body)}`;
          tip.hidden = false;
          tip.style.left = Math.min(innerWidth - tip.offsetWidth - 12, e.clientX + 14) + "px";
          tip.style.top = e.clientY - tip.offsetHeight - 12 + "px";
        });
        hist.addEventListener("pointerleave", () => { tip.hidden = true; hist.querySelectorAll(".col.hot").forEach((c) => c.classList.remove("hot")); });
      }
    },
  };
})();
