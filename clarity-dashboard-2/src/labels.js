// Keeps map labels from overlapping. Each render, labels are placed in priority order
// (highest first); a label whose screen box hits one already placed is hidden.
// Boxes are estimated from the text length and font size, in screen pixels.

export function makePlacer(map) {
  const placed = [];
  const hits = b => placed.some(p => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  // items: array; opts: pos(d) -> [lon, lat], text(d), size (px or fn), priority(d), dy (px or fn, + is down),
  // anchor: 'bottom' (text sits above the point), 'top' (below) or 'center'.
  return function place(items, { pos, text, size = 12, priority = () => 0, dy = 0, anchor = 'center', pad = 4 }) {
    const W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight;
    const ranked = items.map((d, i) => ({ d, i, p: priority(d) })).sort((a, b) => b.p - a.p || a.i - b.i);
    const keep = [];
    for (const { d } of ranked) {
      const pt = map.project(pos(d));
      if (pt.x < -200 || pt.y < -200 || pt.x > W + 200 || pt.y > H + 200) continue;
      const fs = typeof size === 'function' ? size(d) : size;
      const lines = String(text(d)).split('\n');
      const w = Math.max(...lines.map(l => l.length)) * fs * 0.58 + pad * 2;
      const h = lines.length * fs * 1.2 + pad * 2;
      const y = pt.y + (typeof dy === 'function' ? dy(d) : dy);
      const y0 = anchor === 'bottom' ? y - h : anchor === 'top' ? y : y - h / 2;
      const box = { x0: pt.x - w / 2, x1: pt.x + w / 2, y0, y1: y0 + h };
      if (hits(box)) continue;
      placed.push(box);
      keep.push(d);
    }
    return keep;
  };
}
