// End-to-end check of the dashboard in a real browser: node tests/e2e.cjs [baseUrl]
// Clicks through every control and reports PASS/FAIL per check, plus any page errors.
// Start the app first: npm run build && npx vite preview --port 4173
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.argv[2] || 'http://localhost:4173';
const OUT = process.env.SHOTS || '';
const results = [];
const check = async (name, fn) => {
  try {
    const r = await fn();
    results.push([r === false ? 'FAIL' : 'PASS', name, r === true || r === undefined || r === false ? '' : String(r)]);
    console.log(results[results.length - 1].join('  '));
  } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0].slice(0, 200)]); console.log(results[results.length - 1].join('  ')); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  let p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => m.type() === 'error' && !/TUNNEL|Failed to load resource|net::ERR/.test(m.text()) && errors.push('console: ' + m.text().slice(0, 200)));
  const cam = () => p.evaluate(() => { const m = window.clarity.map; return { z: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing(), c: m.getCenter() }; });
  const shot = async n => { if (OUT) await p.screenshot({ path: `${OUT}/${n}.png`, timeout: 120000 }); };

  await p.goto(`${BASE}/?mock=1`);
  await p.waitForFunction(() => window.clarity && window.clarity.map.loaded(), null, { timeout: 60000 });
  await wait(5000);
  // The software GPU in CI is slow; stop the always-on water-flow animation so clicks aren't starved.
  // (Its toggle is still exercised below.)
  if (process.env.SLOW_GPU !== '0') await p.evaluate(() => document.querySelector('#layers input[data-layer=route]').click());

  await check('page loads, status pill', async () => (await p.textContent('#status')).trim());
  await check('live feed has items', async () => { const n = (await p.$$('#feed > *')).length; return n > 0 && `${n} items`; });
  await check('hero before/after card rendered', async () => (await p.textContent('#hero')).includes('ppm'));
  await check('nodes loaded (Princeton area)', async () => { const n = await p.evaluate(() => window.clarity.state.nodes.size); return n >= 7 && `${n} nodes`; });
  await check('Overview tab: tiles, status bar, site bars, US samples', async () => {
    const t = (await p.$$('#tab-ov .tile')).length, r = (await p.$$('#tab-ov .nrow')).length, u = (await p.$$('#tab-ov .usbar i')).length;
    return t === 4 && r >= 10 && u === 4 && `${t} tiles, ${r} sites`;
  });
  await check('Overview row opens the drawer', async () => { await p.click('#tab-ov .nrow'); await wait(1500); const o = await p.$eval('#drawer', d => !d.classList.contains('hidden')); await p.click('#drawer-close'); return o; });
  await check('tab: Live feed', async () => { await p.click('[data-tab=live]'); await wait(300); return p.$eval('#tab-live', d => !d.classList.contains('hidden')); });
  await check('tab: Water source', async () => { await p.click('[data-tab=src]'); await wait(300); return (await p.textContent('#tab-src')).includes('Raritan'); });
  await shot('t-source');
  await check('tab: Business view filters', async () => { await p.click('[data-tab=biz]'); await wait(300); const f = (await p.$$('#filters > *')).length; return f >= 2 && `${f} filters`; });
  await shot('t-biz');
  await check('CSV export downloads the water log', async () => {
    const [d] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }), p.click('#export')]);
    const txt = fs.readFileSync(await d.path(), 'utf8');
    const rows = txt.trim().split('\n').length;
    return rows > 10 && `${d.suggestedFilename()}, ${rows} rows`;
  });
  await p.click('[data-tab=live]');

  await check('replay slider rewinds', async () => {
    await p.evaluate(() => { const s = document.querySelector('#time'); s.value = Math.round((+s.min + +s.max) / 2); s.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(500); const l = (await p.textContent('#time-label')).trim();
    await p.click('#btn-live'); await wait(300);
    return l !== 'Live' && l;
  });
  await check('Play starts replay', async () => { await p.click('#btn-play'); await wait(1200); const l = (await p.textContent('#time-label')).trim(); await p.click('#btn-live'); return l !== 'Live' && l; });

  await shot('t-home');

  for (const t of ['dark', 'light', 'satellite', 'game']) {
    await check(`theme: ${t}`, async () => { await p.click(`#theme [data-theme=${t}]`); await wait(800); return (await p.evaluate(() => document.body.dataset.theme)) === t; });
  }
  await check('2D / 3D toggle', async () => {
    await p.click('#btn-3d'); await wait(3000); const a = (await cam()).pitch;
    await p.click('#btn-3d'); await wait(3000); const c = (await cam()).pitch;
    const msg = `pitch ${a.toFixed(0)} -> ${c.toFixed(0)}`; if (a < 10 && c > 40) return msg; throw new Error(msg);
  });
  await check('Orbit rotates the camera', async () => {
    const a = (await cam()).bearing; await p.click('#btn-rotate'); await wait(2500);
    const c = (await cam()).bearing; await p.click('#btn-rotate');
    return Math.abs(c - a) > 2 && `${(c - a).toFixed(1)} deg`;
  });
  await check('USA button zooms out to the country', async () => { await p.click('#btn-usa'); await p.waitForFunction(() => window.clarity.map.getZoom() < 5, null, { timeout: 15000 }).catch(() => {}); const z = (await cam()).z; return z < 5 && `zoom ${z.toFixed(1)}`; });
  await shot('t-usa');
  await check('Princeton button flies home', async () => { await p.click('#btn-reset'); await wait(4500); const v = await cam(); return Math.abs(v.c.lng + 74.66) < 0.05 && `zoom ${v.z.toFixed(1)}`; });

  const layerKeys = await p.$$eval('#layers input', xs => xs.map(x => x.dataset.layer));
  for (const k of layerKeys) {
    await check(`layer toggle: ${k}`, async () => {
      await p.evaluate(key => { const el = document.querySelector(`#layers input[data-layer=${key}]`); el.click(); el.click(); }, k);
      await wait(150);
    });
  }

  await check('search: building', async () => { await p.fill('#search', 'Nassau Hall'); await p.press('#search', 'Enter'); await wait(3500); const v = await cam(); return Math.abs(v.c.lat - 40.3487) < 0.01 && `zoom ${v.z.toFixed(1)}`; });
  await check('search: US city', async () => { await p.fill('#search', 'Chicago'); await p.press('#search', 'Enter'); await wait(3500); const v = await cam(); await p.evaluate(() => window.clarity.map.jumpTo({ center: [-74.66, 40.35], zoom: 12 })); return Math.abs(v.c.lng + 87.63) < 0.1; });

  await check('node drawer opens with charts', async () => {
    await p.evaluate(() => window.clarity.openDrawer('tank-01')); await wait(3500);
    const open = await p.$eval('#drawer', d => !d.classList.contains('hidden'));
    const charts = (await p.$$('#drawer canvas')).length;
    return open && charts >= 2 && `${charts} charts`;
  });
  await shot('t-drawer');
  await check('drawer closes', async () => { await p.click('#drawer-close'); await wait(300); return p.$eval('#drawer', d => d.classList.contains('hidden')); });

  await check('arrow hides and shows the side panel', async () => {
    const w0 = await p.evaluate(() => window.clarity.map.getCanvas().clientWidth);
    await p.click('#panel-toggle'); await wait(1200);
    const pw = await p.$eval('#panel', e => e.getBoundingClientRect().width), w1 = await p.evaluate(() => window.clarity.map.getCanvas().clientWidth);
    await p.click('#panel-toggle'); await wait(1200);
    const back = await p.$eval('#panel', e => e.getBoundingClientRect().width);
    const msg = `map ${w0} -> ${w1}px, panel back to ${Math.round(back)}px`; if (pw < 2 && w1 > w0 + 200 && back > 300) return msg; throw new Error(msg);
  });

  // Fresh page for the heavy 3D checks, so the software GPU starts clean.
  await p.close();
  p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await p.goto(`${BASE}/?mock=1`);
  await p.waitForFunction(() => window.clarity && window.clarity.map.loaded(), null, { timeout: 60000 });
  await wait(4000);
  if (process.env.SLOW_GPU !== '0') await p.evaluate(() => document.querySelector('#layers input[data-layer=route]').click());
  await check('narrow screen: hero link opens a filled drawer', async () => {
    await p.setViewportSize({ width: 760, height: 820 }); await wait(1500);
    await p.click('.hero-node'); await wait(2500);
    const ok = (await p.$eval('#drawer-body', d => d.innerHTML.length)) > 100;
    await p.click('#drawer-close'); await p.setViewportSize({ width: 1440, height: 900 }); await wait(1500);
    return ok;
  });
  await check('Tour starts and stops', async () => { await p.click('#btn-tour'); await wait(2500); const on = await p.$eval('#btn-tour', d => d.classList.contains('on')); await p.click('#btn-tour'); return on; });

  await check('New York buildings load from national tiles', async () => {
    await p.evaluate(() => window.clarity.map.jumpTo({ center: [-73.9855, 40.758], zoom: 16.4, pitch: 60, bearing: 30 }));
    await wait(14000);
    const n = await p.evaluate(() => window.clarity.map.queryRenderedFeatures({ layers: ['buildings-3d'] }).length);
    return n > 50 && `${n} buildings on screen`;
  });

  const m = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  m.on('pageerror', e => errors.push('phone pageerror: ' + e.message));
  await p.close();
  await m.goto(`${BASE}/?mock=1`, { timeout: 90000 }); await wait(9000);
  await check('phone: no horizontal scroll', async () => { const w = await m.evaluate(() => document.documentElement.scrollWidth); return w <= 392 && `${w}px wide`; });
  if (OUT) await m.screenshot({ path: `${OUT}/t-phone.png`, timeout: 120000 });

  const o = await b.newPage({ viewport: { width: 1200, height: 800 } });
  o.on('pageerror', e => errors.push('offline pageerror: ' + e.message));
  await m.close(); await o.goto(`${BASE}/?mock=1&offline=1`, { timeout: 90000 }); await wait(9000);
  await check('offline mode renders Princeton buildings', async () => {
    await o.evaluate(() => window.clarity.map.jumpTo({ center: [-74.6585, 40.3487], zoom: 16 })); await wait(4000);
    const n = await o.evaluate(() => window.clarity.map.queryRenderedFeatures({ layers: ['buildings-3d'] }).length);
    return n > 20 && `${n} buildings`;
  });

  await check('no JavaScript errors', async () => { if (errors.length) throw new Error(errors.slice(0, 5).join(' | ')); });
  console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} passed`);
  await b.close();
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})();
