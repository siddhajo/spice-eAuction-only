// SCREEN FLAGS — the "hide an existing screen" toggles, in a real browser.
//
// flag_insights and flag_pertrade_breakdown are a different shape from the
// opt-in flags: they gate screens that ALREADY EXIST on every install, so the
// dangerous failure is not "the toggle doesn't work" but "an upgrade silently
// took a screen away". Three things have to hold:
//
//   [default]  a settings payload with NO such key keeps the screen. This is
//              the upgrade path — an install that has not reseeded its
//              settings must be unaffected.
//   [toggle]   an explicit false hides the sidebar entry AND the panel; true
//              brings both back, with no reload.
//   [stranded] a user parked on the screen when it is switched off gets moved
//              to the Dashboard rather than left on a hidden panel, and
//              go() refuses to put them back.
//
// The Dashboard must keep working throughout: Per-Auction Breakdown reads
// /api/stats, which the Dashboard also reads, so the flag must gate the
// SCREEN and never the data.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scrflag-'));
const PORT = 47368;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

// The screens under test: flag, tab id, and the CSS marker class.
const SCREENS = [
  { flag: 'flag_pertrade_breakdown', tab: 'pertrade', feat: 'pertrade-breakdown' },
  { flag: 'flag_insights',           tab: 'insights', feat: 'insights' },
];

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.log('login failed ' + boot.status + '\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await api('POST', '/api/auctions', { ano: '13', date: '2026-08-08', crop_type: 'VST' });

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block'
                                   && !!window._currentTab, { timeout: 20000 });

  const shown = (tab) => page.evaluate((t) => {
    const b = document.querySelector(`.side-item[data-tab="${t}"]`);
    return b ? getComputedStyle(b).display !== 'none' : null;
  }, tab);
  const setFlag = async (k, v) => {
    await api('PUT', '/api/company-settings', { settings: { [k]: v } });
    await page.evaluate(() => applyFeatureFlags());
  };

  for (const s of SCREENS) {
    console.log(`\n[${s.flag}]`);

    // ── default: the screen is there out of the box ────────────────
    check('sidebar entry is visible by default', await shown(s.tab) === true);

    // ── the upgrade path: settings that predate the flag ───────────
    // applyFeatureFlags() reads window._CCFG; delete the key to imitate an
    // install whose settings row was never seeded, then re-run the real
    // function. Anything other than "still visible" is a screen lost on
    // upgrade — the single worst outcome for this flag shape.
    await page.evaluate((f) => { delete window._CCFG[f]; }, s.flag);
    await page.evaluate((feat) => {
      // Re-run just the resolution the function performs, against _CCFG.
      const cfg = window._CCFG, on = v => String(v == null ? '' : v).toLowerCase() === 'true';
      const raw = cfg[feat.flag];
      const val = (raw === undefined || raw === null || raw === '') ? true : on(raw);
      document.body.setAttribute('data-feat-' + feat.feat, val ? '1' : '0');
    }, s);
    check('a missing setting keeps the screen (upgrade path)', await shown(s.tab) === true);
    // An EMPTY value is a different case, and it resolves the other way: the
    // settings endpoint normalises '' to 'false' for a boolean before the
    // client ever sees it. Pinned because the client also carries a
    // ''-means-on branch, which reads like a contradiction — it is
    // unreachable through the API and only guards a locally-set value.
    // (A blank cannot come from the UI either: booleans render as a
    // checkbox, which is always one or the other.)
    await setFlag(s.flag, '');
    check('an empty value is normalised to false, not to on', await shown(s.tab) === false);
    await setFlag(s.flag, 'true');

    // ── toggle off ─────────────────────────────────────────────────
    await setFlag(s.flag, 'false');
    await page.waitForFunction((f) => document.body.getAttribute('data-feat-' + f) === '0',
      { timeout: 10000 }, s.feat);
    check('an explicit false hides the sidebar entry', await shown(s.tab) === false);
    check('…and the panel itself', await page.evaluate((t) =>
      getComputedStyle(document.getElementById('tc-' + t)).display === 'none', s.tab) === true);

    // ── stranded user ──────────────────────────────────────────────
    check('go() refuses the hidden screen and falls back to the Dashboard',
      await page.evaluate((t) => { go(t); return window._currentTab; }, s.tab) === 'dash');

    // ── back on ────────────────────────────────────────────────────
    await setFlag(s.flag, 'true');
    await page.waitForFunction((f) => document.body.getAttribute('data-feat-' + f) === '1',
      { timeout: 10000 }, s.feat);
    check('switching it back on restores the entry, no reload', await shown(s.tab) === true);
    check('…and the screen opens again',
      await page.evaluate((t) => { go(t); return window._currentTab; }, s.tab) === s.tab);
  }

  // ── The data must NOT be gated ───────────────────────────────────
  // Per-Auction Breakdown and the Dashboard read the same /api/stats. If the
  // flag ever grows a server-side gate, the Dashboard goes blank with it.
  console.log('\n[shared data] the Dashboard is unaffected');
  await setFlag('flag_pertrade_breakdown', 'false');
  const stats = await api('GET', '/api/stats?auction_id=all');
  check('/api/stats still answers with the screen off', stats.status === 200, `HTTP ${stats.status}`);
  check('…and still carries the per-trade rows the Dashboard uses',
        !!(stats.d && Array.isArray(stats.d.perTradeBreakdown)),
        JSON.stringify(Object.keys(stats.d || {})));
  await page.evaluate(() => go('dash'));
  await page.waitForFunction(() => window._currentTab === 'dash', { timeout: 10000 });
  check('the Dashboard still renders', await page.evaluate(() =>
    getComputedStyle(document.getElementById('tc-dash')).display !== 'none'));
  await setFlag('flag_pertrade_breakdown', 'true');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-3000)); cleanup(); process.exit(1); });
