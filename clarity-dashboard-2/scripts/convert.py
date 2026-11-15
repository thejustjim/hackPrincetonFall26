# Convert Overture Maps parquet extracts (Princeton bbox) into compact GeoJSON for the dashboard.
import json, sys, pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import mapping
OUT = sys.argv[1]

def rnd(o, d=5):
    if isinstance(o, (list, tuple)):
        if o and isinstance(o[0], (int, float)): return [round(o[0], d), round(o[1], d)]
        return [rnd(x, d) for x in o]
    return o

def name(n):
    return (n or {}).get('primary') if n else None

def write(fname, feats):
    fc = {'type': 'FeatureCollection', 'features': feats}
    s = json.dumps(fc, separators=(',', ':'))
    open(f'{OUT}/{fname}', 'w').write(s)
    print(fname, len(feats), f'{len(s)/1e6:.1f} MB')

def feats(path, props_fn, keep=lambda r: True, simplify=0):
    out = []
    for r in pq.read_table(path).to_pylist():
        if not keep(r): continue
        g = wkb.loads(r['geometry'])
        if simplify: g = g.simplify(simplify, preserve_topology=True)
        if g.is_empty: continue
        m = mapping(g)
        p = {k: v for k, v in props_fn(r).items() if v is not None}
        out.append({'type': 'Feature', 'geometry': {'type': m['type'], 'coordinates': rnd(m['coordinates'])}, 'properties': p})
    return out

def bheight(r):
    if r.get('height'): return round(r['height'], 1)
    if r.get('num_floors'): return round(r['num_floors'] * 3.4, 1)
    return {'garage': 3.5, 'shed': 3, 'house': 8, 'detached': 8, 'residential': 9, 'apartments': 14,
            'university': 14, 'college': 14, 'school': 10, 'church': 16, 'commercial': 10, 'retail': 7}.get(r.get('class'), 7)

write('buildings.json', feats('buildings_building.parquet',
      lambda r: {'h': bheight(r), 'n': name(r['names']), 'c': r.get('class')}, simplify=0.000005))
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'footway', 'path', 'cycleway', 'standard_gauge', 'track'}
write('roads.json', feats('transportation_segment.parquet',
      lambda r: {'c': r['class'], 'n': name(r['names'])}, keep=lambda r: r['class'] in ROADS and not (r['class'] in ('service', 'track') and not name(r['names'])), simplify=0.00001))
write('water.json', feats('base_water.parquet',
      lambda r: {'s': r['subtype'], 'c': r['class'], 'n': name(r['names'])}, simplify=0.00001))
LAND = {'pitch', 'grass', 'park', 'golf_course', 'fairway', 'green', 'tee', 'bunker', 'rough', 'recreation_ground', 'meadow',
        'cemetery', 'nature_reserve', 'garden', 'playground', 'farmland', 'school', 'university', 'college'}
lu = feats('base_land_use.parquet', lambda r: {'c': r['class'], 'n': name(r['names'])}, keep=lambda r: r['class'] in LAND, simplify=0.00001)
lu += feats('base_land.parquet', lambda r: {'c': 'wood' if r['class'] in ('wood', 'forest', 'tree') else r['class'], 'n': name(r['names'])},
            keep=lambda r: r['class'] in ('wood', 'forest', 'wetland', 'scrub') and r['geometry'] is not None and wkb.loads(r['geometry']).geom_type != 'Point', simplify=0.00002)
write('landuse.json', lu)

# Places: keep confident, open businesses that matter for a water story (food, cafes, gyms, schools, health...).
KEEP = ('restaurant', 'cafe', 'coffee', 'bakery', 'bar', 'brewery', 'food', 'grocery', 'supermarket', 'gym', 'fitness', 'school',
        'university', 'college', 'hospital', 'clinic', 'dentist', 'hotel', 'salon', 'spa', 'laundr', 'daycare', 'child_care', 'library', 'museum')
def pkeep(r):
    cat = (r.get('basic_category') or (r.get('taxonomy') or {}).get('primary') or '')
    return (r.get('confidence') or 0) >= 0.75 and r.get('operating_status') in (None, 'open') and any(k in cat for k in KEEP) and name(r['names'])
write('places.json', feats('places_place.parquet',
      lambda r: {'n': name(r['names']), 'c': r.get('basic_category') or (r.get('taxonomy') or {}).get('primary')}, keep=pkeep))
