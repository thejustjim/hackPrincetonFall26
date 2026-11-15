/* A browser-local choice between a real prototype and clearly labelled sample data.
   No device assignment, cloud write, remote geocoder or automatic geolocation request. */
(function () {
  "use strict";
  const KEY = "clarity-setup-v1", root = document.documentElement;
  const here = document.currentScript.src;
  const PRINCETON = { name: "Princeton, New Jersey", lat: 40.3467, lon: -74.6553 };
  let memory = null, pending = null, places = [PRINCETON], loadingPlaces = null;
  const nameOf = (s) => typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, 120) : "";
  const validName = (s) => s.length >= 2 && /[\p{L}\p{N}]/u.test(s);
  function validate(value) {
    if (!value || value.version !== 1 || !["prototype", "demo"].includes(value.mode)) return null;
    const name = nameOf(value.location?.name);
    if (!validName(name)) return null;
    const location = { name }, lat = value.location.lat, lon = value.location.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) Object.assign(location, { lat, lon });
    return { version: 1, mode: value.mode, location, demoView: value.demoView === "network" ? "network" : "cup" };
  }
  function read() {
    try { return validate(JSON.parse(localStorage.getItem(KEY))) || memory; }
    catch (_) { return memory; }
  }
  function destination(choice) {
    const v = validate(choice);
    if (!v) throw new Error("Choose a place or a demo first.");
    const url = new URL(v.mode === "demo" && v.demoView === "network" ? "../map/" : "../demo/", here);
    if (v.mode === "demo") url.search = v.demoView === "network" ? "?mock=1&simulation=1&nointro" : "?demo&mode=demo";
    else {
      url.searchParams.set("mode", "prototype");
      const api = new URLSearchParams(location.search).get("api");
      if (api) url.searchParams.set("api", api);
    }
    return url.href;
  }
  function pitchDestination() {
    const url = new URL("../pitch/", here), api = new URLSearchParams(location.search).get("api");
    if (api) url.searchParams.set("api", api);
    return url.href;
  }
  function previousOption(index, count) {
    return index < 0 ? count - 1 : (index - 1 + count) % count;
  }
  function loadPlaces() {
    if (!loadingPlaces) loadingPlaces = fetch(new URL("../map/data/places.json", here)).then((r) => r.ok ? r.json() : null).then((data) => {
      const seen = new Set(places.map((p) => p.name.toLocaleLowerCase()));
      for (const f of data?.features || []) {
        const name = nameOf(f.properties?.n || f.properties?.name), xy = f.geometry?.coordinates;
        if (!validName(name) || !Array.isArray(xy) || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
        const key = name.toLocaleLowerCase();
        if (!seen.has(key)) { places.push({ name, lat: xy[1], lon: xy[0] }); seen.add(key); }
      }
    }).catch(() => {});
    return loadingPlaces;
  }
  function choose(options = {}) {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const saved = read();
      let mode = saved?.mode || "prototype", selected = saved?.mode === "prototype" ? saved.location : null;
      let matches = [], active = -1, locating = false;
      const dialog = document.createElement("dialog");
      dialog.className = "setup-screen";
      dialog.setAttribute("aria-labelledby", "setup-title");
      dialog.innerHTML = `
        <div class="setup-shell">
          <header class="setup-top">
            <a class="wordmark" href="${pitchDestination()}" aria-label="Clarity — return to the pitch"><img class="logo" src="${new URL("brand/clarity-logo.png", here).href}" width="348" height="132" alt="Clarity"></a>
            <p>Before the first pour</p>
          </header>
          <form class="setup-form" novalidate>
            <nav class="setup-paths" aria-label="Choose how to begin">
              <button type="button" data-setup-mode="prototype">Test the prototype <span>01</span></button>
              <button type="button" data-setup-mode="demo">Explore a demo <span>02</span></button>
            </nav>
            <div class="setup-content" data-setup-panel="prototype">
              <p class="setup-eyebrow">One cup. Your place.</p>
              <h1 id="setup-title">I’m testing the<br>prototype <em>in</em></h1>
              <div class="setup-place">
                <label class="visually-hidden" for="setup-location">Where are you testing the prototype?</label>
                <input id="setup-location" type="text" autocomplete="off" autocapitalize="words" maxlength="120" placeholder="your city or place" role="combobox" aria-autocomplete="list" aria-controls="setup-places" aria-expanded="false" aria-describedby="setup-place-hint">
                <ul id="setup-places" class="setup-places" role="listbox" aria-label="Nearby place suggestions" hidden></ul>
              </div>
              <div class="setup-location-tools"><button class="setup-locate" type="button">Use my current location <span aria-hidden="true">↗</span></button><span class="setup-coordinates"></span></div>
              <p class="setup-place-hint" id="setup-place-hint">Suggestions near Princeton. You can type any place.</p>
            </div>
            <div class="setup-content setup-demo" data-setup-panel="demo" hidden>
              <p class="setup-eyebrow">Demo data · no hardware required</p>
              <h1>Explore the idea.<br><em>Follow what changes.</em></h1>
              <p class="setup-description">A sample cup, or a simulated water network. Start in Princeton and see how Clarity works.</p>
              <fieldset class="setup-demo-choices"><legend class="visually-hidden">Choose a demo</legend>
                <label><input type="radio" name="setup-demo-view" value="cup" checked><span><b>Follow a cup</b><small>Measure, choose a filter, and compare the retest.</small></span><i aria-hidden="true">↗</i></label>
                <label><input type="radio" name="setup-demo-view" value="network"><span><b>Explore the network</b><small>Trace events and compare sensor placement.</small></span><i aria-hidden="true">↗</i></label>
              </fieldset>
            </div>
            <p class="setup-status" role="status" aria-live="polite"></p>
            <footer class="setup-actions"><button class="setup-continue" type="submit"><span>Open my test</span><i aria-hidden="true">→</i></button></footer>
          </form>
          <div class="setup-orbit" aria-hidden="true"><svg viewBox="0 0 520 520"><circle cx="260" cy="260" r="230"/><ellipse cx="260" cy="260" rx="104" ry="230"/><ellipse cx="260" cy="260" rx="230" ry="88"/><path d="M30 260h460M260 30v460"/><circle class="setup-orbit-dot" cx="367" cy="184" r="5"/></svg></div>
        </div>`;
      const $ = (s) => dialog.querySelector(s), input = $("#setup-location"), list = $("#setup-places"), status = $(".setup-status"), submit = $(".setup-continue"), locate = $(".setup-locate");
      input.value = selected?.name || "";
      if (saved?.demoView === "network") $("input[value=network]").checked = true;
      function closeSuggestions() {
        matches = []; active = -1; list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
      }
      function update() {
        const prototype = mode === "prototype";
        dialog.dataset.mode = mode;
        dialog.querySelectorAll("[data-setup-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.setupMode === mode)));
        dialog.querySelectorAll("[data-setup-panel]").forEach((panel) => { panel.hidden = panel.dataset.setupPanel !== mode; });
        dialog.setAttribute("aria-labelledby", prototype ? "setup-title" : "setup-demo-title");
        $(".setup-demo h1").id = "setup-demo-title";
        const view = $("input[name=setup-demo-view]:checked").value;
        submit.querySelector("span").textContent = prototype ? "Open my test" : view === "network" ? "Explore the network" : "Follow a sample cup";
        submit.disabled = prototype && !validName(nameOf(input.value));
        $(".setup-coordinates").textContent = selected?.lat != null ? `${Math.abs(selected.lat).toFixed(3)}° ${selected.lat < 0 ? "S" : "N"} · ${Math.abs(selected.lon).toFixed(3)}° ${selected.lon < 0 ? "W" : "E"}` : "";
      }
      function selectPlace(place) {
        selected = { ...place }; input.value = place.name; status.textContent = ""; closeSuggestions(); update();
      }
      function suggestions() {
        const q = nameOf(input.value).toLocaleLowerCase();
        if (q.length < 2) { closeSuggestions(); return; }
        matches = places.filter((p) => p.name.toLocaleLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(q)) - Number(!b.name.toLocaleLowerCase().startsWith(q))).slice(0, 5);
        active = -1; list.replaceChildren();
        matches.forEach((place, index) => {
          const option = document.createElement("li"); option.id = `setup-place-${index}`; option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false"); option.textContent = place.name;
          option.addEventListener("pointerdown", (event) => event.preventDefault()); option.addEventListener("click", () => selectPlace(place)); list.append(option);
        });
        list.hidden = !matches.length; input.setAttribute("aria-expanded", String(!!matches.length)); input.removeAttribute("aria-activedescendant");
      }
      function activate(index) {
        active = index; [...list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === active)));
        input.setAttribute("aria-activedescendant", `setup-place-${active}`);
      }
      dialog.querySelectorAll("[data-setup-mode]").forEach((button) => button.addEventListener("click", () => { mode = button.dataset.setupMode; status.textContent = ""; closeSuggestions(); update(); }));
      dialog.querySelectorAll("input[name=setup-demo-view]").forEach((radio) => radio.addEventListener("change", update));
      input.addEventListener("input", () => { if (selected && selected.name !== nameOf(input.value)) selected = null; status.textContent = ""; update(); suggestions(); });
      input.addEventListener("focus", () => { loadPlaces().then(() => { if (document.activeElement === input) suggestions(); }); });
      input.addEventListener("blur", () => setTimeout(closeSuggestions, 100));
      input.addEventListener("keydown", (event) => {
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
          event.preventDefault(); activate(event.key === "ArrowDown" ? (active + 1) % matches.length : previousOption(active, matches.length));
        } else if (event.key === "Enter" && active >= 0 && matches[active]) { event.preventDefault(); selectPlace(matches[active]); }
        else if (event.key === "Escape" && !list.hidden) { event.preventDefault(); event.stopPropagation(); closeSuggestions(); }
      });
      locate.addEventListener("click", () => {
        if (locating) return;
        if (!navigator.geolocation) { status.textContent = "Location is unavailable here. Type a place instead."; return; }
        locating = true; locate.disabled = true; locate.firstChild.textContent = "Finding your location "; status.textContent = "Your browser will ask for location access.";
        navigator.geolocation.getCurrentPosition((position) => {
          locating = false; locate.disabled = false; locate.firstChild.textContent = "Use my current location ";
          selectPlace({ name: "My current location", lat: position.coords.latitude, lon: position.coords.longitude });
        }, () => { locating = false; locate.disabled = false; locate.firstChild.textContent = "Use my current location "; status.textContent = "Location wasn’t shared. You can type a place instead."; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
      });
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); status.textContent = "Choose a place or explore the demo to begin."; });
      dialog.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const focusable = [...dialog.querySelectorAll("a,button,input")].filter((el) => !el.disabled && el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
      // The demo's smooth wheel handler must not move the page behind this modal.
      dialog.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
      $("form").addEventListener("submit", (event) => {
        event.preventDefault();
        const name = nameOf(input.value);
        if (mode === "prototype" && !validName(name)) { status.textContent = "Enter a city or place to begin."; input.focus(); return; }
        const value = validate({ version: 1, mode, location: mode === "prototype" ? { ...(selected || {}), name } : PRINCETON, demoView: $("input[name=setup-demo-view]:checked").value });
        let stored = false;
        try { localStorage.setItem(KEY, JSON.stringify(value)); stored = true; } catch (_) {}
        if (!stored && mode === "prototype") { status.textContent = "Your browser couldn’t save this place. Allow browser storage, or explore the demo."; return; }
        memory = value;
        window.dispatchEvent(new CustomEvent("clarity:setup", { detail: value }));
        dialog.close?.(); dialog.remove(); root.classList.remove("setup-open", "setup-pending"); pending = null; resolve(value);
      });
      document.body.append(dialog); root.classList.add("setup-open"); root.classList.remove("setup-pending"); update();
      try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); dialog.setAttribute("aria-modal", "true"); }
      (mode === "prototype" ? input : $("input[name=setup-demo-view]:checked")).focus({ preventScroll: true });
    });
    return pending;
  }
  window.ClaritySetup = { read, choose, destination, validate };
  // This explicit entry point renders before data.js/app.js boot; an ordinary direct reload
  // keeps the existing flow. The post-pitch caller always asks again and prefills the saved place.
  if (new URLSearchParams(location.search).get("setup") === "1" && !root.classList.contains("pitching")) {
    choose().then((choice) => location.replace(destination(choice)));
  }
})();
