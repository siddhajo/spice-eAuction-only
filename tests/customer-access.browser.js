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
//   [search]  searching a NAME narrows the list. It used to strip to no
//             digits, leaving `phone_key LIKE '%%'` — true for every row —
//             so the OR matched everything and the box looked broken
//   [scroll]  the list scrolls inside its card, header pinned, instead of
//             making the page one long column
//   [confirm] "Enrol them" names the parties and writes only on confirm
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
  // Everyone in this fixture is already enrolled at this point, so there is
  // nothing to offer — and the button must NOT appear, or it would promise
  // work it cannot do. The opposite case is proved in [confirm] below.
  check('…says plainly there is nothing to do', /Nothing to do/.test(dry.out), dry.out);
  check('…and does not offer a button that would do nothing', !dry.goShown, dry);
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

  // ── [search] ─────────────────────────────────────────────────────
  console.log('\n[search] a term NARROWS the list');
  const NAMES = ['ANAKKARA TRADERS', 'BASIL SPICES', 'CHUKKURUMBEL', 'DEEPA ESTATES',
                 'ELAICHI ROYAL', 'GREEN EARTH', 'JJ SPICES', 'MALLINGA', 'MARY MATHA',
                 'NILGIRI GOLD', 'PRAKASH K', 'SARANYA G'];
  for (let i = 0; i < NAMES.length; i++) {
    await api('POST', '/api/traders', { name: NAMES[i], tel: '90000000' + (10 + i), place: 'BODI' });
  }
  const allT = (await api('GET', '/api/traders?search=')).d;
  const tRows = Array.isArray(allT) ? allT : ((allT && allT.rows) || []);
  for (const n of NAMES) {
    const t = tRows.find(x => String(x.name).toUpperCase() === n);
    if (t) await api('POST', '/api/portal/admin/links',
      { party_kind: 'seller', party_id: t.id, phone: String(t.tel) });
  }
  const total = (await api('GET', '/api/portal/admin/links')).d.total;
  check('fixture: enough grants to search', total >= 12, total);

  const byApi = async (q) => (await api('GET', '/api/portal/admin/links?q=' + encodeURIComponent(q))).d;
  const nm = await byApi('BASIL');
  check('a NAME narrows to the matches', nm.shown === 1 && nm.shown < nm.total,
        { shown: nm.shown, total: nm.total });
  check('…and it is the right one', /BASIL/i.test((nm.rows[0] || {}).party_name || ''), nm.rows[0]);
  const ph = await byApi('9000000011');
  check('a NUMBER narrows too', ph.shown === 1 && ph.shown < ph.total,
        { shown: ph.shown, total: ph.total });
  const none = await byApi('zzzqqq');
  check('a term that matches nothing returns NOTHING, not everything',
        none.shown === 0, { shown: none.shown, total: none.total });

  // Through the box, which is what the operator actually uses.
  await page.evaluate(() => {
    const i = document.getElementById('pa-search');
    i.value = 'MARY'; i.dispatchEvent(new Event('input'));
  });
  await new Promise(r => setTimeout(r, 900));
  const typed = await page.evaluate(() => ({
    count: document.getElementById('pa-count').textContent,
    rows: document.querySelectorAll('#pa-rows tr').length,
    first: (document.querySelector('#pa-rows td') || {}).innerText || '' }));
  check('typing in the box narrows the table', typed.rows === 1, typed);
  check('…to the party searched for', /MARY/i.test(typed.first), typed);
  check('…and the count says so', /of \d+ shown/.test(typed.count), typed.count);

  // ── [scroll] ─────────────────────────────────────────────────────
  console.log('\n[scroll] the list scrolls inside its card');
  await page.evaluate(() => {
    const i = document.getElementById('pa-search');
    i.value = ''; i.dispatchEvent(new Event('input'));
  });
  await new Promise(r => setTimeout(r, 900));
  const sc = await page.evaluate(() => {
    const box = document.getElementById('pa-table').parentElement;
    return { scrolls: box.scrollHeight > box.clientHeight + 2,
             head: getComputedStyle(document.querySelector('#pa-table thead tr')).position,
             pageRunsOn: document.documentElement.scrollHeight > window.innerHeight + 400 };
  });
  check('the grants list has its own scroll', sc.scrolls, sc);
  check('…with the header pinned while it moves', sc.head === 'sticky', sc);
  check('…so the page itself does not run on', !sc.pageRunsOn, sc);

  // ── [confirm] ────────────────────────────────────────────────────
  console.log('\n[confirm] "Enrol them" names the parties first');
  // Revoke the auto grant so the seed has something real to offer.
  const liveRows = (await api('GET', '/api/portal/admin/links')).d.rows;
  const auto = liveRows.find(r => r.source === 'auto');
  if (auto) await api('POST', '/api/portal/admin/links/' + auto.id + '/revoke', {});
  await page.evaluate(() => paSeed(false));
  await new Promise(r => setTimeout(r, 1100));
  const nowOffered = await page.evaluate(() => ({
    out: document.getElementById('pa-seed-out').innerText.replace(/\s+/g, ' ').trim(),
    goShown: getComputedStyle(document.getElementById('pa-seed-go')).display !== 'none' }));
  check('with work to do, the check says how many', /would gain access/.test(nowOffered.out), nowOffered.out);
  check('…and NOW the Enrol button appears', nowOffered.goShown, nowOffered);
  const beforeConfirm = (await api('GET', '/api/portal/admin/links')).d.total;
  await page.evaluate(() => paConfirmSeed());
  await new Promise(r => setTimeout(r, 600));
  const modal = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('div'))
      .find(d => /Give .* access\?/.test(d.textContent || '') && d.offsetParent);
    if (!b) return null;
    const tb = b.querySelector('tbody');
    return { listed: tb ? tb.querySelectorAll('tr').length : 0,
             text: tb ? tb.innerText.replace(/\s+/g, ' ').trim() : '' };
  });
  check('the confirmation lists the parties by name', !!modal && modal.listed >= 1, modal);
  check('…naming the one that would gain access', !!modal && /ABSAL SPICES/.test(modal.text), modal);
  check('…with the number they would sign in with', !!modal && /9488818786/.test(modal.text), modal);
  const stillUnwritten = (await api('GET', '/api/portal/admin/links')).d.total;
  check('opening the confirmation writes NOTHING', stillUnwritten === beforeConfirm,
        { before: beforeConfirm, now: stillUnwritten });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('div'))
      .find(d => /Give .* access\?/.test(d.textContent || '') && d.offsetParent);
    b.querySelector('[data-x="1"]').click();
  });
  await new Promise(r => setTimeout(r, 1600));
  const afterConfirm = (await api('GET', '/api/portal/admin/links')).d.total;
  check('…and confirming does write', afterConfirm > stillUnwritten,
        { before: stillUnwritten, after: afterConfirm });

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
