/* Pitch deck: navigation, stage scaling, and the drawn parts (cups, sample chart, mini map). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const slides = [...document.querySelectorAll(".slide")];
  const phone = window.matchMedia("(max-width: 760px)");

  // ---------------------------------------------------------------- navigation
  let at = 0;
  function show(n) {
    at = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((s, i) => s.classList.toggle("on", i === at));
    $("#count").textContent = `${at + 1} / ${slides.length}`;
    if (location.hash !== `#${at + 1}`) history.replaceState(null, "", `#${at + 1}`);
  }
  const fromHash = () => (parseInt(location.hash.slice(1), 10) || 1) - 1;
  $("#prev").addEventListener("click", () => show(at - 1));
  $("#next").addEventListener("click", () => show(at + 1));
  window.addEventListener("hashchange", () => show(fromHash()));
  document.addEventListener("keydown", (e) => {
    if (phone.matches || e.metaKey || e.ctrlKey || e.altKey) return;
    if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); show(at + 1); }
    else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); show(at - 1); }
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(slides.length - 1);
    else if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
  });
  let touchX = null;
  document.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (touchX == null || phone.matches) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  function fit() {
    const deck = $("#deck");
    const s = Math.min(deck.clientWidth / 1600, deck.clientHeight / 900);
    $("#stage").style.setProperty("--s", phone.matches ? 1 : s.toFixed(4));
  }
  window.addEventListener("resize", fit);
  phone.addEventListener("change", fit);

  // ---------------------------------------------------------------- cups
  document.querySelectorAll("[data-cup]").forEach((el) => {
    el.innerHTML = TapCup.svg(JSON.parse(el.dataset.cup));
  });

  // ---------------------------------------------------------------- sample chart
  // Days with a published specific-conductance sample at Stony Brook (USGS-01401000 and the
  // NJ DEP stations at the same reach), counted from the Water Quality Portal, Nov 2026.
  const PER_YEAR = { 1956: 2, 1957: 1, 1958: 1, 1959: 1, 1960: 4, 1961: 4, 1962: 4, 1963: 5, 1964: 3, 1965: 3, 1966: 10,
    1967: 12, 1968: 11, 1969: 7, 1970: 5, 1971: 3, 1972: 4, 1973: 8, 1974: 9, 1975: 9, 1979: 8, 1980: 6, 1981: 6,
    1982: 6, 1983: 6, 1984: 6, 1985: 6, 1986: 6, 1987: 10, 1988: 7, 1989: 6, 1990: 6, 1991: 5, 1992: 5, 1993: 5,
    1994: 5, 1995: 5, 1996: 19, 1997: 17, 1998: 6, 2006: 1, 2008: 1, 2009: 3, 2010: 5, 2011: 2, 2014: 2, 2019: 2, 2023: 1 };

  function drawChart() {
    const box = $("#sample-chart");
    const W = 900, H = 420, L = 40, R = 8, T = 44, B = 36;
    const y0 = 1956, y1 = 2025, n = y1 - y0 + 1, max = 20;
    const bw = (W - L - R) / n, gap = 2;
    const x = (yr) => L + (yr - y0) * bw;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-desc"><desc id="chart-desc">Bar chart: days per year with a published conductance sample at Stony Brook. Mostly 3 to 12 days a year from 1956 to 1998, a peak of 19 in 1996, then 17 days in total from 2000 to 2025.</desc>`;
    [5, 10, 15, 20].forEach((v) => { s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 10}" y="${y(v) + 6}" text-anchor="end">${v}</text>`; });
    for (let yr = y0; yr <= y1; yr++) {
      const v = PER_YEAR[yr] || 0;
      const bx = x(yr) + gap / 2, w = bw - gap;
      if (v) {
        const top = y(v), base = y(0), r = Math.min(4, w / 2, base - top);
        s += `<path class="bar" data-yr="${yr}" d="M${bx} ${base} V${top + r} Q${bx} ${top} ${bx + r} ${top} H${bx + w - r} Q${bx + w} ${top} ${bx + w} ${top + r} V${base} Z"/>`;
      }
      s += `<rect class="hit" data-yr="${yr}" x="${x(yr)}" y="${T}" width="${bw}" height="${H - T - B}"/>`;
    }
    s += `<line class="base" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    [1960, 1970, 1980, 1990, 2000, 2010, 2020].forEach((yr) => { s += `<text x="${x(yr) + bw / 2}" y="${H - 8}" text-anchor="middle">${yr}</text>`; });
    // the two things worth reading
    s += `<text class="note" x="${x(1996) + bw / 2}" y="${y(19) - 12}" text-anchor="middle">19 in 1996</text>`;
    const bx0 = x(2000) + 2, bx1 = x(2025) + bw - 2, by = y(7);
    s += `<path class="bracket" d="M${bx0} ${by + 8} V${by} H${bx1} V${by + 8}"/><text class="note" x="${(bx0 + bx1) / 2}" y="${by - 12}" text-anchor="middle">17 days since 2000</text>`;
    s += `</svg>`;
    // table view for screen readers
    s += `<table class="visually-hidden"><caption>Sample days per year</caption><tr><th>Year</th><th>Days</th></tr>${Object.entries(PER_YEAR).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`;
    box.innerHTML = s;

    const tip = $("#tip");
    box.addEventListener("pointermove", (e) => {
      const yr = e.target.dataset?.yr;
      box.querySelectorAll(".bar.hot").forEach((b) => b.classList.remove("hot"));
      if (!yr) { tip.hidden = true; return; }
      const v = PER_YEAR[yr] || 0;
      box.querySelector(`.bar[data-yr="${yr}"]`)?.classList.add("hot");
      tip.textContent = `${yr}: ${v ? `${v} sample day${v > 1 ? "s" : ""}` : "no samples"}`;
      tip.hidden = false;
      tip.style.left = e.clientX + 14 + "px";
      tip.style.top = e.clientY - 34 + "px";
    });
    box.addEventListener("pointerleave", () => { tip.hidden = true; box.querySelectorAll(".bar.hot").forEach((b) => b.classList.remove("hot")); });
  }

  // ---------------------------------------------------------------- mini map (no tiles, works offline)
  function drawMiniMap() {
    const W = 640, H = 540, pad = 46;
    const sites = TapDemo.SITES, ref = TapDemo.REFERENCE;
    const lats = sites.map((s) => s.lat).concat(ref.map((r) => r.lat));
    const lons = sites.map((s) => s.lon).concat(ref.map((r) => r.lon));
    const k = Math.cos((40.35 * Math.PI) / 180);
    const minX = Math.min(...lons) * k, maxX = Math.max(...lons) * k, minY = Math.min(...lats), maxY = Math.max(...lats);
    const sc = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
    const px = (lon) => ox + (lon * k - minX) * sc, py = (lat) => oy + (maxY - lat) * sc;
    let s = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    sites.filter((x) => x.sim).forEach((x) => {
      s += `<circle cx="${px(x.lon)}" cy="${py(x.lat)}" r="7" fill="none" stroke="var(--silt)" stroke-width="2" stroke-dasharray="3 3"/>`;
    });
    ref.forEach((r) => {
      const cx = px(r.lon), cy = py(r.lat);
      s += `<rect x="${cx - 7}" y="${cy - 7}" width="14" height="14" transform="rotate(45 ${cx} ${cy})" fill="rgba(157,188,224,.25)" stroke="var(--survey)" stroke-width="3"/>`;
      s += `<text class="label-pub" x="${cx + 14}" y="${cy + 22}">${r.site}</text>`;
    });
    const t = sites.find((x) => !x.sim);
    s += `<circle cx="${px(t.lon)}" cy="${py(t.lat)}" r="11" fill="var(--clear)" stroke="var(--text)" stroke-width="2"/>`;
    s += `<text class="label-tank" x="${px(t.lon) + 18}" y="${py(t.lat) - 10}">TapTest tank</text>`;
    s += `</svg>`;
    $("#mini-map").innerHTML = s;
  }

  drawChart();
  drawMiniMap();
  fit();
  show(fromHash());
})();
