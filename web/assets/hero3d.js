/* The hero: one glass of water in three.js that shows the latest reading.
   Dissolved solids show as an amber tint and drifting specks, cloudiness as a tea-brown murk.
   When a new reading arrives the water eases to its new look over a few seconds. A pipette
   hangs above the glass: a drop gathers at its tip every few seconds, falls, and lands with
   a small ripple. The glass turns slowly (its etched marks and the reflections travel), leans
   slightly toward the pointer, and stands on a dark surface that faintly reflects it.

   window.TapHero = { setWater(reading), drip(strength), setRunning(bool) } once mounted, and
   the page gets a "hero3d:ready" event. If WebGL or the module fails, the page keeps its
   SVG cup. */
import * as THREE from "three";
import { RoomEnvironment } from "../vendor/three/RoomEnvironment.js";

const C = {
  blue: new THREE.Color(0x5a9bbd),
  shell: new THREE.Color(0xf7f0f0),
  murk: new THREE.Color(0x6b4520),      // tea
  amber: new THREE.Color(0x8c7a3c),
  speck: new THREE.Color(0xe2be5e),
};
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* reading -> how the water should look */
function lookFor(r) {
  if (!r) return { color: C.blue.clone(), body: 0.24, surf: 0.42, speck: 0, sink: 1 };
  const mineral = clamp((r.tds - 60) / 740, 0, 1);
  const murk = clamp(Math.pow(1 - clamp(r.clarity, 0, 1), 1.3) * 1.5, 0, 1);
  return {
    color: C.blue.clone().lerp(C.amber, mineral * 0.4).lerp(C.murk, clamp(murk * 1.4, 0, 1)),
    body: clamp(0.24 + 0.22 * mineral + 0.5 * murk, 0, 0.82),
    surf: clamp(0.42 + 0.2 * mineral + 0.4 * murk, 0, 0.88),
    speck: 0.9 * mineral,
    sink: 1 - mineral,
  };
}

/* World height of the fragment, for fading the reflection as it gets further below the surface. */
const WORLD_Y = "(inverse(viewMatrix) * vec4(-vViewPosition, 1.0)).y";

/* Glass: no body colour, nearly invisible face-on and reflective at grazing angles (Fresnel),
   with highlights that stay bright. `reflection` makes the dimmer copy seen in the surface. */
function glassMaterial(reflection = false) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x000000, roughness: 0.02, metalness: 0, transparent: true, opacity: 1,
    clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.3, side: THREE.DoubleSide, depthWrite: false,
  });
  const fade = reflection ? `* 0.34 * smoothstep(-1.15, -0.02, ${WORLD_Y})` : "";
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        float fresnel = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.6);
        diffuseColor.a = mix(0.02, 0.5, fresnel);`)
      .replace("#include <opaque_fragment>", `
        float hi = clamp(max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b) - 0.6, 0.0, 1.0);
        gl_FragColor = vec4(outgoingLight, clamp(diffuseColor.a + hi * 1.4, 0.0, 1.0) ${fade});`);
  };
  m.customProgramCacheKey = () => (reflection ? "glass-reflection" : "glass");
  return m;
}

/* Water: a little more opaque toward its edges, so it reads as a volume rather than a sticker. */
function waterMaterial(reflection = false) {
  const m = new THREE.MeshPhysicalMaterial({
    color: C.blue.clone(), roughness: 0.2, metalness: 0, transparent: true, opacity: 0.3,
    envMapIntensity: 0.25, side: THREE.FrontSide, depthWrite: false,
  });
  const fade = reflection ? `* 0.4 * smoothstep(-1.0, -0.05, ${WORLD_Y})` : "";
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
      float rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);
      diffuseColor.a = clamp(diffuseColor.a * (0.72 + 1.15 * rim) ${fade}, 0.0, 1.0);`);
  };
  m.customProgramCacheKey = () => (reflection ? "water-reflection" : "water");
  return m;
}

