// WhatsApp compliance — the gate, the consent ledger and the intent reader.
//
// Runs wa-compliance.js against a REAL database (so the wa_consent table and
// the phone_key index in db.js are the things being tested, not a stand-in).
// No Meta account and no network are involved.
//
// WHAT THIS IS HERE TO PROVE
// Meta disabled this business's WhatsApp account on 2026-11-04 for a breach
// of the Terms of Acceptable Use: marketing went to people who had never
// opted in, and replies asking us to stop were logged and never read. These
// are the assertions that say it cannot happen again:
//
//   • a MARKETING message to a contact with no opt-in on record is refused;
//   • an opt-out silences EVERY class, utility and invoice included;
//   • "STOP" in a reply opts somebody out on the spot, in English and Tamil;
//   • an ambiguous reply ("when does the auction end") does NOT, because
//     wrongly silencing a seller cuts them off from their own documents;
//   • the per-contact caps, the quality-rating gates, the dead-number gate;
//   • `warn` mode lets a message out but records the verdict, and `off`
//     restores the old behaviour — both exactly as documented;
//   • the install-wide pause beats everything, including the mode.
//
//   node tests/wa-compliance.unit.js
const os = require('os'), path = require('path'), fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-policy-'));
process.env.SPICE_DATA_DIR = TMP;   // MUST precede require('../db') — db.js
                                    // reads it at module load, and without it
                                    // this test would write the live
                                    // data/config.db

const { initDb } = require('../db');
const { initCompanySettings, updateSettings } = require('../company-config');
const wa = require('../wa-compliance');
const waErrors = require('../wa-errors');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); }
};
const done = (c) => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(c); };

const PHONE = '9876543210';
const PHONE_91 = '919876543210';

