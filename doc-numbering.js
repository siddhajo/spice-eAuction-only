// ── DOCUMENT NUMBER SERIES + RANGE CLAIM ─────────────────────
// One place that knows, for every numbered transaction document, WHICH
// SERIES its number belongs to — and therefore what "that number is already
// taken" means.
//
// Why this file exists
// ───────────────────
// Five modules hand out document numbers, and until now only two of them
// checked anything. `debit_notes` and `debit_notes_planter` claimed their
// range up front (refusing with 409 + a safe start); `invoices`, `purchases`
// and `bills` accepted any positive integer and started writing. There is no
// UNIQUE index on any document-number column in db.js — the only one in the
// schema is `users.username` — so a mistyped start number silently produced a
// trade full of duplicate invoice numbers, with nothing to say so afterwards.
//
// That was survivable while each module was generated deliberately from its
// own tab. It is not survivable for a one-click run that fires all five, where
// a collision discovered at module 4 leaves three already committed. So the
// claim moves here, every module gets it, and a pipeline can ask all five
// BEFORE anything writes.
//
// The series are NOT uniform, which is the whole reason a registry beats five
// inline checks:
//
//   invoices             GLOBAL running series, one per SALE TYPE, with the
//                        proforma series kept separate from the original one.
//                        Sale L #33 and sale I #33 are different documents and
//                        must not collide (tests/collection-raised-draft.http.js
//                        generates exactly that pair).
//   purchases / bills    GLOBAL running series across every trade — a trade's
//                        numbers continue where the previous trade's stopped
//                        (see DOC_NO_MODULES / suggest-doc-no in server.js,
//                        whose `global:false` branch suggests MAX over PRIOR
//                        trades). So the number space is the whole table.
//   debit_notes,         PER-TRADE series. Trade #1's note #5 does not
//   debit_notes_planter  conflict with trade #2's note #5, so every query
//                        here is scoped `WHERE ano = ?`.
//
// Getting that scope wrong in either direction is a real bug: too narrow and
// duplicates slip through, too wide and a legitimate run is refused.
//
// `col GLOB '[0-9]*'` guards every read. Document numbers are stored as text
// in most of these tables and a site may carry non-numeric legacy rows; the
// GLOB keeps them out of MAX and out of the collision window. It deliberately
// still matches "2857.0" — sql.js can bind an integer as REAL into a TEXT
// column (see the sql.js number→TEXT note in the project memory), and such a
// row IS a real occupant of the series.

'use strict';

// Each entry: where(ctx) → the extra SQL that narrows the table to ONE series
// (written against the alias `t`, which every query here uses), and
// scope(ctx) → how to name that series to an operator in an error.
const SERIES = {
  invoices: {
    label: 'sales invoice',
    table: 'invoices',
    col: 'invo',
    where(ctx) {
      return {
        sql: ' AND t.sale = ? AND COALESCE(t.is_proforma,0) = ?',
        params: [String(ctx && ctx.sale || ''), ctx && ctx.isProforma ? 1 : 0],
      };
    },
    scope(ctx) {
      const s = String(ctx && ctx.sale || '').trim() || '(blank)';
      return (ctx && ctx.isProforma ? 'the proforma series' : 'the original series') +
             ' for sale type ' + s;
    },
  },

  purchases: {
    label: 'purchase invoice',
    table: 'purchases',
    col: 'invo',
    where() { return { sql: '', params: [] }; },
    scope() { return 'the purchase invoice series'; },
  },

  bills: {
    label: 'bill of supply',
    plural: 'bills of supply',
    table: 'bills',
    col: 'bil',
    where() { return { sql: '', params: [] }; },
    scope() { return 'the bill of supply series'; },
  },

  debit_notes: {
    label: 'debit note',
    table: 'debit_notes',
    col: 'note_no',
    where(ctx) { return { sql: ' AND t.ano = ?', params: [String(ctx && ctx.ano || '')] }; },
    scope(ctx) { return 'trade #' + String(ctx && ctx.ano || ''); },
  },

  debit_notes_planter: {
    label: 'planter debit note',
    table: 'debit_notes_planter',
    col: 'note_no',
    where(ctx) { return { sql: ' AND t.ano = ?', params: [String(ctx && ctx.ano || '')] }; },
    scope(ctx) { return 'trade #' + String(ctx && ctx.ano || ''); },
  },
};

function seriesFor(id) {
  const s = SERIES[id];
  if (!s) throw new Error('Unknown document series: ' + id);
  return s;
}

// Highest number currently in the series (0 when it is empty).
function maxNo(db, id, ctx) {
  const s = seriesFor(id);
  const w = s.where(ctx);
  const row = db.get(
    `SELECT MAX(CAST(t.${s.col} AS INTEGER)) AS mx
       FROM ${s.table} t
      WHERE t.${s.col} GLOB '[0-9]*'${w.sql}`,
    w.params
  );
  const mx = parseInt(row && row.mx, 10);
  return Number.isFinite(mx) && mx > 0 ? mx : 0;
}

