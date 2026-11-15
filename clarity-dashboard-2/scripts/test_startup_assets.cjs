const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const functions = main.slice(main.indexOf('async function loadExtras() {'), main.indexOf('\nfunction buildSearchIndex()'));
function setup(intro = { active: true }) {
  const requests = [], idle = [], events = new Map(), state = {};
  let renders = 0, indexes = 0;
  const objects = {
    'water_infra.json': [{ k: 'water_tower', pos: [-74.65, 40.37] }],
    'trees.json': Array.from({ length: 30 }, (_, i) => [i, i, 1]),
    'road_labels.json': [[-74.6, 40.3, 0, 'Nassau Street', 1]],
    'building-labels.json': [{ label: 'Nassau Hall', pos: [-74.659, 40.348], zoom: 17, h: 20 }],
    'places.json': { features: [{ geometry: { coordinates: [-74.66, 40.35] }, properties: { n: 'Princeton', c: 'university' } }] },
  };
  const context = vm.createContext({ state, intro,
    window: {
      requestIdleCallback(fn) { assert.equal(this, context.window); idle.push(fn); },
      addEventListener(name, fn, options) { assert.equal(options.once, true); events.set(name, fn); },
    },
    fetch: async url => {
      requests.push(url);
      const name = url.split('/').pop();
      assert.ok(Object.hasOwn(objects, name), `unexpected large or external fetch: ${url}`);
      return { ok: true, json: async () => objects[name] };
    },
    renderMap() { renders++; }, renderSourcePanel() {}, buildSearchIndex() { indexes++; }, setTimeout() { throw new Error('Idle API exists'); },
  });
  vm.runInContext(functions, context);
  return { context, state, requests, idle, events, get renders() { return renders; }, get indexes() { return indexes; } };
}
test('infrastructure renders immediately while decorative layers wait for arrival and idle', async () => {
  const run = setup();
  await run.context.loadExtras();
  assert.deepEqual(run.requests, ['./data/water_infra.json']);
  assert.equal(run.state.infra[0].k, 'water_tower');
  assert.equal(run.renders, 1);
  assert.equal(run.idle.length, 0);
  const arrived = run.events.get('clarity:map-arrived');
  assert.equal(typeof arrived, 'function');
  arrived(); arrived();
  assert.equal(run.idle.length, 1, 'detail starts once');
  await run.idle[0]();
  assert.equal(run.state.trees.length, 10);
  assert.deepEqual(run.state.trees.map(p => p[0]), [0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
  assert.equal(run.state.roadLabels[0][3], 'Nassau Street');
});
test('nointro/reduced motion still schedules decorations without an arrival event', async () => {
  const run = setup(undefined);
  run.context.intro = undefined;
  await run.context.loadExtras();
  assert.equal(run.events.size, 0);
  assert.equal(run.idle.length, 1);
  assert.deepEqual(run.requests, ['./data/water_infra.json']);
  await run.idle[0]();
  assert.equal(run.state.trees.length, 10);
});
test('search consumes compact point labels without fetching building polygons', async () => {
  const run = setup();
  await run.context.loadPlaces();
  assert.deepEqual(run.requests.sort(), ['./data/building-labels.json', './data/places.json']);
  assert.equal(run.state.namedBuildings[0].label, 'Nassau Hall');
  assert.equal(run.state.namedBuildings[0].h, 20);
  assert.equal(run.state.places[0].n, 'Princeton');
  assert.equal(run.indexes, 1);
});
