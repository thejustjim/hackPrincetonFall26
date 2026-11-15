/* The before and after glasses in the full account ("The latest pour"), in 3D.

   The same glass as the hero's, made by the same materials and the same reading-to-water rule
   (glass.js), without the pipette, the drops or the filter: two glasses standing side by side,
   turning slowly, one holding the water as it was poured and one as it came back from the filter.
   They are drawn in one canvas laid over the two flat cups the page already has, which stay in
   the page (hidden) to hold the layout, and come back if WebGL or this module fails.

   window.TapPlate = { set({ before, after }) } once mounted. `after` null draws clear water (through
   the filter, the retest not in yet), and `after` undefined draws no second glass (no filter was used).
   demo-view.js keeps the latest state in window.TapPlateState, for when this loads after it. */
import * as THREE from "three";
import { RoomEnvironment } from "../vendor/three/RoomEnvironment.js";
import { C, lookFor, glassMaterial, waterMaterial } from "./glass.js?v=20261115-clear-shift";

const H = 1.7, RT = 0.66, RB = 0.52, WALL = 0.035, BASE = 0.14, LEVEL = 1.2, INSET = 0.006, SPECKS = 200;
const rOut = (y) => RB + (RT - RB) * (y / H);
const rIn = (y) => rOut(y) - WALL;
const lathe = (pts) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 96);
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

const glassGeo = lathe([[0.001, 0], [RB - 0.03, 0], [RB, 0.03], [RT, H], [RT - WALL / 2, H + 0.014], [rIn(H), H],
                        [rIn(BASE), BASE + 0.02], [rIn(BASE) - 0.03, BASE], [0.001, BASE]]);
const bodyGeo = lathe([[0.001, BASE + INSET], [rIn(BASE) - INSET, BASE + INSET], [rIn(LEVEL) - INSET, LEVEL]]);
const R_SURF = rIn(LEVEL) - INSET;
const surfGeo = new THREE.CircleGeometry(R_SURF, 96).rotateX(-Math.PI / 2);

function softDot() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* One glass and its water. show(reading) eases the water to that reading's look. */
function makeCup(dot) {
  const group = new THREE.Group(), turning = new THREE.Group();
  const glass = new THREE.Mesh(glassGeo, glassMaterial());
  glass.renderOrder = 4;
  const waterMat = waterMaterial();
  const body = new THREE.Mesh(bodyGeo, waterMat);
  body.renderOrder = 1;
  const surfMat = new THREE.MeshPhysicalMaterial({ color: C.blue.clone(), roughness: 0.16, metalness: 0, transparent: true, opacity: 0.45,
    envMapIntensity: 1.0, clearcoat: 0.6, clearcoatRoughness: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const surface = new THREE.Mesh(surfGeo, surfMat);
  surface.position.y = LEVEL;
  surface.renderOrder = 2;
  const ring = [];
  for (let k = 0; k < 96; k++) { const a = (k / 96) * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a) * R_SURF, LEVEL + 0.003, Math.sin(a) * R_SURF)); }
  const meniscus = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring),
    new THREE.LineBasicMaterial({ color: 0xf7f0f0, transparent: true, opacity: 0.34, depthWrite: false }));
  meniscus.renderOrder = 3;

  // dissolved solids: specks that hang in the water, and settle as it gets cleaner
  const at = new Float32Array(SPECKS * 3), seeds = [];
  for (let i = 0; i < SPECKS; i++) {
    const y = BASE + 0.05 + Math.random() * (LEVEL - BASE - 0.1);
    seeds.push({ y, r: Math.sqrt(Math.random()) * (rIn(y) - 0.06), a: Math.random() * Math.PI * 2, w: 0.08 + Math.random() * 0.25, sink: 0.3 + Math.random() * 0.7 });
  }
  const speckGeo = new THREE.BufferGeometry();
  speckGeo.setAttribute("position", new THREE.BufferAttribute(at, 3));
  const speckMat = new THREE.PointsMaterial({ color: C.speck, size: 0.064, map: dot, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  const specks = new THREE.Points(speckGeo, speckMat);
  specks.renderOrder = 3;
  specks.frustumCulled = false;

  // etched marks, so the slow turn can be seen
  const markMat = new THREE.LineBasicMaterial({ color: 0xf7f0f0, transparent: true, opacity: 0.38, depthWrite: false });
  for (let i = 0; i < 6; i++) {
    const y = 0.42 + i * 0.2, r = rOut(y) + 0.004, half = i % 2 ? 0.1 : 0.19, pts = [];
    for (let k = 0; k <= 12; k++) { const a = -half + (2 * half * k) / 12; pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r)); }
    const mark = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), markMat);
    mark.renderOrder = 5;
    turning.add(mark);
  }
  turning.add(specks);
  group.add(glass, body, surface, meniscus, turning);

  const cur = lookFor(null);
  let target = lookFor(null), filled = false;
  return {
    group,
    show(reading, immediate) {
      group.visible = reading !== undefined;
      filled = reading !== undefined;                       // no reading yet (the retest is awaited): clear water, as through the filter
      body.visible = surface.visible = meniscus.visible = specks.visible = filled;
      if (!filled) return;
      target = lookFor(reading || null);
      if (immediate || still) Object.assign(cur, { ...target, color: target.color.clone() });
    },
    frame(dt, t) {
      if (!group.visible) return;
      turning.rotation.y = still ? 0.5 : t * 0.14;
      if (!filled) return;
      const k = 1 - Math.exp(-dt / 0.9);
      cur.color.lerp(target.color, k);
      for (const key of ["body", "surf", "speck", "sink"]) cur[key] += (target[key] - cur[key]) * k;
      waterMat.color.copy(cur.color);
      waterMat.emissive.copy(cur.color).multiplyScalar(0.3);          // a touch brighter than the hero's: these are small
      waterMat.opacity = cur.body;
      surfMat.color.copy(cur.color).lerp(C.shell, 0.06);
      surfMat.opacity = cur.surf;
      speckMat.opacity = cur.speck;
      for (let i = 0; i < SPECKS; i++) {
        const s = seeds[i], a = s.a + t * s.w * (still ? 0 : 0.35);
        at[i * 3] = Math.cos(a) * s.r;
        at[i * 3 + 1] = Math.max(BASE + 0.03, s.y - cur.sink * s.sink * (s.y - BASE)) + (still ? 0 : Math.sin(t * 0.8 + s.a) * 0.01);
        at[i * 3 + 2] = Math.sin(a) * s.r;
      }
      speckGeo.attributes.position.needsUpdate = true;
    },
  };
}

