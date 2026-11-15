// Checks for the map's globe intro (src/intro.js): the slow-down never lurches, and the land drawn on the
// globe is the land. Run: node test_intro.mjs   (about a minute)
import { readFileSync } from "node:fs";
const ROOT = new URL(".", import.meta.url).pathname;
const I = await import("./src/intro.js");
const RAD = Math.PI / 180, TAU = Math.PI * 2;
let ok = true;
const check = (name, cond, detail = "") => { ok &&= !!cond; console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail); };

// ---------------------------------------------------------------- slowing down
const HOME = [-74.66, 40.35];
let worstStart = 0, worstEnd = 0, miss = 0, peak = 0, longest = 0;
for (let from = -720; from < 720; from += 1.3) {
  const p = I.settlePlan(from, HOME[0]), h = 1e-4, at = s => I.settleLon(p, s);
  worstStart = Math.max(worstStart, Math.abs((at(h) - at(0)) / h - I.SPIN));
  worstEnd = Math.max(worstEnd, Math.abs((at(p.t) - at(p.t - h)) / h));
  for (let t = 0; t <= p.t; t += p.t / 400) peak = Math.max(peak, Math.abs((at(t + h) - at(t)) / h));
  miss = Math.max(miss, Math.abs(((((at(p.t) - HOME[0]) % 360) + 540) % 360) - 180));
  longest = Math.max(longest, p.t);
  checkDistance(p);
}
function checkDistance(p) { if (Math.abs(p.d) > 180 + 1e-9) ok = false; }
check("the destination turn starts at the idle spin's speed", worstStart < .01, worstStart);
check("it arrives at rest", worstEnd < .01, worstEnd);
check("it ends with the destination in front", miss < 1e-6, miss);
check("the turn takes at most 3.2 seconds without a full extra revolution", longest <= 3.2 && peak < 90, { longest, peak });
for (const [w,h] of [[1440,836],[886,980],[390,720],[390,550],[1280,600]]) {
  const g = I.restingGlobe(w,h);
  check(`the resting globe fits the visible ${w}x${h} canvas`, g.x-g.r>=0 && g.x+g.r<=w && g.y-g.r>=0 && g.y+g.r<=h);
}

// ---------------------------------------------------------------- cinematic approach and axial tilt
const fly = { zG: 1, zM: 4, zA: 4.9, zB: 6 };
const goalZoom = 11.75;
let lastZoom = fly.zG, backwards = false, earlyMorph = false, earlyMap = false;
for (let t = 0; t <= I.APPROACH_SECONDS + 0.01; t += 0.01) {
  const a = I.approachState(fly, goalZoom, t);
  backwards ||= a.zoom < lastZoom - 1e-9;
  earlyMorph ||= a.morph > 0 && Math.abs(a.roll) > 1e-9;
  earlyMap ||= a.fade < 1 && a.morph < 1;
  lastZoom = a.zoom;
}
check("the scenic approach remains in progress after the previous 4.8-second dive", I.approachState(fly, goalZoom, 4.8).zoom < goalZoom - 0.5);
check("the approach takes six to nine seconds and reaches the requested view", I.APPROACH_SECONDS >= 6 && I.APPROACH_SECONDS <= 9 && I.approachState(fly, goalZoom, I.APPROACH_SECONDS).zoom === goalZoom);
check("zoom advances continuously without reversing or overshooting", !backwards && lastZoom <= goalZoom);
check("the axial tilt settles to north-up before flattening", !earlyMorph);
check("the real map only shows once the projection is fully flat", !earlyMap);
check("the idle globe turns slowly", I.SPIN <= 18);
const tiltedHome = I.view(HOME[0], HOME[1], I.AXIAL_TILT);
const north = I.projectPoint(HOME[0], 90, tiltedHome);
const tiltSeen = Math.atan2(-north.x, north.y) / RAD;
const centre = I.projectPoint(...HOME, tiltedHome);
check("the projected north axis has a natural visible tilt", tiltSeen >= 15 && tiltSeen <= 23.1, tiltSeen);
check("Princeton stays centred when its globe axis is tilted", Math.hypot(centre.x, centre.y) < 1e-9);