// The next start that is guaranteed free: one past the series' highest.
function nextSafe(db, id, ctx) {
  return maxNo(db, id, ctx) + 1;
}

// Numbers already taken inside [from, to] of this series, ascending.
function findCollisions(db, id, ctx, from, to) {
  const s = seriesFor(id);
  if (!(from >= 1) || !(to >= from)) return [];
  const w = s.where(ctx);
  return db.all(
    `SELECT CAST(t.${s.col} AS INTEGER) AS n
       FROM ${s.table} t
      WHERE t.${s.col} GLOB '[0-9]*'${w.sql}
        AND CAST(t.${s.col} AS INTEGER) BETWEEN ? AND ?
      ORDER BY n`,
    w.params.concat([from, to])
  ).map(r => r.n);
}

// ── THE CLAIM ────────────────────────────────────────────────
// Reserve `count` consecutive numbers starting at `start`, or explain why not.
//
//   { ok: true,  from, to, count }
//   { ok: false, status, error, collisions?, suggested? }
//
// `count` is the number of documents the caller is ABOUT to write. Callers
// that can't know it exactly should pass their upper bound: claiming a wider
// range than gets used is conservative (it can refuse a start that would in
// fact have fitted) and never lets a duplicate through, which is the trade we
// want on a tax document.
//
// count === 0 is a success with no range — "nothing to generate" is not a
// numbering failure, and the caller still wants to run so it can report its
// own "nothing eligible" message.
function claimRange(db, id, ctx, start, count) {
  const s = seriesFor(id);
  const n = parseInt(String(start == null ? '' : start).trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, status: 400, error: 'Starting Number must be a positive integer' };
  }
  const want = Number(count) || 0;
  if (want <= 0) return { ok: true, from: n, to: n - 1, count: 0 };

  const to = n + want - 1;
  const collisions = findCollisions(db, id, ctx, n, to);
  if (!collisions.length) return { ok: true, from: n, to, count: want };

  const safe = nextSafe(db, id, ctx);
  const shown = collisions.slice(0, 5).map(c => '#' + c).join(', ');
  const more = collisions.length > 5 ? `, +${collisions.length - 5} more` : '';
  return {
    ok: false,
    status: 409,
    error: `Starting Number ${n} would overlap existing ${s.plural || s.label + 's'} in ` +
           `${s.scope(ctx)} (${shown}${more}). ` +
           `${want} number(s) are needed — try ${safe} or higher.`,
    collisions,
    suggested: safe,
  };
}

// Claim a specific SET of numbers, which need not be contiguous.
//
// A sales-invoice batch spanning several sale types shares ONE counter while
// each sale type is its own series, so a series receives a sparse subset:
// #101 and #103 go to sale L, #102 to sale I. Asking claimRange for the
// window 101-103 on series L would report #102 as a collision when that
// number is not destined for series L at all. This checks membership instead.
//
// `opts.start` / `opts.need` only shape the wording (the operator typed one
// starting number for the whole batch, so that is the number the message has
// to name).
function claimNumbers(db, id, ctx, numbers, opts) {
  const s = seriesFor(id);
  opts = opts || {};
  const nos = (numbers || []).map(Number).filter(n => Number.isFinite(n) && n >= 1);
  if (!nos.length) return { ok: true, numbers: [], count: 0 };

  const lo = Math.min.apply(null, nos), hi = Math.max.apply(null, nos);
  const want = new Set(nos);
  const taken = findCollisions(db, id, ctx, lo, hi).filter(n => want.has(n));
  if (!taken.length) return { ok: true, numbers: nos, count: nos.length };

  const safe = nextSafe(db, id, ctx);
  const shown = taken.slice(0, 5).map(c => '#' + c).join(', ');
  const more = taken.length > 5 ? `, +${taken.length - 5} more` : '';
  const start = opts.start != null ? opts.start : lo;
  const need = opts.need != null ? opts.need : nos.length;
  return {
    ok: false,
    status: 409,
    error: `Starting Number ${start} would overlap existing ${s.plural || s.label + 's'} in ` +
           `${s.scope(ctx)} (${shown}${more}). ` +
           `${need} number(s) are needed — try ${safe} or higher.`,
    collisions: taken,
    suggested: safe,
  };
}

// Convenience for an Express handler: claim, or send the refusal and return
// null so the caller can `if (!claim) return;`. Keeps the five call sites from
// each re-deriving the same res.status(...).json(...) shape.
function claimOrRefuse(res, db, id, ctx, start, count) {
  return sendRefusal(res, claimRange(db, id, ctx, start, count));
}

// Same for an already-computed claim (claimRange or claimNumbers).
function sendRefusal(res, c) {
  if (c.ok) return c;
  const body = { error: c.error };
  if (c.collisions) body.collisions = c.collisions;
  if (c.suggested != null) body.suggested = c.suggested;
  res.status(c.status).json(body);
  return null;
}

module.exports = {
  SERIES, maxNo, nextSafe, findCollisions,
  claimRange, claimNumbers, claimOrRefuse, sendRefusal,
};
