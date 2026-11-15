// Generated facade textures for building walls: window grids, floor lines, doors and shop fronts.
// Names match basemap.js facadePattern(): fac-{theme}-{house|mid|tower}-{0..7}.
import { WALL_SETS } from './basemap.js';

const GLASS = { g: '#5d7f93', l: '#9fb3c2', d: '#5A9BBD', s: '#7c8a96' };
const FRAME = { g: '#f4ede0', l: '#ffffff', d: '#0B2027', s: '#e8eaec' };
const DOOR = { g: '#6b4a34', l: '#717580', d: '#0B2027', s: '#5c5f66' };
const LIT = '#f3d27a';

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * f))));
  return `rgb(${c.join(',')})`;
}

// Each tile is one bay wide. Floors are 32 px apart (about 3.4 m), so windows line up with real floor heights.
function draw(kind, theme, wall, seed) {
  const W = 32, F = 32, floors = kind === 'house' ? 2 : 4;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = F * floors;
  const g = cv.getContext('2d');
  const rnd = (i) => ((Math.sin((seed + 1) * 97.13 + i * 13.7) * 43758.5) % 1 + 1) % 1;
  g.fillStyle = wall; g.fillRect(0, 0, W, F * floors);
  // Rows are drawn top-down, the last row is the ground floor.
  for (let f = 0; f < floors; f++) {
    const y0 = f * F, ground = f === floors - 1;
    if (kind === 'tower') {
      // Curtain wall: big glass panes with mullions and a spandrel band.
      g.fillStyle = shade(GLASS[theme], 0.9 + rnd(f) * 0.25); g.fillRect(2, y0 + 5, W - 4, F - 8);
      g.fillStyle = shade(wall, 0.85); g.fillRect(0, y0, W, 5);
      g.fillStyle = FRAME[theme]; g.fillRect(W / 2 - 1, y0 + 5, 2, F - 8);
      if (rnd(f + 9) > 0.7) { g.fillStyle = LIT; g.globalAlpha = 0.55; g.fillRect(3, y0 + 6, W / 2 - 5, F - 10); g.globalAlpha = 1; }
      continue;
    }
    // Floor line / cornice.
    g.fillStyle = shade(wall, 0.82); g.fillRect(0, y0, W, 2);
    if (ground && (kind === 'house' ? rnd(3) > 0.45 : rnd(4) > 0.35)) {
      if (kind === 'mid') {
        // Shop front: wide glass with a door and an awning.
        g.fillStyle = shade(GLASS[theme], 1.1); g.fillRect(2, y0 + 10, W - 4, F - 10);
        g.fillStyle = DOOR[theme]; g.fillRect(W - 12, y0 + 12, 8, F - 12);
        g.fillStyle = ['#5A9BBD', '#c97b5a', '#717580', '#8aa36a'][Math.floor(rnd(5) * 4)]; g.fillRect(0, y0 + 5, W, 5);
      } else {
        // Front door with a frame and a step.
        g.fillStyle = FRAME[theme]; g.fillRect(9, y0 + 9, 14, F - 9);
        g.fillStyle = DOOR[theme]; g.fillRect(11, y0 + 11, 10, F - 11);
        g.fillStyle = '#e7c46a'; g.fillRect(18, y0 + 21, 2, 2);
      }
      continue;
    }
    // Windows: frame, glass, cross bar, sill; some lit.
    const ww = kind === 'house' ? 14 : 16, wh = 16, x = (W - ww) / 2, y = y0 + 8;
    g.fillStyle = FRAME[theme]; g.fillRect(x - 2, y - 2, ww + 4, wh + 4);
    g.fillStyle = rnd(f * 3 + 1) > 0.82 ? LIT : GLASS[theme]; g.fillRect(x, y, ww, wh);
    g.fillStyle = FRAME[theme]; g.fillRect(x + ww / 2 - 1, y, 2, wh); g.fillRect(x, y + wh / 2 - 1, ww, 2);
    g.fillStyle = shade(wall, 0.7); g.fillRect(x - 3, y + wh + 2, ww + 6, 2);
    if (kind === 'house' && theme === 'g') { g.fillStyle = '#4f6f5a'; g.fillRect(x - 6, y - 2, 3, wh + 4); g.fillRect(x + ww + 3, y - 2, 3, wh + 4); }
  }
  return g.getImageData(0, 0, cv.width, cv.height);
}

const cache = new Map();
export function facadeImage(name) {
  const m = /^fac-([glds])-(house|mid|tower)-(\d)$/.exec(name);
  if (!m) return null;
  if (!cache.has(name)) cache.set(name, draw(m[2], m[1], WALL_SETS[m[1]][+m[3]], +m[3]));
  return cache.get(name);
}

// Register every facade texture up front (96 small images), and fill any gap on demand.
export function installFacades(map) {
  const add = id => {
    try {
      const img = facadeImage(id);
      if (img && !map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
    } catch (e) { console.warn('[facades]', id, e); }
  };
  const all = () => { for (const t of 'glds') for (const k of ['house', 'mid', 'tower']) for (let i = 0; i < 8; i++) add(`fac-${t}-${k}-${i}`); };
  map.on('style.load', all);
  map.on('styleimagemissing', e => add(e.id));
}
