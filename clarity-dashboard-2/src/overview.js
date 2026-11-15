// Overview tab: network at a glance with small visuals (stat tiles, verdict bar, per-node TDS bars with
// sparklines, and how US water samples compare to the EPA guideline).
import { us, TDS_BANDS } from './national.js';
import { isSimulatedNode } from './provenance.js';

const VERDICT_VAR = { SAFE: 'var(--safe)', HIGH_TDS: 'var(--high)', CLOUDY: 'var(--cloudy)', PH_WARN: 'var(--phwarn)' };
const VERDICT_LABEL = { SAFE: 'In range', HIGH_TDS: 'High TDS', CLOUDY: 'Cloudy', PH_WARN: 'pH warning' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SCALE = 1000; // TDS bar scale, ppm
const EPA = 500;

export function sparkline(values, { w = 64, h = 20, color = 'currentColor', max } = {}) {
  if (values.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const hi = max ?? Math.max(...values), lo = Math.min(0, ...values);
  const x = i => (i / (values.length - 1)) * (w - 2) + 1;
  const y = v => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${d}L${x(values.length - 1)} ${h}L1 ${h}Z" fill="${color}" opacity=".14"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="2.2" fill="${color}"/></svg>`;
}

// Percent ring used for "TDS removed".
export function ring(frac, { size = 64, color = 'var(--steel)', label = '' } = {}) {
  const r = size / 2 - 5, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac));
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ink-3)" stroke-width="6"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="currentColor" font-size="${size * 0.24}" font-weight="700">${label}</text></svg>`;
}

// Horizontal TDS bar on a 0-1000 ppm scale with the EPA 500 line.
export function tdsBar(v, color, { scale = SCALE } = {}) {
  const pct = Math.min(100, (v / scale) * 100);
  return `<div class="tbar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i><b style="left:${(EPA / scale) * 100}%"></b></div>`;
}

export function renderOverview(el, { state, nodeView, testPair, openDrawer }) {
  if (!el) return;
  const nodes = [...state.nodes.values()];
  const simulated = n => isSimulatedNode(n, state.mode);
  // tagged row by row only where simulated and measured sites share the list
  const mixed = nodes.some(simulated) && nodes.some(n => !simulated(n));
  const views = nodes.map(n => ({ n, lb: nodeView(n).lb }));
  const counts = { SAFE: 0, HIGH_TDS: 0, CLOUDY: 0, PH_WARN: 0 };
  for (const v of views) if (v.lb) counts[v.lb.verdict] = (counts[v.lb.verdict] || 0) + 1;
  const withData = views.filter(v => v.lb).length || 1;
  const all = [...state.byId.values()];
  const afters = all.filter(r => r.phase === 'after');
  const drops = afters.map(a => { const b = testPair(a.node, a.test).before; return b && b.tds ? 1 - a.tds / b.tds : null; }).filter(x => x != null);
  const avgDrop = drops.length ? drops.reduce((s, x) => s + x, 0) / drops.length : 0;
  const alerts = state.filters.filter(f => f.status !== 'OK').length;
  const befores = all.filter(r => r.phase === 'before').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const tdsTrend = befores.slice(-24).map(r => r.tds);
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const latestTds = views.filter(v => v.lb).map(v => v.lb.tds);

  const bands = TDS_BANDS.map(b => ({ ...b, n: 0 }));
  for (const s of us.sites) bands.find(b => s.tds < b.max).n++;
  const usTotal = us.sites.length || 1;
  const over = us.sites.filter(s => s.tds >= EPA).length;

  const rows = views.filter(v => v.lb).sort((a, b) => b.lb.tds - a.lb.tds);
  el.innerHTML = `
    <div class="ov-tiles">
      <div class="tile"><div class="tk">Sites reporting</div><div class="tv">${nodes.length}</div>
        <div class="ts">${mixed ? `${nodes.filter(n => !simulated(n)).length} real, ${nodes.filter(simulated).length} simulated` : ''}</div></div>
      <div class="tile"><div class="tk">Median source TDS</div><div class="tv">${median(latestTds)}<small> ppm</small></div>
        ${sparkline(tdsTrend, { w: 120, h: 22, color: 'var(--steel)' })}</div>
      <div class="tile ring-tile">${ring(avgDrop, { size: 58, label: `${Math.round(avgDrop * 100)}%` })}
        <div><div class="tk">TDS removed</div><div class="ts">avg of ${drops.length} retests</div></div></div>
      <div class="tile ${alerts ? 'warn' : ''}"><div class="tk">Filter alerts</div><div class="tv">${alerts}</div>
        <div class="ts">${alerts ? 'cartridges to replace' : 'all filters OK'}</div></div>
    </div>

    <h3>Network status now</h3>
    <div class="vbar">${Object.entries(counts).filter(([, c]) => c).map(([k, c]) =>
      `<i style="flex:${c};background:${VERDICT_VAR[k]}" title="${VERDICT_LABEL[k]}: ${c}"></i>`).join('')}</div>
    <div class="vlegend">${Object.entries(counts).map(([k, c]) =>
      `<span><i style="background:${VERDICT_VAR[k]}"></i>${VERDICT_LABEL[k]} <b>${c}</b></span>`).join('')}</div>

    <h3>Source water by site <span class="h3note">TDS, ppm · line = EPA 500</span></h3>
    <div class="nodes-list">${rows.map(({ n, lb }) => {
      const hist = (state.readings.get(n.node) || []).filter(r => r.phase === 'before').slice(-12).map(r => r.tds);
      return `<button class="nrow" data-node="${esc(n.node)}">
        <span class="nn">${esc(n.name)}${mixed && simulated(n) ? '<em>simulated</em>' : ''}</span>
        ${tdsBar(lb.tds, VERDICT_VAR[lb.verdict])}
        <span class="nv">${lb.tds}</span>
        ${sparkline(hist, { w: 44, h: 16, color: VERDICT_VAR[lb.verdict] })}
      </button>`;
    }).join('')}</div>

    <h3>US water samples <span class="h3note">${us.sites.length.toLocaleString()} public sites since 2024</span></h3>
    ${us.sites.length ? `
      <div class="usbar">${bands.map(b => `<i style="flex:${b.n};background:rgb(${b.rgb.join(',')})" title="${b.label} ppm: ${b.n.toLocaleString()}"></i>`).join('')}</div>
      <div class="vlegend">${bands.map(b => `<span><i style="background:rgb(${b.rgb.join(',')})"></i>${b.label} <b>${Math.round((b.n / usTotal) * 100)}%</b></span>`).join('')}</div>
      <p class="muted small">${Math.round((over / usTotal) * 100)}% of these rivers, lakes and wells read above 500 ppm. That is the EPA's guideline for drinking water, shown for scale: this is untreated water, not tap water.
        Source: Water Quality Portal (USGS, EPA, state agencies).</p>` : '<p class="muted small">Loading…</p>'}
  `;
  const top = document.getElementById('topstats');
  if (top) top.innerHTML = [
    [nodes.length, 'sites'],
    [counts.HIGH_TDS + counts.CLOUDY + counts.PH_WARN, 'flagged', counts.HIGH_TDS + counts.CLOUDY + counts.PH_WARN ? 'bad' : ''],
    [`${Math.round(avgDrop * 100)}%`, 'TDS removed'],
    [us.sites.length ? us.sites.length.toLocaleString() : '…', 'US samples'],
  ].map(([v, k, c]) => `<span class="${c || ''}"><b>${v}</b>${k}</span>`).join('');
  el.querySelectorAll('.nrow').forEach(b => b.addEventListener('click', () => openDrawer(b.dataset.node)));
  return { withData };
}
