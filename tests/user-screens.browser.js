// PER-USER SCREENS, in a real browser.
//
// tests/user-screen-flags.http.js proves the override arithmetic and the
// guards. This proves the two things only the browser can show:
//
//   [panel]   the Users row offers Screens, and the panel opens with one
//             tri-state row per screen — "Follow default" naming the value it
//             will follow, so an admin isn't sent to Settings to find out
//   [effect]  two users on ONE install end up with different sidebars: the
//             one given the Auction Manager sees it even though the install
//             has it off, and loses the Auction Desk the install has on
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uscrui-'));
const PORT = 47374;
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
async function api(method, url, body, token) {
  const r = await fetch(B + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const srv = spawn('node', [path.join(ROOT, 'server.js')], { cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }), stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
let browser;
const cleanup = async () => { try { if (browser) await browser.close(); } catch (_) {} try { srv.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// Same resolution order (and the same graceful skip) as the other browser
// tests, so a machine with no Chrome reports skip rather than failure.
function findChrome() {
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
    try { if (fs.existsSync(p)) return { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; } catch (_) {}
  }
  return null;
}

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const ADMIN = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  await api('POST', '/api/users', { username: 'mgr_a', password: 'passw0rd', role: 'manager' }, ADMIN);
  // A SECOND admin for the browser: 'admin' already holds the API session
  // above and the app allows one login per username.
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' }, ADMIN);
  const users = (await api('GET', '/api/users', null, ADMIN)).d.users;
  const aId = users.find(u => u.username === 'mgr_a').id;

  const chrome = findChrome();
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); await cleanup(); process.exit(0); }
  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });

  // ── Admin drives the Screens modal for mgr_a ──
  await page.goto(B, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => { document.getElementById('inp-u').value='uiadmin'; document.getElementById('inp-p').value='pw1234'; login(); });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block' && !!window._currentTab, { timeout: 20000 });
  await page.evaluate(() => go('users'));
  await page.waitForFunction(() => document.querySelectorAll('#users-list tr').length > 1, { timeout: 15000 });

  const hasBtn = await page.evaluate(() =>
    !!Array.from(document.querySelectorAll('#users-list button')).find(b => b.textContent.trim() === 'Screens'));
  check('every user row offers a Screens button', hasBtn);

  await page.evaluate((id) => openUserScreensModal(id, 'mgr_a'), aId);
  await page.waitForFunction(() => document.querySelectorAll('#user-screens-rows input[type=radio]').length > 0, { timeout: 15000 });
  const shape = await page.evaluate(() => ({
    rows: document.querySelectorAll('#user-screens-rows > div').length,
    perRow: document.querySelectorAll('#user-screens-rows input[name="scr-flag_auction_manager"]').length,
    inheritLabel: (document.querySelector('#user-screens-rows label')?.textContent || '').trim(),
    checkedDefault: document.querySelector('#user-screens-rows input[name="scr-flag_auction_manager"]:checked')?.value,
  }));
  check('one row per per-user screen', shape.rows >= 8, String(shape.rows));
  check('three states offered per screen', shape.perRow === 3, String(shape.perRow));
  check('the inherit option names the default value', /Follow default \((on|off)\)/.test(shape.inheritLabel), shape.inheritLabel);
  check('an unconfigured screen starts on inherit', shape.checkedDefault === 'inherit', String(shape.checkedDefault));

  // Give mgr_a the Auction Manager, take away the Desk, and save.
  await page.evaluate(() => {
    document.querySelector('#user-screens-rows input[name="scr-flag_auction_manager"][value="on"]').checked = true;
    document.querySelector('#user-screens-rows input[name="scr-flag_auction_desk"][value="off"]').checked = true;
  });
  await page.evaluate(() => doSaveUserScreens());
  await page.waitForFunction(() => document.getElementById('user-screens-modal')?.style.display === 'none'
                               || !document.getElementById('user-screens-modal')?.classList.contains('show'), { timeout: 10000 }).catch(() => {});
  const saved = (await api('GET', `/api/users/${aId}/screens`, null, ADMIN)).d.flags;
  check('the modal saved through to the server',
        saved.find(f => f.key === 'flag_auction_manager').override === true
        && saved.find(f => f.key === 'flag_auction_desk').override === false,
        JSON.stringify(saved.filter(f => f.override !== null)));

  // ── admin's own sidebar (no overrides) vs mgr_a's ──
  const navOf = () => page.evaluate(() => ({
    mgr: document.body.getAttribute('data-feat-auction-manager'),
    desk: document.body.getAttribute('data-feat-auction-desk'),
  }));
  const adminNav = await navOf();
  check('admin, with no override, follows the install (Desk on, Manager off)',
        adminNav.desk === '1' && adminNav.mgr === '0', JSON.stringify(adminNav));

  const page2 = await browser.newPage();
  page2.on('pageerror', e => { fail++; console.log('  FAIL page2 error: ' + e.message); });
  await page2.goto(B, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#inp-u', { timeout: 15000 });
  await page2.evaluate(() => localStorage.clear());
  await page2.goto(B, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#inp-u', { timeout: 15000 });
  await page2.evaluate(() => { document.getElementById('inp-u').value='mgr_a'; document.getElementById('inp-p').value='passw0rd'; login(); });
  await page2.waitForFunction(() => document.getElementById('app')?.style.display === 'block' && !!window._currentTab, { timeout: 20000 });
  await page2.waitForFunction(() => document.body.hasAttribute('data-feat-auction-manager'), { timeout: 15000 });
  const aNav = await page2.evaluate(() => ({
    mgr: document.body.getAttribute('data-feat-auction-manager'),
    desk: document.body.getAttribute('data-feat-auction-desk'),
    sidebarHasMgr: (() => { const b = document.querySelector('.side-item[data-tab="auctionmgr"]');
                            return b ? getComputedStyle(b).display !== 'none' : null; })(),
    sidebarHasDesk: (() => { const b = document.querySelector('.side-item[data-tab="hub"]');
                             return b ? getComputedStyle(b).display !== 'none' : null; })(),
  }));
  check('mgr_a gets the Auction Manager the install has OFF', aNav.mgr === '1', JSON.stringify(aNav));
  check('…and loses the Auction Desk the install has ON', aNav.desk === '0', JSON.stringify(aNav));
  check('the Auction Manager is actually visible in mgr_a\'s sidebar', aNav.sidebarHasMgr === true, JSON.stringify(aNav));
  check('…and the Auction Desk is actually hidden', aNav.sidebarHasDesk === false, JSON.stringify(aNav));

  const SHOT = process.env.SCREENS_SHOT || path.join(os.tmpdir(), 'user-screens.png');
  await page.evaluate((id) => openUserScreensModal(id, 'mgr_a'), aId);
  await page.waitForFunction(() => document.querySelectorAll('#user-screens-rows input[type=radio]').length > 0, { timeout: 10000 });
  await page.screenshot({ path: SHOT });
  console.log('\n  screenshot → ' + SHOT);

  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-2500)); await cleanup(); process.exit(1); });
