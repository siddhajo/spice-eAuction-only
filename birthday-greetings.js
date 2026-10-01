// ── birthday-greetings.js ──────────────────────────────────────────
// Birthday greetings for sellers and buyers over WhatsApp.
//
// Business rule (configured in Settings → Birthday Greetings):
//   • Sellers carry `traders.dob`, buyers carry `buyers.dob`. Both are
//     optional free text — anybody without one is simply never greeted.
//   • On a party's birthday, send ONE WhatsApp greeting. At most one
//     successful greeting per party per calendar year, enforced in the
//     database (see the partial unique index in db.js), so a server
//     restart, a second operator, or a manual send after an automatic
//     one can never double-greet.
//   • Auto-send is OFF by default. With it off the whole feature is a
//     worklist: the Birthdays screen lists today's birthdays and the
//     operator presses Send.
//
// WHY THE SEND IS A TEMPLATE, NOT FREE TEXT
// A birthday greeting is by definition unsolicited — the contact has not
// messaged us in the previous 24 hours, so WhatsApp's service window is
// shut and Meta will only deliver an APPROVED template. `birthday_tpl`
// names it; it needs exactly one body variable (the party's name). Free
// text is offered as a fallback for the rare contact who IS inside the
// window, but it is not the default because it silently fails otherwise.
//
// STATE lives entirely in the `birthday_greetings` table — no in-memory
// state — so it survives restarts and works across processes.

const { getSetting, getSettingBool, getSettingNum } = require('./company-config');

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                     'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ── DOB PARSING ────────────────────────────────────────────────────
// `dob` is free text: the date pickers write yyyy-mm-dd, but the Sellers
// XLSX import and Import Old Data pass through whatever the source sheet
// held — dd/mm/yyyy, dd-mm-yy, 31-Jan-1980. Only MONTH and DAY decide
// whether to greet, so the year is optional and a missing/implausible one
// costs nothing but the age.
//
// AMBIGUITY RULE: for the non-ISO forms the FIRST number is the day
// (Indian convention, and the convention every import into this app came
// from). 05/06/1980 is 5 June, not 6 May. A first number above 12 removes
// the doubt either way.
function parseDob(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  let y = null, m = null, d = null;

  // yyyy-mm-dd / yyyy/mm/dd  (ISO — what the date pickers write)
  let mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }

  // dd-mmm-yyyy / dd mmm yy  (DBF and spreadsheet exports)
  if (!mt) {
    mt = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,})[-/. ](\d{2,4})/);
    if (mt) {
      const mi = MONTH_NAMES.indexOf(mt[2].slice(0, 3).toLowerCase());
      if (mi >= 0) { d = +mt[1]; m = mi + 1; y = _expandYear(+mt[3], mt[3].length); }
      else mt = null;
    }
  }

  // dd-mm-yyyy / dd/mm/yy  (day first — see AMBIGUITY RULE above)
  if (!mt) {
    mt = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (mt) { d = +mt[1]; m = +mt[2]; y = _expandYear(+mt[3], mt[3].length); }
  }

  if (!mt) return null;
  if (!(m >= 1 && m <= 12)) return null;
  if (!(d >= 1 && d <= 31)) return null;
  // Reject a day the month cannot hold (30 Feb), but keep 29 Feb — that is
  // a real birthday and _greetDay() decides which day to greet it on.
  if (d > _daysInMonth(m, y || 2000)) return null;
  // A year outside living memory is data noise, not a birth year. Drop the
  // year, keep the day — the greeting does not depend on it.
  const nowY = new Date().getFullYear();
  if (!(y >= 1900 && y <= nowY)) y = null;
  return { y, m, d };
}

function _expandYear(n, digits) {
  if (digits >= 4) return n;
  // Two-digit year: everything is a birth date in the past, so pivot on
  // the current year rather than a fixed century.
  const cy = new Date().getFullYear();
  const guess = Math.floor(cy / 100) * 100 + n;
  return guess > cy ? guess - 100 : guess;
}

