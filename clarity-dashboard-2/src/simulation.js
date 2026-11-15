const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n, total) => total ? Math.round(100 * n / total) : 0;
const minutes = n => n == null ? '—' : `${Math.round(n)} min`;

// Schematic coordinates stay in this diagram. The separately labeled map overlay uses its own illustrative transform.
export function graphPositions(nodes, width = 960, height = 600) {
  const valid = nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (!valid.length) return new Map();
  const xs = valid.map(n => n.x), ys = valid.map(n => n.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const scale = Math.min((width - 90) / Math.max(1, x1 - x0), (height - 80) / Math.max(1, y1 - y0));
  const ox = (width - (x1 - x0) * scale) / 2, oy = (height - (y1 - y0) * scale) / 2;
  return new Map(valid.map(n => [String(n.id), { x: ox + (n.x - x0) * scale, y: height - oy - (n.y - y0) * scale }]));
}

export function scenarioSensorState(id, scenario, sensors) {
  id = String(id);
  if ((scenario?.unavailable || []).map(String).includes(id)) return 'unavailable';
  if ((scenario?.alerts || []).some(a => String(a.sensor) === id)) return 'alert';
  if ((scenario?.quiet || []).map(String).includes(id)) return 'quiet';
  return sensors.map(String).includes(id) ? scenario?.replaying ? 'waiting' : 'quiet' : 'junction';
}

export function coverageComparison(plan, existing) {
  const m = plan?.metrics || {}, base = existing?.metrics || {}, total = m.events || base.events || 0;
  return { total, observed: m.observed || 0, corroborated: m.localized || 0,
    observedPct: pct(m.observed, total), corroboratedPct: pct(m.localized, total),
    baselineObserved: base.observed || 0, baselineCorroborated: base.localized || 0,
    delay: m.mean_capped_first_alert_min, baselineDelay: base.mean_capped_first_alert_min };
}

export const REPLAY_DURATION_MS = 24000;
export function replayMinuteAt(startMinute, elapsedMs, horizon = 360) {
  return Math.min(horizon, Math.max(0, startMinute + Math.max(0, elapsedMs) * horizon / REPLAY_DURATION_MS));
}
export function observationHorizon(scenario, modelWindow = 360) {
  return Math.max(modelWindow, ...(scenario?.alerts || []).map(a => Number.isFinite(a.minute) ? Math.ceil(a.minute) : 0));
}
export function scenarioAtTime(scenario, minute, sensors, modelWindow = 360) {
  if (!scenario) return null;
  const horizon = observationHorizon(scenario, modelWindow);
  const t = Math.max(0, Math.min(horizon, minute)), complete = t >= horizon;
  const alerts = (scenario.alerts || []).filter(a => a.minute <= t), unavailable = scenario.unavailable || [];
  const seen = new Set([...alerts.map(a => String(a.sensor)), ...unavailable.map(String)]);
  return { ...scenario, alerts, unavailable, quiet: complete ? scenario.quiet || [] : [],
    waiting: complete ? [] : sensors.filter(id => !seen.has(String(id))),
    candidates: complete ? scenario.candidates || [] : [], fit_quality: complete ? scenario.fit_quality : 'pending',
    complete, replaying: !complete, minute: t,
    summary: complete ? scenario.summary : `${alerts.length} sensors have alerted by model minute ${Math.floor(t)}. The remaining available sensors are still being observed; a quiet reading is confirmed only when the observation window ends.` };
}
const validNetwork = n => n?.simulated === true && Array.isArray(n.nodes) && n.nodes.length > 0 && Array.isArray(n.pipes) &&
  Array.isArray(n.sensors) && Array.isArray(n.scenarios) && n.scenarios.length > 0 && n.scenarios.every(s =>
    s && typeof s.id === 'string' && Array.isArray(s.alerts) && Array.isArray(s.quiet) && Array.isArray(s.candidates));
const validMetrics = m => m && Number.isFinite(m.events) && Number.isFinite(m.observed) && Number.isFinite(m.localized);
const validPlacement = p => p?.simulated === true && Array.isArray(p.nodes) && p.nodes.length > 0 && Array.isArray(p.pipes) &&
  Array.isArray(p.existing?.sensors) && validMetrics(p.existing.metrics) && Array.isArray(p.budgets) && p.budgets.length > 0 &&
  p.budgets.every(b => b && Number.isFinite(b.budget) && Array.isArray(b.sensors) && validMetrics(b.metrics));

// Publish the included snapshots synchronously. Independent optional refreshes must
// never block a working incident view on a slow or unavailable placement endpoint.
export function createSimulationLoader({ network, placement, refreshNetwork, refreshPlacement, onData }) {
  let current = { network: validNetwork(network) ? network : null, placement: validPlacement(placement) ? placement : null }, pending = null;
  return { load() {
    onData(current);
    if (pending) return pending;
    if (!refreshNetwork && !refreshPlacement) return Promise.resolve(current);
    pending = Promise.allSettled([
      refreshNetwork ? Promise.resolve().then(refreshNetwork) : Promise.resolve(null),
      refreshPlacement ? Promise.resolve().then(refreshPlacement) : Promise.resolve(null),
    ]).then(([n, p]) => {
      current = { network: n.status === 'fulfilled' && validNetwork(n.value) ? n.value : current.network,
        placement: p.status === 'fulfilled' && validPlacement(p.value) ? p.value : current.placement };
      pending = null; onData(current); return current;
    });
    return pending;
  } };
}

export function installSimulation({ apiBase = '', mock = false, fallbackNetwork, fallbackPlacement, chooseTab, onOpen = () => {}, onChange = () => {} }) {
  const panel = document.querySelector('#panel'), mapWrap = document.querySelector('.mapwrap');
  const tab = document.createElement('button');
  tab.className = 'tab'; tab.dataset.tab = 'sim'; tab.textContent = 'Simulation';
  panel.querySelector('.tabs').append(tab);
  const launcher = document.createElement('button');
  launcher.id = 'btn-simulation'; launcher.className = 'tool'; launcher.type = 'button'; launcher.textContent = 'Simulations';
  launcher.addEventListener('click', () => chooseTab('sim'));
  document.querySelector('.mapbar').append(launcher);
  const body = document.createElement('div'); body.id = 'tab-sim'; body.className = 'tab-body hidden';
  body.innerHTML = `<p class="sim-kicker">Simulation, not measurements</p><h2 class="sim-heading">Explore the network</h2>
    <p class="sim-intro">A simulated network over Princeton. Connections are illustrative, not verified pipe routes.</p>
    <div class="sim-views seg" role="group" aria-label="Network view"><button type="button" data-view="map" class="on">On the demo map</button><button type="button" data-view="schematic">Schematic</button></div>
    <div class="sim-modes seg" role="group" aria-label="Simulation view"><button type="button" data-mode="events" class="on">Incident replay</button><button type="button" data-mode="placement">Sensor placement</button></div>
    <div class="sim-event-controls"><label class="sim-control" for="sim-scenario">Made-up event<select id="sim-scenario"></select></label><p id="sim-description" class="sim-small"></p>
      <div class="sim-replay-controls"><button type="button" class="tool" id="sim-play">Replay event</button><output id="sim-clock" for="sim-time">Model minute 360 / 360</output></div>
      <label class="sim-control" for="sim-time">Observation timeline<input id="sim-time" type="range" min="0" max="360" value="360" step="1" /></label>
      <p class="sim-small">A 24-second replay. The clock shows simulated minutes.</p></div>
    <div class="sim-placement-controls hidden"><label class="sim-control" for="sim-budget">Sensor budget<select id="sim-budget"></select></label><p class="sim-small">Recommendations favor coverage, a second sensor, then earlier alerts. All sites have equal assumed cost.</p></div>
    <div id="sim-details" aria-live="polite"><p class="sim-small">Loading the simulation…</p></div>`;
  panel.append(body);
  const stage = document.createElement('section'); stage.className = 'sim-stage hidden'; stage.setAttribute('aria-label', 'Simulated water network');
  stage.innerHTML = `<header class="sim-stage-head"><div><p class="sim-kicker">Simulated overlay · illustrative connections</p><h2 id="sim-stage-title">Incident replay</h2></div><button type="button" class="tool" data-back-map>Back to map</button></header>
    <div class="sim-graph" id="sim-graph"></div><div class="sim-legend" id="sim-legend"></div><p id="sim-selection" class="sim-selection" aria-live="polite">Choose a sensor or pipe to inspect it.</p>`;
  mapWrap.append(stage);
  const overlayBanner = document.createElement('p'); overlayBanner.className = 'sim-overlay-banner hidden';
  overlayBanner.textContent = 'Simulated overlay · illustrative connections'; mapWrap.append(overlayBanner);
  stage.querySelector('[data-back-map]').addEventListener('click', () => chooseTab('ov'));
  let network = null, placement = null, mode = 'events', view = 'map', isOpen = false, overlayActive = false, scenarioId = '', budget = 12, revealed = false, picked = null;
  let replayMinute = 360, playing = false, raf = 0, lastMinute = -1, lastOverlayMinute = -1;
  const replayButton = body.querySelector('#sim-play'), replayInput = body.querySelector('#sim-time'), replayClock = body.querySelector('#sim-clock');
  const horizon = () => observationHorizon(selectedScenario(), placement?.model?.horizon_min || 360);
  const visibleScenario = () => scenarioAtTime(selectedScenario(), replayMinute, network?.sensors || [], horizon());
  function snapshot() { return { open: isOpen, overlayActive, view, mode, network, placement, scenario: selectedScenario(), visibleScenario: visibleScenario(), plan: selectedPlan(), picked, selected: picked, revealed, reveal: revealed, replayMinute, replaying: playing }; }
  const notify = () => {
    if (isOpen && view === 'map' && network) overlayActive = true;
    if (view === 'schematic') overlayActive = false;
    overlayBanner.classList.toggle('hidden', !overlayActive || isOpen);
    onChange(snapshot());
  };
  function pauseReplay() { playing = false; if (raf) cancelAnimationFrame(raf); raf = 0; updateReplayControls(); }
  function updateReplayControls() {
    replayButton.textContent = playing ? 'Pause replay' : replayMinute >= horizon() ? 'Replay event' : 'Resume replay';
    replayButton.disabled = !network;
    replayInput.max = String(horizon()); replayInput.value = String(Math.floor(replayMinute));
    replayClock.textContent = `Model minute ${Math.floor(replayMinute)} / ${horizon()}`;
  }
  function paintReplay() {
    updateReplayControls();
    const visible = visibleScenario(); if (!visible) return;
    graph.querySelectorAll('[data-node]').forEach(el => {
      const status = scenarioSensorState(el.dataset.node, visible, network.sensors);
      const cls = `sim-node ${status}${picked?.kind === 'node' && picked.id === el.dataset.node ? ' selected' : ''}`;
      if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
      el.setAttribute('aria-label', `Simulated junction ${el.dataset.node}, ${status}`);
    });
    for (const [key, count] of Object.entries({ alerts: visible.alerts.length, quiet: visible.quiet.length, unavailable: visible.unavailable.length, waiting: visible.waiting.length })) {
      const el = details.querySelector(`[data-replay-count="${key}"]`); if (el) el.textContent = String(count);
    }
    const progress = details.querySelector('[data-replay-status]'); if (progress) progress.textContent = visible.summary;
    renderSelection();
    // Overlay geometry changes only when sensor evidence changes, not on every animation frame.
    if (Math.floor(replayMinute / 3) !== lastOverlayMinute) { lastOverlayMinute = Math.floor(replayMinute / 3); notify(); }
  }
  function playReplay() {
    if (playing) { pauseReplay(); notify(); return; }
    if (!network || mode !== 'events') return;
    if (replayMinute >= horizon()) { replayMinute = 0; revealed = false; }
    playing = true; lastMinute = -1; lastOverlayMinute = -1;
    const started = performance.now(), startMinute = replayMinute;
    render();
    const tick = now => {
      if (!playing || !isOpen) return;
      replayMinute = replayMinuteAt(startMinute, now - started, horizon());
      if (replayMinute >= horizon()) { pauseReplay(); render(); return; }
      if (Math.floor(replayMinute) !== lastMinute) { lastMinute = Math.floor(replayMinute); paintReplay(); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  replayButton.addEventListener('click', playReplay);
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) { pauseReplay(); notify(); } });
  replayInput.addEventListener('input', () => {
    const next = Number(replayInput.value), wasComplete = replayMinute >= horizon(); pauseReplay(); replayMinute = next;
    if (wasComplete !== (replayMinute >= horizon())) render(); else { paintReplay(); notify(); }
  });
  const scenarioSelect = body.querySelector('#sim-scenario'), budgetSelect = body.querySelector('#sim-budget');
  const details = body.querySelector('#sim-details'), graph = stage.querySelector('#sim-graph');

  async function fetchData(apiPath, staticPath, validate) {
    const urls = [apiBase + apiPath, new URL(staticPath, location.href).href];
    for (const url of urls) {
      const controller = new AbortController(); let timeout;
      try {
        const response = await Promise.race([fetch(url, { signal: controller.signal }), new Promise((_, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new Error('Simulation refresh timed out')); }, 2000);
        })]);
        if (response.ok) { const data = await response.json(); if (validate(data)) return data; }
      } catch { /* keep the already-visible prepared snapshot */ }
      finally { clearTimeout(timeout); }
    }
    throw new Error('Simulation refresh unavailable');
  }
  const loader = createSimulationLoader({ network: fallbackNetwork, placement: fallbackPlacement,
    refreshNetwork: mock ? null : () => fetchData('/api/network', '../network/data.json', validNetwork),
    refreshPlacement: mock ? null : () => fetchData('/api/network/placement', '../network/placement.json', validPlacement),
    onData(data) {
      network = data.network; placement = data.placement;
      if (network) {
        if (!network.scenarios.some(s => s.id === scenarioId)) scenarioId = network.scenarios[0].id;
        scenarioSelect.innerHTML = network.scenarios.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
        scenarioSelect.value = scenarioId;
      }
      if (placement) {
        if (!placement.budgets.some(b => b.budget === budget)) budget = placement.budgets[0].budget;
        budgetSelect.innerHTML = placement.budgets.map(b => `<option value="${b.budget}">${b.budget} sensors</option>`).join('');
        budgetSelect.value = String(budget);
      }
      render();
    },
  });
  scenarioSelect.addEventListener('change', () => { pauseReplay(); scenarioId = scenarioSelect.value; replayMinute = horizon(); revealed = false; picked = null; render(); });
  budgetSelect.addEventListener('change', () => { budget = Number(budgetSelect.value); picked = null; render(); });
  body.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    pauseReplay(); mode = button.dataset.mode; picked = null; render();
  }));
  body.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; render(); }));
  body.addEventListener('click', event => {
    const pipe = event.target.closest('[data-sim-pipe]');
    if (pipe) { picked = { kind: 'pipe', id: pipe.dataset.simPipe }; renderGraph(); renderSelection(); notify(); }
    if (event.target.closest('[data-reveal-source]') && replayMinute >= horizon()) { revealed = !revealed; render(); }
  });
  const pickGraph = event => {
    const target = event.target.closest('[data-pipe],[data-node]');
    if (!target) return;
    picked = target.dataset.pipe ? { kind: 'pipe', id: target.dataset.pipe } : { kind: 'node', id: target.dataset.node };
    renderGraph(); renderSelection(); notify();
    if (event.type === 'keydown') [...graph.querySelectorAll('[data-pipe],[data-node]')].find(el =>
      picked.kind === 'pipe' ? el.dataset.pipe === picked.id : el.dataset.node === picked.id)?.focus();
  };
  graph.addEventListener('click', pickGraph);
  graph.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pickGraph(event); } });
  function selectedScenario() { return network?.scenarios?.find(s => s.id === scenarioId); }
  function selectedPlan() { return placement?.budgets?.find(p => p.budget === budget); }

  function render() {
    body.querySelectorAll('[data-mode]').forEach(b => { b.classList.toggle('on', b.dataset.mode === mode); b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); });
    body.querySelector('.sim-event-controls').classList.toggle('hidden', mode !== 'events');
    body.querySelector('.sim-placement-controls').classList.toggle('hidden', mode !== 'placement');
    stage.querySelector('#sim-stage-title').textContent = mode === 'events' ? 'Where would you investigate?' : `Where would ${budget} sensors help most?`;
    stage.classList.toggle('sim-geographic', view === 'map');
    graph.setAttribute('aria-hidden', String(view === 'map')); graph.inert = view === 'map';
    body.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === view); b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
    stage.querySelector('.sim-kicker').textContent = view === 'map' ? 'Simulated overlay · illustrative connections' : 'Simulated network · illustrative connections';
    body.querySelector('.sim-intro').textContent = view === 'map' ? 'A simulated network over Princeton. Connections are illustrative, not verified pipe routes.' : 'An illustrative water network. These are simulated observations and connections.';
    updateReplayControls();
    if ((mode === 'events' && !network) || (mode === 'placement' && !placement)) {
      details.innerHTML = '<p class="sim-small">This simulation view is unavailable. The other view can still be used.</p>'; graph.innerHTML = ''; stage.querySelector('#sim-legend').innerHTML = ''; notify(); return;
    }
    if (mode === 'events') {
      const s = visibleScenario(); if (!s) return;
      body.querySelector('#sim-description').textContent = s.description || '';
      const usable = s.fit_quality === 'usable';
      details.innerHTML = `<p class="sim-fit ${!s.complete || usable ? '' : 'sim-caution'}">${!s.complete ? 'Replay gathering observations' : usable ? 'Multiple observations to compare' : s.fit_quality === 'poor' ? 'Timing disagrees · verify before acting' : 'Too little evidence to single out a pipe'}</p>
        <div class="sim-counts"><div><b data-replay-count="alerts">${s.alerts.length}</b><span>alerting</span></div><div><b data-replay-count="quiet">${s.quiet.length}</b><span>quiet</span></div><div><b data-replay-count="unavailable">${(s.unavailable || []).length}</b><span>unavailable</span></div>${!s.complete ? `<div><b data-replay-count="waiting">${s.waiting.length}</b><span>observing</span></div>` : ''}</div>
        <p class="sim-small" data-replay-status>${esc(s.summary)}</p><h3>${s.complete ? 'Leading candidates' : 'Waiting for the observation window'}</h3>
        <ol class="sim-candidates">${(s.candidates || []).map(c => `<li><button type="button" data-sim-pipe="${esc(c.pipe)}"><span>Pipe ${esc(c.pipe)}</span><span>${Math.round(c.confidence * 100)}% weight</span></button></li>`).join('') || '<li class="sim-small">A ranking appears when the replay completes. Available sensors are still being observed.</li>'}</ol>
        <p class="sim-small">Weights compare these candidates; they are not probabilities of being right. An unavailable sensor is missing evidence, never a quiet sensor.</p>
        <details class="sim-evidence"><summary>Arrival times and next steps</summary><ol>${s.alerts.map(a => `<li>Sensor ${esc(a.sensor)} · minute ${esc(a.minute)}</li>`).join('')}</ol><p>${esc(s.actions?.[0]?.do || 'Verify with sampling before choosing an intervention.')}</p></details>
        <button type="button" class="btn sim-reveal" data-reveal-source ${s.complete ? '' : 'disabled'}>${revealed ? 'Hide injected source' : 'Reveal injected source'}</button>${revealed ? `<p class="sim-small">${esc(s.check)}</p>` : ''}
        <p class="sim-foot">Frozen flow, synthetic pipe attributes and injected events. <a href="../network/">Open the full simulation report</a>.</p>`;
      stage.querySelector('#sim-legend').innerHTML = '<span><i class="alert"></i>Alert</span><span><i class="quiet"></i>Quiet</span><span><i class="unavailable"></i>Unavailable</span><span><i class="candidate"></i>Candidate pipe</span>' + (!s.complete ? '<span><i class="waiting"></i>Observing</span>' : '');
    } else {
      const plan = selectedPlan(); if (!plan) return;
      const c = coverageComparison(plan, placement.existing), old = placement.existing.metrics;
      details.innerHTML = `<p class="sim-fit">${plan.sensors.length} recommended sites · ${c.total} simulated pipe events</p>
        <div class="sim-coverage"><div><b>${c.observedPct}%</b><span>reach at least one sensor</span><small>${c.observed} / ${c.total} events</small></div><div><b>${c.corroboratedPct}%</b><span>reach two or more sensors</span><small>${c.corroborated} / ${c.total} events</small></div></div>
        <table class="sim-comparison"><caption>Compared with the existing ${placement.existing.sensors.length}-sensor layout</caption><thead><tr><th>Simulated coverage</th><th>Existing</th><th>This plan</th></tr></thead><tbody>
          <tr><td>1+ sensor</td><td>${c.baselineObserved}</td><td>${c.observed}</td></tr><tr><td>2+ sensors</td><td>${c.baselineCorroborated}</td><td>${c.corroborated}</td></tr>
          <tr><td>Mean first alert*</td><td>${minutes(c.baselineDelay)}</td><td>${minutes(c.delay)}</td></tr><tr><td>Median, detected only</td><td>${minutes(old.median_first_alert_min)}</td><td>${minutes(plan.metrics.median_first_alert_min)}</td></tr></tbody></table>
        <p class="sim-small">*No alert counts as six hours in the mean. Reaching more distant events can increase the detected-only median. Two-sensor coverage helps corroborate an event; it does not prove correct localization.</p>
        <h3>Recommended junctions</h3><div class="sim-site-list">${plan.sensors.map(id => `<button type="button" data-sim-node="${esc(id)}">${esc(id)}</button>`).join('')}</div>
        <p class="sim-small">${esc(placement.model?.note || 'Greedy recommendations on the frozen Net3 model, not an optimal real-world placement.')}</p>
        <p class="sim-foot">Every pipe is tested as an injected source. These are schematic Net3 junctions, not places to install hardware in Princeton.</p>`;
      details.querySelectorAll('[data-sim-node]').forEach(b => b.addEventListener('click', () => { picked = { kind: 'node', id: b.dataset.simNode }; renderGraph(); renderSelection(); notify(); }));
      stage.querySelector('#sim-legend').innerHTML = '<span><i class="recommended"></i>Recommended sensor</span><span><i class="existing"></i>Existing layout</span><span><i class="covered"></i>Event reaches a sensor</span><span><i class="uncovered"></i>Not observed in six hours</span>';
    }
    renderGraph(); renderSelection(); notify();
  }
  function renderGraph() {
    const n = mode === 'placement' ? placement : network; if (!n) return;
    const positions = graphPositions(n.nodes);
    const s = visibleScenario(), plan = selectedPlan(), candidates = new Set((s?.candidates || []).map(c => String(c.pipe)));
    const recommended = new Set((plan?.sensors || []).map(String)), existing = new Set((placement?.existing?.sensors || []).map(String));
    const covered = new Set((plan?.metrics?.covered_pipes || []).map(String));
    const pipes = (n.pipes || []).map(p => {
      const a = positions.get(String(p.from)), b = positions.get(String(p.to)); if (!a || !b) return '';
      const candidate = mode === 'events' && candidates.has(String(p.id));
      const truth = mode === 'events' && revealed && String(s?.truth?.pipe) === String(p.id);
      const selected = picked?.kind === 'pipe' && picked.id === String(p.id);
      const cls = `sim-pipe${candidate ? ' candidate' : ''}${truth ? ' truth' : ''}${selected ? ' selected' : ''}${mode === 'placement' ? covered.has(String(p.id)) ? ' covered' : ' uncovered' : ''}`;
      return `<g data-pipe="${esc(p.id)}" role="button" tabindex="${candidate || selected ? '0' : '-1'}" aria-label="Simulated pipe ${esc(p.id)}${candidate ? ', ranked candidate' : ''}"><title>Simulated pipe ${esc(p.id)}: ${esc(p.from)} → ${esc(p.to)}</title><line class="sim-pipe-hit" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/><line class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/></g>`;
    }).join('');
    const nodes = n.nodes.map(node => {
      const id = String(node.id), p = positions.get(id); if (!p) return '';
      const status = mode === 'placement' ? recommended.has(id) ? 'recommended' : existing.has(id) ? 'existing' : 'junction' : scenarioSensorState(id, s, network?.sensors || []);
      const selected = picked?.kind === 'node' && picked.id === id, sensor = status !== 'junction';
      return `<g data-node="${esc(id)}" class="sim-node ${status}${selected ? ' selected' : ''}" role="button" tabindex="${sensor ? '0' : '-1'}" aria-label="Simulated junction ${esc(id)}, ${status}"><title>Simulated junction ${esc(id)} · ${status}</title>${mode === 'placement' && recommended.has(id) && existing.has(id) ? `<circle class="sim-existing-ring" cx="${p.x}" cy="${p.y}" r="12"/>` : ''}<circle cx="${p.x}" cy="${p.y}" r="${sensor ? 7 : node.kind === 'junction' ? 2.3 : 4.5}"/>${status === 'unavailable' ? `<path d="M${p.x-4} ${p.y-4}l8 8m-8 0l8-8"/>` : ''}${sensor ? `<text x="${p.x+11}" y="${p.y-10}">${esc(id)}</text>` : ''}</g>`;
    }).join('');
    graph.innerHTML = `<svg viewBox="0 0 960 600" role="group" aria-label="Schematic Net3 network, not real pipe locations">${pipes}${nodes}</svg>`;
  }
  function renderSelection() {
    const el = stage.querySelector('#sim-selection');
    if (!picked) { el.textContent = mode === 'placement' ? 'Select a recommended junction or pipe. Coverage is modeled, not a sensor-health reading.' : 'Select a sensor or candidate pipe. Stress cases run only when you choose them.'; return; }
    if (picked.kind === 'node') {
      const node = (network || placement)?.nodes.find(n => String(n.id) === picked.id), s = visibleScenario();
      const status = mode === 'placement' ? selectedPlan()?.sensors.map(String).includes(picked.id) ? 'recommended sensor site' : 'junction' : scenarioSensorState(picked.id, s, network?.sensors || []);
      el.textContent = `Simulated junction ${picked.id} · ${status}${node?.demand_lps != null ? ` · ${node.demand_lps} L/s assumed demand` : ''}. No real location is implied.`;
    } else {
      const p = (network || placement)?.pipes.find(p => String(p.id) === picked.id), c = visibleScenario()?.candidates?.find(c => String(c.pipe) === picked.id);
      el.textContent = p ? `Simulated pipe ${p.id}: ${p.from} → ${p.to}${p.length_m != null ? ` · ${p.length_m} m · ${p.diameter_mm} mm` : ''}${mode === 'events' && c ? ` · ${Math.round(c.confidence*100)}% ranking weight · ${c.fit_minutes} min timing mismatch` : ''}.` : `Simulated pipe ${picked.id}.`;
    }
  }
  return {
    open() { isOpen = true; document.body.classList.add('simulation-open'); document.body.classList.remove('panel-closed'); stage.classList.remove('hidden'); const toggle = document.querySelector('#panel-toggle'); if (toggle) { toggle.title = 'Hide the side panel'; toggle.setAttribute('aria-label', 'Hide the side panel'); } onOpen(); loader.load(); },
    close() { pauseReplay(); isOpen = false; document.body.classList.remove('simulation-open'); stage.classList.add('hidden'); notify(); },
    pick(kind, id) { if (!['node', 'pipe'].includes(kind)) return; picked = { kind, id: String(id) }; renderGraph(); renderSelection(); notify(); },
    setView(next) { if (['map', 'schematic'].includes(next)) { view = next; render(); } },
    getState: snapshot,
  };
}
