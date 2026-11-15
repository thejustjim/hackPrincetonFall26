// Princeton basemap built from bundled data (public/data/*.json, extracted from Overture Maps / OpenStreetMap),
// so the 3D map works offline. Online extras: hillshade (AWS Terrain Tiles) and satellite imagery (Esri).

const DATA = './data/';
const ATTR_OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://overturemaps.org">Overture Maps</a>';

const ROAD_W = { motorway: 7, trunk: 6, primary: 5, secondary: 4.2, tertiary: 3.4, residential: 2.4, unclassified: 2.2, living_street: 2, service: 1.4, track: 1.2 };
const roadWidth = scale => ['interpolate', ['exponential', 1.6], ['zoom'], 11, ['*', scale * 0.25, ['match', ['get', 'c'], ...Object.entries(ROAD_W).flat(), 1]],
  17, ['*', scale * 2.6, ['match', ['get', 'c'], ...Object.entries(ROAD_W).flat(), 1]]];
const MAJOR = ['motorway', 'trunk', 'primary', 'secondary'];
const PATHS = ['footway', 'path', 'cycleway', 'steps'];
const GREEN = ['park', 'grass', 'pitch', 'garden', 'playground', 'recreation_ground', 'meadow', 'nature_reserve', 'cemetery'];
const GOLF = ['golf_course', 'fairway', 'green', 'tee', 'rough'];

export const THEMES = {
  dark: {
    bg: '#0B2027', green: '#0f2c2c', golf: '#11322f', wood: '#0d2828', farm: '#0e252a', wet: '#0e2a33', sand: '#2b2b26',
    water: '#163f52', waterLine: '#2c6d8f', road: '#173743', roadMajor: '#2a4c58', path: '#14313a', rail: '#3b5058',
    bLow: '#16343e', bHigh: '#2e4f5b', bOpacity: 0.95, hill: 0.3, hillShadow: '#000000', hillHigh: '#2c4a55',
    ocean: '#03090c', other: '#0a1c22', usLand: '#123540', border: '#4f7a88',
  },
  light: {
    bg: '#F7F0F0', green: '#e3e6dc', golf: '#d8e1d2', wood: '#d6ddd0', farm: '#f0ebe5', wet: '#d9e6ea', sand: '#ece4d2',
    water: '#c3dae7', waterLine: '#8db8d1', road: '#ffffff', roadMajor: '#fdfaf6', path: '#e2dada', rail: '#a5a7af',
    bLow: '#e8e1e1', bHigh: '#cdc7c9', bOpacity: 0.96, hill: 0.2, hillShadow: '#717580', hillHigh: '#ffffff',
    ocean: '#cfe2ec', other: '#ebe6e2', border: '#b9b3b6',
  },
  // Storybook "game map" look: grass, warm brick and cream walls, tiled roofs, teal water, cobble roads.
  game: {
    bg: '#9fbf7a', green: '#86b562', golf: '#93c46c', wood: '#6f9f52', farm: '#b9c98d', wet: '#8fb79a', sand: '#e6d7a3',
    water: '#4f9fc4', waterLine: '#4f9fc4', road: '#c9c2b6', roadMajor: '#b8afa1', path: '#d9cdb4', rail: '#7a6f66',
    bLow: '#e9dcc3', bHigh: '#d8c7a6', bOpacity: 1, hill: 0.25, hillShadow: '#3b5a2a', hillHigh: '#d9ecc0', walls: true,
    roadCase: '#8f877b', ocean: '#5fa8d3', other: '#cfd3bd', border: '#f4f0e2',
  },
  satellite: {
    bg: '#000000', green: 'rgba(0,0,0,0)', golf: 'rgba(0,0,0,0)', wood: 'rgba(0,0,0,0)', farm: 'rgba(0,0,0,0)', wet: 'rgba(0,0,0,0)', sand: 'rgba(0,0,0,0)',
    water: 'rgba(30,120,200,0.25)', waterLine: 'rgba(80,170,255,0.6)', road: 'rgba(255,255,255,0.35)', roadMajor: 'rgba(255,220,140,0.6)',
    path: 'rgba(255,255,255,0.18)', rail: 'rgba(255,255,255,0.4)', bLow: '#c8ccd2', bHigh: '#f1f3f5', bOpacity: 0.75, hill: 0, hillShadow: '#000', hillHigh: '#fff',
    ocean: '#000000', other: 'rgba(0,0,0,0)', border: 'rgba(255,255,255,0.5)', usLand: 'rgba(0,0,0,0)',
  },
};

