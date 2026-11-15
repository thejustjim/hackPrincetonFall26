# Extra layers for the game-style map and the water story. Run after convert.py.
import json, math, random, sys
import pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import mapping, Point, shape
from shapely.strtree import STRtree
OUT = sys.argv[1]; WIDE = sys.argv[2]
random.seed(7)
def rnd(o, d=5):
    if isinstance(o, (list, tuple)):
        if o and isinstance(o[0], (int, float)): return [round(o[0], d), round(o[1], d)] + ([round(o[2], 1)] if len(o) > 2 else [])
        return [rnd(x, d) for x in o]
    return o
def name(n): return (n or {}).get('primary') if n else None
def write(fname, obj):
    s = json.dumps(obj, separators=(',', ':')); open(f'{OUT}/{fname}', 'w').write(s); print(fname, f'{len(s)/1e6:.2f} MB')

# --- buildings + parts, with roof/facade hints
def bheight(r):
    if r.get('height'): return round(r['height'], 1)
    if r.get('num_floors'): return round(r['num_floors'] * 3.4, 1)
    return {'garage': 3.5, 'shed': 3, 'house': 8, 'detached': 8, 'residential': 9, 'apartments': 14, 'university': 14,
            'college': 14, 'school': 10, 'church': 16, 'commercial': 10, 'retail': 7}.get(r.get('class'), 7)
feats = []
for r in pq.read_table('buildings_building.parquet').to_pylist():
    g = wkb.loads(r['geometry']).simplify(0.000005, preserve_topology=True)
    if g.is_empty: continue
    p = {'h': bheight(r), 'n': name(r['names']), 'c': r.get('class') or r.get('subtype')}
    if r.get('min_height'): p['b'] = round(r['min_height'], 1)
    if r.get('roof_color'): p['rc'] = r['roof_color']
    if r.get('facade_color'): p['fc'] = r['facade_color']
    if r.get('num_floors'): p['f'] = r['num_floors']
    feats.append({'type': 'Feature', 'geometry': {'type': g.geom_type, 'coordinates': rnd(mapping(g)['coordinates'])}, 'properties': {k: v for k, v in p.items() if v is not None}})
for r in pq.read_table('buildings_building_part.parquet').to_pylist():
    g = wkb.loads(r['geometry'])
    p = {'h': round(r['height'] or 10, 1), 'b': round(r.get('min_height') or 0, 1), 'n': name(r['names']), 'part': 1}
    if r.get('roof_color'): p['rc'] = r['roof_color']
    feats.append({'type': 'Feature', 'geometry': {'type': g.geom_type, 'coordinates': rnd(mapping(g)['coordinates'])}, 'properties': {k: v for k, v in p.items() if v is not None}})
write('buildings.json', {'type': 'FeatureCollection', 'features': feats})
bgeoms = [shape(f['geometry']) for f in feats]
btree = STRtree(bgeoms)
def in_building(pt): return any(bgeoms[i].contains(pt) for i in btree.query(pt))

# --- trees: mapped trees + scattered trees in parks and woods (not inside buildings)
trees = []
for r in pq.read_table('base_land.parquet').to_pylist():
    g = wkb.loads(r['geometry'])
    if r['class'] == 'tree' and g.geom_type == 'Point': trees.append([round(g.x, 6), round(g.y, 6), round(random.uniform(0.8, 1.3), 2)])
M2 = 111000 * 84500  # deg^2 -> m^2 at this latitude
def scatter(g, per_m2, cap):
    n = min(cap, int(g.area * M2 * per_m2))
    minx, miny, maxx, maxy = g.bounds; out = []; tries = 0
    while len(out) < n and tries < n * 6:
        tries += 1
        pt = Point(random.uniform(minx, maxx), random.uniform(miny, maxy))
        if g.contains(pt) and not in_building(pt): out.append([round(pt.x, 6), round(pt.y, 6), round(random.uniform(0.7, 1.35), 2)])
    return out
