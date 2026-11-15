// Mock backend that matches the gateway's API and /ws message shapes exactly.
// Only used when the page is opened with ?mock=1 (UI work and tests). Never shown as real data.

const NODES = [
  { node: 'tank-01', name: 'Clarity Tank (Princeton)', lat: 40.347, lon: -74.6555, sim: false, baseTds: 480 },
  { node: 'sim-01', name: 'Kingston', lat: 40.3753, lon: -74.6145, sim: true, baseTds: 210 },
  { node: 'sim-02', name: 'Lawrenceville', lat: 40.2971, lon: -74.7298, sim: true, baseTds: 340 },
  { node: 'sim-03', name: 'Rocky Hill', lat: 40.399, lon: -74.6385, sim: true, baseTds: 260 },
  { node: 'sim-04', name: 'Plainsboro', lat: 40.3335, lon: -74.5885, sim: true, baseTds: 780 },
  { node: 'sim-05', name: 'Princeton Junction', lat: 40.3168, lon: -74.6238, sim: true, baseTds: 150 },
  { node: 'sim-06', name: 'Lake Carnegie Boathouse', lat: 40.3335, lon: -74.6275, sim: true, baseTds: 395 },
];

const REFERENCE = [ // copied from the gateway's cached reference.json (USGS Water Quality Portal)
  { site: 'Stony Brook', lat: 40.3323, lon: -74.6535, tds_est: 251, date: '2019-09-05', source: 'USGS' },
  { site: 'Millstone River', lat: 40.3158, lon: -74.6005, tds_est: 222, date: '2024-06-13', source: 'USGS' },
  { site: 'Lake Carnegie', lat: 40.3427, lon: -74.6449, tds_est: 96, date: '2023-07-19', source: 'USGS' },
];

const FILTERS = [
  { filter: 'ZEROWATER', liters: 3.2, last_after_tds: 8, status: 'REPLACE' },
  { filter: 'BRITA', liters: 402.5, last_after_tds: 165, status: 'REPLACE_SOON' },
];

let nextId = 1;
const readings = []; // all readings, oldest first
const testCounter = {};

function rnd(a, b) { return a + Math.random() * (b - a); }
function round(x, d = 0) { const p = 10 ** d; return Math.round(x * p) / p; }

function verdictFor(r) {
  if (r.ph < 6.5 || r.ph > 8.5) return 'PH_WARN';
  if (r.clarity < 0.6) return 'CLOUDY';
  if (r.tds > 300) return 'HIGH_TDS';
  return 'SAFE';
}

function ruleFilter(tds) {
  if (tds > 300) return 'ZEROWATER';
  if (tds > 120) return 'BRITA';
  return 'NONE';
}

function explain(r) {
  if (r.phase === 'after') {
    const pair = readings.find(x => x.node === r.node && x.test === r.test && x.phase === 'before');
    const drop = pair ? Math.round((1 - r.tds / pair.tds) * 100) : 0;
    return `After filtering with ${r.filter === 'ZEROWATER' ? 'ZeroWater' : r.filter === 'BRITA' ? 'Brita Elite' : 'no filter'}, ` +
      `TDS fell from ${pair ? pair.tds : '?'} to ${r.tds} ppm (${drop}% removed). pH ${r.ph} and clarity ${r.clarity} are within normal range.`;
  }
  if (r.tds > 300) return `TDS is ${r.tds} ppm, above the 300 ppm comfort level and ${r.tds > 500 ? 'over' : 'close to'} the EPA 500 ppm secondary limit. ZeroWater's 5-stage ion-exchange filter removes dissolved solids that a carbon filter like Brita leaves behind, so ZeroWater is the right pick here.`;
  if (r.tds > 120) return `TDS is ${r.tds} ppm: drinkable but with noticeable taste. A Brita Elite will improve taste and chlorine at lower cost per liter than ZeroWater.`;
  return `TDS is ${r.tds} ppm with normal pH and good clarity. No filter is needed.`;
}

