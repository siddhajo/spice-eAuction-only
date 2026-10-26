// Screensaver — the app's own name on an idle screen.
//
// An office machine sits on one screen all day — a priced lot grid, a
// seller's bank details — in a room people walk through. After a few quiet
// minutes this covers it; the first key or click clears it.
//
// The rule it must not break: it is NOT the sign-out, and must never stand in
// for one. The sign-out runs its own clock, its countdown draws OVER the
// screensaver, and being covered is not activity — an unattended machine
// still signs out on time.
//
//   [off]      0 minutes means never, which is the shipped default
//   [show]     it appears on idle, carrying the app name and company
//   [clear]    a key or a click clears it
//   [logout]   the sign-out warning wins: it sits above, and it takes the
//              screen back from the screensaver
//   [nosnooze] being covered does NOT reset the sign-out clock
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const PORT = 48183;
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
  const put = (settings) => fetch(B + '/api/company-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
    body: JSON.stringify({ settings }) });

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
  await page.setViewport({ width: 1400, height: 860 });

  const open = async () => {
    await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('t', t), T);
    await page.goto(B + '/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1800));
  };
  const state = () => page.evaluate(() => {
    const el = document.getElementById('screensaver');
    const warn = document.getElementById('idle-warn');
    const cs = getComputedStyle(el);
    return {
      shown: cs.display !== 'none',
      z: Number(cs.zIndex), warnZ: Number(getComputedStyle(warn).zIndex),
      warnShown: getComputedStyle(warn).display !== 'none',
      app: (document.getElementById('ss-app') || {}).textContent,
      company: (document.getElementById('ss-company') || {}).textContent,
      clock: (document.getElementById('ss-clock') || {}).textContent,
      minutes: (typeof _ss !== 'undefined') ? _ss.minutes : null,
      ariaHidden: el.getAttribute('aria-hidden'),
    };
  });

  console.log('[off] 0 minutes means never — the shipped default');
  await put({ screensaver_minutes: '0', auto_logout_minutes: '0', trade_name: 'RNS SPICES' });
  await open();
  let s = await state();
  check('it is off by default', s.minutes === 0 && !s.shown, s);
  // Force the timer to fire: even then, 0 must mean never.
  await page.evaluate(() => ssShow());
  s = await state();
  check('…and cannot be shown while off', !s.shown, s);

  console.log('\n[show] it appears on idle, named');
  // A tiny window; ssArm floors the wait at 5s so this is the real path.
  await put({ screensaver_minutes: '0.05', app_name: 'GreenGavel' });
  await open();
  await page.evaluate(() => { if (typeof idleInit === 'function') idleInit(); });
  await new Promise(r => setTimeout(r, 6500));
  s = await state();
  check('the screensaver is up', s.shown, s);
  check('it carries the application name', /GreenGavel/.test(s.app || ''), s.app);
  check('…and the company underneath', /RNS SPICES/i.test(s.company || ''), s.company);
  check('…and an IST clock', /\d{2}:\d{2}\s*IST/.test(s.clock || ''), s.clock);
  check('it is scenery, not content (aria-hidden)', s.ariaHidden === 'true', s.ariaHidden);

  console.log('\n[clear] a key or a click clears it');
  await page.keyboard.press('a');
  await new Promise(r => setTimeout(r, 400));
  s = await state();
  check('a keypress clears it', !s.shown, s);
  await new Promise(r => setTimeout(r, 6500));
  s = await state();
  check('…and it comes back after the next quiet spell', s.shown, s);
  await page.mouse.click(700, 430);
  await new Promise(r => setTimeout(r, 400));
  s = await state();
  check('a click clears it too', !s.shown, s);

  console.log('\n[logout] the sign-out warning wins');
  s = await state();
  check('the warning sits ABOVE the screensaver', s.warnZ > s.z, { warnZ: s.warnZ, z: s.z });
  await new Promise(r => setTimeout(r, 6500));
  s = await state();
  check('the screensaver is up again', s.shown, s);
  // The sign-out warning arriving must take the screen back.
  await page.evaluate(() => { _idle.minutes = 5; idleShowWarning(); });
  await new Promise(r => setTimeout(r, 400));
  s = await state();
  check('the warning is showing', s.warnShown, s);
  check('…and the screensaver got out of its way', !s.shown, s);

  console.log('\n[nosnooze] being covered does not reset the sign-out clock');
  const noTouch = await page.evaluate(() => {
    // Reset to a known state, then show the screensaver the way the timer
    // does and confirm nothing re-armed the sign-out.
    idleHideWarning();
    _idle.minutes = 10;
    idleClearTimers();
    _idle.timer = 'SENTINEL';     // stand-in: ssShow must not clear or replace it
    ssShow();
    const kept = _idle.timer === 'SENTINEL';
    _idle.timer = null;
    return { kept, ssOn: _ss.on };
  });
  check('showing the screensaver leaves the sign-out timer alone',
        noTouch.kept, noTouch);

  if (process.env.SHOT_DIR) {
    await page.evaluate(() => { idleHideWarning(); _ss.minutes = 1; ssShow(); });
    await new Promise(r => setTimeout(r, 700));
    await page.screenshot({ path: process.env.SHOT_DIR + '/screensaver.png' });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); cleanup(); process.exit(1); });
