// Offline map examples only (?mock=1). Background sites stay healthy; deliberate
// cloudy / high-mineral cups cycle on the tank. Network stress cases are opt-in
// in the Simulation view, never random sensor failures on the Princeton map.
// Public reports establish the local water-supply context, not tap TDS readings.
export const DEMO_CONTEXT = {
  kind: 'illustrative', place: 'Princeton, NJ',
  note: 'Synthetic readings, not current tap measurements. Normal TDS baselines of 180–220 ppm, small variation, and device transparency are demo assumptions. Transparency is not utility-reported NTU. Public stream references are separate untreated-water samples.',
  sources: [
    { title: 'NJ American Water · 2025 Raritan water quality report', url: 'https://amwater.com/ccr/raritan.pdf' },
    { title: 'Princeton · 2025 Environmental Resource Inventory, §7.3', url: 'https://www.princetonnj.gov/DocumentCenter/View/20490/250417-Princeton-ERI-ADOPTED-web_64MB' },
  ],
};
const NODES = [
  { node: 'tank-01', name: 'Clarity Tank (Princeton)', lat: 40.347, lon: -74.6555, sim: false, baseTds: 185 },
  { node: 'sim-01', name: 'Kingston', lat: 40.3753, lon: -74.6145, sim: true, baseTds: 190 },
  { node: 'sim-02', name: 'Lawrenceville', lat: 40.2971, lon: -74.7298, sim: true, baseTds: 205 },
  { node: 'sim-03', name: 'Rocky Hill', lat: 40.399, lon: -74.6385, sim: true, baseTds: 195 },
  { node: 'sim-04', name: 'Plainsboro', lat: 40.3335, lon: -74.5885, sim: true, baseTds: 220 },
  { node: 'sim-05', name: 'Princeton Junction', lat: 40.3168, lon: -74.6238, sim: true, baseTds: 200 },
  { node: 'sim-06', name: 'Lake Carnegie Boathouse', lat: 40.3335, lon: -74.6275, sim: true, baseTds: 205 },
];
// Same published stream records as gateway/reference.json. Never use these as tap baselines.
const REFERENCE = [
  { site: 'Stony Brook', lat: 40.3331, lon: -74.6819, tds_est: 109, date: '2023-07-27', source: 'NJ DEP', typical_tds_est: 180 },
  { site: 'Millstone River', lat: 40.3133, lon: -74.5892, tds_est: 299, date: '2025-11-24', source: 'NJ DEP', typical_tds_est: 248 },
  { site: 'Lake Carnegie', lat: 40.3446, lon: -74.6295, tds_est: 92, date: '2023-11-29', source: 'NJ DEP', typical_tds_est: 177 },
].map(r => ({ ...r, source_kind: 'published_stream', water_type: 'untreated_surface_water', live: false }));
// The rig carries one filter, a Brita: anything out of range goes through it.
const FILTERS = [
  { filter: 'BRITA', liters: 35, last_after_tds: 175, status: 'OK', rated_liters: 450 },
];
const SESSION = `map-${Date.now().toString(16)}-${Math.floor(Math.random()*0xffffff).toString(16)}`;
let nextId = 1;
const readings = [], testCounter = {};
const rnd = (a, b) => a + Math.random() * (b-a);
const round = (x, d = 0) => { const p = 10 ** d; return Math.round(x*p)/p; };
const derivedPH = tds => round(Math.max(7, Math.min(8.3, 7 + (tds-150)*1.3/650)), 2);
function verdictFor(r) {
  if (r.tds > 300) return 'HIGH_TDS';
  if (r.clarity < 0.70) return 'CLOUDY';
  if (!r.ph_est && (r.ph < 6.5 || r.ph > 8.5)) return 'PH_WARN';
  return 'SAFE';
}
const ruleFilter = r => r.tds > 300 || r.clarity < 0.70 ? 'BRITA' : 'NONE';
function explain(r) {
  if (r.phase === 'after') {
    const b = readings.find(x => x.node === r.node && x.test === r.test && x.phase === 'before' && x.session === r.session);
    return b && b.clarity < 0.70 ? `Transparency ${b.clarity} → ${r.clarity} through the Brita.`
      : `Dissolved solids ${b?.tds} → ${r.tds} ppm through the Brita, still high.`;
  }
  if (r.tds > 300) return `Dissolved solids read ${r.tds} ppm, over 300, so the cup goes to the Brita. The retest follows.`;
  if (r.clarity < 0.70) return `Transparency read ${r.clarity}, under 0.70, so the cup goes to the Brita. The retest follows.`;
  return `Dissolved solids ${r.tds} ppm and transparency ${r.clarity} are in range. No filter is needed.`;
}
function makeReading(n, phase, test, { ts = new Date(), before, cup = 'normal' } = {}) {
  const id = nextId++;
  let tds = round(n.baseTds * rnd(0.96, 1.04)), clarity = round(rnd(0.92, 0.98), 2);
  if (phase === 'before' && cup === 'cloudy') { tds = round(rnd(190, 220)); clarity = round(rnd(0.40, 0.47), 2); }
  if (phase === 'before' && cup === 'salty') { tds = round(rnd(740, 800)); clarity = round(rnd(0.92, 0.97), 2); }
  if (phase === 'after') {
    // An illustrative Brita response, not a measured one: dissolved solids barely move, cloudy water clears.
    tds = round(before.tds * rnd(0.95, 1.0));
    clarity = before.clarity < 0.70 ? round(rnd(0.86, 0.95), 2) : round(Math.min(0.99, before.clarity + rnd(0, 0.02)), 2);
    cup = before.sample_case;
  }
  const r = { type: 'reading', id, ts: ts.toISOString().replace(/\.\d+Z$/, '+00:00'), node: n.node,
    session: SESSION, seq: id, test, phase, ph: n.sim ? round(rnd(7.25, 7.70), 2) : derivedPH(tds), ph_est: !n.sim,
    tds, clarity, filter: phase === 'after' ? before.filter : null, ai_filter: null,
    rssi: round(n.sim ? rnd(-85, -65) : rnd(-68, -55)), lat: n.lat, lon: n.lon, sim: n.sim, mock: true,
    anomaly: phase === 'before' && cup !== 'normal' ? 0.78 : round(rnd(0.02, 0.12), 2),
    source: 'sample', sample_case: cup, explanation: null };
  if (phase === 'before') r.filter = ruleFilter(r);
  r.verdict = verdictFor(r); return r;
}
function seed() {
  const now = Date.now();
  for (const n of NODES) {
    testCounter[n.node] = 0;
    for (let i = n.sim ? 14 : 20; i >= 1; --i) {
      const r = makeReading(n, 'before', ++testCounter[n.node], { ts: new Date(now-i*45*60000) });
      r.ai_filter = r.filter; r.explanation = explain(r); readings.push(r);
    }
  }
  const n = NODES[0], r = makeReading(n, 'before', ++testCounter[n.node], { ts: new Date(now-60000) });
  r.tds = 185; r.ph = derivedPH(185); r.filter = r.ai_filter = 'NONE'; r.explanation = explain(r); readings.push(r);
}
seed();
const latestFor = node => [...readings].reverse().find(r => r.node === node);
export const mockApi = {
  async context() { return JSON.parse(JSON.stringify(DEMO_CONTEXT)); },
  async nodes() { return NODES.map(({ baseTds, ...n }) => ({ ...n, latest: latestFor(n.node) || null })); },
  async readings(node, limit = 100) { return readings.filter(r => !node || r.node === node).slice(-limit).reverse(); },
  async test(node, test) {
    const pairs = readings.filter(r => r.node === node && r.test === Number(test));
    const b = pairs.find(r => r.phase === 'before') || null;
    return [b, pairs.find(r => r.phase === 'after' && (r.session ?? null) === (b?.session ?? null)) || null];
  },
  async filters() { return FILTERS.map(f => ({ ...f })); },
  async reference() { return REFERENCE.map(r => ({ ...r })); },
};
export function mockSocket(onMessage) {
  const timers = [], intervals = []; let stopped = false, caseIndex = 0, siteIndex = 0;
  const emit = value => { if (!stopped) onMessage(value); };
  const later = (fn, ms) => timers.push(setTimeout(() => { if (!stopped) fn(); }, ms));
  const pour = (n, cup = 'normal') => {
    const before = makeReading(n, 'before', ++testCounter[n.node], { cup }); readings.push(before); emit({ ...before });
    later(() => {
      before.ai_filter = before.filter; before.explanation = explain(before);
      emit({ type: 'decision', id: before.id, node: n.node, test: before.test, phase: 'before',
        ai_filter: before.filter, explanation: before.explanation, source: 'sample' });
      if (before.filter === 'NONE') return;
      later(() => {
        const after = makeReading(n, 'after', before.test, { before }); readings.push(after); emit({ ...after });
        after.ai_filter = after.filter; after.explanation = explain(after);
        emit({ type: 'decision', id: after.id, node: n.node, test: after.test, phase: 'after',
          ai_filter: after.filter, explanation: after.explanation, source: 'sample' });
        const f = FILTERS.find(f => f.filter === after.filter);
        if (f) {
          f.liters = round(f.liters + 0.1, 1); f.last_after_tds = after.tds;
          f.status = f.liters >= 450 ? 'REPLACE' : f.liters >= 405 ? 'REPLACE_SOON' : 'OK';
        }
        later(() => emit({ type: 'report', node: n.node, test: after.test, source: 'sample',
          summary: explain(after), findings: [
            before.clarity < 0.70 ? `Transparency ${before.clarity} → ${after.clarity}.` : `Dissolved solids ${before.tds} → ${after.tds} ppm.`],
          actions: [before.clarity < 0.70 ? 'Nothing further for this pour.' : 'Still high after the Brita: this water needs a filter made for dissolved solids.'] }), 2500);
      }, 6000);
    }, 2500);
  };
  const tankCycle = () => pour(NODES[0], ['cloudy', 'normal', 'salty'][caseIndex++ % 3]);
  const background = () => pour(NODES[1 + siteIndex++ % (NODES.length-1)]);
  later(() => { background(); intervals.push(setInterval(background, 18000)); }, 3000);
  later(() => { tankCycle(); intervals.push(setInterval(tankCycle, 24000)); }, 16000);
  return { close() { stopped = true; intervals.forEach(clearInterval); timers.forEach(clearTimeout); } };
}