// ---------------------------------------------------------------- the land on the globe
const overview = process.argv.includes("--overview");
const geo = JSON.parse(readFileSync(`${ROOT}/public/data/${overview ? "intro-land.json" : "land.json"}`, "utf8"));
const land = I.prepare(geo, HOME, overview);
const count = (l) => l.reduce((n, r) => n + r.n, 0);
console.log("INFO rings:", land.other.length, "other,", land.us.length, "US,", land.states.length, "state lines; points:", count(land.other), count(land.us), count(land.states));
check("there is land to draw", land.other.length > 100 && land.us.length > 5 && land.states.length > 10);

// a recording sink: loops as lists of points, the arcs along the globe's edge walked in 2-degree steps
function recorder() {
  const loops = []; let cur = null;
  return { loops,
    moveTo(x, y) { cur = [[x, y]]; loops.push(cur); }, lineTo(x, y) { cur.push([x, y]); },
    arc(a, b, left) { let sweep = left ? (((b - a) % TAU) + TAU) % TAU : -((((a - b) % TAU) + TAU) % TAU); const n = Math.max(1, Math.ceil(Math.abs(sweep) / (2 * RAD))); for (let k = 1; k <= n; k++) cur.push([Math.cos(a + (sweep * k) / n), Math.sin(a + (sweep * k) / n)]); },
    close() {} };
}
const winding = (loops, x, y) => {
  let w = 0;
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const [x1, y1] = l[i], [x2, y2] = l[(i + 1) % l.length];
    if (y1 <= y) { if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) w++; }
    else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) w--;
  }
  return w;
};
// the truth: is a point of the sphere on this layer's land? Count the ring edges a great-circle arc to a known sea point crosses.
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vec = (lon, lat) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
const within = (p, a, b, n) => dot(cross(a, p), n) >= 0 && dot(cross(p, b), n) >= 0;
function edgesOf(rings) {
  const e = [];
  for (const r of rings) for (let i = 0; i < r.n; i++) { const j = (i + 1) % r.n; e.push([[r.X[i], r.Y[i], r.Z[i]], [r.X[j], r.Y[j], r.Z[j]]]); }
  return e.map(([a, b]) => ({ a, b, n: cross(a, b) }));
}
function onLand(edges, p, sea) {
  const n1 = cross(p, sea); let hits = 0;
  for (const e of edges) {
    const sa = dot(n1, e.a), sb = dot(n1, e.b);
    if (sa * sb > 0) continue;
    const x = cross(n1, e.n);
    for (const s of [1, -1]) { const q = [x[0] * s, x[1] * s, x[2] * s]; if (within(q, p, sea, n1) && within(q, e.a, e.b, e.n)) { hits++; break; } }
  }
  return hits % 2 === 1;
}
const SEA = vec(-140, -8.3);                       // mid Pacific
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (const [name, rings] of [["other", land.other], ["us", land.us]]) {
  const edges = edgesOf(rings);
  let wrong = 0, total = 0, worstView = 0, unlinked = 0, views = 0, landSeen = 0;
  const viewsToCheck = [];
  for (const lat0 of [18, 40.35]) {
    for (let lon0 = -180; lon0 < 180; lon0 += 9) viewsToCheck.push([lon0, lat0, 0]);
    for (let lon0 = -180; lon0 < 180; lon0 += 45) viewsToCheck.push([lon0, lat0, I.AXIAL_TILT]);
  }
  for (const [lon0, lat0, roll] of viewsToCheck) {
    const V = I.view(lon0, lat0, roll), rec = recorder();
    if (!I.trace(rings, V, 0, rec)) unlinked++;
    views++;
    const east = [-V.sl, V.cl, 0], north = [-V.s0 * V.cl, -V.s0 * V.sl, V.c0];
    const E = east.map((x, i) => V.cr * x - V.sr * north[i]), N = east.map((x, i) => V.sr * x + V.cr * north[i]), F = [V.x, V.y, V.z];
    let bad = 0;
    for (let k = 0; k < 60; k++) {
      const r = Math.sqrt(rnd()) * 0.985, a = rnd() * TAU, x = r * Math.cos(a), y = r * Math.sin(a), z = Math.sqrt(1 - x * x - y * y);
      const p = [0, 1, 2].map((i) => x * E[i] + y * N[i] + z * F[i]);
      const truth = onLand(edges, p, SEA), drawn = winding(rec.loops, x, y) !== 0;
      if (truth) landSeen++;
      if (truth !== drawn) bad++;
      total++;
    }
    wrong += bad; worstView = Math.max(worstView, bad);
  }
  check(`${name}: the land filled on the globe is the land (${total} points over ${views} views, ${landSeen} on land)`, wrong <= total * 0.004 && worstView <= 2, `${wrong} wrong, worst view ${worstView}`);
  console.log("INFO", name, "views where a tangled outline was closed piece by piece:", unlinked, "of", views);
  // every quarter degree of the spin, and through the slow-down: the crossings always pair up
  let broke = 0, n = 0; const tangled = [];
  for (const lat0 of [18, 24.1, 31.7, 40.35]) for (let lon0 = -180; lon0 < 180; lon0 += 0.25) { n++; if (!I.trace(rings, I.view(lon0, lat0), 0.002, recorder())) { broke++; tangled.push([lon0, lat0]); } }
  // and in those views the picture is still right
  let off = 0, seen = 0, worstTangled = 0;
  for (const [lon0, lat0] of tangled.filter((_, i) => i % Math.ceil(tangled.length / 14) === 0)) {
    const V = I.view(lon0, lat0), rec = recorder();
    I.trace(rings, V, 0, rec);
    const east = [-V.sl, V.cl, 0], north = [-V.s0 * V.cl, -V.s0 * V.sl, V.c0];
    const E = east.map((x, i) => V.cr * x - V.sr * north[i]), N = east.map((x, i) => V.sr * x + V.cr * north[i]), F = [V.x, V.y, V.z];
    let bad = 0;
    for (let k = 0; k < 120; k++) {
      const r = Math.sqrt(rnd()) * 0.985, a = rnd() * TAU, x = r * Math.cos(a), y = r * Math.sin(a), z = Math.sqrt(1 - x * x - y * y);
      const p = [0, 1, 2].map((i) => x * E[i] + y * N[i] + z * F[i]);
      if (onLand(edges, p, SEA) !== (winding(rec.loops, x, y) !== 0)) bad++;
      seen++;
    }
    off += bad; worstTangled = Math.max(worstTangled, bad);
  }
  if (tangled.length) check(`${name}: where an outline is tangled the land is still right (${seen} points)`, off <= seen * 0.006 && worstTangled <= 3, `${off} wrong, worst ${worstTangled}`);
  check(`${name}: tangled outlines are rare over a full turn (${broke} of ${n} views)`, broke < n * 0.03, broke);
}
// flattened to the map's projection, the outline is the map's: x = lon, y = Mercator
{
  const V = I.view(HOME[0], HOME[1]), rec = recorder();
  I.traceFlat(land.us, V, 1, true, rec);
  const near = land.us.filter((r) => r.near);
  let worst = 0, i = 0;
  for (const r of near) { const l = rec.loops[i++]; for (let k = 0; k < r.n; k++) {
    const x = (r.L[k] - HOME[0] * RAD) * Math.cos(HOME[1] * RAD), y = (r.M[k] - Math.log(Math.tan(Math.PI / 4 + (HOME[1] * RAD) / 2))) * Math.cos(HOME[1] * RAD);
    worst = Math.max(worst, Math.hypot(l[k][0] - x, l[k][1] - y)); } }
  check("flattened, the US outline is exactly the Mercator map", near.length > 3 && worst < 1e-6, worst);
  const tiltedFlat = recorder();
  I.traceFlat(land.us, I.view(HOME[0], HOME[1], I.AXIAL_TILT), 1, true, tiltedFlat);
  let rollGap = 0;
  for (let a = 0; a < rec.loops.length; a++) for (let k = 0; k < rec.loops[a].length; k++) {
    rollGap = Math.max(rollGap, Math.hypot(rec.loops[a][k][0] - tiltedFlat.loops[a][k][0], rec.loops[a][k][1] - tiltedFlat.loops[a][k][1]));
  }
  check("even a tilted globe ends on the exact same flat-map coordinates", rollGap < 1e-9, rollGap);
  const g = recorder(); I.traceFlat(land.us, V, 0, true, g); const o = recorder(); I.trace(near, V, 0, o);
  let gap = 0; for (let a = 0; a < o.loops.length; a++) for (let k = 0; k < o.loops[a].length; k++) gap = Math.max(gap, Math.hypot(g.loops[a][k][0] - o.loops[a][k][0], g.loops[a][k][1] - o.loops[a][k][1]));
  check("not flattened at all, it is exactly the globe", gap < 1e-9, gap);
}
console.log(ok ? "\nall passed" : "\nFAILURES");
process.exit(ok ? 0 : 1);
