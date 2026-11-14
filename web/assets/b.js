/* Mockup B: editorial. Supplies the annotation markup, writes the standfirst, fills the columns. */
(function () {
  "use strict";

  /* one or two sentences that tell the whole pour */
  function account(store) {
    const { fmt, clock, FILTER_NAME } = TapUI;
    const p = store.pour, b = p?.before, a = p?.after, d = p?.decision;
    if (!b) return "No cup has been poured yet. Pour one into the tank and press its button.";
    let s = `At ${clock(b.ts)}, a cup read ${b.tds} parts per million of dissolved solids, a pH of ${fmt(b.ph, 1)} and a transparency of ${fmt(b.clarity, 2)}.`;
    if (!d) return s + " A filter is being chosen.";
    const who = d.source === "claude" ? "Claude" : "The tank's own rule";
    const f = d.ai_filter;
    if (f === "NONE") return s + (b.verdict === "SAFE" ? " All three are in the normal range, so no filter was used." : " Its pH is outside the normal range, which neither filter corrects, so none was used.");
    s += ` ${who} sent it through ${FILTER_NAME[f] || f}.`;
    if (!a) return s + " The retest will show whether that worked.";
    return s + ` Poured back, it read ${a.tds} parts per million and a transparency of ${fmt(a.clarity, 2)}.`;
  }

  window.MOCK = {
    orbit: { reach: 0.5, tagHalf: 115, rowTop: 0.2, rowBottom: 0.86, keepLeftEl: document.querySelector(".hero-copy") },

    tag(item) {
      const { esc } = TapUI;
      return `<span class="lab">${esc(item.label)}</span><span class="val">${esc(item.value)}</span><span class="more">${esc(item.detail)}</span>`;
    },

    hero(store) {
      document.getElementById("standfirst").textContent = account(store);
    },

    render(store, what) {
      const { $, esc, fmt, ago, clock, filterLife, FILTER_NAME, VERDICT, STATUS } = TapUI;
      const p = store.pour, b = p?.before, a = p?.after, d = p?.decision;

      if (what === "all") {
        $("#dateline").textContent = `Princeton, ${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`;
      }
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
        $("#sheet-when").textContent = b ? `${store.nodeName(b.node)}, pour ${b.test}, ${ago((a || b).ts)}` : "";
        const f = d?.ai_filter;
        $("#why").innerHTML = !b
          ? `<p class="lede">No cup has been poured yet.</p>`
          : `<p class="lede">${esc(!d ? "A filter is being chosen." : f === "NONE" ? (b.verdict === "SAFE" ? "No filter was needed." : "No filter would help.") : `It went through ${FILTER_NAME[f] || f}.`)}</p>
             <p>${esc(!d ? "The tank waits a few seconds for Claude, then falls back on its own thresholds." : d.explanation || "There is no AI explanation for this pour: the tank used its built-in thresholds, ZeroWater above 300 ppm and Brita below 0.70 transparency.")}</p>`;
        const cell = (v, digits) => (v == null ? "–" : digits == null ? esc(v) : fmt(v, digits));
        $("#figures").innerHTML = !b ? "" : `<table class="figures">
          <thead><tr><th></th><th class="n">Before</th><th class="n">After</th></tr></thead>
          <tbody>
            <tr><td>Dissolved solids <span class="unit">ppm</span></td><td class="n">${cell(b.tds)}</td><td class="n">${cell(a?.tds)}</td></tr>
            <tr><td>Acidity <span class="unit">pH</span></td><td class="n">${cell(b.ph, 1)}</td><td class="n">${cell(a?.ph, 1)}</td></tr>
            <tr><td>Transparency <span class="unit">0 to 1</span></td><td class="n">${cell(b.clarity, 2)}</td><td class="n">${cell(a?.clarity, 2)}</td></tr>
            <tr><td>Verdict</td><td class="n" style="font-size:18px">${esc(VERDICT[b.verdict] || b.verdict)}</td><td class="n" style="font-size:18px">${a ? esc(VERDICT[a.verdict] || a.verdict) : "–"}</td></tr>
          </tbody></table>`;
      }

      if (what === "all" || what === "report") {
        const rep = store.report;
        $("#report").innerHTML = `<h2>From the investigator</h2>` + (!rep
          ? `<p class="quiet" style="margin-top:16px">${store.health.investigator ? "After each retest, the investigator sets out what changed, how this site compares, and what to do next." : "Reports appear after each retest once the gateway has an Anthropic key. Add it to .env and restart the gateway."}</p>`
          : `<p class="pull" style="margin-top:18px">${esc(rep.summary)}</p>
             ${rep.findings?.length ? `<h3>Findings</h3><ul>${rep.findings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
             ${rep.actions?.length ? `<h3>What to do next</h3><ol>${rep.actions.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}`);
      }

      if (what === "all" || what === "filters") {
        $("#filters").innerHTML = `<h3>Filters</h3>` + (store.filters.length ? `<table><tbody>${store.filters.map((f) => {
          const [label, cls] = STATUS[f.status] || [f.status, "ok"];
          return `<tr><td>${esc(f.name || FILTER_NAME[f.filter])}<br><span class="unit">${esc(filterLife(f).line)}</span></td>
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

      if (!window.MOCK.wired) {
        window.MOCK.wired = true;
        $("#show-sim").addEventListener("change", () => window.MOCK.render(store, "feed"));
        $("#filters").addEventListener("click", async (e) => {
          const btn = e.target.closest("[data-replace]");
          if (!btn) return;
          const name = FILTER_NAME[btn.dataset.replace] || btn.dataset.replace;
          if (!confirm(`Mark ${name} as replaced? Its liters and status start over.`)) return;
          try { await store.replaceFilter(btn.dataset.replace); }
          catch (err) { alert(`Couldn't mark ${name} as replaced: ${err.message}`); }
        });
      }
    },
  };
})();
