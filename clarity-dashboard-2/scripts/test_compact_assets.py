import json
import unittest
from pathlib import Path
import compact_assets as compact

DATA = Path(__file__).resolve().parents[1] / 'public' / 'data'


def lines(geometry):
    c, kind = geometry['coordinates'], geometry['type']
    if kind in ('LineString',):
        return [c]
    if kind in ('Polygon', 'MultiLineString'):
        return c
    return [ring for polygon in c for ring in polygon]


class CompactAssetTests(unittest.TestCase):
    def test_labels_retain_all_named_buildings_in_a_small_point_index(self):
        buildings = json.loads((DATA / 'buildings.json').read_text())
        labels = json.loads((DATA / 'building-labels.json').read_text())
        self.assertEqual(labels, compact.building_labels(buildings))
        self.assertEqual(len(labels), 802)
        self.assertLess((DATA / 'building-labels.json').stat().st_size, 70000)
        self.assertTrue(all(len(label['pos']) == 2 and label['label'] for label in labels))

    def test_land_preserves_features_closed_rings_and_every_local_vertex(self):
        full = json.loads((DATA / 'land.json').read_text())
        small = json.loads((DATA / 'intro-land.json').read_text())
        self.assertEqual(len(full['features']), len(small['features']))
        original_points = 0
        simplified_points = 0
        for before, after in zip(full['features'], small['features']):
            self.assertEqual(before['properties'], after['properties'])
            self.assertEqual(before['geometry']['type'], after['geometry']['type'])
            for old, new in zip(lines(before['geometry']), lines(after['geometry'])):
                original_points += len(old)
                simplified_points += len(new)
                self.assertTrue({tuple(p) for p in old if compact.near_princeton(p)} <= {tuple(p) for p in new})
                if before['geometry']['type'] in ('Polygon', 'MultiPolygon'):
                    self.assertEqual(new[0], new[-1])
                    self.assertGreaterEqual(len(set(map(tuple, new[:-1]))), 3)
        self.assertLess(simplified_points, original_points * 0.5)

    def test_small_and_antimeridian_rings_remain_closed(self):
        for ring in (
            [[0, 0], [.001, 0], [.001, .001], [0, .001], [0, 0]],
            [[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]],
        ):
            out = compact.simplify_ring(ring)
            self.assertEqual(out[0], out[-1])
            self.assertGreaterEqual(len(set(map(tuple, out[:-1]))), 3)


if __name__ == '__main__':
    unittest.main()
