/* A glass of water in three.js for the title slide.
   It starts murky (amber specks of dissolved solids, tea-brown tint), a drop lands, and the
   water clears to the palette's blue while the specks sink and fade: the Clarity story in
   one object. The cup leans toward the pointer and the water sloshes behind the motion.
   window.TapCup3D = { play(), drop(strength), setActive(bool) } once mounted.
   If WebGL or the module fails, the SVG cups already in the vitrine stay. */
import * as THREE from "three";
import { RoomEnvironment } from "../vendor/three/RoomEnvironment.js";

const C = {
  blue: new THREE.Color(0x5a9bbd),
  shell: new THREE.Color(0xf7f0f0),
  murk: new THREE.Color(0x3d2c18),
  speck: new THREE.Color(0xe2be5e),
};
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function mount(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = "cup3d-canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 1.55, 5.4);
  camera.lookAt(0, 0.78, 0);

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
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x000000, roughness: 0.02, metalness: 0, transparent: true, opacity: 1,   // no body colour: glass is all reflection
    clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.3, side: THREE.DoubleSide, depthWrite: false,
  });
  // Glass is nearly invisible face-on and reflective at grazing angles (Fresnel), and its
  // highlights stay bright however clear the pane is.
  glassMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        float fresnel = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.6);
        diffuseColor.a = mix(0.02, 0.5, fresnel);`)
      .replace("#include <opaque_fragment>", `
        float hi = clamp(max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b) - 0.6, 0.0, 1.0);
        gl_FragColor = vec4(outgoingLight, clamp(diffuseColor.a + hi * 1.4, 0.0, 1.0));`);
  };
  const glass = new THREE.Mesh(new THREE.LatheGeometry(profile, 128), glassMat);
  glass.renderOrder = 4;

  // ---------------------------------------------------------------- the water
  const LEVEL = 1.2;
  const inset = 0.006;
  const waterProfile = [[0.001, BASE + inset], [rIn(BASE) - inset, BASE + inset], [rIn(LEVEL) - inset, LEVEL]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: C.murk.clone(), roughness: 0.2, metalness: 0, transparent: true, opacity: 0.8,
    envMapIntensity: 0.25, side: THREE.FrontSide, depthWrite: false,
  });
  const body = new THREE.Mesh(new THREE.LatheGeometry(waterProfile, 128), waterMat);
  body.renderOrder = 1;

  const R_SURF = rIn(LEVEL) - inset;
  const surfGeo = new THREE.RingGeometry(0.0005, R_SURF, 128, 32);
  surfGeo.rotateX(-Math.PI / 2);
  const surfMat = new THREE.MeshPhysicalMaterial({
    color: C.murk.clone(), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.85,
    envMapIntensity: 0.9, clearcoat: 1, clearcoatRoughness: 0.03, side: THREE.DoubleSide, depthWrite: false,
  });
  const surface = new THREE.Mesh(surfGeo, surfMat);
  surface.position.y = LEVEL;
  surface.renderOrder = 2;
  const pos = surfGeo.attributes.position;
  const base = Float32Array.from(pos.array);

  // ---------------------------------------------------------------- dissolved solids
  const N = 320;
  const specks = new Float32Array(N * 3);
  const seeds = [];
  for (let i = 0; i < N; i++) {
    const y = BASE + 0.05 + Math.random() * (LEVEL - BASE - 0.1);
    const r = Math.sqrt(Math.random()) * (rIn(y) - 0.06);
    const a = Math.random() * Math.PI * 2;
    seeds.push({ y, r, a, w: 0.08 + Math.random() * 0.25, sink: 0.3 + Math.random() * 0.7 });
  }
  const speckGeo = new THREE.BufferGeometry();
  speckGeo.setAttribute("position", new THREE.BufferAttribute(specks, 3));
  const speckMat = new THREE.PointsMaterial({ color: C.speck, size: 0.03, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
  const speckPts = new THREE.Points(speckGeo, speckMat);
  speckPts.renderOrder = 3;

  // ---------------------------------------------------------------- soft contact shadow
  const sh = document.createElement("canvas");
  sh.width = sh.height = 128;
  const g = sh.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.002;

  const cup = new THREE.Group();
  cup.add(body, surface, speckPts, glass);
  scene.add(shadow, cup);

  // ---------------------------------------------------------------- state
  let clarity = 0;                     // 0 murky -> 1 clear
  let playT0 = performance.now();      // when the current pour began
  const drops = [];                    // surface ripples: {x, z, t0, a}
  const tilt = { x: 0, z: 0, tx: 0, tz: 0 };
  const slosh = { x: 0, z: 0, vx: 0, vz: 0 };
  let active = true;

  const easeSine = (k) => -(Math.cos(Math.PI * Math.min(1, Math.max(0, k))) - 1) / 2;

  function play() {
    playT0 = performance.now();
    clarity = 0;
  }
  function drop(strength = 1) {
    drops.push({ x: (Math.random() - 0.5) * 0.12, z: (Math.random() - 0.5) * 0.12, t0: performance.now(), a: 0.05 * strength });
    if (drops.length > 6) drops.shift();
    slosh.vx += 0.6 * strength; // a small kick
  }

  window.addEventListener("pointermove", (e) => {
    tilt.tx = (e.clientY / innerHeight - 0.5) * 0.16;
    tilt.tz = -(e.clientX / innerWidth - 0.5) * 0.22;
  }, { passive: true });
  host.addEventListener("click", () => { play(); drop(1); });

  function size() {
    const w = Math.max(2, host.clientWidth), h = Math.max(2, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(size).observe(host);
  size();

  // ---------------------------------------------------------------- frame
  let last = performance.now();
  function frame() {
    const now = performance.now();   // one clock for everything (rAF stamps can run on a different one)
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    const since = (now - playT0) / 1000;

    // the story: murky for a beat, a drop, then it clears over ~4 s
    if (!still) {
      if (since > 2.2 && since - dt <= 2.2) drop(1);
      clarity = easeSine((since - 2.4) / 4.2);
    } else clarity = 1;

    const col = C.murk.clone().lerp(C.blue, clarity);
    waterMat.color.copy(col);
    surfMat.color.copy(col).lerp(C.shell, 0.06);
    waterMat.opacity = 0.78 - 0.5 * clarity;
    surfMat.opacity = 0.8 - 0.42 * clarity;

    // lean toward the pointer; the water lags behind like it should
    tilt.x += (tilt.tx - tilt.x) * 0.04;
    tilt.z += (tilt.tz - tilt.z) * 0.04;
    cup.rotation.x = tilt.x;
    cup.rotation.z = tilt.z;
    cup.position.y = still ? 0 : Math.sin(t * 0.7) * 0.015;
    const k = 18, c = 2.6;
    slosh.vx += (-k * (slosh.x + tilt.z * 0.9) - c * slosh.vx) * dt;
    slosh.vz += (-k * (slosh.z - tilt.x * 0.9) - c * slosh.vz) * dt;
    slosh.x += slosh.vx * dt;
    slosh.z += slosh.vz * dt;

    // surface: slosh plane + soft ambient swell + ripples from drops
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      let y = slosh.x * x * 0.35 + slosh.z * z * 0.35;
      if (!still) y += 0.006 * Math.sin(x * 7 + t * 1.1) * Math.cos(z * 6 - t * 0.9);
      for (const d of drops) {
        const age = (now - d.t0) / 1000;
        const dist = Math.hypot(x - d.x, z - d.z);
        const front = age * 0.32;
        y += d.a * Math.sin((dist - front) * 38) * Math.exp(-Math.pow((dist - front) * 7, 2)) * Math.exp(-age * 1.1);
      }
      pos.array[i * 3 + 1] = y;
    }
    pos.needsUpdate = true;
    surfGeo.computeVertexNormals();

    // specks swirl slowly, then sink and fade as the water clears
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      const a = s.a + t * s.w * (still ? 0 : 0.35);
      const y = Math.max(BASE + 0.03, s.y - clarity * s.sink * (s.y - BASE));
      specks[i * 3] = Math.cos(a) * s.r;
      specks[i * 3 + 1] = y + (still ? 0 : Math.sin(t * 0.8 + s.a) * 0.01);
      specks[i * 3 + 2] = Math.sin(a) * s.r;
    }
    speckGeo.attributes.position.needsUpdate = true;
    speckMat.opacity = 0.85 * (1 - clarity * 0.92);

    renderer.render(scene, camera);
  }

  // render only while the title slide is showing and the tab is visible
  let raf = 0;
  const loop = () => { frame(); raf = requestAnimationFrame(loop); };
  function sync() {
    const run = active && !document.hidden;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
    if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function setActive(on) { active = on; sync(); }
  document.addEventListener("visibilitychange", sync);
  sync();
  return { play, drop, setActive };
}

const host = document.querySelector("[data-cup3d]");
if (host) {
  try {
    const api = mount(host);
    host.classList.add("has-3d");
    window.TapCup3D = api;
    window.dispatchEvent(new Event("cup3d:ready"));
  } catch (err) {
    console.warn("3D cup off:", err);
  }
}
