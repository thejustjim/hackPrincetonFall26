import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ColumnLayer, ArcLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { TANK, tankSolid, tankGlass, metersPerPixel } from './tank.js';
import { PathLayer, PolygonLayer } from '@deck.gl/layers';
import { makePlacer } from './labels.js';
// Labels never overlap: each render places them in priority order (see labels.js).
// Real node > simulated node > base station > plants and towers > USGS > cities > buildings > roads.
import { treeTrunk, treeCanopy, towerMesh, hydrantMesh } from './meshes.js';
import { SYSTEM, PLANTS, RIDGE_TOWER, TRUNK, makePath, particles } from './water.js';
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, BarController, BarElement } from 'chart.js';
import { connect } from './api.js';
import { buildStyle, applyTheme, THEMES, LAYER_GROUPS, MODE, ARTIFACT } from './basemap.js';
import { Protocol } from 'pmtiles';
import { installFacades } from './facades.js';
import { renderOverview, ring, tdsBar } from './overview.js';
import { usLayers, loadUS, US_VIEW, usTooltip, refreshTileLabels, CITIES, us, TDS_BANDS, tdsColor } from './national.js';
import { runIntro } from './intro.js';

maplibregl.addProtocol('pmtiles', new Protocol().tile);
// Building fields differ between the bundled Princeton GeoJSON (h, n, c) and Overture tiles (height, @name, class).
const bHeight = p => +(p.h ?? p.height ?? (p.num_floors ? p.num_floors * 3.4 : 7));
const bName = p => p.n || p['@name'] || p.name || null;
const bClass = p => p.c || p.class || null;
const BSRC = MODE === 'local' ? { source: 'buildings' } : { source: 'ovBuildings', sourceLayer: 'building' };

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, BarController, BarElement);

// ---------- config ----------
const params = new URLSearchParams(location.search);
// LoRa base station location. Override with ?base=40.35,-74.65
const BASE = (params.get('base') || '40.3504,-74.652').split(',').map(Number); // [lat, lon]
// Optional: ?style=<MapLibre style URL> replaces the bundled Princeton basemap.
const BASE_STYLE = params.get('style');
// Palette: #5A9BBD steel, #F7F0F0 paper, #0B2027 ink, #717580 slate (+ warm warning tones that sit with it).
const VERDICT_RGB = { SAFE: [90, 155, 189], HIGH_TDS: [217, 102, 126], CLOUDY: [226, 190, 94], PH_WARN: [168, 146, 200] };   // the site's colours
// Labels on the map speak in three voices. Ours, a real reading: full white, a size up. Simulated: grey, and
// says so. Context (the water system and other people's published readings): the site's light blue, the colour
// of the route line and the stream rings. REF_ZOOM is where the stream readings start to show.
const CONTEXT = light => (light ? [44, 96, 126, 235] : [141, 189, 216, 225]);
const REF_ZOOM = 9.5;
const VERDICT_LABEL = { SAFE: 'In range', HIGH_TDS: 'High TDS', CLOUDY: 'Cloudy', PH_WARN: 'pH warning' };   // SAFE only means the three readings are in range
const FILTER_LABEL = { ZEROWATER: 'ZeroWater', BRITA: 'Brita Elite', NONE: 'No filter' };
const BRITA_RATED_L = 450;
const BRITA_SOON_L = 360;
const ZEROWATER_REPLACE_PPM = 6;

// ---------- state ----------
const state = {
  nodes: new Map(),      // node -> {node,name,lat,lon,sim,latest,lastBefore}
  byId: new Map(),       // reading id -> reading
  readings: new Map(),   // node -> readings sorted by id
  sources: new Map(),    // reading id -> 'gemini' | 'local_rule'
  reports: [],
  filters: [],
  reference: [],
  pulses: new Map(),     // node -> timestamp of last reading
  selected: null,
  api: null,
  mode: 'mock',
  asOf: null,           // replay time (ms) or null for live
  places: [],
  namedBuildings: [],
  searchIndex: [],
  trees: [],
  roadLabels: [],
  infra: [],
  cutaway: null,
};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// Who wrote a filter decision: the gateway sends source "gemini" (AI) or "local_rule" (no AI used).
const AI_NAME = 'Gemini';
const sourceLabel = src => (src === 'local_rule' ? 'Local rule' : src === 'claude' ? 'Claude' : src === 'gemma' ? 'Gemma' : AI_NAME);
const nodeName = id => state.nodes.get(id)?.name || id;

// ---------- data ingest ----------
function addReading(r) {
  if (!r || r.id == null) return;
  const prev = state.byId.get(r.id);
  const merged = prev ? Object.assign(prev, r) : { ...r };
  state.byId.set(r.id, merged);
  if (!prev) {
    const list = state.readings.get(r.node) || [];
    list.push(merged);
    list.sort((a, b) => a.id - b.id);
    state.readings.set(r.node, list);
  }
  let n = state.nodes.get(r.node);
  if (!n) {
    n = { node: r.node, name: r.node, lat: r.lat, lon: r.lon, sim: r.sim, latest: null, lastBefore: null };
    state.nodes.set(r.node, n);
  }
  if (!n.latest || merged.id >= n.latest.id) n.latest = merged;
  if (merged.phase === 'before' && (!n.lastBefore || merged.id >= n.lastBefore.id)) n.lastBefore = merged;
  return merged;
}

function applyDecision(d) {
  const r = state.byId.get(d.id);
  state.sources.set(d.id, d.source);
  if (r) { r.ai_filter = d.ai_filter; r.explanation = d.explanation; }
}

function testPair(node, test) {
  const list = state.readings.get(node) || [];
  return {
    before: list.find(r => r.test === test && r.phase === 'before') || null,
    after: list.find(r => r.test === test && r.phase === 'after') || null,
  };
}

// ---------- map ----------
const HOME = { center: [-74.66, 40.35], zoom: 11.75, pitch: 55, bearing: -20 };
const map = new maplibregl.Map({
  container: 'map',
  style: BASE_STYLE ? BASE_STYLE : buildStyle(THEMES.dark),
  ...HOME,
  maxPitch: 75,
  // Opens on Princeton; you can zoom out past the whole country.
  maxBounds: [[-180, 5], [-40, 75]],
  antialias: true,
  attributionControl: { compact: true },
});
// The start screen: a globe, one line about the country's water worked out from the public samples the map
// carries, and two ways in. The demo goes to Princeton, where the one real tank is; the other shows the country.
runIntro(map, HOME, import.meta.env.BASE_URL + 'data/', THEMES.dark, {
  line: () => {
    if (!us.sites.length) return 'Affordable water monitoring that leads to action.';
    const days = us.sites.map(d => (Date.now() - Date.parse(d.date)) / 864e5).sort((a, b) => a - b);
    return `Half of the ${us.sites.length.toLocaleString()} public sites sampled for dissolved solids since 2024 have gone ${Math.round(days[Math.floor(days.length / 2)] / 30.4)} months or more without a new sample.`;
  },
  choices: [
    { label: 'Start the Princeton demo', name: 'Princeton, New Jersey', view: HOME },
    { label: 'Look across the country', name: 'United States', view: US_VIEW, pin: false },
  ],
  chose: c => { const usa = c.view === US_VIEW; document.getElementById('btn-usa')?.classList.toggle('on', usa); document.getElementById('btn-reset')?.classList.toggle('on', !usa); },
});
const desktop = () => window.innerWidth > 1100;
// Start the before/after card folded on short screens and phones, so it doesn't cover the map.
if (innerWidth <= 760 || innerHeight < 700) document.body.classList.add('hero-collapsed');
map.setPadding(desktop() ? { left: 40, right: 40, top: 40, bottom: 120 } : { top: 0, bottom: 0, left: 0, right: 0 });
// Side panel arrow: hide/show the right column and let the map take the full width.
{
  const btn = document.getElementById('panel-toggle');
  const set = closed => {
    document.body.classList.toggle('panel-closed', closed);
    const t = closed ? 'Show the side panel' : 'Hide the side panel';
    btn.title = t; btn.setAttribute('aria-label', t);
    try { localStorage.setItem('clarity-panel', closed ? 'closed' : 'open'); } catch {}
  };
  let saved = null; try { saved = localStorage.getItem('clarity-panel'); } catch {}
  if (saved === 'closed') set(true);
  btn.addEventListener('click', () => set(!document.body.classList.contains('panel-closed')));
  new ResizeObserver(() => map.resize()).observe(document.querySelector('.mapwrap'));
}
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'bottom-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'bottom-right');
// Online-only sources (hillshade, satellite) fail quietly when offline; the bundled Princeton data still renders.
map.once('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
map.on('error', e => console.debug('[map]', String(e?.error?.message || e?.error || 'error').slice(0, 300)));

const overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip: tooltip });
map.addControl(overlay);

// Which deck.gl layers are on (toggled from the Layers menu).
const show = { ustds: true, columns: true, links: false, usgs: true, businesses: false, range: false, trees: true, labels: true, route: true, infra: true };
document.body.dataset.theme = 'dark';
installFacades(map);
map.on('style.load', () => map.setLight({ anchor: 'map', position: [1.4, 210, 35], color: '#fff6e8', intensity: 0.45 }));

