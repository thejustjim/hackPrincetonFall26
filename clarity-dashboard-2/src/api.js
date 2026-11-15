// Data layer: talks to the Clarity gateway.
// URL options:  ?api=http://192.168.1.20:8000  (gateway elsewhere)   ?mock=1  (force mock data)
import { mockApi, mockSocket } from './mock.js';

const params = new URLSearchParams(location.search);
const API = (params.get('api') || import.meta.env.VITE_API || '').replace(/\/$/, '');
const FORCE_MOCK = params.get('mock') === '1' || !!import.meta.env.VITE_ARTIFACT;

async function getJSON(path, timeout = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API + path, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const liveApi = {
  nodes: () => getJSON('/api/nodes'),
  readings: (node, limit = 100) => getJSON(`/api/readings?${node ? `node=${encodeURIComponent(node)}&` : ''}limit=${limit}`),
  test: (node, test) => getJSON(`/api/tests/${encodeURIComponent(node)}/${test}`),
  // No fake fallback: if the gateway doesn't serve these yet, the panels stay empty.
  filters: () => getJSON('/api/filters').catch(() => []),
  reference: () => getJSON('/api/reference').catch(() => []),
};

function liveSocket(onMessage, onStatus) {
  let ws, closed = false, retry = 1000;
  const url = (API ? API.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`) + '/ws';
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 1000; onStatus('live'); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore non-JSON */ } };
    ws.onclose = () => {
      if (closed) return;
      onStatus('reconnecting');
      setTimeout(open, retry); retry = Math.min(retry * 2, 15000);
    };
  };
  open();
  return { close() { closed = true; ws && ws.close(); } };
}

// Real data only: real hardware nodes plus the gateway's simulated nodes (labeled sim).
// If the gateway is down, keep retrying and show "Gateway offline". No fake fallback.
// ?mock=1 still forces the built-in demo data for offline UI work and tests, and is labeled "Demo data".
export async function connect(onMessage, onStatus) {
  if (FORCE_MOCK) {
    onStatus('demo');
    return { api: mockApi, mode: 'mock', sock: mockSocket(onMessage) };
  }
  for (let wait = 2000; ; wait = Math.min(wait * 2, 15000)) {
    try {
      await liveApi.nodes();
      const sock = liveSocket(onMessage, onStatus);
      return { api: liveApi, mode: 'live', sock };
    } catch {
      onStatus('offline');
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
