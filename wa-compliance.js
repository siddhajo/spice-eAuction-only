// ── wa-compliance.js ──────────────────────────────────────────────
// The policy gate every WhatsApp send now passes through.
//
// WHY THIS FILE EXISTS
// On 2026-11-04 Meta disabled the RNS Spices WhatsApp Business account:
//
//   "We have disabled RNS Spices and its WhatsApp Business accounts due to
//    activity that does not comply with WhatsApp's Business Terms of
//    Service: breach of Terms of Acceptable Use."
//
// Nothing in the app had broken. Every guard that existed was a guard about
// Meta's *limits* — the 24h recipient ceiling, throughput, billing — and the
// app obeyed all of them. What it had no concept of at all was Meta's
// *permission* rules, which is a different thing entirely:
//
//   • WhatsApp requires an OPT-IN, obtained outside WhatsApp, before a
//     business messages a person, and requires the business to be able to
//     show where that opt-in came from. This app messaged phone numbers that
//     arrived in a bulk master import. Nobody had opted in, and there was no
//     column in which an opt-in could even have been recorded.
//   • WhatsApp requires an OPT-OUT to be honoured. The webhook recorded
//     inbound replies into `whatsapp_inbound` and never read them. A seller
//     who replied "STOP" or "don't message me again" stayed on the birthday
//     list and the dormant-seller list for ever.
//   • Marketing-class outreach (birthday greetings, "you haven't booked in a
//     while") went to hundreds of people who had no live business with the
//     firm. Blocks and reports from those recipients are what Meta's
//     enforcement actually measures.
//
// The 131048 "Spam Rate limit hit" the operator hit on 2026-10-09 was Meta
// saying this out loud a month in advance. It was read as a capacity problem
// and answered with a capacity fix (break the loop, warn before a big run).
// It was a reputation problem.
//
// WHAT THIS MODULE IS
// One function — `gate()` — that answers "may this message go to this person
// right now?", and the consent ledger it answers from. It is enforced
// SERVER-SIDE, inside the send helpers, so no screen, no queue and no future
// caller can route around it: a client that forgets the rules still gets a
// refusal. The client has its own copy of the *explanations* so it can grey a
// row out before a send is spent, but the decision is never the client's.
//
// THE RULES, IN THE ORDER THEY ARE APPLIED
//   1. Sending paused            — the one switch that stops everything,
//                                  including both unattended sweeps. This is
//                                  what to reach for the moment Meta writes.
//   2. Opted out                 — blocks EVERY class, utility included. A
//                                  person who says stop means stop; an
//                                  invoice is not an exemption, and the app
//                                  has other ways to deliver one.
//   3. Marketing needs opt-in    — no recorded opt-in, no marketing message.
//                                  This is the rule whose absence caused the
//                                  ban, and the only one that is a hard
//                                  "no" rather than a throttle.
//   4. Marketing frequency       — at most one marketing message per contact
//                                  per `wa_marketing_gap_days`, counted
//                                  ACROSS campaigns so birthdays and
//                                  reminders cannot stack.
//   5. Per-contact daily ceiling — across all classes, so a bulk run cannot
//                                  send one party six documents in a morning.
//   6. Quality rating            — YELLOW stops marketing, RED stops
//                                  everything but service replies. Meta
//                                  publishes this rating precisely so a
//                                  sender can back off before being banned.
//   7. Known-dead number         — repeated refusals with no success ever.
//                                  Each retry is another spam signal.
//
// Utility messages (an invoice the seller is waiting for, a payment notice)
// are NOT gated on opt-in: the business relationship is the basis, which is
// what Meta's own utility template category is for. They are still gated on
// opt-out, on the daily ceiling and on account health.
//
// MODES
// `wa_compliance_mode` is enforce (default) | warn | off. `warn` returns the
// same verdict with `allow:true` and the reason attached, so an install can
// see what would be refused before switching it on. `off` is for a support
// call, not for running — and the Compliance tab says so.

const { getSetting, getSettingBool, getSettingNum } = require('./company-config');

// ── Message classes ───────────────────────────────────────────────
// Meta's own template categories, and the only distinction that matters to
// the gate. `service` is a free-form reply inside a contact's 24h window —
// they messaged us, so it is solicited by definition.
const CLASS_MARKETING = 'marketing';
const CLASS_UTILITY = 'utility';
const CLASS_SERVICE = 'service';

// msg_type (as written to the send log) → class. Anything unrecognised is
// treated as UTILITY, never as service: an unknown sender must not inherit
// the loosest rules by accident. A genuinely new marketing campaign has to
// name itself here, which is the point — adding one is a decision.
const CLASS_BY_TYPE = new Map([
  ['template-birthday', CLASS_MARKETING],
  ['template-reminder', CLASS_MARKETING],
  ['template-document', CLASS_UTILITY],
  ['template-text', CLASS_UTILITY],
  ['document', CLASS_UTILITY],
  ['text', CLASS_SERVICE],
]);