// ---------- water route (illustrative) ----------
let trunkPath = makePath(TRUNK, { color: [90, 155, 189], gapScale: 1 });
const plantFeeds = [makePath([PLANTS[0].pos, TRUNK[1]], { color: [90, 155, 189] })];
const TRUNK_PATHS = [...plantFeeds, trunkPath];
let branchPaths = [];
function rebuildBranches() {
  branchPaths = [...state.nodes.values()].filter(n => n.lat != null && Math.abs(n.lat - RIDGE_TOWER[1]) < 0.3 && Math.abs(n.lon - RIDGE_TOWER[0]) < 0.3).map(n =>
    makePath([RIDGE_TOWER, [(RIDGE_TOWER[0] + n.lon) / 2, (RIDGE_TOWER[1] + n.lat) / 2 + 0.002], [n.lon, n.lat]], { color: [90, 155, 189], node: n.node, gapScale: 0.6 }));
}
let animOn = false;
function animate() {
  if (animOn) return;
  animOn = true;
  const tick = () => {
    if (!state.cutaway) { animOn = false; return; }
    renderMap(true);
    setTimeout(() => requestAnimationFrame(tick), 33);
  };
  requestAnimationFrame(tick);
}

function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestNode(pos) {
  let best = null;
  for (const n of state.nodes.values()) {
    if (n.lat == null) continue;
    const d = haversineKm(pos, [n.lon, n.lat]);
    if (!best || d < best.d) best = { n, d };
  }
  return best;
}

// Node readings as of the replay time (or latest when live).
function nodeView(n) {
  if (state.asOf == null) return { lb: n.lastBefore, lt: n.latest };
  let lb = null, lt = null;
  for (const r of state.readings.get(n.node) || []) {
    if (Date.parse(r.ts) > state.asOf) break;
    lt = r; if (r.phase === 'before') lb = r;
  }
  return { lb, lt };
}

function tooltip({ object, layer }) {
  if (!object) return null;
  if (layer.id === 'reference') {
    return { html: `<b>${esc(object.site)}</b> · USGS<br/>Est. TDS ${object.tds_est} ppm<br/><span style="opacity:.7">${esc(object.date)} · TDS ≈ 0.65 × conductance</span>` };
  }
  if (layer.id === 'us-tds') return usTooltip(object);
  if (layer.id === 'towers') return { html: `<b>${esc(object.n && object.n !== 'water_tower' ? object.n : 'Water tower')}</b><br/>Holds treated water up high. Gravity pushes it down<br/>into the mains, which keeps pressure steady and<br/>covers busy hours. Location from OpenStreetMap.` };
  if (layer.id === 'route-trunk') return { html: '<b>Main water route (illustrative)</b><br/>Treated water leaves the Raritan-Millstone and<br/>Canal Road plants and heads south to the<br/>Princeton Ridge tower. Real main locations<br/>are not public, so this path is approximate.' };
  if (layer.id === 'route-branches') { const n = state.nodes.get(object.node); return { html: `<b>To ${esc(n?.name || 'a test site')} (illustrative)</b><br/>From the ridge tower down to this test site.` }; }
  if (layer.id === 'links') { const r = nodeView(object).lt; return { html: `<b>Radio link: ${esc(object.name)}</b><br/>The node sends each reading to the base station<br/>by radio.${r ? ` Signal ${r.rssi} dBm (stronger is closer to 0).` : ''}` }; }
  if (layer.id === 'hydrants') return { html: '<b>Fire hydrant</b><br/>Connected to the water main under the street.' };
  if (layer.id === 'plants') return { html: `<b>${esc(object.name)}</b><br/>${esc(object.note)}<br/><span style="opacity:.75">Treatment plants settle, filter and disinfect river<br/>water before it goes into the mains.</span>` };
  if (layer.id === 'base') return { html: '<b>Base station</b><br/>LoRa receiver plus the gateway computer. It collects<br/>every reading, runs the checks and the AI, and<br/>feeds this dashboard.' };
  if (layer.id === 'businesses') {
    const near = nearestNode(object.pos);
    const v = near && nodeView(near.n).lb;
    return { html: `<b>${esc(object.n)}</b><br/><span style="opacity:.7">${esc((object.c || '').replace(/_/g, ' '))}</span>` +
      (near ? `<br/>Nearest Clarity node: ${esc(near.n.name)} (${(near.d * 0.621).toFixed(1)} mi)${v ? `<br/>Source water there: ${v.tds} ppm, ${VERDICT_LABEL[v.verdict] || v.verdict}` : ''}` : '') };
  }
  const n = object.node ? state.nodes.get(object.node) : null;
  if (!n) return null;
  const r = nodeView(n).lb || nodeView(n).lt;
  const what = n.sim ? 'Simulated test site: made up by the gateway to<br/>show how a bigger network would look. Not real hardware.'
    : 'Clarity test station: real hardware that tests tap water<br/>before and after a filter and radios the results here.';
  if (!r) return { html: `<b>${esc(n.name)}</b><br/>${what}` };
  return {
    html: `<b>${esc(n.name)}</b>${n.sim ? ' <span style="opacity:.7">· simulated</span>' : ''}<br/>` +
      `TDS ${r.tds} ppm · pH ${r.ph} · clarity ${r.clarity}<br/>` +
      `${VERDICT_LABEL[r.verdict] || r.verdict} · RSSI ${r.rssi} dBm<br/>` +
      `<span style="opacity:.75">${what}<br/>Water height inside the tank = TDS (full at 1,000 ppm).<br/>Water color = verdict.</span><br/><span style="opacity:.7">Click for history</span>`,
  };
}

function rssiColor(rssi, alpha) {
  // -115 dBm weak (slate #717580) .. -55 dBm strong (steel #5A9BBD)
  const t = Math.max(0, Math.min(1, (rssi + 115) / 60));
  return [Math.round(113 + t * (90 - 113)), Math.round(117 + t * (155 - 117)), Math.round(128 + t * (189 - 128)), alpha];
}

const PLACE_RGB = c => (/restaurant|cafe|coffee|bakery|bar|brew|food|grocer|supermarket/.test(c) ? [224, 164, 88]
  : /hospital|clinic|dentist|health/.test(c) ? [209, 73, 91]
  : /school|university|college|library|museum|child|daycare/.test(c) ? [90, 155, 189] : [247, 240, 240]);

let rafPending = false;
function scheduleRender() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderMap(); }); } }
map.on('zoom', scheduleRender);
map.on('moveend', scheduleRender);