function mount(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = "hero3d-canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

  // Framing: the cup sits a little below centre with headroom for the pipette and the drop.
  // orbit.js relies on this (cup top ~34% and bottom ~76% of the canvas height).
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
  camera.position.set(0, 1.9, 8.6);
  camera.lookAt(0, 1.05, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-2.5, 4, 3);
  scene.add(key);
  const rim = new THREE.PointLight(0x5a9bbd, 6, 8);
  rim.position.set(1.8, 1.6, -1.6);
  scene.add(rim);

  // ---------------------------------------------------------------- the glass (a lathe with a real wall)
  const H = 1.7, RT = 0.66, RB = 0.52, WALL = 0.035, BASE = 0.14;
  const rOut = (y) => RB + (RT - RB) * (y / H);
  const rIn = (y) => rOut(y) - WALL;
  const profile = [
    [0.001, 0], [RB - 0.03, 0], [RB, 0.03], [RT, H], [RT - WALL / 2, H + 0.014], [rIn(H), H],
    [rIn(BASE), BASE + 0.02], [rIn(BASE) - 0.03, BASE], [0.001, BASE],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const glassGeo = new THREE.LatheGeometry(profile, 128);
  const glass = new THREE.Mesh(glassGeo, glassMaterial());
  glass.renderOrder = 4;

  // ---------------------------------------------------------------- the water
  const LEVEL = 1.2, inset = 0.006;
  const waterProfile = [[0.001, BASE + inset], [rIn(BASE) - inset, BASE + inset], [rIn(LEVEL) - inset, LEVEL]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const bodyGeo = new THREE.LatheGeometry(waterProfile, 128);
  const waterMat = waterMaterial();
  const body = new THREE.Mesh(bodyGeo, waterMat);
  body.renderOrder = 1;

  const R_SURF = rIn(LEVEL) - inset;
  const surfGeo = new THREE.RingGeometry(0.0005, R_SURF, 128, 32);
  surfGeo.rotateX(-Math.PI / 2);
  const surfMat = new THREE.MeshPhysicalMaterial({
    color: C.blue.clone(), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.45,
    envMapIntensity: 1.1, clearcoat: 1, clearcoatRoughness: 0.03, side: THREE.DoubleSide, depthWrite: false,
  });
  const surface = new THREE.Mesh(surfGeo, surfMat);
  surface.position.y = LEVEL;
  surface.renderOrder = 2;
  const pos = surfGeo.attributes.position;
  const base = Float32Array.from(pos.array);

  // the meniscus: a fine bright line where the water meets the glass
  const ringPts = [];
  for (let k = 0; k < 128; k++) { const a = (k / 128) * Math.PI * 2; ringPts.push(new THREE.Vector3(Math.cos(a) * R_SURF, LEVEL + 0.003, Math.sin(a) * R_SURF)); }
  const meniscus = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts),
    new THREE.LineBasicMaterial({ color: 0xf7f0f0, transparent: true, opacity: 0.34, depthWrite: false }));
  meniscus.renderOrder = 3;

  // ---------------------------------------------------------------- dissolved solids
  const N = 320;
  const specks = new Float32Array(N * 3);
  const seeds = [];
  for (let i = 0; i < N; i++) {
    const y = BASE + 0.05 + Math.random() * (LEVEL - BASE - 0.1);
    seeds.push({ y, r: Math.sqrt(Math.random()) * (rIn(y) - 0.06), a: Math.random() * Math.PI * 2,
                 w: 0.08 + Math.random() * 0.25, sink: 0.3 + Math.random() * 0.7 });
  }
  const speckGeo = new THREE.BufferGeometry();
  speckGeo.setAttribute("position", new THREE.BufferAttribute(specks, 3));
  const speckMat = new THREE.PointsMaterial({ color: C.speck, size: 0.03, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  const speckPts = new THREE.Points(speckGeo, speckMat);
  speckPts.renderOrder = 3;

  // ---------------------------------------------------------------- etched graduation marks (they make the turn visible)
  const marks = new THREE.Group();
  const markMat = new THREE.LineBasicMaterial({ color: 0xf7f0f0, transparent: true, opacity: 0.38, depthWrite: false });
  for (let i = 0; i < 6; i++) {
    const y = 0.42 + i * 0.2, r = rOut(y) + 0.004, half = i % 2 ? 0.1 : 0.19;      // long and short ticks
    const pts = [];
    for (let k = 0; k <= 12; k++) { const a = -half + (2 * half * k) / 12; pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r)); }
    marks.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), markMat));
  }
  marks.renderOrder = 5;

  // ---------------------------------------------------------------- the pipette and its drop
  const TIP = 2.34;                                   // world height of the pipette's tip
  const pipette = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 2.6, 40, 1, true), glassMaterial());
  tube.position.y = TIP + 0.3 + 1.3;
  const taper = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.017, 0.3, 40, 1, true), glassMaterial());
  taper.position.y = TIP + 0.15;
  // the water standing in the pipette
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 2.2, 24),
    new THREE.MeshBasicMaterial({ color: 0x5a9bbd, transparent: true, opacity: 0.2, depthWrite: false }));
  column.position.y = TIP + 0.34 + 1.1;
  pipette.add(column, tube, taper);
  pipette.renderOrder = 6;

  const dropMat = new THREE.MeshPhysicalMaterial({
    color: 0xdcecf5, emissive: 0x5a9bbd, emissiveIntensity: 0.6, roughness: 0.05, metalness: 0,
    transparent: true, opacity: 0, envMapIntensity: 1.2, depthWrite: false,
  });
  const dropMesh = new THREE.Mesh(new THREE.SphereGeometry(0.04, 28, 20), dropMat);
  dropMesh.renderOrder = 7;
  dropMesh.visible = false;
  const GRAVITY = 4.0, GATHER = 1.5;                  // slow motion: gathers for 1.5 s, falls for about 0.7 s
  const drop = { state: "idle", t: 0, y: 0, v: 0, x: 0, z: 0, strength: 1 };
  let nextDrip = performance.now() + 1600;

  // ---------------------------------------------------------------- the surface: contact shadow + faint reflection
  const sh = document.createElement("canvas");
  sh.width = sh.height = 128;
  const g = sh.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.002;
  shadow.renderOrder = 0;

  const spin = new THREE.Group();                    // turns slowly: only the specks and marks need to, the rest is round
  spin.add(speckPts, marks);
  const cup = new THREE.Group();                     // leans toward the pointer
  cup.add(body, surface, meniscus, glass, spin);

  const waterMatR = waterMaterial(true);
  const cupR = new THREE.Group();
  const bodyR = new THREE.Mesh(bodyGeo, waterMatR);
  const glassR = new THREE.Mesh(glassGeo, glassMaterial(true));
  bodyR.renderOrder = -2; glassR.renderOrder = -1;
  cupR.add(bodyR, glassR);
  const mirror = new THREE.Group();                  // the same cup, upside down under the surface
  mirror.scale.y = -1;
  mirror.add(cupR);

  scene.add(mirror, shadow, cup, pipette, dropMesh);

  // ---------------------------------------------------------------- state
  const cur = lookFor(null);
  let target = lookFor(null);
  const ripples = [];                  // {x, z, t0, a}
  const tilt = { x: 0, z: 0, tx: 0, tz: 0 };
  const slosh = { x: 0, z: 0, vx: 0, vz: 0 };
  let active = true, last = performance.now(), lastEase = last;

  function setWater(reading, immediate) {
    target = lookFor(reading);
    if (immediate || still) Object.assign(cur, { ...target, color: target.color.clone() });
  }
  function drip(strength = 1) {
    if (still || drop.state !== "idle") return;
    Object.assign(drop, { state: "gathering", t: 0, v: 0, strength, x: 0, z: 0 });
    dropMesh.visible = true;
  }
  function land() {
    drop.state = "idle";
    dropMesh.visible = false;
    ripples.push({ x: drop.x, z: drop.z, t0: performance.now(), a: 0.046 * drop.strength });
    if (ripples.length > 5) ripples.shift();
    slosh.vx += 0.22 * drop.strength;
    nextDrip = performance.now() + 3800 + Math.random() * 1400;
  }

  window.addEventListener("pointermove", (e) => {
    tilt.tx = (e.clientY / innerHeight - 0.5) * 0.07;
    tilt.tz = -(e.clientX / innerWidth - 0.5) * 0.1;
  }, { passive: true });

  function size() {
    const w = Math.max(2, host.clientWidth), h = Math.max(2, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(size).observe(host);
  size();

  // ---------------------------------------------------------------- frame
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    // ease the water toward the latest reading (a few seconds, never a snap). Uses real elapsed
    // time, so a slow machine still arrives on schedule.
    const k = still ? 1 : 1 - Math.exp(-Math.min(1, (now - lastEase) / 1000) / 1.3);
    lastEase = now;
    cur.color.lerp(target.color, k);
    for (const key of ["body", "surf", "speck", "sink"]) cur[key] += (target[key] - cur[key]) * k;
    waterMat.color.copy(cur.color);
    waterMat.emissive.copy(cur.color).multiplyScalar(0.22);   // keeps its own hue under the blue rim light
    waterMat.opacity = cur.body;
    waterMatR.color.copy(cur.color);
    waterMatR.emissive.copy(waterMat.emissive);
    waterMatR.opacity = cur.body;
    surfMat.color.copy(cur.color).lerp(C.shell, 0.06);
    surfMat.opacity = cur.surf;
    speckMat.opacity = cur.speck;

    // the drop: gathers at the tip, lets go, falls
    if (!still && drop.state === "idle" && now >= nextDrip) drip(1);
    if (drop.state === "gathering") {
      drop.t += dt;
      const q = Math.min(1, drop.t / GATHER), e = q * q * (3 - 2 * q);
      const sag = 1 + 0.45 * e;                                 // hangs heavier as it grows
      dropMesh.scale.set(e / Math.sqrt(sag), e * sag, e / Math.sqrt(sag));
      drop.y = TIP - 0.04 * e * sag;
      dropMesh.position.set(0, drop.y, 0);
      dropMat.opacity = 0.92 * Math.min(1, q * 3);
      if (q >= 1) { drop.state = "falling"; drop.v = 0; }
    } else if (drop.state === "falling") {
      drop.v += GRAVITY * dt;
      drop.y -= drop.v * dt;
      const stretch = 1.2 + Math.min(0.4, drop.v * 0.1);
      dropMesh.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
      dropMesh.position.set(drop.x, drop.y, drop.z);
      if (drop.y <= LEVEL + 0.03) land();
    }

    // reflections travel across the glass as the room turns around it
    if (!still) scene.environmentRotation.y = t * 0.11;

    // lean toward the pointer; the water lags behind
    tilt.x += (tilt.tx - tilt.x) * 0.03;
    tilt.z += (tilt.tz - tilt.z) * 0.03;
    cup.rotation.x = tilt.x;
    cup.rotation.z = tilt.z;
    cupR.rotation.copy(cup.rotation);
    if (!still) spin.rotation.y = t * ((Math.PI * 2) / 48);        // one slow turn every 48 s
    const sk = 18, sc = 2.6;
    slosh.vx += (-sk * (slosh.x + tilt.z * 0.9) - sc * slosh.vx) * dt;
    slosh.vz += (-sk * (slosh.z - tilt.x * 0.9) - sc * slosh.vz) * dt;
    slosh.x += slosh.vx * dt;
    slosh.z += slosh.vz * dt;

    // surface: slosh plane + a faint swell + ripples from drops
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      let y = slosh.x * x * 0.35 + slosh.z * z * 0.35;
      if (!still) y += 0.004 * Math.sin(x * 7 + t * 0.9) * Math.cos(z * 6 - t * 0.7);
      for (const d of ripples) {
        const age = (now - d.t0) / 1000;
        const dist = Math.hypot(x - d.x, z - d.z);
        const front = age * 0.26;                         // slow, soothing
        y += d.a * Math.sin((dist - front) * 34) * Math.exp(-Math.pow((dist - front) * 6, 2)) * Math.exp(-age * 0.9);
      }
      pos.array[i * 3 + 1] = y;
    }
    pos.needsUpdate = true;
    surfGeo.computeVertexNormals();

    // specks swirl slowly; they settle to the bottom as the water gets cleaner
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      const a = s.a + t * s.w * (still ? 0 : 0.35);
      const y = Math.max(BASE + 0.03, s.y - cur.sink * s.sink * (s.y - BASE));
      specks[i * 3] = Math.cos(a) * s.r;
      specks[i * 3 + 1] = y + (still ? 0 : Math.sin(t * 0.8 + s.a) * 0.01);
      specks[i * 3 + 2] = Math.sin(a) * s.r;
    }
    speckGeo.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);
  }

  // render only while the hero is on screen and the tab is visible
  let raf = 0;
  const loop = () => { frame(); raf = requestAnimationFrame(loop); };
  function sync() {
    const run = active && !document.hidden;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
    if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function setRunning(on) { active = on; sync(); }
  document.addEventListener("visibilitychange", sync);
  frame();
  sync();
  return { setWater, drip, setRunning };
}

const host = document.querySelector("[data-hero3d]");
if (host) {
  try {
    window.TapHero = mount(host);
    host.classList.add("has-3d");
    window.dispatchEvent(new Event("hero3d:ready"));
  } catch (err) {
    console.warn("3D hero off:", err);
  }
}
