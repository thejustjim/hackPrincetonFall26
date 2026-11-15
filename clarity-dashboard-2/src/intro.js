/* The map's loading screen: a globe that spins while the map loads, slows to a stop with Princeton
   in front, then dives in, and the dive ends on the real map.

   The globe is a drawing on a 2D canvas (this version of the map library has no globe). It is made
   from the same world outline the map itself draws when zoomed out (data/land.json), and during
   the dive it takes on the map's own colours and flattens from a globe into the map's projection,
   at the map's scale and centred where the map is centred. So by the time the drawing fades, the
   map underneath shows the same shapes in the same places, and from there the map's own camera
   carries on down to the home view: one move, with no cut.

   It can also be the map's start screen: the globe turns until a choice is taken (the Princeton
   demo, or the whole country), and that choice is where it stops and where the map lands.

   Nothing is locked. On the start screen the rest of the page still works, and a search or a button
   that moves the map takes over. Once it is moving, a key skips to where it was heading; a click or
   the wheel does too until the map shows, and after that stops the descent where it is. ?nointro
   leaves the whole thing out, and so does a reduced-motion setting. */
const RAD = Math.PI / 180, TAU = Math.PI * 2, HALF = Math.PI / 2;
export const SPIN = 80;                  // degrees a second while loading
const TILT = 18;                         // latitude the globe is seen from while it spins
const MIN_SPIN = 1.2, HOLD = 0.35, DIVE = 4.8;      // seconds
const SIZE = 0.32;                       // the globe's radius, as a share of the shorter side
const NEAR = Math.cos(45 * RAD);         // outlines with a point this close to home are kept whole
const SMALL = 2 * RAD;                   // outlines smaller than this are not walked along the globe's edge
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const smoother = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
const wrap = (a) => a - TAU * Math.round(a / TAU);
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.05, Math.min(85.05, lat)) * RAD) / 2));

/* ---------------------------------------------------------------- slowing to a stop

   The spin has to end with home in front, and it must not lurch on the way: the speed carries over
   from the spin and falls to nothing, and the globe never turns back. `d` is how far there is still
   to turn, at least 55 degrees so there is room to slow down. */
export function settlePlan(lonNow, homeLon, speed = SPIN) {
  let d = (((homeLon - lonNow) % 360) + 360) % 360;
  if (d < 55) d += 360;
  return { from: lonNow, d, t: 1.6 + d / 160, speed };
}
export function settleLon(plan, since) {
  const s = clamp01(since / plan.t), v = plan.speed * plan.t;
  return plan.from + v * (s - 2 * s * s + s * s * s) + plan.d * (3 * s * s - 2 * s * s * s);
}

/* ---------------------------------------------------------------- the outlines

   Every outline becomes points on a unit sphere. Land rings are turned so that land is always on
   the left (outer rings anticlockwise, holes clockwise): that is what lets a ring that runs over
   the edge of the globe be closed along the edge the right way round. Far from home the points are
   thinned, by a rule that depends only on where a point is, so two countries that share a border
   keep the same points along it and no gap opens between them. */
