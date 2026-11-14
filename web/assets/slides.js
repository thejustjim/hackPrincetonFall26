/* Pitch deck motion. Slides sit on top of each other; a scroll, key or swipe plays one slow
   transition: the current slide drifts up and blurs away, a drop lands on the water behind
   the glass, the light pools ease to a new arrangement (parallax), and the next slide's
   headline rises word by word while its glass panels float up out of a soft blur.
   Phones get a plain scrolling page; reduced motion gets a short crossfade. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const slides = [...document.querySelectorAll(".slide")];
  const phone = window.matchMedia("(max-width: 760px)");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const deckMode = () => !phone.matches;

  // timing, in ms. Slow on purpose.
  const EXIT = 1100;          // outgoing slide drifts away
  const ENTER_AT = 650;       // incoming starts while the old one is still fading
  const WORD = 1500;          // each headline word rising
  const WORD_GAP = 70;
  const PANEL = 1800;         // each panel floating up
  const PANEL_GAP = 160;
  const LOCK = 1700;          // ignore new input until the scene has mostly settled
  const LUX = "cubic-bezier(0.16, 1, 0.3, 1)";      // long, soft landing
  const SOFT = "cubic-bezier(0.45, 0, 0.55, 1)";    // gentle in and out

  document.documentElement.classList.add("js-deck");

  // ---------------------------------------------------------------- water behind the glass
  const water = window.TapWater && TapWater.create($("#water"), { still: still.matches });
  if (water) document.documentElement.classList.add("has-water");

  // ---------------------------------------------------------------- frame scale
  function fit() {
    const s = Math.min(innerWidth / 1600, innerHeight / 900);
    document.documentElement.style.setProperty("--s", s.toFixed(4));
  }

  // ---------------------------------------------------------------- headlines: one span per word
  document.querySelectorAll(".slide h1, .slide h2").forEach((h) => {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const words = h.textContent.trim().split(/\s+/);
    h.setAttribute("aria-label", h.textContent.trim());
    h.innerHTML = words.map((w) => `<span class="w" aria-hidden="true"><span>${esc(w)}</span></span>`).join(" ");
  });

  // what moves on each slide, in reveal order
  const parts = slides.map((s) => ({
    words: [...s.querySelectorAll(".w > span")],
    panels: [...s.querySelectorAll("[data-depth]")].filter((el) => !el.matches("h1, h2")),
    all: [...s.querySelectorAll("[data-depth]")],
  }));

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
  function mark(n) {
    dots.forEach((b, i) => b.setAttribute("aria-current", i === n ? "true" : "false"));
    $("#count").textContent = `${n + 1} / ${slides.length}`;
    if (location.hash !== `#${n + 1}`) history.replaceState(null, "", `#${n + 1}`);
  }

  // ---------------------------------------------------------------- transitions
  const settle = (els) => els.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
  let pending = [];                                    // this slide's scheduled ripples
  const later = (ms, fn) => pending.push(setTimeout(fn, ms));
  const clearPending = () => { pending.forEach(clearTimeout); pending = []; };
  const cup = () => window.TapCup3D;

  // a ripple that comes from an element: centred on it, sized to it
  function rippleFrom(rect, strength) {
    if (!water || !rect || !rect.width) return;
    const size = Math.min(1.5, Math.max(0.45, Math.sqrt(rect.width * rect.height) / (0.32 * innerHeight)));
    water.drop(rect.left + rect.width / 2, rect.top + rect.height / 2, strength, size);
  }
  const focusOf = (s) => (s.dataset.focus ? s.querySelector(s.dataset.focus) : null);
  const echoesOf = (s) => (s.dataset.echo ? [...s.querySelectorAll(s.dataset.echo)] : []);

  function enter(i, dir, delay) {
    const s = slides[i];
    const { words, panels } = parts[i];
    settle(words.concat(panels));
    // measure where the focus and echoes will rest, before anything starts moving
    const focus = focusOf(s), echoes = echoesOf(s);
    const focusRect = focus && focus.getBoundingClientRect();
    const echoRects = echoes.map((el) => el.getBoundingClientRect());
    if (still.matches) {
      s.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: "both" });
      return;
    }
    words.forEach((w, k) => w.animate(
      [{ transform: `translateY(${dir >= 0 ? 108 : -108}%)`, opacity: 0, filter: "blur(6px)" },
       { transform: "none", opacity: 1, filter: "blur(0)" }],
      { duration: WORD, delay: delay + k * WORD_GAP, easing: LUX, fill: "both" }));
    const wordsLand = delay + Math.max(0, words.length - 1) * WORD_GAP + WORD * 0.4;
    const start = delay + 220 + Math.min(words.length, 6) * WORD_GAP;
    const lands = new Map();                           // element -> ms when it has mostly settled
    panels.forEach((el, k) => {
      el.animate(
        [{ opacity: 0, transform: `translateY(${dir >= 0 ? 46 : -46}px) scale(0.985)`, filter: "blur(12px)" },
         { opacity: 1, transform: "none", filter: "blur(0)" }],
        { duration: PANEL, delay: start + k * PANEL_GAP, easing: LUX, fill: "both" });
      lands.set(el, start + k * PANEL_GAP + PANEL * 0.4);
    });
    const landing = (el) => lands.get(el.closest("[data-depth]")) ?? wordsLand;

    // The hierarchy decides the water: the focus lands first and strongest, sized to itself;
    // echoes follow it as small ripples, one at a time, in reading order.
    let t = 0;
    if (focus) {
      t = landing(focus);
      if (i === 0) {
        // the cup loads as a module and may arrive late: decide when the slide lands
        later(t, () => {
          if (!cup()) return rippleFrom(focusRect, 1);
          cup().play();                                 // the cup's own drop lands 2.2 s into its pour,
          later(2200, () => rippleFrom(focusRect, 1));  // and the water outside answers it
        });
      } else {
        later(t, () => rippleFrom(focusRect, 1));
      }
    }
    echoes.forEach((el, k) => {
      t = Math.max(landing(el), focus ? t + 320 : t + 170);
      later(t, () => rippleFrom(echoRects[k], focus ? 0.38 : 0.5));
    });
  }

  function exit(i, dir) {
    const els = parts[i].all;
    const s = slides[i];
    s.classList.add("leaving");
    // the old focus lets go with a faint ripple: immediate feedback for the input
    const f = focusOf(s) || echoesOf(s)[0] || els[0];
    if (f) rippleFrom(f.getBoundingClientRect(), 0.22);
    const done = () => {
      s.classList.remove("leaving");
      if (!s.classList.contains("on")) { settle(els); settle(parts[i].words); if (i === 0) cup()?.setActive(false); }
    };
    if (still.matches) {
      return s.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "both" }).finished
        .then(() => { s.getAnimations().forEach((a) => a.cancel()); done(); });
    }
    const runs = els.map((el, k) => el.animate(
      [{ opacity: 1, transform: "none", filter: "blur(0)" },
       { opacity: 0, transform: `translateY(${dir >= 0 ? -30 : 30}px)`, filter: "blur(10px)" }],
      { duration: EXIT, delay: k * 45, easing: SOFT, fill: "both" }));
    return Promise.all(runs.map((a) => a.finished.catch(() => {}))).then(done);
  }

  let at = -1, lockedUntil = 0, queued = 0;
  function go(n, opts = {}) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    if (n === at) return;
    const now = performance.now();
    if (!opts.force && now < lockedUntil) { queued = Math.sign(n - at); return; }
    const dir = at < 0 ? 1 : Math.sign(n - at);
    const from = at;
    at = n;
    mark(n);
    if (!deckMode()) { slides[n].scrollIntoView({ behavior: still.matches ? "auto" : "smooth" }); return; }

    lockedUntil = now + (still.matches ? 400 : LOCK);
    clearPending();
    if (from >= 0) {
      slides[from].classList.remove("on");
      exit(from, dir);
    }
    slides[n].classList.add("on");
    if (n === 0) cup()?.setActive(true);
    enter(n, dir, from >= 0 ? ENTER_AT : 250);
    water?.pan(n);
    setTimeout(() => {           // one queued step, so a second flick isn't lost
      if (queued && performance.now() >= lockedUntil) { const q = queued; queued = 0; go(at + q); }
    }, (still.matches ? 400 : LOCK) + 20);
  }

  // the 3D cup loads as a module, after this script: sync it with wherever we are
  window.addEventListener("cup3d:ready", () => { cup().setActive(at === 0 && deckMode()); });

  // ---------------------------------------------------------------- input
  let acc = 0, lastWheel = 0, quietUntil = 0;
  window.addEventListener("wheel", (e) => {
    if (!deckMode() || e.ctrlKey) return;
    e.preventDefault();
    const now = performance.now(), gap = now - lastWheel;
    lastWheel = now;
    if (now < lockedUntil) { quietUntil = now + 220; return; }        // swallow the fling's tail
    if (now < quietUntil && gap < 220) { quietUntil = now + 220; return; }
    acc += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(acc) > 30) { const d = Math.sign(acc); acc = 0; go(at + d); }
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    if (!deckMode() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(at + 1); }
    else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(slides.length - 1); }
    else if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
  });

  let touchY = null;
  document.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener("touchmove", (e) => { if (deckMode()) e.preventDefault(); }, { passive: false });
  document.addEventListener("touchend", (e) => {
    if (touchY == null || !deckMode()) return;
    const dy = touchY - e.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(dy) > 40) go(at + Math.sign(dy));
  });

  // the water answers the pointer: a press makes a ripple, gliding over glass leaves faint ones
  document.addEventListener("pointerdown", (e) => {
    if (!water || e.target.closest("a, button, .chart-box")) return;
    water.drop(e.clientX, e.clientY, 0.5, 0.75);
  });
  let lastTrail = 0, trailX = 0, trailY = 0;
  document.addEventListener("pointermove", (e) => {
    if (!water || e.pointerType !== "mouse" || !deckMode()) return;
    const now = performance.now();
    if (now - lastTrail < 650 || !e.target.closest(".slide.on .glass")) return;
    if (Math.hypot(e.clientX - trailX, e.clientY - trailY) < 60) return;
    lastTrail = now; trailX = e.clientX; trailY = e.clientY;
    water.drop(e.clientX, e.clientY, 0.14, 0.5);
  }, { passive: true });

  window.addEventListener("hashchange", () => {
    const n = (parseInt(location.hash.slice(1), 10) || 1) - 1;
    if (n !== at) go(n, { force: true });
  });
  window.addEventListener("resize", fit);

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
    // published sites sit close together, so their labels go in a column with leader lines
    const pubs = ref.map((r) => ({ r, cx: px(r.lon), cy: py(r.lat) })).sort((a, b) => a.cx - b.cx);   // left to right: the leaders fan out without crossing
    pubs.forEach((p, k) => {
      const ly = 74 + k * 40, colX = W - 26;
      const text = `${p.r.site} ~${p.r.typical_tds_est} ppm`;
      const x0 = colX - text.length * 7.7 - 12;
      s += `<path d="M${p.cx + 6} ${p.cy - 6} L${x0} ${ly - 5} H${x0 + 4}" fill="none" stroke="var(--neutral)" stroke-width="1"/>`;
      s += `<text class="label-pub" x="${colX}" y="${ly}" text-anchor="end">${text}</text>`;
    });
    pubs.forEach(({ cx, cy }) => {
      s += `<rect class="pub" x="${cx - 7}" y="${cy - 7}" width="14" height="14" transform="rotate(45 ${cx} ${cy})" fill="rgba(247,240,240,.15)" stroke="var(--text)" stroke-width="2.5"/>`;
    });
    const t = sites.find((x) => !x.sim);
    s += `<circle cx="${px(t.lon)}" cy="${py(t.lat)}" r="18" fill="rgba(90,155,189,.18)"/>`;
    s += `<circle class="tank" cx="${px(t.lon)}" cy="${py(t.lat)}" r="10" fill="var(--accent)" stroke="var(--text)" stroke-width="2"/>`;
    s += `<text class="label-tank" x="${px(t.lon) - 20}" y="${py(t.lat) + 5}" text-anchor="end">TapTest tank</text>`;
    s += `</svg>`;
    $("#mini-map").innerHTML = s;
  }

  // ---------------------------------------------------------------- start
  drawChart();
  drawMiniMap();
  fit();
  const first = (parseInt(location.hash.slice(1), 10) || 1) - 1;
  if (deckMode()) go(first, { force: true });
  else { at = first; mark(first); slides.forEach((s) => s.classList.add("on")); }
  phone.addEventListener("change", () => location.reload());
})();
