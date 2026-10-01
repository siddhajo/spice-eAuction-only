// ── seller-reminders.js ────────────────────────────────────────────
// "You haven't booked with us in a while" reminders for sellers, over
// WhatsApp. Sibling of birthday-greetings.js and deliberately NOT merged
// with it: the two are the same SHAPE (a worklist of parties to message,
// with a guard against messaging the same person twice) but a different
// trigger, a different audience and a different cadence.
//
// Business rule (configured in Settings → Seller Reminders):
//   • A seller is DUE when their last booked lot is between
//     `reminder_after_days` and `reminder_until_days` old, and they have
//     booked at least `reminder_min_auctions` auctions in total.
//   • Anyone reminded within `reminder_cooldown_days` is held back.
//   • Auto-send is OFF by default; with it off this is purely a worklist.
//
// WHY THERE ARE FOUR NUMBERS AND NOT JUST ONE
// Measured against the live master on 2026-09-30 (4,765 sellers, 4,751
// lots, 18 auctions since April — roughly one every 10 days):
//
//   sellers in the master ........................ 4,765
//   ever booked a lot .............................. 1,682
//   NEVER booked ................................... 3,085   ← 65%
//   last booked 60+ days ago ......................... 836
//     ...of whom booked exactly once, ever ........... 632
//     ...booked 2-3 auctions ......................... 182
//     ...booked 4+ auctions (the real regulars) ........ 22
//
// So "remind everyone who hasn't booked in 60 days" is 836 messages
// (~4 days of the 250-recipient/24h WhatsApp ceiling, at the MARKETING
// rate) to reach the 22 people the reminder is actually for. Hence:
//
//   • `reminder_min_auctions` (default 2) — the single most effective
//     knob. A seller who came once and never returned is not a lapsed
//     regular, and 632 of the 836 are exactly that.
//   • never-booked sellers are EXCLUDED unless explicitly asked for. All
//     3,085 of them carry a created_at inside the last 60 days because
//     they arrived in one bulk master import, so "registered N days ago
//     and never booked" would flag the entire tail on the same morning.
//   • `reminder_until_days` (default 180) — past that they have not
//     lapsed, they have left; a message is cold outreach, not a nudge.
//   • `reminder_max_per_day` — the blast guard, as for birthdays.
//
// A seller who has ALREADY booked into a future auction is excluded for
// free: their last booking date is ahead of today, so "days since" is
// negative and falls outside the window. That is the behaviour to
// preserve if this query is ever rewritten.

const { getSetting, getSettingBool, getSettingNum } = require('./company-config');