export function prepare(geo, home) {
  const hl = home[0] * RAD, hp = home[1] * RAD;
  const hx = Math.cos(hp) * Math.cos(hl), hy = Math.cos(hp) * Math.sin(hl), hz = Math.sin(hp);
  const out = { other: [], us: [], states: [], most: 0 };
  const keep = ([lon, lat]) => (((Math.imul(Math.round(lon * 1e4) | 0, 73856093) ^ Math.imul(Math.round(lat * 1e4) | 0, 19349663)) >>> 0) % 4) === 0;
  let polygon = 0;
  const add = (list, pts, closed, hole) => {
    if (closed && !hole) polygon++;
    if (closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
    if (closed && pts.every((q) => q[1] < -89.9)) return;  // Antarctica comes with a pin-prick ring round the pole: not land
    const dot = ([lon, lat]) => Math.cos(lat * RAD) * (Math.cos(lon * RAD) * hx + Math.sin(lon * RAD) * hy) + Math.sin(lat * RAD) * hz;
    const near = pts.some((p) => dot(p) >= NEAR);
    if (!near) pts = pts.filter((p, i) => keep(p) || (!closed && (i === 0 || i === pts.length - 1)));
    if (closed) {
      let a = 0, turn = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length], d = wrap((q[0] - p[0]) * RAD);
        turn += d;
        a += d * (2 + Math.sin(p[1] * RAD) + Math.sin(q[1] * RAD));
      }
      if (Math.abs(turn) > Math.PI) hole = false;          // a coast that goes right round the pole (Antarctica's) bounds the land itself
      if ((a > 0) !== !!hole) pts = pts.slice().reverse();
    }
    const n = pts.length;
    if (n < (closed ? 4 : 2)) return;
    const r = { n, near, poly: polygon, X: new Float32Array(n), Y: new Float32Array(n), Z: new Float32Array(n), L: new Float32Array(n), M: new Float32Array(n), cx: 0, cy: 0, cz: 0, rad: 0 };
    for (let i = 0; i < n; i++) {
      const lon = pts[i][0] * RAD, lat = pts[i][1] * RAD;
      r.X[i] = Math.cos(lat) * Math.cos(lon); r.Y[i] = Math.cos(lat) * Math.sin(lon); r.Z[i] = Math.sin(lat);
      r.L[i] = lon; r.M[i] = mercY(pts[i][1]);
      r.cx += r.X[i]; r.cy += r.Y[i]; r.cz += r.Z[i];
    }
    const len = Math.hypot(r.cx, r.cy, r.cz) || 1;
    r.cx /= len; r.cy /= len; r.cz /= len;
    for (let i = 0; i < n; i++) r.rad = Math.max(r.rad, Math.acos(Math.max(-1, Math.min(1, r.X[i] * r.cx + r.Y[i] * r.cy + r.Z[i] * r.cz))));
    out.most = Math.max(out.most, n);
    list.push(r);
  };
  for (const f of geo.features) {
    const g = f.geometry, k = f.properties?.k;
    const list = k === "us" ? out.us : out.other;
    if (g.type === "Polygon") g.coordinates.forEach((ring, i) => add(list, ring, true, i > 0));
    else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => p.forEach((ring, i) => add(list, ring, true, i > 0)));
    else if (g.type === "LineString") add(out.states, g.coordinates, false);
    else if (g.type === "MultiLineString") g.coordinates.forEach((line) => add(out.states, line, false));
  }
  return out;
}

/* Where the globe is seen from. */
export function view(lon, lat) {
  const l0 = lon * RAD, p0 = lat * RAD;
  return { l0, m0: mercY(lat), cl: Math.cos(l0), sl: Math.sin(l0), s0: Math.sin(p0), c0: Math.cos(p0),
           x: Math.cos(p0) * Math.cos(l0), y: Math.cos(p0) * Math.sin(l0), z: Math.sin(p0) };
}

let px = new Float64Array(0), py = new Float64Array(0), pz = new Float64Array(0);
function room(n) { if (px.length < n) { px = new Float64Array(n); py = new Float64Array(n); pz = new Float64Array(n); } }
function project(r, V) {
  let hidden = -1;
  for (let i = 0; i < r.n; i++) {
    const a = r.X[i] * V.cl + r.Y[i] * V.sl;
    px[i] = r.Y[i] * V.cl - r.X[i] * V.sl; py[i] = V.c0 * r.Z[i] - V.s0 * a; pz[i] = V.s0 * r.Z[i] + V.c0 * a;
    if (hidden < 0 && pz[i] <= 0) hidden = i;
  }
  return hidden;
}

/* The land of one layer as seen on the globe, drawn into `fill` (and its outline into `line`), in
   units of the globe's radius with y up. A ring that runs over the edge is cut where it crosses,
   and the pieces are joined along the edge: from where a piece leaves, anticlockwise to the next
   place a piece comes back, since land is on the left. The crossings of one polygon are matched
   together (its outer ring and its holes: a lake can cross the edge inside a country that crosses
   it elsewhere), and never with another polygon's, since neighbours may overlap by a hair.
   Returns false if some polygon's crossings did not pair up and its pieces were closed one by one. */
