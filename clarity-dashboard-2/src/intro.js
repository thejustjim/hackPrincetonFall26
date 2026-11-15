/* The map's loading screen: a globe that spins while the map loads, slows to bring Princeton to
   the front, then zooms in and fades as the real map flies down to the same spot.

   It is a drawing on a 2D canvas (an orthographic projection of the world outline the map already
   ships in data/land.json), not the map itself: this version of the map library has no globe.
   Nothing is locked. A click, a key or the wheel skips it, and once the map is in view it can be
   grabbed at any moment, which stops the flight. ?nointro leaves it out, and so does a reduced-motion
   setting. */
const RAD = Math.PI / 180;
const SPIN = 64;                 // degrees a second while loading
const TILT = 16;                 // degrees of latitude the globe is seen from while it spins
const MIN_SPIN = 1.4, SETTLE = 2.1, ZOOM = 1.7;     // seconds
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/* Every outline as a list of points, thinned so the whole world is about 14,000 of them. */
function outlines(geo) {
  const lines = [];
  const add = (ring, kind) => { if (ring.length > 3) lines.push({ kind, ring }); };
  for (const f of geo.features) {
    const g = f.geometry, kind = f.properties?.k || "other";
    if (g.type === "Polygon") g.coordinates.forEach((r) => add(r, kind));
    else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => p.forEach((r) => add(r, kind)));
    else if (g.type === "LineString") add(g.coordinates, kind);
    else if (g.type === "MultiLineString") g.coordinates.forEach((r) => add(r, kind));
  }
  const total = lines.reduce((n, l) => n + l.ring.length, 0), step = Math.max(1, Math.ceil(total / 14000));
  return lines.map(({ kind, ring }) => {
    const pts = ring.filter((_, i) => i % step === 0 || i === ring.length - 1);
    const out = new Float32Array(pts.length * 3);
    pts.forEach(([lon, lat], i) => { out[i * 3] = lon * RAD; out[i * 3 + 1] = Math.sin(lat * RAD); out[i * 3 + 2] = Math.cos(lat * RAD); });
    return { kind, pts: out };
  }).filter((l) => l.pts.length >= 12);
}

