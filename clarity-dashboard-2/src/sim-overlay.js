// This is a display transform of Net3, never a source of Princeton pipe locations.
// Keep the hydraulic IDs and topology unchanged so both views inspect the same model.
export const DEMO_OVERLAY = Object.freeze({ center: [-74.658, 40.3615], spanKm: 6 });

export function projectNetwork(network, { center = DEMO_OVERLAY.center, spanKm = DEMO_OVERLAY.spanKm } = {}) {
  const valid = (network?.nodes || []).filter(n => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (!valid.length) return { nodes: [], pipes: [], pumps: [], bounds: null };
  const xs = valid.map(n => n.x), ys = valid.map(n => n.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const kmPerUnit = spanKm / Math.max(x1 - x0, y1 - y0, 1);
  const lonKm = 111.32 * Math.cos(center[1] * Math.PI / 180), latKm = 111.32;
  const nodes = valid.map(n => ({ ...n, id: String(n.id), position: [
    center[0] + (n.x - (x0 + x1) / 2) * kmPerUnit / lonKm,
    center[1] + (n.y - (y0 + y1) / 2) * kmPerUnit / latKm, 4,
  ] }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const connect = pipes => (pipes || []).flatMap(p => {
    const a = byId.get(String(p.from)), b = byId.get(String(p.to));
    return a && b ? [{ ...p, id: String(p.id), path: [a.position, b.position] }] : [];
  });
  const lons = nodes.map(n => n.position[0]), lats = nodes.map(n => n.position[1]);
  return { nodes, pipes: connect(network.pipes), pumps: connect(network.pumps), bounds: [
    [Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)],
  ] };
}

// The caller supplies the already time-filtered evidence. Never fall back to a raw
// scenario: doing so would reveal future alerts and the final ranking during replay.
export function overlayFeatures(snapshot, geometry = projectNetwork(snapshot?.network)) {
  const placementMode = snapshot?.mode === 'placement', scenario = snapshot?.visibleScenario;
  const original = new Set((snapshot?.network?.sensors || snapshot?.placement?.existing?.sensors || []).map(String));
  const recommended = new Set((placementMode ? snapshot?.plan?.sensors || [] : []).map(String));
  const alerts = new Map((scenario?.alerts || []).map(a => [String(a.sensor), a]));
  const quiet = new Set((scenario?.quiet || []).map(String));
  const unavailable = new Set((scenario?.unavailable || []).map(String));
  const waiting = new Set((scenario?.waiting || []).map(String));
  const ranked = new Map((placementMode ? [] : scenario?.candidates || []).map((c, i) => [String(c.pipe), { ...c, rank: i + 1 }]));
  const covered = new Set((snapshot?.plan?.metrics?.covered_pipes || []).map(String));
  const corroborated = new Set((snapshot?.plan?.metrics?.two_sensor_pipes || []).map(String));
  const picked = snapshot?.picked || snapshot?.selected;
  const truth = !placementMode && (snapshot?.revealed || snapshot?.reveal) ? snapshot?.scenario?.truth?.pipe : null;
  const nodes = geometry.nodes.map(n => {
    const sensor = original.has(n.id), proposed = recommended.has(n.id);
    let status = 'junction';
    if (placementMode) status = proposed ? 'recommended' : sensor ? 'existing' : 'junction';
    else if (sensor) status = unavailable.has(n.id) ? 'unavailable' : alerts.has(n.id) ? 'alert' : quiet.has(n.id) ? 'quiet'
      : waiting.has(n.id) || scenario?.complete === false ? 'waiting' : 'quiet';
    return { ...n, _simulation: true, kind: 'node', sensor, proposed, status,
      minute: alerts.get(n.id)?.minute, selected: picked?.kind === 'node' && String(picked.id) === n.id };
  });
  const pipes = geometry.pipes.map(p => ({ ...p, _simulation: true, kind: 'pipe',
    candidate: ranked.get(p.id), coverage: placementMode ? corroborated.has(p.id) ? 2 : covered.has(p.id) ? 1 : 0 : null,
    truth: truth != null && String(truth) === p.id, selected: picked?.kind === 'pipe' && String(picked.id) === p.id,
  }));
  return { nodes, pipes, pumps: geometry.pumps, placementMode, bounds: geometry.bounds };
}

export function simulationTooltip(object) {
  if (!object?._simulation) return null;
  if (object.kind === 'pipe') {
    const evidence = object.truth ? 'Revealed injected source' : object.candidate
      ? `Candidate ${object.candidate.rank} · ${Math.round(object.candidate.confidence * 100)}% of ranking weight`
      : object.coverage === 2 ? 'Two or more recommended sensors can observe this modeled event'
      : object.coverage === 1 ? 'One recommended sensor can observe this modeled event'
      : object.coverage === 0 ? 'No recommended sensor observes this event within six modeled hours' : 'Example network connection';
    return `Simulated pipe ${object.id}\n${evidence}\nIllustrative position, not a Princeton pipe. Click to inspect.`;
  }
  const label = { alert: `Alert at model minute ${Math.round(object.minute || 0)}`, quiet: 'No alert during the observation window',
    waiting: 'Still being observed', unavailable: 'Sensor unavailable, not a quiet reading', recommended: 'Recommended sensor site',
    existing: 'Original example sensor site', junction: 'Example network junction' }[object.status];
  return `Simulated ${object.sensor || object.proposed ? 'sensor' : 'junction'} ${object.id}\n${label}\nIllustrative position, not an installed Princeton sensor. Click to inspect.`;
}

// Deck's frequent scenery/particle renders reuse these exact layer objects. Only a
// new simulation snapshot or theme rebuilds attributes; geometry survives replay.
export function createSimulationOverlay({ PathLayer, ScatterplotLayer, TextLayer }, { onPick = () => {} } = {}) {
  let network = null, geometry = null, current = null, last = null, lastLight = null, layers = [];
  const click = ({ object }) => { if (object?._simulation) onPick(object.kind, object.id); };
  return {
    update(snapshot) { current = snapshot; },
    bounds() {
      if (network !== current?.network) { network = current?.network; geometry = projectNetwork(network); }
      return geometry?.bounds;
    },
    layers(light = false) {
      if (last === current && lastLight === light) return layers;
      last = current; lastLight = light;
      if (!current?.network) return (layers = []);
      if (network !== current.network) { network = current.network; geometry = projectNetwork(network); }
      const f = overlayFeatures(current, geometry);
      const ink = light ? [11, 32, 39, 255] : [247, 240, 240, 255];
      const background = light ? [255, 252, 245, 245] : [11, 32, 39, 245];
      const blue = [125, 195, 229, 255], warm = [238, 137, 113, 255], gold = [243, 204, 117, 255];
      const pipeColor = d => d.selected || d.truth ? gold : d.candidate ? (d.candidate.rank === 1 ? warm : blue)
        : d.coverage === 2 ? [101, 185, 219, 215] : d.coverage === 1 ? [90, 155, 189, 160]
        : light ? [74, 104, 121, 100] : [132, 166, 183, 105];
      const nodeColor = d => d.selected ? gold : d.status === 'alert' ? warm : d.proposed ? blue
        : d.status === 'unavailable' ? [113, 117, 128, 220] : d.status === 'waiting' ? [164, 177, 184, 255]
        : d.sensor ? [133, 190, 218, 255] : [117, 155, 176, 130];
      const important = f.nodes.filter(n => n.sensor || n.proposed || n.selected);
      layers = [
        new PathLayer({ id: 'sim-map-pipes', data: f.pipes, getPath: d => d.path, getColor: pipeColor,
          getWidth: d => d.selected || d.truth ? 6 : d.candidate ? d.candidate.rank === 1 ? 5 : 3.5 : d.coverage ? 2.5 : 1.5,
          widthUnits: 'pixels', widthMinPixels: 1, capRounded: true, jointRounded: true,
          pickable: true, autoHighlight: true, highlightColor: gold, onClick: click, parameters: { depthTest: false } }),
        new PathLayer({ id: 'sim-map-pumps', data: f.pumps, getPath: d => d.path, getColor: [137, 168, 183, 120],
          getWidth: 2, widthUnits: 'pixels', parameters: { depthTest: false } }),
        new ScatterplotLayer({ id: 'sim-map-junctions', data: f.nodes.filter(n => !n.sensor && !n.proposed),
          getPosition: d => d.position, getRadius: d => d.selected ? 7 : 2, radiusUnits: 'pixels',
          getFillColor: nodeColor, pickable: true, onClick: click, parameters: { depthTest: false } }),
        new ScatterplotLayer({ id: 'sim-map-sensors', data: important, getPosition: d => d.position,
          getRadius: d => d.selected ? 10 : d.proposed ? 8 : 7, radiusUnits: 'pixels',
          getFillColor: d => d.status === 'unavailable' || d.status === 'waiting' || d.status === 'existing' ? background : nodeColor(d),
          getLineColor: nodeColor, stroked: true, lineWidthMinPixels: 2.5, pickable: true, onClick: click,
          parameters: { depthTest: false } }),
        new TextLayer({ id: 'sim-map-unavailable', data: important.filter(n => n.status === 'unavailable'),
          getPosition: d => d.position, getText: '×', getSize: 16, getColor: ink,
          fontFamily: 'Inter, system-ui, sans-serif', getTextAnchor: 'middle', getAlignmentBaseline: 'center',
          pickable: true, onClick: click, parameters: { depthTest: false } }),
        new TextLayer({ id: 'sim-map-labels', data: important, getPosition: d => d.position,
          getText: d => d.id, getSize: 11, getPixelOffset: [0, -17], getColor: ink,
          getTextAnchor: 'middle', getAlignmentBaseline: 'bottom', fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600,
          fontSettings: { sdf: true }, characterSet: 'auto', outlineWidth: 3, outlineColor: background,
          pickable: true, onClick: click, parameters: { depthTest: false } }),
      ];
      return layers;
    },
  };
}