function join(runs, fill) {
  const ev = [];
  for (const r of runs) ev.push({ a: r.a0, out: 0, r }, { a: r.a1, out: 1, r });
  ev.sort((p, q) => p.a - q.a || p.out - q.out);            // at the same point, coming back counts first
  let good = true;
  for (let i = 0; i < ev.length && good; i++) {
    const nx = ev[(i + 1) % ev.length];
    if (ev[i].out === nx.out) good = false;
    else if (ev[i].out) { ev[i].r.next = nx.r; if (((nx.a - ev[i].a) % TAU + TAU) % TAU > 3.8) good = false; }
  }
  if (!good) {
    // A thinned outline can cross itself, and then the crossings make no sense as a whole. Close each
    // piece on its own, the short way round: right in all but the oddest cases, and never a whole globe of land.
    for (const r of runs) {
      fill.moveTo(r.pts[0], r.pts[1]);
      for (let j = 2; j < r.pts.length; j += 2) fill.lineTo(r.pts[j], r.pts[j + 1]);
      fill.arc(r.a1, r.a0, ((r.a0 - r.a1) % TAU + TAU) % TAU <= Math.PI);
      fill.close();
    }
    return false;
  }
  for (const r of runs) {
    if (r.done) continue;
    fill.moveTo(r.pts[0], r.pts[1]);
    let c = r;
    do {
      for (let j = 2; j < c.pts.length; j += 2) fill.lineTo(c.pts[j], c.pts[j + 1]);
      c.done = true;
      fill.arc(c.a1, c.next.a0, true);
      c = c.next;
    } while (c !== r && !c.done);
    fill.close();
  }
  return true;
}
export function trace(rings, V, minRad, fill, line) {
  let runs = [], poly = -1, good = true;
  for (const r of rings) {
    if (r.poly !== poly) { if (runs.length) { good = join(runs, fill) && good; runs = []; } poly = r.poly; }
    if (r.rad < minRad) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, r.cx * V.x + r.cy * V.y + r.cz * V.z)));
    if (ang - r.rad >= HALF) continue;                      // all of it is on the far side
    room(r.n);
    const hidden = project(r, V), n = r.n;
    if (hidden < 0) {
      fill.moveTo(px[0], py[0]);
      for (let i = 1; i < n; i++) fill.lineTo(px[i], py[i]);
      fill.close();
      if (line) { line.moveTo(px[0], py[0]); for (let i = 1; i < n; i++) line.lineTo(px[i], py[i]); line.close(); }
      continue;
    }
    if (r.rad < SMALL) {                                    // an island on the edge: its near side, closed straight across
      let pen = false;
      for (let i = 0; i < n; i++) if (pz[i] > 0) { if (pen) fill.lineTo(px[i], py[i]); else { fill.moveTo(px[i], py[i]); pen = true; } }
      if (pen) fill.close();
      continue;
    }
    let run = null;
    for (let k = 1; k <= n; k++) {
      const i = (hidden + k) % n, p = (hidden + k - 1) % n, vis = pz[i] > 0, was = pz[p] > 0;
      if (vis !== was) {
        // where the edge of the globe cuts this segment, worked out from its near end
        const f = vis ? i : p, b = vis ? p : i, t = pz[f] / (pz[f] - pz[b]);
        let x = px[f] + t * (px[b] - px[f]), y = py[f] + t * (py[b] - py[f]);
        const len = Math.hypot(x, y) || 1;
        x /= len; y /= len;
        if (vis) run = { pts: [x, y, px[i], py[i]], a0: Math.atan2(y, x), a1: 0, next: null, done: false };
        else {
          run.pts.push(x, y); run.a1 = Math.atan2(y, x); runs.push(run);
          if (line) { line.moveTo(run.pts[0], run.pts[1]); for (let j = 2; j < run.pts.length; j += 2) line.lineTo(run.pts[j], run.pts[j + 1]); }
          run = null;
        }
      } else if (vis) run.pts.push(px[i], py[i]);
    }
  }
  if (runs.length) good = join(runs, fill) && good;
  return good;
}

/* Lines (the state borders) on the globe: drawn where they are on the near side. */
export function traceLines(lines, V, minRad, sink) {
  for (const r of lines) {
    if (r.rad < minRad) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, r.cx * V.x + r.cy * V.y + r.cz * V.z)));
    if (ang - r.rad >= HALF) continue;
    room(r.n);
    project(r, V);
    let pen = false;
    for (let i = 0; i < r.n; i++) {
      if (pz[i] <= 0) { pen = false; continue; }
      if (pen) sink.lineTo(px[i], py[i]); else { sink.moveTo(px[i], py[i]); pen = true; }
    }
  }
}

