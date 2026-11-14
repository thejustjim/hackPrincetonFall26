/* Pitch deck motion. One full-screen section per slide. A scroll, key or swipe glides to the
   next slide on a slow ease; elements marked data-depth move at different speeds (parallax),
   the pools of light behind the glass drift, and a ripple spreads from the middle like a drop
   landing in a cup. Phones get a plain scrolling page; reduced motion jumps without effects. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const slides = [...document.querySelectorAll(".slide")];
  const phone = window.matchMedia("(max-width: 760px)");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const GLIDE_MS = 1500;
  document.documentElement.classList.add("js-deck");

  // ---------------------------------------------------------------- frame scale
  function fit() {
    const s = Math.min(innerWidth / 1600, innerHeight / 900);
    document.documentElement.style.setProperty("--s", s.toFixed(4));
  }

  // ---------------------------------------------------------------- dots + count
  const dots = slides.map((s, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", `Slide ${i + 1}: ${s.getAttribute("aria-label")}`);
    b.addEventListener("click", () => go(i));
    li.append(b);
    $("#dots").append(li);
    return b;
  });
  let at = 0;
  function mark(n) {
    dots.forEach((b, i) => b.setAttribute("aria-current", i === n ? "true" : "false"));
    $("#count").textContent = `${n + 1} / ${slides.length}`;
    if (location.hash !== `#${n + 1}`) history.replaceState(null, "", `#${n + 1}`);
  }

  // ---------------------------------------------------------------- the glide
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let glide = null;          // {from, to, t0}
  let quietUntil = 0;        // swallow the tail of a trackpad fling after a glide
  const animating = () => glide !== null;

  function go(n, opts = {}) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    const to = slides[n].offsetTop;
    at = n;
    mark(n);
    if (opts.instant || still.matches || phone.matches) {
      window.scrollTo(0, to);
      paint(performance.now());
      return;
    }
    if (Math.abs(scrollY - to) < 2) return;
    glide = { from: scrollY, to, t0: performance.now() };
    ripple(innerWidth / 2, innerHeight / 2, { strength: 1 });
    kick();
  }

  // ---------------------------------------------------------------- input
  let acc = 0, lastWheel = 0;
  window.addEventListener("wheel", (e) => {
    if (phone.matches || e.ctrlKey) return;
    e.preventDefault();
    const now = performance.now(), gap = now - lastWheel;
    lastWheel = now;
    if (animating()) return;
    if (now < quietUntil && gap < 180) { quietUntil = now + 180; return; }
    acc += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(acc) > 24) { const dir = Math.sign(acc); acc = 0; go(at + dir); }
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    if (phone.matches || e.metaKey || e.ctrlKey || e.altKey) return;
    if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); if (!animating()) go(at + 1); }
    else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); if (!animating()) go(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(slides.length - 1); }
    else if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
  });

  let touchY = null;
  document.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener("touchmove", (e) => { if (!phone.matches) e.preventDefault(); }, { passive: false });
  document.addEventListener("touchend", (e) => {
    if (touchY == null || phone.matches) return;
    const dy = touchY - e.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(dy) > 40 && !animating()) go(at + Math.sign(dy));
  });

  // a tap on open water makes a small ripple
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, .chart-box")) return;
    ripple(e.clientX, e.clientY, { strength: 0.6, maxR: 420, dur: 2200 });
  });

  // focus or find-in-page can scroll on their own: keep the dots honest
  window.addEventListener("scroll", () => {
    if (animating()) return;
    const n = Math.round(scrollY / innerHeight);
    if (!phone.matches && n !== at) { at = n; mark(n); }
    kick();
  }, { passive: true });

  // ---------------------------------------------------------------- parallax
  const layers = slides.map((s) => [...s.querySelectorAll("[data-depth]")].map((el) => [el, Number(el.dataset.depth)]));
  const pools = [...document.querySelectorAll(".scene .pool")];

  function parallax() {
    if (phone.matches || still.matches) return;
    const vh = innerHeight, y = scrollY;
    slides.forEach((s, i) => {
      const p = (s.offsetTop - y) / vh;          // 0 in place, 1 just below, -1 just above
      if (Math.abs(p) > 1.05) return;
      for (const [el, d] of layers[i]) {
        el.style.transform = `translate3d(0, ${(p * d * 340).toFixed(1)}px, 0)`;
        el.style.opacity = Math.max(0, 1 - Math.abs(p) * (0.5 + d * 0.7)).toFixed(3);
      }
    });
    const t = y / vh;                              // slides travelled, as a float
    const drift = [[0.8, 0.6, 7, 9], [-0.6, 0.9, 6, 7], [0.5, -0.7, 8, 6], [-0.9, 0.5, 5, 5]];
    pools.forEach((el, k) => {
      const [fx, fy, ax, ay] = drift[k];
      el.style.transform = `translate3d(${(Math.sin(t * fx) * ax).toFixed(2)}vw, ${(Math.cos(t * fy) * ay).toFixed(2)}vh, 0)`;
    });
  }

  // ---------------------------------------------------------------- ripples
  const canvas = $("#ripples");
  const ctx = canvas.getContext("2d");
  let dpr = 1;
  const ripples = [];
  function sizeCanvas() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  function ripple(x, y, o = {}) {
    if (still.matches) return;
    ripples.push({ x, y, t0: performance.now(), strength: o.strength ?? 1,
                   maxR: o.maxR ?? Math.hypot(innerWidth, innerHeight) * 0.72, dur: o.dur ?? 2800 });
    kick();
  }
  function drawRipples(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      const q = (now - r.t0) / r.dur;
      if (q >= 1) { ripples.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - q, 3);            // fast start, long settle
      for (let k = 0; k < 4; k++) {
        const rad = (e * r.maxR - k * r.maxR * 0.085) * dpr;
        if (rad <= 0) continue;
        const a = Math.pow(1 - q, 1.7) * r.strength * (1 - k * 0.24);
        ctx.beginPath();
        ctx.arc(r.x * dpr, r.y * dpr, rad, 0, Math.PI * 2);
        ctx.lineWidth = (18 * (1 - q) + 3) * dpr;
        ctx.strokeStyle = `rgba(90, 155, 189, ${(a * 0.16).toFixed(3)})`;
        ctx.stroke();
        ctx.lineWidth = 1.25 * dpr;
        ctx.strokeStyle = `rgba(247, 240, 240, ${(a * 0.42).toFixed(3)})`;
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- one loop, only while needed
  let running = false;
  function paint(now) {
    if (glide) {
      const t = Math.min(1, (now - glide.t0) / GLIDE_MS);
      window.scrollTo(0, glide.from + (glide.to - glide.from) * ease(t));
      if (t >= 1) { glide = null; quietUntil = now + 450; acc = 0; }
    }
    parallax();
    drawRipples(now);
  }
  function loop(now) {
    paint(now);
    if (glide || ripples.length) requestAnimationFrame(loop);
    else running = false;
  }
  function kick() {
    if (!running) { running = true; requestAnimationFrame(loop); }
  }

  // Re-align to the current slide only in deck mode. On phones the page scrolls freely, and
  // mobile browsers fire resize whenever the address bar shows or hides.
  const realign = () => { if (!phone.matches && !animating()) go(at, { instant: true }); };
  window.addEventListener("resize", () => { fit(); sizeCanvas(); realign(); });
  phone.addEventListener("change", () => { fit(); realign(); });

  // ---------------------------------------------------------------- cups
  document.querySelectorAll("[data-cup]").forEach((el) => { el.innerHTML = TapCup.svg(JSON.parse(el.dataset.cup)); });

  // ---------------------------------------------------------------- sample chart
  // Days with a published specific-conductance sample at Stony Brook (USGS-01401000 and the
  // NJ DEP stations on the same reach), counted from the Water Quality Portal, Nov 2026.
  const PER_YEAR = { 1956: 2, 1957: 1, 1958: 1, 1959: 1, 1960: 4, 1961: 4, 1962: 4, 1963: 5, 1964: 3, 1965: 3, 1966: 10,
    1967: 12, 1968: 11, 1969: 7, 1970: 5, 1971: 3, 1972: 4, 1973: 8, 1974: 9, 1975: 9, 1979: 8, 1980: 6, 1981: 6,
    1982: 6, 1983: 6, 1984: 6, 1985: 6, 1986: 6, 1987: 10, 1988: 7, 1989: 6, 1990: 6, 1991: 5, 1992: 5, 1993: 5,
    1994: 5, 1995: 5, 1996: 19, 1997: 17, 1998: 6, 2006: 1, 2008: 1, 2009: 3, 2010: 5, 2011: 2, 2014: 2, 2019: 2, 2023: 1 };

  function drawChart() {
    const box = $("#sample-chart");
    const W = 900, H = 380, L = 40, R = 8, T = 40, B = 36;
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
    s += `<text class="note" x="${x(1996) + bw / 2}" y="${y(19) - 12}" text-anchor="middle">19 in 1996</text>`;
    const bx0 = x(2000) + 2, bx1 = x(2025) + bw - 2, by = y(7);
    s += `<path class="bracket" d="M${bx0} ${by + 8} V${by} H${bx1} V${by + 8}"/><text class="note" x="${(bx0 + bx1) / 2}" y="${by - 12}" text-anchor="middle">17 days since 2000</text>`;
    s += `</svg>`;
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
      tip.style.top = e.clientY - 40 + "px";
    });
    box.addEventListener("pointerleave", () => { tip.hidden = true; box.querySelectorAll(".bar.hot").forEach((b) => b.classList.remove("hot")); });
  }

  // ---------------------------------------------------------------- mini map (no tiles, works offline)
  function drawMiniMap() {
    const W = 640, H = 520, pad = 50;
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
      s += `<circle cx="${px(x.lon)}" cy="${py(x.lat)}" r="7" fill="none" stroke="var(--neutral)" stroke-width="2" stroke-dasharray="3 3"/>`;
    });
    ref.forEach((r) => {
      const cx = px(r.lon), cy = py(r.lat);
      s += `<rect x="${cx - 7}" y="${cy - 7}" width="14" height="14" transform="rotate(45 ${cx} ${cy})" fill="rgba(247,240,240,.15)" stroke="var(--text)" stroke-width="2.5"/>`;
      s += `<text class="label-pub" x="${cx + 14}" y="${cy + 22}">${r.site}</text>`;
    });
    const t = sites.find((x) => !x.sim);
    s += `<circle cx="${px(t.lon)}" cy="${py(t.lat)}" r="18" fill="rgba(90,155,189,.18)"/>`;
    s += `<circle cx="${px(t.lon)}" cy="${py(t.lat)}" r="10" fill="var(--accent)" stroke="var(--text)" stroke-width="2"/>`;
    s += `<text class="label-tank" x="${px(t.lon) + 18}" y="${py(t.lat) - 12}">TapTest tank</text>`;
    s += `</svg>`;
    $("#mini-map").innerHTML = s;
  }

  // ---------------------------------------------------------------- start
  drawChart();
  drawMiniMap();
  fit();
  sizeCanvas();
  const start = (parseInt(location.hash.slice(1), 10) || 1) - 1;
  requestAnimationFrame(() => go(start, { instant: true }));
  window.addEventListener("hashchange", () => {
    const n = (parseInt(location.hash.slice(1), 10) || 1) - 1;
    if (n !== at) go(n);
  });
})();
