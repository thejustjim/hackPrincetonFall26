// A real-scale water tank, built as triangle meshes for deck.gl's SimpleMeshLayer.
// Units are meters, z is up. Sized like a small municipal / building storage tank.

export const TANK = { r: 6, plinth: 0.6, body: 10, roof: 2.4 }; // radius, plinth height, wall height, roof rise
const SEG = 40;

function push(out, p, n) { out.positions.push(...p); out.normals.push(...n); }

function wall(out, r, z0, z1) {
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
    const p = a => [Math.cos(a) * r, Math.sin(a) * r];
    const n = a => [Math.cos(a), Math.sin(a), 0];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    push(out, [x0, y0, z0], n(a0)); push(out, [x1, y1, z0], n(a1)); push(out, [x1, y1, z1], n(a1));
    push(out, [x0, y0, z0], n(a0)); push(out, [x1, y1, z1], n(a1)); push(out, [x0, y0, z1], n(a0));
  }
}

function disk(out, r, z, up = true) {
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
    const n = [0, 0, up ? 1 : -1];
    const p0 = [Math.cos(a0) * r, Math.sin(a0) * r, z], p1 = [Math.cos(a1) * r, Math.sin(a1) * r, z];
    if (up) { push(out, [0, 0, z], n); push(out, p0, n); push(out, p1, n); } else { push(out, [0, 0, z], n); push(out, p1, n); push(out, p0, n); }
  }
}

function cone(out, r, z0, z1) {
  const slope = r / (z1 - z0);
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2, am = (a0 + a1) / 2;
    const n = a => { const v = [Math.cos(a), Math.sin(a), slope]; const l = Math.hypot(...v); return v.map(x => x / l); };
    push(out, [Math.cos(a0) * r, Math.sin(a0) * r, z0], n(a0));
    push(out, [Math.cos(a1) * r, Math.sin(a1) * r, z0], n(a1));
    push(out, [0, 0, z1], n(am));
  }
}

function mesh(build) {
  const out = { positions: [], normals: [] };
  build(out);
  return {
    positions: { size: 3, value: new Float32Array(out.positions) },
    normals: { size: 3, value: new Float32Array(out.normals) },
  };
}

const { r, plinth, body, roof } = TANK;
const top = plinth + body;

// Opaque parts: concrete pad, bottom and top rims, conical roof, roof vent, and a ladder cage.
export const tankSolid = mesh(o => {
  wall(o, r * 1.15, 0, plinth); disk(o, r * 1.15, plinth);
  wall(o, r * 1.02, plinth, plinth + 0.5);
  wall(o, r * 1.03, top - 0.45, top); disk(o, r * 1.03, top - 0.45, false);
  cone(o, r * 1.03, top, top + roof);
  wall(o, 0.45, top + roof - 0.2, top + roof + 0.6); disk(o, 0.45, top + roof + 0.6);
  // ladder rails on the side facing south-east
  for (const dx of [-0.35, 0.35]) {
    const ladder = { positions: [], normals: [] };
    wall(ladder, 0.06, plinth, top + 0.8);
    for (let i = 0; i < ladder.positions.length; i += 3) {
      o.positions.push(ladder.positions[i] + r * 0.72 + dx, ladder.positions[i + 1] - r * 0.72 + dx, ladder.positions[i + 2]);
      o.normals.push(ladder.normals[i], ladder.normals[i + 1], ladder.normals[i + 2]);
    }
  }
});

// Translucent wall, so the water level inside reads from any angle.
export const tankGlass = mesh(o => wall(o, r, plinth + 0.5, top - 0.45));

// Meters per pixel at a zoom (MapLibre 512px tiles).
export const metersPerPixel = (zoom, lat) => (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
