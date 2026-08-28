/**
 * party-case.js — one uppercase rule for seller and buyer master details.
 *
 * Seller and buyer names, addresses and statutory identifiers print in UPPER
 * CASE on every document this app produces — invoices, debit notes, the
 * Spice-Board returns, the DBF and Tally exports, the XLSX registers. They
 * were only uppercase because operators happened to type them that way, so a
 * single lower-case entry showed up mixed on one report and not another.
 *
 * The rule is applied at the WRITE boundary rather than in each renderer.
 * `lots`, `purchases`, `bills`, `debit_notes` and `invoices` all carry their
 * own denormalised copy of the party name, and every export reads a different
 * one of those — normalising once on the way in means every reader is
 * uppercase without hunting down each call site, and keeps the copies
 * byte-identical to their master (which several name-matching queries rely on).
 *
 * DELIBERATELY NOT uppercased: phone / whatsapp (digits), email (the local
 * part is case-sensitive per RFC 5321, and mail servers do differ), dob,
 * bank account numbers, IFSC (already forced upper at its own input), and
 * every numeric or code column the operator does not type as prose.
 */

// traders columns: name, GSTIN, PAN, TAN, SBL (stored in `aadhar`), address,
// place, state, and the bank account holder's name.
const TRADER_UPPER = [
  'name', 'cr', 'pan', 'tan', 'aadhar', 'padd', 'ppla', 'pstate', 'holder_name',
];

// buyers columns: the buyer code (`buyer`), trade name (`buyer1`), short
// alias (`code`), SBL, address, place, state, GSTIN, PAN, TAN — plus the
// consignee ("c" prefixed) mirror of the same fields.
const BUYER_UPPER = [
  'buyer', 'buyer1', 'code', 'sbl', 'add1', 'add2', 'pla', 'state', 'gstin', 'pan', 'tan',
  'cbuyer1', 'cadd1', 'cadd2', 'cpla', 'cstate', 'cgstin',
];

function upper(v) {
  return v == null ? v : String(v).trim().toUpperCase();
}

// Return a shallow copy of `obj` with the listed keys upper-cased.
//
// Only keys the caller actually SENT are touched: the update handlers build
// their SET clause from "did the client provide this field?", so inventing a
// key here would blank a column the operator never edited.
function normalizeParty(obj, fields) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(out, f)) out[f] = upper(out[f]);
  }
  return out;
}

function normalizeTrader(t) { return normalizeParty(t, TRADER_UPPER); }
function normalizeBuyer(b)  { return normalizeParty(b, BUYER_UPPER); }

// One-time backfill for rows written before the rule existed. Covers the
// masters AND the denormalised copies, because a report reading `lots.name`
// would otherwise still show the old casing until that seller is next edited.
//
// Idempotent (UPPER of an uppercase string is itself) and guarded per table,
// so a build missing one of these tables still migrates the rest.
const BACKFILL = [
  ['traders',              ['name', 'cr', 'pan', 'tan', 'aadhar', 'padd', 'ppla', 'pstate', 'holder_name']],
  ['trader_banks',         ['holder_name']],
  ['buyers',               BUYER_UPPER],
  ['lots',                 ['name', 'cr', 'pan', 'buyer', 'buyer1', 'padd', 'ppla', 'pstate']],
  ['purchases',            ['name']],
  ['bills',                ['name']],
  ['debit_notes',          ['name']],
  ['debit_notes_planter',  ['name']],
  ['invoices',             ['buyer', 'buyer1']],
];

function backfillPartyCase(db) {
  let changed = 0;
  for (const [table, cols] of BACKFILL) {
    let present;
    try {
      present = new Set(db.all(`PRAGMA table_info(${table})`).map(c => c.name));
    } catch (_) { continue; }          // table not in this build — skip
    if (!present.size) continue;
    const use = cols.filter(c => present.has(c));
    if (!use.length) continue;
    // One UPDATE per table, restricted to rows that actually differ, so the
    // common case (everything already uppercase) writes nothing at all.
    const sets  = use.map(c => `${c} = UPPER(${c})`).join(', ');
    const where = use.map(c => `${c} <> UPPER(${c})`).join(' OR ');
    try {
      const info = db.run(`UPDATE ${table} SET ${sets} WHERE ${where}`);
      changed += (info && info.changes) || 0;
    } catch (_) { /* a locked or missing table must not block startup */ }
  }
  return changed;
}

module.exports = {
  upper, normalizeParty, normalizeTrader, normalizeBuyer,
  backfillPartyCase, TRADER_UPPER, BUYER_UPPER,
};
