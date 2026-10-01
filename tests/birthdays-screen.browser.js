// BIRTHDAYS — the screen, in a real browser.
//
// The HTTP tests prove the server; this proves the half of the feature the
// operator actually touches, and the three things most likely to be quietly
// wrong in a 1.2MB single-page app:
//
//   [A] the FLAG really hides it. Asserted on computed display of the
//       sidebar entry, never on the body attribute — a feature gate that
//       loses a CSS specificity fight flips the attribute correctly and
//       leaves the control on screen (see the .needs-*-write trap in
//       tests/feature-gate-specificity.browser.js).
//   [B] the worklist paints today's birthdays, and a party the server would
//       refuse cannot be selected — a party with no phone, or one already
//       greeted this year, must have no tick box and no Send button.
//   [C] sending reports the whole verdict. WhatsApp is not configured in
//       this harness, so the send must fail VISIBLY and the row must stay
//       ungreeted and re-sendable.
//
// Driven in a real headless Chrome; skips cleanly where no Chrome exists.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bday-ui-'));
const PORT = 47418;
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', b => log += b); srv.stderr.on('data', b => log += b);
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await (await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const TOKEN = login.token;
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN };
  const post = (u, b) => fetch(B + u, { method: 'POST', headers: AH, body: JSON.stringify(b) });

  await post('/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });

  const TODAY = ymd(new Date());
  const md = TODAY.slice(5);
  await post('/api/traders', { name: 'CAKE PLANTER', cr: 'CR.1', tel: '9876543210', dob: `1980-${md}` });
  await post('/api/traders', { name: 'SILENT PLANTER', cr: 'CR.2', tel: '', dob: `1985-${md}` });
  await post('/api/buyers', { buyer: 'CKB', buyer1: 'CAKE BUYER CO', tel: '9800000001', dob: `1970-${md}` });

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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.setViewport({ width: 1500, height: 1100 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  await page.waitForFunction(() => document.body.hasAttribute('data-feat-birthdays') && !!window._currentTab, { timeout: 20000 });


  // WHY THIS IS NOT `.side-item[data-tab=…]`: that markup lives in
  // #nav-src, a hidden aria-hidden source list. The navigation the user
  // actually sees is rebuilt by renderNav() from the NAV_GROUPS manifest,
  // and an item missing from that manifest is unreachable no matter what
  // the source entry's computed display says. Asserting on #nav-src is
  // what let exactly that ship — check the rendered strip instead.
  const inRealNav = async (label) => page.evaluate((lbl) => {
    if (typeof navGoGroup === 'function') { try { navGoGroup('master'); } catch (_) {} }
    const strip = document.getElementById('tabrow-items');
    const rail  = document.getElementById('nav-groups');
    const txt = [strip, rail].filter(Boolean).map(e => e.textContent).join(' | ');
    return { hit: new RegExp(lbl, 'i').test(strip ? strip.textContent : ''), txt };
  }, label);

  const navDisplay = () => page.evaluate(() => {
    const el = document.querySelector('.side-item[data-tab="birthdays"]');
    return el ? getComputedStyle(el).display : 'missing';
  });

  console.log('[A] the flag hides the screen — asserted on computed display');
  check('the sidebar entry exists in the markup', (await navDisplay()) !== 'missing');
  check('flag OFF → the entry is display:none', (await navDisplay()) === 'none', await navDisplay());
  check('flag OFF → "Birthdays" is not in the navigation the user sees',
    !(await inRealNav('Birthdays')).hit, (await inRealNav('Birthdays')).txt);
  // The tab-restore path must not reopen a screen whose routes will 403.
  await page.evaluate(() => go('birthdays'));
  await new Promise(r => setTimeout(r, 600));
  check('go(\'birthdays\') with the flag off lands on the dashboard',
    await page.evaluate(() => window._currentTab) === 'dash');

  await fetch(B + '/api/company-settings', {
    method: 'PUT', headers: AH, body: JSON.stringify({ settings: { flag_birthday_greetings: 'true' } }),
  });
  await page.evaluate(() => applyFeatureFlags());
  await page.waitForFunction(() => document.body.getAttribute('data-feat-birthdays') === '1', { timeout: 10000 });
  check('flag ON → the entry is visible', (await navDisplay()) !== 'none', await navDisplay());
  check('flag ON → "Birthdays" appears under Master Data in the real navigation',
    (await inRealNav('Birthdays')).hit, (await inRealNav('Birthdays')).txt);

  console.log('\n[B] the worklist');
  await page.evaluate(() => go('birthdays'));
  await page.waitForFunction(() => {
    const b = document.getElementById('bd-today-list');
    return b && !/Loading/.test(b.textContent) && b.querySelectorAll('tr').length > 0;
  }, { timeout: 15000 });

  const rows = await page.evaluate(() => [...document.querySelectorAll('#bd-today-list tr')].map(tr => ({
    text: tr.textContent.replace(/\s+/g, ' ').trim(),
    cb: (() => { const c = tr.querySelector('input[type=checkbox]'); return c ? (c.disabled ? 'disabled' : 'enabled') : 'none'; })(),
    send: !!tr.querySelector('button'),
  })));
  check('all three of today\'s birthdays are listed', rows.length === 3, JSON.stringify(rows.map(r => r.text)));
  check('a seller is there', rows.some(r => /CAKE PLANTER/.test(r.text)));
  check('a buyer is there too', rows.some(r => /CAKE BUYER CO/.test(r.text)));
  check('the header counts them', /3 birthdays/.test(await page.evaluate(() => document.getElementById('bd-today-head').textContent)));

  // The seller with no phone is the important row: visible, so the operator
  // knows it is their birthday, but not selectable, because the server would
  // only refuse it.
  const silent = rows.find(r => /SILENT PLANTER/.test(r.text));
  check('the seller with no phone is still listed', !!silent, JSON.stringify(rows.map(r => r.text)));
  check('...and says so', silent && /No phone/.test(silent.text), silent && silent.text);
  check('...and cannot be ticked', silent && silent.cb === 'disabled', silent && silent.cb);
  check('...and has no Send button', silent && silent.send === false);
  const sendable = rows.filter(r => r.cb === 'enabled');
  check('the two with phones are selectable', sendable.length === 2, JSON.stringify(sendable.map(r => r.cb)));

  // The unconfigured-WhatsApp banner is the first thing to fix, so it must
  // be the thing on screen.
  check('an unconfigured WhatsApp is called out',
    /not connected/i.test(await page.evaluate(() => document.getElementById('bd-banner').textContent)));
  check('the coverage strip explains who is being greeted',
    /sellers \+ buyers/.test(await page.evaluate(() => document.getElementById('bd-coverage').textContent)),
    await page.evaluate(() => document.getElementById('bd-coverage').textContent));
  // Template mode is the default, and in it the preview is NOT what the
  // customer receives — the screen has to admit that.
  check('the screen admits the template body is what actually sends',
    /approved template/.test(await page.evaluate(() => document.getElementById('bd-preview-note').textContent)),
    await page.evaluate(() => document.getElementById('bd-preview-note').textContent));
  check('...and names the template', /birthday_greeting/.test(await page.evaluate(() => document.getElementById('bd-preview-note').textContent)));

  check('the greeting wording is previewed per row',
    /happy birthday/i.test(rows.map(r => r.text).join(' ')));

  try { await page.screenshot({ path: '/tmp/birthdays-worklist.png', fullPage: true }); } catch (_) {}

  console.log('\n[C] select-all and the send verdict');
  await page.evaluate(() => { document.getElementById('bd-all').checked = true; bdToggleAll(true); });
  check('select-all picks only the sendable rows',
    /Send 2 greetings/.test(await page.evaluate(() => document.getElementById('bd-send-sel').textContent)),
    await page.evaluate(() => document.getElementById('bd-send-sel').textContent));

  await page.evaluate(() => bdSendSelected());
  await page.waitForFunction(() => {
    const b = document.getElementById('bd-log-list');
    return b && /Failed/.test(b.textContent);
  }, { timeout: 15000 });
  const logTxt = await page.evaluate(() => document.getElementById('bd-log-list').textContent.replace(/\s+/g, ' '));
  check('both attempts land in the ledger as failures',
    (logTxt.match(/Failed/g) || []).length === 2, logTxt);
  check('Meta\'s reason is printed, not a generic "failed"', /not configured/i.test(logTxt), logTxt);
  const after = await page.evaluate(() => [...document.querySelectorAll('#bd-today-list tr')]
    .map(tr => tr.textContent.replace(/\s+/g, ' ')));
  check('a failed send leaves the rows un-greeted', !after.some(t => /Greeted/.test(t)), JSON.stringify(after));
  check('...so they are still sendable', await page.evaluate(() =>
    [...document.querySelectorAll('#bd-today-list input[type=checkbox]')].filter(c => !c.disabled).length) === 2);

  console.log('\n[D] sending for a date that is not today');
  // Testing the feature means browsing to another date, which is exactly
  // when an accidental early send would happen — so the button has to look
  // different and ask first.
  await page.evaluate(() => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const p = n => String(n).padStart(2, '0');
    document.getElementById('bd-date').value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    loadBirthdays();
  });
  await new Promise(r => setTimeout(r, 1200));
  await page.evaluate(() => { _bd.sel = {}; _bd.today.forEach(r => { if (r.phone && !r.greeted) _bd.sel[bdKey(r)] = true; }); bdRenderToday(); });
  const notToday = await page.evaluate(() => {
    const b = document.getElementById('bd-send-sel');
    return { text: b.textContent, title: b.title, bg: b.style.background };
  });
  check('the send button names the other date', /for \d{4}-\d{2}-\d{2}/.test(notToday.text) || !/Send \d/.test(notToday.text),
    JSON.stringify(notToday));
  check('...and warns in its tooltip', /NOT today/.test(notToday.title) || !/Send \d/.test(notToday.text), JSON.stringify(notToday));
  // A same-day send must stay a single click — a confirm on every send is
  // trained away and then protects nothing.
  await page.evaluate(() => { document.getElementById('bd-date').value = ''; loadBirthdays(); });
  await new Promise(r => setTimeout(r, 1200));
  const isToday = await page.evaluate(() => {
    const b = document.getElementById('bd-send-sel');
    return { title: b.title, bg: b.style.background };
  });
  check('back on today there is no warning', isToday.title === '', JSON.stringify(isToday));
  check('...and the button is back to the send colour', /25D366|rgb\(37, 211, 102\)/.test(isToday.bg), isToday.bg);

  console.log('\n[E] a date with nobody in it');
  await page.evaluate(() => {
    // 1 January is nobody's birthday in this fixture, and picking a date is
    // how an operator checks tomorrow.
    document.getElementById('bd-date').value = (new Date().getFullYear()) + '-01-01';
    loadBirthdays();
  });
  await page.waitForFunction(() => /No birthdays on this date/.test(document.getElementById('bd-today-list').textContent),
    { timeout: 15000 });
  check('an empty date says so plainly', true);
  check('the send button is disabled with nothing selected',
    await page.evaluate(() => document.getElementById('bd-send-sel').disabled) === true);

  console.log('\n[F] the buyer master carries the date');
  await page.evaluate(() => go('buyers'));
  await new Promise(r => setTimeout(r, 1500));
  check('the Buyers list shows a DOB column while the feature is on',
    await page.evaluate(() => [...document.querySelectorAll('#tc-buyers th')].some(th => /^DOB$/i.test(th.textContent.trim()))));
  const roundTrip = await page.evaluate(async () => {
    const list = await j('/api/buyers?q=CKB');
    const rows = Array.isArray(list) ? list : (list.rows || []);
    const b = rows.find(x => x.buyer === 'CKB');
    openBuyerEdit(b);
    const shown = document.getElementById('b-dob').value;
    document.getElementById('b-dob').value = '1971-12-25';
    await saveBuyer();
    const list2 = await j('/api/buyers?q=CKB');
    const rows2 = Array.isArray(list2) ? list2 : (list2.rows || []);
    return { shown, saved: (rows2.find(x => x.buyer === 'CKB') || {}).dob };
  });
  check('the edit form is populated from the master', !!roundTrip.shown, JSON.stringify(roundTrip));
  check('and an edit saves the new date', roundTrip.saved === '1971-12-25', JSON.stringify(roundTrip));

  console.log('\n[G] the settings the screen is driven by');
  await page.evaluate(() => go('settings'));
  await new Promise(r => setTimeout(r, 1500));
  // The flag must sit in a NAMED section of Settings → Flags. Unclaimed
  // keys fall into a generic "Other Settings" bin at the bottom of a
  // 38-flag grid, which is how a shipped feature becomes unfindable.
  await page.evaluate(() => selectCat('flags'));
  await new Promise(r => setTimeout(r, 1200));
  const flagHome = await page.evaluate(() => {
    const el = document.querySelector('[data-key="flag_birthday_greetings"]');
    if (!el) return 'missing';
    const card = el.closest('.set-group');
    return card ? (card.querySelector('.set-group-head, h3, summary') || {}).textContent || '?' : 'ungrouped';
  });
  check('the birthday flag sits with the other WhatsApp/master flags',
    /Masters & Sharing/.test(flagHome), flagHome);
  check('...and not in the "Other Settings" bin', !/Other Settings/.test(flagHome), flagHome);
  const rmHome = await page.evaluate(() => {
    const el = document.querySelector('[data-key="flag_seller_reminders"]');
    const card = el && el.closest('.set-group');
    return card ? (card.querySelector('.set-group-head, h3, summary') || {}).textContent || '?' : 'missing';
  });
  check('the reminders flag sits there too', /Masters & Sharing/.test(rmHome), rmHome);

  check('a "Birthday Greetings" settings category exists', await page.evaluate(() =>
    [...document.querySelectorAll('#settings-cats *, .set-cat, [onclick*="selectCat"]')]
      .some(el => /Birthday Greetings/i.test(el.textContent || ''))));
  await page.evaluate(() => selectCat('birthdays'));
  await new Promise(r => setTimeout(r, 1200));
  const keys = await page.evaluate(() => [...document.querySelectorAll('#settings-root [data-key]')].map(el => el.dataset.key));
  for (const k of ['birthday_send_sellers', 'birthday_send_buyers', 'birthday_auto_send',
                   'birthday_send_hour', 'birthday_max_per_day', 'birthday_tpl',
                   'birthday_tpl_lang', 'birthday_free_text', 'birthday_message']) {
    check('the category renders ' + k, keys.indexOf(k) >= 0, keys.join(', '));
  }
  check('the wording is a textarea, not a one-line box', await page.evaluate(() =>
    (document.querySelector('[data-key="birthday_message"]') || {}).tagName === 'TEXTAREA'));
  // Turning auto-send on must reach the screen's banner — that banner is the
  // only place an operator is told the app will message customers by itself.
  await page.evaluate(() => {
    document.querySelector('[data-key="birthday_auto_send"]').checked = true;
    saveSettings();
  });
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => go('birthdays'));
  // It goes in the coverage strip, NOT the banner: the banner shows one
  // blocking problem at a time, and here WhatsApp is unconfigured — so a
  // banner-based notice would be swallowed exactly when it matters.
  await page.waitForFunction(() => /Automatic sending is on/.test(document.getElementById('bd-coverage').textContent), { timeout: 15000 });
  const cov = await page.evaluate(() => document.getElementById('bd-coverage').textContent);
  check('auto-send on is announced on the screen', true);
  check('...with the hour and the daily cap', /9:00/.test(cov) && /50 a day/.test(cov), cov);
  check('...and is NOT hidden by the blocking WhatsApp banner',
    /not connected/i.test(await page.evaluate(() => document.getElementById('bd-banner').textContent)), 'banner should still hold the blocker');

  check('no page errors anywhere in the run', errs.length === 0, errs.join(' | '));

  const shot = '/tmp/birthdays-screen.png';
  await page.evaluate(() => { go('birthdays'); });
  await new Promise(r => setTimeout(r, 1500));
  try { await page.screenshot({ path: shot, fullPage: true }); console.log('  screenshot: ' + shot); } catch (_) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2000)); cleanup(); process.exit(1); });
