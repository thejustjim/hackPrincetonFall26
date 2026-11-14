/* The hero: one glass of water in three.js that shows the latest reading.
   Dissolved solids show as an amber tint and drifting specks, cloudiness as a tea-brown murk.
   When a new reading arrives the water eases to its new look over a few seconds.

   A pipette of brown, untreated water hangs above the glass. Every few seconds a drop forms
   and falls the way a real one does, shown at about one-sixth speed:
     - it swells at the tip as a pendant drop, a neck forms and thins, and it pinches off,
       leaving a small satellite droplet behind it;
     - it falls under constant gravity as a sphere (not a teardrop), wobbling between tall and
       flat as surface tension rings down;
     - it clears from brown to blue on the way;
     - it opens a crater in the surface, which rebounds as a small jet that throws up one
       secondary droplet, while capillary rings spread outward.
   The glass turns slowly (its etched marks and the reflections travel), leans slightly toward
   the pointer, and stands on a dark surface that faintly reflects it.

   window.TapHero = { setWater(reading, immediate), drip(), setRunning(bool) } once mounted.
   Events on window: "hero3d:ready", and "hero3d:impact" each time a drop lands.
   If WebGL or the module fails, the page keeps its SVG cup. */
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
  const fade = reflection ? `* 0.3 * smoothstep(-0.6, -0.02, ${WORLD_Y})` : "";
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
  const fade = reflection ? `* 0.34 * smoothstep(-0.55, -0.05, ${WORLD_Y})` : "";
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

  // Framing: the glass fills about 60% of the canvas height, with room above for the pipette
  // and the drop's fall, and a little below for its reflection. Where the glass ends up inside
  // the canvas is measured (see reportShape) and handed to the notes, so they can point at it.
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
  camera.position.set(0, 1.74, 6.09);
  camera.lookAt(0, 1.02, 0);

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
  const surfGeo = new THREE.RingGeometry(0.0005, R_SURF, 128, 56);
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
  const dotCanvas = document.createElement("canvas");
  dotCanvas.width = dotCanvas.height = 64;
  const dotCtx = dotCanvas.getContext("2d");
  const dotGrad = dotCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  dotGrad.addColorStop(0, "rgba(255,255,255,1)");
  dotGrad.addColorStop(0.45, "rgba(255,255,255,0.75)");
  dotGrad.addColorStop(1, "rgba(255,255,255,0)");
  dotCtx.fillStyle = dotGrad;
  dotCtx.fillRect(0, 0, 64, 64);
  const speckMat = new THREE.PointsMaterial({ color: C.speck, size: 0.045, map: new THREE.CanvasTexture(dotCanvas), transparent: true, opacity: 0, depthWrite: false, toneMapped: false });   // round, soft-edged
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

  // the name, etched into the glass: it is what you see travel as the glass turns
  const etch = document.createElement("canvas");
  etch.width = 1024; etch.height = 256;
  const etchTex = new THREE.CanvasTexture(etch);
  etchTex.colorSpace = THREE.SRGBColorSpace;
  etchTex.anisotropy = 8;
  function drawEtch() {
    const c = etch.getContext("2d");
    c.clearRect(0, 0, 1024, 256);
    c.fillStyle = "rgba(247, 240, 240, 0.95)";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = '400 190px "Newsreader", Georgia, serif';
    c.fillText("Clarity", 512, 136);
    etchTex.needsUpdate = true;
  }
  drawEtch();
  document.fonts?.ready.then(() => document.fonts.load('400 190px "Newsreader"')).then(drawEtch).catch(() => {});
  const Y0 = 0.5, Y1 = 0.86, ARC = 1.5;              // a band across the lower half, about 85 degrees wide
  const wordmark = new THREE.Mesh(
    new THREE.CylinderGeometry(rOut(Y1) + 0.005, rOut(Y0) + 0.005, Y1 - Y0, 64, 1, true, Math.PI - ARC / 2, ARC),
    new THREE.MeshBasicMaterial({ map: etchTex, transparent: true, opacity: 0.4, side: THREE.FrontSide, depthWrite: false, toneMapped: false }));   // front only: it never shows mirrored through the glass
  wordmark.position.y = (Y0 + Y1) / 2;
  wordmark.renderOrder = 5;

  // ---------------------------------------------------------------- the pipette and its drop
  // Scale: the glass is about 12 cm tall, so one unit is about 7 cm and the drop is about 3 mm
  // in radius. Real gravity would be ~140 units/s^2; G = 4 shows the fall at about 1/6 speed.
  const TIP = 2.06;                                   // world height of the pipette's tip
  const R0 = 0.017;                                   // radius of its opening
  const RD = 0.046;                                   // radius of a full drop
  const G = 4.0;
  const GATHER = 1.6, NECK = 0.38;                    // seconds to swell, then to neck and pinch off
  const CLEAR = new THREE.Color(0x4fa6e4);
  const SILT = new THREE.Color(0x7fa48e);             // halfway there: the brown thins to a green-grey before it clears            // what the brown drop turns into as it falls
  const PACE = 0.7;                                   // drops play back a little under real time, like slow-motion film

  const pipette = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 2.6, 40, 1, true), glassMaterial());
  tube.position.y = TIP + 0.3 + 1.3;
  const taper = new THREE.Mesh(new THREE.CylinderGeometry(0.052, R0, 0.3, 40, 1, true), glassMaterial());
  taper.position.y = TIP + 0.15;
  // the untreated water standing in the pipette
  const dirty = new THREE.MeshBasicMaterial({ color: C.murk, transparent: true, opacity: 0.82, depthWrite: false });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 2.2, 24), dirty);
  column.position.y = TIP + 0.34 + 1.1;
  const columnTip = new THREE.Mesh(new THREE.CylinderGeometry(0.036, R0 * 0.8, 0.3, 24), dirty);
  columnTip.position.y = TIP + 0.17;
  pipette.add(column, columnTip, tube, taper);
  pipette.renderOrder = 6;

  // one material for the drop and its droplets: brown and dull at the tip, clear and bright by the time it lands
  const dropMat = new THREE.MeshPhysicalMaterial({
    color: C.murk.clone(), emissive: C.blue.clone(), emissiveIntensity: 0, roughness: 0.42, metalness: 0,
    transparent: true, opacity: 0.96, envMapIntensity: 0.5, depthWrite: false,
  });
  const pendantMat = new THREE.MeshPhysicalMaterial({
    color: C.murk.clone(), roughness: 0.42, metalness: 0, transparent: true, opacity: 0.96, envMapIntensity: 0.5, depthWrite: false,
  });
  const sphere = new THREE.SphereGeometry(1, 32, 24);
  const dropMesh = new THREE.Mesh(sphere, dropMat);          // the falling drop
  const satMesh = new THREE.Mesh(sphere, dropMat);           // the satellite left by the neck
  const jetMesh = new THREE.Mesh(sphere, dropMat);           // the droplet thrown up by the rebound
  const pendant = new THREE.Mesh(new THREE.BufferGeometry(), pendantMat);   // the drop while it hangs (rebuilt as it grows)
  for (const m of [dropMesh, satMesh, jetMesh, pendant]) { m.renderOrder = 7; m.visible = false; }

  const smax = (p, q, k) => { const h = Math.max(k - Math.abs(p - q), 0) / k; return Math.max(p, q) + h * h * k * 0.25; };
  /* The hanging drop as a surface of revolution: a bulb of radius rb centred at yc, joined to the
     opening by a neck that is R0 wide at the tip and narrows to nr. */
  function pendantShape(rb, yc, nr) {
    const pts = [], bottom = yc - rb, n = 26;
    for (let i = 0; i <= n; i++) {
      const y = TIP - ((TIP - bottom) * i) / n;
      const bulb = Math.sqrt(Math.max(0, rb * rb - (y - yc) * (y - yc)));
      const u = Math.min(1, Math.max(0, (y - yc) / Math.max(1e-4, TIP - yc)));
      const neck = y >= yc ? nr + (R0 - nr) * u * u * u : 0;
      pts.push(new THREE.Vector2(i === n ? 0.0001 : Math.max(0.0001, smax(bulb, neck, 0.012)), y));
    }
    pendant.geometry.dispose();
    pendant.geometry = new THREE.LatheGeometry(pts, 28);
  }

  const drop = { state: "idle", t: 0, y: 0, v: 0, y0: 0, tf: 0, pace: PACE };
  let splashPace = PACE;                              // the pace of the drop that last landed: its splash keeps it
  const sat = { on: false, y: 0, v: 0 };
  const jet = { on: false, y: 0, v: 0, thrown: true };
  let impactAt = -1e9;                                // when the last drop hit (ms)
  // on the pitch's black opening the first drop waits to be asked for (pitch.js), with a long fallback
  let nextDrip = performance.now() + (document.documentElement.classList.contains("opening") ? 12000 : 1600);
  // the bead of water that always hangs at the opening, where the next drop starts
  const bead = { r: R0 * 1.15, yc: TIP - R0 * 0.6 };

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
  spin.add(speckPts, marks, wordmark);
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

  scene.add(mirror, shadow, cup, pipette, pendant, dropMesh, satMesh, jetMesh);

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
  /* Start a drop. `pace` slows the whole event (necking, fall, wobble, splash) by one factor, the
     way slow-motion film does, so the motion stays true to a real drop. */
  function drip(pace) {
    if (still || drop.state !== "idle") return;
    Object.assign(drop, { state: "gather", t: 0, pace: pace || PACE });
  }
  function splash(amplitude) {
    ripples.push({ x: 0, z: 0, t0: performance.now(), a: amplitude });
    if (ripples.length > 6) ripples.shift();
  }
  function land() {
    drop.state = "idle";
    dropMesh.visible = false;
    impactAt = performance.now();
    splashPace = drop.pace;
    jet.thrown = false;
    splash(0.05);
    nextDrip = impactAt + 3800 + Math.random() * 1400;
    window.dispatchEvent(new Event("hero3d:impact"));
  }

  window.addEventListener("pointermove", (e) => {
    tilt.tx = (e.clientY / innerHeight - 0.5) * 0.07;
    tilt.tz = -(e.clientX / innerWidth - 0.5) * 0.1;
  }, { passive: true });

  const api = { shape: null };
  /* Where the glass sits inside the canvas, as shares of the canvas height: rim, base and water
     surface from the top, and its half-widths at the rim and the base. */
  function reportShape() {
    camera.updateMatrixWorld();
    const at = (x, y) => new THREE.Vector3(x, y, 0).project(camera);
    const down = (v) => (1 - v.y) / 2, across = (v) => (v.x * camera.aspect) / 2;
    api.shape = { top: down(at(0, H)), bottom: down(at(0, 0)), surface: down(at(0, LEVEL)),
                  halfTop: across(at(RT, H)), halfBottom: across(at(RB, 0)) };
    window.dispatchEvent(new Event("hero3d:shape"));
  }
  function size() {
    const w = Math.max(2, host.clientWidth), h = Math.max(2, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    reportShape();
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

    // ---- the drop
    if (!still && drop.state === "idle" && now >= nextDrip) drip();
    pendant.visible = !still;
    const ddt = dt * drop.pace;
    if (drop.state === "gather") {                       // swelling: volume grows steadily, so radius goes as the cube root
      drop.t += dt;                                      // (how fast it fills is the pipette's business, not physics)
      const q = Math.min(1, drop.t / GATHER);
      const rb = Math.max(bead.r, RD * Math.cbrt(q));
      const yc = TIP - rb * 0.82 - 0.012 * q * q;        // it sags as it gets heavier
      pendantShape(rb, yc, R0);
      if (q >= 1) Object.assign(drop, { state: "neck", t: 0, y: yc });
    } else if (drop.state === "neck") {                  // the neck stretches and thins, fastest at the end
      drop.t += ddt;
      const q = Math.min(1, drop.t / NECK);
      const yc = drop.y - 0.5 * 1.7 * drop.t * drop.t;
      pendantShape(RD, yc, R0 * (1 - Math.pow(q, 1.7)));
      if (q >= 1) {                                      // pinch-off
        Object.assign(drop, { state: "fall", y: yc, v: 1.7 * NECK, y0: yc, tf: 0 });
        Object.assign(sat, { on: true, y: (TIP + yc + RD) / 2, v: 1.7 * NECK * 0.55 });
        dropMesh.visible = satMesh.visible = true;
        pendantShape(bead.r, bead.yc, R0);
      }
    } else {
      // the bead left at the opening springs back and settles
      const since = drop.state === "fall" ? drop.tf : 9;
      pendantShape(bead.r, bead.yc + 0.012 * Math.exp(-since / 0.16) * Math.cos(since * 34), R0);
    }
    if (drop.state === "fall") {
      drop.tf += ddt;
      drop.v += G * ddt;
      drop.y -= drop.v * ddt;
      // surface tension rings the drop between tall and flat (about 40 Hz in life), dying away
      const s = 1 + 0.24 * Math.exp(-drop.tf / 0.5) * Math.cos(drop.tf * Math.PI * 2 * 6.5);
      dropMesh.scale.set(RD / Math.sqrt(s), RD * s, RD / Math.sqrt(s));
      dropMesh.position.set(0, drop.y, 0);
      // brown at the tip, clear by the time it lands
      const p = Math.min(1, Math.max(0, (drop.y0 - drop.y) / (drop.y0 - LEVEL)));
      const c = Math.min(1, Math.max(0, (p - 0.1) / 0.62)), clear = c * c * (3 - 2 * c);
      if (clear < 0.5) dropMat.color.copy(C.murk).lerp(SILT, clear * 2);
      else dropMat.color.copy(SILT).lerp(CLEAR, clear * 2 - 1);
      dropMat.roughness = 0.42 - 0.39 * clear;           // muddy and dull, then glossy
      dropMat.opacity = 0.96 - 0.3 * clear;              // and you start to see through it
      dropMat.emissiveIntensity = 0.5 * clear * clear;
      dropMat.envMapIntensity = 0.5 + 0.7 * clear;
      if (drop.y - RD * 0.6 <= LEVEL) land();
    }
    if (sat.on) {                                        // the satellite follows it down
      sat.v += G * ddt;
      sat.y -= sat.v * ddt;
      satMesh.scale.setScalar(0.012);
      satMesh.position.set(0, sat.y, 0);
      if (sat.y <= LEVEL) { sat.on = false; satMesh.visible = false; splash(0.012); }
    }
    const sinceImpact = ((now - impactAt) / 1000) * splashPace;
    if (!jet.thrown && sinceImpact >= 0.5) {             // the rebound throws one droplet straight up
      jet.thrown = true;
      Object.assign(jet, { on: true, y: LEVEL + 0.085, v: -0.62 });
      jetMesh.visible = true;
    }
    if (jet.on) {
      jet.v += G * dt * splashPace;
      jet.y -= jet.v * dt * splashPace;
      jetMesh.scale.setScalar(0.015);
      jetMesh.position.set(0, jet.y, 0);
      if (jet.v > 0 && jet.y <= LEVEL) { jet.on = false; jetMesh.visible = false; splash(0.016); }
    }

    // reflections travel across the glass as the room turns around it
    if (!still) scene.environmentRotation.y = t * 0.11;

    // lean toward the pointer; the water lags behind
    tilt.x += (tilt.tx - tilt.x) * 0.03;
    tilt.z += (tilt.tz - tilt.z) * 0.03;
    cup.rotation.x = tilt.x;
    cup.rotation.z = tilt.z;
    cupR.rotation.copy(cup.rotation);
    spin.rotation.y = still ? Math.PI : Math.PI + t * ((Math.PI * 2) / 40);        // one slow turn every 40 s, starting with the name facing you
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
      const dist0 = Math.hypot(x, z);
      for (const d of ripples) {
        const age = (now - d.t0) / 1000;
        const front = age * 0.26;                         // slow, soothing
        y += d.a * Math.sin((dist0 - front) * 34) * Math.exp(-Math.pow((dist0 - front) * 6, 2)) * Math.exp(-age * 0.9);
      }
      // the impact: a crater that rebounds as a narrower, taller jet, then settles
      if (sinceImpact < 2.4) {
        const h = -0.07 * Math.exp(-sinceImpact / 0.42) * Math.sin((sinceImpact * Math.PI * 2) / 0.72);
        y += h < 0 ? h * Math.exp(-Math.pow(dist0 / 0.12, 2)) : h * 4.2 * Math.exp(-Math.pow(dist0 / 0.045, 2));
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
  return Object.assign(api, { setWater, drip, setRunning });
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
