#!/usr/bin/env python3
"""Derive small startup assets from the checked-in public GeoJSON; no downloads.

Run from anywhere: python3 scripts/compact_assets.py [--data-dir DIR].
Full geometry remains available for map/cutaway detail. The intro coastlines are
illustrative at globe scale; vertices around Princeton remain unmodified.
"""
import argparse
import json
from pathlib import Path

PRINCETON_BOUNDS = (-76.0, 39.0, -73.0, 42.0)


def near_princeton(p):
    west, south, east, north = PRINCETON_BOUNDS
    return west <= p[0] <= east and south <= p[1] <= north


def unwrapped(points):
    """Use continuous longitude for distance tests across the antimeridian."""
    out = []
    for p in points:
        x = p[0]
        if out:
            while x - out[-1][0] > 180:
                x -= 360
            while x - out[-1][0] < -180:
                x += 360
        out.append((x, p[1]))
    return out


def segment_distance_sq(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2


def simplify_line(points, tolerance=0.025):
    if len(points) <= 2:
        return points
    coords = unwrapped(points)
    # Retain local vertices exactly; they become endpoints for the coarse runs.
    keep = {0, len(points) - 1} | {i for i, p in enumerate(points) if near_princeton(p)}
    anchors = sorted(keep)
    stack = list(zip(anchors, anchors[1:]))
    tol_sq = tolerance * tolerance
    while stack:
        first, last = stack.pop()
        far, far_sq = first, tol_sq
        for i in range(first + 1, last):
            d = segment_distance_sq(coords[i], coords[first], coords[last])
            if d > far_sq:
                far, far_sq = i, d
        if far != first:
            keep.add(far)
            stack.extend(((first, far), (far, last)))
    return [points[i] for i in sorted(keep)]


def simplify_ring(points, tolerance=0.025):
    if not points:
        return points
    ring = points if points[0] == points[-1] else points + [points[0]]
    if len(ring) <= 4:
        return ring
    # Split a closed ring into two open arcs so identical endpoints cannot
    # collapse it. Retain small islands/holes if simplification leaves <3 corners.
    coords = unwrapped(ring)
    split = max(range(1, len(ring) - 1), key=lambda i: (coords[i][0] - coords[0][0]) ** 2 + (coords[i][1] - coords[0][1]) ** 2)
    result = simplify_line(ring[:split + 1], tolerance)[:-1] + simplify_line(ring[split:], tolerance)
    if len({tuple(p) for p in result[:-1]}) < 3:
        return ring
    return result if result[0] == result[-1] else result + [result[0]]


def simplify_geometry(geometry, tolerance=0.025):
    kind, coords = geometry['type'], geometry['coordinates']
    if kind == 'Polygon':
        output = [simplify_ring(r, tolerance) for r in coords]
    elif kind == 'MultiPolygon':
        output = [[simplify_ring(r, tolerance) for r in poly] for poly in coords]
    elif kind == 'LineString':
        output = simplify_line(coords, tolerance)
    elif kind == 'MultiLineString':
        output = [simplify_line(r, tolerance) for r in coords]
    else:
        raise ValueError(f'Unsupported geometry: {kind}')
    return {**geometry, 'coordinates': output}


def building_labels(collection):
    labels = []
    for f in collection['features']:
        props, geom = f.get('properties', {}), f['geometry']
        if not props.get('n') or geom['type'] not in ('Polygon', 'MultiPolygon'):
            continue
        ring = geom['coordinates'][0] if geom['type'] == 'Polygon' else geom['coordinates'][0][0]
        if not ring:
            continue
        # Preserve the previous in-browser label position, now precomputed.
        pos = [round(sum(p[k] for p in ring) / len(ring), 6) for k in (0, 1)]
        labels.append({'label': props['n'], 'pos': pos, 'zoom': 17, 'h': props.get('h') or 8})
    return labels


def generate(data_dir, tolerance=0.025):
    buildings = json.loads((data_dir / 'buildings.json').read_text())
    land = json.loads((data_dir / 'land.json').read_text())
    outputs = {
        'building-labels.json': building_labels(buildings),
        'intro-land.json': {**land, 'features': [{**f, 'geometry': simplify_geometry(f['geometry'], tolerance)} for f in land['features']]},
    }
    for name, value in outputs.items():
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'
        (data_dir / name).write_text(encoded)
        print(f'{name}: {len(encoded.encode()):,} bytes')
    return outputs


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'public' / 'data')
    parser.add_argument('--tolerance', type=float, default=0.025)
    args = parser.parse_args()
    if args.tolerance <= 0:
        parser.error('--tolerance must be positive')
    generate(args.data_dir, args.tolerance)
