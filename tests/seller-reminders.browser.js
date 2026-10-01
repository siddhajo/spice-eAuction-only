// SELLER REMINDERS — the screen, in a real browser.
//
// The HTTP test proves the server. This proves the half the operator
// touches, and the one thing that makes this screen different from the
// Birthdays one: the FUNNEL. On a real master "sellers who haven't booked
// in 60 days" is 834 people of whom 631 came exactly once, so a screen
// that just shows a list invites a campaign nobody meant to send. The
// funnel has to show each drop and turn the total into days-of-sending.
//
// Driven in a real headless Chrome; skips cleanly where no Chrome exists.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-ui-'));
const PORT = 47421;
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
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const daysAhead = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

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
  const put  = (u, b) => fetch(B + u, { method: 'PUT',  headers: AH, body: JSON.stringify(b) });

  await post('/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await put('/api/company-settings', { settings: { trade_name: 'RNS SPICES' } });

  const AUCTIONS = [daysAgo(160), daysAgo(120), daysAgo(80), daysAgo(2), daysAhead(8)];
  for (let i = 0; i < AUCTIONS.length; i++) await post('/api/auctions', { ano: String(i + 1), date: AUCTIONS[i] });
  const list = await (await fetch(B + '/api/auctions', { headers: AH })).json();
  const rows = Array.isArray(list) ? list : (list.rows || list.auctions || []);
  const aid = (date) => (rows.find(a => a.date === date) || {}).id;

  let lotNo = 0;
  const mkSeller = async (name, tel) => {
    const r = await (await post('/api/traders', { name, cr: 'CR', tel: tel === undefined ? '9800000001' : tel })).json();
    return r.trader && r.trader.id;
  };
  const book = async (tid, date) => post('/api/lots', { auction_id: aid(date), lot_no: 'L' + (++lotNo), trader_id: tid, qty: 100 });

  // Two lapsed regulars, one one-timer (dropped), one active, one no-phone.
  const L1 = await mkSeller('LAPSED ONE');   await book(L1, AUCTIONS[0]); await book(L1, AUCTIONS[1]);
  const L2 = await mkSeller('LAPSED TWO');   await book(L2, AUCTIONS[1]); await book(L2, AUCTIONS[2]);
  const OT = await mkSeller('ONE TIMER');    await book(OT, AUCTIONS[0]);
  const AC = await mkSeller('STILL ACTIVE'); await book(AC, AUCTIONS[0]); await book(AC, AUCTIONS[3]);
  const NP = await mkSeller('NO PHONE ONE', ''); await book(NP, AUCTIONS[0]); await book(NP, AUCTIONS[1]);
  // A seller who never booked at all. Excluded from the list by default,
  // but he is the reason the funnel's second line exists: on a real master
  // two thirds of the file look like this, and the operator has to see the
  // number before deciding whether to opt them in.
  await mkSeller('NEVER BOOKED ONE');

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
  page.on('dialog', d => d.accept());          // the 10+ confirm
  await page.setViewport({ width: 1600, height: 1100 });
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
  await page.waitForFunction(() => document.body.hasAttribute('data-feat-reminders') && !!window._currentTab, { timeout: 20000 });


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
    const el = document.querySelector('.side-item[data-tab="reminders"]');
    return el ? getComputedStyle(el).display : 'missing';
  });

  console.log('[A] the flag hides the screen — asserted on computed display');
  check('the sidebar entry exists in the markup', (await navDisplay()) !== 'missing');
  check('flag OFF → the entry is display:none', (await navDisplay()) === 'none', await navDisplay());
  check('flag OFF → "Seller Reminders" is not in the navigation the user sees',
    !(await inRealNav('Seller Reminders')).hit, (await inRealNav('Seller Reminders')).txt);
  await page.evaluate(() => go('reminders'));
  await new Promise(r => setTimeout(r, 600));
  check('go(\'reminders\') with the flag off lands on the dashboard',
    await page.evaluate(() => window._currentTab) === 'dash');
  // The two campaigns are separate switches; one must not reveal the other.
  check('the Birthdays entry is independently still hidden',
    await page.evaluate(() => { const e = document.querySelector('.side-item[data-tab="birthdays"]'); return e ? getComputedStyle(e).display : 'missing'; }) === 'none');

  await put('/api/company-settings', { settings: { flag_seller_reminders: 'true' } });
  await page.evaluate(() => applyFeatureFlags());
  await page.waitForFunction(() => document.body.getAttribute('data-feat-reminders') === '1', { timeout: 10000 });
  check('flag ON → the entry is visible', (await navDisplay()) !== 'none', await navDisplay());
  check('flag ON → "Seller Reminders" appears under Master Data in the real navigation',
    (await inRealNav('Seller Reminders')).hit, (await inRealNav('Seller Reminders')).txt);

  console.log('\n[B] the worklist');
  await page.evaluate(() => go('reminders'));
  await page.waitForFunction(() => {
    const b = document.getElementById('rm-due-list');
    return b && !/Loading/.test(b.textContent) && b.querySelectorAll('tr').length > 0;
  }, { timeout: 15000 });

  const due = await page.evaluate(() => [...document.querySelectorAll('#rm-due-list tr')].map(tr => ({
    text: tr.textContent.replace(/\s+/g, ' ').trim(),
    cb: (() => { const c = tr.querySelector('input[type=checkbox]'); return c ? (c.disabled ? 'disabled' : 'enabled') : 'none'; })(),
  })));
  check('both lapsed regulars are listed', due.length === 2, JSON.stringify(due.map(d => d.text)));
  check('the one-time seller is not', !due.some(d => /ONE TIMER/.test(d.text)));
  check('the active seller is not', !due.some(d => /STILL ACTIVE/.test(d.text)));
  check('the longest-away is first', /LAPSED ONE/.test(due[0].text), due[0].text);
  check('each row shows the booking history the operator judges on',
    due.every(d => /\d+ auctions? · \d+ lots?/.test(d.text)), JSON.stringify(due.map(d => d.text)));
  check('each row previews the message', /do send your produce/i.test(due.map(d => d.text).join(' ')));

  const held = await page.evaluate(() => document.getElementById('rm-held-list').textContent.replace(/\s+/g, ' '));
  check('the no-phone seller is under "held back"', /NO PHONE ONE/.test(held), held);
  check('...with the reason spelled out', /no phone number/.test(held), held);

  console.log('\n[C] the funnel — the reason this screen exists');
  const funnel = await page.evaluate(() => document.getElementById('rm-funnel').textContent.replace(/\s+/g, ' '));
  check('it starts from the whole master', /Sellers on file/.test(funnel), funnel);
  check('it names how many never booked, and that they are excluded',
    /1 never have/.test(funnel) && /excluded/.test(funnel), funnel);
  check('it shows the day window', /away 60–180 days/i.test(funnel.replace(/–/g, '–')), funnel);
  check('it shows the one-time sellers it dropped', /minus one-time sellers/.test(funnel), funnel);
  check('...and says how many and why', /booked fewer than 2 auctions/.test(funnel), funnel);
  check('it ends on the number that will actually be messaged', /Due a reminder now/.test(funnel), funnel);
  const cov = await page.evaluate(() => document.getElementById('rm-coverage').textContent.replace(/\s+/g, ' '));
  check('the coverage strip names every threshold in force',
    /60.180 days/.test(cov) && /2\+ auctions/.test(cov) && /45 days/.test(cov), cov);
  check('...and the next auction the message will quote',
    /next auction/.test(cov), cov);
  check('an unconfigured WhatsApp is called out',
    /not connected/i.test(await page.evaluate(() => document.getElementById('rm-banner').textContent)));

  console.log('\n[D] selecting and sending');
  await page.evaluate(() => { document.getElementById('rm-all').checked = true; rmToggleAll(true); });
  check('select-all picks the sendable rows',
    /Send 2 reminders/.test(await page.evaluate(() => document.getElementById('rm-send-sel').textContent)),
    await page.evaluate(() => document.getElementById('rm-send-sel').textContent));
  await page.evaluate(() => rmSendSelected());
  await page.waitForFunction(() => /Failed/.test(document.getElementById('rm-log-list').textContent), { timeout: 15000 });
  const logTxt = await page.evaluate(() => document.getElementById('rm-log-list').textContent.replace(/\s+/g, ' '));
  check('both attempts land in the ledger as failures', (logTxt.match(/Failed/g) || []).length === 2, logTxt);
  check('Meta\'s reason is printed', /not configured/i.test(logTxt), logTxt);
  const stillDue = await page.evaluate(() => document.getElementById('rm-due-list').textContent);
  check('a failed send leaves both sellers due — no accidental 45-day silence',
    /LAPSED ONE/.test(stillDue) && /LAPSED TWO/.test(stillDue), stillDue);

  try { await page.screenshot({ path: '/tmp/seller-reminders.png', fullPage: true }); console.log('  screenshot: /tmp/seller-reminders.png'); } catch (_) {}

  console.log('\n[E] the settings behind it');
  await page.evaluate(() => go('settings'));
  await new Promise(r => setTimeout(r, 1500));
  await page.evaluate(() => selectCat('reminders'));
  await new Promise(r => setTimeout(r, 1200));
  const keys = await page.evaluate(() => [...document.querySelectorAll('#settings-root [data-key]')].map(el => el.dataset.key));
  for (const k of ['reminder_after_days', 'reminder_until_days', 'reminder_min_auctions',
                   'reminder_cooldown_days', 'reminder_include_never_booked', 'reminder_auto_send',
                   'reminder_send_hour', 'reminder_max_per_day', 'reminder_tpl', 'reminder_message']) {
    check('the category renders ' + k, keys.indexOf(k) >= 0, keys.join(', '));
  }
  // Raising the min-auctions threshold must visibly shrink the list — that
  // round trip is the operator's only way to tune a campaign safely.
  await page.evaluate(() => {
    document.querySelector('[data-key="reminder_min_auctions"]').value = '5';
    saveSettings();
  });
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => go('reminders'));
  await page.waitForFunction(() => /Nobody is due a reminder/.test(document.getElementById('rm-due-list').textContent), { timeout: 15000 });
  check('raising min-auctions empties the list', true);
  check('...and the funnel explains where they went',
    /booked fewer than 5 auctions/.test(await page.evaluate(() => document.getElementById('rm-funnel').textContent.replace(/\s+/g, ' '))));

  check('no page errors anywhere in the run', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2000)); cleanup(); process.exit(1); });
