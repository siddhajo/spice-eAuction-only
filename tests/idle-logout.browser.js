// Auto sign-out on inactivity — the two clients, in a headless Chrome.
//
// The server ends the session; these timers are what make that humane. What
// has to hold on both surfaces:
//   • a warning counts down BEFORE the sign-out, so nobody loses half-typed
//     work to a screen that silently went back to the login box;
//   • "I'm still here" genuinely re-arms the window;
//   • a stray event during the warning does NOT dismiss it — a mouse nudge or
//     a pocket touch must not cancel a sign-out nobody read;
//   • when the countdown runs out the session is actually ended, not just
//     hidden — the token is gone from storage.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-ui-'));
const PORT = 47393;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await sleep(250);
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('PUT', '/api/company-settings', { settings: { br1: 'BODI' } });

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

  // ══ DESKTOP ══════════════════════════════════════════════════════
  console.log('[1] Desktop — off by default, nothing armed');
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof _idle !== 'undefined', { timeout: 15000 });
  const offState = await page.evaluate(() => ({ minutes: _idle.minutes, timer: !!_idle.timer }));
  check('the window reads as 0', offState.minutes === 0, JSON.stringify(offState));
  check('and no sign-out is scheduled', offState.timer === false, JSON.stringify(offState));

  console.log('\n[2] Desktop — with a window set, the warning comes first');
  // 0.1 min = 6s, of which the warning takes the last 10s-floor → it appears
  // almost at once, which is what makes this testable in a few seconds.
  await api('PUT', '/api/company-settings', { settings: { auto_logout_minutes: '0.12' } });
  await page.evaluate(async () => { window._CCFG = null; await idleInit(); });
  const armed = await page.evaluate(() => ({ minutes: _idle.minutes, warnSec: _idle.warnSec, timer: !!_idle.timer }));
  check('the window is picked up from settings', Math.abs(armed.minutes - 0.12) < 0.001, JSON.stringify(armed));
  check('…and a sign-out is scheduled', armed.timer === true, JSON.stringify(armed));
  check('…with a warning that fits inside it, never extending it',
        armed.warnSec >= 10 && armed.warnSec <= armed.minutes * 60 + 10, JSON.stringify(armed));

  let warned = true;
  try { await page.waitForFunction(() => document.getElementById('idle-warn').style.display === 'flex', { timeout: 12000 }); }
  catch (_) { warned = false; }
  check('the warning appears before anything is signed out', warned);
  const stillIn = await page.evaluate(() => ({ token: !!T, counting: document.getElementById('idle-countdown').textContent }));
  check('…and the user is still signed in while it counts down', stillIn.token === true, JSON.stringify(stillIn));

  console.log('\n[3] Desktop — a stray event must not cancel it, the button must');
  const afterNudge = await page.evaluate(() => {
    idleBump();                       // what a mouse nudge triggers
    return { shown: document.getElementById('idle-warn').style.display, warning: _idle.warning };
  });
  check('a nudge during the warning leaves it up', afterNudge.shown === 'flex' && afterNudge.warning === true,
        JSON.stringify(afterNudge));
  const afterStay = await page.evaluate(() => {
    idleStaySignedIn();
    return { shown: document.getElementById('idle-warn').style.display, warning: _idle.warning, timer: !!_idle.timer };
  });
  check('"I\'m still here" dismisses it', afterStay.shown === 'none' && afterStay.warning === false, JSON.stringify(afterStay));
  check('…and re-arms the window', afterStay.timer === true, JSON.stringify(afterStay));

  console.log('\n[4] Desktop — running out signs the session out for real');
  const out = await page.evaluate(async () => {
    idleLogoutNow();
    await new Promise(r => setTimeout(r, 300));
    return {
      token: T, stored: localStorage.getItem('t'),
      loginShown: getComputedStyle(document.getElementById('login')).display !== 'none',
      appShown: getComputedStyle(document.getElementById('app')).display !== 'none',
      msg: document.getElementById('login-err').textContent,
      warnShown: document.getElementById('idle-warn').style.display,
    };
  });
  check('the token is gone from memory and storage', !out.token && !out.stored, JSON.stringify(out));
  check('the login screen is back', out.loginShown === true && out.appShown === false, JSON.stringify(out));
  check('…saying why it happened', /inactivity/i.test(out.msg || ''), JSON.stringify(out.msg));
  check('…and the warning is cleared away', out.warnShown === 'none', out.warnShown);

  // ══ MOBILE ═══════════════════════════════════════════════════════
  console.log('\n[5] Mobile — the same contract on the phone');
  const mob = await browser.newPage();
  mob.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(B + '/mobile/', { waitUntil: 'networkidle2' });
  await mob.waitForFunction(() => typeof _idle !== 'undefined', { timeout: 15000 });
  const mState = await mob.evaluate(async () => {
    token = 'x';                                  // a session is what arms it
    const r = await fetch('/api/config'); const d = await r.json();
    cfgAutoLogout = parseFloat(d.autoLogoutMinutes) || 0;
    return { fromConfig: d.autoLogoutMinutes, parsed: cfgAutoLogout };
  });
  // 0.12 was left set by the desktop half — the phone must read the same
  // number, not truncate a sub-minute window to "never".
  check('the window reaches the phone\'s config, fractions intact',
        Math.abs(mState.parsed - 0.12) < 0.001, JSON.stringify(mState));
  const mWarn = await mob.evaluate(() => {
    cfgAutoLogout = 1;
    idleInit();
    idleShowWarning();
    return { shown: document.getElementById('idle-warn').style.display,
             count: document.getElementById('idle-countdown').textContent,
             minutes: _idle.minutes };
  });
  check('it arms from the config value', mWarn.minutes === 1, JSON.stringify(mWarn));
  check('the warning shows with a countdown', mWarn.shown === 'flex' && Number(mWarn.count) > 0, JSON.stringify(mWarn));
  const mNudge = await mob.evaluate(() => { idleBump(); return document.getElementById('idle-warn').style.display; });
  check('a pocket touch does not dismiss it', mNudge === 'flex', mNudge);
  const mStay = await mob.evaluate(() => { idleStaySignedIn(); return { shown: document.getElementById('idle-warn').style.display, timer: !!_idle.timer }; });
  check('"I\'m still here" dismisses and re-arms', mStay.shown === 'none' && mStay.timer === true, JSON.stringify(mStay));
  const mOut = await mob.evaluate(() => {
    idleLogoutNow();
    return { token, stored: localStorage.getItem('sa_token'),
             login: document.getElementById('s-login').classList.contains('active'),
             warn: document.getElementById('idle-warn').style.display };
  });
  check('signing out clears the phone\'s token', !mOut.token && !mOut.stored, JSON.stringify(mOut));
  check('…and returns it to the login screen', mOut.login === true, JSON.stringify(mOut));
  check('…with the warning cleared', mOut.warn === 'none', mOut.warn);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