/* The outlines near home, part of the way (m, 0 to 1) from the globe to the map's flat projection.
   Used only once the globe's edge is well off the screen, so nothing here needs cutting. */
export function traceFlat(rings, V, m, closed, fill, line) {
  for (const r of rings) {
    if (!r.near) continue;
    room(r.n);
    project(r, V);
    for (let i = 0; i < r.n; i++) {
      const x = px[i] + m * (wrap(r.L[i] - V.l0) * V.c0 - px[i]), y = py[i] + m * ((r.M[i] - V.m0) * V.c0 - py[i]);
      if (i === 0) { fill.moveTo(x, y); if (line) line.moveTo(x, y); } else { fill.lineTo(x, y); if (line) line.lineTo(x, y); }
    }
    if (closed) { fill.close(); if (line) line.close(); }
  }
}

/* ---------------------------------------------------------------- the screen */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
const GLOBE = { ocean: rgb("#07161F"), other: rgb("#143541"), us: rgb("#1E5E73"), line: rgb("#8DBDD8") };
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Dead"]);

/* `paint` is the map's own colours for the zoomed-out view: { ocean, other, usLand, border }.
   `start`, if given, makes the globe a start screen: it keeps turning until one of the choices is
   taken, and then goes to that choice's view. { line: () => text, choices: [{ label, name, view, pin }],
   chose(choice) }. The first choice is the one any key takes. Without `start` it goes home by itself. */
