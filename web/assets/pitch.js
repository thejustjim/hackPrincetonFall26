/* The pitch. It runs on top of the live /demo page, which is already loaded underneath.

   Arriving at /pitch lands here (see pitch/index.html and the script in demo/index.html's head):
     1. The page opens on black, on a glass of clear water. One dirty drop gathers and falls in.
     2. On impact the page colour comes up, the title rises beside the glass, and the water turns
        brown. In a wide window the glass then stays on stage for the whole deck. With no filter it
        stays as measured. "One cup, one loop" keeps the original water while it is interpreted,
        adds the filter for Act, then shows the retest at Compare, a step per press. The savings
        slide shows a different, in-range cup passing through without a filter.
     3. Scroll, swipe or use the arrow keys to move through the slides (pitch/slides.html).
     4. Going on past the last slide fades the pitch away, and what is left is /demo. The pitch
        is removed from the page at that point, so there is no way back up to it.

   Wide screens show one slide at a time. Narrow ones get a scrolling column that hands over when
   its end is reached. */
(function () {
  "use strict";
  const root = document.documentElement;
  if (!root.classList.contains("pitching")) return;

  const here = document.currentScript.src;
  const SLIDES_URL = new URL("../pitch/slides.html", here);
  const DEMO_PATH = new URL("../demo/", here).pathname;
  const host = document.getElementById("pitch");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wide = matchMedia("(min-width: 1181px) and (min-height: 480px)");   // the demo's own breakpoint
  const HOLD = 1300;                  // how long a slide change takes; input waits for it
  const $ = (sel) => host.querySelector(sel);

  let slides = [], at = 0, revealed = false, done = false, doneAt = 0;
  let holdUntil = 0, armed = true, lastWheel = 0, pile = 0, restTimer = 0;

  // ---------------------------------------------------------------- handing over to the demo
  /* The wide-screen glass follows the loop's four steps. Keep the measured water until Compare:
       raw      the cup as poured, with no filter.
       hang     Interpret: hold the untreated drop while a filter is chosen.
       catch    Act: the filter snaps in and the water clears; the clear drop is held, since the retest is still to come.
       release  Compare: show the retested water and release the filtered drop.
       bypass   a separate, in-range cup: no filter is needed.
       run      the filtered example repeats on the optional detail slides.
     A slide that names several scenes has that many steps: each press moves on one. */
  const DIRTY = { ph: 6.9, tds: 640, clarity: 0.42, verdict: "CLOUDY" };
  const RETEST = { ph: 7.1, tds: 8, clarity: 0.98, verdict: "SAFE" };
  const IN_RANGE = { ph: 7.2, tds: 136, clarity: 0.96, verdict: "SAFE" };
  const raw = (g) => { g.setSource(DIRTY, false); g.setWater(DIRTY, false, true); g.step?.(null); };
  const scene = (phase, water, filtered = true) => (g) => {
    g.setSource(DIRTY, filtered); g.setWater(water); g.step?.(phase);
  };
  const SCENES = {
    raw, hang: scene("hang", DIRTY, false), catch: scene("catch", null),
    release: scene("release", RETEST), run: scene(null, RETEST),
    bypass: (g) => { g.setSource(IN_RANGE, false); g.setWater(IN_RANGE); g.step?.(null); },
  };
  let sub = 0;                                                  // which step of the current slide
  const stepsOf = (s) => (s.dataset.scene || "").split(" ").filter(Boolean);
  function stage() {
    const slide = slides[at], names = stepsOf(slide);
    slide.querySelectorAll("[data-step]").forEach((el, k) => {
      el.classList.toggle("is", k === sub);
      el.classList.toggle("done", k < sub);
    });
    if (window.TapHero?.setSource && wide.matches && !done) SCENES[names[Math.min(sub, names.length - 1)]]?.(TapHero);
  }

  function finish(instant) {
    if (done) return;
    done = true;
    doneAt = performance.now();
    clearTimeout(restTimer);
    root.classList.remove("opening", "pitching");
    try { history.replaceState(null, "", DEMO_PATH + location.search); } catch (e) { /* opened as a file */ }
    window.scrollTo(0, 0);
    document.body.classList.add("ready");
    // The glass glides from its place in the pitch to its place in the demo. The demo's words and
    // notes come in once it has arrived, so the notes are measured against where it ends up.
    const arrive = () => {
      if (window.TapApp) { document.body.classList.add("live"); TapApp.refresh(); }   // else app.js does this when it starts
      window.dispatchEvent(new Event("resize"));
    };
    if (instant || reduced || !wide.matches) arrive(); else setTimeout(arrive, 1500);
    window.TapHero?.step?.(null);                     // the drops go back to their own timing
    window.TapHero?.setRunning(true);
    host.classList.add("leaving");
    removeEventListener("keydown", onKey);
    removeEventListener("touchstart", onTouchStart);
    removeEventListener("touchend", onTouchEnd);
    setTimeout(() => host.remove(), instant || reduced ? 0 : 2100);
  }

  // ---------------------------------------------------------------- moving between slides
  function show(n, back) {
    at = n;
    sub = back ? Math.max(0, stepsOf(slides[n]).length - 1) : 0;   // coming back to a slide lands on its last step
    slides.forEach((s, k) => {
      s.classList.remove("stepping");
      s.classList.toggle("past", k < n);
      s.classList.toggle("on", k === n);
      s.classList.toggle("in", k === n);
      s.inert = wide.matches && k !== n;
    });
    host.dataset.at = n;
    $(".p-count").textContent = `${n + 1} / ${slides.length}`;
    window.TapHero?.setRunning(true);                 // the glass is on stage for every slide
    stage();
  }
  function go(step) {
    if (done || !revealed || !wide.matches) return false;
    const now = performance.now();
    if (now < holdUntil) return false;
    const last = stepsOf(slides[at]).length - 1;
    if ((step > 0 && sub < last) || (step < 0 && sub > 0)) {      // another step of the same slide
      sub += step;
      holdUntil = now + 800;
      slides[at].classList.add("stepping");
      stage();
      return true;
    }
    const n = at + step;
    if (n < 0) return false;
    holdUntil = now + HOLD;
    if (n >= slides.length) finish(); else show(n, step < 0);
    return true;
  }

  function onWheel(e) {
    const now = performance.now(), gap = now - lastWheel;
    lastWheel = now;
    if (done) {
      // the same flick that ended the pitch must not also scroll the demo
      if (now - doneAt > 1500 && gap > 140) { removeEventListener("wheel", onWheel, true); return; }
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (!wide.matches) return;                       // the column scrolls by itself
    e.preventDefault(); e.stopPropagation();
    if (e.ctrlKey) return;
    // one gesture, one slide: wait for the trackpad's glide to stop before listening again
    if (!armed) { if (gap > 140 && now >= holdUntil) armed = true; else return; }
    if (gap > 250) pile = 0;
    pile += e.deltaY * (e.deltaMode === 1 ? 32 : 1);
    if (Math.abs(pile) >= 40) { if (go(pile > 0 ? 1 : -1)) armed = false; pile = 0; }
  }
  function onKey(e) {
    if (done || !wide.matches || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const fwd = k === "ArrowDown" || k === "ArrowRight" || k === "PageDown" || k === "Enter" || (k === " " && !e.shiftKey);
    const back = k === "ArrowUp" || k === "ArrowLeft" || k === "PageUp" || (k === " " && e.shiftKey);
    if (fwd || back) { e.preventDefault(); go(fwd ? 1 : -1); }
    else if ((k === "Home" || k === "End") && revealed && performance.now() >= holdUntil) {
      e.preventDefault(); holdUntil = performance.now() + HOLD; show(k === "Home" ? 0 : slides.length - 1);
    }
  }
  let touchY = null;
  function onTouchStart(e) { touchY = e.touches.length === 1 ? e.touches[0].clientY : null; }
  function onTouchEnd(e) {
    if (touchY == null || !wide.matches) return;
    const dy = touchY - e.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(dy) > 50) go(dy > 0 ? 1 : -1);
  }

  // ---------------------------------------------------------------- layout
  // slides are drawn 900 units tall and at least 1600 wide, then scaled to the window
  function fit() { host.style.setProperty("--s", Math.min(innerWidth / 1600, innerHeight / 900).toFixed(4)); }
  function mode() {
    host.classList.toggle("stacked", !wide.matches);
    if (wide.matches) { host.scrollTop = 0; if (revealed) show(at); }
    else {
      slides.forEach((s) => { s.inert = false; s.classList.remove("past"); });
      window.TapHero?.setRunning(true);
      if (revealed) slides.forEach((s) => s.classList.add("in"));
    }
  }

  // ---------------------------------------------------------------- the opening
  function reveal() {
    if (revealed || done) return;
    revealed = true;
    root.classList.remove("opening");               // the page colour comes up from black
    if (wide.matches) show(0); else slides.forEach((s) => s.classList.add("in"));
  }
  function open() {
    const start = () => {
      document.body.classList.add("ready");          // the glass fades up out of the dark
      TapHero.setWater(null, true);                  // clear water, whatever the latest reading is
      TapHero.setSource?.(DIRTY, false);             // and a first dirty drop, with nothing to catch it
      if (reduced) { reveal(); return; }
      addEventListener("hero3d:impact", reveal, { once: true });
      setTimeout(() => TapHero.drip(0.5), 1300);    // the first drop, at half speed
    };
    if (window.TapHero) start(); else addEventListener("hero3d:ready", start, { once: true });
    // Carry on regardless if there is no 3D glass after five seconds, or if nothing has landed after
    // sixteen (the drop takes about six; a machine dropping frames plays it slower, and it is worth the wait).
    setTimeout(() => { if (!window.TapHero) reveal(); }, 5000);
    setTimeout(reveal, 16000);
  }

  // ---------------------------------------------------------------- the problem slide: sample days per year
  // Days each year with a published specific-conductance sample for Stony Brook at Princeton
  // (USGS 01401000 and the NJ DEP stations at the same spot), from the Water Quality Portal.
  const PER_YEAR = { 1956: 2, 1957: 1, 1958: 1, 1959: 1, 1960: 4, 1961: 4, 1962: 4, 1963: 5, 1964: 3, 1965: 3, 1966: 10,
    1967: 12, 1968: 11, 1969: 7, 1970: 5, 1971: 3, 1972: 4, 1973: 8, 1974: 9, 1975: 9, 1979: 8, 1980: 6, 1981: 6,
    1982: 6, 1983: 6, 1984: 6, 1985: 6, 1986: 6, 1987: 10, 1988: 7, 1989: 6, 1990: 6, 1991: 5, 1992: 5, 1993: 5,
    1994: 5, 1995: 5, 1996: 19, 1997: 17, 1998: 6, 2006: 1, 2008: 1, 2009: 3, 2010: 5, 2011: 2, 2014: 2, 2019: 2, 2023: 1 };

  function drawChart() {
    const box = $("#sample-chart");
    if (!box) return;
    const W = 1000, H = 400, L = 6, R = 6, T = 44, B = 40;
    const y0 = 1956, y1 = 2026, n = y1 - y0 + 1, max = 20;
    const bw = (W - L - R) / n, gap = 3;
    const x = (yr) => L + (yr - y0) * bw;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart: days per year with a published conductance sample at Stony Brook. Mostly 3 to 12 days a year from 1956 to 1998, a peak of 19 in 1996, then 17 days in total since 2000 and none since 2023.">`;
    for (let yr = y0; yr <= y1; yr++) {
      const v = PER_YEAR[yr] || 0;
      if (v) s += `<rect class="col" data-yr="${yr}" x="${(x(yr) + gap / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}"/>`;
      s += `<rect class="hit" data-yr="${yr}" x="${x(yr).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/>`;
    }
    s += `<line class="base" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    [1960, 1970, 1980, 1990, 2000, 2010, 2020].forEach((yr) => { s += `<text x="${(x(yr) + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${yr}</text>`; });
    const bx0 = x(2000) + 2, bx1 = x(y1) + bw - 2, by = y(7.5);
    s += `<path class="bracket" d="M${bx0.toFixed(1)} ${by + 8} V${by} H${bx1.toFixed(1)} V${by + 8}"/><text class="note" x="${((bx0 + bx1) / 2).toFixed(1)}" y="${by - 12}" text-anchor="middle">2000 to today</text>`;
    s += `</svg>`;
    box.innerHTML = s;

    const tip = document.getElementById("tip");
    if (!tip) return;
    const cool = () => { tip.hidden = true; box.querySelectorAll(".col.hot").forEach((b) => b.classList.remove("hot")); };
    box.addEventListener("pointermove", (e) => {
      const yr = e.target.dataset?.yr;
      cool();
      if (!yr) return;
      const v = PER_YEAR[yr] || 0;
      box.querySelector(`.col[data-yr="${yr}"]`)?.classList.add("hot");
      tip.textContent = `${yr}: ${v ? `${v} sample day${v > 1 ? "s" : ""}` : "no samples"}`;
      tip.hidden = false;
      tip.style.zIndex = 60;
      tip.style.left = e.clientX + 14 + "px";
      tip.style.top = e.clientY - 40 + "px";
    });
    box.addEventListener("pointerleave", cool);
  }

  // ---------------------------------------------------------------- the sources slide: a sketch map (no tiles, works offline)
  function drawMiniMap() {
    const box = $("#mini-map");
    if (!box || !window.TapSample) return;
    const W = 560, H = 520, pad = 40;
    const sites = TapSample.SITES, ref = TapSample.REFERENCE;
    const lats = sites.map((s) => s.lat).concat(ref.map((r) => r.lat));
    const lons = sites.map((s) => s.lon).concat(ref.map((r) => r.lon));
    const k = Math.cos((40.35 * Math.PI) / 180);
    const minX = Math.min(...lons) * k, maxX = Math.max(...lons) * k, minY = Math.min(...lats), maxY = Math.max(...lats);
    const sc = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
    const px = (lon) => ox + (lon * k - minX) * sc, py = (lat) => oy + (maxY - lat) * sc;
    let s = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    sites.filter((x) => x.sim).forEach((x) => {
      s += `<circle cx="${px(x.lon).toFixed(1)}" cy="${py(x.lat).toFixed(1)}" r="7" fill="none" stroke="var(--neutral)" stroke-width="2" stroke-dasharray="3 3"/>`;
    });
    // published sites: a diamond each, named on the side away from the tank
    const t = sites.find((x) => !x.sim), tx = px(t.lon);
    ref.forEach((r) => {
      const cx = px(r.lon), cy = py(r.lat), left = cx < tx;
      s += `<rect x="${(cx - 7).toFixed(1)}" y="${(cy - 7).toFixed(1)}" width="14" height="14" transform="rotate(45 ${cx.toFixed(1)} ${cy.toFixed(1)})" fill="rgba(247,240,240,.16)" stroke="var(--text)" stroke-width="2"/>`;
      s += `<text x="${(cx + (left ? -18 : 18)).toFixed(1)}" y="${(cy + 7).toFixed(1)}" text-anchor="${left ? "end" : "start"}">${r.site}</text>`;
    });
    s += `<circle cx="${px(t.lon).toFixed(1)}" cy="${py(t.lat).toFixed(1)}" r="19" fill="rgba(90,155,189,.2)"/>`;
    s += `<circle cx="${px(t.lon).toFixed(1)}" cy="${py(t.lat).toFixed(1)}" r="9" fill="var(--accent)" stroke="var(--text)" stroke-width="2"/>`;
    s += `<text class="label-tank" x="${(px(t.lon) - 24).toFixed(1)}" y="${(py(t.lat) + 6).toFixed(1)}" text-anchor="end">Clarity tank</text>`;
    s += `</svg>`;
    box.innerHTML = s;
  }

  // ---------------------------------------------------------------- start
  function splitWords(h) {
    const words = h.textContent.trim().split(/\s+/);
    h.setAttribute("aria-label", words.join(" "));
    h.innerHTML = words.map((w, k) => `<span class="w" aria-hidden="true" style="--w:${k}">${w.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join(" ");
  }
  // The slides name the model that picks filters. They say Gemini unless a gateway says it is using another.
  const nameModel = () => {
    const name = window.TapApp?.store?.health?.ai_name;
    if (name) host.querySelectorAll("[data-ai]").forEach((el) => { el.textContent = name; });
  };
  window.addEventListener("app:ready", nameModel);

  function build(html) {
    const mark = document.querySelector(".bar .wordmark");
    host.innerHTML = html + `<p class="p-mark wordmark" aria-hidden="true">${mark ? mark.innerHTML : "Clarity"}</p><p class="p-count" aria-hidden="true"></p><div class="p-end" aria-hidden="true"></div>`;
    // two minutes, demo included: the short deck leaves out the slides marked data-extra. ?full keeps them.
    if (!new URLSearchParams(location.search).has("full")) host.querySelectorAll(".slide[data-extra]").forEach((el) => el.remove());
    slides = [...host.querySelectorAll(".slide")];
    if (!slides.length) throw new Error("no slides");
    nameModel();
    slides.forEach((s) => {
      s.querySelectorAll("h1, h2").forEach(splitWords);
      s.querySelectorAll("[data-rise]").forEach((el, i) => el.style.setProperty("--i", i));
    });
    drawChart();
    drawMiniMap();
    fit();
    mode();
    host.hidden = false;
    addEventListener("resize", fit);
    wide.addEventListener("change", mode);
    addEventListener("keydown", onKey);
    addEventListener("touchstart", onTouchStart, { passive: true });
    addEventListener("touchend", onTouchEnd, { passive: true });
    host.addEventListener("scroll", () => {          // the column: its end is the way into the demo
      if (!wide.matches && revealed && host.scrollTop + host.clientHeight >= host.scrollHeight - 2) finish();
    }, { passive: true });
    open();
  }

  addEventListener("wheel", onWheel, { passive: false, capture: true });
  fetch(SLIDES_URL)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status + " " + SLIDES_URL.pathname))))
    .then(build)
    .catch((err) => { console.warn("Pitch unavailable, showing the demo:", err); finish(true); });
})();
