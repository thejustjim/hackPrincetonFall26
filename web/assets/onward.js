/* The end of the cup page leads on to the map. Scroll to the bottom and keep going (the wheel, a swipe
   or the down keys) and the page hands over to it, the way the pitch hands over to this page. The
   words are a link too.

   It asks for a push that begins after the page has come to rest at the bottom, so the tail of the
   scroll that got you there does not carry you off. The map opens with its simulated network showing
   and without its start screen, on the same data as this page (the header's Map link says which). */
(function () {
  "use strict";
  const foot = document.querySelector(".colophon");
  if (!foot) return;
  const NEED = 260, root = document.documentElement;
  const el = document.createElement("section");
  el.className = "onward";
  el.innerHTML = '<a class="onward-link" href="../map/"><span class="onward-word">The map</span><span class="onward-hint">Keep scrolling</span></a><i class="onward-bar" aria-hidden="true"></i>';
  foot.after(el);
  const link = el.querySelector("a"), bar = el.querySelector(".onward-bar");
  const url = () => {
    const u = new URL(document.querySelector("a[data-map]")?.getAttribute("href") || "../map/", location.href);
    u.searchParams.set("simulation", "1");
    u.searchParams.set("nointro", "1");
    return u.pathname + u.search;
  };
  const atEnd = () => innerHeight + scrollY >= root.scrollHeight - 2;
  let push = 0, gone = false, armed = false, rest = 0, fade = 0;
  const show = () => { bar.style.transform = `scaleX(${Math.min(1, push / NEED)})`; };
  function settle() {                                   // armed once nothing has moved for a moment at the bottom
    armed = false;
    clearTimeout(rest);
    rest = setTimeout(() => { armed = atEnd(); }, 320);
  }
  function go() {
    if (gone) return;
    gone = true;
    link.href = url();
    root.classList.add("leaving");
    setTimeout(() => { location.href = link.href; }, 450);
  }
  function add(amount) {
    if (gone || root.classList.contains("pitching")) return;
    if (!atEnd() || !armed) { settle(); return; }
    push += amount;
    show();
    clearTimeout(fade);
    fade = setTimeout(() => { push = 0; show(); }, 1100);
    if (push >= NEED) go();
  }
  addEventListener("scroll", () => { if (!atEnd()) { armed = false; push = 0; show(); } else if (!armed) settle(); }, { passive: true });
  addEventListener("wheel", (e) => { if (e.deltaY > 0) add(Math.min(e.deltaY, 120)); }, { passive: true });
  let lastY = null;
  addEventListener("touchstart", (e) => { lastY = e.touches[0].clientY; }, { passive: true });
  addEventListener("touchmove", (e) => { const y = e.touches[0].clientY; if (lastY != null && lastY - y > 0) add((lastY - y) * 1.6); lastY = y; }, { passive: true });
  addEventListener("keydown", (e) => {
    if (["ArrowDown", "PageDown", " ", "End"].includes(e.key) && !e.target.closest?.("input, textarea, select, button, a")) add(100);
  });
  link.addEventListener("click", (e) => { e.preventDefault(); go(); });
})();
