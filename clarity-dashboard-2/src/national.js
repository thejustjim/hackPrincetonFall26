// Nationwide layers: TDS at every Water Quality Portal site, US city labels, and names read from the vector tiles.
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';


export const US_VIEW = { center: [-97.5, 38.6], zoom: 3.6, pitch: 30, bearing: 0 };

// Largest US cities plus a few water-story places, for labels at country zoom and for search.
export const CITIES = [
  ['New York', -74.006, 40.7128, 8.3], ['Los Angeles', -118.2437, 34.0522, 3.9], ['Chicago', -87.6298, 41.8781, 2.7], ['Houston', -95.3698, 29.7604, 2.3],
  ['Phoenix', -112.074, 33.4484, 1.6], ['Philadelphia', -75.1652, 39.9526, 1.6], ['San Antonio', -98.4936, 29.4241, 1.5], ['San Diego', -117.1611, 32.7157, 1.4],
  ['Dallas', -96.797, 32.7767, 1.3], ['Austin', -97.7431, 30.2672, 0.97], ['Jacksonville', -81.6557, 30.3322, 0.95], ['San Jose', -121.8863, 37.3382, 0.97],
  ['Fort Worth', -97.3308, 32.7555, 0.95], ['Columbus', -82.9988, 39.9612, 0.9], ['Charlotte', -80.8431, 35.2271, 0.88], ['Indianapolis', -86.1581, 39.7684, 0.88],
  ['San Francisco', -122.4194, 37.7749, 0.81], ['Seattle', -122.3321, 47.6062, 0.75], ['Denver', -104.9903, 39.7392, 0.71], ['Washington', -77.0369, 38.9072, 0.69],
  ['Nashville', -86.7816, 36.1627, 0.69], ['Oklahoma City', -97.5164, 35.4676, 0.69], ['El Paso', -106.485, 31.7619, 0.68], ['Boston', -71.0589, 42.3601, 0.65],
  ['Portland', -122.6765, 45.5152, 0.64], ['Las Vegas', -115.1398, 36.1699, 0.65], ['Detroit', -83.0458, 42.3314, 0.63], ['Memphis', -90.049, 35.1495, 0.62],
  ['Louisville', -85.7585, 38.2527, 0.62], ['Baltimore', -76.6122, 39.2904, 0.57], ['Milwaukee', -87.9065, 43.0389, 0.57], ['Albuquerque', -106.6504, 35.0844, 0.56],
  ['Tucson', -110.9747, 32.2226, 0.54], ['Fresno', -119.7871, 36.7378, 0.54], ['Sacramento', -121.4944, 38.5816, 0.52], ['Kansas City', -94.5786, 39.0997, 0.51],
  ['Atlanta', -84.388, 33.749, 0.5], ['Miami', -80.1918, 25.7617, 0.44], ['Raleigh', -78.6382, 35.7796, 0.47], ['Omaha', -95.9345, 41.2565, 0.48],
  ['Minneapolis', -93.265, 44.9778, 0.43], ['Tulsa', -95.9928, 36.154, 0.41], ['Cleveland', -81.6944, 41.4993, 0.37], ['New Orleans', -90.0715, 29.9511, 0.38],
  ['Tampa', -82.4572, 27.9506, 0.4], ['Pittsburgh', -79.9959, 40.4406, 0.3], ['Salt Lake City', -111.891, 40.7608, 0.2], ['St. Louis', -90.1994, 38.627, 0.29],
  ['Newark', -74.1724, 40.7357, 0.31], ['Buffalo', -78.8784, 42.8864, 0.28], ['Boise', -116.2023, 43.615, 0.24], ['Anchorage', -149.9003, 61.2181, 0.29],
  ['Honolulu', -157.8583, 21.3069, 0.35], ['Flint', -83.6875, 43.0125, 0.08], ['Jackson', -90.1848, 32.2988, 0.15], ['Trenton', -74.7429, 40.2206, 0.09],
  ['Princeton', -74.6593, 40.3573, 0.03], ['Bakersfield', -119.0187, 35.3733, 0.4], ['Corpus Christi', -97.3964, 27.8006, 0.32], ['Spokane', -117.426, 47.6588, 0.23],
  ['Des Moines', -93.625, 41.5868, 0.21], ['Madison', -89.4012, 43.0731, 0.27], ['Richmond', -77.436, 37.5407, 0.23], ['Charleston', -79.9311, 32.7765, 0.15],
  ['Little Rock', -92.2896, 34.7465, 0.2], ['Billings', -108.5007, 45.7833, 0.12], ['Fargo', -96.7898, 46.8772, 0.13], ['Cheyenne', -104.8202, 41.14, 0.065],
  ['Portland, ME', -70.2553, 43.6591, 0.068], ['Burlington', -73.2121, 44.4759, 0.045],
].map(([name, lon, lat, pop]) => ({ name, pos: [lon, lat], pop }));

// TDS bands (mg/L = ppm). EPA's secondary guideline for drinking water is 500 mg/L.
// Colours: blue under the EPA line, rose over it, the same blue and rose the tanks use for "In range" and
// "High TDS". (Yellow is not used here: on this map yellow means cloudy.)
export const TDS_BANDS = [
  { max: 300, rgb: [90, 155, 189], label: 'Under 300' },
  { max: 500, rgb: [152, 170, 184], label: '300–500' },
  { max: 1000, rgb: [232, 160, 174], label: '500–1,000' },
  { max: Infinity, rgb: [217, 102, 126], label: 'Over 1,000' },
];
export const tdsColor = v => TDS_BANDS.find(b => v < b.max).rgb;