function renderMap(fromAnim = false) {
  const nodes = [...state.nodes.values()].filter(n => n.lat != null && n.lon != null);
  const now = performance.now();
  const views = new Map(nodes.map(n => [n.node, nodeView(n)]));
  const shown = n => views.get(n.node).lb || views.get(n.node).lt;
  const colRGB = n => VERDICT_RGB[shown(n)?.verdict] || [113, 117, 128];
  // Each node is drawn as a real-scale water tank (6 m radius, 10 m wall). When zoomed out it is scaled up
  // just enough to stay visible; from street level it is true size next to the buildings.
  const zoom = map.getZoom();
  const ts = Math.max(1, (metersPerPixel(zoom, 40.35) * 12) / TANK.r);
  const R = TANK.r * ts;
  const wallBase = (TANK.plinth + 0.5) * ts;
  const wallH = (TANK.body - 0.95) * ts;
  const fill = n => Math.min(1, Math.max(0.05, (shown(n)?.tds ?? 0) / 1000)); // water level = TDS on a 0-1000 ppm scale
  const elev = () => (TANK.plinth + TANK.body + TANK.roof + 0.8) * ts;
  const radius = R;
  const theme = document.body.dataset.theme;
  const light = theme === 'light' || theme === 'game';
  const key = `${now}|${state.asOf}|${radius}|${light}`;
  // Label placement, highest priority first, so nothing overlaps.
  const place = makePlacer(map);
  const pitchK = Math.sin((map.getPitch() * Math.PI) / 180);
  const tankTopPx = (elev() / metersPerPixel(zoom, 40.35)) * pitchK;
  const nodeText = n => `${n.name}\n${shown(n)?.tds ?? '–'} ppm${n.sim ? ', simulated' : ''}`;
  const nodeLabels = show.columns ? place(nodes, { pos: n => [n.lon, n.lat], text: nodeText, size: n => (n.sim ? 11 : 13),
    priority: n => (n.sim ? 90 : 100), anchor: 'bottom', dy: -tankTopPx }) : [];
  const miscLabels = [
    ...place(show.links ? [{ pos: [BASE[1], BASE[0]], text: 'BASE STATION' }] : [], { pos: d => d.pos, text: d => d.text, size: 11, anchor: 'top', dy: 16 }),
    ...(show.infra ? place(PLANT_LABELS, { pos: d => d.pos, text: d => d.text, size: 13, anchor: 'center', dy: -22 }).map(d => ({ ...d, plant: true })) : []),
    ...place(show.usgs && zoom >= REF_ZOOM ? state.reference.map(r => ({ pos: [r.lon, r.lat], text: `${r.site}, USGS ${r.tds_est} ppm`, ref: true })) : [],
      { pos: d => d.pos, text: d => d.text, size: 11, anchor: 'top', dy: 16 }),
  ];
  const layers = [
    show.range && new ScatterplotLayer({
      id: 'range', data: [3, 6, 9].map(km => ({ km })),
      getPosition: [BASE[1], BASE[0]], getRadius: d => d.km * 1000,
      filled: false, stroked: true, getLineColor: [90, 155, 189, 80], lineWidthMinPixels: 1.5,
    }),
    show.links && new ArcLayer({
      id: 'links',
      // Off unless switched on in Layers. Only nodes near the base station link to it; other cities would have their own.
      data: nodes.filter(n => Math.abs(n.lat - BASE[0]) < 0.5 && Math.abs(n.lon - BASE[1]) < 0.5),
      getSourcePosition: n => [n.lon, n.lat],
      getTargetPosition: [BASE[1], BASE[0]],
      getSourceColor: n => rssiColor(views.get(n.node).lt?.rssi ?? -90, n.sim ? 90 : 220),
      getTargetColor: n => rssiColor(views.get(n.node).lt?.rssi ?? -90, n.sim ? 60 : 200),
      getWidth: n => (n.sim ? 1.5 : 3),
      getHeight: 0.6,
      greatCircle: false,
      pickable: true,
      updateTriggers: { getSourceColor: key, getTargetColor: key },
    }),
    show.businesses && new ScatterplotLayer({
      id: 'businesses', data: state.places,
      getPosition: d => d.pos, getRadius: 18, radiusMinPixels: 2.5, radiusMaxPixels: 7,
      getFillColor: d => [...PLACE_RGB(d.c || ''), 220], getLineColor: [11, 32, 39, 255],
      stroked: true, lineWidthMinPixels: 1, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 200],
      onClick: ({ object }) => object && flyTo(object.pos, 17),
    }),
    show.usgs && new ScatterplotLayer({
      id: 'reference',
      data: state.reference,
      getPosition: d => [d.lon, d.lat],
      // Invisible hover target only: no ring is drawn, the label carries the site.
      getRadius: Math.max(40, R * 1.4),
      stroked: false,
      filled: true,
      getFillColor: [0, 0, 0, 1],
      pickable: true,
      updateTriggers: { getRadius: key },
    }),
    // A stream reading is a small open ring, in the colour of everything on the map that is context and not ours.
    show.usgs && zoom >= REF_ZOOM && new ScatterplotLayer({
      id: 'reference-ring', data: state.reference, getPosition: d => [d.lon, d.lat],
      radiusUnits: 'pixels', getRadius: 4.5, lineWidthUnits: 'pixels', getLineWidth: 1.5, stroked: true, filled: true,
      getFillColor: light ? [247, 240, 240, 200] : [9, 22, 34, 200], getLineColor: CONTEXT(light),
      parameters: { depthTest: false }, updateTriggers: { getFillColor: light, getLineColor: light },
    }),
    // Water inside the tank: height = TDS (0-1000 ppm), color = verdict.
    show.columns && new ColumnLayer({
      id: 'tds',
      data: nodes,
      diskResolution: 40,
      radius: R * 0.96,
      extruded: true,
      pickable: true,
      getPosition: n => [n.lon, n.lat, wallBase],
      getElevation: n => fill(n) * wallH,
      getFillColor: n => [...colRGB(n), n.sim ? 150 : 255],
      material: { ambient: 0.55, diffuse: 0.55, shininess: 60 },
      updateTriggers: { getElevation: key, getFillColor: key, getPosition: key },
      onClick: ({ object }) => object && openDrawer(object.node),
    }),
    show.columns && new SimpleMeshLayer({
      id: 'tank-solid',
      data: nodes,
      mesh: tankSolid,
      getPosition: n => [n.lon, n.lat, 0],
      getScale: [ts, ts, ts],
      getColor: n => (n.sim ? [113, 117, 128, 255] : light ? [90, 96, 108, 255] : [222, 216, 216, 255]),
      material: { ambient: 0.45, diffuse: 0.65, shininess: 24, specularColor: [40, 40, 40] },
      pickable: true,
      autoHighlight: true,
      highlightColor: [90, 155, 189, 120],
      updateTriggers: { getScale: key, getColor: key },
      onClick: ({ object }) => object && openDrawer(object.node),
    }),
    show.columns && new SimpleMeshLayer({
      id: 'tank-glass',
      data: nodes,
      mesh: tankGlass,
      getPosition: n => [n.lon, n.lat, 0],
      getScale: [ts, ts, ts],
      getColor: n => (light ? [11, 32, 39, 60] : [247, 240, 240, n.sim ? 40 : 70]),
      material: { ambient: 0.8, diffuse: 0.3, shininess: 80 },
      parameters: { depthMask: false, depthWriteEnabled: false },
      updateTriggers: { getScale: key, getColor: key },
    }),
    show.links && new ScatterplotLayer({
      id: 'base',
      data: [{ pos: [BASE[1], BASE[0]] }],
      getPosition: d => d.pos,
      getRadius: Math.max(4, R * 0.6),
      getFillColor: [247, 240, 240, 255],
      getLineColor: [90, 155, 189, 255],
      stroked: true, lineWidthMinPixels: 3, pickable: true,
      updateTriggers: { getRadius: key },
    }),
    show.columns && new TextLayer({
      id: 'labels',
      data: nodeLabels,
      getPosition: n => [n.lon, n.lat, elev(n)],
      getText: nodeText,
      getSize: n => (n.sim ? 11 : 13),
      getColor: n => (light ? (n.sim ? [113, 117, 128, 240] : [11, 32, 39, 255]) : (n.sim ? [150, 154, 163, 230] : [247, 240, 240, 255])),
      fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: 600,
      outlineWidth: 3, outlineColor: light ? [255, 255, 255, 235] : [9, 22, 34, 230],
      fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false },
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'bottom',
      billboard: true,
      updateTriggers: { getText: key, getPosition: key },
    }),
    new TextLayer({
      id: 'misc-labels',
      data: miscLabels.filter(d => !d.plant),
      getPosition: d => d.pos,
      getText: d => d.text,
      getSize: 11,
      getColor: d => (d.ref ? CONTEXT(light) : (light ? [11, 32, 39, 255] : [247, 240, 240, 255])),
      getPixelOffset: [0, 16],
      fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600,
      outlineWidth: 3, outlineColor: light ? [255, 255, 255, 235] : [9, 22, 34, 230], fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false },
      getAlignmentBaseline: 'top',
      updateTriggers: { getText: key, getColor: light },
    }),
    ...extraLayers({ zoom, light, now, place, plantLabels: miscLabels.filter(d => d.plant) }),
    ...usLayers({ zoom, place, light, on: show.ustds, onClick: ({ object }) => object && flyTo(object.pos, 12.5, { pitch: 50 }) }),
  ].filter(Boolean);
  // Text goes last so labels sit on top of tanks and route lines.
  layers.sort((a, b) => (a instanceof TextLayer) - (b instanceof TextLayer));
  overlay.setProps({ layers });
  if (state.cutaway && !animOn) animate();
}