// Two data sources with the same layers:
//  - national (default): Overture Maps vector tiles (PMTiles on Overture's public S3), every building, road and
//    river in the US, no API key.
//  - local (?offline=1): the bundled Princeton GeoJSON in public/data, which works with no internet at all.
export const OVERTURE_TILES = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-10-21.0';
// The claude.ai artifact build (VITE_ARTIFACT=1) can only fetch its own files, so it uses the bundled Princeton data.
export const ARTIFACT = !!import.meta.env.VITE_ARTIFACT;
export const MODE = ARTIFACT || new URLSearchParams(location.search).get('offline') === '1' ? 'local' : 'national';

const G = k => ({ c: ['coalesce', ['get', 'c'], ['get', 'class'], ''], s: ['coalesce', ['get', 's'], ['get', 'subtype'], ''] }[k]);
// Building height: bundled 'h', tile 'height', else floors x 3.4 m, else 7 m.
const H = ['coalesce', ['get', 'h'], ['get', 'height'], ['case', ['has', 'num_floors'], ['*', ['to-number', ['get', 'num_floors'], 2], 3.4], 7]];
const B = ['coalesce', ['get', 'b'], ['get', 'min_height'], 0];
// Stable 0-15 bucket per building for color variety (tile GERS ids are hex strings, bundled ids are numbers).
export const BUCKET = ['case', ['has', 'id'], ['index-of', ['slice', ['to-string', ['get', 'id']], ['-', ['length', ['to-string', ['get', 'id']]], 1]], '0123456789abcdef'],
  ['%', ['to-number', ['id'], 0], 16]];

// Wall and roof colors per theme, 8 variants each; a building's id picks one so streets look varied.
export const WALL_SETS = {
  g: ['#e9dcc3', '#d9b38c', '#c97b5a', '#efe6d2', '#b8664a', '#d8c7a6', '#e4cfa8', '#a9a39a'],
  l: ['#ece6e6', '#e2dcdc', '#d9d3d4', '#efeaea', '#d2cccd', '#e6e0e0', '#dcd6d7', '#cfc9cb'],
  d: ['#1d3c47', '#21424d', '#264852', '#1a3741', '#2b4e59', '#203f4a', '#24454f', '#2e5260'],
  s: ['#c8ccd2', '#d4d6da', '#bfc4cb', '#e0e2e5', '#c3c7cd', '#d9dbde', '#b8bdc4', '#ccd0d5'],
};
export const ROOF_SETS = {
  g: ['#a4553f', '#8a4a3a', '#6f6a6a', '#b4683f', '#5f6670', '#94503c', '#7b7470', '#a35b48'],
  l: ['#cfc8ca', '#c6bfc2', '#bdb7ba', '#d4cdcf', '#b9b3b6', '#c8c1c4', '#c1babd', '#b5afb2'],
  d: ['#12303a', '#163541', '#183843', '#102b34', '#1b3c48', '#142f39', '#173640', '#1d404c'],
  s: ['#9ea3aa', '#a8acb2', '#959aa2', '#b1b5ba', '#9a9fa6', '#a4a8ae', '#8f949c', '#abafb4'],
};
export const themeKey = t => (t.walls ? 'g' : t === THEMES.light ? 'l' : t === THEMES.satellite ? 's' : 'd');
const pick = set => ['match', ['%', ['max', 0, BUCKET], 8], ...set.slice(0, 7).flatMap((c, i) => [i, c]), set[7]];
function wallColor(t) { return pick(WALL_SETS[themeKey(t)]); }
function roofColor(t) {
  const k = themeKey(t);
  // Real roof color from Overture when it is mapped, else a varied tile/slate color.
  if (k !== 'g') return pick(ROOF_SETS[k]);
  // Towers get flat concrete/gravel roofs; houses get the mapped roof color or a tile color.
  return ['case', ['>=', H, 30], pick(['#8d9096', '#a3a29d', '#7c8088', '#9a958c', '#b0aea8', '#868a90', '#9d9a94', '#777b82']),
    ['to-color', ['get', 'roof_color'], pick(ROOF_SETS[k])]];
}

