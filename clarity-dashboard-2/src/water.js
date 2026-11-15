// Where Princeton's water comes from, and where it goes inside a building.
//
// Facts below come from New Jersey American Water's Raritan System water quality reports (PWSID NJ2004002).
// Results are from the 2025 report (amwater.com/ccr/raritan.pdf). The 126 MGD supply figure is from the
// 2023 report, since the 2025 report doesn't state it. Princeton is served by this system's
// Raritan-Millstone and Canal Road plants (NJ American Water press release, April 2026).
// Plant positions come from Overture Maps places. Real pipe routes are not public, so every route drawn here is illustrative.

export const SYSTEM = {
  utility: 'New Jersey American Water',
  system: 'Raritan System',
  pwsid: 'NJ2004002',
  report: '2025 water quality report',
  reportUrl: 'https://amwater.com/ccr/raritan.pdf',
  supplyMgd: 126,
  surfacePct: 92,
  groundPct: 8,
  wells: 98,
  intakes: 7,
  sources: ['Millstone River', 'Raritan River', 'Delaware & Raritan Canal'],
  treatment: 'Surface water is treated with chloramines, groundwater with chlorine.',
  results: [
    { k: 'Sodium', v: '32 to 99 ppm', note: 'NJ guideline 50 ppm (taste, not health)' },
    { k: 'Lead (90th percentile)', v: '2 ppb', note: 'action level 15 ppb, 54 sites tested' },
    { k: 'Copper (90th percentile)', v: '0.3 ppm', note: 'action level 1.3 ppm' },
  ],
};

export const PLANTS = [
  { id: 'rm', name: 'Raritan-Millstone Water Treatment Plant', short: 'Raritan-Millstone plant', pos: [-74.56501, 40.54552],
    note: 'Where the Millstone meets the Raritan, in Bridgewater. The main surface-water plant for the system.' },
  { id: 'cr', name: 'Canal Road Water Treatment Plant', short: 'Canal Road plant', pos: [-74.58458, 40.45839],
    note: 'Draws from the Delaware & Raritan Canal and Millstone River in Franklin Township.' },
];

// Princeton Ridge storage tank (a mapped water tower north of town) that feeds the town by gravity.
export const RIDGE_TOWER = [-74.65424, 40.37298];

// Illustrative trunk route: plants -> along the Millstone / Route 27 corridor -> Kingston -> ridge tower -> town.
export const TRUNK = [
  PLANTS[0].pos, [-74.5755, 40.5205], [-74.5893, 40.4842], PLANTS[1].pos, [-74.5978, 40.4302], [-74.6088, 40.4025],
  [-74.6145, 40.3830], [-74.6290, 40.3760], [-74.6420, 40.3745], RIDGE_TOWER,
];

// ---------- route geometry helpers ----------
const M_PER_DEG_LAT = 111000;
const mPerDegLon = lat => 111000 * Math.cos((lat * Math.PI) / 180);
export function segLenM(a, b) {
  const dx = (b[0] - a[0]) * mPerDegLon(a[1]), dy = (b[1] - a[1]) * M_PER_DEG_LAT, dz = (b[2] || 0) - (a[2] || 0);
  return Math.hypot(dx, dy, dz);
}
// Precompute cumulative lengths so particles can move at a steady speed.
export function makePath(points, meta = {}) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + segLenM(points[i - 1], points[i]));
  return { points, cum, len: cum[cum.length - 1], ...meta };
}
export function pointAt(path, d) {
  const { points, cum } = path;
  if (d <= 0) return points[0];
  if (d >= path.len) return points[points.length - 1];
  let i = 1;
  while (cum[i] < d) i++;
  const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  const a = points[i - 1], b = points[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t];
}
// Particles spaced every `gap` meters, moving at `speed` m/s.
export function particles(paths, timeSec, { gap, speed }) {
  const out = [];
  for (const p of paths) {
    const g = gap * (p.gapScale || 1), sp = speed * (p.speedScale || 1);
    const off = (timeSec * sp) % g;
    for (let d = off; d < p.len; d += g) out.push({ pos: pointAt(p, d), color: p.color });
  }
  return out;
}

// ---------- building cutaway ----------
export function pointInPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function interiorPoint(ring) {
  const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
  if (pointInPolygon(c, ring)) return c;
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let k = 1; k < 12; k++) for (let i = 1; i < k; i++) for (let j = 1; j < k; j++) {
    const p = [x0 + ((x1 - x0) * i) / k, y0 + ((y1 - y0) * j) / k];
    if (pointInPolygon(p, ring)) return p;
  }
  return c;
}

