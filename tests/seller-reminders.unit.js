// SELLER REMINDERS — who is due, who is held back, and the cooldown.
//
// Runs the real engine against a REAL database with a FAKE sender, so the
// SQL is the thing under test (the dormancy roll-up is the whole feature)
// and no Meta account is involved.
//
// The properties that matter, in the order they can hurt:
//   • a seller already booked into a COMING auction is never reminded —
//     the most embarrassing possible failure of this feature;
//   • a RESERVED lot is a held placeholder, not a booking, so it must not
//     make a dormant seller look active;
//   • the cooldown is a window keyed on SENT rows only — a failed attempt
//     must not buy a seller weeks of silence;
//   • the min-auctions filter, which on the live master is the difference
//     between 834 recipients and 203.
//
//   node tests/seller-reminders.unit.js
const os = require('os'), path = require('path'), fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reminders-'));
process.env.SPICE_DATA_DIR = TMP;   // MUST precede require('../db')

const { initDb } = require('../db');
const { initCompanySettings, updateSettings } = require('../company-config');
const r = require('../seller-reminders');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const done = (c) => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(c); };

function sender(outcome) {
  const calls = [];
  const fn = async (msg) => { calls.push(msg); return typeof outcome === 'function' ? outcome(msg, calls.length) : outcome; };
  fn.calls = calls;
  return fn;
}