function sources(mode) {
  const common = {
    // Ocean and coastlines: world land (Natural Earth 50m), the US outline and state borders (US Census 1:10M),
    // bundled in public/data/land.json (scripts/build_land.cjs), so the country's shape shows even offline.
    landmask: { type: 'geojson', data: DATA + 'land.json', attribution: 'Coastlines: Natural Earth, US Census' },
    dem: {
      type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
    },
    satellite: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
  };
  if (mode === 'local') {
    return {
      ...common,
      landuse: { type: 'geojson', data: DATA + 'landuse.json', attribution: ATTR_OSM },
      water: { type: 'geojson', data: DATA + 'water.json' },
      waterWide: { type: 'geojson', data: DATA + 'water_wide.json' },
      roads: { type: 'geojson', data: DATA + 'roads.json' },
      buildings: { type: 'geojson', data: DATA + 'buildings.json', generateId: true },
    };
  }
  const pm = name => ({ type: 'vector', url: `pmtiles://${OVERTURE_TILES}/${name}.pmtiles` });
  return {
    ...common,
    ovBase: { ...pm('base'), attribution: ATTR_OSM },
    ovRoads: pm('transportation'),
    ovBuildings: { ...pm('buildings'), promoteId: { building: 'id', building_part: 'id' } },
    ovDivisions: pm('divisions'),
  };
}

// Where each logical layer reads from, per mode.
function src(mode, key) {
  if (mode === 'local') {
    return { landuse: { source: 'landuse' }, landcover: null, land: { source: 'landuse' }, water: { source: 'water' }, waterWide: { source: 'waterWide' },
      roads: { source: 'roads' }, buildings: { source: 'buildings' }, parts: null, borders: null }[key];
  }
  return {
    landuse: { source: 'ovBase', 'source-layer': 'land_use' }, landcover: { source: 'ovBase', 'source-layer': 'land_cover' },
    land: { source: 'ovBase', 'source-layer': 'land' }, water: { source: 'ovBase', 'source-layer': 'water' }, waterWide: null,
    roads: { source: 'ovRoads', 'source-layer': 'segment' }, buildings: { source: 'ovBuildings', 'source-layer': 'building' },
    parts: { source: 'ovBuildings', 'source-layer': 'building_part' }, borders: { source: 'ovDivisions', 'source-layer': 'division_boundary' },
  }[key];
}