for r in pq.read_table('base_land.parquet').to_pylist():
    if r['class'] in ('wood', 'forest'):
        g = wkb.loads(r['geometry'])
        if g.geom_type in ('Polygon', 'MultiPolygon'): trees += scatter(g, 1 / 900, 400)
for r in pq.read_table('base_land_use.parquet').to_pylist():
    if r['class'] in ('park', 'garden', 'cemetery', 'recreation_ground', 'nature_reserve', 'golf_course', 'rough', 'meadow', 'grass'):
        g = wkb.loads(r['geometry'])
        if g.geom_type in ('Polygon', 'MultiPolygon'): trees += scatter(g, {'golf_course': 1 / 2500, 'grass': 1 / 450}.get(r['class'], 1 / 700), 250)
# street trees along residential roads
for r in pq.read_table('transportation_segment.parquet').to_pylist():
    if r['class'] in ('residential', 'tertiary') and random.random() < 0.6:
        g = wkb.loads(r['geometry']); L = g.length * 100000
        for k in range(int(L / 28)):
            p = g.interpolate(random.random(), normalized=True)
            side = random.choice([-1, 1]) * 0.00009
            pt = Point(p.x + side * random.random(), p.y + side * random.random())
            if not in_building(pt): trees.append([round(pt.x, 6), round(pt.y, 6), round(random.uniform(0.6, 1.0), 2)])
random.shuffle(trees); trees = trees[:30000]
write('trees.json', trees)

# --- road labels: one label per road name per ~500 m
labels = {}; 
for r in pq.read_table('transportation_segment.parquet').to_pylist():
    n = name(r['names'])
    if not n or r['class'] in ('footway', 'path', 'service', 'cycleway', 'steps'): continue
    g = wkb.loads(r['geometry'])
    if g.length * 100000 < 60: continue
    mid = g.interpolate(0.5, normalized=True)
    a = g.interpolate(0.45, normalized=True); b = g.interpolate(0.55, normalized=True)
    ang = math.degrees(math.atan2((b.y - a.y) * 111, (b.x - a.x) * 84.5))
    if ang > 90: ang -= 180
    if ang < -90: ang += 180
    cell = (n, round(mid.x / 0.006), round(mid.y / 0.0045))
    major = r['class'] in ('motorway', 'trunk', 'primary', 'secondary')
    if cell not in labels or g.length > labels[cell][3]:
        labels[cell] = (round(mid.x, 6), round(mid.y, 6), round(ang, 1), g.length, n, 1 if major else 0)
write('road_labels.json', [[v[0], v[1], v[2], v[4], v[5]] for v in labels.values()])

# --- water infrastructure (wider area): towers, hydrants, fountains
inf = []
for r in pq.read_table('base_infrastructure.parquet').to_pylist():
    if r['class'] in ('water_tower', 'fire_hydrant', 'drinking_water', 'fountain'):
        c = wkb.loads(r['geometry']).centroid
        inf.append({'k': r['class'], 'n': name(r['names']), 'pos': [round(c.x, 6), round(c.y, 6)]})
write('water_infra.json', inf)

# --- upstream water (wide bbox): the rivers and canal that feed the Raritan system
KEEP = {'Delaware and Raritan Canal', 'Millstone River', 'Raritan River', 'South Branch Raritan River', 'North Branch Raritan River', 'Stony Brook', 'Six Mile Run', 'Beden Brook', 'Lake Carnegie', 'Carnegie Lake', 'Raritan Power Canal'}
wf = []
for r in pq.read_table(f'{WIDE}/base_water.parquet').to_pylist():
    n = name(r['names'])
    if n not in KEEP and not (r['subtype'] in ('river', 'canal') and n): continue
    g = wkb.loads(r['geometry']).simplify(0.00003, preserve_topology=True)
    wf.append({'type': 'Feature', 'geometry': {'type': g.geom_type, 'coordinates': rnd(mapping(g)['coordinates'])}, 'properties': {'s': r['subtype'], 'n': n}})
write('water_wide.json', {'type': 'FeatureCollection', 'features': wf})
