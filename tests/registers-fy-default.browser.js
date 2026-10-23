// Registers — the default From date.
//
// It was the first of the CURRENT MONTH, which is the wrong window for every
// register on this screen: these are season documents read against the
// financial year, so the default silently hid everything before the 1st and
// the operator widened the range on every visit.
//
//   [fy]     From defaults to Settings → Season → "FY Start Date".
//   [blank]  With no FY set, the old first-of-month default stands — an empty
//            From would list every trade ever recorded.
//   [keep]   A date the operator already typed is never overwritten.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'regfy-'));
const PORT = 48061;
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
  const put = (settings) => fetch(B + '/api/company-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
    body: JSON.stringify({ settings }),
  });

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

  // Read the From default after a fresh load with the given settings.
  const fromAfterLoad = async (preset) => {
    const page = await browser.newPage();
    page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
    await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('t', t), T);
    await page.goto(B + '/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1500));
    const out = await page.evaluate(async (pre) => {
      const f = document.getElementById('reg-from');
      if (f) f.value = pre || '';            // pre-existing value, or cleared
      await loadRegisterDefault();
      return { from: (document.getElementById('reg-from') || {}).value,
               to:   (document.getElementById('reg-to')   || {}).value };
    }, preset).catch(() => null);
    await page.close();
    return out;
  };

  console.log('[fy] From defaults to the FY start date');
  await put({ season_start: '2026-04-01' });
  let r = await fromAfterLoad('');
  check('From is the configured FY start', r && r.from === '2026-04-01', r);
  check('…and To is still today', r && /^\d{4}-\d{2}-\d{2}$/.test(r.to || ''), r);

  console.log('\n[blank] no FY set → the old first-of-month default stands');
  await put({ season_start: '' });
  r = await fromAfterLoad('');
  const firstOfMonth = (r && r.to) ? r.to.slice(0, 8) + '01' : '';
  check('From falls back to the 1st of this month', r && r.from === firstOfMonth, { r, firstOfMonth });
  check('…never blank, which would list every trade ever', !!(r && r.from), r);

  console.log('\n[keep] a date the operator typed is left alone');
  await put({ season_start: '2026-04-01' });
  r = await fromAfterLoad('2025-01-15');
  check('the typed From survives', r && r.from === '2025-01-15', r);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