function _daysInMonth(m, y) {
  return [31, _isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
function _isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

// Which day of `year` this birthday is greeted on, as {m, d}.
// 29 February in a non-leap year is greeted on the 28th — otherwise those
// sellers would be greeted once every four years.
function _greetDay(dob, year) {
  if (dob.m === 2 && dob.d === 29 && !_isLeap(year)) return { m: 2, d: 28 };
  return { m: dob.m, d: dob.d };
}

// Local yyyy-mm-dd for a Date (never toISOString — that shifts the date
// backwards for any clock east of UTC, which is every install here).
function ymd(dt) {
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function parseYmd(s) {
  const mt = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!mt) return null;
  return new Date(+mt[1], +mt[2] - 1, +mt[3]);
}

// Age the party turns on the greeting date. null when the DOB carried no
// usable year. Shown on the worklist only — never put in the message.
function ageOn(dob, year) {
  if (!dob || !dob.y) return null;
  const a = year - dob.y;
  return a >= 0 && a < 130 ? a : null;
}

// ── CANDIDATES ─────────────────────────────────────────────────────
// Everyone with a parseable DOB and a phone, as a uniform row. Read in
// full and filtered in JS rather than in SQL because `dob` is free text:
// a strftime/substr comparison would silently miss every row that is not
// already ISO, which is exactly the imported ones.
//
// `id` is the party's own table id — the identity that survives a rename,
// and the only safe key for parties whose names repeat.
// `types` is `{ sellers, buyers }` — the shape config() produces via
// partyTypes(). An ABSENT key means "include"; only an explicit false
// excludes, so candidates(db) and candidates(db, {}) both mean everyone and
// a caller can never accidentally ask for nobody.
function candidates(db, types = {}) {
  const want = { sellers: types.sellers !== false, buyers: types.buyers !== false };
  const out = [];
  if (want.sellers) {
    let rows = [];
    try {
      rows = db.all(`SELECT id, name, cr, dob, tel, whatsapp FROM traders
                      WHERE dob IS NOT NULL AND TRIM(dob) <> ''`) || [];
    } catch (_) { rows = []; }
    for (const r of rows) {
      const dob = parseDob(r.dob);
      if (!dob) continue;
      out.push({
        party_type: 'seller', party_id: r.id,
        name: r.name || '', label: [r.cr, r.name].filter(Boolean).join(' ').trim() || r.name || '',
        dob, dob_raw: r.dob,
        phone: String(r.whatsapp || '').trim() || String(r.tel || '').trim(),
      });
    }
  }
  if (want.buyers) {
    let rows = [];
    try {
      rows = db.all(`SELECT id, buyer, buyer1, dob, tel FROM buyers
                      WHERE dob IS NOT NULL AND TRIM(dob) <> ''`) || [];
    } catch (_) { rows = []; }
    for (const r of rows) {
      const dob = parseDob(r.dob);
      if (!dob) continue;
      out.push({
        party_type: 'buyer', party_id: r.id,
        name: r.buyer1 || r.buyer || '', label: r.buyer1 || r.buyer || '',
        dob, dob_raw: r.dob,
        phone: String(r.tel || '').trim(),
      });
    }
  }
  return out;
}

// Everyone whose greeting day is `dateStr` (yyyy-mm-dd, default today).
function birthdaysOn(db, dateStr, types = {}) {
  const dt = parseYmd(dateStr) || new Date();
  const year = dt.getFullYear();
  const m = dt.getMonth() + 1, d = dt.getDate();
  return candidates(db, types)
    .filter((c) => { const g = _greetDay(c.dob, year); return g.m === m && g.d === d; })
    .map((c) => ({ ...c, greet_date: ymd(dt), age: ageOn(c.dob, year) }));
}

// Birthdays in a forward window, for the "coming up" list. Day 0 = today.
function upcoming(db, fromStr, days, types = {}) {
  const base = parseYmd(fromStr) || new Date();
  const span = Math.max(1, Math.min(366, days | 0 || 30));
  const out = [];
  const all = candidates(db, types);
  for (let i = 0; i < span; i++) {
    const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const year = dt.getFullYear(), m = dt.getMonth() + 1, d = dt.getDate();
    for (const c of all) {
      const g = _greetDay(c.dob, year);
      if (g.m === m && g.d === d) {
        out.push({ ...c, greet_date: ymd(dt), days_away: i, age: ageOn(c.dob, year) });
      }
    }
  }
  return out;
}

// ── THE SEND-ONCE LEDGER ───────────────────────────────────────────
// One row per attempt. The partial unique index on
// (party_type, party_id, greet_year) WHERE status='sent' is what makes
// "greeted at most once a year" a database guarantee rather than a
// convention — a failed attempt leaves the slot open for a retry, a
// successful one closes it for the year.
function greetedYears(db, year) {
  let rows = [];
  try {
    rows = db.all(
      `SELECT party_type, party_id, greet_date, wamid FROM birthday_greetings
        WHERE greet_year = ? AND status = 'sent'`, [String(year)]) || [];
  } catch (_) { rows = []; }
  const map = new Map();
  for (const r of rows) map.set(`${r.party_type}:${r.party_id}`, r);
  return map;
}
function alreadyGreeted(db, row, year) {
  try {
    return !!db.get(
      `SELECT id FROM birthday_greetings
        WHERE party_type = ? AND party_id = ? AND greet_year = ? AND status = 'sent' LIMIT 1`,
      [row.party_type, row.party_id, String(year)]);
  } catch (_) { return false; }
}
function _log(db, f) {
  try {
    db.run(
      `INSERT INTO birthday_greetings
         (party_type, party_id, greet_year, greet_date, name, phone, mode, sent_by, status, wamid, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [f.party_type, f.party_id, String(f.greet_year), f.greet_date || '', f.name || '',
       f.phone || '', f.mode || 'manual', f.sent_by || '', f.status || 'failed', f.wamid || '', f.error || '']);
    return true;
  } catch (e) {
    // The unique index refusing the insert means somebody else greeted this
    // party first. That is the guarantee working, not an error.
    return false;
  }
}

// ── MESSAGE ────────────────────────────────────────────────────────
// Tokens, so the operator can reword the greeting without a code change.
// {name} full name · {first_name} first word · {company} the business.
function composeMessage(db, row) {
  const tpl = getSetting(db, 'birthday_message')
    || 'Dear {name}, wishing you a very happy birthday! 🎂 Warm regards, {company}';
  const name = String(row.name || row.label || '').trim();
  // Same precedence the invoice headers use: the trade name is the business
  // as its customers know it; `short_name` is the fallback for an install
  // that only filled the short form in.
  const company = String(getSetting(db, 'trade_name') || getSetting(db, 'short_name') || '').trim();
  return String(tpl)
    .replace(/\{name\}/g, name)
    .replace(/\{first_name\}/g, name.split(/\s+/)[0] || name)
    .replace(/\{company\}/g, company)
    // An install that has not filled in its trade name would otherwise send
    // "...Warm regards," with nothing after the comma. Tidy the hole rather
    // than letting a half-configured install sign off mid-sentence.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[\s,;:—-]+$/, '')
    .trim();
}

function config(db) {
  return {
    enabled:  getSettingBool(db, 'flag_birthday_greetings'),
    sellers:  getSettingBool(db, 'birthday_send_sellers'),
    buyers:   getSettingBool(db, 'birthday_send_buyers'),
    auto:     getSettingBool(db, 'birthday_auto_send'),
    hour:     Math.max(0, Math.min(23, getSettingNum(db, 'birthday_send_hour'))),
    maxPerDay: Math.max(0, getSettingNum(db, 'birthday_max_per_day')) || 50,
    template: String(getSetting(db, 'birthday_tpl') || '').trim(),
    lang:     String(getSetting(db, 'birthday_tpl_lang') || 'en').trim() || 'en',
    freeText: getSettingBool(db, 'birthday_free_text'),
  };
}
function partyTypes(cfg) { return { sellers: cfg.sellers, buyers: cfg.buyers }; }

// ── SEND ───────────────────────────────────────────────────────────
// `send` is injected by server.js — it owns the Meta credentials, the
// template call and the WhatsApp send log. Signature:
//   send({ phone, text, template, lang, bodyParams, ref }) →
//     Promise<{ ok, id?, error? }>   (never throws)
//
// Returns one result per requested row so the caller can render a ledger:
//   status: sent | failed | skipped, with `reason` on a skip.
async function sendGreetings(db, rows, opts = {}) {
  const cfg = opts.cfg || config(db);
  const send = opts.send;
  const mode = opts.mode === 'auto' ? 'auto' : 'manual';
  const by = String(opts.by || '');
  const results = [];
  let sent = 0;
  const cap = opts.cap == null ? cfg.maxPerDay : opts.cap;

  for (const row of rows) {
    const year = (parseYmd(row.greet_date) || new Date()).getFullYear();
    const base = {
      party_type: row.party_type, party_id: row.party_id,
      name: row.label || row.name, phone: row.phone, greet_date: row.greet_date,
    };
    if (!row.phone) { results.push({ ...base, status: 'skipped', reason: 'no phone number' }); continue; }
    if (alreadyGreeted(db, row, year)) {
      results.push({ ...base, status: 'skipped', reason: `already greeted in ${year}` }); continue;
    }
    // The daily cap exists because a bad DOB import (every row 01-01-1980)
    // would otherwise spend the whole 24h recipient tier in one sweep and
    // take the invoice sends down with it.
    if (cap && sent >= cap) {
      results.push({ ...base, status: 'skipped', reason: `daily cap of ${cap} reached` }); continue;
    }
    const message = composeMessage(db, row);
    let out;
    try {
      out = await send({
        phone: row.phone,
        text: message,
        template: cfg.template,
        lang: cfg.lang,
        bodyParams: [row.label || row.name || ''],
        freeText: cfg.freeText,
        ref: { ref_type: 'birthday', ref_id: `${row.party_type}:${row.party_id}` },
      });
    } catch (e) { out = { ok: false, error: e.message }; }
    out = out || { ok: false, error: 'no response from sender' };
    if (out.ok) {
      const claimed = _log(db, { ...base, greet_year: year, mode, sent_by: by, status: 'sent', wamid: out.id || '' });
      sent++;
      results.push({ ...base, status: 'sent', wamid: out.id || '',
        note: claimed ? '' : 'sent, but another run had already logged this greeting' });
    } else {
      _log(db, { ...base, greet_year: year, mode, sent_by: by, status: 'failed', error: out.error || 'send failed' });
      results.push({ ...base, status: 'failed', error: out.error || 'send failed' });
    }
  }
  return { results, sent,
    failed:  results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length };
}

// ── THE DAILY SWEEP ────────────────────────────────────────────────
// Called on a timer. Every gate is re-read from settings on each tick, so
// turning the feature off takes effect without a restart.
//
// It is deliberately NOT a cron expression: this app also ships as a
// desktop install that is closed overnight. The sweep fires on the first
// tick at or after `birthday_send_hour` ON THE DAY ITSELF, and the
// send-once ledger makes every later tick that day a no-op. A machine that
// was off all day sends nothing — a greeting a day late is worse than
// none, and the missed row stays on the screen for the operator to judge.
async function runDailySweep(db, opts = {}) {
  const cfg = opts.cfg || config(db);
  if (!cfg.enabled) return { ran: false, reason: 'feature off' };
  if (!cfg.auto)    return { ran: false, reason: 'auto-send off' };
  if (!cfg.sellers && !cfg.buyers) return { ran: false, reason: 'no party types selected' };
  const now = opts.now || new Date();
  if (now.getHours() < cfg.hour) return { ran: false, reason: `before send hour (${cfg.hour}:00)` };
  const today = ymd(now);
  const due = birthdaysOn(db, today, partyTypes(cfg))
    .filter((r) => !alreadyGreeted(db, r, now.getFullYear()));
  if (!due.length) return { ran: true, date: today, results: [], sent: 0, failed: 0, skipped: 0 };
  const out = await sendGreetings(db, due, { cfg, send: opts.send, mode: 'auto' });
  return { ran: true, date: today, ...out };
}

module.exports = {
  parseDob, ymd, parseYmd, ageOn,
  candidates, birthdaysOn, upcoming,
  greetedYears, alreadyGreeted, composeMessage,
  config, partyTypes, sendGreetings, runDailySweep,
  _internals: { _greetDay, _isLeap, _daysInMonth, _expandYear },
};