export function runIntro(map, home, dataUrl) {
  const wrap = map.getContainer().parentElement;
  const off = new URLSearchParams(location.search).has("nointro") || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (off || !wrap) return;

  const el = document.createElement("div");
  el.className = "intro";
  el.innerHTML = '<canvas></canvas><p class="intro-note">Loading the map</p>';
  wrap.appendChild(el);
  const canvas = el.querySelector("canvas"), note = el.querySelector(".intro-note"), ctx = canvas.getContext("2d");
  const [homeLon, homeLat] = home.center;
  let lines = [], ready = false, phase = "spin", t0 = performance.now(), phaseAt = t0, lon0 = homeLon + 150, from = 0, to = 0, raf = 0, done = false;

  fetch(dataUrl + "land.json").then((r) => r.json()).then((geo) => { lines = outlines(geo); }).catch(() => {});
  const mapReady = () => { ready = true; };
  if (map.loaded()) mapReady(); else map.once("load", mapReady);
  setTimeout(mapReady, 7000);                      // a slow connection: carry on with whatever has loaded

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    el.classList.add("gone");
    setTimeout(() => el.remove(), 700);
    removeEventListener("keydown", skip);
  }
  function skip() {                                // not locked: any input goes straight to the map
    if (phase !== "zoom") map.jumpTo(home);
    finish();
  }
  el.addEventListener("pointerdown", skip);
  el.addEventListener("wheel", skip, { passive: true });
  addEventListener("keydown", skip);

  function size() {
    const dpr = Math.min(2, devicePixelRatio || 1), w = wrap.clientWidth, h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  }

  function draw(now) {
    if (done) return;
    const [w, h] = size(), since = (now - phaseAt) / 1000;
    let lat0 = TILT, scale = 1, fade = 1, mark = 0;

    if (phase === "spin") {
      lon0 = homeLon + 150 + SPIN * ((now - t0) / 1000);
      if (ready && (now - t0) / 1000 >= MIN_SPIN) {
        // slow to a stop with Princeton in front: the next time round that it comes to the middle, at least half a turn on
        from = lon0;
        to = from + ((((homeLon - from) % 360) + 360) % 360);
        if (to - from < 200) to += 360;
        phase = "settle"; phaseAt = now;
        note.textContent = "Princeton, New Jersey";
      }
    } else if (phase === "settle") {
      const k = easeOut(Math.min(1, since / SETTLE));
      lon0 = from + (to - from) * k;
      lat0 = TILT + (homeLat - TILT) * easeInOut(Math.min(1, since / SETTLE));
      mark = Math.min(1, since / (SETTLE * 0.6));
      if (since >= SETTLE) {
        phase = "zoom"; phaseAt = now;
        el.classList.add("through");               // from here the map underneath takes the pointer
        // the real map starts high above the same spot and comes down as the globe grows and fades
        map.jumpTo({ center: home.center, zoom: 5.4, pitch: 0, bearing: 0 });
        map.flyTo({ ...home, duration: 4200, essential: true });
      }
    } else {
      const k = Math.min(1, since / ZOOM);
      lon0 = homeLon; lat0 = homeLat; mark = 1;
      scale = 1 + 15 * k * k * k;
      fade = 1 - easeInOut(Math.max(0, (k - 0.3) / 0.7));
      if (k >= 1) { finish(); return; }
    }

    const R = Math.min(w, h) * 0.33 * scale, cx = w / 2, cy = h / 2;
    const l0 = lon0 * RAD, s0 = Math.sin(lat0 * RAD), c0 = Math.cos(lat0 * RAD);
    el.style.opacity = fade.toFixed(3);
    ctx.clearRect(0, 0, w, h);

    // the sphere: a dark ball, lit from the upper left, with a thin bright edge
    const ball = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
    ball.addColorStop(0, "#102A3D");
    ball.addColorStop(1, "#060F18");
    ctx.save();
    ctx.shadowColor = "rgba(90, 155, 189, 0.35)";
    ctx.shadowBlur = 50;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = ball; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.strokeStyle = "rgba(141, 189, 216, 0.4)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();

    // one point of the globe onto the screen; false when it is on the far side
    const put = (lam, sinPhi, cosPhi) => {
      const d = lam - l0, cd = Math.cos(d);
      if (s0 * sinPhi + c0 * cosPhi * cd <= 0) return false;
      ctx.lineTo(cx + R * cosPhi * Math.sin(d), cy - R * (c0 * sinPhi - s0 * cosPhi * cd));
      return true;
    };
    const stroke = (pts) => {
      let pen = false;
      for (let i = 0; i < pts.length; i += 3) {
        const d = pts[i] - l0, cd = Math.cos(d), sp = pts[i + 1], cp = pts[i + 2];
        if (s0 * sp + c0 * cp * cd <= 0) { pen = false; continue; }
        const x = cx + R * cp * Math.sin(d), y = cy - R * (c0 * sp - s0 * cp * cd);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
    };

    // lines of latitude and longitude every 30 degrees
    ctx.beginPath();
    for (let lon = -180; lon < 180; lon += 30) {
      let pen = false;
      for (let lat = -90; lat <= 90; lat += 5) {
        const d = lon * RAD - l0, cd = Math.cos(d), sp = Math.sin(lat * RAD), cp = Math.cos(lat * RAD);
        if (s0 * sp + c0 * cp * cd <= 0) { pen = false; continue; }
        const x = cx + R * cp * Math.sin(d), y = cy - R * (c0 * sp - s0 * cp * cd);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      let pen = false;
      for (let lon = -180; lon <= 180; lon += 5) {
        const d = lon * RAD - l0, cd = Math.cos(d), sp = Math.sin(lat * RAD), cp = Math.cos(lat * RAD);
        if (s0 * sp + c0 * cp * cd <= 0) { pen = false; continue; }
        const x = cx + R * cp * Math.sin(d), y = cy - R * (c0 * sp - s0 * cp * cd);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
    }
    ctx.strokeStyle = "rgba(247, 240, 240, 0.07)"; ctx.lineWidth = 1; ctx.stroke();

    // coastlines, then the United States a little brighter, then its state lines once they are worth seeing
    for (const [kind, colour, width] of [["other", "rgba(141, 189, 216, 0.62)", 0.9], ["states", "rgba(247, 240, 240, 0.2)", 0.7], ["us", "rgba(141, 189, 216, 0.95)", 1.3]]) {
      if (kind === "states" && phase === "spin") continue;
      ctx.beginPath();
      for (const l of lines) if (l.kind === kind) stroke(l.pts);
      ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.stroke();
    }

    // Princeton: a dot and a ring that breathes
    if (mark > 0) {
      ctx.beginPath();
      if (put(homeLon * RAD, Math.sin(homeLat * RAD), Math.cos(homeLat * RAD))) {
        const d = homeLon * RAD - l0, cp = Math.cos(homeLat * RAD), sp = Math.sin(homeLat * RAD), cd = Math.cos(d);
        const x = cx + R * cp * Math.sin(d), y = cy - R * (c0 * sp - s0 * cp * cd), pulse = (now / 1000) % 1.6 / 1.6;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = `rgba(247, 240, 240, ${mark})`; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 6 + 18 * pulse, 0, Math.PI * 2); ctx.strokeStyle = `rgba(141, 189, 216, ${(mark * (1 - pulse)).toFixed(3)})`; ctx.lineWidth = 1.4; ctx.stroke();
      }
    }
    ctx.restore();
    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);
}
