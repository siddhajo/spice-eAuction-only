// Settings → Integrations → WhatsApp Business → Compliance.
//
// Built 2026-11-04, the day Meta disabled this business's WhatsApp account
// for a breach of the Terms of Acceptable Use. The tab exists so that the
// two things that caused it are visible and fixable from inside the app:
// nobody had recorded an opt-in, and replies asking us to stop were logged
// and never read.
//
// WHAT THIS FILE PINS
//   [tab]        a fourth tab exists and switching to it paints the panel
//   [state]      warn mode and the install-wide pause are impossible to
//                miss — on the morning after Meta writes, that banner is
//                the only thing on screen that matters
//   [coverage]   "never asked" is shown as a number and not softened away
//   [backlog]    unread "stop" replies get a loud banner and one button
//   [review]     the ambiguous replies are LISTED with both answers, never
//                auto-applied — wrongly silencing a seller cuts them off
//                from their own invoices
//   [register]   the opt-out list shows the evidence each entry rests on
//   [form]       an opt-in cannot be recorded without saying where the
//                permission came from
//   [siblings]   the other three tabs still render (they share .wa-sub,
//                whose spacing this panel also uses)
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-policy-br-'));
const PORT = 47401;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// The state a real install is in on day one: thousands of contactable
// parties, nobody asked, and a backlog of replies nobody read.
const EXPOSED = {
  configured: true,
  health: 'green',
  policy: { mode: 'enforce', paused: false, marketingGapDays: 30, maxPerContactDay: 3,
    legacyOptIn: false, legacyBasis: '', stopMarketingOnYellow: true, stopAllOnRed: true, deadNumberFails: 3 },
  coverage: {
    contactable: 5240, sellersWithPhone: 4600, buyersWithPhone: 640,
    optedIn: 0, optedOut: 0, recorded: 0, unknown: 5240,
    blocks: [], unheardOptOuts: 7,
    needsReviewCount: 2,
    needsReview: [
      { phone: '919111111111', text: 'when does the auction end', at: '2026-10-02 11:04' },
      { phone: '919222222222', text: 'not interested', at: '2026-10-03 09:20' },
    ],
  },
  optedOut: [],
  recent: [],
};
// After the work has been done: consent recorded, backlog cleared, and the
// gate visibly doing its job.
const SETTLED = {
  configured: true,
  health: 'yellow',
  policy: { mode: 'enforce', paused: false, marketingGapDays: 30, maxPerContactDay: 3,
    legacyOptIn: false, legacyBasis: '', stopMarketingOnYellow: true, stopAllOnRed: true, deadNumberFails: 3 },
  coverage: {
    contactable: 5240, sellersWithPhone: 4600, buyersWithPhone: 640,
    optedIn: 1310, optedOut: 46, optedOutMarketingOnly: 11, recorded: 1356, unknown: 3884,
    blocks: [
      { code: 'no_optin', mode: 'enforce', cls: 'marketing', n: 412 },
      { code: 'opted_out', mode: 'enforce', cls: 'utility', n: 9 },
      { code: 'too_soon', mode: 'enforce', cls: 'marketing', n: 3 },
    ],
    unheardOptOuts: 0, needsReviewCount: 0, needsReview: [],
  },
  optedOut: [
    { phone: '919111111111', status: 'out', scope: 'all', source: 'reply', basis: 'Contact asked us to stop, in their own reply on WhatsApp',
      note: 'STOP', opted_out_at: '2026-10-02 11:05', updated_at: '2026-10-02 11:05' },
    { phone: '919333333333', status: 'out', scope: 'all', source: 'meta', basis: 'Meta refused the message because the contact has stopped messages from this business',
      note: '(#131050)', opted_out_at: '2026-10-09 15:40', updated_at: '2026-10-09 15:40' },
    // The narrower request: stop the greetings, keep sending the bills.
    { phone: '919555555555', status: 'out', scope: 'marketing', source: 'operator', basis: 'Asked at the counter — greetings only',
      note: '', opted_out_at: '2026-10-20 10:00', updated_at: '2026-10-20 10:00' },
  ],
  recent: [],
};
// Warn mode, and the emergency stop. Both have to shout.
const WARNING = JSON.parse(JSON.stringify(SETTLED));
WARNING.policy.mode = 'warn';
WARNING.coverage.blocks = [{ code: 'no_optin', mode: 'warn', cls: 'marketing', n: 203 }];
const PAUSED = JSON.parse(JSON.stringify(SETTLED));
PAUSED.policy.paused = true;

