// CUSTOMER ACCESS — the admin screen for customer-portal sign-ins.
//
// Until this existed, every link was API-only: an admin could not see who
// could sign in, could not move a grant to a corrected number, and could
// not enrol the parties whose documents predate the portal. On the live
// install that last one mattered — 57 dealers held a purchase invoice and
// not one of them could sign in.
//
//   [nav]     the screen is REACHABLE — a .side-item alone is not enough,
//             NAV_GROUPS is what the rail is built from, and #nav-src is
//             hidden so a test asserting on it alone passes either way
//   [list]    every live grant, with where it came from
//   [flags]   a hand-made grant on a number the master no longer holds is
//             marked PINNED (autoEnrol will not move it) and STALE
//   [seed]    checking reports and writes NOTHING; enrolling writes
//   [revoke]  a grant can be withdrawn, and the list follows
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'custaccess-'));
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
    body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'] });
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
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await api('PUT', '/api/company-settings', { settings: {
    gunny_rate: '150', br1: 'BODI', flag_customer_portal: 'true' } });

  // A dealer with a purchase invoice — enrolled when it was raised.
  const A = (await api('POST', '/api/auctions',
    { ano: '23', date: '2026-11-16', crop_type: 'ISP' })).d.id;
  await api('POST', `/api/auctions/${A}/allocations`,
    { allocations: [{ branch: 'BODI', from_no: 100, to_no: 300 }] });
  await api('POST', '/api/traders',
    { name: 'ABSAL SPICES', tel: '9488818786', place: 'CUMBUM', cr: '33ALCPU9807E1Z0' });
  const traders = (await api('GET', '/api/traders?search=ABSAL')).d;
  const trows = Array.isArray(traders) ? traders : ((traders && traders.rows) || []);
  const sid = (trows.find(t => /ABSAL/i.test(t.name)) || {}).id;
  check('fixture: the dealer exists', !!sid, trows.length);
  await api('POST', '/api/lots', { auction_id: A, lot_no: '140', trader_id: sid,
    name: 'ABSAL SPICES', branch: 'BODI', bags: 10, qty: 236.7, gross_wt: 237.7,
    cr: '33ALCPU9807E1Z0' });
  const lots = (await api('GET', `/api/lots/${A}`)).d || [];
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 2962 })) });
  await api('POST', '/api/lots/calculate/' + A, {});
  await api('POST', `/api/purchases/generate/${A}`,
    { sellerName: 'ABSAL SPICES', invoiceNo: '301' });

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  // confirm() on revoke, prompt() on rebind.
  page.on('dialog', async d => { await d.accept(d.type() === 'prompt' ? '9112233445' : undefined); });
  await page.setViewport({ width: 1500, height: 980 });
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

  // ── [nav] ────────────────────────────────────────────────────────
  console.log('\n[nav] the screen is reachable, not just present');
  const nav = await page.evaluate(() => {
    const g = NAV_GROUPS.find(x => x.id === 'admin');
    return { inModel: !!(g && g.items.find(i => i.tab === 'portalaccess')),
             srcItem: !!document.querySelector('#nav-src .side-item[data-tab="portalaccess"]'),
             pane: !!document.getElementById('tc-portalaccess'),
             loader: typeof loadPortalAccess === 'function' };
  });
  check('it is in NAV_GROUPS — the rail is built from this, not from #nav-src',
        nav.inModel, nav);
  check('…it has a #nav-src item, which is where the gates are read', nav.srcItem, nav);
  check('…a pane to show', nav.pane, nav);
  check('…and a loader wired to the tab', nav.loader, nav);

  await page.evaluate(() => go('portalaccess'));
  await page.waitForFunction(() => {
    const t = document.getElementById('tc-portalaccess');
    return t && getComputedStyle(t).display !== 'none';
  }, { timeout: 10000 });
  await new Promise(r => setTimeout(r, 1200));

  // ── [list] ───────────────────────────────────────────────────────
  console.log('\n[list] every live grant, and where it came from');
  const first = await page.evaluate(() =>
    document.getElementById('pa-rows').innerText.replace(/\s+/g, ' ').trim());
  check('the dealer enrolled when the purchase was raised', /ABSAL SPICES/.test(first), first);
  check('…and the row says so', /Document raised/.test(first), first);

  // ── [flags] ──────────────────────────────────────────────────────
  console.log('\n[flags] a hand-made grant on a number the master dropped');
  await api('POST', '/api/portal/admin/links',
    { party_kind: 'seller', party_id: sid, phone: '9112233445' });
  await page.evaluate(() => loadPortalAccess());
  await new Promise(r => setTimeout(r, 1000));
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#pa-rows tr')).map(r => ({
    text: r.innerText.replace(/\s+/g, ' ').trim(),
    badges: Array.from(r.querySelectorAll('span')).map(b => b.textContent).filter(t => /STALE|PINNED/.test(t)),
  })));
  const pinned = rows.find(r => r.badges.length);
  check('the hand-made grant is flagged', !!pinned, rows);
  check('…as PINNED — autoEnrol will not move it',
        !!pinned && pinned.badges.includes('PINNED'), pinned);
  check('…and STALE — the master says another number',
        !!pinned && pinned.badges.includes('STALE'), pinned);
  check('…showing what the master actually says',
        !!pinned && /master: 9488818786/.test(pinned.text), pinned && pinned.text);
  check('the auto grant on the master\'s own number is NOT flagged',
        rows.some(r => /Document raised/.test(r.text) && r.badges.length === 0), rows);

  // ── [seed] ───────────────────────────────────────────────────────
  console.log('\n[seed] checking writes nothing; enrolling writes');
  const before = (await api('GET', '/api/portal/admin/links')).d.total;
  await page.evaluate(() => paSeed(false));
  await new Promise(r => setTimeout(r, 1000));
  const dry = await page.evaluate(() => ({
    out: document.getElementById('pa-seed-out').innerText.replace(/\s+/g, ' ').trim(),
    goShown: getComputedStyle(document.getElementById('pa-seed-go')).display !== 'none' }));
  check('the check reports counts', /sellers hold a document/.test(dry.out), dry.out);
  check('…warns about shared handsets', /MORE THAN ONE party/.test(dry.out), dry.out);
  check('…says plainly that nothing was written', /Nothing has been written/.test(dry.out), dry.out);
  check('…and only THEN offers to enrol', dry.goShown, dry);
  const afterDry = (await api('GET', '/api/portal/admin/links')).d.total;
  check('the check really wrote nothing', afterDry === before, { before, afterDry });

  // ── [revoke] ─────────────────────────────────────────────────────
  console.log('\n[revoke] a grant can be withdrawn');
  const revoked = await page.evaluate(async () => {
    const r = _paRows.find(x => x.source === 'admin');
    await paRevoke(r.id);
    await new Promise(z => setTimeout(z, 1200));
    return { gone: !_paRows.some(x => Number(x.id) === Number(r.id)), left: _paRows.length };
  });
  check('the revoked grant leaves the list', revoked.gone, revoked);
  check('…and the other one stays', revoked.left >= 1, revoked);
  const kept = (await api('GET', '/api/portal/admin/links')).d.rows;
  check('…the server agrees it is no longer active',
        !kept.some(r => r.phone_key === '9112233445'), kept.map(r => r.phone_key));

  if (process.env.CA_SHOT_DIR) await page.screenshot({ path: process.env.CA_SHOT_DIR + '/customer-access.png' });
  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nCRASHED:', e && e.stack || e);
  console.error('\n--- server log ---\n' + srvLog.slice(-2000));
  cleanup();
  process.exit(1);
});