export const us = { sites: [], meta: null, tileLabels: [] };

export async function loadUS() {
  try {
    const j = await (await fetch('./data/us_tds.json')).json();
    us.meta = j.source;
    us.sites = j.rows.map(([lon, lat, tds, date, name, type, org]) => ({ pos: [lon, lat], tds, date, name, type, org }));
  } catch { us.sites = []; }
  return us;
}

export function usTooltip(object) {
  const v = object.tds;
  const note = v < 500 ? 'Within the EPA 500 mg/L guideline' : v < 1000 ? 'Above the EPA 500 mg/L guideline' : 'Well above the EPA guideline';
  return { html: `<b>${object.name}</b><br/>TDS ${v.toLocaleString()} ppm · ${note}<br/><span style="opacity:.7">${object.type} · ${object.date}<br/>${object.org} · Water Quality Portal</span>` };
}

// Called from main.js renderMap. Place names are light on the dark map and dark on the light one, like every other label.
export function usLayers({ zoom, on, onClick, place, light }) {
  if (!on) return [];
  const ink = light ? [11, 32, 39, 255] : [247, 240, 240, 225];
  const halo = light ? [247, 240, 240, 230] : [9, 22, 34, 230];
  const fade = zoom > 11 ? Math.max(0, 1 - (zoom - 11) / 2) : 1;
  return [
    us.sites.length && fade > 0 && new ScatterplotLayer({
      id: 'us-tds', data: us.sites, pickable: true, opacity: 0.85 * fade,
      getPosition: d => d.pos, getFillColor: d => tdsColor(d.tds), getLineColor: light ? [247, 240, 240, 220] : [9, 22, 34, 210],
      stroked: true, lineWidthMinPixels: 0.5, radiusUnits: 'pixels',
      getRadius: d => (d.tds >= 1000 ? 4.5 : d.tds >= 500 ? 3.8 : 3), radiusScale: zoom < 5 ? 0.9 : zoom < 8 ? 1.3 : 1.8,
      updateTriggers: { getLineColor: light },
      onClick,
    }),
    zoom < 9 && new TextLayer({
      id: 'us-cities', data: place(CITIES.filter(c => zoom >= 5.2 || c.pop >= (zoom < 4.3 ? 1.2 : 0.45)), { pos: d => d.pos, text: d => d.name, size: d => (d.pop > 1 ? 14 : 12), priority: d => d.pop, dy: -10, anchor: 'bottom' }),
      getPosition: d => d.pos, getText: d => d.name, getSize: d => (d.pop > 1 ? 14 : 12), getColor: ink,
      fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600, outlineWidth: 3, outlineColor: halo, fontSettings: { sdf: true },
      getPixelOffset: [0, -10], characterSet: 'auto',
    }),
    zoom >= 15.3 && us.tileLabels.length && new TextLayer({
      id: 'tile-labels', data: place(us.tileLabels, { pos: d => d.pos, text: d => d.text, size: d => (d.kind === 'road' ? 11 : 12), priority: d => (d.kind === 'road' ? 0 : 1) }), getPosition: d => d.pos, getText: d => d.text, getSize: d => (d.kind === 'road' ? 11 : 12),
      getColor: d => (d.kind === 'road' ? (light ? [70, 74, 84, 255] : [150, 154, 163, 235]) : ink), fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600,
      outlineWidth: 3, outlineColor: halo, fontSettings: { sdf: true }, characterSet: 'auto', billboard: true,
    }),
  ].filter(Boolean);
}

// Street and building names for whatever part of the country is on screen, read from the loaded vector tiles.
export function refreshTileLabels(map) {
  us.tileLabels = [];
  if (map.getZoom() < 15.3 || !map.getSource('ovRoads')) return;
  const seen = new Set();
  for (const f of map.querySourceFeatures('ovRoads', { sourceLayer: 'segment' })) {
    const name = f.properties['@name'] || f.properties.name;
    if (!name || seen.has(name) || f.properties.subtype !== 'road') continue;
    const line = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0];
    if (!line || line.length < 2) continue;
    seen.add(name);
    us.tileLabels.push({ text: name, pos: [...line[Math.floor(line.length / 2)], 2], kind: 'road' });
  }
  const bl = [];
  for (const f of map.querySourceFeatures('ovBuildings', { sourceLayer: 'building' })) {
    const name = f.properties['@name'];
    if (!name || seen.has(name)) continue;
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    const h = +(f.properties.height ?? (f.properties.num_floors ? f.properties.num_floors * 3.4 : 8));
    seen.add(name);
    bl.push({ text: name, pos: [c[0], c[1], h + 4], kind: 'building', h });
  }
  // Keep the map readable in dense downtowns: the tallest named buildings and a few dozen streets.
  bl.sort((a, b) => b.h - a.h);
  us.tileLabels = [...us.tileLabels.slice(0, 30), ...bl.slice(0, map.getZoom() >= 17 ? 40 : 18)];
}
