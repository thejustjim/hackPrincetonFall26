// A saved prototype location changes only the camera, never device coordinates.
export function readPrototypeLocation(storage, explicitDemo = false) {
  if (explicitDemo) return null;
  try {
    const choice = JSON.parse(storage.getItem('clarity-setup-v1') || 'null'), loc = choice?.location;
    if (choice?.version !== 1 || choice.mode !== 'prototype' || !loc ||
      !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || Math.abs(loc.lat) > 85 || Math.abs(loc.lon) > 180) return null;
    return { name: typeof loc.name === 'string' && loc.name.trim() ? loc.name.trim().slice(0, 120) : 'Prototype location', lat: loc.lat, lon: loc.lon };
  } catch { return null; }
}

// Explicit URL choices win over a saved setup. A prototype never falls back to samples.
export function readMapMode(storage, search = '') {
  const p = typeof search?.get === 'function' ? search : new URLSearchParams(search);
  if (p.get('mock') === '1' || p.has('simulation')) return 'demo';
  if (p.get('mode') === 'prototype' || p.get('mode') === 'demo') return p.get('mode');
  if (p.get('mock') === '0' || p.has('api')) return 'prototype';
  try {
    const saved = JSON.parse(storage.getItem('clarity-setup-v1') || 'null');
    if (saved?.version === 1 && ['prototype', 'demo'].includes(saved.mode)) return saved.mode;
  } catch { /* private mode or an old/broken setting */ }
  return 'prototype';
}
