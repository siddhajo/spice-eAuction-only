// COLLAPSIBLE WORKLIST SECTIONS — Birthdays and Seller Reminders, in a real browser.
//
// Both screens are worklists the operator works top-to-bottom, and both grow
// without bound at the bottom (the sent log). Before this, "Greetings sent"
// sat a full page below "Today" and pushed the work off screen. Every card now
// collapses and every list scrolls inside its own section.
//
// The four things that can actually break, and are asserted here:
//
//   [B] sections start EXPANDED. These screens ARE the feature (auto-send is
//       off by default), so a first visit must show the work, not a stack of
//       shut headers. A collapsed default would also hide the Send button.
//   [C] the controls that sit IN the head — Refresh, the date picker, the
//       day selector, Send selected — must not toggle the section. They are
//       inside the clickable header, so without stopPropagation every
//       refresh would also fold the card the operator is reading.
//   [D] collapsed state survives a reload, and is keyed per section.
//   [E] the lists really are height-capped with a pinned header, rather than
//       just carrying a class that says so.
//
// Driven in a real headless Chrome; skips cleanly where no Chrome exists.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-collapse-'));
const PORT = 47468;
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

// The sections, in the order the operator meets them.
const BD = ['bd-sec-intro', 'bd-sec-today', 'bd-sec-upcoming', 'bd-sec-log'];
const RM = ['rm-sec-intro', 'rm-sec-due', 'rm-sec-held', 'rm-sec-log'];

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await (await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const post = (u, b) => fetch(B + u, { method: 'POST', headers: AH, body: JSON.stringify(b) });
  const put  = (u, b) => fetch(B + u, { method: 'PUT',  headers: AH, body: JSON.stringify(b) });

  await post('/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await put('/api/company-settings', {
    settings: { flag_birthday_greetings: 'true', flag_seller_reminders: 'true' },
  });

  let chrome = null;
  for (const c of [
    () => ({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: [] }),
    () => ({ executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium', args: [] }),
    () => { const p = require('@sparticuz/chromium'); return { executablePath: p.executablePath(), args: p.args }; },
  ]) {
    try { const got = c(); if (got.executablePath && fs.existsSync(got.executablePath)) { chrome = got; break; } } catch (_) {}
  }
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.setViewport({ width: 1600, height: 1100 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());

  const signIn = async () => {
    await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#inp-u', { timeout: 15000 });
    await page.evaluate(() => {
      document.getElementById('inp-u').value = 'uiadmin';
      document.getElementById('inp-p').value = 'pw1234';
      login();
    });
    await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
    // Wait for the feature flags to land before navigating. go('birthdays')
    // before the flag is applied redirects to the hub (the gate working as
    // designed), the loader never runs, and the restore that lives in it
    // never happens — which looks exactly like "state was not remembered".
    await page.waitForFunction(() =>
      document.body.hasAttribute('data-feat-birthdays') &&
      document.body.hasAttribute('data-feat-reminders') &&
      !!window._currentTab, { timeout: 20000 });
  };
  await signIn();

  // Navigate and WAIT FOR THE SCREEN TO ACTUALLY BE SHOWN. Two traps here,
  // both of which make later assertions measure a hidden screen and read 0
  // for every dimension:
  //   - the cards are static markup, so waiting for the element to exist
  //     succeeds even when its screen was never opened;
  //   - the app finishes its own boot navigation shortly after login and
  //     lands on the hub, overriding a go() issued too early.
  // So assert on _currentTab plus the screen's computed display, and re-issue
  // go() until it sticks.
  const openScreen = async (tab, screenId) => {
    for (let i = 0; i < 20; i++) {
      await page.evaluate((t) => go(t), tab);
      try {
        await page.waitForFunction((t, sid) =>
          window._currentTab === t &&
          getComputedStyle(document.getElementById(sid)).display !== 'none',
          { timeout: 1000 }, tab, screenId);
        await new Promise(r => setTimeout(r, 400));
        return;
      } catch (_) { await new Promise(r => setTimeout(r, 300)); }
    }
    throw new Error('could not open screen ' + tab);
  };
  // Is the section's BODY actually on screen? Asserted on computed display,
  // not on the class, so a CSS rule that silently stops matching is caught.
  const bodyShown = (id) => page.evaluate((sid) => {
    const card = document.getElementById(sid);
    if (!card) return 'missing';
    const body = card.querySelector('.wl-collapsible-body');
    return body ? getComputedStyle(body).display : 'no-body';
  }, id);
  const collapsed = (id) => page.evaluate((sid) => {
    const c = document.getElementById(sid);
    return c ? c.classList.contains('is-collapsed') : null;
  }, id);
  const clickHead = (id) => page.evaluate((sid) => {
    document.getElementById(sid).querySelector('.wl-collapsible-head').click();
  }, id);

  console.log('[A] every section exists on both screens');
  await openScreen('birthdays', 'tc-birthdays');
  for (const id of BD) check(`birthdays: ${id} is a collapsible card`,
    await page.evaluate((s) => !!document.querySelector('#' + s + '.wl-collapsible'), id));
  await openScreen('reminders', 'tc-reminders');
  for (const id of RM) check(`reminders: ${id} is a collapsible card`,
    await page.evaluate((s) => !!document.querySelector('#' + s + '.wl-collapsible'), id));

  console.log('\n[B] they start EXPANDED — the work is visible on arrival');
  await openScreen('birthdays', 'tc-birthdays');
  for (const id of BD) check(`${id} open by default`, (await bodyShown(id)) !== 'none', await bodyShown(id));
  check('the Send button is reachable, not hidden behind a collapsed header',
    await page.evaluate(() => { const b = document.getElementById('bd-send-sel'); return !!(b && b.offsetParent); }));

  console.log('\n[C] the head toggles — and its controls do NOT');
  await clickHead('bd-sec-log');
  check('clicking the head collapses the section', await collapsed('bd-sec-log'));
  check('...and the body is really hidden', (await bodyShown('bd-sec-log')) === 'none', await bodyShown('bd-sec-log'));
  await clickHead('bd-sec-log');
  check('clicking again re-opens it', !(await collapsed('bd-sec-log')));
  check('...and the body is shown again', (await bodyShown('bd-sec-log')) !== 'none');

  // The controls sit INSIDE the clickable header. Without stopPropagation,
  // hitting Refresh would also fold the card being read.
  await page.evaluate(() => document.querySelector('#bd-sec-intro .wl-head-actions button:last-child').click());
  await new Promise(r => setTimeout(r, 400));
  check('Refresh inside the head does not collapse the section', !(await collapsed('bd-sec-intro')));
  await page.evaluate(() => document.getElementById('bd-date').click());
  check('the date picker inside the head does not collapse it', !(await collapsed('bd-sec-intro')));
  await page.evaluate(() => document.getElementById('bd-days').click());
  check('the day selector inside the head does not collapse "Coming up"', !(await collapsed('bd-sec-upcoming')));
  await openScreen('reminders', 'tc-reminders');
  await page.evaluate(() => document.getElementById('rm-send-sel').click());
  await new Promise(r => setTimeout(r, 400));
  check('"Send selected" inside the head does not collapse the due list', !(await collapsed('rm-sec-due')));

  console.log('\n[D] collapsed state is remembered across a reload');
  await openScreen('birthdays', 'tc-birthdays');
  await clickHead('bd-sec-log');
  await clickHead('bd-sec-upcoming');
  check('two sections collapsed', (await collapsed('bd-sec-log')) && (await collapsed('bd-sec-upcoming')));
  const stored = await page.evaluate(() => localStorage.getItem('wl_collapsed_sections'));
  check('both ids are persisted', /bd-sec-log/.test(stored || '') && /bd-sec-upcoming/.test(stored || ''), stored);
  check('it does NOT write the lot-entry key', !(await page.evaluate(() => localStorage.getItem('le_collapsed_sections'))));

  await signIn();
  await openScreen('birthdays', 'tc-birthdays');
  check('after reload: "Greetings sent" is still collapsed', await collapsed('bd-sec-log'));
  check('after reload: "Coming up" is still collapsed', await collapsed('bd-sec-upcoming'));
  check('after reload: the sections NOT collapsed stayed open', !(await collapsed('bd-sec-today')));
  // Reopen so the stored set shrinks again — proves it is a live set, not append-only.
  await clickHead('bd-sec-log');
  const stored2 = await page.evaluate(() => localStorage.getItem('wl_collapsed_sections'));
  check('re-opening removes it from the stored set', !/bd-sec-log/.test(stored2 || ''), stored2);

  console.log('\n[E] the lists scroll inside their section, header pinned');
  await openScreen('birthdays', 'tc-birthdays');
  const scrollBox = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const th = el.querySelector('thead th');
    return {
      overflowY: cs.overflowY, maxHeight: cs.maxHeight,
      thPos: th ? getComputedStyle(th).position : 'no-th',
      thTop: th ? getComputedStyle(th).top : null,
    };
  }, sel);
  // Measure only while the section is OPEN — a collapsed body is display:none
  // and every dimension reads 0, which would pass or fail for the wrong reason.
  if (await collapsed('bd-sec-log')) await clickHead('bd-sec-log');
  check('the log section is open before measuring', !(await collapsed('bd-sec-log')));
  const box = await scrollBox('#bd-sec-log .wl-scroll');
  check('the log list is a scroll container', box && box.overflowY === 'auto', JSON.stringify(box));
  check('...with a real height cap', box && /^\d+(\.\d+)?px$/.test(box.maxHeight), JSON.stringify(box));
  check('...and a sticky header', box && box.thPos === 'sticky' && box.thTop === '0px', JSON.stringify(box));
  check('every list on both screens is wrapped in a scroll container',
    await page.evaluate(() => document.querySelectorAll('#tc-birthdays .wl-scroll, #tc-reminders .wl-scroll').length) === 6,
    String(await page.evaluate(() => document.querySelectorAll('#tc-birthdays .wl-scroll, #tc-reminders .wl-scroll').length)));

  // Prove the cap actually constrains: fill the log past it and check the
  // container scrolls rather than growing the page.
  const grew = await page.evaluate(() => {
    const body = document.getElementById('bd-log-list');
    body.innerHTML = Array.from({ length: 80 },
      (_, i) => `<tr><td>row ${i}</td><td>n</td><td>t</td><td>p</td><td>h</td><td>b</td><td>s</td></tr>`).join('');
    const box = document.querySelector('#bd-sec-log .wl-scroll');
    return { scrollH: box.scrollHeight, clientH: box.clientHeight };
  });
  check('80 rows scroll inside the section instead of stretching the page',
    grew.scrollH > grew.clientH, JSON.stringify(grew));

  console.log('\n[F] the headers are coloured — in every theme, and in dark mode');
  // The colour is color-mix(accent, --card). Two traps this guards:
  //   - mixing into --spice-paper instead of --card gives a dark header on a
  //     white card under data-dark (the dark override sits on body, below the
  //     :root where --card is computed, so --card never flips);
  //   - colouring the title with --spice-text-main does flip it to near-white
  //     on that same white header, and the headings disappear.
  const headOf = (sel) => page.evaluate((s) => {
    const h = document.querySelector(s);
    const cs = getComputedStyle(h);
    const t = h.querySelector('.wl-collapsible-title');
    return { bg: cs.backgroundColor, title: getComputedStyle(t).color,
             body: getComputedStyle(h.closest('.wl-collapsible')).backgroundColor };
  }, sel);
  const setMode = (theme, dark) => page.evaluate((t, d) => {
    if (t) document.body.setAttribute('data-theme', t); else document.body.removeAttribute('data-theme');
    document.body.setAttribute('data-dark', d ? '1' : '0');
  }, theme, dark);

  await openScreen('birthdays', 'tc-birthdays');
  const lightBd = await headOf('#bd-sec-today .wl-collapsible-head');
  check('the header is tinted, not the plain card surface',
    lightBd.bg !== 'rgba(0, 0, 0, 0)' && lightBd.bg !== lightBd.body, JSON.stringify(lightBd));
  check('the title is not the same colour as its header', lightBd.title !== lightBd.bg, JSON.stringify(lightBd));

  await setMode(null, true);
  await new Promise(r => setTimeout(r, 300));
  const darkBd = await headOf('#bd-sec-today .wl-collapsible-head');
  check('dark mode: the header still matches the surface the card paints',
    darkBd.bg === lightBd.bg, JSON.stringify(darkBd));
  check('dark mode: the title is still readable, not white-on-white',
    darkBd.title === lightBd.title && darkBd.title !== darkBd.bg, JSON.stringify(darkBd));
  await setMode(null, false);

  // The accent must follow the active theme, or it is just a hardcoded tint.
  const tints = {};
  await openScreen('reminders', 'tc-reminders');
  for (const t of [null, 'violet', 'coral']) {
    await setMode(t, false); await new Promise(r => setTimeout(r, 250));
    tints[t || 'default'] = (await headOf('#rm-sec-due .wl-collapsible-head')).bg;
  }
  check('the header tint follows the theme',
    new Set(Object.values(tints)).size === 3, JSON.stringify(tints));
  await setMode(null, false);

  // Two near-identical screens must not be the same colour.
  await openScreen('birthdays', 'tc-birthdays');
  const bdTint = (await headOf('#bd-sec-today .wl-collapsible-head')).bg;
  await openScreen('reminders', 'tc-reminders');
  const rmTint = (await headOf('#rm-sec-due .wl-collapsible-head')).bg;
  check('Birthdays and Seller Reminders are tinted differently', bdTint !== rmTint,
    `bd=${bdTint} rm=${rmTint}`);

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log(`\n${pass} passed, ${fail + 1} failed`); cleanup(); process.exit(1); });
