// Settings → Integrations → WhatsApp Business → Overview.
//
// The tab used to be one strip of five equal tiles. That packed two
// different questions into one row and made the numbers hard to read:
//
//   • "Free messages left" was the biggest number on screen, and a whole
//     paragraph underneath had to explain that it is NOT how many invoices
//     you can still send. A label that needs a paragraph is the wrong label.
//   • "Billable this month: 2,143" had a message COUNT as its value and the
//     money, the per-message rate and a currency caveat crammed into its
//     subtitle — three numbers in three units under one ambiguous heading.
//   • "Recipients left (24h)" — the one ceiling that actually stops a bulk
//     run partway — sat third of five at the same size as everything else.
//
// It is now two labelled bands: what can still go out (ceilings, from Meta)
// and what has gone out / cost (history, mostly from this app's own log),
// with the 24h recipient limit leading.
//
//   [bands]      two headings, and the tiles land under the right one
//   [lead]       the 24h ceiling leads, and is visibly bigger than its
//                neighbour — the whole point of the regrouping
//   [units]      cost and count are separate tiles, each reading in its own
//                unit without needing its subtitle
//   [bare]       an unconfigured install is told what to do, and the lead
//                emphasis is NOT spent on an em dash
//   [tabs]       Setup and Send log still render (they share .wa-sub, whose
//                margin this change moved)
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-layout-'));
const PORT = 47397;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// Meta answers everything — the state where every tile renders its rich form.
const LIVE = {
  configured: true, displayPhone: '+91 90477 44444', qualityRating: 'GREEN', monthLabel: 'September 2026',
  free:  { source: 'meta', allowance: 1000, used: 812, remaining: 188, paid: 2143, cost: 6873.41, currency: 'INR' },
  limit: { source: 'meta', cap: 250, used: 187, remaining: 63, tier: 'TIER_250' },
  sent:  { today: { total: 143, delivered: 139, failed: 4 }, month: { total: 2955, delivered: 2901, failed: 54 } },
  billing: { blocked: false, url: 'https://business.facebook.com/billing_hub', insightsUrl: 'https://x/', customUrl: '' },
};
// The state most installs are actually in.
const BARE = {
  configured: false, monthLabel: 'September 2026',
  free:  { source: 'local', error: 'no WhatsApp Business Account ID configured' },
  limit: { used: 0 },
  sent:  { today: { total: 0 }, month: { total: 0 } },
  billing: { blocked: false, url: 'https://business.facebook.com/billing_hub', insightsUrl: '', customUrl: '' },
};

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
  // Meta is never reachable from a test box, so the usage payload is served
  // here — this file is about how the figures are LAID OUT, not where they
  // come from (whatsapp-usage.http.js covers that).
  let payload = LIVE;
  page.on('request', r => {
    if (r.url().includes('/api/whatsapp/usage')) {
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    r.continue();
  });
  await page.setViewport({ width: 1500, height: 1100 });

  async function openIntegrations() {
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
    await new Promise(r => setTimeout(r, 1500));
  }

  const overview = (fn) => page.evaluate(fn);

  console.log('[bands] two labelled bands, not one strip of five');
  await openIntegrations();
  const heads = await overview(() =>
    [...document.querySelectorAll('[data-wapane="overview"] .wa-sub')].map(e => e.textContent.trim()));
  check('there are exactly two band headings', heads.length === 2, JSON.stringify(heads));
  check('…the first is about sending', /before you send/i.test(heads[0] || ''), JSON.stringify(heads));
  check('…the second about what went out', /sent|charged/i.test(heads[1] || ''), JSON.stringify(heads));

  const groups = await overview(() => {
    const pane = document.querySelector('[data-wapane="overview"]');
    const labels = (sel) => [...pane.querySelectorAll(sel + ' .wa-tile .k')].map(e => e.textContent.trim());
    return { gate: labels('.wa-gate'), rest: labels('.wa-tiles') };
  });
  check('the ceiling band holds exactly the two ceilings', groups.gate.length === 2, JSON.stringify(groups));
  check('…the 24h recipient limit first', /recipients left/i.test(groups.gate[0] || ''), JSON.stringify(groups));
  check('…the free allowance second',      /free/i.test(groups.gate[1] || ''),           JSON.stringify(groups));
  check('the history band holds the other four', groups.rest.length === 4, JSON.stringify(groups));

  console.log('[lead] the ceiling that stops a bulk run actually leads');
  const lead = await overview(() => {
    const pane = document.querySelector('[data-wapane="overview"]');
    const tiles = [...pane.querySelectorAll('.wa-gate .wa-tile')];
    const px = (el) => parseFloat(getComputedStyle(el.querySelector('.v')).fontSize);
    return {
      isLead: tiles[0].classList.contains('lead'),
      leadSize: px(tiles[0]), otherSize: px(tiles[1]),
      leadWidth: Math.round(tiles[0].getBoundingClientRect().width),
      restSize: px(pane.querySelector('.wa-tiles .wa-tile')),
    };
  });
  check('it carries the lead treatment', lead.isLead, JSON.stringify(lead));
  check('…and its number is visibly bigger than its neighbour',
        lead.leadSize > lead.otherSize, JSON.stringify(lead));
  check('…and bigger than the history tiles too',
        lead.leadSize > lead.restSize, JSON.stringify(lead));

  console.log('[units] cost and count are separate tiles, each in its own unit');
  const money = await overview(() => {
    const pane = document.querySelector('[data-wapane="overview"]');
    const byLabel = {};
    pane.querySelectorAll('.wa-tile').forEach(t => {
      byLabel[t.querySelector('.k').textContent.trim().toLowerCase()] = {
        v: t.querySelector('.v').textContent.trim(),
        s: t.querySelector('.s').textContent.trim(),
      };
    });
    return byLabel;
  });
  const charged = money['charged this month'] || {};
  const billable = money['billable messages'] || {};
  check('there is a tile whose value is the MONEY', /6,873\.41/.test(charged.v || ''), JSON.stringify(charged));
  check('…and it carries the currency symbol, not a bare number',
        /₹/.test(charged.v || ''), JSON.stringify(charged));
  check('…and a separate one whose value is the COUNT', /^2,143/.test(billable.v || ''), JSON.stringify(billable));
  check('the money tile names the currency in its subtitle', /INR/.test(charged.s || ''), JSON.stringify(charged));
  check('the count tile carries its period as a unit, not in the label',
        /this month/i.test(billable.v || ''), JSON.stringify(billable));
  // The old single tile crammed the charge, the rate AND the count together.
  // Each value must now carry ONE figure — checked per tile, not on the two
  // concatenated (which would of course contain both).
  const bothIn = (v) => /6,873/.test(v || '') && /2,143/.test(v || '');
  check('neither value carries both the money and the count',
        !bothIn(charged.v) && !bothIn(billable.v), JSON.stringify({ charged, billable }));
  check('…and the money never appears in the count tile at all',
        !/6,873/.test(billable.v + billable.s), JSON.stringify(billable));

  console.log('[bare] an unconfigured install is told what to do');
  payload = BARE;
  await openIntegrations();
  const bare = await overview(() => {
    const pane = document.querySelector('[data-wapane="overview"]');
    const warn = pane.querySelector('.wa-banner.warn');
    return {
      warn: warn ? warn.textContent.replace(/\s+/g, ' ').trim() : '',
      hasSetupBtn: !!(warn && warn.querySelector('button')),
      leadTinted: pane.querySelector('.wa-gate .wa-tile').classList.contains('lead'),
      firstValue: pane.querySelector('.wa-gate .wa-tile .v').textContent.trim(),
    };
  });
  check('a banner says it is not set up', /isn.t set up/i.test(bare.warn), bare.warn);
  check('…and offers the Setup tab as the next step', bare.hasSetupBtn && /Setup/.test(bare.warn), bare.warn);
  check('the lead tile shows no figure', bare.firstValue === '—', JSON.stringify(bare));
  check('…so the emphasis is NOT spent on it', bare.leadTinted === false, JSON.stringify(bare));

  console.log('[tabs] the sibling tabs still render');
  // Setup and Send log share .wa-sub, whose margin this change moved — a
  // broken selector there would show up as collapsed or missing headings.
  const setup = await page.evaluate(async () => {
    _waSetTab('setup');
    await new Promise(r => setTimeout(r, 600));
    const pane = document.querySelector('[data-wapane="setup"]');
    const subs = [...pane.querySelectorAll('.wa-sub')];
    return {
      count: subs.length,
      allSpaced: subs.every((e, i) => i === 0 || parseFloat(getComputedStyle(e).marginTop) >= 10),
      fields: pane.querySelectorAll('.wa-in').length,
    };
  });
  check('Setup still shows its three sub-headings', setup.count === 3, JSON.stringify(setup));
  check('…each separated from the block above it', setup.allSpaced, JSON.stringify(setup));
  check('…and its credential fields are there', setup.fields > 4, JSON.stringify(setup));

  const logTab = await page.evaluate(async () => {
    _waSetTab('log');
    await new Promise(r => setTimeout(r, 1200));
    const pane = document.querySelector('[data-wapane="log"]');
    return { html: pane.innerHTML.length, hidden: pane.hidden };
  });
  check('Send log opens and renders something', !logTab.hidden && logTab.html > 50, JSON.stringify(logTab));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', log.slice(-2000)); cleanup(); process.exit(1); });