// ---------- game-map details, water network, cutaway ----------
// Memoize filtered arrays so deck.gl doesn't rebuild attributes every animation frame.
const memo = new Map();
function cached(key, deps, fn) {
  const m = memo.get(key);
  if (m && m.deps.length === deps.length && m.deps.every((d, i) => d === deps[i])) return m.v;
  const v = fn(); memo.set(key, { deps, v }); return v;
}
const PLANT_LABELS = [...PLANTS.map(p => ({ pos: p.pos, text: p.short })), { pos: RIDGE_TOWER, text: 'Water tower (Princeton Ridge)' }];
const onRoute = pos => Math.abs(pos[0] - RIDGE_TOWER[0]) < 0.004 && Math.abs(pos[1] - RIDGE_TOWER[1]) < 0.004;
const TREE_GREENS = [[86, 140, 64], [104, 156, 70], [73, 122, 58], [122, 168, 82], [95, 133, 60]];
function extraLayers({ zoom, light, now, place, plantLabels }) {
  const t = performance.now() / 1000;
  const mpp = metersPerPixel(zoom, 40.36);
  const towerScale = Math.max(1, (mpp * 7) / 8);
  const textBase = {
    fontFamily: 'Inter, Helvetica, Arial, sans-serif', fontWeight: 600, fontSettings: { sdf: true }, characterSet: 'auto',
    outlineWidth: 3, outlineColor: light ? [255, 252, 245, 240] : [9, 22, 34, 235], parameters: { depthTest: false },
  };
  const ink = light ? [11, 32, 39, 255] : [247, 240, 240, 255];
  const cut = state.cutaway;
    const cutFlow = cut ? particles(cut.paths, t, { gap: 4, speed: 3 }) : [];
  return [
    show.trees && zoom >= 13 && new SimpleMeshLayer({
      id: 'tree-trunks', data: state.trees, mesh: treeTrunk,
      getPosition: d => [d[0], d[1], 0], getScale: d => [d[2], d[2], d[2]], getColor: [110, 82, 60],
      material: { ambient: 0.6, diffuse: 0.5 },
    }),
    show.trees && zoom >= 13 && new SimpleMeshLayer({
      id: 'tree-canopy', data: state.trees, mesh: treeCanopy,
      getPosition: d => [d[0], d[1], 0], getScale: d => [d[2], d[2], d[2] * 1.05],
      getColor: (d, { index }) => TREE_GREENS[index % TREE_GREENS.length],
      material: { ambient: 0.55, diffuse: 0.6, shininess: 8 },
    }),
    // The water route (illustrative): one quiet line in the site's blue from the plants to the tower, and a
    // hairline on to each site. Only the site that is open is picked out, so the map is not a web of spokes.
    show.route && new PathLayer({
      id: 'route-trunk', data: TRUNK_PATHS, getPath: d => d.points, getColor: [90, 155, 189, 190],
      getWidth: 6, widthMinPixels: 2, widthMaxPixels: 8, capRounded: true, jointRounded: true, pickable: true,
    }),
    show.route && new PathLayer({
      id: 'route-branches', data: branchPaths, getPath: d => d.points,
      getColor: d => (d.node === state.selected ? [141, 189, 216, 255] : [90, 155, 189, 105]),
      getWidth: d => (d.node === state.selected ? 3 : 1.2), widthUnits: 'pixels', capRounded: true, jointRounded: true, pickable: true,
      updateTriggers: { getPath: branchPaths.length, getColor: state.selected, getWidth: state.selected },
    }),
    cut && new ScatterplotLayer({
      id: 'flow', data: cutFlow, getPosition: d => d.pos, getRadius: 0.35,
      radiusMinPixels: 2.5, radiusMaxPixels: 7, getFillColor: [222, 244, 255, 255], getLineColor: [90, 155, 189, 255],
      stroked: true, lineWidthMinPixels: 1, parameters: { depthTest: !cut },
      updateTriggers: { getRadius: !!cut },
    }),
    show.infra && new SimpleMeshLayer({
      // The tower on the route is always there. The other mapped towers are scenery, so they wait until the map is close in.
      id: 'towers', data: cached('tw', [state.infra, zoom >= 13], () => state.infra.filter(d => d.k === 'water_tower' && (zoom >= 13 || onRoute(d.pos)))), mesh: towerMesh,
      getPosition: d => [...d.pos, 0], getScale: [towerScale, towerScale, towerScale],
      getColor: light ? [214, 222, 228] : [180, 196, 204], material: { ambient: 0.5, diffuse: 0.65, shininess: 30 },
      pickable: true, updateTriggers: { getScale: towerScale },
    }),
    show.infra && zoom >= 16 && new SimpleMeshLayer({
      id: 'hydrants', data: cached('hy', [state.infra], () => state.infra.filter(d => d.k === 'fire_hydrant')), mesh: hydrantMesh,
      getPosition: d => [...d.pos, 0], getScale: [1.6, 1.6, 1.6], getColor: [200, 58, 50], pickable: true,
    }),
    show.infra && new ScatterplotLayer({
      id: 'plants', data: PLANTS, getPosition: d => d.pos, getRadius: Math.max(120, mpp * 14),
      getFillColor: [90, 155, 189, 70], getLineColor: [90, 155, 189, 255], stroked: true, lineWidthMinPixels: 2,
      pickable: true, onClick: ({ object }) => object && flyTo(object.pos, 15),
      updateTriggers: { getRadius: Math.round(mpp) },
    }),
    show.infra && new TextLayer({
      id: 'plant-labels',
      data: plantLabels,
      getPosition: d => d.pos, getText: d => d.text, getSize: 12, getColor: CONTEXT(light), getPixelOffset: [0, -22],
      ...textBase, updateTriggers: { getColor: light },
    }),
    show.labels && zoom >= 15.8 && new TextLayer({
      id: 'road-labels', data: place(zoom >= 17 ? state.roadLabels : cached('rl', [state.roadLabels], () => state.roadLabels.filter(d => d[4])), { pos: d => [d[0], d[1]], text: d => d[3], size: d => (d[4] ? 12.5 : 11), priority: d => (d[4] ? 1 : 0) }),
      getPosition: d => [d[0], d[1]], getText: d => d[3], getAngle: d => d[2], getSize: d => (d[4] ? 12.5 : 11),
      getColor: light ? [70, 62, 52, 255] : [190, 196, 204, 255], billboard: false, sizeUnits: 'pixels',
      ...textBase, outlineWidth: 2,
      updateTriggers: { getColor: light },
    }),
    show.labels && zoom >= 15.3 && new TextLayer({
      id: 'building-labels', data: place(zoom >= 17.2 ? state.namedBuildings : cached('bl', [state.namedBuildings], () => state.namedBuildings.filter(d => d.h >= 16)), { pos: d => d.pos, text: d => d.label, size: 12, priority: d => d.h,
        // the label floats at roof height, so shift its box up by the building's height on screen
        dy: d => -((d.h + 4) / mpp) * Math.sin((map.getPitch() * Math.PI) / 180) }),
      getPosition: d => [d.pos[0], d.pos[1], d.h + 4], getText: d => d.label, getSize: 12, getColor: ink,
      ...textBase,
      updateTriggers: { getColor: light },
    }),
  ];
}

function exitCutaway() {
  if (!state.cutaway) return;
  state.cutaway = null;
  for (const l of ['buildings-3d', 'facades', 'roofs', 'building-parts']) if (map.getLayer(l)) map.setFilter(l, null);
  $('#cutaway').classList.add('hidden');
  renderMap();
}

// Camera tour along the water's path: river intake -> plants -> ridge tower -> Clarity tank.
async function followTheWater() {
  stopMotion();
  exitCutaway();
  const tank = [...state.nodes.values()].find(n => !n.sim) || [...state.nodes.values()][0];
  const stops = [
    { center: [-74.5700, 40.5480], zoom: 13.2, pitch: 55, bearing: -30, say: 'The Millstone River meets the Raritan here. Both rivers, plus the D&R Canal and 98 wells, supply the system.' },
    { center: PLANTS[0].pos, zoom: 14.6, pitch: 60, bearing: 10, say: `${PLANTS[0].name}: river water is filtered and treated with chloramines.` },
    { center: PLANTS[1].pos, zoom: 14.4, pitch: 60, bearing: 40, say: `${PLANTS[1].name}: a second plant on the canal.` },
    { center: [-74.6145, 40.3830], zoom: 13, pitch: 55, bearing: 70, say: 'Treated water travels south toward Princeton through large transmission mains (route shown is illustrative).' },
    { center: RIDGE_TOWER, zoom: 16, pitch: 62, bearing: 120, say: 'Storage tanks on the Princeton Ridge hold water high up, so gravity keeps the pressure steady in town.' },
    ...(tank ? [{ center: [tank.lon, tank.lat], zoom: 17.3, pitch: 64, bearing: 160, say: `${tank.name}: Clarity tests the water at the tap, before and after the filter.` }] : []),
  ];
  const card = $('#cutaway');
  card.classList.remove('hidden');
  let stopped = false;
  motion = { type: 'follow', stop: () => { stopped = true; } };
  for (const st of stops) {
    if (stopped) return;
    card.innerHTML = `<div class="cut-head"><b>Follow the water</b><button id="cut-exit" class="tool">Stop</button></div><p>${esc(st.say)}</p>`;
    $('#cut-exit').addEventListener('click', () => { stopped = true; card.classList.add('hidden'); stopMotion(); });
    map.flyTo({ ...st, duration: 4200, essential: true });
    await new Promise(r => map.once('moveend', r));
    await new Promise(r => setTimeout(r, 2600));
  }
  if (!stopped) setTimeout(() => card.classList.add('hidden'), 4000);
  motion = null;
}

/* What EPA's public records say about the system that serves Princeton: collected ahead of time by
   scripts/public_record.py and stored, so nothing is looked up while the page is being shown. */
let publicRecord = null;
fetch(import.meta.env.BASE_URL + 'data/public_record.json').then(r => (r.ok ? r.json() : null)).then(j => { publicRecord = j; renderSourcePanel(); }).catch(() => {});
function recordHTML() {
  const r = publicRecord;
  if (!r) return '';
  const day = new Date(r.fetched + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `<h3>On the public record <span class="h3note">EPA, fetched ${day}</span></h3>
    <table class="facts record">
      <tr><td>Who it serves</td><td>${Number(r.system.population).toLocaleString()} people through ${Number(r.system.connections).toLocaleString()} connections, Princeton among many towns.
        <a href="${esc(r.system.url)}" target="_blank" rel="noopener">${esc(r.system.source)}</a></td></tr>
      ${r.facts.map(f => `<tr><td>${esc(f.label)}</td><td>${esc(f.text)} <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.source)}</a></td></tr>`).join('')}
    </table>
    <p class="muted small">${esc(r.caveat)}</p>`;
}
function renderSourcePanel() {
  const wells = publicRecord ? `wells: ${SYSTEM.wells} by the utility's report, ${publicRecord.wells_active} active on EPA's record` : `${SYSTEM.wells} wells`;
  const ref = state.reference.map(r => `<tr><td>${esc(r.site)}</td><td>${r.tds_est} ppm</td><td class="muted">${esc(String(r.date).slice(0, 4))}</td></tr>`).join('');
  $('#tab-src').innerHTML = `
    <p class="lede">Princeton's tap water comes from <b>${SYSTEM.utility}</b>, ${SYSTEM.system}. About ${SYSTEM.surfacePct}% is river and canal water and ${SYSTEM.groundPct}% comes from wells.</p>
    <button id="btn-follow" class="btn">Follow the water</button>
    <ol class="journey">
      <li data-fly="-74.5700,40.5480,13.2"><b>Sources</b><span>${SYSTEM.sources.join(', ')}, plus ${wells}</span></li>
      <li data-fly="${PLANTS[0].pos.join(',')},14.6"><b>${PLANTS[0].short}</b><span>${esc(PLANTS[0].note)}</span></li>
      <li data-fly="${PLANTS[1].pos.join(',')},14.4"><b>${PLANTS[1].short}</b><span>${esc(PLANTS[1].note)}</span></li>
      <li data-fly="${RIDGE_TOWER.join(',')},16"><b>Storage towers</b><span>${state.infra.filter(d => d.k === 'water_tower').length} mapped water towers in the area keep pressure up by gravity.</span></li>
      <li data-fly="-74.6555,40.347,17"><b>Your tap</b><span>Clarity tests it before and after the filter.</span></li>
    </ol>
    ${recordHTML()}
    <h3>From the utility's ${SYSTEM.report}</h3>
    <table class="facts">${SYSTEM.results.map(r => `<tr><td>${r.k}</td><td>${r.v}</td><td class="muted">${r.note}</td></tr>`).join('')}</table>
    <p class="muted small">Average supply ${SYSTEM.supplyMgd} million gallons a day (2023 report). ${SYSTEM.treatment} The report does not list TDS. PWSID ${SYSTEM.pwsid}. <a href="${SYSTEM.reportUrl}" target="_blank" rel="noopener">Read the report</a></p>
    <h3>Nearby streams (USGS Water Quality Portal)</h3>
    <table class="facts">${ref || '<tr><td class="muted">No reference data from the gateway yet.</td></tr>'}</table>
    <p class="muted small">Estimated as 0.65 × specific conductance. The real ratio for natural water runs about 0.55 to 0.75, so treat these as ±15%.</p>
    <p class="muted small">The route on the map is illustrative: water main locations aren't published.</p>`;
  $('#btn-follow').addEventListener('click', followTheWater);
  document.querySelectorAll('.journey li').forEach(li => li.addEventListener('click', () => {
    const [x, y, z] = li.dataset.fly.split(',').map(Number);
    flyTo([x, y], z);
  }));
}

