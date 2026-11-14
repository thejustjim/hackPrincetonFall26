/* Small labels that float around the cup, like notes pinned around an object on a turntable.
   The cup turns; the labels keep their places on either side of it and drift a few pixels,
   so nothing ever crosses the cup or another label. Hovering, focusing or tapping a label
   holds everything still and opens its explanation. On phones they sit in a plain grid.

   const notes = TapOrbit.create({ stage, cup, tags, leaders, slots: [...ids] });
   notes.set(items, render)   // items: [{id, value, label, detail}], render(item) -> innerHTML */
(function () {
  "use strict";

  function create(opts) {
    const { stage, cup, tags: tagsEl, leaders = null, slots } = opts;
    const n = slots.length;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phone = matchMedia("(max-width: 760px)");
    const tags = new Map();                            // id -> {el, line, html, w, hover, open()}
    let geo = null, keepOpen = null, running = true, clock = 0, last = performance.now();

    // where the cup sits inside its canvas (fractions of the canvas height; set by hero3d's camera)
    const CUP = Object.assign({ top: 0.34, bottom: 0.76, halfTop: 0.163, halfBottom: 0.128 }, opts.cupShape);
    // how far out each slot sits, as a share of the reach: an uneven scatter reads as placed by hand
    const FAR = [0.8, 0.94, 1.0, 0.72, 0.86, 1.0, 0.76, 0.9, 0.84];

    function measure() {
      const W = stage.clientWidth, ch = cup.offsetHeight;
      const cx = cup.offsetLeft + cup.offsetWidth / 2, top = cup.offsetTop;
      const tagHalf = opts.tagHalf || 110;
      const keep = opts.keepLeftEl ? opts.keepLeftEl.offsetLeft + opts.keepLeftEl.offsetWidth : 0;   // e.g. a text column to stay clear of
      geo = {
        cx, ch, tagHalf,
        reachL: Math.max(160, Math.min(cx - keep - tagHalf - 16, ch * (opts.reach || 0.62))),
        reachR: Math.max(160, Math.min(W - cx - tagHalf - 16, ch * (opts.reach || 0.62))),
        rowTop: top + ch * (opts.rowTop ?? 0.25), rowBottom: top + ch * (opts.rowBottom ?? 0.9),
        cupTop: top + ch * CUP.top, cupBottom: top + ch * CUP.bottom,
        sil(y) {                                         // half-width of the cup at this height
          const k = Math.min(1, Math.max(0, (y - this.cupTop) / (this.cupBottom - this.cupTop)));
          return ch * (CUP.halfTop + (CUP.halfBottom - CUP.halfTop) * k);
        },
      };
      tags.forEach((t) => { if (!t.open()) t.w = t.el.offsetWidth; });
    }

    const held = () => { for (const t of tags.values()) if (t.open()) return true; return false; };

    function place() {
      if (!geo) measure();
      if (!cup.offsetHeight) return;                     // hero not laid out (hidden)
      if (phone.matches) {
        tags.forEach((t) => { t.el.style.transform = ""; if (t.line) t.line.style.opacity = 0; });
        return;
      }
      tags.forEach((t, id) => {
        const k = slots.indexOf(id);
        const side = k % 2 ? 1 : -1;                     // alternate left and right, top to bottom
        const y0 = geo.rowTop + ((geo.rowBottom - geo.rowTop) * k) / (n - 1);
        const reach = side < 0 ? geo.reachL : geo.reachR;
        const out = Math.max(reach * FAR[k % FAR.length], geo.sil(y0) + t.w / 2 + 64);
        const x = geo.cx + side * out + (still ? 0 : 4 * Math.sin(clock * 0.37 + k * 2.1));
        const y = y0 + (still ? 0 : 5 * Math.sin(clock * 0.5 + k * 1.3));
        t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        if (t.line) {
          const yc = Math.min(geo.cupBottom, Math.max(geo.cupTop, y));
          const x1 = x - side * (t.w / 2 + 10), x2 = geo.cx + side * (geo.sil(yc) + 12);
          t.line.setAttribute("x1", x1.toFixed(1)); t.line.setAttribute("y1", y.toFixed(1));
          t.line.setAttribute("x2", x2.toFixed(1)); t.line.setAttribute("y2", yc.toFixed(1));
          t.line.style.opacity = t.open() || (x1 - x2) * side < 18 ? 0 : 0.42;
        }
      });
    }

    let raf = 0;
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!held()) clock += dt;                          // everything holds still while a label is open
      place();
      raf = running ? requestAnimationFrame(frame) : 0;
    }
    function setRunning(on) {
      running = on;
      if (on && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }

    function set(items, render) {
      const ids = new Set(items.map((i) => i.id));
      for (const [id, t] of tags) if (!ids.has(id)) { t.el.remove(); t.line?.remove(); tags.delete(id); }
      items.forEach((item) => {
        let t = tags.get(item.id);
        if (!t) {
          const el = document.createElement("button");
          el.type = "button";
          el.className = "tag";
          el.dataset.id = item.id;
          el.style.setProperty("--k", slots.indexOf(item.id));
          t = { el, html: "", w: 0, hover: false, line: null,
                open: () => t.hover || el.classList.contains("pinned") || document.activeElement === el };
          el.addEventListener("pointerenter", () => { t.hover = true; });
          el.addEventListener("pointerleave", () => { t.hover = false; });
          el.addEventListener("click", () => {
            const was = el.classList.contains("pinned");
            tags.forEach((o) => o.el.classList.remove("pinned"));
            el.classList.toggle("pinned", !was);
            if (was) el.blur();
          });
          if (leaders) {
            t.line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            leaders.append(t.line);
          }
          if (item.id === keepOpen) el.classList.add("pinned");
          tagsEl.append(el);
          tags.set(item.id, t);
        }
        const html = render(item);
        if (html !== t.html) { t.el.innerHTML = html; t.html = html; if (!t.open()) t.w = t.el.offsetWidth; }
        t.el.setAttribute("aria-label", `${item.label}: ${item.value}. ${item.detail}`);
      });
      place();
    }

    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".tag")) tags.forEach((t) => t.el.classList.remove("pinned"));
    });
    if (window.ResizeObserver) new ResizeObserver(() => { measure(); place(); }).observe(stage);
    phone.addEventListener("change", () => { measure(); place(); });
    setRunning(true);

    return { set, setRunning, pin(id) { keepOpen = id; tags.get(id)?.el.classList.add("pinned"); } };
  }

  window.TapOrbit = { create };
})();
