// Birthday greetings — the send-once ledger and the daily sweep.
//
// Runs the real engine against a REAL database (so the partial unique index
// in db.js is the thing being tested, not a stand-in) with a FAKE sender, so
// no Meta account and no network are involved.
//
// What it is here to prove:
//   • a party is greeted at most once per calendar year, whatever the caller
//     does — that is the difference between a nice touch and an app that
//     spams a customer every time the server restarts;
//   • a FAILED attempt is recorded but leaves the year open for a retry;
//   • the daily cap, the no-phone skip, and every gate on the sweep.
//
//   node tests/birthday-send-once.unit.js
const os = require('os'), path = require('path'), fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'birthday-'));
process.env.SPICE_DATA_DIR = TMP;   // MUST precede require('../db') — db.js
                                    // reads it at module load, and without it
                                    // this test would write the live data/config.db

const { initDb } = require('../db');
const { initCompanySettings, updateSettings } = require('../company-config');
const b = require('../birthday-greetings');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const done = (c) => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(c); };

// A sender that records what it was asked to send and answers as told.
function sender(outcome) {
  const calls = [];
  const fn = async (msg) => {
    calls.push(msg);
    return typeof outcome === 'function' ? outcome(msg, calls.length) : outcome;
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  const db = await initDb();
  initCompanySettings(db);

  const TODAY = '2026-09-29';   // fixed so the test never depends on the clock
  const YEAR = 2026;
  db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`, ['MURUGAN', 'CR.1', '1980-09-29', '9876543210']);
  db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`, ['SELVAM', 'CR.2', '29/09/1975', '9000000002']);
  db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`, ['NO PHONE', 'CR.3', '1990-09-29', '']);
  db.run(`INSERT INTO buyers (buyer, buyer1, dob, tel) VALUES (?,?,?,?)`, ['AK', 'AK TRADERS', '29-Sep-1970', '9000000007']);

  console.log('Reading the masters');
  const due = b.birthdaysOn(db, TODAY);
  check('all four parties are found through the real schema', due.length === 4, `got ${due.length}`);
  check('buyers.dob exists on a fresh database', due.some(r => r.party_type === 'buyer'));

  console.log('\nThe send-once guarantee');
  let send = sender({ ok: true, id: 'wamid.AAA' });
  let out = await b.sendGreetings(db, due, { send, mode: 'manual', by: 'admin', cap: 0 });
  check('three sends, one skipped for want of a phone', out.sent === 3 && out.skipped === 1,
    JSON.stringify(out.results));
  check('the skip names its reason',
    /no phone/.test((out.results.find(r => r.status === 'skipped') || {}).reason || ''));
  check('the operator is recorded',
    (db.get(`SELECT sent_by FROM birthday_greetings WHERE status='sent' LIMIT 1`) || {}).sent_by === 'admin');
  check('the wamid is kept, so the WhatsApp receipt can be joined later',
    (db.get(`SELECT wamid FROM birthday_greetings WHERE status='sent' LIMIT 1`) || {}).wamid === 'wamid.AAA');

  // The whole point. A second run — a restart, a second operator, an
  // impatient click — must send nothing.
  send = sender({ ok: true, id: 'wamid.BBB' });
  out = await b.sendGreetings(db, due, { send, mode: 'manual', cap: 0 });
  check('a second run sends NOTHING', out.sent === 0 && send.calls.length === 0, JSON.stringify(out));
  check('and says why', out.results.filter(r => /already greeted in 2026/.test(r.reason || '')).length === 3);

  // The index, not the check, is the guarantee: force the insert the check
  // would have prevented and confirm the database refuses it.
  let refused = false;
  try {
    db.run(`INSERT INTO birthday_greetings (party_type, party_id, greet_year, greet_date, status)
            VALUES ('seller', 1, '2026', '2026-09-29', 'sent')`);
  } catch (_) { refused = true; }
  check('the database itself refuses a second SENT row for the year', refused);
  // ...while the same party in a different year is a different greeting.
  let nextYearOk = true;
  try {
    db.run(`INSERT INTO birthday_greetings (party_type, party_id, greet_year, greet_date, status)
            VALUES ('seller', 1, '2027', '2027-09-29', 'sent')`);
  } catch (_) { nextYearOk = false; }
  check('next year is a separate slot', nextYearOk);
  db.run(`DELETE FROM birthday_greetings WHERE greet_year = '2027'`);

  console.log('\nA failed send leaves the year open');
  db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`, ['RETRY', 'CR.9', '1988-09-29', '9111111111']);
  const retryRow = b.birthdaysOn(db, TODAY).filter(r => r.name === 'RETRY');
  out = await b.sendGreetings(db, retryRow, { send: sender({ ok: false, error: 'Business eligibility payment issue' }), cap: 0 });
  check('the failure is reported', out.failed === 1 && out.sent === 0);
  check('the failure is recorded with Meta’s own words',
    /eligibility/.test((db.get(`SELECT error FROM birthday_greetings WHERE status='failed' ORDER BY id DESC LIMIT 1`) || {}).error || ''));
  out = await b.sendGreetings(db, retryRow, { send: sender({ ok: true, id: 'wamid.CCC' }), cap: 0 });
  check('the retry goes through — a failure does not burn the year', out.sent === 1, JSON.stringify(out));
  out = await b.sendGreetings(db, retryRow, { send: sender({ ok: true, id: 'wamid.DDD' }), cap: 0 });
  check('and the retry itself closes the year', out.sent === 0 && out.skipped === 1);

  console.log('\nThe daily cap');
  // A bad DOB import — every row the same day — is the realistic way this
  // feature could empty the 250-recipient/24h WhatsApp tier and take the
  // day's invoice sends with it.
  for (let i = 0; i < 8; i++) {
    db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`,
      [`BULK${i}`, `CR.B${i}`, '1980-09-28', '90000001' + String(i).padStart(2, '0')]);
  }
  const bulk = b.birthdaysOn(db, '2026-09-28');
  check('the bad import lands on one day', bulk.length === 8, `got ${bulk.length}`);
  send = sender({ ok: true, id: 'wamid.EEE' });
  out = await b.sendGreetings(db, bulk, { send, mode: 'auto', cap: 3 });
  check('the cap stops the run at 3', out.sent === 3 && send.calls.length === 3, JSON.stringify({ sent: out.sent, calls: send.calls.length }));
  check('the rest are skipped, not failed', out.skipped === 5 && out.failed === 0);
  check('the skip explains itself', out.results.filter(r => /daily cap of 3/.test(r.reason || '')).length === 5);

  console.log('\nAn account-level refusal stops the whole sweep');
  // Same guard, other campaign: the cap stops us sending too much, this stops
  // us sending into a wall. Every row after an account-level refusal would be
  // refused too, and each refusal counts against the number.
  for (let i = 0; i < 4; i++) {
    db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`,
      [`WALL${i}`, `CR.W${i}`, '1980-09-29', '90000002' + String(i).padStart(2, '0')]);
  }
  // 29 Sep already carries fixture parties from the cases above, so the wall
  // run is narrowed to its own four — the point is where the loop STOPS.
  const wall = b.birthdaysOn(db, '2026-09-29').filter((r) => /WALL/.test(r.name || ''));
  check('the wall fixture is four parties', wall.length === 4, `got ${wall.length}`);
  let wallN = 0;
  send = sender(() => (++wallN === 1 ? { ok: true, id: 'wamid.W1' } : { ok: false, error: 'Spam Rate limit hit' }));
  out = await b.sendGreetings(db, wall, { send, mode: 'auto', cap: 0 });
  check('the sweep stops at the refusal instead of spending the rest of the list',
    send.calls.length === 2, `attempted ${send.calls.length} of 4`);
  check('the stop is named', out.stopped && out.stopped.code === '131048', JSON.stringify(out.stopped));
  check('the untried parties say they were never attempted',
    out.results.filter((r) => /not attempted/.test(r.reason || '')).length === 2, JSON.stringify(out.results));
  check('an untried party is NOT burned — nothing was written to the send-once ledger',
    !db.get(`SELECT 1 AS x FROM birthday_greetings WHERE party_id = ? AND party_type = 'seller'`,
      [wall[3].party_id]));

  console.log('\nThe message that actually goes out');
  updateSettings(db, {
    birthday_message: 'Dear {name}, happy birthday from {company}!',
    trade_name: 'RNS SPICES',
    birthday_tpl: 'birthday_greeting',
    birthday_tpl_lang: 'en',
  });
  db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`, ['WORDING', 'CR.W', '1980-09-27', '9222222222']);
  send = sender({ ok: true, id: 'wamid.FFF' });
  await b.sendGreetings(db, b.birthdaysOn(db, '2026-09-27'), { send, cap: 0 });
  const msg = send.calls[0] || {};
  check('the wording is composed from the setting',
    msg.text === 'Dear WORDING, happy birthday from RNS SPICES!', msg.text);
  // One body variable, the name — that is what the approved Meta template
  // takes. A second variable here would be rejected at send time.
  check('the template gets exactly one body variable',
    Array.isArray(msg.bodyParams) && msg.bodyParams.length === 1, JSON.stringify(msg.bodyParams));
  check('the greeting is tagged in the send log so it is traceable',
    msg.ref && msg.ref.ref_type === 'birthday' && /^seller:\d+$/.test(msg.ref.ref_id), JSON.stringify(msg.ref));

  console.log('\nEvery gate on the automatic sweep');
  const at10 = new Date(2026, 8, 29, 10, 0);
  let r = await b.runDailySweep(db, { send: sender({ ok: true }), now: at10 });
  check('off while the feature flag is off', r.ran === false && /feature off/.test(r.reason));
  updateSettings(db, { flag_birthday_greetings: 'true' });
  r = await b.runDailySweep(db, { send: sender({ ok: true }), now: at10 });
  check('still off while auto-send is off — the default is a worklist',
    r.ran === false && /auto-send off/.test(r.reason));
  updateSettings(db, { birthday_auto_send: 'true', birthday_send_hour: '9' });
  r = await b.runDailySweep(db, { send: sender({ ok: true }), now: new Date(2026, 8, 29, 7, 0) });
  check('nothing before the send hour', r.ran === false && /before send hour/.test(r.reason));
  updateSettings(db, { birthday_send_sellers: 'false', birthday_send_buyers: 'false' });
  r = await b.runDailySweep(db, { send: sender({ ok: true }), now: at10 });
  check('nothing when neither sellers nor buyers are selected',
    r.ran === false && /no party types/.test(r.reason));
  updateSettings(db, { birthday_send_sellers: 'true', birthday_send_buyers: 'true' });

  // With every gate open the sweep works on TODAY only — it is a timer, not
  // a catch-up job, so a machine that was off all day sends nothing.
  db.run(`INSERT INTO traders (name, cr, dob, tel) VALUES (?,?,?,?)`,
    ['SWEEP', 'CR.S', b.ymd(new Date()).replace(/^\d{4}/, '1980'), '9333333333']);
  send = sender({ ok: true, id: 'wamid.GGG' });
  r = await b.runDailySweep(db, { send, now: new Date(new Date().setHours(10, 0, 0, 0)) });
  check('the sweep runs and greets today’s birthday', r.ran === true && r.sent >= 1, JSON.stringify(r));
  check('it greeted SWEEP', send.calls.some(c => /SWEEP/.test(c.text || '')));
  const before = send.calls.length;
  r = await b.runDailySweep(db, { send, now: new Date(new Date().setHours(11, 0, 0, 0)) });
  check('the next tick the same day is a no-op', r.ran === true && r.sent === 0 && send.calls.length === before,
    JSON.stringify(r));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