// ---------- map interactions: buildings hover, camera, tour, layers, search, replay ----------
const tip = document.createElement('div');
tip.className = 'map-tip hidden';
document.body.appendChild(tip);
let hoverId = null;
map.on('mousemove', 'buildings-3d', e => {
  const f = e.features?.[0];
  // A deck.gl object (node, business, USGS site) under the cursor has its own tooltip.
  if (!f || overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 2 })) { tip.classList.add('hidden'); return; }
  if (hoverId != null) map.setFeatureState({ ...BSRC, id: hoverId }, { hover: false });
  hoverId = f.id;
  if (hoverId != null) map.setFeatureState({ ...BSRC, id: hoverId }, { hover: true });
  const p = f.properties;
  const ft = Math.round(bHeight(p) * 3.281), nm = bName(p), cl = bClass(p);
  tip.innerHTML = `<b>${esc(nm || (cl ? cl.replace(/_/g, ' ') : 'Building'))}</b><br/><span>${ft} ft tall${nm && cl ? ` · ${esc(cl.replace(/_/g, ' '))}` : ''}${p.num_floors ? ` · ${p.num_floors} floors` : ''}</span>`;
  tip.style.left = `${e.originalEvent.clientX + 14}px`;
  tip.style.top = `${e.originalEvent.clientY + 14}px`;
  tip.classList.remove('hidden');
  map.getCanvas().style.cursor = 'default';
});
map.on('mouseleave', 'buildings-3d', () => {
  if (hoverId != null) map.setFeatureState({ ...BSRC, id: hoverId }, { hover: false });
  hoverId = null;
  tip.classList.add('hidden');
});

function flyTo(pos, zoom = 15.5, extra = {}) {
  stopMotion();
  map.flyTo({ center: pos, zoom, pitch: 62, bearing: map.getBearing() + 25, duration: 2200, essential: true, ...extra });
}

let motion = null; // { type: 'rotate' | 'tour', stop() }
function stopMotion() {
  if (!motion) return;
  motion.stop();
  motion = null;
  $('#btn-rotate')?.classList.remove('on');
  $('#btn-tour')?.classList.remove('on');
}
['mousedown', 'wheel', 'touchstart', 'dragstart'].forEach(ev => map.on(ev, e => e.originalEvent && stopMotion()));

