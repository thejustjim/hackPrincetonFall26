// Builds public/data/land.json: world land (Natural Earth 50m, via world-atlas) minus nothing,
// the US outline and state borders (Census 1:10M, via us-atlas). Coordinates rounded to 3 decimals (~100 m).
const fs = require('fs');
const topo = require('topojson-client');
const out = process.argv[2];
const r = c => (typeof c[0] === 'number' ? [Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000] : c.map(r));
const clean = g => ({ type: g.type, coordinates: r(g.coordinates) });
const world = JSON.parse(fs.readFileSync('node_modules/world-atlas/countries-50m.json'));
const countries = topo.feature(world, world.objects.countries).features;
const usTopo = JSON.parse(fs.readFileSync('node_modules/us-atlas/states-10m.json'));
const nation = topo.feature(usTopo, usTopo.objects.nation);
const nationGeom = nation.features ? nation.features[0].geometry : nation.geometry;
const borders = topo.mesh(usTopo, usTopo.objects.states, (a, b) => a !== b);
const feats = [
  ...countries.filter(f => f.id !== '840' && f.geometry).map(f => ({ type: 'Feature', properties: { k: 'other' }, geometry: clean(f.geometry) })),
  { type: 'Feature', properties: { k: 'us' }, geometry: clean(nationGeom) },
  { type: 'Feature', properties: { k: 'states' }, geometry: clean(borders) },
];
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features: feats }));
console.log(out, (fs.statSync(out).size / 1e6).toFixed(2), 'MB', feats.length, 'features');