// Local yyyy-mm-dd. Never toISOString — east of UTC that returns
// yesterday for most of the morning, which would shift every threshold.
function ymd(dt) {
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function parseYmd(s) {
  const mt = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!mt) return null;
  return new Date(+mt[1], +mt[2] - 1, +mt[3]);
}
function daysBetween(fromYmd, toYmd) {
  const a = parseYmd(fromYmd), b = parseYmd(toYmd);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

function config(db) {
  const num = (k, dflt) => {
    const v = getSettingNum(db, k);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    enabled:       getSettingBool(db, 'flag_seller_reminders'),
    afterDays:     num('reminder_after_days', 60),
    untilDays:     num('reminder_until_days', 180),
    minAuctions:   Math.max(1, getSettingNum(db, 'reminder_min_auctions') || 1),
    cooldownDays:  num('reminder_cooldown_days', 45),
    includeNever:  getSettingBool(db, 'reminder_include_never_booked'),
    auto:          getSettingBool(db, 'reminder_auto_send'),
    hour:          Math.max(0, Math.min(23, getSettingNum(db, 'reminder_send_hour'))),
    maxPerDay:     num('reminder_max_per_day', 50),
    template:      String(getSetting(db, 'reminder_tpl') || '').trim(),
    lang:          String(getSetting(db, 'reminder_tpl_lang') || 'en').trim() || 'en',
    freeText:      getSettingBool(db, 'reminder_free_text'),
  };
}

// The next auction the seller could actually come to. Blank when none is
// scheduled yet — the wording has to survive that, because between two
// seasons there often isn't one.
function nextAuction(db, todayStr) {
  try {
    return db.get(`SELECT ano, date FROM auctions WHERE date >= ? ORDER BY date, CAST(ano AS INTEGER) LIMIT 1`,
      [todayStr]) || null;
  } catch (_) { return null; }
}

// Every seller who has ever booked, with their booking history rolled up.
//
// `reserved = 1` lots are excluded throughout: a reserved lot is a HELD
// placeholder that keeps a lot number away from other sellers, not a
// booking (see the column's note in db.js). Counting one would mark a
// seller active who never actually brought anything.
//
// Future auctions are deliberately NOT filtered out — a seller already
// booked into next week's trade must come out with a negative "days
// since" and drop out of the window, rather than being reminded.
function bookingHistory(db) {
  try {
    return db.all(
      `SELECT t.id                          AS trader_id,
              t.name, t.cr, t.tel, t.whatsapp,
              MAX(a.date)                   AS last_booked,
              COUNT(DISTINCT l.auction_id)  AS auctions_booked,
              COUNT(l.id)                   AS lots_booked,
              COALESCE(SUM(l.qty), 0)       AS kg_booked
         FROM traders t
         JOIN lots l     ON l.trader_id = t.id AND COALESCE(l.reserved, 0) = 0
         JOIN auctions a ON a.id = l.auction_id
        WHERE a.date IS NOT NULL AND TRIM(a.date) <> ''
        GROUP BY t.id`) || [];
  } catch (_) { return []; }
}

// Sellers with no booking at all. Off by default — see the header.
function neverBooked(db) {
  try {
    return db.all(
      `SELECT t.id AS trader_id, t.name, t.cr, t.tel, t.whatsapp, t.created_at
         FROM traders t
        WHERE NOT EXISTS (SELECT 1 FROM lots l
                           WHERE l.trader_id = t.id AND COALESCE(l.reserved, 0) = 0)`) || [];
  } catch (_) { return []; }
}

function _row(r, extra) {
  return Object.assign({
    trader_id: r.trader_id,
    name: r.name || '',
    label: [r.cr, r.name].filter(Boolean).join(' ').trim() || r.name || '',
    phone: String(r.whatsapp || '').trim() || String(r.tel || '').trim(),
    last_booked: r.last_booked || '',
    auctions_booked: Number(r.auctions_booked) || 0,
    lots_booked: Number(r.lots_booked) || 0,
    kg_booked: Number(r.kg_booked) || 0,
  }, extra);
}

// ── THE COOLDOWN LEDGER ────────────────────────────────────────────
// Unlike a birthday (once per year, enforced by a unique index) a
// reminder recurs, so the guard is a WINDOW: when did we last actually
// reach this seller? Only a SENT row counts — a failed attempt must not
// buy the seller 45 days of silence.
function lastRemindedMap(db) {
  const map = new Map();
  try {
    const rows = db.all(
      `SELECT trader_id, MAX(substr(created_at, 1, 10)) AS last_sent
         FROM seller_reminders WHERE status = 'sent' GROUP BY trader_id`) || [];
    for (const r of rows) map.set(Number(r.trader_id), r.last_sent || '');
  } catch (_) { /* table may not exist on a very old DB */ }
  return map;
}
function lastRemindedFor(db, traderId) {
  try {
    const r = db.get(
      `SELECT MAX(substr(created_at, 1, 10)) AS last_sent
         FROM seller_reminders WHERE trader_id = ? AND status = 'sent'`, [traderId]);
    return (r && r.last_sent) || '';
  } catch (_) { return ''; }
}
function _log(db, f) {
  try {
    db.run(
      `INSERT INTO seller_reminders
         (trader_id, name, phone, last_booked, days_since, mode, sent_by, status, wamid, error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [f.trader_id, f.name || '', f.phone || '', f.last_booked || '',
       f.days_since == null ? null : f.days_since,
       f.mode || 'manual', f.sent_by || '', f.status || 'failed', f.wamid || '', f.error || '']);
    return true;
  } catch (_) { return false; }
}

// ── WHO IS DUE ─────────────────────────────────────────────────────
// Returns { due, held, counts } in ONE pass, because the screen has to
// explain itself: "836 sellers have not booked in 60 days, but 632 of
// them only ever came once" is the number that stops a bad campaign, and
// it can only be shown if the rejected rows are counted as they are
// rejected.
function review(db, opts = {}) {
  const cfg = opts.cfg || config(db);
  const today = opts.date && parseYmd(opts.date) ? String(opts.date) : ymd(new Date());
  const seen = lastRemindedMap(db);
  const due = [], held = [];
  const counts = {
    sellers_total: 0, ever_booked: 0, never_booked: 0,
    in_window: 0, too_recent: 0, too_long_ago: 0,
    below_min_auctions: 0, no_phone: 0, in_cooldown: 0, due: 0,
  };
  try {
    counts.sellers_total = (db.get('SELECT COUNT(*) n FROM traders') || {}).n || 0;
  } catch (_) {}

  const consider = (r, daysSince, neverBookedFlag) => {
    const row = _row(r, {
      days_since: daysSince,
      never_booked: !!neverBookedFlag,
      last_reminded: seen.get(Number(r.trader_id)) || '',
    });
    row.reminded_days_ago = row.last_reminded ? daysBetween(row.last_reminded, today) : null;
    if (!row.phone) { counts.no_phone++; row.hold = 'no phone number'; held.push(row); return; }
    if (row.reminded_days_ago != null && row.reminded_days_ago < cfg.cooldownDays) {
      counts.in_cooldown++;
      row.hold = `reminded ${row.reminded_days_ago} day${row.reminded_days_ago === 1 ? '' : 's'} ago — cooling off for ${cfg.cooldownDays}`;
      held.push(row); return;
    }
    counts.due++;
    due.push(row);
  };

  for (const r of bookingHistory(db)) {
    counts.ever_booked++;
    const d = daysBetween(r.last_booked, today);
    // Negative = they are already booked into a future auction.
    if (d == null || d < cfg.afterDays) { counts.too_recent++; continue; }
    if (d > cfg.untilDays) { counts.too_long_ago++; continue; }
    counts.in_window++;
    if ((Number(r.auctions_booked) || 0) < cfg.minAuctions) { counts.below_min_auctions++; continue; }
    consider(r, d, false);
  }

  const never = neverBooked(db);
  counts.never_booked = never.length;
  if (cfg.includeNever) {
    for (const r of never) consider(r, null, true);
  }

  // Longest first: the person who has been away 170 days is the one worth
  // a message before the one at 61.
  const rank = (x) => (x.days_since == null ? Number.MAX_SAFE_INTEGER : -x.days_since);
  due.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  held.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  return { date: today, due, held, counts };
}

// ── MESSAGE ────────────────────────────────────────────────────────
// Tokens: {name} {first_name} {company} {last_booked} {days}
//         {next_auction} {next_auction_no}
function composeMessage(db, row, ctx = {}) {
  // NOTE the shape of the default: {next_auction} sits after "for", never
  // after "on". Between seasons there is often no auction on the calendar
  // and the token has to fall back to a PHRASE ("our next auction") — put
  // it after "on" and an install with nothing scheduled sends "is on our
  // next auction". It also cannot fall back to an empty string: Meta
  // rejects a blank template variable outright.
  const tpl = getSetting(db, 'reminder_message')
    || 'Dear {name}, we have not seen your lots since {last_booked}. Do send your produce for {next_auction}. Regards, {company}';
  const name = String(row.label || row.name || '').trim();
  const company = String(getSetting(db, 'trade_name') || getSetting(db, 'short_name') || '').trim();
  const na = ctx.nextAuction || null;
  const fmt = (ymdStr) => {
    const d = parseYmd(ymdStr);
    if (!d) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  };
  return String(tpl)
    .replace(/\{name\}/g, name)
    .replace(/\{first_name\}/g, name.split(/\s+/)[0] || name)
    .replace(/\{company\}/g, company)
    .replace(/\{last_booked\}/g, row.last_booked ? fmt(row.last_booked) : 'your last visit')
    .replace(/\{days\}/g, row.days_since == null ? '' : String(row.days_since))
    // No auction on the calendar is normal between seasons, so the token
    // degrades to a phrase that still reads as a sentence rather than
    // leaving a hole or an empty date.
    .replace(/\{next_auction\}/g, na && na.date ? fmt(na.date) : 'our next auction')
    .replace(/\{next_auction_no\}/g, na && na.ano ? String(na.ano) : '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[\s,;:—-]+$/, '')
    .trim();
}

// The approved Meta template takes THREE body variables, in this order:
//   {{1}} the seller's name
//   {{2}} when they last booked   ("05/05/2026", or "your last visit")
//   {{3}} the next auction        ("08/10/2026", or "our next auction")
//
// Kept beside composeMessage and matching its default wording token for
// token, because the on-screen preview and what Meta actually delivers
// have to say the same thing — a preview promising "since 05/05/2026"
// against a template with no such variable is worse than no preview.
//
// EVERY param is a non-empty, self-contained phrase. Two reasons: Meta
// rejects a blank template variable outright, and both of these have a
// real absent case (a never-booked seller; no auction on the calendar
// between seasons) that still has to read as a sentence.
function templateParams(row, ctx = {}) {
  const na = ctx.nextAuction || null;
  const fmt = (ymdStr) => {
    const d = parseYmd(ymdStr);
    if (!d) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  };
  return [
    String(row.label || row.name || '').trim(),
    row.last_booked ? fmt(row.last_booked) : 'your last visit',
    na && na.date ? fmt(na.date) : 'our next auction',
  ];
}

// ── SEND ───────────────────────────────────────────────────────────
// `send` is injected by server.js, same contract as the birthday engine:
//   send({ phone, text, template, lang, bodyParams, freeText, ref })
//     → Promise<{ ok, id?, error? }>, never throws.
async function sendReminders(db, rows, opts = {}) {
  const cfg = opts.cfg || config(db);
  const send = opts.send;
  const mode = opts.mode === 'auto' ? 'auto' : 'manual';
  const by = String(opts.by || '');
  const today = opts.date && parseYmd(opts.date) ? String(opts.date) : ymd(new Date());
  const ctx = { nextAuction: opts.nextAuction !== undefined ? opts.nextAuction : nextAuction(db, today) };
  const cap = opts.cap == null ? cfg.maxPerDay : opts.cap;
  const results = [];
  let sent = 0;

  for (const row of rows) {
    const base = { trader_id: row.trader_id, name: row.label || row.name, phone: row.phone,
      last_booked: row.last_booked, days_since: row.days_since };
    if (!row.phone) { results.push({ ...base, status: 'skipped', reason: 'no phone number' }); continue; }
    // Re-check the cooldown per row rather than trusting the caller's list:
    // a long run, or two operators at once, must not double-message anyone.
    const last = lastRemindedFor(db, row.trader_id);
    const ago = last ? daysBetween(last, today) : null;
    if (ago != null && ago < cfg.cooldownDays) {
      results.push({ ...base, status: 'skipped', reason: `already reminded ${ago} day${ago === 1 ? '' : 's'} ago` });
      continue;
    }
    if (cap && sent >= cap) {
      results.push({ ...base, status: 'skipped', reason: `daily cap of ${cap} reached` });
      continue;
    }
    const message = composeMessage(db, row, ctx);
    let out;
    try {
      out = await send({
        phone: row.phone,
        text: message,
        template: cfg.template,
        lang: cfg.lang,
        bodyParams: templateParams(row, ctx),
        freeText: cfg.freeText,
        ref: { ref_type: 'seller_reminder', ref_id: String(row.trader_id) },
      });
    } catch (e) { out = { ok: false, error: e.message }; }
    out = out || { ok: false, error: 'no response from sender' };
    if (out.ok) {
      sent++;
      _log(db, { ...base, mode, sent_by: by, status: 'sent', wamid: out.id || '' });
      results.push({ ...base, status: 'sent', wamid: out.id || '' });
    } else {
      _log(db, { ...base, mode, sent_by: by, status: 'failed', error: out.error || 'send failed' });
      results.push({ ...base, status: 'failed', error: out.error || 'send failed' });
    }
  }
  return { results, sent,
    failed:  results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length };
}

// ── THE DAILY SWEEP ────────────────────────────────────────────────
// Same timer shape as the birthday sweep and the same reason for it (this
// app also ships as a desktop install that is shut overnight). The
// difference: a dormant seller stays dormant, so the backlog does NOT
// have to clear in one day. The cap drains it a slice at a time — on the
// live master, 836 due at 50/day is a 17-day trickle that never threatens
// the 250-recipient ceiling the invoice sends also draw on.
async function runDailySweep(db, opts = {}) {
  const cfg = opts.cfg || config(db);
  if (!cfg.enabled) return { ran: false, reason: 'feature off' };
  if (!cfg.auto)    return { ran: false, reason: 'auto-send off' };
  const now = opts.now || new Date();
  if (now.getHours() < cfg.hour) return { ran: false, reason: `before send hour (${cfg.hour}:00)` };
  const today = ymd(now);
  const { due } = review(db, { cfg, date: today });
  if (!due.length) return { ran: true, date: today, results: [], sent: 0, failed: 0, skipped: 0, remaining: 0 };
  const out = await sendReminders(db, due, { cfg, send: opts.send, mode: 'auto', date: today });
  return { ran: true, date: today, ...out, remaining: Math.max(0, due.length - out.sent) };
}

module.exports = {
  ymd, parseYmd, daysBetween, config, nextAuction,
  bookingHistory, neverBooked, review,
  lastRemindedMap, lastRemindedFor, composeMessage, templateParams,
  sendReminders, runDailySweep,
};
