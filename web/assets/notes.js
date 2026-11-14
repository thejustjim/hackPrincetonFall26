/* Notes placed around the glass, like annotations on a plate. Each note has a fixed place and
   drifts a few pixels; a hairline runs from it to the part of the glass it describes. Hovering,
   focusing or tapping a note holds everything still and unfolds its explanation, without the
   note's own text moving. Below `stackBelow` pixels wide the notes sit in a plain grid.

   Places are given relative to the glass, so they hold at any window size:
     slots: [{ id, side: -1|1, y, gap, at, ax }]
       y    where the note sits down the glass: 0 = rim, 1 = base
       gap  how far its inner edge stands off the glass, in glass heights
       at   where its line ends down the glass (0 rim .. 1 base), or "surface"
       ax   how far across its line ends: 0 = centre line, 1 = the glass wall
     slots: ["id", ...]   auto layout, alternating sides, no lines

   const notes = TapNotes.create({ stage, cup, tags, leaders, slots });
   notes.set(items, render)     items: [{id, value, label, detail}]
   notes.setShape(shape)        where the glass is inside its canvas (from glass.js) */
(function () {
  "use strict";
  const SVG = "http://www.w3.org/2000/svg";

  function create(opts) {
    const { stage, cup, tags: tagsEl, leaders = null } = opts;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stacked = matchMedia(`(max-width: ${opts.stackBelow || 760}px)`);
    const drift = still ? 0 : opts.drift ?? 4;
    // the glass inside its canvas, as shares of the canvas height (glass.js reports the real values)
    const shape = Object.assign({ top: 0.26, bottom: 0.86, halfTop: 0.233, halfBottom: 0.184, surface: 0.43 }, opts.cupShape);

    const n = opts.slots.length;
    const slots = new Map(opts.slots.map((s, k) => {
      const spec = typeof s === "string"
        ? { id: s, side: k % 2 ? 1 : -1, y: -0.15 + (1.3 * k) / Math.max(1, n - 1), gap: [0.16, 0.34, 0.24, 0.12, 0.3, 0.2, 0.14, 0.28, 0.22][k % 9] }
        : s;
      return [spec.id, Object.assign({ k }, spec)];
    }));

    const tags = new Map();            // id -> {el, leader, html, w, h, hover, open(), x0, y0, ...}
    let geo = null, keepOpen = null, running = true, clock = 0, last = performance.now();

    function measure() {
      const ch = cup.offsetHeight, top = cup.offsetTop;
      const keep = opts.keepLeftEl ? opts.keepLeftEl.offsetLeft + opts.keepLeftEl.offsetWidth : 0;   // a text column to stay clear of
      geo = {
        W: stage.clientWidth, cx: cup.offsetLeft + cup.offsetWidth / 2, ch, keep,
        margin: Math.max(20, opts.margin ? opts.margin() : 20),          // the page's right margin
        rim: top + ch * shape.top, base: top + ch * shape.bottom, surface: top + ch * shape.surface,
        down(f) { return this.rim + (this.base - this.rim) * f; },
        sil(y) {                         // half-width of the glass at this height
          const k = Math.min(1, Math.max(0, (y - this.rim) / (this.base - this.rim)));
          return ch * (shape.halfTop + (shape.halfBottom - shape.halfTop) * k);
        },
      };
      // the width of the label itself: the note's box is as wide as its (folded) explanation
      tags.forEach((t) => { if (!t.open()) { t.w = (t.el.querySelector(".head") || t.el).offsetWidth; t.h = t.el.offsetHeight; } });
      layout();
    }

    /* Where everything rests. Done once per change of size or content, never per frame, so
       nothing flickers as the notes drift. */
    function layout() {
      if (!geo || !cup.offsetHeight || stacked.matches) return;
      const height = geo.base - geo.rim;
      tags.forEach((t, id) => {
        const s = slots.get(id);
        if (!s) return;
        const y0 = geo.down(s.y), wide = Math.max(t.w, opts.openWidth || 0);
        const want = geo.sil(y0) + (s.gap ?? 0.14) * height;
        const room = s.side < 0 ? geo.cx - geo.keep - 20 - wide : geo.W - geo.cx - geo.margin - wide;
        // a note that has no room to open outward is set against the page margin and opens inward;
        // if even its label doesn't fit there, it moves out toward the window edge
        t.flush = s.side > 0 && want > room;
        const edge = Math.max(20, Math.min(geo.margin, geo.W - geo.cx - geo.sil(y0) - 30 - t.w));
        const inner = t.flush ? geo.W - edge - geo.cx : Math.max(geo.sil(y0) + 30, Math.min(want, room));
        t.x0 = geo.cx + s.side * inner;
        t.y0 = y0;
        t.grow = s.grow || (s.y > 0.74 ? "up" : "down");
        t.el.dataset.side = s.side < 0 || t.flush ? "left" : "right";     // "left" = text set against its right edge
        t.el.dataset.grow = t.grow;
        if (t.leader) {
          const ay = s.at === "surface" ? geo.surface : s.at != null ? geo.down(s.at) : Math.min(geo.base, Math.max(geo.rim, y0));
          const ax = s.ax ?? 1;
          t.x2 = geo.cx + s.side * (geo.sil(ay) * ax + (ax >= 1 ? 3 : 0));
          t.y2 = ay;
          t.dx1 = t.flush ? -(t.w + 14) : -s.side * 14;                   // from the note's inner edge
          const length = (t.x0 + t.dx1 - t.x2) * s.side;
          t.leader.style.display = length < 22 ? "none" : "";
        }
      });
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
        if (!s || t.x0 == null) return;
        const x = t.x0 + drift * 0.6 * Math.sin(clock * 0.37 + s.k * 2.1);
        const y = t.y0 + drift * Math.sin(clock * 0.5 + s.k * 1.3);
        // anchored by its inner edge and its resting height, so unfolding never moves the label
        const tx = t.el.dataset.side === "left" ? "-100%" : "0";
        const ty = t.grow === "up" ? `calc(-100% + ${(t.h / 2).toFixed(1)}px)` : `${(-t.h / 2).toFixed(1)}px`;
        t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${tx}, ${ty})`;
        if (t.leader) {
          const [line, dot] = t.leader.children;
          line.setAttribute("x1", (x + t.dx1).toFixed(1)); line.setAttribute("y1", y.toFixed(1));
          line.setAttribute("x2", t.x2.toFixed(1)); line.setAttribute("y2", t.y2.toFixed(1));
          dot.setAttribute("cx", t.x2.toFixed(1)); dot.setAttribute("cy", t.y2.toFixed(1));
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

    function make(item, s) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "tag";
      el.dataset.id = item.id;
      el.style.setProperty("--k", s.k);
      const t = { el, html: "", w: 0, h: 0, hover: false, leader: null, leaving: 0,
                  open: () => t.hover || el.classList.contains("pinned") || document.activeElement === el };
      el.addEventListener("pointerenter", () => { t.hover = true; });
      el.addEventListener("pointerleave", () => { t.hover = false; });
      el.addEventListener("click", () => {
        const was = el.classList.contains("pinned");
        tags.forEach((o) => o.el.classList.remove("pinned"));
        el.classList.toggle("pinned", !was);
        if (was) el.blur();
      });
      if (leaders && s.at != null) {
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
      return t;
    }

    function set(items, render) {
      const ids = new Set(items.map((i) => i.id));
      // a note that no longer applies fades out before it goes
      for (const [id, t] of tags) {
        if (ids.has(id) || t.leaving) continue;
        t.el.classList.add("gone");
        t.leader?.classList.add("gone");
        t.leaving = setTimeout(() => { t.el.remove(); t.leader?.remove(); tags.delete(id); }, 700);
      }
      // keep the notes in the order they are given, so the Tab order follows the page
      const live = [];
      items.forEach((item) => {
        const s = slots.get(item.id);
        if (!s) return;
        let t = tags.get(item.id);
        if (!t) { t = make(item, s); tags.set(item.id, t); }
        if (t.leaving) { clearTimeout(t.leaving); t.leaving = 0; t.el.classList.remove("gone"); t.leader?.classList.remove("gone"); }
        const html = render(item);
        if (html !== t.html) {
          const first = !t.html;
          t.el.innerHTML = html;
          t.html = html;
          if (!first) { t.el.classList.remove("changed"); void t.el.offsetWidth; t.el.classList.add("changed"); }
        }
        t.el.className = `tag${item.tone ? ` ${item.tone}` : ""}${item.minor ? " minor" : ""}${t.el.classList.contains("pinned") ? " pinned" : ""}${t.el.classList.contains("changed") ? " changed" : ""}`;
        t.el.setAttribute("aria-label", `${item.label}: ${item.value}${item.flag ? `, ${item.flag}` : ""}. ${item.detail}`);
        live.push(t.el);
      });
      live.forEach((el, i) => { if (tagsEl.children[i] !== el) tagsEl.insertBefore(el, tagsEl.children[i] || null); });
      measure();
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

    return {
      set, setRunning,
      setShape(s) { Object.assign(shape, s); measure(); place(); },
      pin(id) { keepOpen = id; tags.get(id)?.el.classList.add("pinned"); },
    };
  }

  window.TapNotes = { create };
})();
