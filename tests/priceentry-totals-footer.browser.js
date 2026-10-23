// Price Entry — the totals footer.
//
// It scrolled away with the rows, so on a long trade the operator priced
// blind: the figure they were working toward was somewhere above or below the
// viewport. It is now pinned, using the SAME .dt-foot / .dt-foot-sel classes
// the Sales Invoices list uses — the actual classes, not a copy of their look,
// so the two screens cannot drift apart.
//
//   [pinned]  the grand total stays on screen with the grid scrolled to the end
//   [select]  ticking lots adds a second subtotal row above it, and clearing
//             them takes it away again
//   [stack]   the two sticky rows do not pin on top of each other
//   [sums]    both rows agree with the data, and WD/NA lots count toward lots
//             and Qty but contribute no Amount
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pefoot-'));
const PORT = 48082;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '\n         ' + JSON.stringify(d) : '')); }
};

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const T = (await (await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json()).token;
  const api = async (m, u, b) => {
    const r = await fetch(B + u, { method: m,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
      body: b ? JSON.stringify(b) : undefined });
    return r.json().catch(() => null);
  };

  await api('PUT', '/api/company-settings', { settings: { br1: 'BODI' } });
  await api('POST', '/api/buyers', { buyer: 'B1', code: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
  const a = await api('POST', '/api/auctions', { ano: '30', date: '2026-10-23', crop_type: 'ISP' });
  await api('POST', `/api/auctions/${a.id}/allocations`, { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '060' }] });
  const s = (await api('POST', '/api/traders', { name: 'SELLER ONE', tel: '9790744401', ppla: 'BODIMETTU' })).trader;
  // 25 rows so the grid genuinely scrolls — a footer that never leaves the
  // viewport proves nothing.
  for (let i = 1; i <= 25; i++) {
    await api('POST', '/api/lots', { auction_id: a.id, lot_no: String(i).padStart(3, '0'),
      trader_id: s.id, branch: 'BODI', grade: '1', bags: 10, litre: '300', qty: 500,
      sample_wt: 2.95, gross_wt: 502.95 });
  }
  let lots = await api('GET', `/api/lots/${a.id}`);
  await api('POST', '/api/lots/bulk-set-buyer', { ids: lots.map(l => l.id),
    code: 'B1', buyer: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3000 })) });
  // One WD lot — carries bags and Qty but no Amount, which both footer rows
  // must honour identically.
  lots = await api('GET', `/api/lots/${a.id}`);
  await api('POST', '/api/lots/bulk-set-buyer', { ids: [lots[24].id], code: 'WD' });
  lots = await api('GET', `/api/lots/${a.id}`);

  let chrome = null;
  for (const p of [process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = p; break; } } catch (_) {}
  }
  if (!chrome) {
    console.log('  skip no Chrome available');
    console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0);
  }
  browser = await pptr.launch({ executablePath: chrome, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1500, height: 900 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => localStorage.setItem('t', t), T);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1600));
  await page.evaluate(aid => { go('priceentry'); const sel = document.getElementById('pe-auction'); if (sel) sel.value = String(aid); }, a.id);
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => { if (typeof peLoad === 'function') peLoad(); });
  await new Promise(r => setTimeout(r, 2000));
  await page.evaluate(() => peToggleShowAll(true));
  await new Promise(r => setTimeout(r, 900));

  console.log('[pinned] the grand total stays on screen');
  const base = await page.evaluate(() => {
    const g = document.getElementById('pe-grid');
    const t = g.querySelector('.pe-grid-table');
    const all = t.querySelector('tfoot .dt-foot-all');
    const cs = getComputedStyle(all.cells[0]);
    return { rows: t.querySelectorAll('tbody tr[data-lotid]').length,
             scrolls: g.scrollHeight > g.clientHeight,
             position: cs.position, bottom: cs.bottom,
             text: all.innerText.replace(/\s+/g, ' ').trim() };
  });
  check('the grid actually scrolls', base.rows === 25 && base.scrolls, base);
  check('the total row is sticky to the bottom', base.position === 'sticky' && base.bottom === '0px', base);
  const stuck = await page.evaluate(() => {
    const g = document.getElementById('pe-grid');
    g.scrollTop = g.scrollHeight;
    const all = document.querySelector('#pe-grid tfoot .dt-foot-all');
    const r = all.getBoundingClientRect(), gr = g.getBoundingClientRect();
    return r.bottom <= gr.bottom + 2 && r.top >= gr.top - 2;
  });
  check('…and is still in view with the grid scrolled to the end', stuck);

  console.log('\n[sums] the grand total agrees with the data');
  // 25 lots x 10 bags = 250; x 500kg = 12,500; 24 priced x 500 x 3000 = 3,60,00,000
  // (the 25th is WD: bags and Qty count, Amount does not)
  check('lots, bags and qty include the WD lot',
        /25 lots/.test(base.text) && /\b250\b/.test(base.text) && /12,500\.00/.test(base.text), base.text);
  check('…but the WD lot contributes no Amount',
        /3,60,00,000\.00/.test(base.text), base.text);

  console.log('\n[select] ticking lots adds a subtotal above it');
  const ids = lots.slice(0, 3).map(l => l.id);
  const sel = await page.evaluate((ids) => {
    ids.forEach(id => { const cb = document.querySelector(`[data-pesel="${id}"]`); if (cb) { cb.checked = true; peToggleSel(id, true); } });
    const t = document.querySelector('#pe-grid .pe-grid-table');
    const row = t.querySelector('tfoot .dt-foot-sel');
    const cs = getComputedStyle(row.cells[0]);
    const all = t.querySelector('tfoot .dt-foot-all');
    return { hidden: row.hidden, text: row.innerText.replace(/\s+/g, ' ').trim(),
             position: cs.position, bottom: cs.bottom, allH: all.offsetHeight };
  }, ids);
  check('the selected row appears', sel.hidden === false, sel);
  check('…and sums only the ticked lots', /3 lots/.test(sel.text) && /\b30\b/.test(sel.text) && /1,500\.00/.test(sel.text) && /45,00,000\.00/.test(sel.text), sel.text);

  console.log('\n[stack] the two sticky rows do not pin on top of each other');
  check('the selected row is lifted by the total row\'s height',
        sel.position === 'sticky' && parseInt(sel.bottom, 10) === sel.allH && sel.allH > 0, sel);
  const apart = await page.evaluate(() => {
    const t = document.querySelector('#pe-grid .pe-grid-table');
    const selR = t.querySelector('tfoot .dt-foot-sel').getBoundingClientRect();
    const allR = t.querySelector('tfoot .dt-foot-all').getBoundingClientRect();
    return { overlap: Math.max(0, selR.bottom - allR.top) };
  });
  check('…so they never overlap on screen', apart.overlap <= 1, apart);

  console.log('\n[select] clearing the ticks takes it away again');
  const cleared = await page.evaluate((ids) => {
    ids.forEach(id => { const cb = document.querySelector(`[data-pesel="${id}"]`); if (cb) { cb.checked = false; peToggleSel(id, false); } });
    return document.querySelector('#pe-grid tfoot .dt-foot-sel').hidden;
  }, ids);
  check('the selected row is hidden with nothing ticked', cleared === true, cleared);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
