// ── Proforma ⇄ original cross-reference ──────────────────────────────────
//
// Answers one question, for one auction: "which PROFORMA number does the buyer
// actually hold for this sales invoice?" — so a register can quote the document
// the buyer was shipped against instead of the original tax-invoice number they
// may never have seen.
//
// This is the same resolution the Collection register performs inline
// (getCollectionRows in auction-reports.js) and the Merchants XML performs in
// tally-xml.js. It lives here so the Sales Journal answers identically rather
// than growing a third, subtly different copy. If you change a rule here,
// check those two.
//
// ── Why two sources, and why the lots win ────────────────────────────────
// `invoices.raised_invo` is stamped on at most ONE draft per original, and only
// where sale type and number line up, so two everyday cases fall through it:
//
//   • SPLIT — one draft shipped as several originals. The generate path stamps
//     raised_invo only where it is still empty, so the 2nd, 3rd … original
//     carries no back-reference at all.
//   • SALE CHANGE — drafted Local, billed Inter-state. `sale` is part of the
//     key, so the match misses.
//
// The LOTS are ground truth: an original stamps lots.invo (lots.asp_invo on the
// Kerala/ASP side) and the draft that covered those lots left lots.proforma_invo
// behind, per lot. So lot stamps WIN OUTRIGHT and raised_invo is consulted only
// for invoices that have none. Unioning the two printed phantom numbers:
// raised_invo survives on a draft that was later re-issued, and because the
// draft and original series are numbered independently, a stale "draft N was
// raised as original N" row gets pulled into the cell for an unrelated original
// that happens to share the number N.

const { formatInvoiceNo } = require('./report-formatters');

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();
const trim  = (v) => String(v == null ? '' : v).trim();

// Numeric-first sort so "2, 10" doesn't come back as "10, 2".
function byInvoiceNo(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * Build the cross-reference indexes for one auction, once, then hand back
 * lookups that run in memory. Two queries total — cheap enough to build per
 * request, so callers don't need to cache it.
 *
 * @param {object} db          the app db handle (.all)
 * @param {number} auctionId
 * @returns {{ pfNosFor: Function, draftSaleFor: Function, labelFor: Function }}
 */
function buildProformaIndex(db, auctionId) {
  // ── Source 1 (wins): per-lot draft stamps ──
  const proformaByLots = new Map();
  const lotStamps = db.all(
    `SELECT buyer,
            TRIM(COALESCE(invo,''))          AS invo,
            TRIM(COALESCE(asp_invo,''))      AS asp_invo,
            TRIM(COALESCE(proforma_invo,'')) AS pf
       FROM lots
      WHERE auction_id = ? AND TRIM(COALESCE(proforma_invo,'')) != ''`,
    [auctionId]
  );
  for (const l of lotStamps) {
    const buyerKey = upper(l.buyer);
    // A lot can be stamped by both sides of the ASP→ISP cycle; index it under
    // each number so whichever invoice the caller is printing finds it.
    for (const no of new Set([l.invo, l.asp_invo])) {
      if (!no) continue;
      const k = `${buyerKey}|${no}`;
      if (!proformaByLots.has(k)) proformaByLots.set(k, new Set());
      proformaByLots.get(k).add(l.pf);
    }
  }

  // ── Source 2 (fallback): invoices.raised_invo back-references ──
  const allDrafts = db.all(
    `SELECT sale, buyer, invo, raised_invo
       FROM invoices
      WHERE auction_id = ? AND COALESCE(is_proforma,0) = 1
      ORDER BY CAST(invo AS INTEGER), invo`,
    [auctionId]
  );
  // The sale letter printed next to a draft number must be the DRAFT's own —
  // that is what the buyer holds. Taking it from the original turns "PI/L-8"
  // into "PI/I-8" whenever the operator drafted under one sale type and billed
  // under another: a number that appears on no document anywhere.
  const draftSaleByNo = new Map();
  for (const p of allDrafts) draftSaleByNo.set(`${upper(p.buyer)}|${trim(p.invo)}`, upper(p.sale));

  const bySale = new Map(), anySale = new Map();
  for (const p of allDrafts) {
    const raised = trim(p.raised_invo);
    if (!raised) continue;                    // still pending — nothing to map back to
    const buyerKey = upper(p.buyer), no = trim(p.invo);
    const k1 = `${upper(p.sale)}|${buyerKey}|${raised}`;
    if (!bySale.has(k1)) bySale.set(k1, []);
    bySale.get(k1).push(no);
    const k2 = `${buyerKey}|${raised}`;
    if (!anySale.has(k2)) anySale.set(k2, []);
    anySale.get(k2).push(no);
  }

  /** Proforma number(s) `row` (an ORIGINAL invoice) was raised from, lowest first. */
  function pfNosFor(row) {
    const buyerKey = upper(row && row.buyer), invoKey = trim(row && row.invo);
    const fromLots = [...(proformaByLots.get(`${buyerKey}|${invoKey}`) || [])];
    const fromRaised = fromLots.length ? [] : (
      bySale.get(`${upper(row && row.sale)}|${buyerKey}|${invoKey}`) ||
      anySale.get(`${buyerKey}|${invoKey}`) || []
    );
    return [...new Set([...fromLots, ...fromRaised])].filter(Boolean).sort(byInvoiceNo);
  }

  /** The sale letter a given draft number was raised under ('' when unknown). */
  function draftSaleFor(buyer, no) {
    return draftSaleByNo.get(`${upper(buyer)}|${trim(no)}`) || '';
  }

  /**
   * Ready-to-print invoice-number cell for `row`:
   *   • row IS a pending proforma → its OWN number under the proforma prefix
   *     ("PI/L-8"). Nothing has been raised from it, so there is no original to
   *     show — and the prefix is what marks it as a draft at a glance.
   *   • raised from a proforma    → that proforma's number, prefixed
   *     ("PI/L-8"); comma-separated when several drafts folded into one original.
   *   • billed directly           → the original number, legacy bare form ("I 2009").
   */
  function labelFor(row, prefix) {
    if (Number(row && row.is_proforma)) return formatInvoiceNo(prefix, row.sale, row.invo);
    const pfNos = pfNosFor(row);
    if (!pfNos.length) return formatInvoiceNo('', row.sale, row.invo);
    return pfNos
      .map(n => formatInvoiceNo(prefix, draftSaleFor(row.buyer, n) || row.sale, n))
      .join(', ');
  }

  return { pfNosFor, draftSaleFor, labelFor };
}

module.exports = { buildProformaIndex };
