/* A slow lava lamp behind the glass, drawn with WebGL.
   Soft blobs of the accent rise, sink and merge, and small bubbles drift up; drop() sends a ripple across, and its crests
   catch the light. pan(n) eases the pools to a new arrangement (parallax between slides).
   Falls back to the CSS .scene pools if WebGL is unavailable. */
(function () {
  "use strict";
  const MAX_RIPPLES = 12;
  const SCALE = 0.5;                       // render at half resolution: it is soft, and sits under blur

  const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uPan;
uniform vec2 uMouse;
uniform vec4 uRip[${MAX_RIPPLES}];   // x, y (0..1), start time, strength
uniform float uRipS[${MAX_RIPPLES}];  // size: wavelength and reach scale with the element it came from
varying vec2 vUv;

const vec3 DEEP = vec3(0.043, 0.125, 0.153);   // #0B2027
const vec3 BLUE = vec3(0.353, 0.608, 0.741);   // #5A9BBD
const vec3 GRAY = vec3(0.443, 0.459, 0.502);   // #717580
const vec3 SHELL = vec3(0.969, 0.941, 0.941);  // #F7F0F0

float pool(vec2 p, vec2 c, float r) { vec2 d = p - c; return exp(-dot(d, d) / (r * r)); }

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);

  // ripples: a slow packet of crests travelling out from each drop
  vec2 disp = vec2(0.0);
  float h = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRip[i];
    float t = uTime - r.z;
    if (r.w <= 0.0 || t < 0.0) continue;
    float sc = uRipS[i];
    vec2 d = p - vec2(r.x * aspect, r.y);
    float dist = length(d);
    float x = (dist - t * 0.19 * sc) / sc;
    float env = exp(-x * x * 22.0) * exp(-t * 0.42 / sc) * r.w * smoothstep(0.0, 0.25, t);
    float wave = sin(x * 42.0) * env;
    h += wave;
    disp += (d / max(dist, 1e-4)) * wave * 0.014;
  }
  vec2 q = p + disp;

  // #0B2027 is the background. A slow lava lamp: soft blobs of the accent rise, sink and
  // merge (a metaball field), breathing on a ~7 s pulse; a few small bubbles drift up.
  float t = uTime;
  float pulse = 0.5 + 0.5 * sin(t * 0.9);
  float breath = mix(0.7, 1.0, pulse * pulse * (3.0 - 2.0 * pulse));
  vec2 pan = vec2(sin(uPan * 0.9) * 0.16, cos(uPan * 0.7) * 0.06) + uMouse * 0.025;
  vec2 lq = q + pan;
  float field = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float speed = 0.07 + 0.025 * mod(fi * 1.7, 3.0);           // 40-90 s per rise and fall
    float x = (0.12 + 0.13 * fi) * aspect + 0.05 * sin(t * 0.11 + fi * 2.3);
    float y = 0.5 + 0.48 * sin(t * speed + fi * 1.9);
    float r = 0.075 + 0.035 * mod(fi * 2.3, 2.0);
    vec2 d = lq - vec2(x, y);
    field += r * r / (dot(d, d) + 0.0004);
  }
  float blob = smoothstep(0.9, 1.7, field);                    // the wax: soft-edged, merging
  float core = smoothstep(1.7, 5.0, field);                    // brighter where it is thick
  float halo = smoothstep(0.25, 1.2, field);                   // glow around it
  vec3 col = DEEP;
  col = mix(col, mix(DEEP, BLUE, 0.42), blob * 0.62 * breath);
  col += BLUE * (0.045 * halo + 0.07 * core) * breath;
  col = mix(col, GRAY, 0.05 * pool(q, vec2(0.95 * aspect, 0.5), 0.5));

  // small bubbles, rising slowly and wobbling: faint rings that catch a little light
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float sp = 0.012 + 0.008 * mod(fi * 1.3, 3.0);
    float by = fract(t * sp + fi * 0.37) * 1.25 - 0.12;
    float bx = (0.04 + 0.083 * fi) * aspect + 0.012 * sin(t * 0.8 + fi * 4.0);
    float br = 0.0035 + 0.0035 * mod(fi * 1.9, 2.0);
    float bd = length(q - vec2(bx, by));
    float ring = smoothstep(br, br * 0.7, bd) - smoothstep(br * 0.7, br * 0.35, bd) * 0.7;
    col += SHELL * ring * 0.09 * smoothstep(-0.1, 0.15, by) * smoothstep(1.12, 0.9, by);
  }

  // ripple crests catch the accent light, troughs fall into the dark
  col += mix(BLUE, SHELL, 0.35) * max(h, 0.0) * 0.16;
  col -= DEEP * max(-h, 0.0) * 0.6;

  // vignette into deeper dark at the edges
  float v = smoothstep(1.25, 0.25, length((vUv - 0.5) * vec2(aspect, 1.0)));
  col *= mix(0.6, 1.0, v);
  gl_FragColor = vec4(col, 1.0);
}`;

  function create(canvas, opts = {}) {
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (err) {
      console.warn("water shader off:", err);
      return null;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = (n) => gl.getUniformLocation(prog, n);
    const uRes = u("uRes"), uTime = u("uTime"), uPan = u("uPan"), uMouse = u("uMouse"), uRip = u("uRip"), uRipS = u("uRipS");

    const still = !!opts.still;
    const ripples = new Float32Array(MAX_RIPPLES * 4);
    const sizes = new Float32Array(MAX_RIPPLES).fill(1);
    let next = 0;
    const t0 = performance.now();
    const clock = () => (still ? 40 : (performance.now() - t0) / 1000);
    let pan = 0, panFrom = 0, panTo = 0, panStart = 0, panDur = 1;
    const mouse = [0, 0], mouseTarget = [0, 0];
    const easeSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;

    function size() {
      canvas.width = Math.max(2, Math.round(innerWidth * SCALE));
      canvas.height = Math.max(2, Math.round(innerHeight * SCALE));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function frame() {
      const now = performance.now();
      if (panDur > 0) {
        const k = Math.min(1, (now - panStart) / panDur);
        pan = panFrom + (panTo - panFrom) * easeSine(k);
      }
      mouse[0] += (mouseTarget[0] - mouse[0]) * 0.03;   // slow follow
      mouse[1] += (mouseTarget[1] - mouse[1]) * 0.03;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, clock());
      gl.uniform1f(uPan, pan);
      gl.uniform2f(uMouse, mouse[0], mouse[1]);
      gl.uniform4fv(uRip, ripples);
      gl.uniform1fv(uRipS, sizes);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    let raf = 0;
    function loop() { frame(); raf = requestAnimationFrame(loop); }
    function start() { if (!raf && !still) raf = requestAnimationFrame(loop); }
    function stop() { cancelAnimationFrame(raf); raf = 0; }
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
    window.addEventListener("resize", () => { size(); frame(); });
    if (!still) {
      window.addEventListener("pointermove", (e) => {
        mouseTarget[0] = e.clientX / innerWidth - 0.5;
        mouseTarget[1] = 0.5 - e.clientY / innerHeight;
      }, { passive: true });
    }

    size();
    frame();
    start();

    return {
      /** a drop at viewport point (x, y) in CSS px; strength 0..1; size ~0.4 (tight) to ~1.5 (broad) */
      drop(x, y, strength = 1, size = 1) {
        if (still) return;
        const i = next++ % MAX_RIPPLES;
        ripples.set([x / innerWidth, 1 - y / innerHeight, clock(), strength], i * 4);
        sizes[i] = size;
      },
      /** ease the pools to the arrangement for slide n */
      pan(n, ms = 2600) {
        panFrom = pan; panTo = n; panStart = performance.now(); panDur = still ? 0 : ms;
        if (still) { pan = n; frame(); }
      },
    };
  }

  window.TapWater = { create };
})();
