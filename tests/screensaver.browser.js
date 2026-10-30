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
      logo: (() => { const n = document.getElementById('ss-logo');
                     return n && n.offsetParent !== null ? n.getAttribute('src') : null; })(),
      hasCompanyLine: !!document.getElementById('ss-company'),
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
  // The APP's mark, never the customer's upload. The two were conflated:
  // this panel used to copy the topbar image, so an operator saw their own
  // company logo on the one screen that is about the software.
  check('it shows the application logo', /logo-app\.svg/.test(s.logo || ''), s.logo);
  check('…not the customer company logo', !/logo-ispl/.test(s.logo || ''), s.logo);
  // The trade name belongs on every working screen, not here.
  check('the trade name is not on the panel', s.hasCompanyLine === false, s);
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

  console.log('\n[lockup] name, credit and numbers share one centre axis');
  // The complaint this covers: a long product name overflowed a 640px box
  // and wrapped mid-name, so the block read as crooked. Assert the real
  // geometry — every line centred on the same axis, and the name INSIDE its
  // container — rather than that the CSS string says "center".
  await put({ screensaver_minutes: '1', app_name: 'SpiceFlow eAuction Suite',
              app_credit: 'Powered by KJ & Co', app_contact: '9790745462 / 8248922434' });
  await open();
  const lock = await page.evaluate(() => {
    idleHideWarning(); _ss.minutes = 1; ssShow();
    const box = (id) => {
      const n = document.getElementById(id);
      if (!n || n.offsetParent === null) return null;
      const r = n.getBoundingClientRect();
      return { mid: Math.round(r.left + r.width / 2), w: Math.round(r.width),
               h: Math.round(r.height), text: n.textContent.trim() };
    };
    const col = document.getElementById('ss-app').parentElement.getBoundingClientRect();
    return {
      app: box('ss-app'),
      credit: box('ss-credit'), contact: box('ss-contact'), clock: box('ss-clock'),
      colMid: Math.round(col.left + col.width / 2), colW: Math.round(col.width),
      lineH: parseFloat(getComputedStyle(document.getElementById('ss-app')).fontSize),
    };
  });
  check('the credit line is there', /Powered by KJ & Co/.test((lock.credit || {}).text || ''),
        lock.credit);
  check('…and the support numbers', /9790745462 \/ 8248922434/.test((lock.contact || {}).text || ''),
        lock.contact);
  check('the full name renders unabbreviated',
        /SpiceFlow eAuction Suite/.test((lock.app || {}).text || ''), lock.app);
  // One axis: every line's midpoint within a pixel of the column's.
  const axes = ['app', 'credit', 'contact', 'clock']
    .map(k => ({ k, mid: (lock[k] || {}).mid })).filter(x => x.mid != null);
  const offAxis = axes.filter(x => Math.abs(x.mid - lock.colMid) > 1);
  check('every line sits on the same centre axis', offAxis.length === 0,
        { colMid: lock.colMid, axes, offAxis });
  check('the name fits its column — no overflow', (lock.app || {}).w <= lock.colW,
        { name: (lock.app || {}).w, col: lock.colW });
  // Two lines at this size would be ~2.3x the font size tall. One line is the
  // point: a mid-name wrap is what made it look broken.
  check('…and does not wrap mid-name', (lock.app || {}).h < lock.lineH * 1.8,
        { h: (lock.app || {}).h, fontSize: lock.lineH });

  console.log('\n[unbadged] a blank credit leaves no empty rule');
  await put({ app_credit: '', app_contact: '' });
  await open();
  const bare = await page.evaluate(() => {
    idleHideWarning(); _ss.minutes = 1; ssShow();
    const by = document.getElementById('ss-by');
    return { byShown: !!by && by.offsetParent !== null,
             app: (document.getElementById('ss-app') || {}).textContent };
  });
  check('the whole byline block is gone, hairline and all', bare.byShown === false, bare);
  check('…and the name still shows', /SpiceFlow/.test(bare.app || ''), bare.app);

  console.log('\n[fireworks] it animates, stays bounded, and stops dead');
  await put({ screensaver_minutes: '1', screensaver_fireworks: 'true',
              app_credit: 'Powered by KJ & Co', app_contact: '9790745462 / 8248922434' });
  await open();
  const fx = await page.evaluate(async () => {
    idleHideWarning(); _ss.minutes = 1; ssShow();
    const cv = document.getElementById('ss-fx');
    const ctx = cv.getContext('2d');
    // Sample the canvas rather than trust the state object: this asserts
    // pixels were actually painted, not merely that a loop is running.
    const lit = () => {
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0, total = 0;
      for (let i = 3; i < d.length; i += 4 * 13) { total++; if (d[i] > 24) n++; }
      return total ? n / total : 0;      // fraction of the panel carrying light
    };
    // Sample repeatedly and keep the best frame: bursts come and go, so one
    // snapshot can legitimately land in a lull. The figure that matters is
    // the PEAK — whether a burst, when it happens, is actually visible.
    let painted = 0;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 140));
      painted = Math.max(painted, lit());
    }
    const peak = { rockets: _ssFx.rockets.length, sparks: _ssFx.sparks.length };
    // Let it run on and confirm the particle count does not grow with uptime.
    await new Promise(r => setTimeout(r, 2600));
    const later = { rockets: _ssFx.rockets.length, sparks: _ssFx.sparks.length, raf: _ssFx.raf };
    return { painted, peak, later,
             behind: getComputedStyle(cv).pointerEvents,
             canvasW: cv.width };
  });
  // A bar high enough that the near-invisible first cut would have failed
  // it: that version lit a few dozen sampled pixels at peak.
  // Measured: a real burst lights 1.2–1.6% of the panel at peak; the
  // near-invisible first cut managed about a tenth of that. 0.4% sits clear
  // of both, and being a fraction it holds at any viewport or DPR.
  check('a burst is actually visible, not a few specks', fx.painted > 0.004,
        (fx.painted * 100).toFixed(2) + '% of panel lit at peak');
  check('rockets stay under the cap', fx.peak.rockets <= 3 && fx.later.rockets <= 3, fx);
  check('…and sparks do not grow without bound', fx.later.sparks < 900, fx.later);
  check('it cannot swallow the dismissing click', fx.behind === 'none', fx.behind);
  check('the canvas is backed by real pixels', fx.canvasW > 0, fx.canvasW);

  // The point of the whole exercise: an unattended machine must not keep a
  // render loop alive behind a dismissed screensaver.
  const stopped = await page.evaluate(async () => {
    ssHide();
    await new Promise(r => setTimeout(r, 300));
    const cv = document.getElementById('ss-fx');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4 * 13) if (d[i] > 12) n++;
    return { raf: _ssFx.raf, sparks: _ssFx.sparks.length, rockets: _ssFx.rockets.length,
             flashes: _ssFx.flashes.length, lit: n };
  });
  check('hiding cancels the animation frame', stopped.raf === 0, stopped);
  check('…drops every particle', stopped.sparks === 0 && stopped.rockets === 0
        && stopped.flashes === 0, stopped);
  check('…and wipes the canvas', stopped.lit === 0, stopped);

  console.log('\n[fireworks-off] the setting turns it off completely');
  await put({ screensaver_fireworks: 'false' });
  await open();
  const off = await page.evaluate(async () => {
    idleHideWarning(); _ss.minutes = 1; ssShow();
    await new Promise(r => setTimeout(r, 1500));
    const cv = document.getElementById('ss-fx');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4 * 13) if (d[i] > 12) n++;
    return { raf: _ssFx.raf, lit: n, shown: _ss.on,
             app: (document.getElementById('ss-app') || {}).textContent };
  });
  check('no animation frame is scheduled', off.raf === 0, off);
  check('…nothing is painted', off.lit === 0, off);
  check('…but the screensaver itself still works', off.shown === true && /SpiceFlow/.test(off.app || ''), off);

  console.log('\n[login] the product names itself on the sign-in page too');
  // app_name now also prints in the login hero's footer — asked for outright
  // ("add the app name here in the login page as well"). Two properties:
  //   • it is PRE-AUTH, so it rides /api/branding beside the trade name and
  //     the logo rather than company-settings, which needs a token;
  //   • it does NOT displace the customer's own name. The sign-in card and
  //     the top bar stay the CUSTOMER's — this footer is the one place the
  //     software says what IT is.
  await put({ app_name: 'GreenGavel', trade_name: 'RNS SPICES' });
  const pub = await (await fetch(B + '/api/branding')).json();   // no Authorization header
  check('the public branding payload carries the app name', pub.appName === 'GreenGavel',
        JSON.stringify({ appName: pub.appName, tradeName: pub.tradeName }));
  check('…alongside the customer company, not instead of it', pub.tradeName === 'RNS SPICES',
        pub.tradeName);

  await page.evaluate(() => { try { localStorage.removeItem('t'); } catch (_) {} });
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));
  const login = await page.evaluate(() => {
    const app = document.getElementById('login-hero-app');
    const cs = app ? getComputedStyle(app) : null;
    return {
      loginShown: getComputedStyle(document.getElementById('login')).display !== 'none',
      text: app ? app.textContent.trim() : '(absent)',
      visible: !!(app && !app.hidden && cs.display !== 'none'),
      weight: cs ? cs.fontWeight : '',
      footText: (document.querySelector('#login .login-hero-foot') || {}).textContent || '',
      cardName: (document.getElementById('login-hero-name') || {}).textContent || '',
    };
  });
  check('the login page is what is on screen', login.loginShown === true, JSON.stringify(login));
  check('the app name prints in the hero footer', login.text === 'GreenGavel', login.text);
  check('…and is visible', login.visible === true, JSON.stringify(login));
  check('…set apart from the small print beside it', Number(login.weight) >= 700, login.weight);
  check('the copyright line is still there', /Powered by/.test(login.footText), login.footText);
  check('the customer company still names the sign-in side',
        /RNS SPICES/.test(login.cardName), login.cardName);

  // Blank app_name must leave no gap in the footer row — a flex item with no
  // text would still take its gap.
  await put({ app_name: '' });
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));
  const blank = await page.evaluate(() => {
    const app = document.getElementById('login-hero-app');
    return { hidden: app.hidden, display: getComputedStyle(app).display,
             foot: (document.querySelector('#login .login-hero-foot') || {}).textContent.trim() };
  });
  check('an unnamed install hides the slot entirely',
        blank.hidden === true && blank.display === 'none', JSON.stringify(blank));
  check('…and the rest of the footer is unharmed', /Powered by/.test(blank.foot), blank.foot);
  await put({ app_name: 'SpiceFlow eAuction Suite' });

  if (process.env.SHOT_DIR) {
    await page.evaluate(t => localStorage.setItem('t', t), T);
    await page.goto(B + '/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => { idleHideWarning(); _ss.minutes = 1; ssShow(); });
    await new Promise(r => setTimeout(r, 700));
    await page.screenshot({ path: process.env.SHOT_DIR + '/screensaver.png' });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); cleanup(); process.exit(1); });