// ref_type → class, consulted first. The outreach campaigns write their own
// ref_type and a free-text fallback send would otherwise look like a service
// reply (msg_type 'text') and skip the opt-in test — which is exactly the
// hole `birthday_free_text` / `reminder_free_text` opened.
const CLASS_BY_REF = new Map([
  ['birthday', CLASS_MARKETING],
  ['reminder', CLASS_MARKETING],
  ['seller_reminder', CLASS_MARKETING],
]);

// → 'marketing' | 'utility' | 'service'
function classify(msgType, refType) {
  const r = String(refType || '').trim().toLowerCase();
  if (CLASS_BY_REF.has(r)) return CLASS_BY_REF.get(r);
  const t = String(msgType || '').trim().toLowerCase();
  if (CLASS_BY_TYPE.has(t)) return CLASS_BY_TYPE.get(t);
  // A campaign-shaped msg_type nobody registered: 'template-<something>'.
  // Treat it as utility (gated, billable, allowed on the relationship) and
  // let the Compliance tab show it as unclassified.
  return CLASS_UTILITY;
}

// ── Consent ledger key ────────────────────────────────────────────
// The send log stores 91 + ten digits; the masters mostly hold the bare ten;
// an operator typing an opt-out by hand will type whatever they read off a
// phone. All three must land on the same ledger row, so the key is the LAST
// TEN DIGITS — the only part that is the same in every spelling of the
// number. This mirrors the join `problem-numbers` already uses.
function consentKey(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '').slice(-10);
}

// ── Opt-out / opt-in detection ────────────────────────────────────
// WhatsApp does not deliver a structured "unsubscribe" event: a person opts
// out by replying in words, or by tapping a template's Stop button, and the
// obligation to notice is the business's.
//
// TWO TIERS, AND THE REASON FOR THEM
// The first draft of this had one generous pattern list and a comment saying
// a false opt-out only costs one contact who can be put back by hand. That
// is wrong in this business. A seller asking "when does the auction end" or
// "do not send to this number, use my son's" would have been silenced — and
// what they would then stop receiving is their own purchase invoice and
// payment notice, which nobody would notice for weeks.
//
// So:
//   STOP_PATTERNS   — unambiguous. There is no reading of these that is not
//                     a request to stop. Applied automatically, on the spot.
//   REVIEW_PATTERNS — probably a request to stop, but they contain words
//                     that occur in ordinary auction conversation. Surfaced
//                     on Settings → Integrations → Compliance for an
//                     operator to confirm or dismiss. NEVER auto-applied.
//
// Erring either way has a cost, and splitting the list is what lets each
// cost land where it should: a missed opt-out is the breach that disabled
// the account, and a wrongly-applied one cuts a customer off from their own
// documents. The unambiguous half needs no human; the ambiguous half does.
//
// Sellers and buyers on this install write in English, in Tamil, and in
// Tamil typed with Latin letters, so all three are matched throughout.

