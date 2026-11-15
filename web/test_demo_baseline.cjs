const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

function demo(seed = 26) {
  const window = {}, timers = new Map();
  let clock = 0, nextTimer = 1;
  function schedule(fn, delay, repeat = false) {
    const id = nextTimer++;
    timers.set(id, { fn, at: clock + delay, delay, repeat });
    return id;
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'assets/sample.js'), 'utf8'), {
    window, location: { search: '' }, URL, URLSearchParams, Math, Date,
    setTimeout: (fn, ms) => schedule(fn, ms),
    setInterval: (fn, ms) => schedule(fn, ms, true),
  });
  const api = window.TapSample.create({ seed });
  return { api, advance(to) {
    let steps = 0;
    for (;;) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!timer || timer.at > to) break;
      assert.ok(++steps < 10000, 'timer replay terminates');
      clock = timer.at;
      timers.delete(id);
      if (timer.repeat) timers.set(id, { ...timer, at: clock + timer.delay });
      timer.fn();
    }
    clock = to;
  } };
}

function healthyPeers(rows) {
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.mock, true);
    assert.equal(r.source, 'sample');
    assert.equal(r.verdict, 'SAFE');
    assert.ok(r.tds >= 172 && r.tds <= 229);
    assert.ok(r.clarity >= 0.92 && r.clarity <= 0.99);
    assert.equal(r.ph_est, false);
    assert.ok(r.ph >= 7.25 && r.ph <= 7.7);
  }
}

test('normal sample peers remain healthy over multiple seeds and preserve source boundaries', async () => {
  for (let seed = 0; seed < 32; seed++) {
    const { api } = demo(seed);
    const rows = await api.get('/api/readings?limit=1500');
    healthyPeers(rows.filter(r => r.sim));
    assert.ok(rows.every(r => r.session && Number.isInteger(r.seq)));
    const health = await api.get('/health');
    assert.match(health.demo_context.note, /not current tap measurements/);
    assert.match(health.demo_context.note, /demo assumptions/);
    assert.equal(health.demo_context.sources[0].url, 'https://amwater.com/ccr/raritan.pdf');
    const refs = await api.get('/api/reference');
    assert.ok(refs.every(r => r.source_kind === 'published_stream' && r.water_type === 'untreated_surface_water' && r.live === false));
  }
});

test('fifty demo cup cycles keep background peers and demonstration cartridges functional', async () => {
  const run = demo(26), events = [];
  run.api.subscribe(event => events.push(event), status => assert.equal(status, 'demo'));
  run.advance(16_000 + 50 * 24_000);
  const rows = events.filter(e => e.type === 'reading');
  healthyPeers(rows.filter(r => r.sim));
  const cups = rows.filter(r => !r.sim);
  assert.ok(cups.some(r => r.sample_case === 'cloudy' && r.phase === 'before' && r.filter === 'BRITA'));
  assert.ok(cups.some(r => r.sample_case === 'salty' && r.phase === 'before' && r.filter === 'ZEROWATER'));
  assert.ok(cups.every(r => r.ph_est === true));
  for (const after of cups.filter(r => r.phase === 'after')) {
    const before = cups.find(r => r.test === after.test && r.session === after.session && r.phase === 'before');
    assert.ok(before);
    assert.equal(after.sample_case, before.sample_case);
    assert.equal(after.verdict, 'SAFE');
    if (before.filter === 'ZEROWATER') assert.ok(after.tds < 6);
  }
  assert.equal(new Set(rows.map(r => `${r.node}/${r.session}/${r.seq}`)).size, rows.length);
  const filters = await run.api.get('/api/filters');
  assert.ok(filters.every(f => f.status === 'OK'));
  for (const report of events.filter(e => e.type === 'report')) {
    assert.equal(report.source, 'sample');
    assert.match(report.notice, /^Demo example:/);
    assert.doesNotMatch(report.findings.join(' '), /Measured:/);
    assert.equal(report.checks.baseline.find(r => r.metric === 'ph').included, false);
  }
});

test('map mock uses the same quiet baseline and separates public stream records', async () => {
  const url = pathToFileURL(path.join(__dirname, '../clarity-dashboard-2/src/mock.js'));
  const { mockApi, DEMO_CONTEXT } = await import(url.href);
  healthyPeers((await mockApi.readings(null, 1000)).filter(r => r.sim));
  const tank = await mockApi.readings('tank-01', 1000);
  assert.ok(tank.every(r => r.mock && r.source === 'sample' && r.ph_est === true));
  assert.match(DEMO_CONTEXT.note, /demo assumptions/);
  const sampleRefs = await demo().api.get('/api/reference');
  assert.deepEqual(JSON.parse(JSON.stringify(await mockApi.reference())), JSON.parse(JSON.stringify(sampleRefs)));
});