export function buildStyle(t = THEMES.dark, mode = MODE) {
  const ls = (p = {}) => ({ 'line-cap': 'round', 'line-join': 'round', ...p });
  const S = k => src(mode, k);
  const C = G('c'), ST = G('s');
  const isPoly = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
  const isLine = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
  const roadFilter = extra => (mode === 'local' ? extra : ['all', ['==', ST, 'road'], extra]);
  const layers = [
    // Zoomed out the background is ocean and land is drawn on top, so coastlines and the US shape show.
    // Zoomed in (z 10+) the background turns land-colored, since the coarse coastline isn't street-accurate.
    { id: 'bg', type: 'background', paint: { 'background-color': ['interpolate', ['linear'], ['zoom'], 9, t.ocean || t.bg, 10, t.bg] } },
    { id: 'land-other', type: 'fill', source: 'landmask', filter: ['==', ['get', 'k'], 'other'], paint: { 'fill-color': t.other || t.bg } },
    { id: 'land-us', type: 'fill', source: 'landmask', filter: ['==', ['get', 'k'], 'us'], paint: { 'fill-color': t.usLand || t.bg } },
    { id: 'us-states', type: 'line', source: 'landmask', filter: ['==', ['get', 'k'], 'states'], maxzoom: 10, layout: { 'line-join': 'round' },
      paint: { 'line-color': t.border || t.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 9, 1.4] } },
    { id: 'us-coast', type: 'line', source: 'landmask', filter: ['==', ['get', 'k'], 'us'], maxzoom: 10,
      paint: { 'line-color': t.border || t.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 9, 2] } },
    { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.85 } },
    // Nationwide land cover so the whole country reads as a map when zoomed out.
    S('landcover') && { id: 'cover-forest', type: 'fill', ...S('landcover'), filter: ['in', ST, ['literal', ['forest', 'mangrove']]], paint: { 'fill-color': t.wood } },
    S('landcover') && { id: 'cover-crop', type: 'fill', ...S('landcover'), filter: ['in', ST, ['literal', ['crop', 'grass', 'shrub', 'moss']]], paint: { 'fill-color': t.farm } },
    S('landcover') && { id: 'cover-wet', type: 'fill', ...S('landcover'), filter: ['==', ST, 'wetland'], paint: { 'fill-color': t.wet } },
    S('landcover') && { id: 'cover-barren', type: 'fill', ...S('landcover'), filter: ['in', ST, ['literal', ['barren', 'snow']]], paint: { 'fill-color': t.sand } },
    { id: 'land-farm', type: 'fill', ...S('landuse'), filter: ['==', C, 'farmland'], paint: { 'fill-color': t.farm } },
    { id: 'land-wood', type: 'fill', ...S('land'), filter: ['all', isPoly, ['in', C, ['literal', ['wood', 'forest', 'scrub']]]], paint: { 'fill-color': t.wood } },
    { id: 'land-wet', type: 'fill', ...S('land'), filter: ['all', isPoly, ['==', C, 'wetland']], paint: { 'fill-color': t.wet } },
    { id: 'land-green', type: 'fill', ...S('landuse'), filter: ['in', C, ['literal', GREEN]], paint: { 'fill-color': t.green } },
    { id: 'land-golf', type: 'fill', ...S('landuse'), filter: ['in', C, ['literal', GOLF]], paint: { 'fill-color': t.golf } },
    { id: 'land-sand', type: 'fill', ...S('landuse'), filter: ['==', C, 'bunker'], paint: { 'fill-color': t.sand } },
    { id: 'hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': t.hill, 'hillshade-shadow-color': t.hillShadow, 'hillshade-highlight-color': t.hillHigh } },
    S('waterWide') && { id: 'upstream-fill', type: 'fill', ...S('waterWide'), filter: isPoly, paint: { 'fill-color': t.water } },
    S('waterWide') && { id: 'upstream-line', type: 'line', ...S('waterWide'), filter: isLine, layout: ls(),
      paint: { 'line-color': t.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 4] } },
    { id: 'water-fill', type: 'fill', ...S('water'), filter: isPoly, paint: { 'fill-color': t.water } },
    { id: 'water-line', type: 'line', ...S('water'), filter: isLine, layout: ls(),
      paint: { 'line-color': t.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, ['match', ST, ['river', 'canal'], 0.6, 0.2], 11, ['match', ST, ['river', 'canal'], 1.5, 0.6], 16, ['match', ST, ['river', 'canal'], 8, 2.5]] } },
    S('borders') && { id: 'state-borders', type: 'line', ...S('borders'), filter: ['all', ['==', ['get', 'country'], 'US'], ['==', ST, 'region']], maxzoom: 11,
      paint: { 'line-color': t.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 10, 1.6], 'line-dasharray': [3, 2] } },
    { id: 'road-path', type: 'line', ...S('roads'), minzoom: 14, filter: roadFilter(['in', C, ['literal', PATHS]]), layout: ls(),
      paint: { 'line-color': t.path, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 18, 2], 'line-dasharray': [2, 1.5] } },
    { id: 'road-rail', type: 'line', ...S('roads'), filter: mode === 'local' ? ['==', C, 'standard_gauge'] : ['==', ST, 'rail'], layout: ls(),
      paint: { 'line-color': t.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 17, 3], 'line-dasharray': [3, 2] } },
    { id: 'road-case', type: 'line', ...S('roads'), minzoom: 13, filter: roadFilter(['!', ['in', C, ['literal', [...PATHS, 'standard_gauge']]]]), layout: ls(),
      paint: { 'line-color': t.roadCase || t.road, 'line-width': roadWidth(1.35), 'line-opacity': t.roadCase ? 1 : 0 } },
    { id: 'road-minor', type: 'line', ...S('roads'), minzoom: mode === 'local' ? 0 : 11, filter: roadFilter(['!', ['in', C, ['literal', [...MAJOR, ...PATHS, 'standard_gauge']]]]), layout: ls(),
      paint: { 'line-color': t.road, 'line-width': roadWidth(1) } },
    { id: 'road-major', type: 'line', ...S('roads'), filter: roadFilter(['in', C, ['literal', MAJOR]]), layout: ls(),
      paint: { 'line-color': t.roadMajor, 'line-width': roadWidth(1) } },
    // Plain-color buildings (far away and for hover highlight).
    { id: 'buildings-3d', type: 'fill-extrusion', ...S('buildings'), minzoom: 13,
      paint: {
        'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#5A9BBD', wallColor(t)],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, H],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, B],
        'fill-extrusion-opacity': t.bOpacity,
        'fill-extrusion-vertical-gradient': true,
      } },
    // Close up, walls get windows, floor lines and doors from generated facade textures (see facades.js).
    { id: 'facades', type: 'fill-extrusion', ...S('buildings'), minzoom: 16,
      paint: {
        'fill-extrusion-pattern': facadePattern(t),
        'fill-extrusion-height': H,
        'fill-extrusion-base': B,
        'fill-extrusion-opacity': t.bOpacity,
        'fill-extrusion-vertical-gradient': false,
      } },
    S('parts') && { id: 'building-parts', type: 'fill-extrusion', ...S('parts'), minzoom: 15,
      paint: { 'fill-extrusion-color': wallColor(t), 'fill-extrusion-height': H, 'fill-extrusion-base': B, 'fill-extrusion-opacity': t.bOpacity } },
    // A darker cap on top of every building reads as a roof (tiles in the game theme).
    { id: 'roofs', type: 'fill-extrusion', ...S('buildings'), minzoom: 14,
      paint: {
        'fill-extrusion-color': roofColor(t),
        'fill-extrusion-base': H,
        'fill-extrusion-height': ['+', H, ['min', 3.2, ['max', 0.8, ['*', 0.16, H]]]],
        'fill-extrusion-opacity': t.bOpacity,
      } },
  ].filter(Boolean);
  return { version: 8, sources: sources(mode), layers };
}