function nearestOnSegment(p, a, b) {
  const k = mPerDegLon(p[1]) / M_PER_DEG_LAT;
  const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return { pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: [b[0] - a[0], b[1] - a[1]] };
}

// Nearest road to a point, from roads.json features. Returns the point on the road, the road name and direction.
export function nearestRoad(p, roads) {
  let best = null;
  for (const f of roads) {
    const c = f.properties.c;
    if (['footway', 'path', 'cycleway', 'steps', 'standard_gauge', 'track'].includes(c)) continue;
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of lines) for (let i = 1; i < line.length; i++) {
      const r = nearestOnSegment(p, line[i - 1], line[i]);
      const d = segLenM(p, r.pt);
      if (!best || d < best.d) best = { d, pt: r.pt, dir: r.dir, name: f.properties.n };
    }
  }
  return best;
}

// Illustrative plumbing for a building: street main, service line, meter, riser, a branch per floor.
export function buildCutaway(ring, height, road) {
  const floorH = 3.4;
  const floors = Math.max(1, Math.min(40, Math.round(height / floorH)));
  const core = interiorPoint(ring);
  // entry point: the wall vertex closest to the street
  let entry = ring[0], bestD = Infinity;
  for (const v of ring) { const d = segLenM(v, road.pt); if (d < bestD) { bestD = d; entry = v; } }
  const inward = (p, f) => [p[0] + (core[0] - p[0]) * f, p[1] + (core[1] - p[1]) * f];
  const meter = inward(entry, 0.18);
  const sensor = inward(entry, 0.32);
  const riserBase = inward(entry, 0.55);
  // the street main runs along the road, 40 m each way
  const len = Math.hypot(road.dir[0] * mPerDegLon(road.pt[1]), road.dir[1] * M_PER_DEG_LAT) || 1;
  const u = [(road.dir[0] / len) * 40, (road.dir[1] / len) * 40];
  const mainA = [road.pt[0] - u[0], road.pt[1] - u[1], 0.4], mainB = [road.pt[0] + u[0], road.pt[1] + u[1], 0.4];
  const z0 = 0.6;
  const paths = [
    makePath([mainA, [...road.pt, 0.4], mainB], { kind: 'main', color: [90, 155, 189], gapScale: 1.6 }),
    makePath([[...road.pt, 0.4], [...entry, z0], [...meter, z0]], { kind: 'service', color: [90, 155, 189] }),
    makePath([[...meter, z0], [...sensor, z0], [...riserBase, z0]], { kind: 'service', color: [90, 155, 189] }),
    makePath([[...riserBase, z0], [...riserBase, (floors - 1) * floorH + 1.2]], { kind: 'riser', color: [90, 155, 189], speedScale: 0.6, gapScale: 0.5 }),
  ];
  const taps = [];
  // Two branch runs per floor toward opposite sides of the building.
  const far = ring.reduce((a, v) => (segLenM(v, riserBase) > segLenM(a, riserBase) ? v : a), ring[0]);
  const side = ring.reduce((a, v) => {
    const s = (v[0] - riserBase[0]) * (far[1] - riserBase[1]) - (v[1] - riserBase[1]) * (far[0] - riserBase[0]);
    const sa = (a[0] - riserBase[0]) * (far[1] - riserBase[1]) - (a[1] - riserBase[1]) * (far[0] - riserBase[0]);
    return Math.abs(s) > Math.abs(sa) ? v : a;
  }, ring[0]);
  for (let f = 0; f < floors; f++) {
    const z = f * floorH + 1.2;
    for (const target of [far, side]) {
      const t = [riserBase[0] + (target[0] - riserBase[0]) * 0.7, riserBase[1] + (target[1] - riserBase[1]) * 0.7];
      paths.push(makePath([[...riserBase, z], [...t, z]], { kind: 'branch', color: [90, 155, 189], gapScale: 0.5, speedScale: 0.5 }));
      taps.push({ pos: [...t, z], floor: f + 1 });
    }
  }
  const slabs = [];
  for (let f = 0; f <= floors; f++) slabs.push({ ring, z: Math.min(f * floorH, height) });
  const labels = [
    { pos: [...mainB.slice(0, 2), 1.5], text: `Water main${road.name ? ` under ${road.name}` : ''}` },
    { pos: [...entry, 2], text: 'Service line' },
    { pos: [...meter, 2.6], text: 'Meter + shutoff' },
    { pos: [...sensor, 4.2], text: 'Clarity test point' },
    { pos: [...riserBase, (floors - 1) * floorH + 3.2], text: `Riser to ${floors} floor${floors > 1 ? 's' : ''}` },
  ];
  return { floors, paths, taps, slabs, labels, core, entry, meter, sensor, riserBase };
}