function startRotate() {
  stopMotion();
  let on = true, last = performance.now();
  const step = t => {
    if (!on) return;
    map.setBearing(map.getBearing() + (t - last) * 0.006);
    last = t;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  motion = { type: 'rotate', stop: () => { on = false; } };
  $('#btn-rotate').classList.add('on');
}

function startTour() {
  stopMotion();
  const stops = [...state.nodes.values()].filter(n => n.lat != null).sort((a, b) => a.sim - b.sim);
  let i = 0, on = true, timer = null;
  const next = () => {
    if (!on) return;
    const n = stops[i % stops.length];
    i += 1;
    map.flyTo({ center: [n.lon, n.lat], zoom: n.sim ? 14.6 : 15.6, pitch: 64, bearing: (i * 47) % 360 - 180, duration: 3500, essential: true });
    map.once('moveend', () => { if (on) timer = setTimeout(next, 2200); });
  };
  next();
  motion = { type: 'tour', stop: () => { on = false; clearTimeout(timer); } };
  $('#btn-tour').classList.add('on');
}

function initMapControls() {
  const themeBtns = document.querySelectorAll('#theme button');
  themeBtns.forEach(b => b.addEventListener('click', () => {
    themeBtns.forEach(x => x.classList.toggle('on', x === b));
    applyTheme(map, b.dataset.theme);
    document.body.dataset.theme = b.dataset.theme;
    renderMap();
  }));
  $('#btn-3d').addEventListener('click', () => {
    const flat = map.getPitch() < 10;
    map.easeTo({ pitch: flat ? 60 : 0, bearing: flat ? -20 : 0, duration: 900 });
  });
  map.on('pitchend', () => { $('#btn-3d').textContent = map.getPitch() < 10 ? '3D' : '2D'; });
  $('#btn-rotate').addEventListener('click', () => (motion?.type === 'rotate' ? stopMotion() : startRotate()));
  $('#btn-tour').addEventListener('click', () => (motion?.type === 'tour' ? stopMotion() : startTour()));
  // Princeton / USA work as one toggle: the highlighted one is where you last jumped.
  const jump = id => { $('#btn-reset').classList.toggle('on', id === 'btn-reset'); $('#btn-usa').classList.toggle('on', id === 'btn-usa'); };
  $('#btn-reset').addEventListener('click', () => { jump('btn-reset'); stopMotion(); exitCutaway(); map.flyTo({ ...HOME, duration: 1800 }); });
  $('#btn-usa')?.addEventListener('click', () => { jump('btn-usa'); stopMotion(); exitCutaway(); map.flyTo({ ...US_VIEW, duration: 2600, essential: true }); });
  // Street and building names anywhere in the US, from the tiles on screen (bundled labels cover Princeton).
  const inPrinceton = c => c.lng > -74.95 && c.lng < -74.35 && c.lat > 40.2 && c.lat < 40.65;
  if (MODE !== 'local') map.on('moveend', () => {
    if (inPrinceton(map.getCenter())) { if (us.tileLabels.length) { us.tileLabels = []; renderMap(); } return; }
    refreshTileLabels(map); renderMap();
    // Tiles for the new view may still be loading: read names again once the map settles.
    map.once('idle', () => { refreshTileLabels(map); renderMap(); });
  });

  document.querySelectorAll('#layers input').forEach(cb => cb.addEventListener('change', () => {
    const k = cb.dataset.layer;
    if (k in show) { show[k] = cb.checked; renderMap(); return; }
    for (const id of LAYER_GROUPS[k] || []) map.setLayoutProperty(id, 'visibility', cb.checked ? 'visible' : 'none');
  }));

  // Search across Clarity sites, USGS sites, businesses and named buildings.
  const input = $('#search');
  const go = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const hit = state.searchIndex.find(x => x.label.toLowerCase() === q) || state.searchIndex.find(x => x.label.toLowerCase().includes(q));
    if (!hit) {
      // Anywhere in the US: ask OpenStreetMap's geocoder (online only).
      fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&limit=1&q=${encodeURIComponent(input.value.trim())}`)
        .then(r => r.json()).then(([g]) => {
          if (!g) throw new Error('none');
          flyTo([+g.lon, +g.lat], g.class === 'building' || g.class === 'amenity' ? 17.5 : g.type === 'city' ? 13.5 : 16);
          input.blur();
        }).catch(() => { input.classList.add('miss'); setTimeout(() => input.classList.remove('miss'), 600); });
      return;
    }
    flyTo(hit.pos, hit.zoom);
    if (hit.node) openDrawer(hit.node);
    input.blur();
  };
  input.addEventListener('change', go);
  input.addEventListener('keydown', e => e.key === 'Enter' && go());

  // Hero card can be minimized to see more map.
  $('#hero').addEventListener('click', e => {
    if (e.target.closest('.hero-min')) document.body.classList.toggle('hero-collapsed');
  });

  // Time replay
  const slider = $('#time'), label = $('#time-label'), play = $('#btn-play'), live = $('#btn-live');
  let playTimer = null;
  const setAsOf = v => {
    const max = Number(slider.max);
    state.asOf = v >= max ? null : v;
    slider.value = v;
    label.textContent = state.asOf == null ? 'Live' : new Date(v).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    live.classList.toggle('on', state.asOf == null);
    renderMap(); scheduleOverview();
  };
  slider.addEventListener('input', () => { stopPlay(); setAsOf(Number(slider.value)); });
  const stopPlay = () => { clearInterval(playTimer); playTimer = null; play.textContent = 'Play'; };
  play.addEventListener('click', () => {
    if (playTimer) return stopPlay();
    refreshTimeRange();
    if (state.asOf == null) setAsOf(Number(slider.min));
    play.textContent = 'Pause';
    const stepMs = (Number(slider.max) - Number(slider.min)) / 120;
    playTimer = setInterval(() => {
      const v = Number(slider.value) + stepMs;
      if (v >= Number(slider.max)) { stopPlay(); setAsOf(Number(slider.max)); } else setAsOf(v);
    }, 80);
  });
  live.addEventListener('click', () => { stopPlay(); refreshTimeRange(); setAsOf(Number(slider.max)); });
}

function refreshTimeRange() {
  const ts = [...state.byId.values()].map(r => Date.parse(r.ts)).filter(Number.isFinite);
  if (!ts.length) return;
  const slider = $('#time');
  slider.min = Math.min(...ts);
  slider.max = Math.max(...ts, Date.now());
  slider.step = 60000;
  if (state.asOf == null) slider.value = slider.max;
}

async function loadExtras() {
  const get = async (f, dflt) => { try { return await (await fetch(`./data/${f}`)).json(); } catch { return dflt; } };
  const [trees, roadLabels, infra] = await Promise.all([get('trees.json', []), get('road_labels.json', []), get('water_infra.json', [])]);
  state.trees = trees; state.roadLabels = roadLabels; state.infra = infra;
  renderSourcePanel();
  renderMap();
}

async function loadPlaces() {
  try {
    const fc = await (await fetch('./data/places.json')).json();
    state.places = fc.features.map(f => ({ pos: f.geometry.coordinates, n: f.properties.n, c: f.properties.c }));
  } catch { state.places = []; }
  try {
    const b = await (await fetch('./data/buildings.json')).json();
    state.namedBuildings = b.features.filter(f => f.properties.n).map(f => {
      const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
      return { label: f.properties.n, pos: c, zoom: 17, h: (f.properties.h || 8) + (f.properties.b ? 0 : 0) };
    });
  } catch { state.namedBuildings = []; }
  buildSearchIndex();
  renderMap();
}

function buildSearchIndex() {
  const idx = [
    ...[...state.nodes.values()].filter(n => n.lat != null).map(n => ({ label: `${n.name}${n.sim ? ' (simulated node)' : ' (Clarity node)'}`, pos: [n.lon, n.lat], zoom: 15.5, node: n.node })),
    ...state.reference.map(r => ({ label: `${r.site} (USGS)`, pos: [r.lon, r.lat], zoom: 15 })),
    ...(state.namedBuildings || []),
    ...(state.places || []).map(p => ({ label: p.n, pos: p.pos, zoom: 17.5 })),
    ...CITIES.map(c => ({ label: `${c.name} (city)`, pos: c.pos, zoom: 15.2 })),
  ];
  const seen = new Set();
  state.searchIndex = idx.filter(x => x.label && !seen.has(x.label) && seen.add(x.label));
  $('#search-list').innerHTML = state.searchIndex.map(x => `<option value="${esc(x.label)}"></option>`).join('');
}

// ---------- hero before/after card ----------
function heroTest() {
  // Prefer the latest test from a real (non-simulated) node: that's the tank on the demo table.
  const all = [...state.byId.values()].sort((a, b) => b.id - a.id);
  const real = all.find(r => !r.sim);
  const r = real || all[0];
  return r ? { node: r.node, test: r.test } : null;
}

/* Away from Princeton there is no Clarity site, so the card says what is publicly known about the water in
   view instead: the Water Quality Portal samples the map already carries. It is worked out here from that
   data, with no model and nothing fetched. These are rivers, lakes and wells, not tap water, and it says so. */
const atHome = c => c.lng > -74.95 && c.lng < -74.35 && c.lat > 40.2 && c.lat < 40.65;
let areaShown = false;
function renderArea(el) {
  const b = map.getBounds(), c = map.getCenter();
  const km = (lon, lat) => { const R = 6371, r = Math.PI / 180, dy = (lat - c.lat) * r, dx = (lon - c.lng) * r * Math.cos(c.lat * r); return R * Math.hypot(dx, dy); };
  // Zoomed out, it is what is in view. Zoomed in to a town or a street, the view holds too little to
  // say anything, so it is everything within 25 km, and the card says which.
  const close = km(b.getEast(), b.getNorth()) < 25;
  const seen = close ? us.sites.filter(d => km(d.pos[0], d.pos[1]) <= 25)
    : us.sites.filter(d => d.pos[0] >= b.getWest() && d.pos[0] <= b.getEast() && d.pos[1] >= b.getSouth() && d.pos[1] <= b.getNorth());
  const near = map.getZoom() >= 6.5 ? CITIES.map(x => ({ x, d: km(x.pos[0], x.pos[1]) })).sort((p, q) => p.d - q.d)[0] : null;
  const place = near && near.d < 60 ? `Near ${near.x.name}` : map.getZoom() < 5 ? 'United States' : 'This view';
  const away = Math.round(km(HOME.center[0], HOME.center[1]) / 10) * 10;
  const home = `<div class="explain"><div class="who rule">No Clarity site here yet</div>
      <p class="muted">The nearest is the Princeton demo, ${away.toLocaleString()} km away. <button class="area-home">Go to the demo</button></p></div>`;
  const head = `<div class="hero-head">
      <div class="hero-title"><button class="hero-min" title="Minimize / expand"></button>Public water samples ${close ? 'within 25 km' : 'in view'}</div>
      <div class="area-place">${esc(place)}</div>
    </div>`;
  if (!seen.length) {
    el.innerHTML = `${head}<p class="area-line">No public sample of dissolved solids ${close ? 'within 25 km' : 'in view'} since 2024.</p>${home}`;
  } else {
    const tds = seen.map(d => d.tds).sort((p, q) => p - q), median = tds[Math.floor(tds.length / 2)];
    const over = seen.filter(d => d.tds >= 500).length, share = over / seen.length;
    const days = seen.map(d => (Date.now() - Date.parse(d.date)) / 864e5).sort((p, q) => p - q);
    const latest = new Date(Math.max(...seen.map(d => Date.parse(d.date)))).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const months = Math.round(days[Math.floor(days.length / 2)] / 30.4);
    const bands = TDS_BANDS.map(x => ({ ...x, n: seen.filter(d => tdsColor(d.tds) === x.rgb).length }));
    el.innerHTML = `${head}
      <div class="hero-big">
        <div><span class="num" style="color:rgb(${tdsColor(median).join(',')})">${median.toLocaleString()}</span><span class="unit">${seen.length === 1 ? 'ppm at the one site' : 'ppm, the median'}</span></div>
        <div class="pct">${ring(share, { size: 62, label: `${Math.round(share * 100)}%` })}<span>over 500 ppm</span></div>
      </div>
      <div class="usbar">${bands.map(x => `<i style="flex:${x.n};background:rgb(${x.rgb.join(',')})" title="${x.label} ppm: ${x.n.toLocaleString()}"></i>`).join('')}</div>
      <p class="area-line">${seen.length.toLocaleString()} ${seen.length === 1 ? 'site' : 'sites'} sampled since 2024, the latest on ${latest}.
        ${seen.length > 2 ? `Half have gone ${months} months or more without a new sample.` : ''}</p>
      <p class="muted small">Rivers, lakes and wells, from the Water Quality Portal (USGS, EPA and state agencies). Untreated water, not tap water: 500 ppm is the EPA's drinking-water guideline, shown for scale.</p>
      ${home}`;
  }
  el.querySelector('.area-home')?.addEventListener('click', () => document.getElementById('btn-reset')?.click());
}

// The card follows the map: redraw when the view settles somewhere other than home, or comes back.
map.on('moveend', () => { if (areaShown || !atHome(map.getCenter())) renderHero(); });

function renderHero() {
  const el = $('#hero');
  areaShown = us.sites.length > 0 && !atHome(map.getCenter());
  if (areaShown) { renderArea(el); return; }
  const h = heroTest();
  if (!h) { el.innerHTML = '<div class="hero-title">Waiting for the first test…</div>'; return; }
  const { before, after } = testPair(h.node, h.test);
  const n = state.nodes.get(h.node);
  const filter = (after || before)?.ai_filter || (after || before)?.filter;
  const src = state.sources.get(after?.id) || state.sources.get(before?.id) || after?.source || before?.source;   // the gateway also stores who chose
  const pct = before && after && before.tds ? Math.round((1 - after.tds / before.tds) * 100) : null;
  const color = r => `rgb(${(VERDICT_RGB[r?.verdict] || [113, 117, 128]).join(',')})`;
  const metric = (k, key, d = 0) => `<div><div class="k">${k}</div><div class="v">${before ? Number(before[key]).toFixed(d) : '–'}<span class="to">→</span>${after ? Number(after[key]).toFixed(d) : '…'}</div></div>`;
  const expl = [before?.explanation, after?.explanation].filter(Boolean);
  el.innerHTML = `
    <div class="hero-head">
      <div class="hero-title"><button class="hero-min" title="Minimize / expand"></button>Before and after, test ${h.test}</div>
      <div class="hero-node" data-node="${esc(h.node)}">${esc(n?.name || h.node)} ${n?.sim ? '<span class="chip sim">simulated</span>' : ''}</div>
    </div>
    <div class="hero-big">
      <div><span class="num" style="color:${color(before)}">${before ? before.tds : '–'}</span><span class="unit">ppm</span></div>
      <div class="arrow">→</div>
      ${after
        ? `<div><span class="num" style="color:${color(after)}">${after.tds}</span><span class="unit">ppm</span></div>
           <div class="pct">${ring(pct / 100, { size: 62, label: `${pct}%` })}<span>TDS removed</span></div>`
        : '<div class="pending">Retest pending…<br/><span class="muted small">Pour the filtered water</span></div>'}
    </div>
    ${before ? `<div class="hero-bars">
      <div class="hb"><span>Before</span>${tdsBar(before.tds, color(before))}<b>${before.tds}</b></div>
      <div class="hb"><span>After</span>${after ? tdsBar(after.tds, color(after)) : tdsBar(0, 'transparent')}<b>${after ? after.tds : '…'}</b></div>
      <div class="hb-scale"><span>0</span><span>EPA guideline 500</span><span>1,000 ppm</span></div>
    </div>` : ''}
    ${filter ? `<div class="filter-tag">Filter used: ${FILTER_LABEL[filter] || filter}</div>` : ''}
    <div class="trio">${metric('TDS (ppm)', 'tds')}${metric(n?.sim ? 'pH' : 'pH, estimated', 'ph', 2)}${metric('Clarity', 'clarity', 2)}</div>
    ${expl.length ? `<div class="explain">
        <div class="who ${src === 'local_rule' ? 'rule' : ''}">${sourceLabel(src)}</div>
        ${expl.map(t => `<p>${esc(t)}</p>`).join('')}
      </div>` : before ? (before.ai_filter
        ? `<div class="explain"><div class="who rule">Local rule</div><p class="muted">The tank's own rule chose this. There is no model explanation for this pour.</p></div>`
        : `<div class="explain"><div class="who">${AI_NAME}</div><p class="muted">Thinking…</p></div>`) : ''}
  `;
  el.querySelector('.hero-node')?.addEventListener('click', () => openDrawer(h.node));
}

// ---------- live feed ----------
function feedItem(html, cls, node) {
  const el = document.createElement('div');
  el.className = `item ${cls}`;
  el.innerHTML = html;
  if (node) el.addEventListener('click', () => openDrawer(node));
  const feed = $('#feed');
  feed.prepend(el);
  while (feed.children.length > 60) feed.lastChild.remove();
}

function feedReading(r) {
  const n = state.nodes.get(r.node);
  feedItem(`<div class="item-top"><span class="nodename">${esc(nodeName(r.node))}</span>
      ${n?.sim ? '<span class="chip sim">sim</span>' : ''}<span class="chip ${r.verdict}">${VERDICT_LABEL[r.verdict] || r.verdict}</span>
      <span class="t">${fmtTime(r.ts)}</span></div>
    <div class="body">Test #${r.test} ${r.phase === 'after' ? 'retest (after filter)' : 'first pour'}: TDS <b>${r.tds}</b> ppm · pH ${r.ph} · clarity ${r.clarity}</div>
    ${tdsBar(r.tds, `rgb(${(VERDICT_RGB[r.verdict] || [113, 117, 128]).join(',')})`)}`, `reading v-${r.verdict}`, r.node);
}

function feedDecision(d) {
  feedItem(`<div class="item-top"><span class="chip ai">${sourceLabel(d.source)}</span>
      <span class="nodename">${esc(nodeName(d.node))}</span><span class="t">#${d.test} ${d.phase}</span></div>
    <div class="body"><b>${FILTER_LABEL[d.ai_filter] || d.ai_filter}</b> · ${esc(d.explanation)}</div>`, 'decision v-ai', d.node);
}

function reportHTML(rep) {
  return `<div class="item-top"><span class="chip PH_WARN">Investigator</span><span class="nodename">${esc(nodeName(rep.node))}</span><span class="t">test #${rep.test}</span></div>
    <div class="body">${esc(rep.summary)}</div>
    ${rep.findings?.length ? `<div class="lbl">Findings</div><ul>${rep.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${rep.actions?.length ? `<div class="lbl">Actions</div><ul>${rep.actions.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`;
}

function addReport(rep) {
  state.reports.unshift(rep);
  feedItem(reportHTML(rep), 'report report-card', rep.node);
  renderReports();
  if (state.selected === rep.node) renderDrawer();
}

function renderReports() {
  if (!state.reports.length) return;
  $('#reports').innerHTML = state.reports.slice(0, 10).map(r => `<div class="report-card">${reportHTML(r)}</div>`).join('');
}

// ---------- business view ----------
function gaugeSVG(frac, color) {
  const f = Math.max(0, Math.min(1, frac));
  const a = Math.PI * (1 - f);
  const x = 50 + 40 * Math.cos(a), y = 50 - 40 * Math.sin(a);
  return `<svg viewBox="0 0 100 58">
    <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="rgba(113,117,128,.35)" stroke-width="9" stroke-linecap="round"/>
    ${f > 0.001 ? `<path d="M10 50 A40 40 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"/>` : ''}
    <text x="50" y="47" text-anchor="middle" fill="currentColor" font-size="15" font-weight="700">${Math.round(f * 100)}%</text>
  </svg>`;
}

function renderFilters() {
  const statusColor = { OK: 'var(--safe)', REPLACE_SOON: 'var(--cloudy)', REPLACE: 'var(--high)' };
  $('#filters').innerHTML = state.filters.map(f => {
    let frac, sub;
    if (f.filter === 'ZEROWATER') {
      frac = (f.last_after_tds ?? 0) / ZEROWATER_REPLACE_PPM;
      sub = `Last retest <b>${f.last_after_tds ?? '–'} ppm</b> (replace at ${ZEROWATER_REPLACE_PPM})<br/>${f.liters} L filtered`;
    } else if (f.filter === 'BRITA') {
      frac = f.liters / BRITA_RATED_L;
      sub = `<b>${f.liters} L</b> of ${BRITA_RATED_L} L rated (replace soon at ${BRITA_SOON_L})<br/>Last retest ${f.last_after_tds ?? '–'} ppm`;
    } else {
      frac = 0; sub = `${f.liters} L`;
    }
    return `<div class="gauge">${gaugeSVG(frac, statusColor[f.status] || 'var(--accent)')}
      <div class="name">${FILTER_LABEL[f.filter] || f.filter}</div>
      <div class="sub">${sub}</div><span class="chip ${f.status}">${f.status.replace('_', ' ')}</span></div>`;
  }).join('') || '<p class="muted small">No filter data yet.</p>';

  const alerts = state.filters.filter(f => f.status !== 'OK');
  $('#alerts').innerHTML = alerts.map(f => `<div class="alert ${f.status}"><div>
      <b>${f.status === 'REPLACE' ? 'Replace' : 'Replace soon'}: ${FILTER_LABEL[f.filter] || f.filter}</b>
      ${f.filter === 'ZEROWATER'
        ? `Retest read ${f.last_after_tds} ppm. ZeroWater's own rule is to replace at ${ZEROWATER_REPLACE_PPM} ppm or more.`
        : `${f.liters} of ${BRITA_RATED_L} L used (${Math.round((f.liters / BRITA_RATED_L) * 100)}%).`}
    </div></div>`).join('');
  const badge = $('#alert-count');
  badge.textContent = alerts.length;
  badge.classList.toggle('hidden', !alerts.length);
}

let ovPending = false;
function scheduleOverview() {
  if (ovPending) return; ovPending = true;
  requestAnimationFrame(() => { ovPending = false; renderOverview($('#tab-ov'), { state, nodeView, testPair, openDrawer }); });
}
function renderKpis() {
  scheduleOverview();
  const all = [...state.byId.values()];
  const befores = all.filter(r => r.phase === 'before');
  const afters = all.filter(r => r.phase === 'after');
  const safeAfter = afters.length ? Math.round((afters.filter(r => r.verdict === 'SAFE').length / afters.length) * 100) : 0;
  const drops = afters.map(a => { const b = testPair(a.node, a.test).before; return b && b.tds ? 1 - a.tds / b.tds : null; }).filter(x => x != null);
  const avgDrop = drops.length ? Math.round((drops.reduce((s, x) => s + x, 0) / drops.length) * 100) : 0;
  const liters = state.filters.reduce((s, f) => s + (f.liters || 0), 0);
  const real = [...state.nodes.values()].filter(n => !n.sim).length;
  $('#kpis').innerHTML = [
    [befores.length, 'water tests run'],
    [`${safeAfter}%`, 'in range after filtering'],
    [`−${avgDrop}%`, 'avg TDS removed'],
    [`${liters.toFixed(1)} L`, 'water filtered'],
    [state.nodes.size, `sites (${real} real, ${state.nodes.size - real} sim)`],
    [befores.filter(r => r.verdict !== 'SAFE').length, 'first pours out of range'],
  ].map(([v, k]) => `<div class="kpi"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
}

async function refreshFilters() {
  try { state.filters = await state.api.filters(); } catch { /* keep last */ }
  renderFilters(); renderKpis();
}

async function exportCSV() {
  let rows = [...state.byId.values()];
  try {
    const fetched = await state.api.readings(null, 10000);
    fetched.forEach(addReading);
    rows = [...state.byId.values()];
  } catch { /* export what we have */ }
  rows.sort((a, b) => a.id - b.id);
  const cols = ['id', 'ts', 'node', 'name', 'sim', 'test', 'phase', 'ph', 'tds', 'clarity', 'verdict', 'filter', 'ai_filter', 'ai_source', 'anomaly', 'rssi', 'lat', 'lon', 'explanation'];
  const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c =>
    cell(c === 'name' ? nodeName(r.node) : c === 'ai_source' ? (state.sources.get(r.id) || r.source) : r[c])).join(','))).join('\n');
  const filename = `clarity-water-log-${new Date().toISOString().slice(0, 10)}.csv`;
  // Inside a claude.ai artifact, files are handed over through the viewer's downloads capability.
  if (ARTIFACT && window.claude?.use) {
    const downloads = await window.claude.use('downloads');
    if (downloads) { try { await downloads.save({ filename, data: csv }); } catch { /* viewer declined */ } return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- node drawer ----------
const charts = [];
const bandPlugin = {
  id: 'band',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts || opts.min == null) return;
    const { ctx, chartArea: a, scales: { y } } = chart;
    const top = y.getPixelForValue(Math.min(opts.max, y.max)), bot = y.getPixelForValue(Math.max(opts.min, y.min));
    ctx.save(); ctx.fillStyle = 'rgba(90,155,189,0.10)'; ctx.fillRect(a.left, top, a.right - a.left, bot - top);
    if (opts.line != null && opts.line < y.max) {
      const ly = y.getPixelForValue(opts.line);
      ctx.strokeStyle = 'rgba(209,73,91,.7)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a.left, ly); ctx.lineTo(a.right, ly); ctx.stroke();
    }
    ctx.restore();
  },
};

function lineChart(canvas, labels, series, opts) {
  return new Chart(canvas, {
    type: opts.type || 'line',
    data: {
      labels,
      datasets: series.map(s => ({
        label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.fill || s.color,
        pointRadius: 2.5, pointHoverRadius: 5, borderWidth: 2, tension: 0.3, spanGaps: true, fill: !!s.fill,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, band: opts.band || {}, tooltip: { backgroundColor: '#0F1B27', borderColor: 'rgba(247,240,240,.28)', borderWidth: 1 } },
      scales: {
        x: { ticks: { color: 'rgba(247,240,240,.55)', maxTicksLimit: 5, font: { size: 10 } }, grid: { display: false } },
        y: { min: opts.min, max: opts.max, ticks: { color: 'rgba(247,240,240,.55)', font: { size: 10 }, maxTicksLimit: 5 }, grid: { color: 'rgba(247,240,240,.08)' } },
      },
    },
    plugins: [bandPlugin],
  });
}

async function openDrawer(node) {
  state.selected = node;
  renderMap();                       // the open site's branch of the water route is picked out
  $('#drawer').classList.remove('hidden');
  const n = state.nodes.get(node);
  if (n?.lat != null) {
    stopMotion();
    // padding: undefined crashes MapLibre's flyTo on narrow screens, so only pass it when there is one.
    map.flyTo({ center: [n.lon, n.lat], zoom: Math.max(map.getZoom(), 14.8), pitch: 60, duration: 1800, essential: true,
      ...(desktop() ? { padding: { left: 40, right: 40, top: 40, bottom: 120 } } : {}) });
  }
  renderDrawer();
  try {
    const rs = await state.api.readings(node, 200);
    rs.forEach(addReading);
    if (state.selected === node) renderDrawer();
  } catch (e) { console.warn('readings fetch failed', e); }
}

function closeDrawer() {
  state.selected = null;
  renderMap();
  $('#drawer').classList.add('hidden');
  charts.splice(0).forEach(c => c.destroy());
}

function renderDrawer() {
  const node = state.selected;
  if (!node) return;
  const n = state.nodes.get(node) || { node, name: node };
  const rs = (state.readings.get(node) || []).slice(-80);
  const latest = rs[rs.length - 1];
  const reps = state.reports.filter(r => r.node === node).slice(0, 2);
  charts.splice(0).forEach(c => c.destroy());
  const anomaly = latest?.anomaly ?? 0;
  $('#drawer-body').innerHTML = `
    <h2>${esc(n.name)}</h2>
    <div class="meta"><span>${esc(node)}</span>
      ${n.lastBefore ? `<span>Source water</span><span class="chip ${n.lastBefore.verdict}">${VERDICT_LABEL[n.lastBefore.verdict] || n.lastBefore.verdict}</span>` : ''}
      ${latest ? `<span>RSSI ${latest.rssi} dBm</span><span>Last ${fmtTime(latest.ts)}</span>` : ''}</div>
    ${n.sim ? '<div class="sim-banner">Simulated node. Readings are generated, not measured.</div>' : ''}
    <div class="anomaly">
      <div><div class="lbl">Anomaly score</div><div class="score" style="color:${anomaly > 0.66 ? 'var(--high)' : anomaly > 0.33 ? 'var(--cloudy)' : 'var(--safe)'}">${anomaly.toFixed(2)}</div></div>
      <div style="flex:1"><div class="bar"><i style="left:${anomaly * 100}%"></i></div>
        <div class="small muted" style="margin-top:8px">${anomaly > 0.66 ? 'Very unusual for this site' : anomaly > 0.33 ? 'Somewhat unusual for this site' : 'Normal for this site'}</div></div>
    </div>
    <h3>Dissolved solids in ppm, first pour and after the filter</h3><div class="chart"><canvas id="c-tds"></canvas></div>
    <h3>${n.sim ? 'pH' : 'pH, estimated'}, usual range 6.5 to 8.5</h3><div class="chart"><canvas id="c-ph"></canvas></div>
    <h3>Clarity, where 1 is clear</h3><div class="chart"><canvas id="c-cl"></canvas></div>
    <h3>Anomaly score over time</h3><div class="chart" style="height:90px"><canvas id="c-an"></canvas></div>
    ${reps.length ? `<h3>Investigator</h3>${reps.map(r => `<div class="report-card" style="margin-bottom:8px">${reportHTML(r)}</div>`).join('')}` : ''}
    ${latest?.explanation ? `<h3>Latest AI note</h3><div class="explain"><p>${esc(latest.explanation)}</p></div>` : ''}
  `;
  if (!rs.length) return;
  const labels = rs.map(r => fmtTime(r.ts));
  const pick = (phase, key) => rs.map(r => (r.phase === phase ? r[key] : null));
  charts.push(lineChart($('#c-tds'), labels, [
    { label: 'First pour', data: pick('before', 'tds'), color: '#D9667E' },
    { label: 'After filter', data: pick('after', 'tds'), color: '#5A9BBD' },
  ], { min: 0, band: { min: 0, max: 300, line: 500 } }));
  charts.push(lineChart($('#c-ph'), labels, [{ label: 'pH', data: rs.map(r => r.ph), color: '#A892C8' }], { min: 5, max: 10, band: { min: 6.5, max: 8.5 } }));
  charts.push(lineChart($('#c-cl'), labels, [{ label: 'Clarity', data: rs.map(r => r.clarity), color: '#F7F0F0' }], { min: 0, max: 1, band: { min: 0.6, max: 1 } }));
  charts.push(lineChart($('#c-an'), labels, [{ label: 'Anomaly', data: rs.map(r => r.anomaly), color: 'rgba(113,117,128,.9)' }], { type: 'bar', min: 0, max: 1 }));
}

// ---------- wiring ----------
function onMessage(m) {
  if (m.type === 'reading') {
    const r = addReading(m);
    feedReading(r);
    renderMap(); renderHero(); renderKpis();
    if (r.phase === 'after') refreshFilters();
    if (state.asOf == null) refreshTimeRange();
    if (state.selected === r.node) renderDrawer();
  } else if (m.type === 'decision') {
    applyDecision(m);
    feedDecision(m);
    renderHero();
    if (state.selected === m.node) renderDrawer();
  } else if (m.type === 'report') {
    addReport(m);
  }
}

function setStatus(s) {
  const el = $('#status');
  // Demo mode (?mock=1 and the artifact build) shows no header label; simulated sites are still labeled on the map.
  el.className = `pill ${s === 'live' ? 'live' : s === 'offline' || s === 'demo' ? 'demo' : ''}`;
  el.textContent = s === 'live' ? 'Live' : s === 'demo' ? 'Demo data' : s === 'offline' ? 'Gateway offline' : s;   // made-up data always says so
  el.title = s === 'offline' ? 'Retrying the gateway. Add ?api=http://host:8000 if it runs on another machine.' : '';
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  for (const k of ['ov', 'live', 'src', 'biz']) $(`#tab-${k}`).classList.toggle('hidden', t.dataset.tab !== k);
}));
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); exitCutaway(); } });
$('#export').addEventListener('click', exportCSV);

