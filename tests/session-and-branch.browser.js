// Concurrent-login control + per-user branch lock, driven through the REAL
// desktop screens in a headless Chrome.
//
// The server-side rules are covered by session-and-branch.http.js. What
// only a browser can prove is that the UI actually reflects them:
//   • the login screen shows the server's "already logged in" message
//     instead of the generic "Invalid credentials"
//   • a branch-locked operator's Lot Entry branch dropdown is pinned to
//     their depot and disabled, with no "All branches" escape
//   • an unlocked user still gets the full dropdown
//   • the Users table renders the Branch column and the Sign out action
//   • the concurrent-admin banner appears from the poll
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-branch-ui-'));
const PORT = 47333;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

let TOKEN = '';
async function api(method, url, body, token) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      (token || TOKEN) ? { Authorization: 'Bearer ' + (token || TOKEN) } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', b => { srvLog += b.toString(); });
srv.stderr.on('data', b => { srvLog += b.toString(); });
let browser = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

// Sign in through the real login form and wait for the app shell.
async function uiLogin(page, username, password) {
  // Land on the origin first — localStorage is unreachable on about:blank.
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  // Drop any token from the previous user, then reload so the app boots
  // on the login screen instead of auto-restoring that session.
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate((u, p) => {
    document.getElementById('inp-u').value = u;
    document.getElementById('inp-p').value = p;
  }, username, password);
  await page.evaluate(() => login());
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, boot.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: { br1: 'BODINAYAKANUR', br2: 'CUMBUM' } });

  // A trade so Lot Entry has something to open against.
  await api('POST', '/api/auctions', { ano: '31', date: '2026-08-20', state: 'TAMIL NADU' });

  // Two operators: one locked to CUMBUM, one with no lock. Plus a second
  // admin for the browser to sign in as — this test holds the bootstrap
  // `admin` session over the API for its out-of-band calls, and with
  // single_session on (the default) that session would rightly block the
  // browser from signing in as `admin` too.
  const locked = await api('POST', '/api/users', { username: 'lockedop', password: 'pw1234', role: 'operator', branch: 'CUMBUM' });
  const free   = await api('POST', '/api/users', { username: 'freeop',   password: 'pw1234', role: 'operator' });
  const uiAdm  = await api('POST', '/api/users', { username: 'uiadmin',  password: 'pw1234', role: 'admin' });
  if (locked.status >= 300 || free.status >= 300 || uiAdm.status >= 300) {
    console.error('fixture users failed', locked.d, free.d, uiAdm.d); cleanup(); process.exit(1);
  }

  let chrome = null;
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) {
    try {
      const mod = require('@sparticuz/chromium');
      const chromium = mod && mod.default ? mod.default : mod;
      const ep = await chromium.executablePath();
      if (ep) chrome = { executablePath: ep, args: (chromium.args || ['--no-sandbox']) };
    } catch (_) {}
  }
  if (!chrome) {
    console.log('  skip no Chrome available — UI checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    cleanup(); process.exit(0);
  }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });

  // ══ [A] BRANCH LOCK IN LOT ENTRY ═══════════════════════════════════
  console.log('[A] Lot Entry branch dropdown');

  await uiLogin(page, 'lockedop', 'pw1234');
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 15000 });
  await page.evaluate(() => go('lotentry'));
  await page.waitForFunction(() => {
    const s = document.getElementById('le-branch');
    return s && s.options.length > 0 && s.options[0].value !== '';
  }, { timeout: 15000 });

  const lockedSel = await page.evaluate(() => {
    const s = document.getElementById('le-branch');
    return { value: s.value, disabled: s.disabled, opts: [...s.options].map(o => o.value) };
  });
  check('locked operator: branch pinned to their depot', lockedSel.value === 'CUMBUM', JSON.stringify(lockedSel));
  check('locked operator: dropdown is disabled', lockedSel.disabled === true, JSON.stringify(lockedSel));
  check('locked operator: no "All branches" escape',
        lockedSel.opts.length === 1 && lockedSel.opts[0] === 'CUMBUM', JSON.stringify(lockedSel.opts));

  // The save path reads .value off the select — a disabled select still
  // reports it, but assert it rather than trusting the spec from memory.
  check('a disabled select still reports its value to the save path',
        await page.evaluate(() => (document.getElementById('le-branch').value || '').trim().toUpperCase() === 'CUMBUM'));

  // An unlocked operator must be unaffected.
  await uiLogin(page, 'freeop', 'pw1234');
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 15000 });
  await page.evaluate(() => go('lotentry'));
  await page.waitForFunction(() => {
    const s = document.getElementById('le-branch');
    return s && s.options.length > 0 && s.options[0].value !== '';
  }, { timeout: 15000 });
  const freeSel = await page.evaluate(() => {
    const s = document.getElementById('le-branch');
    return { value: s.value, disabled: s.disabled, opts: [...s.options].map(o => o.value) };
  });
  check('unlocked operator: dropdown stays enabled', freeSel.disabled === false, JSON.stringify(freeSel));
  check('unlocked operator: keeps every branch plus ALL',
        freeSel.opts.join(',') === 'ALL,BODINAYAKANUR,CUMBUM', JSON.stringify(freeSel.opts));

  // ══ [B] DUPLICATE LOGIN ON THE LOGIN SCREEN ════════════════════════
  console.log('\n[B] login screen shows the block');

  // freeop is signed in on this page. A second browser context is a
  // genuinely different browser — no shared localStorage, so no prev_token.
  const ctx = await browser.createBrowserContext
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext();
  const page2 = await ctx.newPage();
  page2.on('pageerror', e => { fail++; console.log('  FAIL page2 error: ' + e.message); });
  await page2.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#inp-u', { timeout: 15000 });
  await page2.evaluate(() => {
    document.getElementById('inp-u').value = 'freeop';
    document.getElementById('inp-p').value = 'pw1234';
  });
  await page2.evaluate(() => login());
  await page2.waitForFunction(() => {
    const e = document.getElementById('login-err');
    return e && e.style.display === 'block' && (e.textContent || '').trim().length > 0;
  }, { timeout: 15000 });
  const errText = await page2.evaluate(() => document.getElementById('login-err').textContent.trim());
  check('shows the server message, not "Invalid credentials"',
        /Already freeop is logged in/.test(errText), errText);
  check('tells the user how to get in', /admin|sign out/i.test(errText), errText);
  check('stays on the login screen',
        await page2.evaluate(() => document.getElementById('app').style.display !== 'block'));
  check('offers no override button',
        await page2.evaluate(() => !/switch to this device/i.test(document.getElementById('login-err').innerHTML)));

  // ══ [C] USERS SCREEN ═══════════════════════════════════════════════
  console.log('\n[C] Users screen');

  await uiLogin(page, 'uiadmin', 'pw1234');
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 15000 });
  await page.evaluate(() => go('users'));
  await page.waitForFunction(() => /lockedop/.test(document.getElementById('users-list')?.textContent || ''), { timeout: 15000 });

  const usersUi = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#users-list tr')];
    const row = rows.find(r => /lockedop/.test(r.textContent));
    const adminRow = rows.find(r => /\badmin\b/.test(r.cells?.[0]?.textContent || ''));
    return {
      headers: [...document.querySelectorAll('#tc-users thead th')].map(t => t.textContent.trim()),
      lockedRow: row ? row.textContent : '',
      lockedHtml: row ? row.innerHTML : '',
      adminRowText: adminRow ? adminRow.textContent : '',
      adminRowHtml: adminRow ? adminRow.innerHTML : '',
    };
  });
  check('Branch column is in the header', usersUi.headers.some(h => /^Branch$/.test(h)),
        JSON.stringify(usersUi.headers));
  check('locked user shows their branch', /CUMBUM/.test(usersUi.lockedRow), usersUi.lockedRow);
  check('locked user has a Branch button', /openUserBranchModal/.test(usersUi.lockedHtml));
  check('admin row reads "all branches"', /all branches/.test(usersUi.adminRowText), usersUi.adminRowText);
  check('admin row has no Branch button', !/openUserBranchModal/.test(usersUi.adminRowHtml));

  // freeop is online (page2's attempt failed, but page1 signed them in
  // earlier), so their row must carry the Sign out escape hatch.
  const freeRowHtml = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#users-list tr')].find(r => /freeop/.test(r.textContent));
    return row ? row.innerHTML : '';
  });
  check('an online user offers Sign out', /forceSignOutUser/.test(freeRowHtml), freeRowHtml.slice(0, 300));

  // The branch modal must populate from the configured branch list.
  const modal = await page.evaluate(() => {
    openUserBranchModal(999, 'someone', 'CUMBUM');
    const s = document.getElementById('ub-branch');
    return { opts: [...s.options].map(o => o.value), value: s.value };
  });
  check('branch modal lists "no lock" plus every configured branch',
        modal.opts.join(',') === ',BODINAYAKANUR,CUMBUM', JSON.stringify(modal.opts));
  check('branch modal preselects the current branch', modal.value === 'CUMBUM', modal.value);
  await page.evaluate(() => hideModal('user-branch-modal'));

  // ══ [D] CONCURRENT-ADMIN BANNER ════════════════════════════════════
  console.log('\n[D] concurrent-admin banner');

  // This page is signed in as admin. Sign a SECOND admin in out-of-band;
  // the poll should surface a banner here within a couple of ticks.
  await api('POST', '/api/users', { username: 'admin9', password: 'pw1234', role: 'admin' });
  const a9 = await api('POST', '/api/login', { username: 'admin9', password: 'pw1234' });
  check('second admin gets the reciprocal notice inline',
        /admin/i.test(a9.d && a9.d.notice || ''), JSON.stringify(a9.d && a9.d.notice));

  await page.evaluate(() => pollSessionAlerts());
  await page.waitForFunction(
    () => (document.getElementById('sa-alert-stack')?.textContent || '').includes('admin9'),
    { timeout: 15000 }
  );
  const banner = await page.evaluate(() => document.getElementById('sa-alert-stack').textContent.trim());
  check('already-online admin sees a banner naming the other admin',
        /admin9/.test(banner), banner);
  check('banner says what it is', /Another admin is signed in/.test(banner), banner);

  // The banner must sit UNDER the topbar, not on top of it. It used to be
  // pinned at a flat top:10px, which covered Refresh / text size / Logout —
  // and covered more of them the larger the text size got.
  const clearsTopbar = async () => page.evaluate(() => {
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const bn  = document.querySelector('#sa-alert-stack > div');
    if (!bn) return { ok:false, why:'no banner' };
    const b = bn.getBoundingClientRect();
    return { ok: b.top >= bar.bottom - 1, barBottom: Math.round(bar.bottom), bannerTop: Math.round(b.top) };
  });
  const clr = await clearsTopbar();
  check('banner clears the topbar at the default text size', clr.ok, JSON.stringify(clr));
  // …and still clears it once the bar has grown with the text size.
  await page.evaluate(() => applyTextSize('xxl', { silent:true }));
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await new Promise(r => setTimeout(r, 400));
  const clrBig = await clearsTopbar();
  check('banner still clears the topbar at 145%', clrBig.ok, JSON.stringify(clrBig));
  await page.evaluate(() => applyTextSize('md', { silent:true }));
  await new Promise(r => setTimeout(r, 300));

  // Two independent sources feed this stack and both must be present:
  // the login-time notice (uiadmin signed in while the API's `admin`
  // session was live) and the polled row about admin9. The login notice
  // has no server row behind it, so only the polled one gets acked.
  const bannerCount = await page.evaluate(() => document.querySelectorAll('#sa-alert-stack > div').length);
  check('login-time notice and polled alert both render', bannerCount === 2, `found ${bannerCount}`);

  // Dismiss every banner. The polled one acks server-side, so it must not
  // reappear on the next tick; the local one has nothing to come back from.
  await page.evaluate(() => {
    document.querySelectorAll('#sa-alert-stack button').forEach(b => b.click());
  });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => pollSessionAlerts());
  await new Promise(r => setTimeout(r, 600));
  const afterAck = await page.evaluate(() => document.getElementById('sa-alert-stack').textContent.trim());
  check('dismissed banners stay dismissed across a poll', afterAck === '', afterAck);

  // And the ack really landed server-side, not just in the page's local
  // dismissed-set — a reload must not bring it back.
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 15000 });
  await page.evaluate(() => pollSessionAlerts());
  await new Promise(r => setTimeout(r, 800));
  const afterReload = await page.evaluate(() => document.getElementById('sa-alert-stack').textContent.trim());
  check('ack persisted — banner gone after a reload too', afterReload === '', afterReload);

  // ══ [E] LOGOUT CLEARS THE SESSION-SCOPED STATE ═════════════════════
  // logout() touches the banner state and the branch lock. A typo there
  // would throw a ReferenceError only at logout time, which no other
  // check in this file would reach.
  console.log('\n[E] logout clears branch lock and banners');

  await page.evaluate(() => pollSessionAlerts());
  await api('POST', '/api/users', { username: 'admin8', password: 'pw1234', role: 'admin' });
  await api('POST', '/api/login', { username: 'admin8', password: 'pw1234' });
  await page.evaluate(() => pollSessionAlerts());
  await page.waitForFunction(
    () => (document.getElementById('sa-alert-stack')?.textContent || '').includes('admin8'),
    { timeout: 15000 }
  );

  const logoutState = await page.evaluate(() => {
    logout();
    return {
      branch: window._userBranch,
      role: window._userRole,
      banners: document.getElementById('sa-alert-stack').textContent.trim(),
      onLogin: document.getElementById('login').style.display !== 'none',
    };
  });
  check('logout runs without throwing and returns to the login screen', logoutState.onLogin === true,
        JSON.stringify(logoutState));
  check('logout clears the branch lock', logoutState.branch === '', JSON.stringify(logoutState.branch));
  check('logout clears the banners', logoutState.banners === '', logoutState.banners);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('test crashed:', e, '\n', srvLog.slice(-3000));
  cleanup();
  process.exit(1);
});
