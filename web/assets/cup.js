/* Draws a tumbler of water from one reading: amber tint and specks grow with dissolved
   solids (TDS), brown murk grows as clarity drops. Shared by the dashboard and the slides. */
(function () {
  "use strict";
  let uid = 0;
  const TOP = 46, BOT = 186;               // water surface and floor
  const GLASS = "M10 10 L25 190 L135 190 L150 10";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  const xAt = (y, side) => (side < 0 ? 10 + (y - 10) * (15 / 180) : 150 - (y - 10) * (15 / 180));

  function rng(seed) {                       // small deterministic generator: same reading, same specks
    let s = (seed >>> 0) || 1;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  }

  function describe(r) {
    return `Cup of water: ${r.tds} ppm dissolved solids, clarity ${Number(r.clarity).toFixed(2)}, pH ${Number(r.ph).toFixed(1)}`;
  }

  function svg(reading, opts = {}) {
    if (!reading) {
      const label = opts.emptyLabel || "Empty cup";
      return `<svg viewBox="0 0 160 200" class="cup cup-empty" role="img" aria-label="${label}"><path d="${GLASS}" class="glass"/></svg>`;
    }
    const id = "cupclip" + ++uid;
    const tds = clamp(reading.tds, 0, 1000);
    const clr = clamp(reading.clarity, 0, 1);
    // ordinary tap water (~150 ppm, clarity ~0.95) should look nearly clear
    const mineral = clamp((tds - 60) / 740, 0, 1) * 0.5;
    const murk = Math.pow(1 - clr, 1.3) * 0.95;
    const rand = rng(Math.round(tds * 7 + clr * 1000 + (reading.test || 0) * 31));
    let specks = "";
    const n = Math.round((tds / 1000) * 90);
    for (let i = 0; i < n; i++) {
      const y = TOP + 6 + rand() * (BOT - TOP - 10);
      const x0 = xAt(y, -1) + 4, x1 = xAt(y, 1) - 4;
      specks += `<circle cx="${(x0 + rand() * (x1 - x0)).toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.8 + rand() * 1.6).toFixed(2)}"/>`;
    }
    const water = `M${xAt(TOP, -1)} ${TOP} L${xAt(BOT, -1)} ${BOT} L${xAt(BOT, 1)} ${BOT} L${xAt(TOP, 1)} ${TOP}Z`;
    return `<svg viewBox="0 0 160 200" class="cup" role="img" aria-label="${describe(reading)}">
  <defs><clipPath id="${id}"><path d="${water}"/></clipPath></defs>
  <g clip-path="url(#${id})"><g class="${opts.rise ? "rise" : ""}">
    <rect x="0" y="${TOP}" width="160" height="${BOT - TOP + 4}" style="fill:var(--water)"/>
    <rect x="0" y="${TOP}" width="160" height="${BOT - TOP + 4}" style="fill:var(--mineral)" opacity="${mineral.toFixed(3)}"/>
    <rect x="0" y="${TOP}" width="160" height="${BOT - TOP + 4}" style="fill:var(--tannin)" opacity="${murk.toFixed(3)}"/>
    <g style="fill:var(--mineral)" opacity="0.8">${specks}</g>
    <path d="M${xAt(TOP, -1)} ${TOP} L${xAt(TOP, 1)} ${TOP}" class="meniscus"/>
  </g></g>
  <path d="${GLASS}" class="glass"/>
</svg>`;
  }

  window.TapCup = { svg };
})();
