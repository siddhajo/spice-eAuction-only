// THE GLOBAL AUCTION SELECTOR DEFAULTS TO THE CURRENT TRADE.
//
// The selector in the topbar drives every screen (setSharedAucId fans the
// pick out to each tab's dropdown). It already seeded itself from the
// newest trade on a fresh session — but once somebody switched to an older
// trade to fix something, it stayed there for the rest of the session with
// nothing on screen saying so, and the next document they raised went onto
// last month's trade.
//
//   [default]  a fresh session opens on the CURRENT (newest) trade
//   [marker]   a sticky topbar warning while a past trade is selected,
//              and none at all while the current one is
//   [offer]    a WRITE on a past trade offers a way back…
//   [offer]    …and nothing moves unless the operator says so
//   [quiet]    reads don't nag, and neither do master/settings edits
//   [back]     taking the offer returns every screen to the current trade
//   [dark]     the offer floats on the PAGE, which flips — so it must be
//              dark on dark ground. --card/--text resolve on :root and keep
//              their light values, which is how a glaring white card gets
//              shipped; this has caught the codebase out three times.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'curtrade-'));
const PORT = 3000 + Math.floor(Math.random() * 1500) + 400;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' },
                                   TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  TOKEN = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  if (!TOKEN) { console.error('login failed\n' + srvLog.slice(-1500)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await api('PUT', '/api/company-settings', { settings: { gunny_rate: '150', br1: 'BODI' } });

  // Three trades. /api/auctions comes back date DESC, so #22 is current
  // and #20 / #21 are past.
  const mk = async (ano, date) => (await api('POST', '/api/auctions',
    { ano, date, crop_type: 'ISP', state: 'TAMIL NADU' })).d;
  const A20 = await mk('20', '2026-10-17');
  const A21 = await mk('21', '2026-10-28');
  const A22 = await mk('22', '2026-11-06');
  const id20 = A20.id || (A20.auction && A20.auction.id);
  const id22 = A22.id || (A22.auction && A22.auction.id);
  // A lot on the past trade, so a write against it is a realistic one.
  await api('POST', `/api/auctions/${id20}/allocations`,
    { allocations: [{ branch: 'BODI', from_no: 1, to_no: 20 }] });
  const sel = (await api('POST', '/api/traders',
    { name: 'GANESHBABU', tel: '9790744444', place: 'CUMBUM' })).d;
  const sid = sel.id || sel.trader_id;
  await api('POST', '/api/lots', { auction_id: id20, lot_no: '016', trader_id: sid,
    name: 'GANESHBABU', branch: 'BODI', bags: 1, qty: 33.9, gross_wt: 34.9 });

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1500, height: 920 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  await page.waitForFunction(() => !!window._currentTab, { timeout: 20000 });
  await page.waitForFunction(() => !!getCurrentAucId && !!getCurrentAucId(), { timeout: 20000 });

  const state = () => page.evaluate(() => ({
    shared: getSharedAucId(),
    current: getCurrentAucId(),
    past: isPastTradeSelected(),
    topbar: document.getElementById('topbar-trade').value,
    markerShown: getComputedStyle(document.getElementById('topbar-trade-past')).display !== 'none',
    promptShown: !!document.getElementById('past-trade-prompt'),
    promptText: (document.getElementById('past-trade-prompt') || {}).innerText || '',
  }));

  // ── [default] ────────────────────────────────────────────────────
  console.log('\n[default] a fresh session opens on the current trade');
  let st = await state();
  check('the selector holds the newest trade', String(st.shared) === String(id22),
        { shared: st.shared, want: id22 });
  check('…which the app agrees is the current one', String(st.current) === String(id22), st);
  check('…so nothing is flagged as past', st.past === false && st.markerShown === false, st);

  // ── [marker] ─────────────────────────────────────────────────────
  console.log('\n[marker] switching to a past trade raises a sticky warning');
  await page.evaluate((id) => setSharedAucId(String(id), 'topbar'), id20);
  await page.waitForFunction(() => isPastTradeSelected(), { timeout: 5000 });
  st = await state();
  check('the app knows a past trade is selected', st.past === true, st);
  check('…and the topbar marker is visible', st.markerShown === true, st);
  const markerText = await page.evaluate(() =>
    document.getElementById('topbar-trade-past').innerText.replace(/\s+/g, ' ').trim());
  check('…naming the current trade to go back to', /#22/.test(markerText), markerText);
  check('no prompt yet — switching is not "doing something"', st.promptShown === false, st);

  // ── [quiet] reads and non-trade writes don't nag ─────────────────
  console.log('\n[quiet] a read, and a master edit, raise nothing');
  await page.evaluate(() => j('/api/auctions'));
  await new Promise(r => setTimeout(r, 1800));
  check('a GET raises no offer', (await state()).promptShown === false);
  await page.evaluate(() => j('/api/traders', { method: 'POST',
    body: JSON.stringify({ name: 'SOMEONE ELSE', tel: '9000000001', place: 'BODI' }) }));
  await new Promise(r => setTimeout(r, 1800));
  check('editing a MASTER raises no offer either', (await state()).promptShown === false);

  // ── [offer] a real write on the past trade ───────────────────────
  console.log('\n[offer] a write on the past trade offers the way back');
  await page.evaluate((aid, tid) => j('/api/lots', { method: 'POST',
    body: JSON.stringify({ auction_id: aid, lot_no: '017', trader_id: tid,
      name: 'GANESHBABU', branch: 'BODI', bags: 2, qty: 57.3, gross_wt: 58.3 }) }), id20, sid);
  await page.waitForFunction(() => !!document.getElementById('past-trade-prompt'), { timeout: 6000 })
    .catch(() => {});
  st = await state();
  check('the offer appears', st.promptShown === true, st);
  check('…asking about the PAST trade by name', /#20/.test(st.promptText), st.promptText);
  check('…and naming the current one as the destination', /#22/.test(st.promptText), st.promptText);
  check('…while the trade has NOT moved on its own',
        String(st.shared) === String(id20), st);

  // ── [offer] "Stay" leaves everything alone ───────────────────────
  console.log('\n[offer] "Stay" is respected');
  await page.evaluate(() => stayOnPastTrade());
  st = await state();
  check('the offer closes', st.promptShown === false, st);
  check('…and the past trade is still selected', String(st.shared) === String(id20), st);
  check('…with the marker still up', st.markerShown === true, st);

  // ── [back] taking the offer ──────────────────────────────────────
  console.log('\n[back] taking the offer returns the whole app');
  await page.evaluate(() => backToCurrentTrade('test'));
  await page.waitForFunction(() => !isPastTradeSelected(), { timeout: 5000 });
  st = await state();
  check('the shared trade is the current one again', String(st.shared) === String(id22), st);
  check('…the topbar select moved with it', String(st.topbar) === String(id22), st);
  check('…and the marker is gone', st.markerShown === false, st);

  // ── [dark] ───────────────────────────────────────────────────────
  console.log('\n[dark] the offer belongs to the page, so it flips');
  const lum = (rgb) => {
    const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb || '');
    if (!m) return null;
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  };
  const cardTone = async (dark) => page.evaluate((d) => {
    if (d) document.body.dataset.dark = '1'; else delete document.body.dataset.dark;
    if (!document.getElementById('past-trade-prompt')) _showPastTradePrompt();
    const el = document.getElementById('past-trade-prompt');
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, fg: cs.color };
  }, dark);

  await page.evaluate((id) => setSharedAucId(String(id), 'topbar'), id20);
  const light = await cardTone(false);
  const dark = await cardTone(true);
  check('light ground: a pale card with dark text',
        lum(light.bg) > 0.7 && lum(light.fg) < 0.4, light);
  check('dark ground: the card goes DARK — not a white slab',
        lum(dark.bg) < 0.4, dark);
  check('…and its text goes light with it', lum(dark.fg) > 0.6, dark);
  check('…so the two have real contrast',
        Math.abs(lum(dark.bg) - lum(dark.fg)) > 0.4, dark);
  await page.evaluate(() => { delete document.body.dataset.dark; _dismissPastTradePrompt(); });

  // Screenshots for eyeballing (opt-in via CURTRADE_SHOT_DIR).
  const SHOT = process.env.CURTRADE_SHOT_DIR;
  if (SHOT) {
    await page.evaluate((id) => setSharedAucId(String(id), 'topbar'), id20);
    await new Promise(r => setTimeout(r, 400));
    const bar = await page.$('#topbar-trade-wrap');
    if (bar) await bar.screenshot({ path: SHOT + '/trade-marker.png' });
    await page.evaluate(() => _showPastTradePrompt());
    await new Promise(r => setTimeout(r, 300));
    const pr = await page.$('#past-trade-prompt');
    if (pr) await pr.screenshot({ path: SHOT + '/trade-prompt.png' });
    await page.screenshot({ path: SHOT + '/trade-full.png' });
    // Dark ground — the card floats on the page, which flips.
    await page.evaluate(() => { document.body.dataset.dark = '1'; });
    await new Promise(r => setTimeout(r, 400));
    const prD = await page.$('#past-trade-prompt');
    if (prD) await prD.screenshot({ path: SHOT + '/trade-prompt-dark.png' });
    const barD = await page.$('#topbar-trade-wrap');
    if (barD) await barD.screenshot({ path: SHOT + '/trade-marker-dark.png' });
    await page.evaluate(() => { delete document.body.dataset.dark; _dismissPastTradePrompt(); });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nCRASHED:', e && e.stack || e);
  console.error('\n--- server log ---\n' + srvLog.slice(-2000));
  cleanup();
  process.exit(1);
});
