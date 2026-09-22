// FEATURE GATES vs PERMISSION RULES — a CSS specificity fight the flag has
// to win.
//
// Permission classes are restored with
//   body[data-perm-x="1"] .btn.needs-x { display:flex !important }
// — specificity (0,3,1). A feature gate written the obvious way,
//   body:not([data-feat-y="1"]) .feat-y { display:none !important }
// — is (0,2,1) and LOSES. So does an equal-specificity gate declared earlier
// in the file, on document order. Either way the switched-off feature's
// button stays on screen, which is the one thing the switch exists to stop.
//
// This was live for "⚡ Generate All Documents": the body attribute flipped
// to '0' and the button carried on rendering, because it also carries
// .needs-invoice-write. The gates now sit in a block below the permission
// rules with .btn-qualified selectors.
//
// The check is deliberately phrased in terms of COMPUTED STYLE on a button
// that has both classes — that is the only thing that catches a regression
// here, since every intermediate step (flag stored, attribute set) can be
// perfectly correct while the button is still visible.
//
//   [gen-all]   Price Entry's one-click run hides when its flag is off
//   [dummy]     the Lots-tab Dummy Details button hides when ITS flag is off,
//               by CSS alone (its JS mirror is disabled for this check)
//   [neighbour] an ungated button beside it is untouched either way
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-gate-'));
const PORT = 47396;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const setFlags = settings => api('PUT', '/api/company-settings', { settings });

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', b => { log += b.toString(); });
srv.stderr.on('data', b => { log += b.toString(); });
let browser = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', log.slice(-2000)); cleanup(); process.exit(1); }

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
    cleanup(); process.exit(fail ? 1 : 0);
  }
  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1600, height: 1000 });

  // Reload from scratch each time: the body attributes are written once, from
  // the config fetched at boot, so a flag change only lands on a fresh load.
  async function reload() {
    await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
    await page.goto(B + '/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1200));
  }
  // Computed display of a button, with the screen it lives on opened first.
  const displayOf = (screen, id) => page.evaluate((screen, id) => {
    go(screen);
    const el = document.getElementById(id);
    return el ? getComputedStyle(el).display : 'missing';
  }, screen, id);

  console.log('[gen-all] Price Entry — ⚡ Generate All Documents (.needs-invoice-write)');
  await reload();
  check('shown by default — the flag ships ON',
        (await displayOf('pe', 'pe-gen-all')) !== 'none', await displayOf('pe', 'pe-gen-all'));
  check('[neighbour] Save & Calculate All is shown too',
        (await displayOf('pe', 'pe-save-calc')) !== 'none', await displayOf('pe', 'pe-save-calc'));

  await setFlags({ flag_generate_all_docs: 'false' });
  await reload();
  check('the body attribute flipped to 0',
        (await page.evaluate(() => document.body.getAttribute('data-feat-generate-all-docs'))) === '0');
  check('…and the button is ACTUALLY hidden, not merely marked',
        (await displayOf('pe', 'pe-gen-all')) === 'none', await displayOf('pe', 'pe-gen-all'));
  check('[neighbour] Save & Calculate All is untouched',
        (await displayOf('pe', 'pe-save-calc')) !== 'none', await displayOf('pe', 'pe-save-calc'));

  await setFlags({ flag_generate_all_docs: 'true' });
  await reload();
  check('switching it back on shows it again',
        (await displayOf('pe', 'pe-gen-all')) !== 'none', await displayOf('pe', 'pe-gen-all'));

  console.log('[dummy] Lots — 🎭 Dummy Details (.needs-lot-write)');
  // This button also has a JS visibility mirror in BulkActions._sync, which
  // would mask a broken CSS gate. Assert on the CSS alone: force the button
  // visible inline (as _sync does when lots are ticked) and see whether the
  // stylesheet still wins.
  await setFlags({ flag_lot_dummy_details: 'true' });
  await reload();
  check('flag ON → visible when the selection reveals it',
        (await page.evaluate(() => {
          go('lots');
          const el = document.getElementById('lot-bulk-dummy');
          el.style.display = 'inline-flex';
          return getComputedStyle(el).display;
        })) !== 'none');

  await setFlags({ flag_lot_dummy_details: 'false' });
  await reload();
  check('flag OFF → the stylesheet overrides even an inline display',
        (await page.evaluate(() => {
          go('lots');
          const el = document.getElementById('lot-bulk-dummy');
          el.style.display = 'inline-flex';
          return getComputedStyle(el).display;
        })) === 'none');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', log.slice(-2000)); cleanup(); process.exit(1); });
