// ── IST (Asia/Kolkata) — the app's one and only clock ────────────────
//
// Every timestamp this app writes or shows is Indian Standard Time. That
// was previously only true by accident: the code leans on SQLite's
// datetime('now','localtime') in ~66 places and on bare `new Date()`
// elsewhere, both of which resolve to whatever zone the *host* happens to
// be in. On a developer's Mac that is IST; in the Docker/Railway
// container it is UTC, so every stored stamp — lot created_at, session
// last_used_at, activity-log rows, WhatsApp send times, the "today"
// window that day-wise counters filter on — came out 5h30m behind the
// wall clock the operator is reading it against. Lots entered before
// 05:30 IST were even filed under the previous day.
//
// Pinning the process TZ fixes all of those at the source, in one place:
// SQLite's 'localtime' modifier, better-sqlite3's native localtime(), and
// JS Date's local getters/formatters all read this.
//
// It is deliberately NOT `process.env.TZ || 'Asia/Kolkata'`: hosts inject
// TZ=UTC as a default, which would silently undo the fix. Override needs
// an explicit, unambiguous SPICE_TZ.
const TZ = process.env.SPICE_TZ || 'Asia/Kolkata';
process.env.TZ = TZ;

// Node caches the zone on first use; nudge it so a require() that already
// touched Date (or a test that sets SPICE_TZ late) still picks this up.
try { new Date().toString(); } catch { /* not fatal */ }

// ── Formatters ───────────────────────────────────────────────────────
//
// Two shapes of timestamp exist in this codebase and they must NOT be
// treated alike:
//
//   naive  "2026-10-12 14:05:00" / "2026-10-12T14:05:00"  — what
//          datetime('now','localtime') stores. Already IST wall-clock,
//          with no zone attached. These are RE-FORMATTED, never
//          re-parsed: `new Date(s)` would read them in the reader's own
//          zone and a second conversion would shift them again.
//
//   instant  an ISO string carrying Z or ±hh:mm (toISOString()), or epoch
//          milliseconds — a real point in time, which gets CONVERTED
//          into IST.
//
// fmtIst() tells them apart and does the right thing for each.

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const pad = (n) => String(n).padStart(2, '0');

// Break a real instant down into IST calendar parts.
function istParts(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  // en-GB renders midnight as "24" in some ICU builds.
  if (p.hour === '24') p.hour = '00';
  return p;
}

/**
 * Format any timestamp as IST.
 *
 * @param {string|number|Date} value  naive stamp, ISO instant, or epoch ms
 * @param {object} [opts]
 * @param {boolean} [opts.seconds=false]  include :ss
 * @param {boolean} [opts.dateOnly=false] drop the time entirely
 * @param {boolean} [opts.label=false]    append " IST"
 * @returns {string} "DD/MM/YYYY HH:MM" (or '' when unparseable)
 */
function fmtIst(value, opts = {}) {
  if (value === null || value === undefined || value === '') return '';
  const { seconds = false, dateOnly = false, label = false } = opts;

  let Y, M, D, h, m, s;
  const str = typeof value === 'string' ? value.trim() : null;
  const naive = str && !ZONED.test(str) ? str.match(NAIVE) : null;

  if (naive) {
    // Already IST — reformat the digits, don't re-parse.
    [, Y, M, D, h, m, s] = naive;
    h = h || '00'; m = m || '00'; s = s || '00';
  } else {
    const p = istParts(value);
    if (!p) return String(value);
    ({ year: Y, month: M, day: D, hour: h, minute: m, second: s } = p);
  }

  let out = `${D}/${M}/${Y}`;
  if (!dateOnly) out += ` ${h}:${m}` + (seconds ? `:${s}` : '');
  return label ? `${out} IST` : out;
}

/** Date half only: "DD/MM/YYYY". */
const fmtIstDate = (v) => fmtIst(v, { dateOnly: true });

/** Time half only: "HH:MM". */
function fmtIstTime(value, opts = {}) {
  const full = fmtIst(value, { seconds: !!opts.seconds });
  const sp = full.indexOf(' ');
  const t = sp === -1 ? '' : full.slice(sp + 1);
  return opts.label && t ? `${t} IST` : t;
}

/** "YYYY-MM-DD HH:MM:SS" in IST — the shape datetime('now','localtime') stores. */
function istStamp(value = new Date()) {
  const str = typeof value === 'string' ? value.trim() : null;
  const naive = str && !ZONED.test(str) ? str.match(NAIVE) : null;
  if (naive) {
    const [, Y, M, D, h, m, s] = naive;
    return `${Y}-${M}-${D} ${h || '00'}:${m || '00'}:${s || '00'}`;
  }
  const p = istParts(value);
  if (!p) return '';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * The IST calendar date of any timestamp, as "YYYY-MM-DD".
 *
 * Use this instead of `d.toISOString().slice(0, 10)` on a Date object.
 * toISOString() is UTC whatever the process TZ is, so on an IST clock a
 * locally-built Date (`new Date(2026, 9, 12)`, or `new Date()` before
 * 05:30) renders as the PREVIOUS day. Reading the date in IST is right for
 * both shapes that reach here: a locally-built midnight stays on its own
 * day, and an Excel serial / UTC-midnight Date lands at 05:30 IST — still
 * the same day, because IST is ahead of UTC.
 */
function istYmd(value = new Date()) {
  return istStamp(value).slice(0, 10);
}

/** Today's IST calendar date as "YYYY-MM-DD" — for date-only business fields. */
function istToday() {
  return istYmd(new Date());
}

/**
 * Epoch milliseconds for any timestamp, reading a naive stamp as IST rather
 * than as process-local. Keeps arithmetic on stored stamps correct even if
 * the TZ pin is ever bypassed. IST is a fixed +05:30 with no DST, so the
 * shift is a constant.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
function istEpoch(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const str = typeof value === 'string' ? value.trim() : null;
  const naive = str && !ZONED.test(str) ? str.match(NAIVE) : null;
  if (naive) {
    return Date.UTC(+naive[1], +naive[2] - 1, +naive[3],
      +(naive[4] || 0), +(naive[5] || 0), +(naive[6] || 0)) - IST_OFFSET_MS;
  }
  const d = value instanceof Date ? value : new Date(value);
  return d.getTime();
}

/** Filename-safe IST stamp: "YYYY-MM-DD-HH-MM-SS". */
function istFileStamp(value = new Date()) {
  return istStamp(value).replace(/[: ]/g, '-');
}

module.exports = {
  TZ, fmtIst, fmtIstDate, fmtIstTime, istStamp, istToday, istYmd, istFileStamp, istParts, istEpoch,
};
