// export-filename.js — one place that names every file the app hands out.
//
// THE RULE: a downloaded file says which TRADE it came from, and it says so by
// AUCTION NUMBER (`ano`), never by the internal `auctions.id`.
//
// Both halves of that rule were being broken, in ways that looked fine:
//
//   · Twelve routes put the raw auction id in the filename. In the live data
//     every auction happens to have id == ano, so the names looked right —
//     until an auction is deleted (ids are AUTOINCREMENT and never reused) or
//     an ano stops being a plain number (`ano` is a TEXT column). Latent, not
//     theoretical.
//
//   · Per-document names left the trade out entirely, and those numbers are
//     NOT globally unique. 35 (sale, invo) pairs in the live data are reused
//     across different anos — sales invoice I-18 exists in both auction 14 and
//     15 — so the two PDFs overwrite each other in the Downloads folder. Lot
//     numbers are worse: 490 of 499 are reused across trades.
//
// Everything that sets a Content-Disposition filename goes through
// exportFileName() so the convention holds in one place and can be tested.
// Reports that are genuinely not trade-scoped (TDS return, pooler
// certificate, the individual registers) carry their DATE RANGE instead —
// see scopeParts().

// Characters no filesystem (or Content-Disposition header) should have to
// carry. Quotes matter especially: the header quotes the filename, so a `"`
// in a party name would truncate it.
const UNSAFE = /[\/\\:*?"<>|\r\n]+/g;

// One filename component. Empty in → empty out, which is what lets
// exportFileName drop it rather than leaving a stray separator behind.
function safeFilePart(v) {
  if (v == null) return '';
  return String(v).trim().replace(UNSAFE, '-').replace(/\s+/g, '_');
}

// Join parts into a filename STEM (no extension), dropping blanks.
//
//   exportFileName('Invoice', '15', 'L', '9')  → 'Invoice_15_L_9'
//   exportFileName('Invoice', '',   'L', '9')  → 'Invoice_L_9'
//
// The second form is the point: when a document predates the ano or the
// lookup fails, the name degrades to what it used to be instead of growing a
// double underscore or the word "undefined".
function exportFileName(...parts) {
  return parts.map(safeFilePart).filter(s => s !== '').join('_');
}

// Resolve the business-facing auction number for a filename. Falls back to the
// raw id when the auction can't be found — at that point the id is the only
// handle there is, and a name is better than no name.
function anoForFilename(db, auctionId) {
  let val = auctionId;
  try {
    const a = db.get('SELECT ano FROM auctions WHERE id = ?', [auctionId]);
    if (a && a.ano != null && String(a.ano).trim()) val = String(a.ano).trim();
  } catch (_) {}
  return safeFilePart(val);
}

// Trade label for a batch of document rows: the shared ano when every row
// belongs to one trade, 'Multi' when the selection spans trades. Without this
// a 12-document batch from auction 15 and a 12-document batch from 16 are both
// `..._Batch_12.pdf`, and the second download silently replaces the first.
function anoLabelForRows(rows) {
  if (!Array.isArray(rows)) return '';
  const set = [...new Set(rows.map(r => String((r && r.ano) || '').trim()).filter(Boolean))];
  if (set.length === 1) return safeFilePart(set[0]);
  return set.length > 1 ? 'Multi' : '';
}

// Same, for a route that holds only the selected ids. `table` is interpolated,
// so it is whitelisted by shape — every caller passes a literal.
function anoLabelForIds(db, table, ids) {
  if (!Array.isArray(ids) || !ids.length) return '';
  if (!/^[a-z_]+$/.test(String(table))) return '';
  try {
    const rows = db.all(
      `SELECT DISTINCT ano FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids.map(n => Number(n)));
    return anoLabelForRows(rows);
  } catch (_) { return ''; }
}

// Scope parts for a report that may be filtered by trade OR by date range:
// the ano when there is one, else the range, else nothing. Returns an ARRAY so
// it drops straight into an exportFileName call.
//
//   exportFileName('SalesRegister', ...scopeParts(db, opts))
//     → 'SalesRegister_15'              (trade)
//     → 'SalesRegister_2026-08-01_to_2026-08-31'   (range)
//     → 'SalesRegister'                 (neither)
function scopeParts(db, opts) {
  const o = opts || {};
  const ano = o.ano != null && String(o.ano).trim() ? String(o.ano).trim() : '';
  if (ano) return [ano];
  if (o.auctionId != null && String(o.auctionId).trim()) {
    return [anoForFilename(db, o.auctionId)];
  }
  const from = o.from || o.dateFrom || '';
  const to   = o.to   || o.dateTo   || '';
  if (from && to) return [from, 'to', to];
  if (from) return ['from', from];
  if (to) return ['to', to];
  return [];
}

module.exports = {
  safeFilePart, exportFileName, anoForFilename,
  anoLabelForRows, anoLabelForIds, scopeParts,
};