(async function init() {
  initMapControls();
  // Static layers load right away, so the map is usable while the gateway is still connecting.
  buildSearchIndex();
  loadPlaces();
  loadExtras();
  loadUS().then(() => { renderMap(); scheduleOverview(); });
  renderSourcePanel();
  renderMap(); renderHero();
  const { api, mode } = await connect(onMessage, setStatus);
  state.api = api; state.mode = mode;
  const [nodes, readings, reference] = await Promise.all([
    api.nodes(), api.readings(null, 1000).catch(() => []), api.reference().catch(() => []),
  ]);
  for (const n of nodes) {
    state.nodes.set(n.node, { node: n.node, name: n.name, lat: n.lat, lon: n.lon, sim: n.sim, latest: null, lastBefore: null });
    if (n.latest) addReading(n.latest);
  }
  readings.forEach(addReading);
  state.reference = reference;
  // Make sure the hero test has both halves, even if /api/readings was capped.
  const h = heroTest();
  if (h) { try { (await api.test(h.node, h.test)).forEach(r => r && addReading(r)); } catch { /* ok */ } }
  [...state.byId.values()].sort((a, b) => new Date(a.ts) - new Date(b.ts) || a.id - b.id).slice(-12).forEach(feedReading);
  renderHero(); await refreshFilters(); renderMap();
  refreshTimeRange();
  buildSearchIndex();
  rebuildBranches();
  renderSourcePanel();
  scheduleOverview();
  window.clarity = { state, openDrawer, map }; // handy for debugging in the console
})();
