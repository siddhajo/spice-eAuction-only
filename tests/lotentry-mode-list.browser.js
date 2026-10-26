// Lot Entry — the recent list shows only what the entry mode is for.
//
//   Book for auction    → this trade's bookings, no stored stock
//   Godown storage only → stored stock, no bookings
//
// The two were mixed. It got worse once stored stock was untied from trades:
// an unscoped /api/lots/:id request means "this trade's lots PLUS all stored
// stock" (see _lotScopeSql), so every godown entry in the install appeared
// under every trade while booking.
//
//   [book]    booking mode lists the trade's lots only
//   [store]   godown mode lists stored stock only — and ALL of it, since it
//             belongs to no trade
//   [switch]  flipping the mode refetches, rather than leaving the other list
//   [wording] the heading says which list is on screen; "this auction" is
//             wrong for stock that carries no trade
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lemode-'));
const PORT = 48172;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
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
  const T = (await (await fetch(B + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json()).token;
  const api = async (m, u, b) => {
    const r = await fetch(B + u, { method: m,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
      body: b ? JSON.stringify(b) : undefined });
    return r.json().catch(() => null);
  };
  await api('PUT', '/api/company-settings', { settings: { br1: 'BODI', flag_godown: 'true' } });
  const s = (await api('POST', '/api/traders', { name: 'LE SELLER', tel: '9790744441', ppla: 'BODIMETTU' })).trader;
  const a = await api('POST', '/api/auctions', { ano: '80', date: '2026-10-26', crop_type: 'ISP' });
  await api('POST', `/api/auctions/${a.id}/allocations`,
    { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  for (const n of ['001', '002']) {
    await api('POST', '/api/lots', { auction_id: a.id, lot_no: n, trader_id: s.id, branch: 'BODI',
      grade: '1', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  }
  for (let i = 0; i < 3; i++) {
    await api('POST', '/api/lots', { trader_id: s.id, branch: 'BODI', grade: '1',
      bags: 5, litre: '300', qty: 300, sample_wt: 0, gross_wt: 300, godown: 1 });
  }

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
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => localStorage.setItem('t', t), T);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1800));
  await page.evaluate(aid => { go('lotentry'); const sel = document.getElementById('le-auction'); if (sel) sel.value = String(aid); }, a.id);
  await new Promise(r => setTimeout(r, 1200));

  const snap = async (mode) => {
    await page.evaluate(m => leSetEntryMode(m), mode);
    await new Promise(r => setTimeout(r, 1400));
    return page.evaluate(() => ({
      mode: _le.entryMode,
      lots: (_le.recentLots || []).map(l => ({ no: String(l.lot_no), godown: Number(l.godown) || 0 })),
      title: ((document.getElementById('le-recent-title') || {}).textContent || '').trim(),
    }));
  };

  console.log('[book] booking mode lists the trade\'s lots only');
  let v = await snap('auction');
  check('the mode is booking', v.mode === 'auction', v.mode);
  check('both bookings are listed', v.lots.length === 2, v.lots);
  check('…and NO stored stock leaks in', v.lots.every(l => !l.godown), v.lots);
  check('the heading names the trade', /this auction/i.test(v.title), v.title);

  console.log('\n[store] godown mode lists stored stock only');
  v = await snap('godown');
  check('the mode is godown', v.mode === 'godown', v.mode);
  check('all three stored entries are listed', v.lots.length === 3, v.lots);
  check('…every one of them is stored stock', v.lots.every(l => l.godown === 1), v.lots);
  check('…and NO booking leaks in', v.lots.every(l => l.godown === 1), v.lots);
  console.log('\n[wording] the heading follows the list');
  check('it no longer claims "this auction"', !/this auction/i.test(v.title), v.title);
  check('…and names the godown', /godown/i.test(v.title), v.title);

  console.log('\n[switch] flipping back refetches');
  v = await snap('auction');
  check('the bookings are back', v.lots.length === 2 && v.lots.every(l => !l.godown), v.lots);
  v = await snap('godown');
  check('…and so is the stock', v.lots.length === 3 && v.lots.every(l => l.godown === 1), v.lots);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); cleanup(); process.exit(1); });
