/* Mockup A: Weather / Health style. Supplies the label markup and fills the tiles. */
(function () {
  "use strict";

  function scale({ min, max, band, ticks = [], was, now }) {
    const pos = (v) => `${(100 * Math.min(1, Math.max(0, (v - min) / (max - min)))).toFixed(1)}%`;
    const wide = (a, b) => `${(100 * (b - a) / (max - min)).toFixed(1)}%`;
    return `<div class="scale">
      ${band ? `<span class="band" style="left:${pos(band[0])};width:${wide(band[0], band[1])}"></span>` : ""}
      ${ticks.map((t) => `<i class="tick" style="left:${pos(t)}"></i>`).join("")}
      ${was != null ? `<span class="dot was" style="left:${pos(was)}"></span>` : ""}
      ${now != null ? `<span class="dot" style="left:${pos(now)}"></span>` : ""}</div>`;
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 3200);
  }

  window.MOCK = {
    orbit: { tagHalf: 110 },

    tag(item) {
      const { esc } = TapUI;
      return `<span class="head"><svg class="i"><use href="#i-${item.icon}"/></svg><b>${esc(item.value)}</b><em>${esc(item.label)}</em></span>
        <span class="more">${esc(item.detail)}</span>`;
    },

    render(store, what) {
      const { $, esc, fmt, pct, ago, clock, ring, filterLife, FILTER_NAME, VERDICT, STATUS } = TapUI;
      const body = (id) => $(`#${id} .t-body`);
      const p = store.pour, b = p?.before, a = p?.after, r = a || b, d = p?.decision;

      if (what === "all" || what === "conn") {
        const [short, long] = {
          live: store.health.ai ? ["Live, Claude on", "Live from the gateway; Claude picks filters"] : ["Live, local rule", "Live from the gateway; no Anthropic key, so the tank's own rule picks filters"],
          down: ["Reconnecting", "Lost the gateway; reconnecting"],
          demo: ["Demo data", "No gateway reachable, so this is demo data"],
        }[store.conn] || ["Connecting", ""];
        $("#conn").dataset.state = store.conn;
        $("#conn").title = long;
        $("#conn-text").textContent = short;
      }

      if (what === "all" || what === "pour") {
        $("#sheet-site").textContent = b ? store.nodeName(b.node) : "Clarity";
        $("#sheet-when").textContent = b ? `Pour ${b.test}, ${ago((a || b).ts)}` : "Waiting for a pour";

        if (!r) {
          body("t-tds").innerHTML = body("t-ph").innerHTML = body("t-clear").innerHTML = `<p class="quiet">Pour a cup into the tank and press its button.</p>`;
        } else {
          const drop = a ? pct(a.tds, b.tds) : null;
          body("t-tds").innerHTML = `
            <div class="row"><p class="big">${a ? `${b.tds}<span class="arrow">→</span>${a.tds}` : r.tds}<small>ppm</small></p>
              ${a ? `<span class="chip ${drop >= 0 ? "ok" : "now"}">${drop >= 0 ? `Down ${drop}%` : `Up ${-drop}%`}</span>` : `<span class="chip ${r.tds > 300 ? "soon" : "ok"}">${r.tds > 300 ? "High" : "Fine"}</span>`}</div>
            ${scale({ min: 0, max: 1000, band: [0, 300], ticks: [300, 500], was: a ? b.tds : null, now: r.tds })}
            <p class="scale-note">Fine up to 300. The EPA guideline is 500.</p>`;
          const phOk = r.ph >= 6.5 && r.ph <= 8.5;
          body("t-ph").innerHTML = `
            <p class="big">${fmt(r.ph, 1)}<small>pH</small></p>
            ${scale({ min: 4, max: 11, band: [6.5, 8.5], was: a ? b.ph : null, now: r.ph })}
            <p class="scale-note">${phOk ? "In the normal range, 6.5 to 8.5." : "Outside the normal range, 6.5 to 8.5."}${a ? ` Was ${fmt(b.ph, 1)}.` : ""}</p>`;
          body("t-clear").innerHTML = `
            <p class="big">${fmt(r.clarity, 2)}</p>
            ${scale({ min: 0, max: 1, band: [0.7, 1], was: a ? b.clarity : null, now: r.clarity })}
            <p class="scale-note">${r.clarity >= 0.7 ? "Clear." : "Cloudy: below 0.70."}${a ? ` Was ${fmt(b.clarity, 2)}.` : ""}</p>`;
        }

        const meta = $("#t-choice .t-meta");
        if (!b) { meta.textContent = ""; body("t-choice").innerHTML = `<p class="quiet">The tank measures the cup, then picks a filter.</p>`; }
        else if (!d) { meta.textContent = ""; body("t-choice").innerHTML = `<h3>Choosing a filter</h3>`; }
        else {
          const f = d.ai_filter;
          meta.textContent = d.source === "claude" ? "Chosen by Claude" : "Chosen by the tank's rule";
          body("t-choice").innerHTML = `
            <h3>${esc(f === "NONE" ? (b.verdict === "SAFE" ? "No filter needed" : "No filter helps here") : `Tipped into ${FILTER_NAME[f] || f}`)}</h3>
            <p>${esc(d.explanation || "No AI explanation for this pour: the tank used its built-in thresholds.")}</p>`;
        }
      }

      if (what === "all" || what === "filters") {
        $("#filter-tiles").innerHTML = store.filters.length ? store.filters.map((f) => {
          const [label, cls] = STATUS[f.status] || [f.status, "ok"];
          const life = filterLife(f);
          return `<article class="tile filter-tile ${cls}">
            <header class="t-head"><svg class="i"><use href="#i-ring"/></svg>Filter life</header>
            <div class="ring-wrap">${ring(life.frac, 84)}<b>${Math.round(100 * Math.min(1, life.frac))}%</b></div>
            <h3>${esc(f.name || FILTER_NAME[f.filter])}</h3>
            <span class="chip ${cls}">${esc(label)}</span>
            <p class="sub">${esc(life.line)}</p>
            <button class="text-btn" type="button" data-replace="${esc(f.filter)}">Mark as replaced</button>
          </article>`;
        }).join("") : `<article class="tile span2"><header class="t-head"><svg class="i"><use href="#i-ring"/></svg>Filter life</header><p class="quiet">No filter data yet. It starts with the first tip.</p></article>`;
      }

      if (what === "all" || what === "report") {
        const rep = store.report;
        $("#t-report .t-meta").textContent = rep ? `Pour ${rep.test}${rep.ts ? `, ${ago(rep.ts)}` : ""}` : "";
        body("t-report").innerHTML = !rep
          ? `<p class="quiet">${store.health.investigator ? "After each retest, the investigator explains what changed, how this site compares, and what to do next." : "Reports appear after each retest once the gateway has an Anthropic key. Add it to .env and restart the gateway."}</p>`
          : `<p class="report-summary">${esc(rep.summary)}</p>
             ${rep.findings?.length ? `<h3>Findings</h3><ul>${rep.findings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
             ${rep.actions?.length ? `<h3>What to do next</h3><ol>${rep.actions.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}`;
      }

      if (what === "all" || what === "feed" || what === "pour") {
        const showSim = $("#show-sim").checked;
        const rows = store.feed.filter((x) => showSim || !store.isSim(x)).slice(0, 10);
        body("t-readings").innerHTML = `<ul class="rows">
          <li class="cols"><span>Site</span><span class="r hide-s">Time</span><span class="r">pH</span><span class="r hide-s">Transparency</span><span class="r">Solids</span></li>
          ${rows.map((x) => `<li>
            <span class="name">${esc(store.nodeName(x.node))}${store.isSim(x) ? '<span class="tag-sim">Simulated</span>' : ""}${x.phase === "after" ? '<span class="tag-sim">Retest</span>' : ""}
              ${x.verdict !== "SAFE" ? `<span class="flag">${esc(VERDICT[x.verdict] || x.verdict)}</span>` : ""}${x.anomaly >= 0.6 ? '<span class="flag odd">Unusual here</span>' : ""}</span>
            <span class="r dim hide-s">${esc(clock(x.ts))}</span>
            <span class="r">${fmt(x.ph, 1)}</span>
            <span class="r hide-s">${fmt(x.clarity, 2)}</span>
            <span class="r ppm"><b>${esc(x.tds)}</b> <span class="dim">ppm</span></span></li>`).join("")}</ul>`;
      }

      if (!window.MOCK.wired) {
        window.MOCK.wired = true;
        $("#show-sim").addEventListener("change", () => window.MOCK.render(store, "feed"));
        $("#filter-tiles").addEventListener("click", async (e) => {
          const btn = e.target.closest("[data-replace]");
          if (!btn) return;
          const name = FILTER_NAME[btn.dataset.replace] || btn.dataset.replace;
          if (!confirm(`Mark ${name} as replaced? Its liters and status start over.`)) return;
          try { await store.replaceFilter(btn.dataset.replace); toast(`Marked ${name} as replaced`); }
          catch (err) { toast(`Couldn't mark ${name} as replaced: ${err.message}`); }
        });
      }
    },
  };
})();
