// SELLER REMINDERS — the HTTP surface.
//
// Covers what the engine test cannot: the feature gate, the permission
// gates, the shape the screen reads (including the funnel counts, which
// are the point of the screen), and the guard that stops a stale tab
// messaging a seller who has since booked.
//
// No Meta account here, so every real send fails — which is itself pinned:
// an unconfigured WhatsApp must produce a reported failure per row, never
// a 500, and must not start anybody's cooldown.
//
//   node tests/seller-reminders.http.js
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reminders-http-'));
const PORT = 47396;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body, noAuth) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      (TOKEN && !noAuth) ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const setFlags = (settings) => api('PUT', '/api/company-settings', { settings });

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const done = c => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(c);
};

const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const daysAhead = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  console.log('Seller reminders — HTTP');

  // [A] OFF is the shipped state, and off must be inert everywhere.
  const offGet = await api('GET', '/api/seller-reminders');
  check('flag OFF → 403 on the worklist', offGet.status === 403, JSON.stringify(offGet));
  check('the 403 names the flag and where to find it',
    /Seller Booking Reminders.*Settings/.test((offGet.d && offGet.d.error) || ''), JSON.stringify(offGet.d));
  check('flag OFF → 403 on send',
    (await api('POST', '/api/seller-reminders/send', { trader_ids: [1] })).status === 403);
  check('flag OFF → 403 on run-sweep',
    (await api('POST', '/api/seller-reminders/run-sweep', {})).status === 403);
  check('unauthenticated → 401', (await api('GET', '/api/seller-reminders', null, true)).status === 401);

  await setFlags({ flag_seller_reminders: 'true', trade_name: 'RNS SPICES' });

  // [B] The fixture: auctions on a ~10-day cadence, plus one in the future.
  const AUCTIONS = [daysAgo(160), daysAgo(120), daysAgo(80), daysAgo(40), daysAgo(2), daysAhead(8)];
  for (let i = 0; i < AUCTIONS.length; i++) {
    await api('POST', '/api/auctions', { ano: String(i + 1), date: AUCTIONS[i] });
  }
  const auctions = (await api('GET', '/api/auctions')).d;
  const list = Array.isArray(auctions) ? auctions : (auctions.rows || auctions.auctions || []);
  const aid = (date) => (list.find(a => a.date === date) || {}).id;
  check('the auction fixture loaded', list.length >= 6, JSON.stringify(list.map(a => a.date)));

  let lotNo = 0;
  const mkSeller = async (name, tel) => {
    const r = await api('POST', '/api/traders', { name, cr: 'CR.' + name.slice(0, 3), tel: tel === undefined ? '9800000001' : tel });
    return r.d && r.d.trader && r.d.trader.id;
  };
  const book = async (tid, date, reserved) => {
    await api('POST', '/api/lots', { auction_id: aid(date), lot_no: 'L' + (++lotNo), trader_id: tid, qty: 100, reserved: reserved ? 1 : 0 });
  };

  const LAPSED    = await mkSeller('LAPSED REGULAR');
  await book(LAPSED, AUCTIONS[0]); await book(LAPSED, AUCTIONS[1]);
  const ONETIMER  = await mkSeller('ONE TIMER');
  await book(ONETIMER, AUCTIONS[0]);
  const ACTIVE    = await mkSeller('STILL ACTIVE');
  await book(ACTIVE, AUCTIONS[0]); await book(ACTIVE, AUCTIONS[4]);
  const PREBOOKED = await mkSeller('ALREADY COMING');
  await book(PREBOOKED, AUCTIONS[0]); await book(PREBOOKED, AUCTIONS[1]); await book(PREBOOKED, AUCTIONS[5]);
  const NOPHONE   = await mkSeller('NO PHONE SELLER', '');
  await book(NOPHONE, AUCTIONS[0]); await book(NOPHONE, AUCTIONS[1]);
  const NEVER     = await mkSeller('NEVER BOOKED');

  let g = await api('GET', '/api/seller-reminders');
  check('flag ON → 200', g.status === 200, JSON.stringify(g.d && g.d.error));
  const dueIds = (g.d.due || []).map(x => x.trader_id);
  check('the lapsed regular is due', dueIds.includes(LAPSED), JSON.stringify((g.d.due || []).map(x => x.label)));
  check('the one-time seller is filtered out', !dueIds.includes(ONETIMER));
  check('the active seller is not due', !dueIds.includes(ACTIVE));
  check('a seller already booked into a COMING auction is never due', !dueIds.includes(PREBOOKED));
  check('the never-booked seller is excluded by default', !dueIds.includes(NEVER));
  check('the no-phone seller is HELD with a reason, not dropped',
    (g.d.held || []).some(x => x.trader_id === NOPHONE && /no phone/.test(x.hold || '')),
    JSON.stringify((g.d.held || []).map(x => x.label + ':' + x.hold)));

  // [C] The funnel. Without these the screen cannot answer "why is the
  //     list so short?" / "why is it so long?", which is the whole reason
  //     the thresholds are configurable.
  const c = g.d.counts || {};
  check('the funnel counts the whole master', c.sellers_total >= 6, JSON.stringify(c));
  check('...how many ever booked', c.ever_booked === 5, JSON.stringify(c));
  check('...how many never have', c.never_booked === 1, JSON.stringify(c));
  check('...how many fell in the day window', c.in_window >= 3, JSON.stringify(c));
  check('...how many were dropped for booking too few auctions', c.below_min_auctions === 1, JSON.stringify(c));
  check('...how many booked more recently', c.too_recent >= 2, JSON.stringify(c));
  check('...and how many have no number', c.no_phone === 1, JSON.stringify(c));
  check('the thresholds come back so the screen can name them',
    g.d.config.afterDays === 60 && g.d.config.untilDays === 180 && g.d.config.minAuctions === 2
    && g.d.config.cooldownDays === 45, JSON.stringify(g.d.config));
  check('the screen is told whether WhatsApp is configured', g.d.whatsapp.configured === false);
  check('the next auction is returned for the preview',
    g.d.nextAuction && g.d.nextAuction.date === AUCTIONS[5], JSON.stringify(g.d.nextAuction));
  check('each due row previews the message that would go out',
    (g.d.due || []).every(x => typeof x.message === 'string' && x.message.length > 0));
  check('the preview carries the next auction date',
    /\d{2}\/\d{2}\/\d{4}/.test((g.d.due[0] || {}).message || ''), (g.d.due[0] || {}).message);
  check('rows carry the booking history the operator judges on',
    (g.d.due || []).every(x => Number.isInteger(x.auctions_booked) && Number.isInteger(x.lots_booked)));

  // [D] Thresholds move the list through the API, not just in the engine.
  await setFlags({ reminder_min_auctions: '1' });
  check('min-auctions 1 admits the one-time seller',
    ((await api('GET', '/api/seller-reminders')).d.due || []).some(x => x.trader_id === ONETIMER));
  await setFlags({ reminder_min_auctions: '2' });
  await setFlags({ reminder_include_never_booked: 'true' });
  const withNever = await api('GET', '/api/seller-reminders');
  check('never-booked can be opted in', (withNever.d.due || []).some(x => x.trader_id === NEVER));
  check('...and carries a null days-away rather than a fake one',
    (withNever.d.due.find(x => x.trader_id === NEVER) || {}).days_since === null);
  await setFlags({ reminder_include_never_booked: 'false' });

  // [E] Sending. WhatsApp is unconfigured, so every attempt must fail
  //     visibly — and must NOT start a cooldown, or one broken run would
  //     silence the whole list for 45 days.
  const send = await api('POST', '/api/seller-reminders/send', { trader_ids: [LAPSED] });
  check('send returns 200 with a per-row verdict, not a 500', send.status === 200, JSON.stringify(send));
  check('the row failed', send.d.failed === 1 && send.d.sent === 0, JSON.stringify(send.d));
  check('and says WhatsApp is not configured',
    /not configured/i.test(((send.d.results || [])[0] || {}).error || ''), JSON.stringify(send.d.results));
  const after = await api('GET', '/api/seller-reminders');
  check('the failed attempt is in the ledger', (after.d.log || []).some(x => x.status === 'failed'));
  check('the ledger records who tried', ((after.d.log || [])[0] || {}).sent_by === 'admin');
  check('a FAILED send does NOT start the cooldown',
    (after.d.due || []).some(x => x.trader_id === LAPSED), 'one broken run must not silence the list');

  // [F] The stale-screen guards.
  const notDue = await api('POST', '/api/seller-reminders/send', { trader_ids: [ACTIVE] });
  check('a seller who is not due is refused', notDue.status === 400, JSON.stringify(notDue.d));
  check('the refusal tells the operator to reload', /reload/i.test((notDue.d && notDue.d.error) || ''));
  check('an empty selection is a 400',
    (await api('POST', '/api/seller-reminders/send', { trader_ids: [] })).status === 400);
  check('an unknown id is a 400, not a crash',
    (await api('POST', '/api/seller-reminders/send', { trader_ids: [99999] })).status === 400);
  const mixed = await api('POST', '/api/seller-reminders/send', { trader_ids: [LAPSED, 99999] });
  check('a mixed selection still processes the valid rows',
    mixed.status === 200 && mixed.d.results.length === 1, JSON.stringify(mixed.d));
  check('and names the ones it could not place', (mixed.d.unknown || []).length === 1, JSON.stringify(mixed.d.unknown));
  // The seller who is already coming to the next auction is the one this
  // guard exists for.
  check('a seller booked into the coming auction cannot be messaged by id',
    (await api('POST', '/api/seller-reminders/send', { trader_ids: [PREBOOKED] })).status === 400);

  // [G] The sweep.
  const sweep = await api('POST', '/api/seller-reminders/run-sweep', {});
  check('run-sweep says why it did nothing', sweep.status === 200 && /auto-send off/.test(sweep.d.reason || ''),
    JSON.stringify(sweep.d));
  await setFlags({ reminder_auto_send: 'true', reminder_send_hour: '0', reminder_max_per_day: '1' });
  const sweep2 = await api('POST', '/api/seller-reminders/run-sweep', {});
  check('with auto-send on the sweep runs', sweep2.d.ran === true, JSON.stringify(sweep2.d));
  check('it honours the daily cap', sweep2.d.failed + sweep2.d.sent <= 1, JSON.stringify(sweep2.d));
  check('and reports the backlog it did not reach', typeof sweep2.d.remaining === 'number', JSON.stringify(sweep2.d));
  const auto = await api('GET', '/api/seller-reminders');
  check('sweep attempts are tagged auto in the ledger', (auto.d.log || []).some(x => x.mode === 'auto'));
  check('an unattended sweep records no operator',
    ((auto.d.log || []).find(x => x.mode === 'auto') || {}).sent_by === '');

  // [H] The two campaigns must stay independent — one flag must not gate
  //     the other, and one ledger must not feed the other's screen.
  const bd = await api('GET', '/api/birthdays');
  check('the birthday feature is still independently OFF', bd.status === 403, JSON.stringify(bd.d));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); done(1); });