function makeReading(n, phase, test, opts = {}) {
  const t = opts.ts || new Date();
  let tds, ph, clarity;
  if (phase === 'before') {
    tds = Math.max(20, round(n.baseTds * rnd(0.85, 1.15) + (opts.spike ? 300 : 0)));
    ph = round(rnd(6.8, 7.9) - (opts.spike ? 0.9 : 0), 2);
    clarity = round(Math.min(1, rnd(0.7, 0.97) - (opts.spike ? 0.25 : 0)), 2);
  } else {
    const before = opts.before;
    const f = before.filter;
    tds = f === 'ZEROWATER' ? round(rnd(2, 12)) : f === 'BRITA' ? round(before.tds * rnd(0.6, 0.8)) : before.tds;
    ph = round(rnd(6.9, 7.6), 2);
    clarity = round(rnd(0.92, 0.99), 2);
  }
  const r = {
    type: 'reading', id: nextId++, ts: t.toISOString().replace(/\.\d+Z$/, '+00:00'),
    node: n.node, test, phase, ph, tds, clarity, verdict: null,
    filter: phase === 'before' ? ruleFilter(tds) : opts.before.filter,
    ai_filter: null, rssi: Math.round(n.sim ? rnd(-112, -78) : rnd(-68, -55)),
    lat: n.lat, lon: n.lon, sim: n.sim,
    anomaly: round(Math.min(1, opts.spike ? rnd(0.75, 0.95) : rnd(0.05, 0.35)), 2),
    explanation: null,
  };
  r.verdict = verdictFor(r);
  return r;
}

function seed() {
  const now = Date.now();
  for (const n of NODES) {
    testCounter[n.node] = 0;
    const count = n.sim ? 14 : 20;
    for (let i = count; i >= 1; i--) {
      const ts = new Date(now - i * 45 * 60 * 1000);
      const test = ++testCounter[n.node];
      const before = makeReading(n, 'before', test, { ts, spike: n.node === 'sim-04' && i === 3 });
      before.ai_filter = before.filter;
      before.explanation = explain(before);
      readings.push(before);
      if (before.filter !== 'NONE') {
        const after = makeReading(n, 'after', test, { ts: new Date(ts.getTime() + 4 * 60 * 1000), before });
        readings.push(after);
        after.ai_filter = after.filter;
        after.explanation = explain(after);
      }
    }
  }
  // The demo's hero pair: 780 -> 8 ppm on the tank, ZeroWater.
  const n = NODES[0];
  const test = ++testCounter[n.node];
  const ts = new Date(now - 6 * 60 * 1000);
  const before = { ...makeReading(n, 'before', test, { ts }), tds: 780, ph: 7.34, clarity: 0.81 };
  before.verdict = verdictFor(before); before.filter = 'ZEROWATER'; before.ai_filter = 'ZEROWATER';
  readings.push(before); before.explanation = explain(before);
  const after = { ...makeReading(n, 'after', test, { ts: new Date(ts.getTime() + 3 * 60 * 1000), before }), tds: 8, ph: 7.12, clarity: 0.98 };
  after.verdict = verdictFor(after); after.ai_filter = 'ZEROWATER';
  readings.push(after); after.explanation = explain(after);
}
seed();

const latestFor = node => [...readings].reverse().find(r => r.node === node);

export const mockApi = {
  async nodes() {
    return NODES.map(({ baseTds, ...n }) => ({ ...n, latest: latestFor(n.node) || null }));
  },
  async readings(node, limit = 100) {
    const rs = readings.filter(r => !node || r.node === node);
    return rs.slice(-limit).reverse(); // newest first, like a typical SQL ORDER BY id DESC
  },
  async test(node, test) {
    const pair = readings.filter(r => r.node === node && r.test === Number(test));
    return [pair.find(r => r.phase === 'before') || null, pair.find(r => r.phase === 'after') || null];
  },
  async filters() { return FILTERS.map(f => ({ ...f })); },
  async reference() { return REFERENCE.map(r => ({ ...r })); },
};

