import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Headless layer factories isolate display-data behavior from WebGL drivers.
class TestLayer { constructor(props) { this.id = props.id; this.props = props; } }
const PathLayer = TestLayer, ScatterplotLayer = TestLayer, TextLayer = TestLayer;
import { projectNetwork, overlayFeatures, createSimulationOverlay, simulationTooltip, DEMO_OVERLAY } from './src/sim-overlay.js';
import { scenarioAtTime } from './src/simulation.js';
const network = JSON.parse(readFileSync(new URL('../web/network/data.json', import.meta.url)));
const placement = JSON.parse(readFileSync(new URL('../web/network/placement.json', import.meta.url)));
const original = JSON.stringify(network), geometry = projectNetwork(network);
assert.equal(geometry.nodes.length, network.nodes.length);
assert.equal(geometry.pipes.length, 117);
assert.equal(geometry.pumps.length, network.pumps.length);
assert.deepEqual(geometry.pipes.map(p => p.id), network.pipes.map(p => p.id));
const byId = new Map(geometry.nodes.map(n => [n.id, n]));
for (const p of geometry.pipes) assert.deepEqual(p.path, [byId.get(p.from).position, byId.get(p.to).position]);
const [sw, ne] = geometry.bounds;
assert.ok(sw[0] > -74.71 && ne[0] < -74.6 && sw[1] > 40.32 && ne[1] < 40.4);
assert.ok(Math.abs((sw[0] + ne[0]) / 2 - DEMO_OVERLAY.center[0]) < 1e-10);
assert.ok(Math.abs((sw[1] + ne[1]) / 2 - DEMO_OVERLAY.center[1]) < 1e-10);
assert.ok(Math.abs((ne[0] - sw[0]) * 111.32 * Math.cos(DEMO_OVERLAY.center[1] * Math.PI / 180) - 6) < 1e-8);
// One display scale in both axes preserves local relative lengths and angles.
const a = geometry.nodes[0], b = geometry.nodes[20];
const east = (b.position[0] - a.position[0]) * 111.32 * Math.cos(DEMO_OVERLAY.center[1] * Math.PI / 180);
const north = (b.position[1] - a.position[1]) * 111.32;
assert.ok(Math.abs(east * (b.y - a.y) - north * (b.x - a.x)) < 1e-8);
assert.equal(JSON.stringify(network), original);
assert.equal(projectNetwork({ nodes: [], pipes: [] }).bounds, null);
const scenario = network.scenarios[0];
const state = { network, placement, scenario, visibleScenario: scenarioAtTime(scenario, 0, network.sensors), mode: 'events', revealed: false };
let f = overlayFeatures(state, geometry);
assert.equal(f.nodes.filter(n => n.status === 'waiting').length, 12);
assert.equal(f.nodes.filter(n => n.status === 'alert').length, 0);
assert.equal(f.pipes.filter(p => p.candidate || p.truth).length, 0, 'raw final ranking/truth must not leak into replay');
const first = scenario.alerts[0];
f = overlayFeatures({ ...state, visibleScenario: scenarioAtTime(scenario, first.minute, network.sensors) }, geometry);
assert.equal(f.nodes.find(n => n.id === first.sensor).status, 'alert');
assert.equal(f.pipes.filter(p => p.candidate).length, 0);
const finished = { ...state, visibleScenario: scenarioAtTime(scenario, 360, network.sensors) };
f = overlayFeatures(finished, geometry);
assert.equal(f.nodes.filter(n => n.status === 'alert').length, scenario.alerts.length);
assert.equal(f.pipes.filter(p => p.candidate).length, scenario.candidates.length);
assert.equal(f.pipes.filter(p => p.truth).length, 0);
f = overlayFeatures({ ...finished, revealed: true }, geometry);
assert.deepEqual(f.pipes.filter(p => p.truth).map(p => p.id), [scenario.truth.pipe]);
const missing = network.scenarios.find(s => s.unavailable.length);
f = overlayFeatures({ ...state, scenario: missing, visibleScenario: scenarioAtTime(missing, 360, network.sensors) }, geometry);
for (const id of missing.unavailable) {
  const n = f.nodes.find(n => n.id === id);
  assert.equal(n.status, 'unavailable'); assert.match(simulationTooltip(n), /not a quiet reading/);
}
const plan = placement.budgets.find(p => p.budget === 12);
f = overlayFeatures({ ...finished, mode: 'placement', plan, revealed: true }, geometry);
assert.equal(f.nodes.filter(n => n.proposed).length, 12);
assert.equal(f.pipes.filter(p => p.coverage >= 1).length, plan.metrics.observed);
assert.equal(f.pipes.filter(p => p.coverage === 2).length, plan.metrics.localized);
assert.equal(f.pipes.filter(p => p.candidate || p.truth).length, 0);
// The Simulation tab says once what this is; a tooltip names the pipe and what is known about it.
assert.match(simulationTooltip(f.pipes[0]), /^Pipe \S+\n.+\nClick to inspect\.$/);
assert.equal(simulationTooltip({ node: 'real-hardware' }), null);
// Verify the data/accessor/click contract passed to Deck; the production build verifies its imports.
const picks = [];
const overlay = createSimulationOverlay({ PathLayer, ScatterplotLayer, TextLayer }, { onPick: (...p) => picks.push(p) });
overlay.update(finished); assert.deepEqual(overlay.bounds(), geometry.bounds);
const layers = overlay.layers(false);
assert.equal(layers.length, 6); assert.equal(overlay.layers(false), layers);
assert.equal(layers.find(l => l.id === 'sim-map-pipes').props.data.length, 117);
const sensors = layers.find(l => l.id === 'sim-map-sensors'); assert.equal(sensors.props.data.length, 12);
sensors.props.onClick({ object: sensors.props.data[0] });
const pipes = layers.find(l => l.id === 'sim-map-pipes'); pipes.props.onClick({ object: pipes.props.data[0] });
assert.deepEqual(picks, [['node', sensors.props.data[0].id], ['pipe', pipes.props.data[0].id]]);
assert.notEqual(overlay.layers(true), layers);
overlay.update({ ...finished, picked: { kind: 'pipe', id: '20' } });
assert.equal(overlay.layers(true).find(l => l.id === 'sim-map-pipes').props.data.find(p => p.id === '20').selected, true);
overlay.update(null); assert.deepEqual(overlay.layers(), []);
console.log('Simulation overlay: topology, projection, replay/provenance, coverage, Deck caching and inspector clicks pass.');