// Facade texture name: wall color bucket + building type (house / mid-rise / tower).
function facadePattern(t) {
  const theme = themeKey(t);
  const kind = ['case', ['<', H, 11], 'house', ['<', H, 30], 'mid', 'tower'];
  return ['concat', 'fac-', theme, '-', kind, '-', ['to-string', ['%', ['max', 0, BUCKET], 8]]];
}

// Repaint an existing map for another theme without reloading the bundled data.
export function applyTheme(map, name) {
  const t = THEMES[name];
  const s = buildStyle(t, MODE);
  for (const l of s.layers) {
    if (!map.getLayer(l.id)) continue;
    for (const [k, v] of Object.entries(l.paint || {})) {
      try { map.setPaintProperty(l.id, k, v); } catch { /* layer may be missing */ }
    }
  }
  map.setLayoutProperty('satellite', 'visibility', name === 'satellite' ? 'visible' : 'none');
}

export const LAYER_GROUPS = {
  buildings: ['buildings-3d', 'facades', 'building-parts', 'roofs'],
  roads: ['road-path', 'road-rail', 'road-case', 'road-minor', 'road-major'],
  water: ['water-fill', 'water-line', 'upstream-fill', 'upstream-line'],
  parks: ['land-farm', 'land-wood', 'land-wet', 'land-green', 'land-golf', 'land-sand', 'cover-forest', 'cover-crop', 'cover-wet', 'cover-barren'],
  terrain: ['hillshade'],
};