function mount(plate) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const host = document.createElement("div");
  host.className = "plate3d";
  host.setAttribute("aria-hidden", "true");
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-2.5, 4, 3);
  scene.add(key);
  const rim = new THREE.PointLight(0x5a9bbd, 6, 10);
  rim.position.set(2.2, 1.6, -1.8);
  scene.add(rim);
  const FOV = 22, camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
  const dot = softDot(), cups = [makeCup(dot), makeCup(dot)];
  cups.forEach((c) => scene.add(c.group));

  let state = null, shown = false;
  /* Put each glass where its flat cup is: same centre, same height, in the same row. */
  function layout() {
    const flat = [...plate.querySelectorAll(".pair .cup")];
    const pair = plate.querySelector(".pair");
    host.hidden = !state || !pair || !flat.length;
    if (host.hidden) return;
    if (host.parentNode !== plate) plate.prepend(host);          // the page rewrites the plate; the canvas goes back in
    const box = plate.getBoundingClientRect(), row = pair.getBoundingClientRect();
    const top = row.top - box.top - 26, height = row.height + 78, width = box.width;      // room above for the rims and below for the bases
    Object.assign(host.style, { top: `${top}px`, height: `${height}px` });
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const rects = flat.map((el) => el.getBoundingClientRect());
    const tall = Math.max(...rects.map((r) => r.height));
    if (!tall) return;
    const span = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2));                 // world height seen per unit of distance
    const distance = (H * 1.0 * height) / (span * tall), perPx = (span * distance) / height;
    const middle = rects[0].top + rects[0].height / 2 - (row.top - 26) - height / 2;   // px the cups sit below the canvas's middle
    const aim = H / 2 + (middle + 10) * perPx;                                   // a little high, so the base clears the labels
    camera.position.set(0, aim + 0.62, distance);
    camera.lookAt(0, aim, 0);
    camera.updateProjectionMatrix();
    rects.forEach((r, i) => { cups[i].group.position.x = (r.left + r.width / 2 - box.left - width / 2) * perPx; });
    if (rects.length < 2) cups[1].group.position.x = 1e3;
    if (still) render(0);
  }
  let t = 0, last = performance.now(), raf = 0, seen = false;
  function render(dt) {
    t += dt;
    cups.forEach((c) => c.frame(dt, t));
    renderer.render(scene, camera);
  }
  const loop = (now) => { render(Math.min(0.05, (now - last) / 1000)); last = now; raf = requestAnimationFrame(loop); };
  function sync() {                                          // draw only while the plate is on screen and the tab is showing
    const run = seen && shown && !document.hidden && !still;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
    if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  new IntersectionObserver((entries) => { seen = entries.some((e) => e.isIntersecting); sync(); }, { rootMargin: "120px" }).observe(plate);
  document.addEventListener("visibilitychange", sync);
  if (window.ResizeObserver) new ResizeObserver(() => layout()).observe(plate);

  function set(next) {
    const first = !state;
    state = next || null;
    shown = !!state;
    if (state) {
      cups[0].show(state.before, first);
      cups[1].show(state.after, first || !state.after);
    }
    layout();
    sync();
    if (state) render(0);
  }
  return { set, layout };
}

const plate = document.getElementById("plate");
if (plate) {
  try {
    window.TapPlate = mount(plate);
    plate.classList.add("has-3d");
    window.TapPlate.set(window.TapPlateState);
  } catch (err) {
    console.warn("3D plate off:", err);
  }
}