// Unambiguous. Auto-applied.
const STOP_PATTERNS = [
  // Meta's own recommended keywords. A message that is just one of these is
  // a command, not a sentence.
  /^\s*(stop|stopall|unsubscribe|unsub|optout|opt\s*-?\s*out|cancel)\s*[.!]?\s*$/i,
  // The same words used in a sentence that can only mean one thing.
  /\b(unsubscribe|opt\s*-?\s*out)\b/i,
  /\bstop\b[^.?!]{0,20}\b(message|messages|msg|whatsapp|sms|text|texting|sending|greeting|greetings|reminder|reminders)\b/i,
  /\b(no|not)\s+more\b[^.?!]{0,20}\b(message|messages|msg|whatsapp|sms|text|greeting|greetings|reminder|reminders)\b/i,
  /\b(remove|delete|take)\s+(me|us|my\s+(number|name)|our\s+(number|name))\b/i,
  /\b(do\s*n[o']?t|dont|don't|never)\s+(message|msg|whatsapp|text|contact)\s+(me|us|again|this)\b/i,
  /\b(stop|don'?t)\s+disturb/i,
  // Tamil: வேண்டாம் (don't want), அனுப்ப வேண்டாம் (don't send), நிறுத்து (stop).
  // Each of these is a refusal on its own; none has an innocent reading in a
  // reply to a business message.
  /நிறுத்த|வேண்டாம்|அனுப்பாதீர்|தேவையில்லை/,
  // The same, typed with Latin letters on a phone keyboard.
  /\b(vendaa?m|venda?am|niruthu|niruththu|anupp?a?athe|thevaiyillai)\b/i,
];

// Probably an opt-out, but these words appear in ordinary trade
// conversation. Shown to an operator; never applied on their own.
const REVIEW_PATTERNS = [
  // "not interested" is almost always an opt-out — but it is also how a
  // seller declines ONE auction.
  /\bnot\s+interested\b/i,
  /\bwrong\s+number\b/i,
  // "don't send", with no object. Could be "don't send messages"; could
  // equally be "don't send the lorry yet".
  /\b(do\s*n[o']?t|dont|don't)\s+(send|message|msg|text)\b/i,
  // Bare "cancel" / "quit" / "end" / "block" inside a sentence. "When does
  // the auction end", "cancel lot 42" and "block 5 lots" are all real
  // messages this business receives.
  /\b(quit|cancel|end|block)\b/i,
  /\btonthara|தொந்தரவு/i,
];

// Opt-IN must be at least as strict as opt-out, and for a sharper reason: a
// wrongly-recorded opt-in is a licence to send marketing to somebody who
// never agreed, which is the exact thing the account was disabled for. A
// bare "yes" or "ok" is therefore NOT an opt-in — it is an answer to
// whatever was asked, and we do not know what that was.
const START_PATTERNS = [
  /^\s*(start|subscribe|resubscribe|optin|opt\s*-?\s*in)\s*[.!]?\s*$/i,
  /\b(subscribe|opt\s*-?\s*in)\b/i,
  /\b(yes|ok|okay|please)\b[^.?!]{0,15}\b(send|message|whatsapp|update|updates|inform)\b/i,
  /\b(send|message)\s+me\b[^.?!]{0,20}\b(update|updates|detail|details|auction|message|messages|info|information)\b/i,
  /அனுப்பு(ங்கள்)?|வேண்டும்/,
];

// → 'stop' | 'start' | 'review' | null for a free-text inbound reply.
//
// Only SHORT messages are read as commands. "STOP" is a command; a paragraph
// that happens to contain the word "cancel" ("can I cancel lot 42 and move
// the rest to next week?") is a business conversation, and reading it as an
// opt-out would cut a customer off from their own invoices.
const INTENT_MAX_WORDS = 12;
function detectIntent(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  if (s.split(/\s+/).length > INTENT_MAX_WORDS) return null;
  for (const re of STOP_PATTERNS) if (re.test(s)) return 'stop';
  for (const re of START_PATTERNS) if (re.test(s)) return 'start';
  for (const re of REVIEW_PATTERNS) if (re.test(s)) return 'review';
  return null;
}

// A template's own Stop/Unsubscribe quick-reply button. Meta requires one on
// marketing templates, and a tap arrives as a button payload or title rather
// than as text — so it bypasses detectIntent's word limit entirely. A tap is
// never ambiguous: there is only one thing that button does.
function buttonIsOptOut(payload, title) {
  const s = (String(payload || '') + ' ' + String(title || '')).trim();
  if (!s) return false;
  return /\b(stop|stopall|unsubscribe|opt\s*-?\s*out|no\s+more)\b/i.test(s)
    || /நிறுத்த|வேண்டாம்/.test(s);
}

// ── Settings ──────────────────────────────────────────────────────
function config(db) {
  const num = (k, dflt) => {
    const v = getSettingNum(db, k);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const mode = String(getSetting(db, 'wa_compliance_mode') || 'enforce').trim().toLowerCase();
  return {
    // Unknown values resolve to 'enforce'. A typo in this box must not turn
    // the protection off.
    mode: (mode === 'warn' || mode === 'off') ? mode : 'enforce',
    paused: getSettingBool(db, 'wa_sending_paused'),
    marketingGapDays: num('wa_marketing_gap_days', 30),
    maxPerContactDay: num('wa_max_per_contact_day', 3),
    // Treat every party already on the masters as having opted in. OFF, and
    // it must stay off: that switch is precisely the assumption Meta
    // disabled the account over. It exists only because an install that has
    // genuinely collected written consent (a signed registration form) needs
    // a way to say so — and the Compliance tab makes it say when and on what
    // basis, which is what Meta asks a business to be able to produce.
    legacyOptIn: getSettingBool(db, 'wa_assume_legacy_optin'),
    legacyBasis: String(getSetting(db, 'wa_legacy_optin_basis') || '').trim(),
    // Quality-rating gates. Both on by default: this rating is Meta's own
    // early warning, and the whole lesson of the ban is that ignoring it
    // costs the account.
    stopMarketingOnYellow: getSettingBool(db, 'wa_stop_marketing_on_yellow'),
    stopAllOnRed: getSettingBool(db, 'wa_stop_all_on_red'),
    deadNumberFails: num('wa_dead_number_fails', 3),
  };
}

// Defaults live in company-config DEFAULTS; these two are the booleans whose
// stored default is `true`, so a database predating them (getSettingBool
// returns false for a missing key) must not silently lose the guard.
// `initCompanySettings` inserts them, so this is belt-and-braces for a row
// an operator deleted by hand.
function configWithFallbacks(db) {
  const c = config(db);
  if (getSetting(db, 'wa_stop_marketing_on_yellow') === null) c.stopMarketingOnYellow = true;
  if (getSetting(db, 'wa_stop_all_on_red') === null) c.stopAllOnRed = true;
  return c;
}

// ── Consent reads and writes ──────────────────────────────────────
// Statuses: 'in' (opted in), 'out' (opted out). The ABSENCE of a row is the
// third state and is never stored as one — "we have never asked" is not a
// decision anyone made, and writing it as a row would make an untouched
// master look audited.
function readConsent(db, phone) {
  const k = consentKey(phone);
  if (!k) return null;
  try {
    return db.get('SELECT * FROM wa_consent WHERE phone_key = ?', [k]) || null;
  } catch (_) { return null; }
}

// The WHOLE ledger as a Map, phone_key → 'in' | 'out'. The two outreach
// worklists have to mark every candidate (hundreds of them) as sendable or
// held, and asking readConsent per row is the per-row-query mistake this
// codebase has made before. The table holds one row per DECIDED contact, so
// it stays small even on an install with thousands of parties.
function consentMap(db) {
  const m = new Map();
  try {
    for (const r of db.all('SELECT phone_key, status, scope FROM wa_consent') || []) {
      if (r && r.phone_key) {
        m.set(String(r.phone_key), { status: String(r.status || ''), scope: String(r.scope || 'all') });
      }
    }
  } catch (_) {}
  return m;
}

// May a MARKETING message go to this number, as far as consent alone is
// concerned? The worklists use this to label a row; the gate is still the
// authority at send time (it also weighs frequency, caps and health).
//
// → '' when it may, or the sentence explaining why not.
function marketingConsentHold(phone, consentMapOrNull, cfg) {
  const k = consentKey(phone);
  if (!k) return 'no phone number';
  const rec = consentMapOrNull ? consentMapOrNull.get(k) : null;
  // Both opt-out scopes hold a MARKETING message; only the wording differs,
  // and it differs for a reason — "opted out" and "asked us to stop the
  // greetings" are different conversations to have with that seller.
  if (rec && rec.status === 'out') {
    return rec.scope === 'marketing'
      ? 'asked us to stop greetings and reminders'
      : 'asked us to stop — opted out';
  }
  if (rec && rec.status === 'in') return '';
  if (cfg && cfg.legacyOptIn) return '';
  return 'no WhatsApp opt-in on record';
}

// Upsert one consent decision. `source` says HOW it was captured
// ('reply' = the contact messaged us, 'operator' = typed in from a phone
// call or a form, 'button' = a template Stop tap, 'meta' = Meta told us the
// user had stopped our messages, 'import' = a bulk legacy capture) and
// `basis` is the evidence an auditor would be shown. Both are kept because
// "we have consent" is not a claim Meta accepts without them.
function setConsent(db, { phone, status, scope, source, basis, note, by, partyType, partyId }) {
  const k = consentKey(phone);
  if (!k) return { ok: false, error: 'no usable phone number' };
  const st = status === 'in' ? 'in' : status === 'out' ? 'out' : '';
  if (!st) return { ok: false, error: 'status must be "in" or "out"' };
  // Anything unrecognised resolves to 'all' — the stricter reading, which is
  // the one to fall back on. An opt-IN has no scope to speak of.
  const sc = (st === 'out' && String(scope || '') === 'marketing') ? 'marketing' : 'all';
  try {
    db.run(
      `INSERT INTO wa_consent (phone_key, phone, status, scope, source, basis, note, updated_by, party_type, party_id,
                               opted_in_at, opted_out_at, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,
                    CASE WHEN ? = 'in'  THEN datetime('now','localtime') ELSE NULL END,
                    CASE WHEN ? = 'out' THEN datetime('now','localtime') ELSE NULL END,
                    datetime('now','localtime'), datetime('now','localtime'))
       ON CONFLICT(phone_key) DO UPDATE SET
            phone = excluded.phone,
            status = excluded.status,
            scope = excluded.scope,
            source = excluded.source,
            basis = excluded.basis,
            note = excluded.note,
            updated_by = excluded.updated_by,
            party_type = COALESCE(NULLIF(excluded.party_type,''), wa_consent.party_type),
            party_id = COALESCE(excluded.party_id, wa_consent.party_id),
            -- Keep the FIRST opt-in date and the LATEST opt-out date. An
            -- auditor asks "since when did you have permission" and "when
            -- did you stop"; overwriting either loses the answer.
            opted_in_at  = CASE WHEN excluded.status = 'in'
                                THEN COALESCE(wa_consent.opted_in_at, datetime('now','localtime'))
                                ELSE wa_consent.opted_in_at END,
            opted_out_at = CASE WHEN excluded.status = 'out'
                                THEN datetime('now','localtime')
                                ELSE wa_consent.opted_out_at END,
            updated_at = datetime('now','localtime')`,
      [k, String(phone || ''), st, sc, String(source || 'operator'), String(basis || ''),
       String(note || ''), String(by || ''), String(partyType || ''),
       partyId == null ? null : Number(partyId) || null, st, st]
    );
    return { ok: true, phoneKey: k, status: st, scope: sc };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Apply an inbound reply to the ledger. Called from the webhook for every
// inbound message, so an opt-out takes effect on the next send without
// anyone reading a log.
//
// Returns { intent, applied } — `applied` false means the words were a stop
// but the number was already out (or the text was ordinary conversation).
function recordInbound(db, phone, text, meta = {}) {
  const intent = buttonIsOptOut(meta.buttonPayload, meta.buttonTitle)
    ? 'stop'
    : detectIntent(text);
  if (!intent) return { intent: null, applied: false };
  // The ambiguous tier is reported, never applied. It reaches an operator
  // through coverage().needsReview, which reads the same inbound archive
  // this message has already been written to.
  if (intent === 'review') return { intent, applied: false };
  const existing = readConsent(db, phone);
  const want = intent === 'stop' ? 'out' : 'in';
  if (existing && existing.status === want) return { intent, applied: false };
  const r = setConsent(db, {
    phone,
    status: want,
    source: meta.buttonPayload || meta.buttonTitle ? 'button' : 'reply',
    basis: intent === 'stop'
      ? 'Contact asked us to stop, in their own reply on WhatsApp'
      : 'Contact asked us to message them, in their own reply on WhatsApp',
    note: String(text || '').slice(0, 200),
    partyType: existing && existing.party_type,
    partyId: existing && existing.party_id,
  });
  return { intent, applied: !!r.ok, error: r.error };
}

// Meta sometimes tells us directly that a user has stopped our messages
// (131050, and the "user preference" family). That is an opt-out expressed
// to Meta rather than to us, and it binds just the same — continuing to
// template that number is the clearest possible policy breach.
const META_STOP_RE = /131050|user\s+(has\s+)?(stopped|opted)|not\s+opted\s+in|user\s+preference|marketing\s+messages?\s+(are\s+)?(blocked|stopped)/i;
function noteMetaError(db, phone, error) {
  if (!META_STOP_RE.test(String(error || ''))) return { applied: false };
  const existing = readConsent(db, phone);
  if (existing && existing.status === 'out') return { applied: false };
  const r = setConsent(db, {
    phone, status: 'out', source: 'meta',
    basis: 'Meta refused the message because the contact has stopped messages from this business',
    note: String(error || '').slice(0, 200),
    partyType: existing && existing.party_type,
    partyId: existing && existing.party_id,
  });
  return { applied: !!r.ok };
}

// ── Counters the gate needs ───────────────────────────────────────
// All three read `whatsapp_messages`, which is the only record of what
// actually left. Rows that never reached Meta (not_attempted / not_sent /
// blocked) are excluded everywhere: a message we refused to send is not a
// message this contact received, and counting it would make the gate
// progressively stricter every time it fired.
//
// Every one filters on the PERSISTED `phone_key` column (last ten digits,
// written by _waLog) rather than computing it in the WHERE clause. These run
// three times per send, so a computed key turned a 250-row bulk run into 750
// full scans of the send log.
const DELIVERED_SQL = "('sent','delivered','read')";

function daysSinceLastMarketing(db, phone) {
  const k = consentKey(phone);
  if (!k) return null;
  try {
    const row = db.get(
      `SELECT MAX(created_at) AS at FROM whatsapp_messages
        WHERE direction = 'out'
          AND phone_key = ?
          AND status IN ${DELIVERED_SQL}
          AND (msg_type IN ('template-birthday','template-reminder') OR ref_type IN ('birthday','reminder','seller_reminder'))`,
      [k]);
    if (!row || !row.at) return null;
    const d = db.get("SELECT CAST(julianday('now','localtime') - julianday(?) AS INTEGER) AS d", [row.at]);
    return d && d.d != null ? Number(d.d) : null;
  } catch (_) { return null; }
}

function sentToContactToday(db, phone) {
  const k = consentKey(phone);
  if (!k) return 0;
  try {
    const row = db.get(
      `SELECT COUNT(*) AS n FROM whatsapp_messages
        WHERE direction = 'out'
          AND phone_key = ?
          AND status IN ${DELIVERED_SQL}
          AND created_at >= datetime('now','localtime','-24 hours')`,
      [k]);
    return (row && Number(row.n)) || 0;
  } catch (_) { return 0; }
}

// Has this number ever worked, and how often has Meta refused it lately?
// A number that has succeeded even once is never called dead — a shared
// line, a phone off, a temporary refusal all look the same otherwise.
function deadNumberFails(db, phone) {
  const k = consentKey(phone);
  if (!k) return 0;
  try {
    const row = db.get(
      `SELECT
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS fails,
         SUM(CASE WHEN status IN ${DELIVERED_SQL} THEN 1 ELSE 0 END) AS ok
       FROM whatsapp_messages
        WHERE direction = 'out'
          AND phone_key = ?
          AND created_at >= datetime('now','localtime','-90 days')`,
      [k]);
    if (!row) return 0;
    if ((Number(row.ok) || 0) > 0) return 0;
    return Number(row.fails) || 0;
  } catch (_) { return 0; }
}

// ── Account health ────────────────────────────────────────────────
// Meta's quality rating for the sending number, cached by the caller (it
// costs a Graph round-trip). The gate takes it as an input rather than
// fetching it, so a Meta outage can never block the day's invoices: an
// unknown rating is treated as GREEN.
function healthFromRating(rating) {
  const r = String(rating || '').trim().toUpperCase();
  if (r.includes('RED')) return 'red';
  if (r.includes('YELLOW')) return 'yellow';
  if (r.includes('GREEN')) return 'green';
  return 'unknown';
}

// ── THE GATE ──────────────────────────────────────────────────────
// → { allow, code, reason, cls, mode, advisory }
//
// `code` is a stable token for the client and the tests; `reason` is the
// sentence an operator reads. `advisory` is true when the mode is 'warn' and
// the message is going out despite a verdict against it — the caller logs
// that, so "what would enforcement have stopped?" has an answer before
// anyone flips the switch.
function gate(db, opts = {}) {
  const phone = opts.phone;
  const cfg = opts.config || configWithFallbacks(db);
  const cls = opts.cls || classify(opts.msgType, opts.refType);
  const health = opts.health || 'unknown';
  const allow = (code, reason) => ({ allow: true, code: code || 'ok', reason: reason || '', cls, mode: cfg.mode, advisory: false });
  const deny = (code, reason) => {
    if (cfg.mode === 'off') return { allow: true, code: 'compliance_off', reason: '', cls, mode: cfg.mode, advisory: false };
    if (cfg.mode === 'warn') return { allow: true, code, reason, cls, mode: cfg.mode, advisory: true };
    return { allow: false, code, reason, cls, mode: cfg.mode, advisory: false };
  };

  // 1. The master pause. Deliberately ahead of the mode check below —
  // "stop sending" has to mean stop even on an install running in warn.
  if (cfg.paused) {
    return {
      allow: false, cls, mode: cfg.mode, advisory: false, code: 'paused',
      reason: 'WhatsApp sending is paused for this install (Settings → WhatsApp Compliance). Nothing goes out until it is resumed.',
    };
  }
  if (cfg.mode === 'off') return allow('compliance_off');

  if (!consentKey(phone)) return allow('no_phone');  // the send helpers reject this on their own terms

  const consent = readConsent(db, phone);

  // 2. Opted out. A bare "STOP" means everything, which is Meta's own
  // convention and the stricter reading — so that is the default, and it
  // stops an invoice too. The narrower scope exists for the person who
  // actually said "stop the birthday messages, keep sending my bills":
  // answering that request by cutting them off from their own documents
  // would be honouring it badly. Only an operator can record the narrow
  // scope; no reader of words is confident enough to infer it.
  if (consent && consent.status === 'out') {
    const when = consent.opted_out_at ? ' (' + consent.opted_out_at + ')' : '';
    if (consent.scope === 'marketing') {
      if (cls === CLASS_MARKETING) {
        return deny('opted_out_marketing',
          `This contact has asked not to receive greetings or reminders${when}. Invoices and notices still reach them.`);
      }
    } else {
      return deny('opted_out',
        `This contact has asked not to receive WhatsApp messages${when}. `
        + 'Honouring that is a WhatsApp Business requirement, so the message was not sent — send the document by another route if it is needed.');
    }
  }

  // 3. Marketing needs a recorded opt-in. THE rule the ban was about.
  if (cls === CLASS_MARKETING) {
    const optedIn = (consent && consent.status === 'in') || cfg.legacyOptIn;
    if (!optedIn) {
      return deny('no_optin',
        'No WhatsApp opt-in is on record for this contact, so a greeting or reminder cannot be sent to them. '
        + 'WhatsApp requires an opt-in collected outside WhatsApp before a business sends marketing. '
        + 'Record it in Settings → WhatsApp Compliance once they have agreed.');
    }
    // 4. Frequency, across every campaign.
    const since = daysSinceLastMarketing(db, phone);
    if (since != null && since < cfg.marketingGapDays) {
      return deny('too_soon',
        `This contact already had a greeting or reminder ${since} day${since === 1 ? '' : 's'} ago. `
        + `The app allows one marketing message per contact every ${cfg.marketingGapDays} days — repeated outreach is what produces blocks, and blocks are what Meta counts.`);
    }
  }

  // 5. Per-contact daily ceiling, across all classes.
  if (cls !== CLASS_SERVICE) {
    const today = sentToContactToday(db, phone);
    if (today >= cfg.maxPerContactDay) {
      return deny('contact_cap',
        `This contact has already had ${today} WhatsApp message${today === 1 ? '' : 's'} from us in the last 24 hours, which is the per-contact limit. `
        + 'Several messages to one person in a day is the pattern recipients report as spam.');
    }
  }

  // 6. Account health. Service replies are never blocked — answering someone
  // who messaged us is the one thing that IMPROVES a quality rating.
  if (cls !== CLASS_SERVICE) {
    if (health === 'red' && cfg.stopAllOnRed) {
      return deny('quality_red',
        'Meta currently rates this number RED (low quality). Sending more while the rating is red is how a number goes from throttled to disabled — '
        + 'only replies to people who messaged us are allowed until it recovers.');
    }
    if (cls === CLASS_MARKETING && (health === 'yellow' || health === 'red') && cfg.stopMarketingOnYellow) {
      return deny('quality_yellow',
        `Meta currently rates this number ${health.toUpperCase()}. Greetings and reminders are paused while the rating is below green; invoices and notices still go out.`);
    }
  }

  // 7. A number Meta has refused repeatedly and never once delivered to.
  const fails = deadNumberFails(db, phone);
  if (fails >= cfg.deadNumberFails) {
    return deny('dead_number',
      `Meta has refused ${fails} messages to this number in the last 90 days and never delivered one. `
      + 'The number is almost certainly wrong on the master — fix it there; each further attempt counts against this sender.');
  }

  return allow();
}

// The inbound archive stores the WHOLE raw webhook message as JSON (it was
// built as a diagnostic for button taps). Pull the words a person actually
// typed back out of it; a plain string is passed through, for the rows the
// shape of which predates that.
function inboundText(body) {
  const raw = String(body == null ? '' : body);
  if (!raw.startsWith('{')) return raw;
  try {
    const j = JSON.parse(raw);
    return (j.text && j.text.body)
      || (j.button && j.button.text)
      || (j.interactive && j.interactive.button_reply && j.interactive.button_reply.title)
      || '';
  } catch (_) { return ''; }
}

// ── Coverage, for the Compliance tab ──────────────────────────────
// Answers the two questions an operator has after a ban: how exposed are we,
// and what is the gate actually doing? Counts are over the masters (who
// could be messaged) and the ledger (who has said something).
function coverage(db) {
  const one = (sql, args) => {
    try { return (args ? db.get(sql, args) : db.get(sql)) || {}; }
    catch (e) { return {}; }
  };
  const n = (v) => Number(v) || 0;
  const CLEAN = (col) => `substr(replace(replace(replace(replace(replace(IFNULL(${col},''),' ',''),'-',''),'+',''),'(',''),')',''), -10)`;

  const consent = one(`SELECT
      SUM(CASE WHEN status = 'in'  THEN 1 ELSE 0 END) AS opted_in,
      SUM(CASE WHEN status = 'out' THEN 1 ELSE 0 END) AS opted_out,
      -- Split out, because the two mean different things to the business: a
      -- total opt-out means their invoice has to go by another route, while
      -- a marketing-only one costs nothing but a greeting.
      SUM(CASE WHEN status = 'out' AND scope = 'marketing' THEN 1 ELSE 0 END) AS opted_out_marketing,
      COUNT(*) AS total FROM wa_consent`);

  // Contactable parties: a seller or buyer with a usable number. This is the
  // denominator for "how much of the master may we actually message?".
  const sellers = one(`SELECT COUNT(*) AS n FROM traders WHERE length(${CLEAN('COALESCE(NULLIF(whatsapp,\'\'), tel)')}) = 10`);
  const buyers = one(`SELECT COUNT(*) AS n FROM buyers WHERE length(${CLEAN('tel')}) = 10`);

  // What the gate DECIDED over the last 30 days, by rule. Read from
  // wa_policy_log rather than from the send log's `blocked` rows, because
  // that is the only place a `warn`-mode verdict is recorded — and on an
  // install still in warn mode, those are the whole point of the panel:
  // they are the sends enforcement would have stopped.
  let blocks = [];
  try {
    blocks = db.all(
      `SELECT code, mode, cls, COUNT(*) AS n FROM wa_policy_log
        WHERE created_at >= datetime('now','localtime','-30 days')
        GROUP BY code, mode, cls ORDER BY n DESC LIMIT 30`) || [];
  } catch (_) { blocks = []; }

  // The inbound archive, re-read through the intent reader. Two numbers come
  // out of it and they mean different things:
  //
  //   unheardOptOuts — somebody said stop in so many words and is still
  //                    being messaged. This is the backlog from before the
  //                    reader existed: these replies were written to
  //                    whatsapp_inbound and read by nobody, which is the
  //                    behaviour the account was disabled over. One button
  //                    on the Compliance tab clears it.
  //   needsReview    — the ambiguous tier. A person has to decide, so these
  //                    are listed rather than counted away.
  let unheard = 0;
  const review = [];
  try {
    const rows = db.all(
      `SELECT phone, body, received_at FROM whatsapp_inbound ORDER BY id DESC LIMIT 2000`) || [];
    const seen = new Set();
    for (const r of rows) {
      const k = consentKey(r.phone);
      if (!k || seen.has(k)) continue;
      const text = inboundText(r.body);
      const intent = detectIntent(text);
      if (intent !== 'stop' && intent !== 'review') continue;
      seen.add(k);
      const c = readConsent(db, r.phone);
      // Already decided, either way. An operator who dismissed an ambiguous
      // reply recorded an opt-IN for that contact, and it must not come
      // back onto the worklist the next time the page is opened.
      if (c) continue;
      if (intent === 'stop') unheard++;
      else review.push({ phone: r.phone, text: String(text).slice(0, 160), at: r.received_at || '' });
    }
  } catch (_) {}

  const contactable = n(sellers.n) + n(buyers.n);
  return {
    contactable,
    sellersWithPhone: n(sellers.n),
    buyersWithPhone: n(buyers.n),
    optedIn: n(consent.opted_in),
    optedOut: n(consent.opted_out),
    optedOutMarketingOnly: n(consent.opted_out_marketing),
    recorded: n(consent.total),
    // Everyone we could message and have never asked. On a fresh install
    // this is the whole master, and that number is the honest picture of
    // what the old behaviour was doing.
    unknown: Math.max(0, contactable - n(consent.total)),
    blocks: blocks.map(b => ({ code: String(b.code || ''), mode: String(b.mode || ''), cls: String(b.cls || ''), n: n(b.n) })),
    unheardOptOuts: unheard,
    needsReview: review.slice(0, 50),
    needsReviewCount: review.length,
  };
}

// Sweep the inbound archive and apply every stop reply that predates this
// module (or that arrived while the webhook was unsubscribed). Idempotent:
// a number already out is left alone, so running it twice is free.
//
// ONLY the unambiguous tier. The ambiguous one is a worklist for a person,
// and silently applying months of it in one click is how an operator
// discovers in February that forty sellers stopped getting their invoices in
// November.
function applyHistoricOptOuts(db, { by } = {}) {
  let rows = [];
  try {
    rows = db.all('SELECT phone, body, received_at FROM whatsapp_inbound ORDER BY id ASC') || [];
  } catch (_) { return { scanned: 0, applied: 0 }; }
  let applied = 0;
  const done = new Set();
  for (const r of rows) {
    const k = consentKey(r.phone);
    if (!k || done.has(k)) continue;
    const text = inboundText(r.body);
    if (detectIntent(text) !== 'stop') continue;
    done.add(k);
    const c = readConsent(db, r.phone);
    if (c && c.status === 'out') continue;
    const res = setConsent(db, {
      phone: r.phone, status: 'out', source: 'reply',
      basis: `Contact asked us to stop, in their own reply on WhatsApp${r.received_at ? ' on ' + r.received_at : ''}`,
      note: String(text).slice(0, 200), by: by || '',
      partyType: c && c.party_type, partyId: c && c.party_id,
    });
    if (res.ok) applied++;
  }
  return { scanned: rows.length, applied };
}

module.exports = {
  CLASS_MARKETING, CLASS_UTILITY, CLASS_SERVICE,
  classify, consentKey, detectIntent, buttonIsOptOut,
  config, configWithFallbacks,
  readConsent, setConsent, recordInbound, noteMetaError,
  consentMap, marketingConsentHold,
  daysSinceLastMarketing, sentToContactToday, deadNumberFails,
  healthFromRating, gate, coverage, applyHistoricOptOuts,
  inboundText, STOP_PATTERNS, START_PATTERNS, REVIEW_PATTERNS,
};