let TOKEN = '';
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
  const lr = await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const ld = await lr.json();
  TOKEN = ld && (ld.token || ld.accessToken);
  if (!TOKEN) { console.error('login failed', ld, '\n', log.slice(-2000)); cleanup(); process.exit(1); }

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
  await page.setRequestInterception(true);
  // The compliance payload is served here: this file is about how the panel
  // READS, not where the figures come from (wa-compliance.http.js covers
  // that against the real routes).
  let payload = EXPOSED;
  page.on('request', r => {
    if (r.url().includes('/api/whatsapp/compliance')) {
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (r.url().includes('/api/whatsapp/usage')) {
      return r.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ configured: false, monthLabel: 'November 2026',
          free: { source: 'local' }, limit: { used: 0 }, sent: { today: { total: 0 }, month: { total: 0 } },
          billing: { blocked: false, url: 'https://x/', insightsUrl: '', customUrl: '' },
          policy: { mode: 'enforce', paused: false } }) });
    }
    r.continue();
  });
  await page.setViewport({ width: 1500, height: 1200 });

  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));
  await page.evaluate(() => { go('settings'); });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => {
    _activeCat = 'integrations';
    if (typeof renderSettingsNav === 'function') renderSettingsNav();
    renderSettingsPanel();
  });
  await new Promise(r => setTimeout(r, 1200));

  // ── [tab] ───────────────────────────────────────────────────
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#settings-root [data-watab]')).map(b => b.dataset.watab));
  check('[tab] a Compliance tab sits beside the other three',
    tabs.includes('policy') && tabs.length === 4, JSON.stringify(tabs));

  const openPolicy = async (data) => {
    payload = data;
    await page.evaluate(() => { _waPolicyData = null; _waSetTab('policy'); });
    await new Promise(r => setTimeout(r, 900));
    return page.evaluate(() => {
      const host = document.getElementById('whatsapp-policy-host');
      const pane = document.querySelector('#settings-root [data-wapane="policy"]');
      return {
        visible: !!pane && !pane.hidden,
        text: host ? host.innerText : '',
        banners: Array.from(host ? host.querySelectorAll('.wa-banner') : [])
          .map(b => ({ cls: b.className, text: b.innerText.slice(0, 160) })),
        subs: Array.from(host ? host.querySelectorAll('.wa-sub') : []).map(e => e.innerText.trim()),
        tiles: Array.from(host ? host.querySelectorAll('.wa-tile') : [])
          .map(t => ({ k: (t.querySelector('.k') || {}).innerText || '', v: (t.querySelector('.v') || {}).innerText || '',
                       lead: t.classList.contains('lead') })),
        rows: Array.from(host ? host.querySelectorAll('.wa-tbl tbody tr') : []).map(tr => tr.innerText.replace(/\s+/g, ' ').trim()),
        buttons: Array.from(host ? host.querySelectorAll('button') : []).map(b => b.innerText.trim()),
      };
    });
  };

  // ── The exposed install ─────────────────────────────────────
  console.log('\n[an install that has never asked anybody]');
  let v = await openPolicy(EXPOSED);
  check('the pane is shown', v.visible);
  check('[coverage] "never asked" is given as a plain number, not softened away',
    /Never asked/i.test(v.text) && /5,240/.test(v.text), v.tiles.map(t => t.k + '=' + t.v).join(' | '));
  check('[coverage] opted-in leads the band, because that is the figure to grow',
    v.tiles.some(t => t.lead && /Opted in/i.test(t.k)), JSON.stringify(v.tiles));
  check('[coverage] the caption says invoices are not gated on an opt-in',
    /invoices|notices/i.test(v.text), v.text.slice(0, 400));

  // THE assertion of this file. These seven people asked to stop and were
  // still being messaged; that is what the account was disabled over.
  check('[backlog] unread "stop" replies get a RED banner naming the count',
    v.banners.some(b => /bad/.test(b.cls) && /7/.test(b.text) && /asked us to stop/i.test(b.text)),
    JSON.stringify(v.banners));
  check('[backlog] …and one button that applies them all',
    v.buttons.some(b => /Apply all 7/i.test(b)), JSON.stringify(v.buttons));

  check('[review] the ambiguous replies are listed, not applied',
    v.rows.some(r => /auction end/.test(r)) && v.rows.some(r => /not interested/.test(r)),
    JSON.stringify(v.rows));
  // Three answers, not two: stop everything, stop only the greetings (they
  // keep their invoices), or it was never an opt-out at all. A person picks.
  check('[review] …each with every answer, so a person decides',
    v.buttons.some(b => /Stop everything/i.test(b))
      && v.buttons.some(b => /Stop greetings only/i.test(b))
      && v.buttons.some(b => /Not an opt-out/i.test(b)),
    JSON.stringify(v.buttons));
  check('[review] …and the caption says why the app will not guess',
    /own invoices|ordinary auction/i.test(v.text), v.text.slice(0, 1200));

  // ── The settled install ─────────────────────────────────────
  console.log('\n[an install that has done the work]');
  v = await openPolicy(SETTLED);
  check('the backlog banner is gone once there is nothing to apply',
    !v.banners.some(b => /asked us to stop/i.test(b.text)), JSON.stringify(v.banners));
  check('[coverage] the opt-in share is shown against the contactable total',
    /25%/.test(v.text), v.tiles.map(t => t.k + '=' + t.v + '/' + 0).join(' | '));
  check('[register] an opt-out shows the evidence it rests on',
    v.rows.some(r => /own reply/i.test(r)), JSON.stringify(v.rows));
  check('[register] …and a Meta-reported opt-out says it came from Meta',
    v.rows.some(r => /stopped our messages/i.test(r)), JSON.stringify(v.rows));
  check('[register] removing somebody is possible but is not the default action',
    v.buttons.filter(b => /^Remove$/i.test(b)).length === 3, JSON.stringify(v.buttons));
  // The scope is the difference between "their invoice has to go another
  // way" and "they just miss a birthday wish", so the register names it.
  check('[scope] the register says what each opt-out actually stopped',
    v.rows.some(r => /Everything/.test(r)) && v.rows.some(r => /Greetings & reminders/.test(r)),
    JSON.stringify(v.rows));
  check('[scope] …and the coverage tile says their invoices still go out',
    /11 of them only asked us to stop/.test(v.text) && /invoices still go out/.test(v.text),
    v.text.slice(0, 900));
  check('[scope] recording one is offered beside the total opt-out',
    v.buttons.some(b => /Stop everything/i.test(b)) && v.buttons.some(b => /Stop greetings only/i.test(b)),
    JSON.stringify(v.buttons));
  check('what the rules refused is shown per rule, in words',
    v.rows.some(r => /No opt-in on record/i.test(r) && /412/.test(r)), JSON.stringify(v.rows));
  check('…and a yellow rating is stated on the status line',
    /YELLOW/i.test(v.text), v.text.slice(0, 200));

  // ── Warn mode and the pause ─────────────────────────────────
  console.log('\n[the two states that must shout]');
  v = await openPolicy(WARNING);
  check('[state] warn mode is called out as not a place to stay',
    v.banners.some(b => /warn/.test(b.cls) && /WARN ONLY/i.test(b.text)), JSON.stringify(v.banners));
  check('[state] …and the refusals it would have made are shown as sent anyway',
    v.rows.some(r => /warn mode/i.test(r)), JSON.stringify(v.rows));

  v = await openPolicy(PAUSED);
  check('[state] the pause gets a red banner saying nothing goes out',
    v.banners.some(b => /bad/.test(b.cls) && /PAUSED/.test(b.text) && /no invoice/i.test(b.text)),
    JSON.stringify(v.banners));

  // ── [form] ──────────────────────────────────────────────────
  console.log('\n[recording a decision]');
  v = await openPolicy(SETTLED);
  check('[form] there is a box for the number and for the evidence',
    /Record a decision/i.test(v.subs.join(' ')) && /where the permission/i.test(v.text),
    JSON.stringify(v.subs));
  // An opt-in with no basis is refused in the browser, before the request:
  // "we have consent" with nothing behind it is the claim that got this
  // account disabled.
  const noBasis = await page.evaluate(() => {
    document.getElementById('wa-cs-phone').value = '9876543210';
    document.getElementById('wa-cs-basis').value = '';
    _waConsentForm('in', null);
    return (document.getElementById('wa-cs-msg') || {}).innerText || '';
  });
  check('[form] an opt-in without a basis is refused, and says why',
    /where the permission came from/i.test(noBasis), noBasis);
  const noPhone = await page.evaluate(() => {
    document.getElementById('wa-cs-phone').value = '';
    document.getElementById('wa-cs-basis').value = 'signed the form';
    _waConsentForm('in', null);
    return (document.getElementById('wa-cs-msg') || {}).innerText || '';
  });
  check('[form] …and so is one without a number', /phone number/i.test(noPhone), noPhone);

  // ── [siblings] ──────────────────────────────────────────────
  console.log('\n[the other three tabs still work]');
  for (const t of ['overview', 'setup', 'log']) {
    // Switch, THEN wait, THEN read. The log pane is fetched on first open
    // (up to 500 rows), so reading it in the same evaluate() that switched
    // to it catches an empty host and reports a working tab as broken.
    await page.evaluate((id) => { _waSetTab(id); }, t);
    await new Promise(r => setTimeout(r, 900));
    const shown = await page.evaluate((id) => {
      const pane = document.querySelector(`#settings-root [data-wapane="${id}"]`);
      return !!pane && !pane.hidden && pane.innerText.trim().length > 0;
    }, t);
    check(`${t} still renders`, shown);
  }

  try {
    await page.evaluate(() => { _waPolicyData = null; _waSetTab('policy'); });
    await new Promise(r => setTimeout(r, 700));
    await page.screenshot({ path: '/tmp/wa-compliance.png', fullPage: true });
    console.log('  --   screenshot: /tmp/wa-compliance.png');
  } catch (_) {}

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.error('--- server log tail ---\n' + log.slice(-2000));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', log.slice(-2000)); cleanup(); process.exit(1); });