(async () => {
  const db = await initDb();
  initCompanySettings(db);

  const TODAY = '2026-09-30';
  // Auctions roughly every 10 days, like the live install.
  const AUCTIONS = ['2026-04-22', '2026-06-03', '2026-07-21', '2026-08-29', '2026-09-28', '2026-10-08'];
  AUCTIONS.forEach((d, i) => db.run('INSERT INTO auctions (ano, date) VALUES (?,?)', [String(i + 1), d]));
  const aid = (date) => db.get('SELECT id FROM auctions WHERE date = ?', [date]).id;

  let lotNo = 0;
  const seller = (name, opts = {}) => {
    db.run('INSERT INTO traders (name, cr, tel, whatsapp) VALUES (?,?,?,?)',
      [name, opts.cr || '', opts.tel === undefined ? '9800000000' : opts.tel, opts.whatsapp || '']);
    return db.get('SELECT id FROM traders WHERE name = ? ORDER BY id DESC LIMIT 1', [name]).id;
  };
  const book = (tid, date, opts = {}) => {
    db.run('INSERT INTO lots (auction_id, lot_no, trader_id, qty, reserved) VALUES (?,?,?,?,?)',
      [aid(date), 'L' + (++lotNo), tid, opts.qty || 100, opts.reserved ? 1 : 0]);
  };

  // ── the fixture, one seller per rule ────────────────────────────
  const LAPSED    = seller('LAPSED REGULAR', { cr: 'CR.1' });     // 2 auctions, last 161d ago
  book(LAPSED, '2026-04-22'); book(LAPSED, '2026-06-03');
  const ONETIMER  = seller('ONE TIMER', { cr: 'CR.2' });          // 1 auction, last 161d ago
  book(ONETIMER, '2026-04-22');
  const ACTIVE    = seller('STILL ACTIVE', { cr: 'CR.3' });       // booked 2 days ago
  book(ACTIVE, '2026-04-22'); book(ACTIVE, '2026-09-28');
  const PREBOOKED = seller('ALREADY COMING', { cr: 'CR.4' });     // dormant BUT booked into 8 Oct
  book(PREBOOKED, '2026-04-22'); book(PREBOOKED, '2026-06-03'); book(PREBOOKED, '2026-10-08');
  const HELDONLY  = seller('RESERVED ONLY', { cr: 'CR.5' });      // one RESERVED lot recently
  book(HELDONLY, '2026-04-22'); book(HELDONLY, '2026-06-03'); book(HELDONLY, '2026-09-28', { reserved: true });
  const NOPHONE   = seller('NO PHONE', { cr: 'CR.6', tel: '' });
  book(NOPHONE, '2026-04-22'); book(NOPHONE, '2026-06-03');
  const NEVER     = seller('NEVER BOOKED', { cr: 'CR.7' });

  updateSettings(db, {
    flag_seller_reminders: 'true', trade_name: 'RNS SPICES',
    reminder_after_days: '60', reminder_until_days: '180',
    reminder_min_auctions: '2', reminder_cooldown_days: '45',
    reminder_include_never_booked: 'false', reminder_max_per_day: '50',
    reminder_tpl: 'seller_booking_reminder',
  });

  console.log('Who is due');
  let rv = r.review(db, { date: TODAY });
  const dueIds = rv.due.map(x => x.trader_id);
  check('the lapsed regular is due', dueIds.includes(LAPSED), JSON.stringify(rv.due.map(x => x.label)));
  check('the one-time seller is filtered out by min-auctions', !dueIds.includes(ONETIMER));
  check('...and counted, so the screen can explain the drop', rv.counts.below_min_auctions === 1, JSON.stringify(rv.counts));
  check('an active seller is not due', !dueIds.includes(ACTIVE));

  // The one that would be most embarrassing in front of a customer.
  check('a seller ALREADY booked into a coming auction is never reminded', !dueIds.includes(PREBOOKED),
    JSON.stringify(rv.due.map(x => x.label)));
  check('...and is counted as too-recent, not as dropped', rv.counts.too_recent >= 2, JSON.stringify(rv.counts));

  // reserved = 1 is a held lot number, not a booking (see db.js).
  check('a RESERVED lot does not count as a booking', dueIds.includes(HELDONLY),
    'RESERVED ONLY last really booked 2026-06-03 and must read as dormant');
  const heldOnlyRow = rv.due.find(x => x.trader_id === HELDONLY);
  check('...so the last-booked date skips it', heldOnlyRow && heldOnlyRow.last_booked === '2026-06-03',
    heldOnlyRow && heldOnlyRow.last_booked);
  check('...and the lot count skips it too', heldOnlyRow && heldOnlyRow.lots_booked === 2, heldOnlyRow && heldOnlyRow.lots_booked);

  check('a seller with no phone is HELD, not silently dropped',
    rv.held.some(x => x.trader_id === NOPHONE && /no phone/.test(x.hold)), JSON.stringify(rv.held.map(x => x.hold)));
  check('never-booked sellers are excluded by default', !dueIds.includes(NEVER));
  check('...but counted, because that number decides the campaign', rv.counts.never_booked === 1, JSON.stringify(rv.counts));

  check('days away is computed from the last real booking',
    rv.due.find(x => x.trader_id === LAPSED).days_since === 119,
    String((rv.due.find(x => x.trader_id === LAPSED) || {}).days_since));
  check('the longest-away seller is first', rv.due[0].days_since >= rv.due[rv.due.length - 1].days_since,
    JSON.stringify(rv.due.map(x => x.days_since)));

  console.log('\nThe thresholds actually move the list');
  updateSettings(db, { reminder_min_auctions: '1' });
  check('min-auctions 1 lets the one-time seller in', r.review(db, { date: TODAY }).due.some(x => x.trader_id === ONETIMER));
  updateSettings(db, { reminder_min_auctions: '2' });
  updateSettings(db, { reminder_after_days: '200' });
  check('a longer "after" empties the list', r.review(db, { date: TODAY }).due.length === 0);
  updateSettings(db, { reminder_after_days: '60', reminder_until_days: '100' });
  check('a tighter "until" drops the long-gone', !r.review(db, { date: TODAY }).due.some(x => x.trader_id === LAPSED));
  check('...and counts them as gone-too-long', r.review(db, { date: TODAY }).counts.too_long_ago >= 1);
  updateSettings(db, { reminder_until_days: '180' });
  updateSettings(db, { reminder_include_never_booked: 'true' });
  rv = r.review(db, { date: TODAY });
  check('never-booked can be opted in', rv.due.some(x => x.trader_id === NEVER));
  check('...and carries a null days-away, not a fake one',
    rv.due.find(x => x.trader_id === NEVER).days_since === null);
  updateSettings(db, { reminder_include_never_booked: 'false' });

  console.log('\nThe message');
  const ctx = { nextAuction: r.nextAuction(db, TODAY) };
  check('the next auction is found', ctx.nextAuction && ctx.nextAuction.date === '2026-10-08', JSON.stringify(ctx.nextAuction));
  const row = r.review(db, { date: TODAY }).due.find(x => x.trader_id === LAPSED);
  const msg = r.composeMessage(db, row, ctx);
  check('the wording carries the real last-booked date', /03\/06\/2026/.test(msg), msg);
  check('...the next auction date', /08\/10\/2026/.test(msg), msg);
  check('...and the company', /RNS SPICES/.test(msg), msg);
  // Between seasons there is often nothing scheduled, and the sentence
  // still has to read — this is why the token sits after "for", not "on".
  const noAuc = r.composeMessage(db, row, { nextAuction: null });
  check('with no auction scheduled the sentence still reads',
    /for our next auction\./.test(noAuc) && !/on our next auction/.test(noAuc), noAuc);
  const params = r.templateParams(row, ctx);
  check('the template gets exactly three body variables', params.length === 3, JSON.stringify(params));
  check('...in the order name, last-booked, next-auction',
    params[0] === row.label && params[1] === '03/06/2026' && params[2] === '08/10/2026', JSON.stringify(params));
  // The preview cannot promise a fact the template has no variable for.
  check('...so every date the preview shows is also a template variable',
    params.slice(1).every(p => msg.includes(p)), JSON.stringify({ params, msg }));
  check('...and none is ever blank (Meta rejects those)',
    r.templateParams(row, { nextAuction: null }).every(p => String(p).trim().length > 0),
    JSON.stringify(r.templateParams(row, { nextAuction: null })));
  check('...including for a never-booked seller',
    r.templateParams({ label: 'X', last_booked: '' }, {}).every(p => String(p).trim().length > 0),
    JSON.stringify(r.templateParams({ label: 'X', last_booked: '' }, {})));

  console.log('\nSending, and the cooldown');
  let send = sender({ ok: true, id: 'wamid.R1' });
  let out = await r.sendReminders(db, r.review(db, { date: TODAY }).due, { send, mode: 'manual', by: 'admin', date: TODAY, cap: 0 });
  // TWO, not three: NO PHONE is in `held`, never in `due` (asserted above),
  // so a send can never be attempted for somebody the screen greyed out.
  check('the due sellers are messaged', out.sent === 2, JSON.stringify(out.results.map(x => x.status + ':' + x.name)));
  check('...and the no-phone seller was never even attempted',
    !out.results.some(x => /NO PHONE/.test(x.name || '')), JSON.stringify(out.results.map(x => x.name)));
  check('the ledger records who and when',
    (db.get(`SELECT sent_by, status FROM seller_reminders ORDER BY id DESC LIMIT 1`) || {}).sent_by === 'admin');
  check('the ledger keeps the dormancy it acted on',
    (db.get(`SELECT days_since FROM seller_reminders WHERE trader_id = ? LIMIT 1`, [LAPSED]) || {}).days_since === 119);

  rv = r.review(db, { date: TODAY });
  check('a reminded seller leaves the due list', !rv.due.some(x => x.trader_id === LAPSED));
  check('...and appears under held, with the reason',
    rv.held.some(x => x.trader_id === LAPSED && /cooling off/.test(x.hold)), JSON.stringify(rv.held.map(x => x.hold)));
  send = sender({ ok: true, id: 'wamid.R2' });
  out = await r.sendReminders(db, [{ trader_id: LAPSED, label: 'LAPSED REGULAR', phone: '9800000000' }],
    { send, date: TODAY, cap: 0 });
  check('sending again inside the cooldown sends NOTHING', out.sent === 0 && send.calls.length === 0, JSON.stringify(out));
  check('...and says how long ago', /already reminded 0 days ago/.test(out.results[0].reason || ''), JSON.stringify(out.results));

  // 44 days later is still inside a 45-day cooldown; 46 is not.
  const plus = (n) => { const d = r.parseYmd(TODAY); d.setDate(d.getDate() + n); return r.ymd(d); };
  check('still held at day 44', r.review(db, { date: plus(44) }).held.some(x => x.trader_id === LAPSED));
  check('due again at day 46', r.review(db, { date: plus(46) }).due.some(x => x.trader_id === LAPSED),
    JSON.stringify(r.review(db, { date: plus(46) }).due.map(x => x.label)));

  console.log('\nA failed send must not buy silence');
  const FRESH = seller('FAILED SEND', { cr: 'CR.8' });
  book(FRESH, '2026-04-22'); book(FRESH, '2026-06-03');
  const only = () => r.review(db, { date: TODAY }).due.filter(x => x.trader_id === FRESH);
  out = await r.sendReminders(db, only(), { send: sender({ ok: false, error: 'Business eligibility payment issue' }), date: TODAY, cap: 0 });
  check('the failure is reported', out.failed === 1);
  check('the failure is recorded', /eligibility/.test((db.get(`SELECT error FROM seller_reminders WHERE status='failed' ORDER BY id DESC LIMIT 1`) || {}).error || ''));
  check('a FAILED attempt leaves the seller due', only().length === 1, 'a failed send must not start the cooldown');
  out = await r.sendReminders(db, only(), { send: sender({ ok: true, id: 'wamid.R3' }), date: TODAY, cap: 0 });
  check('the retry goes through', out.sent === 1);
  check('and the retry does start the cooldown', only().length === 0);

  console.log('\nAn account-level refusal stops the whole run');
  // The cap above guards against sending too much. This guards against
  // sending into a wall: once Meta refuses the ACCOUNT, every remaining row
  // is refused too, and each refusal is another spam signal on the number.
  // Nobody is watching the 7am sweep, so the loop has to stop itself.
  const WALL = [1, 2, 3, 4].map((i) => ({
    trader_id: seller('WALL ' + i, { cr: 'CR.W' + i }),
    label: 'WALL ' + i, phone: '98000001' + String(i).padStart(2, '0'),
  }));
  let wallN = 0;
  send = sender(() => (++wallN === 1 ? { ok: true, id: 'wamid.W1' } : { ok: false, error: 'Spam Rate limit hit' }));
  out = await r.sendReminders(db, WALL, { send, mode: 'auto', date: TODAY, cap: 0 });
  check('the run stops at the refusal instead of spending the rest of the list',
    send.calls.length === 2, `attempted ${send.calls.length} of 4`);
  check('the stop is named, not buried in four identical failures',
    out.stopped && out.stopped.code === '131048', JSON.stringify(out.stopped));
  check('the untried sellers say they were never attempted',
    out.results.filter((x) => /not attempted/.test(x.reason || '')).length === 2, JSON.stringify(out.results));
  check('an untried seller is NOT burned — no cooldown, no ledger row',
    !db.get(`SELECT 1 AS x FROM seller_reminders WHERE trader_id = ?`, [WALL[3].trader_id]));
  // The two the wall never reached carry no cooldown, so they can stand in
  // for an ordinary bad-number run — which must NOT stop at the first refusal.
  check('an ordinary per-row rejection still lets the run continue',
    (await r.sendReminders(db, WALL.slice(2),
      { send: sender({ ok: false, error: 'Message undeliverable' }), date: TODAY, cap: 0 })).failed === 2);

  console.log('\nThe daily cap');
  for (let i = 0; i < 8; i++) {
    const t = seller('BULK ' + i, { cr: 'CR.B' + i });
    book(t, '2026-04-22'); book(t, '2026-06-03');
  }
  send = sender({ ok: true, id: 'wamid.RB' });
  out = await r.sendReminders(db, r.review(db, { date: TODAY }).due, { send, mode: 'auto', date: TODAY, cap: 3 });
  check('the cap stops the run at 3', out.sent === 3 && send.calls.length === 3, JSON.stringify({ sent: out.sent, calls: send.calls.length }));
  check('the rest are skipped, not failed', out.skipped >= 5 && out.failed === 0, JSON.stringify(out));
  check('the skip explains itself', out.results.some(x => /daily cap of 3/.test(x.reason || '')));

  console.log('\nEvery gate on the automatic sweep');
  const at11 = new Date(2026, 8, 30, 11, 0);
  updateSettings(db, { flag_seller_reminders: 'false' });
  let sw = await r.runDailySweep(db, { send: sender({ ok: true }), now: at11 });
  check('off while the feature flag is off', sw.ran === false && /feature off/.test(sw.reason));
  updateSettings(db, { flag_seller_reminders: 'true' });
  sw = await r.runDailySweep(db, { send: sender({ ok: true }), now: at11 });
  check('still off while auto-send is off — the default is a worklist', sw.ran === false && /auto-send off/.test(sw.reason));
  updateSettings(db, { reminder_auto_send: 'true', reminder_send_hour: '10' });
  sw = await r.runDailySweep(db, { send: sender({ ok: true }), now: new Date(2026, 8, 30, 8, 0) });
  check('nothing before the send hour', sw.ran === false && /before send hour/.test(sw.reason));
  updateSettings(db, { reminder_max_per_day: '2' });
  send = sender({ ok: true, id: 'wamid.SW' });
  sw = await r.runDailySweep(db, { send, now: at11 });
  check('the sweep sends its daily slice', sw.ran === true && sw.sent === 2, JSON.stringify(sw));
  // The backlog is the point: unlike a birthday, a dormant seller is still
  // dormant tomorrow, so the sweep drains rather than blasting.
  check('...and reports the backlog it did not reach', sw.remaining > 0, JSON.stringify(sw));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
