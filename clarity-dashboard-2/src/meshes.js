// Small low-poly meshes for the game-style map (meters, z up).
const SEG = 10;

function out() { return { positions: [], normals: [] }; }
function push(o, p, n) { o.positions.push(...p); o.normals.push(...n); }
function wall(o, r, z0, z1, seg = SEG, cx = 0, cy = 0) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const n = a => [Math.cos(a), Math.sin(a), 0];
    const p = (a, z) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
    push(o, p(a0, z0), n(a0)); push(o, p(a1, z0), n(a1)); push(o, p(a1, z1), n(a1));
    push(o, p(a0, z0), n(a0)); push(o, p(a1, z1), n(a1)); push(o, p(a0, z1), n(a0));
  }
}
function cone(o, r, z0, z1, seg = SEG) {
  const s = r / (z1 - z0);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
    const n = a => { const v = [Math.cos(a), Math.sin(a), s]; const l = Math.hypot(...v); return v.map(x => x / l); };
    push(o, [Math.cos(a0) * r, Math.sin(a0) * r, z0], n(a0)); push(o, [Math.cos(a1) * r, Math.sin(a1) * r, z0], n(a1)); push(o, [0, 0, z1], n(am));
  }
}
function disk(o, r, z, seg = SEG) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    push(o, [0, 0, z], [0, 0, 1]); push(o, [Math.cos(a0) * r, Math.sin(a0) * r, z], [0, 0, 1]); push(o, [Math.cos(a1) * r, Math.sin(a1) * r, z], [0, 0, 1]);
  }
}
// Rounded canopy: an octahedron-ish blob from stacked cones.
function blob(o, r, zc, seg = 8) {
  cone(o, r, zc, zc + r * 1.05, seg);
  const lower = out(); cone(lower, r, zc, zc - r * 0.8, seg);
  for (let i = 0; i < lower.positions.length; i += 9) {
    // flip winding for the downward cone
    o.positions.push(...lower.positions.slice(i + 3, i + 6), ...lower.positions.slice(i, i + 3), ...lower.positions.slice(i + 6, i + 9));
    o.normals.push(...lower.normals.slice(i + 3, i + 6).map((v, k) => (k === 2 ? -Math.abs(v) : v)),
      ...lower.normals.slice(i, i + 3).map((v, k) => (k === 2 ? -Math.abs(v) : v)),
      ...lower.normals.slice(i + 6, i + 9).map((v, k) => (k === 2 ? -Math.abs(v) : v)));
  }
}
function pack(o) {
  return { positions: { size: 3, value: new Float32Array(o.positions) }, normals: { size: 3, value: new Float32Array(o.normals) } };
}

// Deciduous tree ~9 m: trunk + round canopy. Trunk and canopy are separate so they can be colored.
export const treeTrunk = (() => { const o = out(); wall(o, 0.5, 0, 4.5, 6); return pack(o); })();
export const treeCanopy = (() => { const o = out(); blob(o, 4.2, 8.2); return pack(o); })();

// Classic water tower ~38 m: column, bowl and conical cap.
export const towerMesh = (() => {
  const o = out();
  wall(o, 2.2, 0, 26, 12);
  wall(o, 8, 26, 34, 16); disk(o, 8, 26, 16);
  cone(o, 8.3, 34, 38, 16);
  return pack(o);
})();

// Fire hydrant ~0.9 m.
export const hydrantMesh = (() => { const o = out(); wall(o, 0.2, 0, 0.75, 8); cone(o, 0.24, 0.75, 0.95, 8); return pack(o); })();
