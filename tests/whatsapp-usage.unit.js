// Unit test for the Settings → Integrations "Usage & billing" card in
// public/index.html (_renderWhatsappUsage).
//
// The card answers three questions and it is the WORDING as much as the
// numbers that has to be right:
//   1. "Free messages left" is the allowance minus what Meta says was free —
//      and the card must keep saying, out loud, that free ≠ invoices you can
//      still send (invoice/utility templates are billable).
//   2. "Recipients left (24h)" is the messaging-limit tier minus the unique
//      recipients this install messaged in the rolling 24h. This is the number
//      that actually stops a bulk run partway.
//   3. Recharge links at the Meta billing hub (or the configured override),
//      because Meta has no top-up API — nothing in-app can add funds.
// Plus: when Meta can't be read the tiles degrade to "—" and the REASON,
// never to an invented balance; and a billing block gets a banner.
//
// The function is lifted verbatim out of index.html so the test tracks the
// shipped source rather than a copy.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extract(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm');
  const m = re.exec(HTML);
  assert.ok(m, `could not find function ${name}() in public/index.html`);
  const start = m.index;
  const end = HTML.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of ${name}()`);
  return HTML.slice(start, end + 3);
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

// Minimal host element + the handful of globals the card reads.
const host = { innerHTML: '' };
const state = { usage: null, usageErr: null, lastUrl: '' };
const sandbox = {
  console, Date,
  B: '', T: 'test-token',
  document: { getElementById: (id) => (id === 'whatsapp-usage-host' ? host : null) },
  esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])),
  j: async (url) => { state.lastUrl = url; if (state.usageErr) throw new Error(state.usageErr); return state.usage; },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(extract('_renderWhatsappUsage'), sandbox);

const USAGE = {
  configured: true, monthLabel: 'September 2026', displayPhone: '+91 95260 09651', qualityRating: 'GREEN',
  sent: { today: { total: 104, delivered: 90, read: 12, failed: 2 },
          month: { total: 601, delivered: 540, read: 80, failed: 9 }, total: 4210 },
  limit: { tier: 'TIER_250', cap: 250, used: 180, remaining: 70, source: 'meta', error: '', unlimited: false },
  free: { allowance: 1000, used: 1, remaining: 999, paid: 601, cost: 69.1, source: 'meta', error: '' },
  billing: { blocked: false, blockError: '', blockAt: '', url: 'https://business.facebook.com/billing_hub/payment_settings',
             customUrl: '', insightsUrl: 'https://business.facebook.com/wa/manage/insights/?waba_id=158' },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const render = async (usage, err) => {
  state.usage = usage; state.usageErr = err || null; host.innerHTML = '';
  await sandbox._renderWhatsappUsage();
  return host.innerHTML;
};

(async () => {
  console.log('WhatsApp usage & billing card');

  // [A] The three headline numbers, each next to what it is out of.
  const h = await render(clone(USAGE));
  check('free tile shows allowance headroom', /Free messages left/.test(h) && /999/.test(h) && /1 of 1,000 used/.test(h), h.slice(0, 400));
  check('billable tile shows the month\'s count and spend',
    /Billable this month/.test(h) && /601/.test(h) && /69\.1/.test(h), 'missing billable tile');
  check('billable tile shows the per-message rate for sizing a run', /~0\.115 each/.test(h), 'no per-message rate');
  check('24h tile shows the tier headroom', /Recipients left \(24h\)/.test(h) && /180 of 250 used/.test(h) && /TIER_250/.test(h), 'missing limit tile');
  check('local send log fills today + this month', /Sent today/.test(h) && /104/.test(h) && /Sent this month/.test(h) && /601/.test(h), 'missing sent tiles');

  // [B] The caveat that stops "999 free left" being read as "999 invoices".
  check('card says free ≠ invoices you can still send',
    /Free ≠ how many invoices you can still send/.test(h) && /billable/.test(h), 'caveat missing');
  check('card names the 24h limit as the real ceiling', /250 unique recipients per rolling 24 hours/.test(h), 'ceiling not spelled out');

  // [C] Recharge — the only honest answer is a deep link, and the card says so.
  check('recharge opens the Meta billing hub in a new tab',
    h.includes('href="https://business.facebook.com/billing_hub/payment_settings"') && /target="_blank"/.test(h), 'billing link missing');
  check('card states Meta has no in-app top-up', /no way to add funds from inside another app/.test(h), 'top-up caveat missing');
  const custom = clone(USAGE); custom.billing.url = 'https://pay.example.com/topup'; custom.billing.customUrl = 'https://pay.example.com/topup';
  const hc = await render(custom);
  check('a configured override replaces the Meta link',
    hc.includes('href="https://pay.example.com/topup"') && !hc.includes('billing_hub'), 'override not used');
  check('the override round-trips into its input box', hc.includes('value="https://pay.example.com/topup"'), 'override input empty');

  // [D] Meta unreadable → "—" and the reason. Never an invented balance.
  const blind = clone(USAGE);
  blind.free = { allowance: 1000, used: null, remaining: null, paid: null, cost: null, source: 'unavailable', error: 'Session has expired' };
  blind.limit = { tier: '', cap: 0, used: 43, remaining: null, source: 'unavailable', error: 'Session has expired', unlimited: false };
  const hb = await render(blind);
  check('unreadable free tier shows the reason, not a number',
    /Free messages left/.test(hb) && /Session has expired/.test(hb) && !/999/.test(hb), 'invented a balance');
  check('unknown tier still reports the local 24h recipient count',
    /43 unique recipients in the last 24h/.test(hb), 'lost the local fallback');

  // [E] A billing block is the one thing that must interrupt the operator.
  const blocked = clone(USAGE);
  blocked.billing.blocked = true; blocked.billing.blockError = 'Business eligibility payment issue'; blocked.billing.blockAt = '2026-09-17 10:12:00';
  const hbk = await render(blocked);
  check('billing block raises a banner quoting Meta',
    /Sends are being refused for a billing reason/.test(hbk) && /Business eligibility payment issue/.test(hbk), 'no block banner');

  // [F] Unlimited tier — no cap to subtract from, so don't fake one.
  const unl = clone(USAGE);
  unl.limit = { tier: 'UNLIMITED', cap: 0, used: 900, remaining: null, source: 'meta', error: '', unlimited: true };
  const hu = await render(unl);
  check('an unlimited tier reads "Unlimited", not a bogus remainder',
    /Unlimited/.test(hu) && /900 unique recipients in the last 24h/.test(hu), 'unlimited mishandled');

  // [G] Refresh must bypass the server's 60s Meta cache.
  await render(clone(USAGE));
  check('plain render uses the cached endpoint', state.lastUrl === '/api/whatsapp/usage', state.lastUrl);
  await sandbox._renderWhatsappUsage(true);
  check('Refresh asks for fresh Meta figures', state.lastUrl === '/api/whatsapp/usage?fresh=1', state.lastUrl);

  // [H] A dead endpoint must not leave the panel on "Loading…" forever.
  const he = await render(null, 'HTTP 500');
  check('load failure renders the error, not a spinner', /Could not load WhatsApp usage: HTTP 500/.test(he), he.slice(0, 200));

  // [I] The server's free/paid split, run against a REAL Meta response
  //     captured from the live RNS account. Graph nests analytics data points
  //     differently per edge and per version, so the parser walks the response
  //     instead of betting on one shape — this pins that it still finds them,
  //     and that FREE_CUSTOMER_SERVICE is counted as free while REGULAR is not.
  const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const srvBox = { console, fetch: null, process: { env: {} }, encodeURIComponent, Number, String, Math, Object, Array,
    AbortController, setTimeout, clearTimeout };
  srvBox.window = srvBox;
  vm.createContext(srvBox);
  for (const fn of ['_waDataPoints', '_waGraphGet', '_waPricingThisMonth']) {
    const m = new RegExp(`^(?:async )?function ${fn}\\s*\\(`, 'm').exec(SERVER);
    assert.ok(m, `could not find ${fn}() in server.js`);
    const end = SERVER.indexOf('\n}\n', m.index);
    vm.runInContext(SERVER.slice(m.index, end + 3), srvBox);
  }
  vm.runInContext("const WA_ANALYTICS_GRAPH = 'v23.0';", srvBox);
  // Verbatim from graph.facebook.com/v23.0/<waba>?fields=pricing_analytics…
  const META_BODY = { id: '1580412210089993', pricing_analytics: { data: [{ data_points: [
    { start: 1788546600, end: 1788633000, pricing_type: 'REGULAR', pricing_category: 'UTILITY', volume: 104, cost: 11.96 },
    { start: 1788460200, end: 1788546600, pricing_type: 'REGULAR', pricing_category: 'UTILITY', volume: 2, cost: 0.23 },
    { start: 1788978600, end: 1789065000, pricing_type: 'FREE_CUSTOMER_SERVICE', pricing_category: 'UTILITY', volume: 1, cost: 0 },
    { start: 1788978600, end: 1789065000, pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 20, cost: 2.3 },
  ] }] } };
  srvBox.fetch = async () => ({ ok: true, json: async () => META_BODY });
  const priced = await srvBox._waPricingThisMonth({ token: 't', wabaId: '158' }, 1, 2);
  check('real Meta payload parses into a free/paid split',
    priced.source === 'meta' && priced.free === 1 && priced.paid === 126,
    JSON.stringify(priced));
  check('only billable rows accumulate spend', Math.abs(priced.cost - 14.49) < 0.001, String(priced.cost));
  check('spend is broken down per pricing category',
    priced.byCategory.utility.paid === 106 && priced.byCategory.marketing.paid === 20,
    JSON.stringify(priced.byCategory));
  srvBox.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Session has expired' } }) });
  const failed = await srvBox._waPricingThisMonth({ token: 't', wabaId: '158' }, 1, 2);
  check('a Meta error degrades to unavailable + the reason',
    failed.source === 'unavailable' && failed.error === 'Session has expired', JSON.stringify(failed));
  const noWaba = await srvBox._waPricingThisMonth({ token: 't', wabaId: '' }, 1, 2);
  check('a missing WABA id says what to fill in, not "0 free"',
    noWaba.source === 'unavailable' && /Business Account ID/.test(noWaba.error), JSON.stringify(noWaba));

  // [J] The Integrations panel used to give WhatsApp THREE sibling sections —
  //     setup, usage, send log — each drawing its own bordered card inside the
  //     section's own header. One tabbed section replaced them, so this pins
  //     the tab contract: three tabs, one visible pane, and the send log (a
  //     fetch of up to 500 rows most visits never open) loaded only on demand.
  const tabBox = { console };
  let logRenders = 0;
  const tabEls = ['overview', 'setup', 'log'].map(id => ({ dataset: { watab: id }, on: false,
    classList: { toggle(c, v) { tabEls.find(t => t.dataset.watab === id).on = v; } } }));
  const paneEls = ['overview', 'setup', 'log'].map(id => ({ dataset: { wapane: id }, hidden: false }));
  tabBox.document = { querySelectorAll: (sel) => (sel.includes('data-watab') ? tabEls : paneEls) };
  tabBox._renderWhatsappLog = () => { logRenders++; };
  vm.createContext(tabBox);
  for (const m of [/^let _waTab = .*$/m, /^let _waLogHydrated = .*$/m]) {
    const hit = m.exec(HTML);
    assert.ok(hit, 'could not find the tab state declarations in index.html');
    vm.runInContext(hit[0], tabBox);
  }
  vm.runInContext(extract('_waPanesHtml'), tabBox);
  vm.runInContext(extract('_waSetTab'), tabBox);

  const panes = tabBox._waPanesHtml();
  check('one section now carries all three WhatsApp tabs',
    (panes.match(/class="wa-tab["\s]/g) || []).length === 3 &&
    /whatsapp-usage-host/.test(panes) && /whatsapp-config-host/.test(panes) && /whatsapp-log-host/.test(panes),
    panes.slice(0, 300));
  check('only the active pane is visible',
    /data-wapane="overview"><div id="whatsapp-usage-host"/.test(panes) &&
    /data-wapane="setup" hidden/.test(panes) && /data-wapane="log" hidden/.test(panes),
    panes);
  check('the active tab is the only one marked on',
    (panes.match(/class="wa-tab on"/g) || []).length === 1, panes.slice(0, 200));

  tabBox._waSetTab('log');
  check('switching tabs swaps which pane is hidden',
    paneEls.find(p => p.dataset.wapane === 'log').hidden === false &&
    paneEls.find(p => p.dataset.wapane === 'overview').hidden === true,
    JSON.stringify(paneEls.map(p => [p.dataset.wapane, p.hidden])));
  check('the send log loads the first time its tab is opened', logRenders === 1, String(logRenders));
  tabBox._waSetTab('overview');
  tabBox._waSetTab('log');
  check('reopening the tab reuses what was already fetched', logRenders === 1, String(logRenders));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