export function runIntro(map, home, dataUrl, paint, start) {
  const wrapEl = map.getContainer().parentElement;
  const off = new URLSearchParams(location.search).has("nointro") || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (off || !wrapEl) return;
  const el = document.createElement("div");
  el.className = "intro";
  el.innerHTML = '<canvas></canvas><p class="intro-note">Loading the map</p>' + (start ? `<div class="intro-start"><p class="intro-line"></p><div class="intro-choices">${
    start.choices.map((c, i) => `<button type="button" class="intro-go${i ? "" : " first"}" data-i="${i}">${c.label}</button>`).join("")}</div></div>` : "");
  const canvas = el.querySelector("canvas"), note = el.querySelector(".intro-note"), ctx = canvas.getContext("2d");
  if (!ctx) return;
  wrapEl.appendChild(el);
  const MAP = { ocean: rgb(paint.ocean), other: rgb(paint.other), us: rgb(paint.usLand), line: rgb(paint.border) };
  let goal = home, [goalLon, goalLat] = home.center, chosen = !start, offered = false, geoRaw = null;
  const lonStart = goalLon - 120 - SPIN * MIN_SPIN;        // if the map is ready at once, home is a third of a turn away
  let land = null, noLand = false, ready = false, phase = "spin", clock = 0, last = 0, mark = 0, raf = 0, done = false;
  let lon = lonStart, lat = TILT, plan = null, fly = null, driving = false;

  fetch(dataUrl + "land.json").then((r) => r.json()).then((geo) => { geoRaw = geo; land = prepare(geo, home.center); }).catch(() => { noLand = true; });
  const mapReady = () => { ready = true; };
  if (map.loaded()) mapReady(); else map.once("load", mapReady);
  setTimeout(mapReady, 7000);                              // a slow connection: carry on with whatever has loaded

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    el.classList.add("gone");
    setTimeout(() => el.remove(), 500);
    removeEventListener("keydown", onKey, true);
    removeEventListener("pointerdown", onPointer, true);
    removeEventListener("wheel", onPointer, true);
    map.off("move", onMapMove);
  }
  // The start screen: a choice sets where the globe stops and where the map lands.
  function choose(c) {
    if (chosen || done) return;
    goal = { ...c.view, name: c.name, pin: c.pin };
    [goalLon, goalLat] = goal.center;
    if ((goalLon !== home.center[0] || goalLat !== home.center[1]) && geoRaw) land = prepare(geoRaw, goal.center);
    chosen = true;
    el.classList.remove("ask");
    start.chose?.(c);
  }
  el.querySelectorAll(".intro-go").forEach((b) => b.addEventListener("click", () => choose(start.choices[+b.dataset.i])));
  // While the start screen waits, the rest of the page still works: a search or a button that moves the
  // map takes over, and the globe gets out of the way.
  function onMapMove() {
    if (chosen || done) return;
    const c = map.getCenter();
    if (Math.abs(c.lng - home.center[0]) > 1e-3 || Math.abs(c.lat - home.center[1]) > 1e-3 || Math.abs(map.getZoom() - home.zoom) > 0.05) finish();
  }
  map.on("move", onMapMove);
  // Not locked. On the start screen a key takes the first choice, and a click anywhere but a choice does
  // nothing. Once it is moving, a key goes straight to where it was heading; a click or the wheel does
  // too while the globe is all there is to see, and once the map is showing leaves it where the hand found it.
  function onKey(e) {
    if (MODIFIERS.has(e.key) || e.metaKey || e.ctrlKey || e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (!chosen) { if (offered) choose(start.choices[0]); return; }
    map.jumpTo(goal); finish();
  }
  function onPointer() { if (!chosen) return; if (!driving) map.jumpTo(goal); finish(); }
  addEventListener("keydown", onKey, true);
  addEventListener("pointerdown", onPointer, true);
  addEventListener("wheel", onPointer, { capture: true, passive: true });

  function size() {
    const dpr = Math.min(2, devicePixelRatio || 1), w = wrapEl.clientWidth, h = wrapEl.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  }
  // Where the map's centre sits in the overlay (the map keeps it off-middle, clear of its panels).
  function centre() {
    const p = map.project(goal.center), a = map.getContainer().getBoundingClientRect(), b = el.getBoundingClientRect();
    return [p.x + a.left - b.left, p.y + a.top - b.top];
  }

  /* Work out the dive against the real map: put it straight above home, looking straight down, and
     measure its scale, so the globe can be drawn at exactly the size the map is at any zoom.
     zG is the zoom the resting globe corresponds to; from zM to zA the globe flattens into the
     map's projection; from zA to zB the drawing fades over the map; then the map goes on alone. */
  function plot(w, h) {
    const [cx, cy] = centre();
    map.jumpTo({ center: goal.center, zoom: 5, pitch: 0, bearing: 0 });
    const a = map.project([goalLon - 0.25, goalLat]), b = map.project([goalLon + 0.25, goalLat]);
    const unit = (b.x - a.x) / (0.5 * RAD) / Math.cos(goalLat * RAD);      // the globe radius, in px, that matches zoom 5
    if (!(unit > 0)) return null;
    const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const zOf = (r) => 5 + Math.log2(r / unit);
    let zA = zOf(2 * far) + 0.9;
    for (let i = 0; i < 8; i++) {                          // the map will not show past its bounds: start close enough to stay centred
      map.jumpTo({ center: goal.center, zoom: zA, pitch: 0, bearing: 0 });
      const at = map.getCenter();
      if (Math.abs(at.lng - goalLon) < 1e-3 && Math.abs(at.lat - goalLat) < 1e-3) break;
      zA += 0.4;
    }
    if (zA + 1.6 > goal.zoom) return null;                 // a view too far out to dive into: the globe just gives way to it
    return { zG: zOf(Math.min(w, h) * SIZE), zM: zA - 0.9, zA, zB: zA + 1.1, rOf: (z) => unit * 2 ** (z - 5) };
  }

  const sinkFor = (path, cx, cy, R) => ({
    moveTo: (x, y) => path.moveTo(cx + R * x, cy - R * y),
    lineTo: (x, y) => path.lineTo(cx + R * x, cy - R * y),
    arc: (a, b, left) => path.arc(cx, cy, R, -a, -b, left),
    close: () => path.closePath(),
  });

  /* One frame of the globe. c is how far its colours have gone over to the map's (0 to 1), m how
     far its shape has (0 to 1), detail how much of the state lines to show, pin the marker. */
  function paintGlobe(w, h, cx, cy, R, V, c, m, zoom, detail, pin, now) {
    ctx.clearRect(0, 0, w, h);
    const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const whole = R > far * 1.03;                          // the globe's edge is off the screen
    const ocean = mix(GLOBE.ocean, MAP.ocean, c);
    if (whole) { ctx.fillStyle = ocean; ctx.fillRect(0, 0, w, h); }
    else {
      const glow = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.32);
      glow.addColorStop(0, `rgba(90, 155, 189, ${(0.3 * (1 - c)).toFixed(3)})`);
      glow.addColorStop(1, "rgba(90, 155, 189, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fillStyle = ocean; ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
      if (c < 0.97) {                                      // lines of latitude and longitude every 30 degrees
        ctx.beginPath();
        const grid = (lonAt, latAt, n) => {
          let pen = false;
          for (let k = 0; k <= n; k++) {
            const lo = lonAt(k) * RAD - V.l0, la = latAt(k) * RAD, cd = Math.cos(lo), sp = Math.sin(la), cp = Math.cos(la);
            if (V.s0 * sp + V.c0 * cp * cd <= 0) { pen = false; continue; }
            const x = cx + R * cp * Math.sin(lo), y = cy - R * (V.c0 * sp - V.s0 * cp * cd);
            if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
          }
        };
        for (let g = -180; g < 180; g += 30) grid(() => g, (k) => -90 + k * 5, 36);
        for (let g = -60; g <= 60; g += 30) grid((k) => -180 + k * 5, () => g, 72);
        ctx.strokeStyle = `rgba(247, 240, 240, ${(0.07 * (1 - c)).toFixed(3)})`; ctx.lineWidth = 1; ctx.stroke();
      }
    }
    if (land) {
      const A = new Path2D(), B = new Path2D(), BL = new Path2D(), S = new Path2D();
      const sA = sinkFor(A, cx, cy, R), sB = sinkFor(B, cx, cy, R), sBL = sinkFor(BL, cx, cy, R), sS = sinkFor(S, cx, cy, R);
      if (m > 0) { traceFlat(land.other, V, m, true, sA); traceFlat(land.us, V, m, true, sB, sBL); traceFlat(land.states, V, m, false, sS); }
      else {
        const tiny = 0.6 / R;                              // outlines smaller than about a pixel are left out
        trace(land.other, V, tiny, sA);
        trace(land.us, V, tiny, sB, sBL);
        if (detail > 0.01) traceLines(land.states, V, tiny, sS);
      }
      ctx.lineJoin = "round";
      const coast = 0.55 * (1 - c);
      // Coastlines of the other countries: stroked first, then the land is filled over the top, which
      // hides the half of every line that lies on land, and with it the borders between countries.
      if (coast > 0.01) { ctx.strokeStyle = `rgba(141, 189, 216, ${coast.toFixed(3)})`; ctx.lineWidth = 1.7; ctx.stroke(A); }
      ctx.fillStyle = mix(GLOBE.other, MAP.other, c); ctx.fill(A);
      ctx.fillStyle = mix(GLOBE.us, MAP.us, c); ctx.fill(B);
      const z = zoom ?? 3;
      ctx.strokeStyle = mix(GLOBE.line, MAP.line, c);
      if (detail > 0.01) { ctx.globalAlpha = detail * (0.4 + 0.6 * c); ctx.lineWidth = 0.7 + c * ((0.6 + ((z - 3) * 0.8) / 6) - 0.7); ctx.stroke(S); ctx.globalAlpha = 1; }
      ctx.lineWidth = 1.2 + c * ((1 + (z - 3) / 6) - 1.2);
      ctx.stroke(BL);
    }
    if (!whole) {
      if (c < 0.99) {                                      // light from the upper left, dark toward the edge
        const shade = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.42, R * 0.08, cx, cy, R * 1.02);
        shade.addColorStop(0, `rgba(150, 205, 235, ${(0.15 * (1 - c)).toFixed(3)})`);
        shade.addColorStop(0.55, "rgba(0, 0, 0, 0)");
        shade.addColorStop(1, `rgba(0, 4, 8, ${(0.62 * (1 - c)).toFixed(3)})`);
        ctx.fillStyle = shade;
        ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      }
      ctx.restore();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU);
      ctx.strokeStyle = `rgba(141, 189, 216, ${(0.5 * (1 - c)).toFixed(3)})`; ctx.lineWidth = 1; ctx.stroke();
    }
    if (pin > 0.01) {                                      // home: a dot and a ring that breathes
      const d = goalLon * RAD - V.l0, sp = Math.sin(goalLat * RAD), cp = Math.cos(goalLat * RAD), cd = Math.cos(d);
      if (V.s0 * sp + V.c0 * cp * cd > 0) {
        const ox = cp * Math.sin(d), oy = V.c0 * sp - V.s0 * cp * cd;
        const x = cx + R * (ox + m * (wrap(d) * V.c0 - ox)), y = cy - R * (oy + m * ((mercY(goalLat) - V.m0) * V.c0 - oy));
        const beat = ((now / 1000) % 1.6) / 1.6;
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, TAU); ctx.fillStyle = `rgba(247, 240, 240, ${pin.toFixed(3)})`; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 6 + 18 * beat, 0, TAU);
        ctx.strokeStyle = `rgba(141, 189, 216, ${(pin * (1 - beat)).toFixed(3)})`; ctx.lineWidth = 1.4; ctx.stroke();
      }
    }
  }

  function frame(now) {
    if (done) return;
    raf = requestAnimationFrame(frame);
    // The clock moves at most a tenth of a second a frame: a machine that cannot keep up sees every
    // part of it, slower, instead of a few frames of it at full speed.
    clock += Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    const [w, h] = size(), since = clock - mark;
    let R = Math.min(w, h) * SIZE, c = 0, m = 0, zoom = null, fade = 1, detail = 0, pin = 0;

    if (phase === "spin") {
      lon = lonStart + SPIN * clock;
      if (ready && noLand && chosen) { map.jumpTo(goal); finish(); return; }
      if (ready && (land || noLand) && clock >= MIN_SPIN && !chosen && !offered) {     // the start screen: ready, and waiting to be told where
        offered = true;
        note.textContent = "";
        const line = el.querySelector(".intro-line");
        if (line) line.textContent = start.line?.() || "";
        el.classList.add("ask");
      }
      if (ready && land && clock >= MIN_SPIN && chosen) {
        fly = plot(w, h);                                  // null when the view is too far out to dive into
        plan = settlePlan(lon, goalLon);
        phase = "settle"; mark = clock;
        note.textContent = goal.name || "Princeton, New Jersey";
      }
    } else if (phase === "settle") {
      lon = settleLon(plan, since);
      lat = TILT + (goalLat - TILT) * smooth(since / plan.t);
      detail = pin = smooth(since / (plan.t * 0.7));
      if (since >= plan.t) { phase = "hold"; mark = clock; }
    } else if (phase === "hold") {
      lon = goalLon; lat = goalLat; detail = pin = 1;
      if (since >= HOLD) {
        if (!fly) { map.jumpTo(goal); finish(); return; }
        phase = "dive"; mark = clock; el.classList.add("diving");
      }
    } else {
      lon = goalLon; lat = goalLat; detail = 1;
      zoom = fly.zG + (goal.zoom - fly.zG) * smooth(since / DIVE);
      R = fly.rOf(zoom);
      c = smooth((zoom - fly.zG) / (fly.zM - fly.zG));
      m = smooth((zoom - fly.zM) / (fly.zA - fly.zM));
      pin = 1 - m;
      fade = 1 - smooth((zoom - fly.zA) / (fly.zB - fly.zA));
      if (zoom >= fly.zA) {                                // the map shows from here, and moves in step with the drawing
        if (!driving) { driving = true; el.classList.add("through"); }
        const k = smoother((zoom - fly.zB) / (goal.zoom - fly.zB));
        map.jumpTo({ center: goal.center, zoom, pitch: (goal.pitch || 0) * k, bearing: (goal.bearing || 0) * k });
      }
      if (since >= DIVE) { map.jumpTo(goal); finish(); return; }
    }
    el.dataset.phase = phase;
    if (fade <= 0) { el.style.display = "none"; return; }  // the map carries on alone
    el.style.opacity = fade < 1 ? fade.toFixed(3) : "";
    const [cx, cy] = centre();
    paintGlobe(w, h, cx, cy, R, view(lon, lat), c, m, zoom, detail, goal.pin === false ? 0 : pin, now);
  }
  raf = requestAnimationFrame(frame);
}