(async () => {
  const db = await initDb();
  initCompanySettings(db);

  // Log a send as the server would, so the gate's counters see it.
  // `ago` is a SQLite modifier like '-5 days', INTERPOLATED rather than
  // bound: a bound value is a string, not an expression, so binding
  // "datetime('now','-5 days')" stores those characters and every julianday
  // comparison against them silently returns null — which makes the
  // frequency assertions pass for the wrong reason.
  const logged = (phone, msgType, status, ago) => {
    const at = ago ? `datetime('now','localtime','${ago}')` : `datetime('now','localtime')`;
    db.run(
      `INSERT INTO whatsapp_messages (direction, phone, msg_type, status, phone_key, created_at)
       VALUES ('out', ?, ?, ?, ?, ${at})`,
      [phone, msgType, status, wa.consentKey(phone)]);
  };
  const clearLog = () => db.run('DELETE FROM whatsapp_messages');
  const clearConsent = () => db.run('DELETE FROM wa_consent');
  const g = (opts) => wa.gate(db, Object.assign({ phone: PHONE }, opts));

  // ── 1. Classification ───────────────────────────────────────
  console.log('\nclassification');
  check('a birthday template is marketing', wa.classify('template-birthday') === 'marketing');
  check('a reminder template is marketing', wa.classify('template-reminder') === 'marketing');
  check('a document template is utility', wa.classify('template-document') === 'utility');
  check('a plain text send is a service reply', wa.classify('text') === 'service');
  // The hole that mattered: an outreach campaign falling back to free text
  // writes msg_type 'text', which on its own reads as a solicited reply.
  check('free-text outreach is still marketing, by ref_type',
    wa.classify('text', 'birthday') === 'marketing');
  check('free-text reminder is still marketing, by ref_type',
    wa.classify('text', 'seller_reminder') === 'marketing');
  // An unregistered sender must not inherit the loosest rules by accident.
  check('an unknown msg_type falls back to utility, never service',
    wa.classify('template-something-new') === 'utility');

  // ── 2. The consent key ──────────────────────────────────────
  console.log('\nconsent key — every spelling of one number lands on one row');
  const keys = ['9876543210', '919876543210', '+91 98765 43210', '+91-98765-43210', '0919876543210']
    .map(wa.consentKey);
  check('all five spellings share a key', new Set(keys).size === 1, keys.join(' / '));
  check('the key is the last ten digits', keys[0] === '9876543210');
  check('a blank number has no key', wa.consentKey('') === '' && wa.consentKey(null) === '');

  // ── 3. The intent reader ────────────────────────────────────
  console.log('\nintent — unambiguous stops');
  for (const t of ['STOP', 'stop', 'Stop.', 'unsubscribe', 'opt out', 'OPTOUT',
                   'please remove me', 'remove my number', 'stop sending messages',
                   'no more messages', 'do not message me again', "don't contact me again",
                   'stop disturbing', 'வேண்டாம்', 'இந்த மெசேஜ் வேண்டாம்', 'vendam', 'niruthu']) {
    check(`"${t}" → stop`, wa.detectIntent(t) === 'stop', `got ${wa.detectIntent(t)}`);
  }

  console.log('\nintent — ordinary auction conversation is NOT a stop');
  // Each of these was matched as an opt-out by the first draft's single
  // generous pattern list. Silencing any of them would have cut a customer
  // off from their own invoice.
  for (const t of ['when does the auction end', 'cancel lot 42 please',
                   'block 5 lots for me', 'I will quit next season',
                   'send the invoice to this number', 'ok', 'yes', 'thanks',
                   'what is the rate today']) {
    const got = wa.detectIntent(t);
    check(`"${t}" is not auto-applied`, got !== 'stop', `got ${got}`);
  }
  check('"when does the auction end" is flagged for review, not acted on',
    wa.detectIntent('when does the auction end') === 'review');
  check('"not interested" is flagged for review', wa.detectIntent('not interested') === 'review');
  check('"wrong number" is flagged for review', wa.detectIntent('wrong number') === 'review');

  console.log('\nintent — opt-in is at least as strict');
  check('"START" → start', wa.detectIntent('START') === 'start');
  check('"subscribe" → start', wa.detectIntent('subscribe') === 'start');
  check('"yes please send updates" → start', wa.detectIntent('yes please send updates') === 'start');
  // A bare yes is an answer to something, and we do not know what.
  check('a bare "yes" is NOT an opt-in', wa.detectIntent('yes') !== 'start');
  check('a bare "ok" is NOT an opt-in', wa.detectIntent('ok') !== 'start');

  console.log('\nintent — long messages are conversation, not commands');
  const longMsg = 'can I cancel lot 42 and move the rest of my lots to the auction next week instead please';
  check('a 17-word message naming "cancel" is ignored', wa.detectIntent(longMsg) === null);

  console.log('\nintent — a template Stop button needs no word limit');
  check('payload "stop" is an opt-out', wa.buttonIsOptOut('stop', '') === true);
  check('title "Unsubscribe" is an opt-out', wa.buttonIsOptOut('', 'Unsubscribe') === true);
  // The reassign approval flow sends quick-reply buttons through the same
  // webhook path; neither may read as an opt-out.
  check('"approve:42" is not an opt-out', wa.buttonIsOptOut('approve:42', 'Approve') === false);
  check('"deny:42" is not an opt-out', wa.buttonIsOptOut('deny:42', 'Deny') === false);

  // ── 4. The ledger ───────────────────────────────────────────
  console.log('\nledger');
  clearConsent();
  check('an untouched number has no record', wa.readConsent(db, PHONE) === null);
  wa.setConsent(db, { phone: PHONE, status: 'in', source: 'operator', basis: 'signed registration form' });
  let rec = wa.readConsent(db, PHONE);
  check('an opt-in is stored', rec && rec.status === 'in');
  check('the basis is stored with it', rec && rec.basis === 'signed registration form');
  check('opted_in_at is stamped', !!(rec && rec.opted_in_at));
  // The number is written in a different shape; it must find the same row.
  check('the 91-prefixed spelling reads the same row',
    wa.readConsent(db, PHONE_91) && wa.readConsent(db, PHONE_91).status === 'in');
  const inAt = rec.opted_in_at;
  wa.setConsent(db, { phone: PHONE, status: 'out', source: 'reply', basis: 'replied STOP' });
  rec = wa.readConsent(db, PHONE);
  check('an opt-out replaces the status', rec.status === 'out');
  check('opted_out_at is stamped', !!rec.opted_out_at);
  // Both dates are kept: an auditor asks "since when did you have
  // permission" AND "when did you stop".
  check('the original opt-in date survives the opt-out', rec.opted_in_at === inAt);
  check('a bad status is refused', wa.setConsent(db, { phone: PHONE, status: 'maybe' }).ok === false);
  check('a blank phone is refused', wa.setConsent(db, { phone: '', status: 'in' }).ok === false);

  // ── 5. THE RULE THE BAN WAS ABOUT ───────────────────────────
  console.log('\nmarketing needs an opt-in — the rule whose absence caused the ban');
  clearConsent(); clearLog();
  let v = g({ msgType: 'template-birthday' });
  check('a greeting to a contact with no opt-in is REFUSED', v.allow === false, v.code);
  check('…and the reason names the rule', v.code === 'no_optin', v.code);
  check('…and reads as a sentence an operator can act on',
    /opt-in/i.test(v.reason) && /Compliance/.test(v.reason), v.reason);
  v = g({ msgType: 'template-reminder' });
  check('a dormant-seller reminder is refused the same way', v.code === 'no_optin');
  // Utility is allowed on the business relationship — that is what Meta's
  // utility category is for, and refusing an invoice would break the firm.
  v = g({ msgType: 'template-document' });
  check('an INVOICE to the same contact still goes out', v.allow === true, v.code);
  v = g({ msgType: 'text' });
  check('a reply inside the 24h window still goes out', v.allow === true, v.code);

  wa.setConsent(db, { phone: PHONE, status: 'in', basis: 'asked on the phone' });
  v = g({ msgType: 'template-birthday' });
  check('with an opt-in on record the greeting is allowed', v.allow === true, v.code);

  // ── 6. Opt-out silences everything ──────────────────────────
  console.log('\nan opt-out silences every class');
  wa.setConsent(db, { phone: PHONE, status: 'out', basis: 'replied STOP' });
  for (const t of ['template-birthday', 'template-reminder', 'template-document', 'template-text', 'document', 'text']) {
    v = g({ msgType: t });
    check(`${t} is refused`, v.allow === false && v.code === 'opted_out', v.code);
  }
  check('the refusal says when they asked', /\d{4}-\d{2}-\d{2}/.test(g({ msgType: 'document' }).reason));

  // ── 6b. A narrower opt-out ──────────────────────────────────
  // "Stop the birthday messages but keep sending my bills" is a real
  // request, and answering it by cutting somebody off from their own
  // invoices would be honouring it badly.
  console.log('\nan opt-out scoped to marketing only');
  clearConsent(); clearLog();
  wa.setConsent(db, { phone: PHONE, status: 'out', scope: 'marketing', basis: 'asked on the phone — greetings only' });
  check('the narrow scope is stored', wa.readConsent(db, PHONE).scope === 'marketing');
  v = g({ msgType: 'template-birthday' });
  check('a greeting is refused', v.allow === false && v.code === 'opted_out_marketing', v.code);
  check('…and says invoices still reach them', /[Ii]nvoices and notices still/.test(v.reason), v.reason);
  v = g({ msgType: 'template-document' });
  check('their INVOICE still goes out', v.allow === true, v.code);
  v = g({ msgType: 'text' });
  check('and so does a reply', v.allow === true, v.code);
  // The default must stay the strict reading: a bare STOP means everything.
  wa.setConsent(db, { phone: PHONE, status: 'out', basis: 'replied STOP' });
  check('an opt-out with no scope given defaults to ALL',
    wa.readConsent(db, PHONE).scope === 'all');
  check('…and stops the invoice too', g({ msgType: 'template-document' }).code === 'opted_out');
  wa.setConsent(db, { phone: PHONE, status: 'out', scope: 'nonsense', basis: 'x' });
  check('an unrecognised scope falls back to ALL, the stricter reading',
    wa.readConsent(db, PHONE).scope === 'all');
  // A stop REPLY is never narrowed automatically — no reader of words is
  // confident enough to decide that for somebody.
  clearConsent();
  wa.recordInbound(db, PHONE, 'STOP');
  check('a stop reply records the total scope', wa.readConsent(db, PHONE).scope === 'all');

  // ── 7. Marketing frequency, across campaigns ────────────────
  console.log('\nmarketing frequency — counted across BOTH campaigns');
  clearConsent(); clearLog();
  wa.setConsent(db, { phone: PHONE, status: 'in', basis: 'form' });
  logged(PHONE_91, 'template-birthday', 'delivered', '-5 days');
  v = g({ msgType: 'template-reminder' });
  check('a reminder 5 days after a birthday wish is refused', v.allow === false && v.code === 'too_soon', v.code);
  check('…and the reason gives the number of days', /5 days/.test(v.reason), v.reason);
  clearLog();
  logged(PHONE_91, 'template-birthday', 'delivered', '-40 days');
  v = g({ msgType: 'template-reminder' });
  check('40 days later it is allowed', v.allow === true, v.code);
  clearLog();
  // A refused send is not a message the contact received.
  logged(PHONE_91, 'template-birthday', 'failed', '-2 days');
  logged(PHONE_91, 'template-reminder', 'blocked', '-2 days');
  v = g({ msgType: 'template-reminder' });
  check('a failed or blocked attempt does not start the clock', v.allow === true, v.code);
  // A document is not marketing and must not consume the window.
  clearLog();
  logged(PHONE_91, 'template-document', 'delivered', '-1 days');
  v = g({ msgType: 'template-birthday' });
  check('yesterday\'s invoice does not block today\'s greeting', v.allow === true, v.code);

  // ── 8. Per-contact daily ceiling ────────────────────────────
  console.log('\nper-contact daily ceiling — across all classes');
  clearLog();
  logged(PHONE_91, 'template-document', 'delivered');
  logged(PHONE_91, 'template-document', 'delivered');
  v = g({ msgType: 'template-document' });
  check('two documents today, a third is allowed', v.allow === true, v.code);
  logged(PHONE_91, 'template-text', 'sent');
  v = g({ msgType: 'template-document' });
  check('a fourth in 24h is refused', v.allow === false && v.code === 'contact_cap', v.code);
  v = g({ msgType: 'text' });
  check('a service reply is never capped', v.allow === true, v.code);

  // ── 9. Quality rating ───────────────────────────────────────
  console.log('\nquality rating — Meta\'s own early warning');
  clearLog();
  check('GREEN maps to green', wa.healthFromRating('GREEN') === 'green');
  check('a missing rating is unknown, not bad', wa.healthFromRating('') === 'unknown');
  v = g({ msgType: 'template-birthday', health: 'yellow' });
  check('YELLOW pauses marketing', v.allow === false && v.code === 'quality_yellow', v.code);
  v = g({ msgType: 'template-document', health: 'yellow' });
  check('…but invoices still go out on yellow', v.allow === true, v.code);
  v = g({ msgType: 'template-document', health: 'red' });
  check('RED pauses invoices too', v.allow === false && v.code === 'quality_red', v.code);
  v = g({ msgType: 'text', health: 'red' });
  check('…except replies, which are what repair a rating', v.allow === true, v.code);
  v = g({ msgType: 'template-document', health: 'unknown' });
  check('an unknown rating never stops the day\'s work', v.allow === true, v.code);

  // ── 10. Dead numbers ────────────────────────────────────────
  console.log('\ndead numbers — each retry is another spam signal');
  clearLog();
  for (let i = 0; i < 3; i++) logged(PHONE_91, 'template-document', 'failed');
  v = g({ msgType: 'template-document' });
  check('three refusals and no delivery ever → stop trying', v.allow === false && v.code === 'dead_number', v.code);
  logged(PHONE_91, 'template-document', 'delivered');
  v = g({ msgType: 'template-document' });
  check('one success and the number is never called dead', v.allow === true, v.code);

  // ── 11. Modes ───────────────────────────────────────────────
  console.log('\nmodes');
  clearConsent(); clearLog();
  updateSettings(db, { wa_compliance_mode: 'warn' });
  v = g({ msgType: 'template-birthday' });
  check('warn mode lets the message out', v.allow === true);
  check('…but still names the verdict', v.code === 'no_optin', v.code);
  check('…and flags itself as advisory', v.advisory === true);
  updateSettings(db, { wa_compliance_mode: 'off' });
  v = g({ msgType: 'template-birthday' });
  check('off restores the pre-ban behaviour', v.allow === true && v.code === 'compliance_off', v.code);
  updateSettings(db, { wa_compliance_mode: 'nonsense' });
  v = g({ msgType: 'template-birthday' });
  check('an unrecognised mode falls back to ENFORCE, not off', v.allow === false, v.code);
  updateSettings(db, { wa_compliance_mode: 'enforce' });

  // ── 12. The pause beats everything ──────────────────────────
  console.log('\nthe install-wide pause');
  updateSettings(db, { wa_sending_paused: 'true', wa_compliance_mode: 'off' });
  v = g({ msgType: 'template-document' });
  check('paused stops a send even with the rules switched off',
    v.allow === false && v.code === 'paused', v.code);
  v = g({ msgType: 'text' });
  check('paused stops a service reply too', v.allow === false, v.code);
  updateSettings(db, { wa_sending_paused: 'false', wa_compliance_mode: 'enforce' });

  // ── 13. The legacy opt-in switch ────────────────────────────
  console.log('\nthe legacy opt-in switch');
  clearConsent();
  v = g({ msgType: 'template-birthday' });
  check('off by default, so marketing is refused', v.allow === false && v.code === 'no_optin');
  updateSettings(db, { wa_assume_legacy_optin: 'true' });
  v = g({ msgType: 'template-birthday' });
  check('on, the master counts as opted in', v.allow === true, v.code);
  wa.setConsent(db, { phone: PHONE, status: 'out', basis: 'replied STOP' });
  v = g({ msgType: 'template-birthday' });
  check('an explicit opt-out still beats it', v.allow === false && v.code === 'opted_out', v.code);
  updateSettings(db, { wa_assume_legacy_optin: 'false' });

  // ── 14. Inbound replies reach the ledger ────────────────────
  console.log('\ninbound replies reach the ledger');
  clearConsent();
  let r = wa.recordInbound(db, PHONE, 'STOP');
  check('a stop reply is applied', r.intent === 'stop' && r.applied === true);
  check('…and the contact is now out', wa.readConsent(db, PHONE).status === 'out');
  check('…with the source recorded as their own reply', wa.readConsent(db, PHONE).source === 'reply');
  r = wa.recordInbound(db, PHONE, 'STOP');
  check('a second stop is a no-op', r.applied === false);
  r = wa.recordInbound(db, PHONE, 'subscribe');
  check('an opt-in reply reverses it', r.intent === 'start' && wa.readConsent(db, PHONE).status === 'in');
  clearConsent();
  r = wa.recordInbound(db, PHONE, 'when does the auction end');
  check('an ambiguous reply is reported but NOT applied', r.intent === 'review' && r.applied === false);
  check('…and writes no ledger row', wa.readConsent(db, PHONE) === null);
  r = wa.recordInbound(db, PHONE, 'what is the rate');
  check('ordinary conversation is nothing at all', r.intent === null);
  // A Stop button tap carries no text.
  r = wa.recordInbound(db, PHONE, '', { buttonPayload: 'stop', buttonTitle: 'Stop promotions' });
  check('a Stop button tap opts out', r.intent === 'stop' && wa.readConsent(db, PHONE).status === 'out');

  // ── 15. Meta's own refusals ─────────────────────────────────
  console.log("\nMeta's own refusals feed the ledger");
  clearConsent();
  r = wa.noteMetaError(db, PHONE, '(#131050) User has stopped marketing messages');
  check('131050 records an opt-out', r.applied === true && wa.readConsent(db, PHONE).status === 'out');
  check('…attributed to Meta, not to us', wa.readConsent(db, PHONE).source === 'meta');
  clearConsent();
  r = wa.noteMetaError(db, PHONE, 'Message undeliverable');
  check('an ordinary failure records nothing', r.applied === false && wa.readConsent(db, PHONE) === null);
  // The error table must agree: both policy refusals are account-level stops.
  check('131050 is an account-level stop in wa-errors',
    waErrors.blockKind('(#131050) user has stopped') !== null);
  check('131049 is an account-level stop in wa-errors',
    waErrors.blockKind('(#131049) frequency cap') !== null);
  check('131048 still wins over the generic rate-limit pattern',
    waErrors.blockKind('Spam Rate limit hit').code === '131048');

  // ── 16. The historic backlog ────────────────────────────────
  console.log('\nthe backlog of replies nobody read');
  clearConsent();
  db.run('DELETE FROM whatsapp_inbound');
  // Two shapes: the raw webhook JSON this table actually holds, and a plain
  // string (the shape that predates it).
  db.run('INSERT INTO whatsapp_inbound (wamid, phone, body) VALUES (?,?,?)',
    ['w1', '919111111111', JSON.stringify({ type: 'text', text: { body: 'STOP' } })]);
  db.run('INSERT INTO whatsapp_inbound (wamid, phone, body) VALUES (?,?,?)',
    ['w2', '919222222222', 'please remove me']);
  db.run('INSERT INTO whatsapp_inbound (wamid, phone, body) VALUES (?,?,?)',
    ['w3', '919333333333', JSON.stringify({ type: 'text', text: { body: 'what is the rate today' } })]);
  db.run('INSERT INTO whatsapp_inbound (wamid, phone, body) VALUES (?,?,?)',
    ['w4', '919444444444', JSON.stringify({ type: 'text', text: { body: 'when does the auction end' } })]);
  let out = wa.applyHistoricOptOuts(db, { by: 'tester' });
  check('both unambiguous stops are applied', out.applied === 2, JSON.stringify(out));
  check('the first is now out', wa.readConsent(db, '9111111111').status === 'out');
  check('the second is now out', wa.readConsent(db, '9222222222').status === 'out');
  check('ordinary conversation is untouched', wa.readConsent(db, '9333333333') === null);
  check('the ambiguous one is left for a person', wa.readConsent(db, '9444444444') === null);
  out = wa.applyHistoricOptOuts(db, { by: 'tester' });
  check('running it again applies nothing', out.applied === 0);

  // ── 17. Coverage ────────────────────────────────────────────
  console.log('\ncoverage');
  const cov = wa.coverage(db);
  check('the opt-out count is reported', cov.optedOut >= 2, JSON.stringify(cov.optedOut));
  check('the ambiguous reply is listed for review', cov.needsReviewCount >= 1, String(cov.needsReviewCount));
  check('…with the words they actually sent',
    cov.needsReview.some((x) => /auction end/.test(x.text)), JSON.stringify(cov.needsReview));
  check('"never asked" is a number, not zero by default', typeof cov.unknown === 'number');

  // ── 18. The worklist label ──────────────────────────────────
  console.log('\nthe worklist label the two campaigns show');
  const map = wa.consentMap(db);
  check('the ledger loads as one Map', map instanceof Map && map.size >= 2);
  check('…carrying the scope alongside the status',
    [...map.values()].every(v => v && typeof v.status === 'string' && typeof v.scope === 'string'),
    JSON.stringify([...map.entries()].slice(0, 3)));
  const pol = wa.configWithFallbacks(db);
  check('an opted-out seller is labelled as such',
    /opted out/.test(wa.marketingConsentHold('9111111111', map, pol)));
  wa.setConsent(db, { phone: '9777777777', status: 'out', scope: 'marketing', basis: 'greetings only' });
  check('a marketing-only opt-out is held too, but worded differently',
    /stop greetings and reminders/.test(wa.marketingConsentHold('9777777777', wa.consentMap(db), pol)),
    wa.marketingConsentHold('9777777777', wa.consentMap(db), pol));
  check('an unknown seller is labelled "no opt-in on record"',
    /no WhatsApp opt-in/.test(wa.marketingConsentHold('9555555555', map, pol)));
  check('a seller with no number is labelled as such',
    /no phone/.test(wa.marketingConsentHold('', map, pol)));
  wa.setConsent(db, { phone: '9666666666', status: 'in', basis: 'form' });
  check('an opted-in seller is not held',
    wa.marketingConsentHold('9666666666', wa.consentMap(db), pol) === '');

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