// Simulated /ws: emits reading -> decision -> (after) reading -> decision -> report.
export function mockSocket(onMessage) {
  const timers = [];
  const cycle = () => {
    // tank-01 is the real hardware on the demo table, so the mock only drives the simulated nodes.
    const n = NODES[1 + Math.floor(Math.random() * (NODES.length - 1))];
    const test = ++testCounter[n.node];
    const spike = Math.random() < 0.2;
    const before = makeReading(n, 'before', test, { spike });
    readings.push(before);
    onMessage({ ...before });
    timers.push(setTimeout(() => {
      before.ai_filter = before.tds > 280 ? 'ZEROWATER' : before.filter;
      before.filter = before.ai_filter;
      before.explanation = explain(before);
      onMessage({ type: 'decision', id: before.id, node: n.node, test, phase: 'before',
        ai_filter: before.ai_filter, explanation: before.explanation, source: 'gemini' });
      if (before.ai_filter === 'NONE') return;
      timers.push(setTimeout(() => {
        const after = makeReading(n, 'after', test, { before });
        readings.push(after);
        onMessage({ ...after });
        const f = FILTERS.find(x => x.filter === after.filter);
        if (f) {
          f.liters = round(f.liters + 0.1 * Math.round(rnd(3, 8)), 1);
          f.last_after_tds = after.tds;
          // Same rules as the gateway: ZeroWater REPLACE at an after-test >= 6 ppm;
          // Brita Elite REPLACE_SOON at 360 L, REPLACE at 450 L.
          f.status = f.filter === 'ZEROWATER' ? (after.tds >= 6 ? 'REPLACE' : 'OK')
            : (f.liters >= 450 ? 'REPLACE' : f.liters >= 360 ? 'REPLACE_SOON' : 'OK');
        }
        timers.push(setTimeout(() => {
          after.ai_filter = after.filter;
          after.explanation = explain(after);
          onMessage({ type: 'decision', id: after.id, node: n.node, test, phase: 'after',
            ai_filter: after.ai_filter, explanation: after.explanation, source: 'gemini' });
          timers.push(setTimeout(() => {
            // Nearest USGS reference, only if it's actually nearby.
            const near = REFERENCE.map(r => ({ r, d: Math.hypot(r.lat - n.lat, (r.lon - n.lon) * 0.77) })).sort((a, b) => a.d - b.d)[0];
            const ref = near && near.d < 0.5 ? near.r : null;
            onMessage({ type: 'report', node: n.node, test,
              summary: `${n.name}: TDS ${before.tds} → ${after.tds} ppm with ${after.filter === 'ZEROWATER' ? 'ZeroWater' : 'Brita'}. ` +
                (!ref ? 'No USGS reference site is loaded near this node.' : before.tds > ref.tds_est * 1.3 ? `Source water is well above nearby ${ref.site} (${ref.tds_est} ppm, USGS), which points to local plumbing or softener brine rather than the watershed.` : `Source water is in line with nearby ${ref.site} (${ref.tds_est} ppm, USGS).`),
              findings: [
                `Before-filter TDS ${before.tds} ppm vs site median ${n.baseTds} ppm (anomaly ${before.anomaly}).`,
                `${f ? `${f.filter} has filtered ${f.liters} L; last after-test ${f.last_after_tds} ppm.` : 'No filter log.'}`,
                ...(ref ? [`Nearest USGS reference: ${ref.site}, est. ${ref.tds_est} ppm (${ref.date}).`] : []),
              ],
              actions: [
                f && f.status !== 'OK' ? `Replace the ${f.filter === 'ZEROWATER' ? 'ZeroWater' : 'Brita Elite'} cartridge (${f.status.replace('_', ' ').toLowerCase()}).` : 'Keep the current filter; it is performing well.',
                before.anomaly > 0.6 ? 'Retest tomorrow to confirm the spike.' : 'No follow-up test needed.',
              ] });
          }, 2500));
        }, 2500));
      }, 6000));
    }, 2500));
  };
  const iv = setInterval(cycle, 22000);
  timers.push(setTimeout(cycle, 3000));
  return { close() { clearInterval(iv); timers.forEach(clearTimeout); } };
}
