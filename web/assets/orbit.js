/* Notes placed around the cup, like annotations on a plate. Each note has a fixed place and
   drifts a few pixels; a hairline runs from it to the part of the cup it describes. Hovering,
   focusing or tapping a note holds everything still and unfolds its explanation, without the
   note's own text moving. Below `stackBelow` pixels wide the notes sit in a plain grid.

   const notes = TapOrbit.create({ stage, cup, tags, leaders, slots });
   slots: ["id", ...]                       auto layout, alternating sides, no leader targets
      or  [{ id, side: -1|1, y, out, ay, ax }]
          y   where the note sits, as a share of the cup canvas height
          out how far its inner edge is from the cup's centre line, as a share of that height
          ay  the height on the cup its line ends at; ax how far across (0 centre, 1 the glass)
   notes.set(items, render)                 items: [{id, value, label, detail}] */
(function () {
  "use strict";
  const SVG = "http://www.w3.org/2000/svg";

  function create(opts) {
    const { stage, cup, tags: tagsEl, leaders = null } = opts;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stacked = matchMedia(`(max-width: ${opts.stackBelow || 760}px)`);
    const drift = still ? 0 : opts.drift ?? 4;
    // where the cup sits inside its canvas (shares of the canvas height; set by hero3d's camera)
    const CUP = Object.assign({ top: 0.34, bottom: 0.76, halfTop: 0.163, halfBottom: 0.128 }, opts.cupShape);
    const FAR = [0.8, 0.94, 1.0, 0.72, 0.86, 1.0, 0.76, 0.9, 0.84];   // auto layout: an uneven scatter

    const n = opts.slots.length;
    const slots = new Map(opts.slots.map((s, k) => {
      const spec = typeof s === "string"
        ? { id: s, side: k % 2 ? 1 : -1, y: (opts.rowTop ?? 0.25) + (((opts.rowBottom ?? 0.9) - (opts.rowTop ?? 0.25)) * k) / Math.max(1, n - 1), far: FAR[k % FAR.length] }
        : s;
      return [spec.id, Object.assign({ k }, spec)];
    }));

    const tags = new Map();            // id -> {el, leader, html, w, h, hover, open()}
    let geo = null, keepOpen = null, running = true, clock = 0, last = performance.now();

    function measure() {
      const ch = cup.offsetHeight, top = cup.offsetTop;
      const cx = cup.offsetLeft + cup.offsetWidth / 2;
      const keep = opts.keepLeftEl ? opts.keepLeftEl.offsetLeft + opts.keepLeftEl.offsetWidth : 0;   // a text column to stay clear of
      geo = {
        W: stage.clientWidth, cx, ch, top, keep,
        cupTop: top + ch * CUP.top, cupBottom: top + ch * CUP.bottom,
        sil(y) {                         // half-width of the glass at this height
          const k = Math.min(1, Math.max(0, (y - this.cupTop) / (this.cupBottom - this.cupTop)));
          return ch * (CUP.halfTop + (CUP.halfBottom - CUP.halfTop) * k);
        },
      };
      tags.forEach((t) => { if (!t.open()) { t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; } });
    }

    const held = () => { for (const t of tags.values()) if (t.open()) return true; return false; };

    function place() {
      if (!geo) measure();
      if (!cup.offsetHeight) return;                         // hero not laid out (hidden)
      if (stacked.matches) {
        tags.forEach((t) => { t.el.style.transform = ""; if (t.leader) t.leader.style.display = "none"; });
        return;
      }
      tags.forEach((t, id) => {
        const s = slots.get(id);
        if (!s) return;
        const side = s.side;
        const y0 = geo.top + geo.ch * s.y;
        // distance from the cup's centre line to the note's inner edge
        const room = (side < 0 ? geo.cx - geo.keep : geo.W - geo.cx) - 20 - Math.max(t.w, opts.openWidth || 0);   // leave room for it to open
        const want = s.out != null ? s.out * geo.ch : Math.min(room, geo.ch * (opts.reach || 0.62)) * s.far - t.w / 2;
        const inner = Math.max(geo.sil(y0) + 44, Math.min(want, room));
        const x = geo.cx + side * inner + drift * 0.6 * Math.sin(clock * 0.37 + s.k * 2.1);
        const y = y0 + drift * Math.sin(clock * 0.5 + s.k * 1.3);
        const grow = s.grow || (s.y > 0.74 ? "up" : "down");
        t.el.dataset.side = side < 0 ? "left" : "right";
        t.el.dataset.grow = grow;
        // anchored by its inner edge and its resting height, so unfolding never moves the label
        t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${side < 0 ? "-100%" : "0"}, ${grow === "up" ? `calc(-100% + ${(t.h / 2).toFixed(1)}px)` : `${(-t.h / 2).toFixed(1)}px`})`;
        if (t.leader) {
          const ay = s.ay != null ? geo.top + geo.ch * s.ay : Math.min(geo.cupBottom, Math.max(geo.cupTop, y));
          const ax = s.ax ?? 1;
          const x2 = geo.cx + side * (geo.sil(ay) * ax + (ax >= 1 ? 9 : 0));
          const x1 = x - side * 14;
          const [line, dot] = t.leader.children;
          line.setAttribute("x1", x1.toFixed(1)); line.setAttribute("y1", y.toFixed(1));
          line.setAttribute("x2", x2.toFixed(1)); line.setAttribute("y2", ay.toFixed(1));
          dot.setAttribute("cx", x2.toFixed(1)); dot.setAttribute("cy", ay.toFixed(1));
          t.leader.style.display = (x1 - x2) * side < 16 ? "none" : "";
        }
      });
    }

    let raf = 0;
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!held()) clock += dt;                              // everything holds still while a note is open
      place();
      raf = running ? requestAnimationFrame(frame) : 0;
    }
    function setRunning(on) {
      running = on;
      if (on && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }

    function set(items, render) {
      const ids = new Set(items.map((i) => i.id));
      for (const [id, t] of tags) if (!ids.has(id)) { t.el.remove(); t.leader?.remove(); tags.delete(id); }
      items.forEach((item) => {
        const s = slots.get(item.id);
        if (!s) return;
        let t = tags.get(item.id);
        if (!t) {
          const el = document.createElement("button");
          el.type = "button";
          el.className = "tag";
          el.dataset.id = item.id;
          el.style.setProperty("--k", s.k);
          t = { el, html: "", w: 0, h: 0, hover: false, leader: null,
                open: () => t.hover || el.classList.contains("pinned") || document.activeElement === el };
          el.addEventListener("pointerenter", () => { t.hover = true; });
          el.addEventListener("pointerleave", () => { t.hover = false; });
          el.addEventListener("click", () => {
            const was = el.classList.contains("pinned");
            tags.forEach((o) => o.el.classList.remove("pinned"));
            el.classList.toggle("pinned", !was);
            if (was) el.blur();
          });
          if (leaders && (s.ay != null || opts.autoLeaders)) {
            t.leader = document.createElementNS(SVG, "g");
            t.leader.setAttribute("class", "leader");
            t.leader.style.setProperty("--k", s.k);
            const line = document.createElementNS(SVG, "line");
            line.setAttribute("pathLength", "1");              // lets CSS draw it in whatever its length
            const dot = document.createElementNS(SVG, "circle");
            dot.setAttribute("r", "2.5");
            t.leader.append(line, dot);
            leaders.append(t.leader);
          }
          if (item.id === keepOpen) el.classList.add("pinned");
          tagsEl.append(el);
          tags.set(item.id, t);
        }
        const html = render(item);
        if (html !== t.html) {
          const first = !t.html;
          t.el.innerHTML = html;
          t.html = html;
          if (!first) { t.el.classList.remove("changed"); void t.el.offsetWidth; t.el.classList.add("changed"); }
          if (!t.open()) { t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; }
        }
        t.el.classList.toggle("warn", item.tone === "warn");
        t.el.classList.toggle("minor", !!item.minor);
        t.el.setAttribute("aria-label", `${item.label}: ${item.value}${item.flag ? `, ${item.flag}` : ""}. ${item.detail}`);
      });
      place();
    }

    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".tag")) tags.forEach((t) => t.el.classList.remove("pinned"));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") tags.forEach((t) => { t.el.classList.remove("pinned"); if (document.activeElement === t.el) t.el.blur(); });
    });
    if (window.ResizeObserver) new ResizeObserver(() => { measure(); place(); }).observe(stage);
    stacked.addEventListener("change", () => { measure(); place(); });
    if (document.fonts?.ready) document.fonts.ready.then(() => { measure(); place(); });   // widths change when the serif arrives
    setRunning(true);

    return { set, setRunning, pin(id) { keepOpen = id; tags.get(id)?.el.classList.add("pinned"); } };
  }

  window.TapOrbit = { create };
})();
