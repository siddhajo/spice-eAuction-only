/**
 * calculations.js — Core business logic
 * Replaces: GENERATE.PRG, parts of GSTKBILT/GSTKBILP/GSTBILP/PAYCHECK
 */

const { getSettingsFlat, getGSTRates } = require('./company-config');

/**
 * Extract the 2-digit state code from a seller's `cr` field.
 *
 * The `cr` column has accumulated several formats over the life of the
 * data — UI inputs, Excel imports, GST-portal lookups, and edge-case
 * manual entry all leave their fingerprints. We accept any of:
 *
 *   "GSTIN.32AAACG1234F1Z2"  → UI prefix
 *   "GSTIN 32AAACG1234F1Z2"  → no-dot variant
 *   "CR.32AAACG1234F1Z2"     → legacy seller-CR prefix (DBF-era)
 *   "CR 32AAACG1234F1Z2"     → no-dot variant
 *   "32AAACG1234F1Z2"        → already bare
 *   ""  / null / undefined   → "" (no GSTIN)
 *   "CR.001" / "CR/12"       → ""  (CR-only, no GSTIN payload)
 *
 * Returns the 2-digit state code from the GSTIN. If the value after
 * stripping prefixes doesn't start with 2 digits, returns "" (which
 * means "treat as unregistered → no GST"). Caller decides what to do
 * with that signal.
 */
function gstinStateCode(cr) {
  if (!cr) return '';
  let s = String(cr).trim().toUpperCase();
  // Strip every well-known prefix our data layer attaches to CR fields.
  // Without the CR. branch, Kerala sellers stored as "CR.32ABC…" got
  // tagged as unregistered and the calculator applied IGST on services
  // instead of the correct CGST+SGST split.
  if      (s.startsWith('GSTIN.')) s = s.substring(6);
  else if (s.startsWith('GSTIN '))  s = s.substring(6);
  else if (s.startsWith('GSTIN'))   s = s.substring(5);
  else if (s.startsWith('CR.'))     s = s.substring(3);
  else if (s.startsWith('CR '))     s = s.substring(3);
  s = s.trim();
  // GSTIN format: 2 digits (state) + 10-char PAN (5 letters + 4 digits + 1
  // letter) + 1 entity char + 'Z' + 1 checksum char = 15 chars total.
  // Validate the WHOLE shape, not just the leading two characters. Checking
  // only the first two digits misclassified CR registration numbers whose
  // value happens to start with two digits — e.g. "CR.21472/19" → "21472/19"
  // → returned "21" and tagged the (unregistered/planter) seller as a
  // registered dealer. That broke the Payments planter/dealer filter and any
  // intra/inter-state GST decision keyed off this state code. A full-format
  // match still detects a real GSTIN stored under a "CR." prefix.
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(s)) return '';
  return s.substring(0, 2);
}

// ── Sale type (L / I) derivation — SINGLE SOURCE OF TRUTH ────────────────
// The sale type on a sales transaction is a function of the BUYER's GST state
// vs the company's business state:
//   buyer GSTIN state == company state → 'L' (Local / intra-state)
//   buyer GSTIN state != company state → 'I' (Inter-state)
//   no / invalid GSTIN                 → '' (unknown — caller may default to 'L')
// Export ('E') is a manual classification that cannot be inferred from a GSTIN,
// so every caller PREFERS an explicit non-blank stored value and only falls
// back to this derivation when the stored value is blank. This mirrors the
// Buyers-tab live derivation in the UI so every surface (generation, import,
// reports, backfill) agrees. Company state code follows the same fixed mapping
// the UI uses: KERALA → 32, otherwise (Tamil Nadu) → 33.
function deriveSaleType(gstin, cfg) {
  const buyerState = gstinStateCode(gstin);
  if (!buyerState) return '';
  const biz = String((cfg && cfg.business_state) || '').toUpperCase();
  const companyState = biz === 'KERALA' ? '32' : '33';
  return buyerState === companyState ? 'L' : 'I';
}

// ── Seller party grade (Grade 1 planter vs Grade 2 registered dealer) ────
// SINGLE SOURCE OF TRUTH. A seller is GRADE 2 (registered dealer — eligible for
// a Purchase Invoice, dealer settlement terms, RD-purchase treatment) iff:
//     cr starts with "GSTIN"  AND  the SBL (stored in `aadhar`) is non-empty.
// Everything else is GRADE 1 (planter / agriculturist — Bill of Supply):
//   • cr starts with "GSTIN" but aadhar empty → Grade 1
//   • cr starts with "CR"                     → Grade 1 (even if it parses as a GSTIN)
//   • blank / anything else                   → Grade 1
// NOTE: this is DISTINCT from gstinStateCode(), which extracts the GST state
// code for the intra/inter-state (CGST/SGST vs IGST) decision — that must keep
// using the full-format GSTIN check and is intentionally left unchanged.
function isDealerSeller(cr, aadhar) {
  const c = String(cr == null ? '' : cr).trim().toUpperCase();
  const sbl = String(aadhar == null ? '' : aadhar).trim();
  return c.startsWith('GSTIN') && sbl !== '';
}
// SQL predicate for the SAME rule. Pass the column expressions so it works with
// table aliases, e.g. dealerSql('l.cr','l.aadhar'). Returns a boolean SQL expr;
// planter = NOT dealerSql(...).
function dealerSql(crCol = 'cr', aadharCol = 'aadhar') {
  return `(UPPER(TRIM(COALESCE(${crCol},''))) LIKE 'GSTIN%' AND TRIM(COALESCE(${aadharCol},'')) <> '')`;
}

// ── Previous "GSTIN dealer" rule (pre-SBL classification) ────────────────
// The isDealerSeller()/dealerSql() rule above (GSTIN + SBL) is now used ONLY
// on the Dashboard, the Current-Auction widget, Lot Entry (web + mobile) and
// the Spice Board e-Auction CSV. EVERYWHERE ELSE — invoicing, payments, bills
// of supply, dealer/planter lists, lot validation, and the Praman / Form-C
// reports — reverts to this older rule: a seller is a dealer purely on whether
// `cr` holds a full-format 15-char GSTIN. The SBL (aadhar) field is NOT
// considered here. This mirrors the long-standing Dealer-List behaviour.
function hasValidGstin(cr) {
  return gstinStateCode(cr) !== '';
}
// SQL predicate for the SAME "cr holds a valid GSTIN" rule. Faithfully
// replicates gstinStateCode()'s prefix-stripping (GSTIN./GSTIN /GSTIN/CR./CR )
// and full 15-char GSTIN shape so SQL-side filters agree with the JS helper.
// GLOB (not LIKE) does the character-class match; the value is UPPER()ed first
// so the [A-Z] classes line up. Planter = NOT hasValidGstinSql(...).
function hasValidGstinSql(crCol = 'cr') {
  const s = `UPPER(TRIM(COALESCE(${crCol},'')))`;
  const stripped =
    `TRIM(CASE ` +
      `WHEN ${s} LIKE 'GSTIN.%' THEN SUBSTR(${s},7) ` +
      `WHEN ${s} LIKE 'GSTIN %' THEN SUBSTR(${s},7) ` +
      `WHEN ${s} LIKE 'GSTIN%'  THEN SUBSTR(${s},6) ` +
      `WHEN ${s} LIKE 'CR.%'    THEN SUBSTR(${s},4) ` +
      `WHEN ${s} LIKE 'CR %'    THEN SUBSTR(${s},4) ` +
      `ELSE ${s} END)`;
  return `(${stripped} GLOB '[0-9][0-9][A-Z][A-Z][A-Z][A-Z][A-Z][0-9][0-9][0-9][0-9][A-Z][0-9A-Z]Z[0-9A-Z]')`;
}

/**
 * Calculate purchase amounts for a lot (after trade).
 *
 * e-Auction only build — canonical inputs:
 *   Amount     = lot.amount (qty × price, already stored on the lot)
 *   Refund     = round( sb_refund (kg) × price )
 *   Commission = round( ( Amount + Refund ) × commission% / 100 )
 *   Handling   = round( Commission × hpc% / 100 )
 *   GST on services = (Commission + Handling) × gst_service
 *                     split intra/inter per seller GSTIN state
 *   Payable    = Amount + Refund − Commission − Handling − (CGST + SGST + IGST)
 *
 * The legacy split into pqty/prate/puramt is no longer used — every
 * formula now reads `lot.amount` directly. The pqty/prate/puramt
 * columns ARE still written (= qty / price / amount) so older SELECTs
 * and exports that referenced them keep working, but they're just
 * aliases now and don't introduce any rounding of their own.
 */
function calculateLot(lot, cfg) {
  const result = { ...lot };

  // ── Amount: qty × price, as stored on the lot ───────────
  // We use lot.amount directly (rather than recomputing qty × price)
  // because the lot's amount column is the canonical figure shown
  // throughout the app — commission/payable/discount should match
  // whatever the operator sees in the Lots table, not a re-rounded
  // variant of it. Falls back to qty × price when amount is missing
  // (e.g. fresh import before Calculate was run).
  const amount = Number(lot.amount) || (Number(lot.qty) || 0) * (Number(lot.price) || 0);

  // Legacy aliases — kept identical to qty / price / amount so any
  // downstream code that still reads pqty/prate/puramt continues to
  // resolve to the same numbers without their own rounding step.
  result.pqty   = Number(lot.qty)   || 0;
  result.prate  = Number(lot.price) || 0;
  result.puramt = amount;

  // ── Sample-bag refund: SB Sample Refund (kg) × price ──────
  // 2-decimal precision: 2664 × 2.85 = 7,592.40 (not 7,592.00).
  const sbRefundKg = Number(cfg.sb_refund) || 0;
  result.refund    = Math.round(sbRefundKg * (Number(lot.price) || 0) * 100) / 100;

  // ── Commission + Handling ─────────────────────────────────
  // Formula:  Commission = ( Amount + Refund ) × 1/100
  //   Commission rate defaults to 1% — `cfg.commission` is honoured as
  //   an override so existing installs can run a different rate, but
  //   the canonical formula is 1%. 2-decimal precision throughout.
  const commissionPct = Number(cfg.commission) > 0 ? Number(cfg.commission) : 1;
  const hpcPct        = Number(cfg.hpc)        || 0;
  result.com    = Math.round((amount + result.refund) * commissionPct / 100 * 100) / 100;
  result.sertax = Math.round(result.com * hpcPct / 100 * 100) / 100;

  // Mirror dual-storage columns for legacy SELECTs that still read isp_*/asp_*.
  result.isp_pqty   = result.pqty;
  result.isp_prate  = result.prate;
  result.isp_puramt = result.puramt;
  result.asp_pqty   = result.pqty;
  result.asp_prate  = result.prate;
  result.asp_puramt = result.puramt;

  // ── GST on services (commission + handling) ──────────────
  // Three classes of seller, in priority order:
  //   1. CR-tagged seller — `lot.cr` starts with "CR" (with or without
  //      "." / space), whether or not it carries a GSTIN payload after
  //      the prefix. These are local registered sellers in the company's
  //      own state; ALWAYS taxed as intra-state (CGST + SGST), per the
  //      business rule that any "CR.*" value indicates a same-state
  //      registered seller. This rule wins even when a GSTIN extracted
  //      from the payload would suggest a different state.
  //   2. Bare GSTIN seller — no CR prefix, a 2-digit state-code-bearing
  //      value (e.g. "32AERPA…"). State code drives intra/inter:
  //         • matches company state → CGST + SGST
  //         • differs from company  → IGST
  //   3. Unregistered seller — no CR prefix and no extractable GSTIN
  //      state. No GST is applied (they go on Bills of Supply).
  //
  // Company state is derived from the actual company GSTIN (kl_gstin /
  // tn_gstin), falling back to the business_state dropdown only when
  // no GSTIN is configured — a Kerala company left on the default
  // 'TAMIL NADU' setting would otherwise wrongly tag intra-state sales
  // as IGST.
  const crRaw         = String(lot.cr == null ? '' : lot.cr).trim().toUpperCase();
  const isCrTagged    = /^CR(\b|[.\s])/.test(crRaw);
  const sellerGstState = gstinStateCode(lot.cr);
  const companyGstin   = cfg.business_state === 'KERALA'     ? (cfg.kl_gstin || '')
                       : cfg.business_state === 'TAMIL NADU' ? (cfg.tn_gstin || '')
                       : (cfg.kl_gstin || cfg.tn_gstin || '');
  const companyGstState = gstinStateCode(companyGstin)
                       || (cfg.business_state === 'KERALA'     ? '32'
                         : cfg.business_state === 'TAMIL NADU' ? '33'
                         : String(cfg.tally_state_code || '33'));
  const isRegistered = isCrTagged || !!sellerGstState;
  const isIntra      = isCrTagged || (!!sellerGstState && sellerGstState === companyGstState);

  const svcRate = Number(cfg.gst_service) || 0;
  const half    = svcRate / 2;
  const taxBase = result.com + result.sertax;

  result.cgst = 0; result.sgst = 0; result.igst = 0;
  if (isRegistered && taxBase > 0 && svcRate > 0) {
    if (isIntra) {
      result.cgst = Math.round(taxBase * half    / 100 * 100) / 100;
      result.sgst = Math.round(taxBase * half    / 100 * 100) / 100;
    } else {
      result.igst = Math.round(taxBase * svcRate / 100 * 100) / 100;
    }
  }

  // advance = total tax on services (informational column)
  result.advance = result.cgst + result.sgst + result.igst;

  // ── Payable ──────────────────────────────────────────────
  //   Payable = Amount + Refund − Commission − Handling − (CGST+SGST+IGST)
  // `balance` is kept as the legacy alias so existing queries don't
  // break, and `payable` is exposed as the canonical key for new code.
  const totalDeductions = result.com + result.sertax + result.cgst + result.sgst + result.igst;
  result.payable = Math.round((amount + result.refund - totalDeductions) * 100) / 100;
  result.balance = result.payable;

  // ── Discount ─────────────────────────────────────────────
  //   Discount = round( Payable / 1000 × 14 × 0.65 )
  // Used by Spice Board export / reports as a derived field.
  // Gated on the per-lot Immediate Payment flag: the early-payment
  // discount is only earned when the seller is settled immediately, so
  // lots with immediate_payment = 0 (or unset) get discount = 0.
  const immediatePayment = Number(lot.immediate_payment) ? 1 : 0;
  result.discount = immediatePayment
    ? Math.round((result.payable / 1000) * 14 * 0.65)
    : 0;

  // ── DN Amount ────────────────────────────────────────────
  //   DN Amount = ( (Amount + Refund) × 1/100 ) + ( Commission × 0/100 )
  // Per spec, the second term contributes 0 — DN amount equals 1% of
  // (Amount + Refund). Stored as `dn_amount` so the Debit Note flow
  // can pick it up without recomputing.
  result.dn_amount = Math.round(((amount + result.refund) * 1 / 100
                                + result.com * 0 / 100) * 100) / 100;

  // Bill amount (for agriculturist bills) — equals Amount.
  result.bilamt = amount;

  return result;
}

/**
 * Calculate TDS under Section 194Q (TDS on Purchase of Goods).
 *
 * Per Section 194Q, a buyer whose turnover exceeds ₹10 cr in the prior FY
 * must deduct TDS at 0.1% of the purchase amount in EXCESS of ₹50 lakh
 * paid to a single seller in the current FY. Once the threshold is crossed,
 * TDS applies to every subsequent rupee bought from that seller for the
 * rest of the year.
 *
 * Inputs (must all be on the SAME basis — either all incl-GST or all
 *   excl-GST; the caller is responsible for keeping units consistent):
 *   purchaseAmount  — current trade's purchase amount (this voucher)
 *   priorPurchases  — sum of all prior purchases from the same seller in
 *                      the current FY (excluding this trade)
 *   cfg.tds_threshold     — usually 5000000 (₹50 L); configurable
 *   cfg.tds_purchase_rate — usually 0.1 (%); configurable, fall-back to
 *                            tcs_tds for back-compat with older configs
 *
 * Returns: TDS amount in rupees (rounded up to nearest paisa).
 */
function calculateTDS(purchaseAmount, priorPurchases, cfg) {
  const threshold = Number(cfg.tds_threshold) || 5000000;
  // Prefer the dedicated TDS-on-purchase rate; fall back to the legacy
  // shared tcs_tds setting if the new key isn't configured yet.
  const tdsRate = Number(cfg.tds_purchase_rate) || Number(cfg.tcs_tds) || 0.1;

  if (priorPurchases > threshold) {
    // Already crossed threshold this FY — TDS on the full new purchase
    return Math.ceil(purchaseAmount * tdsRate / 100);
  } else if ((priorPurchases + purchaseAmount) > threshold) {
    // This trade crosses the threshold — TDS only on the portion above
    const excess = priorPurchases + purchaseAmount - threshold;
    return Math.ceil(excess * tdsRate / 100);
  }
  return 0;
}

/**
 * Calculate TCS under Section 206C(1H) — TCS on Sale of Goods.
 * Threshold logic mirrors TDS-on-purchase: TCS applies to amounts in
 * EXCESS of ₹50 lakh per buyer per FY, then to every subsequent rupee.
 */
function calculateTCS(invoiceAmount, priorSales, cfg) {
  const threshold = Number(cfg.tds_threshold) || 5000000;
  const tcsRate = Number(cfg.tcs_tds) || 0.1;

  if (priorSales > threshold) {
    return Math.ceil(invoiceAmount * tcsRate / 100);
  } else if ((priorSales + invoiceAmount) > threshold) {
    const excess = priorSales + invoiceAmount - threshold;
    return Math.ceil(excess * tcsRate / 100);
  }
  return 0;
}

/**
 * Build sales invoice data for a buyer
 * Aggregates lots by buyer for a given auction
 * Sale type filter is optional — if lots don't have sale set yet, filter by buyer only
 */
function buildSalesInvoice(db, auctionId, buyerCode, saleType, cfg, opts) {
  // Per-invoice "No Transport & Insurance" switch. When true, this whole
  // invoice carries no transport/insurance — both come out 0 (and so drop
  // out of the PDF + Tally via their >0 guards). Set per invoice from the
  // Generate modal / the Invoices-tab toggle (invoices.no_ti).
  const noTI = !!(opts && opts.noTI);
  // Optional lot subset — when splitting one buyer's lots across several
  // invoices, the caller passes the specific lot numbers for THIS invoice.
  // When absent/empty we fall back to the default "all of the buyer's lots"
  // behaviour, so existing single-invoice callers are unaffected.
  const lotNos = (opts && Array.isArray(opts.lotNos))
    ? opts.lotNos.map(x => String(x)).filter(x => x.trim() !== '')
    : null;
  // An explicitly-provided but empty subset means "these zero lots" — return
  // no invoice rather than silently falling back to the whole buyer. (When
  // lotNos is absent entirely, lotNos is null and the full-buyer path runs.)
  if (lotNos && lotNos.length === 0) return null;
  // Get all lots for this buyer in this auction that have amounts
  // Don't filter by sale — we're ASSIGNING the sale type now
  const params = [auctionId, buyerCode, saleType];
  let lotFilter = '';
  if (lotNos && lotNos.length) {
    lotFilter = ` AND lot_no IN (${lotNos.map(() => '?').join(',')})`;
    params.push(...lotNos);
  }
  // Double-invoice guard (opt-in). Generation callers pass excludeInvoiced so
  // a lot that already carries a sales invoice can't be pulled onto a second
  // one. State-aware, mirroring the eligible-buyers rule so it never hides a
  // lot that legitimately still needs invoicing:
  //   - Kerala (ASP): eligible only when `invo` is empty.
  //   - Tamil Nadu (ISP): also eligible when the only invoice on the lot is
  //     its ASP one (invo == asp_invo) — that lot still needs its ISP invoice.
  // Reprint / no-TI-toggle / preview-of-existing callers DON'T pass the flag,
  // so they keep rebuilding from lots that already hold an invoice number.
  let invoFilter = '';
  if (opts && opts.excludeInvoiced) {
    const isASPState = String(cfg.business_state || '').toUpperCase() === 'KERALA';
    invoFilter = isASPState
      ? ` AND (invo IS NULL OR invo = '')`
      : ` AND (invo IS NULL OR invo = '' OR (asp_invo IS NOT NULL AND asp_invo != '' AND invo = asp_invo))`;
  }
  const lots = db.all(
    `SELECT * FROM lots WHERE auction_id = ? AND buyer = ? AND amount > 0
     AND (reserved IS NULL OR reserved = 0)
     AND (sale IS NULL OR sale = '' OR sale = ?)${lotFilter}${invoFilter} ORDER BY lot_no`,
    params
  );
  
  if (!lots.length) return null;

  const gstGoods = cfg.gst_goods || 5;
  const companyState = cfg.business_state === 'KERALA' ? '32' : '33';
  
  // Get buyer details
  const buyer = db.get('SELECT * FROM buyers WHERE buyer = ?', [buyerCode]);
  const buyerState = buyer ? buyer.gstin.substring(0, 2) : companyState;
  const isInterState = buyerState !== companyState;

  let totalQty = 0, totalBags = 0, totalAmount = 0;
  const lineItems = [];

  for (const lot of lots) {
    totalBags += lot.bags;
    const calc = calculateLot(lot, cfg);
    const prate = calc.prate;
    const puramt = calc.puramt;

    totalQty += lot.qty;
    totalAmount += lot.amount;

    lineItems.push({
      lot: lot.lot_no, grade: lot.grade, bags: lot.bags, qty: lot.qty,
      price: lot.price, amount: lot.amount,
      prate: prate, puramt: puramt,
    });
  }

  // Gunny cost (HSN: jute bags)
  const gunnyCost = totalBags * (cfg.gunny_rate || 165);

  // Transport & Insurance rates depend on sale type:
  //   L (Local)        → local_transport / local_insurance
  //   I (Inter-state)  → buyer covers freight; T/I hidden from invoice
  //   E (Export)       → use inter-state rates (same interstate logistics)
  const pickRate = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null || v === '') continue;
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (!Number.isNaN(n)) return n;
    }
    return 0;
  };
  // Sale-type-driven rate selection:
  //   L (Local)       → local_transport / local_insurance config keys
  //   I (Inter-state) → transport / insurance config keys
  //   E (Export)      → zero (buyer covers freight; matches the
  //                      hideTransportInsurance render rule in invoice-pdf.js)
  // Anything else (legacy / blank) is treated as 'L' for safety.
  const st = String(saleType || '').toUpperCase();
  const isExport = (st === 'E');
  const isInter  = (st === 'I');
  const transportRate = isExport ? 0 : (isInter
    ? pickRate(cfg.transport, 2.5)
    : pickRate(cfg.local_transport, cfg.transport, 2.5));
  const insuranceRate = isExport ? 0 : (isInter
    ? pickRate(cfg.insurance, 0.75)
    : pickRate(cfg.local_insurance, cfg.insurance, 0.75));

  // Transport: ₹/kg (qty × rate). Forced to 0 when this invoice is marked
  // "No Transport & Insurance".
  const transportCost = noTI ? 0 : Math.round(totalQty * transportRate * 100) / 100;

  // Insurance: per ₹1000 of (cardamom + gunny + GST on those). Forced to 0
  // when this invoice is marked "No Transport & Insurance".
  //   insurance = ((cardamom_amount + gunny_cost) × (1 + gstGoods/100)) / 1000 × rate
  const subtotalGoods = totalAmount + gunnyCost;
  const gstOnGoods = subtotalGoods * gstGoods / 100;
  const insuranceCost = noTI ? 0 : Math.round((subtotalGoods + gstOnGoods) / 1000 * insuranceRate * 100) / 100;

  // Taxable value = cardamom + gunny + transport + insurance
  const taxableValue = subtotalGoods + transportCost + insuranceCost;

  // All four components get the SAME gstGoods rate (per user confirmation).
  let cgst = 0, sgst = 0, igst = 0;
  if (isInterState) {
    igst = Math.round(taxableValue * gstGoods / 100 * 100) / 100;
  } else {
    cgst = Math.round(taxableValue * (gstGoods / 2) / 100 * 100) / 100;
    sgst = Math.round(taxableValue * (gstGoods / 2) / 100 * 100) / 100;
  }

  const totalBeforeRound = taxableValue + cgst + sgst + igst;
  const roundDiff = Math.round(totalBeforeRound) - totalBeforeRound;
  const subtotalRounded = Math.round(totalBeforeRound);

  // Additional Charge — sum(cardamom) × cfg.addl_charge_value % .
  // The configured value is a PERCENTAGE (e.g. 2 means 2%). Sits BELOW the
  // Round on/off line and adds straight onto the grand total — does not
  // feed into GST or round-off math. When the percentage is 0 the charge
  // is fully skipped (no row, no XML ledger, no effect on grand total).
  const addlChargePct = Number(cfg.addl_charge_value) || 0;
  const addlCharge = addlChargePct > 0
    ? Math.round(totalAmount * addlChargePct) / 100
    : 0;
  const addlChargeName = addlCharge > 0 ? String(cfg.addl_charge_name || '').trim() : '';
  const grandTotalBeforeTds = addlCharge > 0
    ? Math.round((subtotalRounded + addlCharge) * 100) / 100
    : subtotalRounded;

  // ── TDS / TCS on Sales (Task 6) ──────────────────────────────
  // Two feature flags drive the column on the printed invoice and
  // the corresponding ledger in the Tally XML:
  //   - flag_tds_sales : show TDS column (mode = Taxable Amount × rate)
  //   - flag_wgst      : show TDS column (mode = Total Amount  × rate)
  // When BOTH flags are off → no TDS column, no XML ledger, no math.
  // Rate comes from `tcs_tds` (canonical) with `tds_purchase_rate`
  // as a back-compat fallback. Result is rounded to the nearest paisa
  // so it matches the rest of the invoice's 2-decimal precision.
  const tdsSalesFlag = String(cfg.flag_tds_sales).toLowerCase() === 'true';
  const tdsFullFlag  = String(cfg.flag_wgst).toLowerCase() === 'true';
  const tdsRate      = Number(cfg.tcs_tds) || Number(cfg.tds_purchase_rate) || 0;
  let tdsAmount = 0;
  let tdsMode   = '';
  if (tdsRate > 0 && (tdsSalesFlag || tdsFullFlag)) {
    if (tdsFullFlag) {
      // Mode B — applied on the full invoice value (incl. GST + round +
      // additional charge).
      tdsAmount = Math.round(grandTotalBeforeTds * tdsRate / 100 * 100) / 100;
      tdsMode   = 'full';
    } else {
      // Mode A — applied on the taxable amount only (cardamom + gunny +
      // transport + insurance, no GST).
      tdsAmount = Math.round(taxableValue * tdsRate / 100 * 100) / 100;
      tdsMode   = 'taxable';
    }
  }
  const grandTotal = tdsAmount > 0
    ? Math.round((grandTotalBeforeTds + tdsAmount) * 100) / 100
    : grandTotalBeforeTds;

  const _auc = db.get('SELECT ano FROM auctions WHERE id = ?', [auctionId]);
  return {
    buyer: buyer || {},
    saleType,
    auctionNo: _auc ? _auc.ano : '',
    lineItems,
    summary: {
      totalQty, totalBags, totalAmount,
      noTI,   // whether transport & insurance were skipped for this invoice
      gunnyCost, transportCost, insuranceCost,
      taxableValue, cgst, sgst, igst,
      roundDiff, subtotalRounded,
      addlCharge, addlChargeName,
      // TDS/TCS surface (zero when both flags are off)
      tdsRate, tdsAmount, tdsMode,
      grandTotal,
      isInterState
    }
  };
}

/**
 * Build purchase invoice data for a seller
 * Aggregates lots by seller for a given auction (registered dealers only)
 */
// `opts.traderId` / `opts.userId` identify WHICH seller when the name is
// shared. Two dealers can be registered under the same name with different
// GSTINs (real case: two "BASKARAN S", user ids P0002613 / P0003011). Keyed on
// the name alone this built ONE invoice covering both dealers' lots and filed
// it under whichever GSTIN came first — a ₹10,000 purchase from each became a
// single ₹21,000 invoice against one GSTIN, wrong for GST input and for 194Q
// TDS on both sides. The name stays the primary argument so existing callers
// keep working; when they can supply an id, the invoice narrows to that seller.
// ── Lot-wise mode (flag_lotwise_purchase) ────────────────────────────────
// `opts.lotId` / `opts.lotNo` narrow the invoice to a SINGLE lot. Supplying
// either switches this builder from "every lot this dealer sold in the trade"
// (seller-wise, the default and the historical behaviour) to "exactly this one
// lot" (lot-wise). Neither supplied → identical behaviour to before, so every
// existing caller is unaffected.
//
// lotId is preferred because it is exact; lotNo is the fallback for documents
// whose trade was deleted and re-imported under fresh lot ids. lotNo alone is
// only unique WITHIN an auction, which is fine — auctionId is already pinned.
//
// `opts.docNo` is the invoice number this document carries (or is about to be
// assigned). It is used solely to order the 194Q TDS accumulation below; see
// the comment there for why lot-wise mode needs it.
function buildPurchaseInvoice(db, auctionId, sellerName, cfg, opts) {
  opts = opts || {};
  const traderId = (opts.traderId != null && String(opts.traderId).trim() !== '')
    ? Number(opts.traderId) : null;
  // 'import' is the bulk importer's placeholder for "no USER_ID in the file",
  // not a seller key — narrowing on it would match every imported lot.
  const rawUid = String(opts.userId || '').trim();
  const userId = rawUid.toUpperCase() === 'IMPORT' ? '' : rawUid;
  let sellerSql = '', sellerArgs = [];
  if (Number.isFinite(traderId)) { sellerSql = ' AND trader_id = ?'; sellerArgs = [traderId]; }
  else if (userId) { sellerSql = " AND TRIM(COALESCE(user_id,'')) = ?"; sellerArgs = [userId]; }

  // Lot narrowing — appended to (not replacing) the seller filter, so a
  // lot-wise invoice still verifies the lot really belongs to the named
  // seller rather than trusting the lot id alone.
  const lotId = (opts.lotId != null && String(opts.lotId).trim() !== '')
    ? Number(opts.lotId) : null;
  const lotNo = String(opts.lotNo == null ? '' : opts.lotNo).trim();
  let lotSql = '', lotArgs = [];
  if (Number.isFinite(lotId) && lotId > 0) { lotSql = ' AND id = ?'; lotArgs = [lotId]; }
  else if (lotNo) { lotSql = ' AND TRIM(lot_no) = ?'; lotArgs = [lotNo]; }
  const isLotWise = !!lotSql;

  // A lot qualifies for a Purchase Invoice if it has a GSTIN-bearing seller —
  // i.e. cr is either "GSTIN.<15-char>" (legacy UI format) or a bare 15-char
  // GSTIN starting with 2 digits (Excel import format). We accept both.
  let lots = db.all(
    `SELECT * FROM lots
     WHERE auction_id = ? AND name = ? AND amount > 0${sellerSql}${lotSql}
       AND (reserved IS NULL OR reserved = 0)
       AND ${hasValidGstinSql('cr')}
     ORDER BY lot_no`,
    [auctionId, sellerName, ...sellerArgs, ...lotArgs]
  );

  // Re-import recovery: a lot-wise document pinned by lot_id whose trade was
  // deleted and re-imported has a dangling id. Fall back to the lot NUMBER
  // within the same auction+seller, which survives re-import. Without this a
  // reprint would silently drop to the stored-summary path and lose the lot
  // detail — the same failure recoverAgriBillByAno() guards against on bills.
  if (!lots.length && Number.isFinite(lotId) && lotNo) {
    lots = db.all(
      `SELECT * FROM lots
       WHERE auction_id = ? AND name = ? AND amount > 0${sellerSql}
         AND TRIM(lot_no) = ?
         AND (reserved IS NULL OR reserved = 0)
         AND ${hasValidGstinSql('cr')}
       ORDER BY lot_no`,
      [auctionId, sellerName, ...sellerArgs, lotNo]
    );
  }

  if (!lots.length) return null;

  const gstGoods = cfg.gst_goods || 5;
  const companyState = cfg.business_state === 'KERALA' ? '32' : '33';

  // Purchase invoice: TOTAL QTY column = sold qty + sample-refund qty.
  // Matches the same convention used by Bills of Supply so the column
  // means the same thing on both PDFs.
  const sbRefundKgPurchase = Number(cfg.sb_refund) || 0;
  let totalQty = 0, totalPuramt = 0, totalBags = 0, totalRefundQty = 0;
  const lineItems = [];

  for (const lot of lots) {
    const sellerState = gstinStateCode(lot.cr);
    const isInter = sellerState !== companyState;

    const baseQty   = (lot.pqty || lot.qty) || 0;
    const lineTotal = baseQty + sbRefundKgPurchase;
    // Line amount = Total Qty × price (qty + sample-bag refund kg).
    // Previously this was qty-only via lot.puramt — the sample-bag
    // refund kgs went uncharged. GST + grand total now scale with the
    // full delivered weight per the business rule.
    const lineAmount = Math.round(lineTotal * (Number(lot.price) || 0) * 100) / 100;

    const rcgst = isInter ? 0 : Math.round(lineAmount * (gstGoods / 2) / 100 * 100) / 100;
    const rsgst = isInter ? 0 : Math.round(lineAmount * (gstGoods / 2) / 100 * 100) / 100;
    const rigst = isInter ? Math.round(lineAmount * gstGoods / 100 * 100) / 100 : 0;

    totalQty       += lineTotal;
    totalRefundQty += sbRefundKgPurchase;
    totalPuramt    += lineAmount;
    totalBags      += lot.bags || 0;

    lineItems.push({
      lot: lot.lot_no, bags: lot.bags, grade: lot.grade,
      qty: lot.qty, pqty: lot.pqty,
      refundQty: sbRefundKgPurchase,
      totalQty:  lineTotal,
      price: lot.price, prate: lot.prate,
      // amount + puramt both report the Total-Qty-based line amount
      // so the PDF rows and downstream consumers stay in sync.
      amount: lineAmount, puramt: lineAmount,
      com: lot.com, sertax: lot.sertax,
      cgst: rcgst, sgst: rsgst, igst: rigst
    });
  }

  const firstLot = lots[0];
  const sellerState = gstinStateCode(firstLot.cr);
  const isInter = sellerState !== companyState;

  let totalCgst = 0, totalSgst = 0, totalIgst = 0;
  lineItems.forEach(li => { totalCgst += li.cgst; totalSgst += li.sgst; totalIgst += li.igst; });

  const totalBeforeRound = totalPuramt + totalCgst + totalSgst + totalIgst;
  const roundDiff = Math.round(totalBeforeRound) - totalBeforeRound;
  const grandTotal = Math.round(totalBeforeRound);

  // ── TDS calculation (Section 194Q) ──
  //
  // 1) GSTIN format compatibility: the purchases table may have rows with
  //    gstin in either form ("GSTIN.32AAA..." or bare "32AAA..."). We
  //    derive both candidates from the current lot's cr and match either.
  //
  // 2) Amount basis must match: this trade's amount and the running prior
  //    total must be on the SAME basis (both with-GST or both excl-GST),
  //    otherwise the threshold check is inconsistent. The `purchases.total`
  //    column = puramt + GST = grand total (with GST). So:
  //      • flag_wgst=true  → prior=SUM(total), current=grandTotal       ✓
  //      • flag_wgst=false → prior=SUM(amount), current=totalPuramt    ✓
  //    (`purchases.amount` is stored as the pre-GST puramt subtotal.)
  const cr = String(firstLot.cr || '').trim();
  const gstinPrefixed = cr.toUpperCase().startsWith('GSTIN.') ? cr : ('GSTIN.' + cr);
  const gstinBare     = cr.toUpperCase().startsWith('GSTIN.') ? cr.substring(6) : cr;
  //
  // 3) "Prior" means trades that come BEFORE this one, chronologically —
  //    it must NOT include this trade itself, nor any later one. This
  //    function runs twice per invoice: once at generate time (before the
  //    purchases row exists) and again on every PDF re-render (after it
  //    exists, and after later auctions have been invoiced). A plain
  //    "sum everything for this seller this FY" therefore gave a different
  //    answer each time. On a seller's first threshold-crossing trade the
  //    re-render counted the trade in its own `prior`, flipped to the
  //    already-crossed branch and charged TDS on the FULL amount instead
  //    of only the excess — so the PDF disagreed with the stored
  //    `purchases.tds` shown on screen by exactly threshold × rate
  //    (₹5,000 at 50 L / 0.1%). Ordering by (date, auction_id) is stable
  //    on re-render and matches how 194Q actually accumulates.
  //
  // 4) LOT-WISE mode needs a third ordering key. Seller-wise generation puts
  //    at most ONE purchase row per (dealer, auction), so ordering by
  //    (date, auction_id) totally orders a dealer's trades and "prior" is
  //    unambiguous. Lot-wise generation puts N rows there — one per lot —
  //    all sharing the same date AND the same auction_id. Under the
  //    two-key rule every one of those rows excludes all of its siblings,
  //    so each lot computes the same `prior` and each independently
  //    concludes it is the trade that crossed the 50 L threshold. A dealer
  //    crossing on a 5-lot trade would be charged the crossing-trade
  //    calculation five times over.
  //
  //    Within one auction the invoice NUMBER is the sequence in which the
  //    documents were raised, so it is the correct third key: a lot-wise
  //    row counts its same-auction siblings with a SMALLER invoice number
  //    as prior. That ordering is stable on re-render (the number is
  //    stored on the row) and is exactly how the numbers were handed out.
  //
  //    Applied ONLY in lot-wise mode. Seller-wise rows keep the original
  //    two-key rule untouched — the flag must not move a single rupee of
  //    TDS on documents raised the old way.
  const _auc = db.get('SELECT ano, date FROM auctions WHERE id = ?', [auctionId]);
  const aucId   = Number(auctionId);
  const aucDate = _auc ? _auc.date : '';
  const priorAmountCol = cfg.flag_wgst ? 'total' : 'amount';
  const docSeq = parseInt(String(opts.docNo == null ? '' : opts.docNo).trim(), 10);
  const useLotSeq = isLotWise && Number.isFinite(docSeq);
  const siblingSql = useLotSeq
    ? ` OR (date = ? AND COALESCE(auction_id, -1) = ?
            AND TRIM(COALESCE(lot_no,'')) <> ''
            AND CAST(invo AS INTEGER) < ?)`
    : '';
  const priorPurchases = db.get(
    `SELECT COALESCE(SUM(${priorAmountCol}),0) as total
       FROM purchases
      WHERE (gstin = ? OR gstin = ?) AND date >= ?
        AND (date < ? OR (date = ? AND COALESCE(auction_id, -1) < ?)${siblingSql})`,
    [gstinPrefixed, gstinBare, cfg.season_start || '2026-04-01',
     aucDate, aucDate, aucId,
     ...(useLotSeq ? [aucDate, aucId, docSeq] : [])]
  );
  const tdsAmount = cfg.flag_tds_purchase 
    ? calculateTDS(cfg.flag_wgst ? grandTotal : totalPuramt, priorPurchases ? priorPurchases.total : 0, cfg)
    : 0;
  const invoiceAmount = grandTotal - tdsAmount;

  return {
    // trader_id travels with the seller so the caller can stamp it on the
    // purchases row — that is what lets a reprint find the right master
    // later instead of re-guessing from a shared name.
    seller: { name: firstLot.name, address: firstLot.padd, place: firstLot.ppla,
              cr: firstLot.cr, pan: firstLot.pan, state: firstLot.pstate,
              trader_id: firstLot.trader_id != null ? firstLot.trader_id : null },
    auctionNo: _auc ? _auc.ano : '',
    // Lot-wise identity, echoed back so the caller can stamp purchases.lot_no
    // / lot_id without re-querying. Both null on a seller-wise build, which is
    // precisely what marks the stored row as seller-wise.
    lotWise: isLotWise,
    lotNo: isLotWise ? String(firstLot.lot_no || '') : '',
    lotId: isLotWise ? (firstLot.id != null ? firstLot.id : null) : null,
    lineItems,
    summary: {
      totalQty, totalRefundQty, totalBags, totalPuramt, totalCgst, totalSgst, totalIgst,
      roundDiff, grandTotal, tdsAmount, invoiceAmount, isInter
    }
  };
}

/**
 * Generate payment summary for sellers (PAYCHECK.PRG equivalent)
 */
// ── Seller identity in SQL ───────────────────────────────────────────────
// Which seller a lot belongs to, in order of how much the key can be trusted:
//
//   1. trader_id — the real foreign key into `traders`. Unique per master row,
//      so it is the only thing that separates two sellers who share a name.
//   2. user_id   — the Sellers-screen User ID, for lots that carry one.
//      NOTE the 'import' guard: the bulk lot importer defaults this column to
//      the literal string 'import' when the file has no USER_ID, and on a real
//      database that is EVERY row. Treating it as an identity would key every
//      such lot alike, so it is explicitly discarded.
//   3. name      — last resort, for legacy lots with neither. Same grouping
//      these installs have always had.
const SELLER_KEY_SQL = (a) => `COALESCE(
    CASE WHEN ${a}.trader_id IS NOT NULL THEN 'id:' || ${a}.trader_id END,
    CASE WHEN UPPER(TRIM(COALESCE(${a}.user_id,''))) IN ('', 'IMPORT')
         THEN NULL ELSE 'uid:' || TRIM(${a}.user_id) END,
    'name:' || UPPER(TRIM(${a}.name)))`;

function getPaymentSummary(db, auctionId, state, cfg, includeUnpriced) {
  // Per-seller, per-auction payment roll-up for the Payments tab (and the
  // lot-selection modal + payment statement, which must agree with it).
  //   Net Amount = Σ lots.balance  (Amount + Refund − Commission − Handling − GST)
  //   Advance    = per-seller advance already paid (payment_advances table)
  //   Payable    = Net − Advance
  //   Discount   = early-payment settlement discount on immediate-payment lots;
  //                DISPLAY-ONLY (opt-in via auctions.discount_applied) — it does
  //                NOT change Payable.
  // Debit notes are NOT part of this — they are separate documents and do not
  // change the Payments payable (see the note before the settlement-discount
  // block below). The query also pulls per-seller GST sums so the tab can
  // show a "GST 18% (CGST+SGST+IGST)" column.
  // Sellers are identified by USER ID — two masters can share a name (two
  // "BASKARAN S", user ids P0002613 / P0003011) and grouping on the name
  // alone rolled them into one row, hiding that they are different people
  // with different bank accounts. Falls back to the name for legacy lots
  // imported before `lots.user_id` was captured, so those group as before.
  const sellerKeySql = SELLER_KEY_SQL('l');
  let query = `SELECT l.name, l.cr, MAX(l.aadhar) AS aadhar,
    ${sellerKeySql} AS seller_key,
    MAX(l.trader_id) AS trader_id,
    TRIM(COALESCE(l.user_id,'')) AS user_id,
    SUM(l.qty) as total_qty, SUM(l.amount) as total_amount,
    SUM(l.pqty) as total_pqty, SUM(l.prate) as avg_prate,
    SUM(l.puramt) as total_puramt,
    SUM(l.refund) as lot_discount,
    SUM(COALESCE(l.com,0)) as total_commission,
    SUM(COALESCE(l.cgst,0)) as total_cgst,
    SUM(COALESCE(l.sgst,0)) as total_sgst,
    SUM(COALESCE(l.igst,0)) as total_igst,
    SUM(l.balance) as total_payable,
    SUM(CASE WHEN COALESCE(l.immediate_payment,0)=1 THEN l.balance ELSE 0 END) as immediate_payable,
    COUNT(*) as lot_count,
    GROUP_CONCAT(DISTINCT l.bank_id) AS bank_ids,
    COUNT(l.bank_id) AS bank_lot_count,
    MAX(COALESCE(l.immediate_payment,0)) AS any_immediate,
    SUM(COALESCE(l.immediate_payment,0)) AS immediate_lot_count
    FROM lots l WHERE l.auction_id = ?`;
  // Normally only priced lots (amount > 0) count toward the Payments roll-up.
  // `includeUnpriced` relaxes that so sellers whose lots aren't priced yet
  // still appear — lets the operator pre-enter advances BEFORE price import.
  // Their money columns come out 0 (flagged `unpriced` below); exports keep
  // the strict amount>0 filter, so this never leaks into bank/XLSX output.
  if (!includeUnpriced) query += ' AND l.amount > 0';
  const params = [auctionId];
  if (state) { query += ' AND l.state = ?'; params.push(state); }
  query += ` GROUP BY ${sellerKeySql}, l.name, l.cr ORDER BY l.state, l.name`;
  const sellers = db.all(query, params);

  // TDS (u/s 194Q) is held on the purchase invoice — one row per seller per
  // auction in `purchases` — not on the lots. Pull it per seller name so the
  // Payments tab can show a "TDS" column alongside the lot-derived figures.
  // Keyed by trader_id where the purchase carries one, so two same-named
  // dealers get their own TDS instead of one seeing the other's. Falls back to
  // the name for purchases raised before purchases.trader_id existed.
  const tdsRows = db.all(
    `SELECT name, trader_id, SUM(COALESCE(tds,0)) AS tds
       FROM purchases WHERE auction_id = ? GROUP BY trader_id, name`,
    [auctionId]) || [];
  const tdsByName = {}, tdsByTrader = {};
  tdsRows.forEach(r => {
    const v = Number(r.tds) || 0;
    if (r.trader_id != null) tdsByTrader[r.trader_id] = (tdsByTrader[r.trader_id] || 0) + v;
    const k = String(r.name || '').trim().toUpperCase();
    tdsByName[k] = (tdsByName[k] || 0) + v;
  });

  // Per-seller advance already paid (Payments tab "Advance" column). Deducted
  // from the payable: Payable = Net Amount − Advance. Keyed case-insensitively
  // by seller name (same key as the lot rollup / TDS map above).
  const advByName = {};
  const advAtByName = {};
  try {
    const advRows = db.all(
      'SELECT name_key, advance, updated_at FROM payment_advances WHERE auction_id = ?',
      [auctionId]) || [];
    advRows.forEach(r => {
      const k = String(r.name_key || '').trim().toUpperCase();
      // `name_key` is the seller identity: 'id:<trader_id>' for rows written
      // since advances became id-keyed, the bare uppercase name before that.
      advByName[k] = Number(r.advance) || 0;
      advAtByName[k] = r.updated_at || '';   // when the advance was recorded
    });
  } catch (_) { /* table missing on very old DBs — treat as no advances */ }

  // Settlement discount is display-only and opt-in per auction: it stays 0
  // until the operator clicks "Calculate All Discounts" (auctions.discount_applied
  // = 1). When off, every seller's Discount reads 0 on-screen and in exports.
  let discountApplied = 0;
  try {
    const a = db.get('SELECT discount_applied FROM auctions WHERE id = ?', [auctionId]);
    discountApplied = a && Number(a.discount_applied) === 1 ? 1 : 0;
  } catch (_) { discountApplied = 0; }

  // Debit notes are intentionally NOT read here. They are separate
  // documents and no longer affect the Payments payable — the on-screen
  // list, the lot-selection modal, and the bank/XLSX exports all show the
  // same clean net (lots.balance, less the early-payment settlement
  // discount below). Previously this subtracted each seller's debit-note
  // total from Net, which made the screen disagree with the modal.
  // Days-based settlement discount (Payments tab + statement). Pooler vs
  // dealer is inferred from the seller's `cr`: a cr carrying a GSTIN →
  // registered dealer (uses `dealer_days`); anything else → pooler (uses
  // `discount_days`). `discount_pct` is applied directly (₹ per 1000 per
  // day — no ÷100), matching the existing debit-note discount convention.
  const discPct    = Number(cfg && cfg.discount_pct)  || 0;
  const poolerDays = Number(cfg && cfg.discount_days) || 0;
  const dealerDays = Number(cfg && cfg.dealer_days)   || 0;

  return sellers.map(s => {
    const lotDisc = Number(s.lot_discount) || 0;
    const cgst = Number(s.total_cgst) || 0;
    const sgst = Number(s.total_sgst) || 0;
    const igst = Number(s.total_igst) || 0;
    // Net amount = sum of each lot's Payable (lots.balance). No debit-note
    // adjustment — the days-based settlement discount below is taken off THIS.
    const netAmount = Number(s.total_payable) || 0;
    // Previous rule: dealer purely on a valid GSTIN in `cr` (SBL ignored).
    const isDealer = hasValidGstin(s.cr);
    const days = isDealer ? dealerDays : poolerDays;
    // Display-only settlement discount, opt-in per auction via
    // "Calculate All Discounts" (discount_applied). This is the "for ALL
    // sellers at once" mode: the days-based discount is computed on each
    // seller's FULL net amount, not just their immediate-payment lots — so
    // every seller gets a figure even when no lots are flagged immediate.
    // Never affects Payable.
    const sellerDiscount = discountApplied
      ? Math.round(netAmount / 1000 * days * discPct)
      : 0;
    // Advance already paid to this seller (deducted from Payable below).
    const advKey = (s.trader_id != null && advByName[`ID:${s.trader_id}`] != null)
      ? `ID:${s.trader_id}` : String(s.name || '').trim().toUpperCase();
    const advance = advByName[advKey] || 0;
    // Unpriced = this seller has no priced lots yet (all amounts still 0),
    // i.e. price import hasn't run. Only possible when includeUnpriced is set.
    // The UI shows "—" for the money columns and keeps just Advance editable.
    const unpriced = (Number(s.total_amount) || 0) <= 0;
    return {
      ...s,
      unpriced,
      // Per-seller commission (lots.com) — shown in the Payments "Commission"
      // column. Independent of discount; does not affect payable.
      total_commission: Number(s.total_commission) || 0,
      total_tax: cgst + sgst + igst,
      // TDS deducted on this seller's purchase invoice (194Q). Display-only —
      // does not alter net/payable here.
      tds: (s.trader_id != null && tdsByTrader[s.trader_id] != null)
        ? tdsByTrader[s.trader_id]
        : (tdsByName[String(s.name || '').trim().toUpperCase()] || 0),
      // Purchase = sale amount + sample-bag refund (the base commission is
      // charged on), summed per seller.
      purchase_value: (Number(s.total_amount) || 0) + lotDisc,
      // Seller classification + the new days-based settlement discount.
      seller_type: isDealer ? 'dealer' : 'pooler',
      net_amount: netAmount,
      seller_discount: sellerDiscount,
      // Whether the display-only settlement discount has been applied for this
      // auction. Lets the UI/statement distinguish "0 discount" from "not yet
      // calculated" and drives the reference line on the payment statement.
      discount_applied: discountApplied,
      // Advance already paid — user-entered per seller on the Payments tab.
      advance,
      // When the advance was recorded (payment_advances.updated_at) — drives
      // the "Advance paid on {date}" badge in the Advance column.
      advance_at: advAtByName[advKey] || '',
      // True when this seller's lots point at more than one bank account
      // (or a mix of tagged + untagged). Drives the "multiple banks" badge
      // on the Payments table so the user knows to export each account's
      // lots separately via the per-seller lot picker.
      multipleBanks: (() => {
        const ids = String(s.bank_ids || '').split(',')
          .map(x => x.trim()).filter(x => x !== '' && x !== 'null');
        const untagged = Number(s.lot_count || 0) > Number(s.bank_lot_count || 0);
        const distinct = new Set(ids).size;
        return distinct > 1 || (distinct >= 1 && untagged);
      })(),
      // Final payable = net amount − advance already paid. The settlement
      // discount is display-only and intentionally NOT subtracted here.
      total_payable: netAmount - advance,
    };
  });
}

/**
 * Generate bank payment data (BANKPAY.PRG — RTGS/NEFT format).
 * Used by both the "after discount" Bank Payment export (default) and
 * the "Bank Payment (Before)" export when `opts.before === true`.
 */
// Format a raw GROUP_CONCAT(lot_no) string into a clean, de-duped,
// numerically-sorted comma list for the bank payment REMARKS column
// (e.g. "12,13,14"). Returns '' when there are no lots.
function formatLotList(raw) {
  if (!raw) return '';
  const uniq = [...new Set(String(raw).split(',').map(s => s.trim()).filter(Boolean))];
  const allNumeric = uniq.every(x => /^\d+$/.test(x));
  uniq.sort(allNumeric ? (a, b) => Number(a) - Number(b) : undefined);
  return uniq.join(',');
}

// Sort key for `opts.orderByLot` — a bank row covers one or more lots, so it
// sorts on the SMALLEST lot it pays for. Numeric lot numbers order numerically
// and ahead of non-numeric ones, which fall to the end ordered as text; a row
// with no lots at all sorts last. Returns [number, text] compared in order.
function lotSortKey(lotList) {
  let num = Infinity, txt = null;
  for (const x of String(lotList || '').split(',')) {
    const t = x.trim();
    if (!t) continue;
    if (/^\d+$/.test(t)) { const n = Number(t); if (n < num) num = n; }
    else if (txt === null || t < txt) txt = t;
  }
  return [num, txt === null ? '' : txt];
}

function getBankPaymentData(db, auctionId, cfg, opts) {
  opts = opts || {};
  const useBefore = !!opts.before;
  // Identity keys ('id:<trader_id>') from the Payments tab's tracked export.
  // When present they take precedence over the name filter — ticking one of
  // two same-named sellers must export only that one.
  const sellerKeyFilter = (Array.isArray(opts.sellerKeys) && opts.sellerKeys.length)
    ? new Set(opts.sellerKeys.map(k => String(k).trim().toUpperCase()))
    : null;
  const sellersFilter = (Array.isArray(opts.sellers) && opts.sellers.length)
    ? new Set(opts.sellers.map(s => String(s).trim().toUpperCase()))
    : null;
  // Per-seller lot-picks + already-exported exclusions (Payments tab's
  // tracked-export flow). Each is { sellerName: ['lot_no', ...] }, keyed
  // case-insensitively. lots → keep ONLY these lots; excludeLots → skip
  // these (already shipped in a prior export, so don't re-pay them).
  const _upMap = (m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const o = {}; let any = false;
    for (const k of Object.keys(m)) {
      const arr = Array.isArray(m[k]) ? m[k].map(x => String(x).trim()).filter(Boolean) : [];
      if (arr.length) { o[String(k).trim().toUpperCase()] = arr; any = true; }
    }
    return any ? o : null;
  };
  const lotPicks    = _upMap(opts.lots);
  const excludeLots = _upMap(opts.excludeLots);
  const hasLotFilter = !!(lotPicks || excludeLots);
  let bankById = {};
  if (hasLotFilter) {
    try { for (const b of db.all('SELECT id, ifsc, acctnum, holder_name FROM trader_banks')) bankById[b.id] = b; } catch (_) {}
  }
  // Bank Payment lists every seller in the trade with a non-zero
  // payable (or non-zero pre-discount amount in 'before' mode) — both
  // registered dealers AND unregistered (URD/agriculturist) farmers.
  // The earlier WHERE clause filtered to URD-only by excluding rows
  // whose `cr` looked like a GSTIN. That came from the legacy FoxPro
  // BANKPAY.PRG which only handled farmers — but the e-Auction flow pays
  // every seller via RTGS/NEFT, so all sellers must be included.
  // Result was: registered dealers had IFSC + acctnum on file, but the
  // SQL excluded them and returned empty rows, so the export was blank.
  //
  // Bank details come from `traders` (single-bank legacy) or
  // `trader_banks` (multi-bank). The LEFT JOIN to traders pulls
  // address/IFSC; we then COALESCE with trader_banks default for
  // sellers who maintain multiple bank accounts.
  // The seller is identified by USER ID, not by name. Two different sellers
  // can carry the same name (real case: two "BASKARAN S", user ids P0002613
  // and P0003011, different phones and different bank accounts) and keying on
  // the name conflated them in two separate ways:
  //
  //   • the LEFT JOIN matched BOTH master rows, so every lot fanned out into
  //     two result rows and the SUMs came out DOUBLED — a two-lot ₹20,000
  //     trade exported as a single ₹40,000 payment;
  //   • whichever master row the join happened to land on supplied the
  //     phone / IFSC / account for BOTH sellers, so one seller's money was
  //     routed into the other's account.
  //
  // Fix: aggregate with NO join (nothing to fan out), grouped by the lot's
  // own seller identity, then resolve the master row per group in JS. The
  // identity falls back to the name for legacy lots imported before
  // `lots.user_id` was captured, so those installs group exactly as before.
  const sellerKeySql = SELLER_KEY_SQL('l');
  let payments = db.all(
    `SELECT l.state, l.name, l.cr,
      ${sellerKeySql} AS seller_key,
      MAX(l.trader_id) AS lot_trader_id,
      TRIM(COALESCE(l.user_id,'')) AS user_id,
      SUM(l.puramt) as puramt, SUM(l.refund) as advance, SUM(l.balance) as payable,
      GROUP_CONCAT(l.lot_no) AS lot_nos
    FROM lots l
    WHERE l.auction_id = ? AND l.amount > 0
      AND (l.paid IS NULL OR l.paid = '')
    GROUP BY ${sellerKeySql}, l.name, l.cr
    ORDER BY l.state, l.name`,
    [auctionId]
  );

  // Resolve each group's master row: by user id first, then by name for lots
  // that predate user-id capture. Name lookup keeps the lowest id so it stays
  // deterministic when the name IS duplicated (there is nothing better to go
  // on for such a lot — but it no longer corrupts the other seller's row).
  const traderById = {}, traderByUserId = {}, traderByName = {};
  for (const t of db.all(
    `SELECT id, name, user_id, ifsc, acctnum, holder_name, padd, ppla, pin, tel
       FROM traders ORDER BY id`)) {
    traderById[t.id] = t;
    const uid = String(t.user_id || '').trim().toUpperCase();
    const nm  = String(t.name    || '').trim().toUpperCase();
    if (uid && traderByUserId[uid] == null) traderByUserId[uid] = t;
    if (nm  && traderByName[nm]    == null) traderByName[nm]    = t;
  }
  payments.forEach(p => {
    // trader_id FIRST — it is the only key that separates two sellers who
    // share a name. user_id is a fallback for lots with no FK ('import' is the
    // importer's placeholder, not a key), and the name is the last resort.
    const rawUid = String(p.user_id || '').trim().toUpperCase();
    const uid = rawUid === 'IMPORT' ? '' : rawUid;
    const t = (p.lot_trader_id != null && traderById[p.lot_trader_id])
           || (uid && traderByUserId[uid])
           || traderByName[String(p.name || '').trim().toUpperCase()]
           || null;
    p.trader_id = t ? t.id : null;
    p.t_ifsc    = t ? t.ifsc        : '';
    p.t_acctnum = t ? t.acctnum     : '';
    p.t_holder  = t ? t.holder_name : '';
    p.t_tel     = t ? t.tel         : '';
    p.padd      = t ? t.padd        : '';
    p.ppla      = t ? t.ppla        : '';
    p.pin       = t ? t.pin         : '';
  });
  if (sellerKeyFilter) {
    payments = payments.filter(p => sellerKeyFilter.has(String(p.seller_key || '').trim().toUpperCase()));
  } else if (sellersFilter) {
    payments = payments.filter(p => sellersFilter.has(String(p.name || '').trim().toUpperCase()));
  }

  // Per-seller bank-details fallback chain:
  //   1. trader_banks default (is_default=1) — picks the explicitly
  //      flagged primary account when the seller has multiple banks
  //   2. trader_banks first row — when no default flagged
  //   3. traders.ifsc/acctnum — legacy single-bank
  // Pre-fetch all default banks once (cheaper than per-seller query).
  const bankByTraderId = {};
  try {
    const banks = db.all(`
      SELECT trader_id, ifsc, acctnum, holder_name, is_default, id
        FROM trader_banks
       ORDER BY trader_id, is_default DESC, id ASC
    `);
    for (const b of banks) {
      // First row per trader_id wins (already sorted by is_default DESC).
      if (bankByTraderId[b.trader_id] == null) bankByTraderId[b.trader_id] = b;
    }
  } catch (_) { /* trader_banks may not exist on partial migrations */ }

  // Per-seller advance already paid — deducted from the bank payout so the
  // exported amount matches the Payments tab's Payable (Net − Advance). Applied
  // only to whole-seller rows; partial (lot-picked) exports pay the picked lots
  // at face value since a seller-level advance can't be split across lots.
  const advanceByName = {};
  try {
    const advRows = db.all('SELECT name_key, advance FROM payment_advances WHERE auction_id = ?', [auctionId]) || [];
    advRows.forEach(r => { advanceByName[String(r.name_key || '').trim().toUpperCase()] = Number(r.advance) || 0; });
    // 'ID:<trader_id>' keys are exact — no same-name ambiguity to guard against.
  } catch (_) { /* table missing on old DBs — no advances */ }

  const auction = db.get('SELECT * FROM auctions WHERE id = ?', [auctionId]);
  const roundAmounts = cfg.flag_round;

  // Build one bank-payment output row for seller `p`. `rawAmount` is the
  // pre-round amount, `lotList` the formatted lot numbers for REMARKS, and
  // `routedBank` (or null → seller-default fallback chain) the destination.
  const buildRow = (p, rawAmount, lotList, routedBank) => {
    const amount = roundAmounts ? Math.round(rawAmount) : rawAmount;
    // The lots this row actually pays for: the picked subset when the caller
    // filtered, otherwise every lot the seller has in this trade.
    const rowLots = lotList || formatLotList(p.lot_nos || '');
    const tb = p.trader_id != null ? bankByTraderId[p.trader_id] : null;
    const ifsc      = (routedBank && routedBank.ifsc)        || (tb && tb.ifsc)        || p.t_ifsc    || '';
    const acctnum   = (routedBank && routedBank.acctnum)     || (tb && tb.acctnum)     || p.t_acctnum || '';
    const holderNm  = (routedBank && routedBank.holder_name) || (tb && tb.holder_name) || p.t_holder  || p.name;
    return {
      transactionType: rawAmount >= 200000 ? 'RTGS' : 'NEFT',
      // Firm's own account that funds are debited from. Kerala account per
      // config; same value on every row (single debit account for the batch).
      debitAccount: (cfg && cfg.bank_kl_acct) || '',
      // Beneficiary account type (SB/CA) is not stored per seller — left
      // blank for the user to fill before upload.
      accountType: '',
      ifsc,
      accountNo: acctnum,
      beneficiaryName: holderNm,
      address1: p.padd || '',
      address2: p.ppla || '',
      pin: p.pin || '',
      amount,
      remarks: `${auction ? auction.ano : ''} ${p.name} PAYMENT ${rawAmount.toFixed(2)} Credited${lotList ? ` for lot${lotList.includes(',') ? 's' : ''} ${lotList}` : ''}`,
      holderName: holderNm,
      // Seller phone + CR carried for presentation-only bank formats (e.g. the
      // HDFC A/C sheet's Phone column). `cr` is the leading candidate for that
      // format's "Particulars" column.
      phone: p.t_tel || '',
      cr: p.cr || '',
      // Particulars — Auction No + space + lot no(s) (e.g. "A10 024"). Uses the
      // picked lots when this is a lot-filtered export, otherwise all of the
      // seller's lots for this auction.
      particulars: `${auction ? auction.ano : ''} ${rowLots}`.trim(),
      // Internal only — the orderByLot sort reads it and it is stripped before
      // the rows are returned, so no bank format can accidentally print it.
      _lotList: rowLots,
    };
  };

  // `payment_advances` is keyed by NAME, so when one name covers two sellers
  // the advance cannot be attributed to either. Deducting it from both would
  // pay out less than is owed, so it is applied to the first group only —
  // the trade still settles exactly Payable − Advance in total.
  const groupsPerName = {};
  payments.forEach(p => {
    const n = String(p.name || '').trim().toUpperCase();
    groupsPerName[n] = (groupsPerName[n] || 0) + 1;
  });
  const advanceTaken = {};

  let result = payments.flatMap(p => {
    // 'before' uses puramt — pre-discount, useful when paying suppliers
    // before the deduction policy is applied. 'after' (default) uses
    // payable = puramt − discount − GST.
    const nameUpper = String(p.name || '').trim().toUpperCase();
    // Picks/exclusions arrive keyed by seller identity from the Payments tab,
    // or by name from older callers. Identity wins so a same-named seller's
    // picks are never applied to this one.
    const skUpper    = String(p.seller_key || '').trim().toUpperCase();
    const picksArr   = lotPicks    ? (lotPicks[skUpper]    || lotPicks[nameUpper])    : null;
    const excludeArr = excludeLots ? (excludeLots[skUpper] || excludeLots[nameUpper]) : null;
    if (!((picksArr && picksArr.length) || (excludeArr && excludeArr.length))) {
      // No lot filter for this seller → one seller-level row, default bank.
      // Deduct any advance already paid so the payout equals the on-screen
      // Payable (Net − Advance). Clamp at 0 so an advance ≥ payable never
      // produces a negative bank line.
      // An id-keyed advance belongs to exactly this seller — take it as is.
      // Only the legacy name-keyed fallback needs the once-only guard, because
      // one such row cannot be attributed between two same-named sellers.
      const idKey = (p.lot_trader_id != null) ? `ID:${p.lot_trader_id}` : null;
      let adv = 0;
      if (idKey && advanceByName[idKey] != null) {
        adv = advanceByName[idKey];
      } else {
        adv = advanceByName[nameUpper] || 0;
        if (adv && groupsPerName[nameUpper] > 1) {
          if (advanceTaken[nameUpper]) adv = 0;
          else advanceTaken[nameUpper] = true;
        }
      }
      const base = Math.max(0, (useBefore ? (p.puramt || 0) : (p.payable || 0)) - adv);
      return [buildRow(p, base, '', null)];
    }
    // Re-sum balance/puramt over ONLY the picked (and not-excluded) lots
    // so the bank row pays exactly what's being settled now. Group the
    // covered lots BY bank account so a selection that spans multiple banks
    // produces one payment line per bank (NULL bank_id = untagged lots,
    // grouped together and routed to the seller-default account).
    // Scope to THIS seller by the same identity the aggregate grouped on —
    // matching on the name alone would pull a same-named seller's lots into
    // this row (and into theirs), paying both lots twice over.
    const params = [auctionId, p.seller_key];
    let extra = '';
    if (picksArr && picksArr.length)    { extra += ` AND l.lot_no IN (${picksArr.map(() => '?').join(',')})`;     for (const x of picksArr)   params.push(String(x)); }
    if (excludeArr && excludeArr.length){ extra += ` AND l.lot_no NOT IN (${excludeArr.map(() => '?').join(',')})`; for (const x of excludeArr) params.push(String(x)); }
    const groups = db.all(
      `SELECT l.bank_id AS bank_id,
              COALESCE(SUM(l.balance),0) AS payable, COALESCE(SUM(l.puramt),0) AS puramt,
              GROUP_CONCAT(l.lot_no) AS lot_nos
         FROM lots l WHERE l.auction_id = ? AND l.amount > 0
          AND (l.paid IS NULL OR l.paid = '') AND ${sellerKeySql} = ?${extra}
        GROUP BY l.bank_id`,
      params
    ) || [];
    // Only banks we can actually route to count toward "spans multiple banks".
    const taggedBanks = groups.filter(g => g.bank_id != null && bankById[g.bank_id]);
    const hasUntagged = groups.some(g => g.bank_id == null || !bankById[g.bank_id]);
    const amtOf = g => useBefore ? (Number(g.puramt) || 0) : (Number(g.payable) || 0);

    // Split into one row per destination whenever the covered lots don't all
    // pay into the same place — either several tagged banks, or one tagged
    // bank alongside untagged lots that follow the seller's default.
    //
    // That second case used to fall through to the merged row below, which
    // paid the tagged lot into the DEFAULT account — silently discarding an
    // explicit per-lot choice the operator had made. Splitting here routes
    // each group where it was told to go (untagged group → null → default).
    if (taggedBanks.length >= 2 || (taggedBanks.length === 1 && hasUntagged)) {
      return groups.map(g => buildRow(
        p, amtOf(g), formatLotList(g.lot_nos || ''),
        (g.bank_id != null && bankById[g.bank_id]) || null
      ));
    }
    // Everything lands in one account — all lots untagged (→ seller default),
    // or all tagged to the same bank. One merged row, as before.
    const rawAmount = groups.reduce((s, g) => s + amtOf(g), 0);
    const lotList = formatLotList(groups.map(g => g.lot_nos || '').filter(Boolean).join(','));
    const routedBank = (taggedBanks.length === 1 && !hasUntagged)
      ? bankById[taggedBanks[0].bank_id]
      : null;
    return [buildRow(p, rawAmount, lotList, routedBank)];
  });
  // When lot-filtering is active, drop rows that net to zero — a seller
  // whose remaining (un-exported) lots all net to zero shouldn't appear.
  if (hasLotFilter) result = result.filter(r => Number(r.amount) > 0);
  // Lot-wise Payments exports what the operator sees, in the order they see it:
  // that screen lists lots ascending, so the bank sheet does too. Every other
  // caller keeps the seller-wise `ORDER BY l.state, l.name` above untouched.
  // A row can cover several lots, so it sorts on its smallest one; the original
  // index breaks ties so equal keys stay in their seller-wise order.
  if (opts.orderByLot) {
    result = result
      .map((r, i) => ({ r, i, k: lotSortKey(r._lotList) }))
      .sort((a, b) =>
        (a.k[0] - b.k[0]) ||
        (a.k[1] < b.k[1] ? -1 : a.k[1] > b.k[1] ? 1 : 0) ||
        (a.i - b.i))
      .map(x => x.r);
  }
  result.forEach(r => { delete r._lotList; });
  return result;
}

/**
 * TDS return data (TDSRETU.PRG equivalent)
 */
function getTDSReturnData(db, fromDate, toDate, orderBy) {
  const order = orderBy === 'party' ? 'name' : 'date, invo';
  // PAN extraction. The gstin column holds either:
  //   "GSTIN.32AAHCE4551A1Z8" (21 chars, with prefix — most common)
  //   "32AAHCE4551A1Z8"       (15 chars, bare GSTIN)
  // Strip the optional "GSTIN." prefix first, then take chars 3-12 of
  // the bare GSTIN to get the 10-char PAN ("AAHCE4551A").
  return db.all(
    `SELECT invo as invoice, date, name,
      SUBSTR(
        CASE WHEN UPPER(SUBSTR(COALESCE(gstin,''), 1, 6)) = 'GSTIN.'
             THEN SUBSTR(gstin, 7)
             ELSE COALESCE(gstin,'') END,
        3, 10
      ) as pan,
      amount as assess_value, tds
    FROM purchases
    WHERE date BETWEEN ? AND ? AND tds > 0
    ORDER BY ${order}`,
    [fromDate, toDate]
  );
}

/**
 * Build Agriculturist Bill of Supply (GSTKBILP/GSTBILP equivalent)
 * For sellers WITHOUT GSTIN — agricultural produce from farmers.
 * No GST charged (exempt/reverse charge).
 * 
 * Returns: { seller, lineItems, summary } if successful
 *          { error, detail } object if no data (to help debug)
 */
// `opts.traderId` / `opts.userId` pick ONE seller when the name is shared —
// see the note on buildPurchaseInvoice. Without it two same-named planters
// were billed on a single Bill of Supply.
function buildAgriBill(db, auctionId, sellerName, cfg, opts) {
  const trimmedName = String(sellerName || '').trim();
  if (!trimmedName) return { error: 'Seller name is empty' };
  opts = opts || {};
  const traderId = (opts.traderId != null && String(opts.traderId).trim() !== '')
    ? Number(opts.traderId) : null;
  // 'import' is the bulk importer's placeholder for "no USER_ID in the file",
  // not a seller key — narrowing on it would match every imported lot.
  const rawUid = String(opts.userId || '').trim();
  const userId = rawUid.toUpperCase() === 'IMPORT' ? '' : rawUid;
  let sellerSql = '', sellerArgs = [];
  if (Number.isFinite(traderId)) { sellerSql = ' AND trader_id = ?'; sellerArgs = [traderId]; }
  else if (userId) { sellerSql = " AND TRIM(COALESCE(user_id,'')) = ?"; sellerArgs = [userId]; }

  // ── Lot-wise mode (flag_lotwise_bills) ─────────────────────────────
  // opts.lotId / opts.lotNo narrow the bill to a SINGLE lot. Neither supplied
  // → unchanged seller-wise behaviour, so existing callers are unaffected.
  // See buildPurchaseInvoice for why lotId is preferred and lotNo is the
  // re-import fallback.
  const lotId = (opts.lotId != null && String(opts.lotId).trim() !== '')
    ? Number(opts.lotId) : null;
  const lotNo = String(opts.lotNo == null ? '' : opts.lotNo).trim();
  let lotSql = '', lotArgs = [];
  if (Number.isFinite(lotId) && lotId > 0) { lotSql = ' AND id = ?'; lotArgs = [lotId]; }
  else if (lotNo) { lotSql = ' AND TRIM(lot_no) = ?'; lotArgs = [lotNo]; }
  const isLotWise = !!lotSql;

  // First check: any lots at all for this seller (case-insensitive)?
  let allLots = db.all(
    `SELECT * FROM lots WHERE auction_id = ? AND UPPER(TRIM(name)) = UPPER(?)${sellerSql}${lotSql} ORDER BY lot_no`,
    [auctionId, trimmedName, ...sellerArgs, ...lotArgs]
  );

  // Re-import recovery — a stale lot_id falls back to the lot NUMBER, which
  // survives a delete-and-reimport of the trade. Without this a lot-wise
  // bill's PDF would drop to the stored snapshot and lose live pricing.
  if (!allLots.length && Number.isFinite(lotId) && lotNo) {
    allLots = db.all(
      `SELECT * FROM lots WHERE auction_id = ? AND UPPER(TRIM(name)) = UPPER(?)${sellerSql} AND TRIM(lot_no) = ? ORDER BY lot_no`,
      [auctionId, trimmedName, ...sellerArgs, lotNo]
    );
  }

  if (!allLots.length) {
    return { error: isLotWise
      ? `Lot ${lotNo || lotId} not found for seller "${trimmedName}" in this auction.`
      : `No lots found for seller "${trimmedName}" in this auction. Check the exact spelling.` };
  }

  // Registered-dealer lots aren't eligible for a Bill of Supply; planter lots
  // are. Previous rule: dealer purely on a valid GSTIN in `cr` (SBL ignored),
  // so any GSTIN-bearing seller is a dealer regardless of SBL.
  const withGstin = allLots.filter(l => hasValidGstin(l.cr));
  const withoutGstin = allLots.filter(l => !hasValidGstin(l.cr));

  if (withGstin.length && !withoutGstin.length) {
    return { error: `Seller "${trimmedName}" is a registered dealer (GSTIN ${withGstin[0].cr}). Use Generate Purchase Invoice instead — Bills of Supply are only for non-GSTIN planters.` };
  }

  // Filter to agri-eligible lots with amount > 0 (reserved lots are held, not
  // booked, so they never appear on a bill).
  const lots = withoutGstin.filter(l => (l.amount || 0) > 0 && !Number(l.reserved));

  if (!lots.length) {
    if (withoutGstin.length) {
      return { error: `Seller "${trimmedName}" has ${withoutGstin.length} lot(s) but none have amount > 0. Set prices on the lots first (or click Calculate All).` };
    }
    return { error: `No eligible lots for "${trimmedName}"` };
  }

  // Bills of Supply: TOTAL QTY column = sold qty + sample-refund qty
  // (the kgs retained by the company as sample bags). sb_refund is the
  // config-driven kg-per-lot value used by every other report. Stamped
  // on each line so the PDF can render "Qty" and "Total Qty" distinctly.
  const sbRefundKg = Number(cfg.sb_refund) || 0;
  let totalQty = 0, totalPuramt = 0, totalRefundQty = 0;
  const lineItems = [];

  for (const lot of lots) {
    const baseQty   = (lot.pqty || lot.qty) || 0;
    const lineTotal = baseQty + sbRefundKg;
    // Line amount = Total Qty × price (qty + sample-bag refund kg).
    // Previously this was qty-only via lot.puramt — the sample-bag
    // refund kgs went uncharged on the Bill of Supply.
    const lineAmount = Math.round(lineTotal * (Number(lot.price) || 0) * 100) / 100;
    totalQty       += lineTotal;
    totalRefundQty += sbRefundKg;
    totalPuramt    += lineAmount;
    lineItems.push({
      lot: lot.lot_no, qty: lot.qty, pqty: lot.pqty,
      refundQty: sbRefundKg,
      totalQty: lineTotal,
      price: lot.price, prate: lot.prate,
      amount: lineAmount, puramt: lineAmount,
      com: lot.com, sertax: lot.sertax
    });
  }

  const firstLot = lots[0];
  const roundDiff = cfg.flag_round ? Math.round(totalPuramt) - totalPuramt : 0;
  const netAmount = Math.round(totalPuramt);

  return {
    seller: {
      name: firstLot.name,
      address: firstLot.padd,
      place: firstLot.ppla,
      pin: firstLot.ppin,
      state: firstLot.pstate,
      st_code: firstLot.pst_code,
      cr: firstLot.cr,
      pan: firstLot.pan,
      aadhar: firstLot.aadhar,
      tel: firstLot.tel,
      // See the note in buildPurchaseInvoice — stamped onto bills.trader_id.
      trader_id: firstLot.trader_id != null ? firstLot.trader_id : null,
    },
    // Lot-wise identity, echoed back so the caller can stamp bills.lot_no /
    // lot_id. Both blank on a seller-wise build — which is what marks the
    // stored row seller-wise.
    lotWise: isLotWise,
    lotNo: isLotWise ? String(firstLot.lot_no || '') : '',
    lotId: isLotWise ? (firstLot.id != null ? firstLot.id : null) : null,
    lineItems,
    summary: {
      totalQty, totalRefundQty, totalPuramt,
      roundDiff, netAmount,
      cgst: 0, sgst: 0, igst: 0,
      tax: 0
    }
  };
}

/**
 * List agri-eligible sellers for an auction
 * (sellers without GSTIN who have lots with amount > 0)
 */
function listAgriSellers(db, auctionId) {
  // An "agri seller" is a planter — i.e. a seller WITHOUT a valid GSTIN in
  // `cr` (previous rule; SBL/aadhar not considered). CR-coded and blank-cr
  // sellers qualify; any GSTIN-bearing seller does not.
  // Grouped by the seller's identity, not just the name: two planters can
  // share a name, and grouping on the name alone put both on ONE Bill of
  // Supply. trader_id is the real key; user_id covers lots imported before
  // the FK existed; the name is the last resort so legacy rows still group
  // exactly as before. The id/user id travel back so the caller can bill the
  // right one.
  return db.all(
    `SELECT name, MAX(trader_id) AS trader_id,
            CASE WHEN UPPER(TRIM(COALESCE(MAX(user_id),''))) IN ('','IMPORT')
                 THEN '' ELSE TRIM(MAX(user_id)) END AS user_id,
            COUNT(*) as lot_count, SUM(qty) as total_qty, SUM(amount) as total_amount
     FROM lots
     WHERE auction_id = ?
       AND NOT ${hasValidGstinSql('cr')}
       AND amount > 0
     GROUP BY COALESCE(trader_id, -1), UPPER(TRIM(name))
     -- Case-insensitive alphabetical. A plain ORDER BY name uses SQLite's
     -- binary collation, which files every lowercase name after every
     -- uppercase one ("Anil" landing below "ZZZ"). This order is also the
     -- numbering scheme for Bills of Supply: /api/bills/generate-all walks
     -- this list and hands out bill numbers as it goes.
     ORDER BY UPPER(TRIM(name))`,
    [auctionId]
  );
}

// Convert YYYY-MM-DD (SQLite date) → dd/mm/yyyy for display in
// journal exports. Falls through unchanged if the input doesn't match.
function _ddmmyyyy(d) {
  if (!d) return '';
  const s = String(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}

// ── PROFORMA MODE for the Sales Journal (flag_proforma_invoice) ──────────
//
// OFF (the default) — the journal is the ORIGINAL tax-invoice register it has
// always been: raised originals only, bare "I 2009" numbers, drafts excluded.
//
// ON — the journal follows the document the BUYER holds, matching Collection,
// the Buyer Statement and the Merchants XML:
//   • the invoice-number cell quotes the PROFORMA number ("PI/L-8"), falling
//     back to the bare original for invoices billed with no draft behind them;
//   • PENDING drafts (nothing raised from them yet) are listed as rows of their
//     own. Once a draft is raised, the original it became is already in the row
//     set, so counting both would double the buyer.
//
// NOTE the consequence of that second rule: unbilled drafts carry their value —
// and their GST — into the register, so the journal and its ledger summary no
// longer foot to the GST returns for the trade. That is intentional here (a
// register of what the buyers hold), and it is exactly why the SALES VOUCHERS
// Tally export does NOT do this — posting a draft there would create output-tax
// entries for a tax invoice that was never issued. Keep the two apart.
//
// `_proformaMode` resolves the flag + prefix once. Callers may pass a cfg they
// already loaded; otherwise it reads settings itself.
function _proformaMode(db, cfg) {
  const c = cfg || getSettingsFlat(db);
  const on = String((c && c.flag_proforma_invoice) || '').toLowerCase() === 'true'
    || (c && c.flag_proforma_invoice) === true;
  return { on, prefix: String((c && c.proforma_invoice_prefix) || '').trim() };
}

// Row filter shared by the journal and its ledger summary, so the summary
// always totals exactly the rows the journal printed.
function _journalProformaSql(on) {
  return on
    ? `(COALESCE(is_proforma,0) = 0
        OR (COALESCE(is_proforma,0) = 1 AND TRIM(COALESCE(raised_invo,'')) = ''))`
    : `COALESCE(is_proforma,0) = 0`;
}

// ── Register order ───────────────────────────────────────────────────────
// The journal is ordered by the invoice number it PRINTS: sale letter first,
// then the number NUMERICALLY —
//     PI/I-1, PI/I-2, PI/I-20, PI/L-1, PI/L-10
// Two things were wrong with ordering on the stored `invo` text in SQL:
//   • TEXT collation puts "10" ahead of "2", so PI/I-10 printed above PI/I-2;
//   • in proforma mode the printed cell is the DRAFT's number, which is
//     numbered independently of the original behind it — so the register was
//     sorted on a number it never shows.
// The draft also carries its OWN sale letter (a lot can be drafted Local and
// billed Inter-state), which is why the letter is read off the printed cell
// rather than off `row.sale`.
//
// Splits print as "PI/L-8, PI/L-9" — the first number positions the row.
// A cell with no number at all sorts last rather than jumping to the top.
function _invoCellSortKey(cell) {
  const first = String(cell == null ? '' : cell).split(',')[0].trim();
  const digits = (first.match(/(\d+)\s*$/) || [])[1];
  const letter = (first.match(/([A-Za-z])\s*[-\s]\s*\d+\s*$/) || [])[1] || '';
  return {
    letter: letter.toUpperCase(),
    num: digits ? parseInt(digits, 10) : Number.MAX_SAFE_INTEGER,
    raw: first.toUpperCase(),
  };
}
// Stable: rows whose keys tie keep the SQL order (date, sale, invo).
function _byInvoCell(cellOf) {
  return (a, b) => {
    const ka = _invoCellSortKey(cellOf(a)), kb = _invoCellSortKey(cellOf(b));
    if (ka.letter !== kb.letter) return ka.letter < kb.letter ? -1 : 1;
    if (ka.num !== kb.num) return ka.num - kb.num;
    return ka.raw.localeCompare(kb.raw);
  };
}

/**
 * Sales Journal (JOUR.PRG)
 * Trade-wise sales invoice register. Filters invoices by auction id
 * (resolved via auctions.ano so old invoices with a NULL auction_id
 * still match by ano). Dates rendered dd/mm/yyyy.
 *
 * With flag_proforma_invoice on, `invo` carries the proforma number the buyer
 * holds and pending drafts join the register — see the note above.
 *
 * Rows come out in printed-invoice-number order — see _invoCellSortKey().
 */
function getSalesJournal(db, auctionId, saleType, cfg) {
  const auction = db.get('SELECT id, ano FROM auctions WHERE id = ?', [auctionId]);
  if (!auction) return [];
  const pf = _proformaMode(db, cfg);
  let query = `SELECT date, sale, invo, buyer, buyer1, gstin, place,
      bag, qty, amount as cardamom, gunny, pava_hc as transport, ins as insurance,
      cgst, sgst, igst, tcs, rund, tot as total,
      COALESCE(is_proforma,0) AS is_proforma
    FROM invoices WHERE (auction_id = ? OR ano = ?) AND ${_journalProformaSql(pf.on)}`;
  const params = [auction.id, auction.ano];
  if (saleType) { query += ' AND sale = ?'; params.push(saleType); }
  query += ' ORDER BY date, sale, invo';
  const rows = db.all(query, params);
  if (!pf.on) {
    // Untouched legacy shape — no is_proforma column leaks into the response.
    // The number prints in its own cell with the sale letter beside it, so the
    // sort key is built from the two together.
    return rows
      .map(({ is_proforma, ...r }) => ({ ...r, date: _ddmmyyyy(r.date) }))
      .sort(_byInvoCell(r => `${r.sale || ''} ${r.invo || ''}`));
  }
  const idx = require('./proforma-refs').buildProformaIndex(db, auction.id);
  return rows
    .map(r => {
      const { is_proforma, ...rest } = r;
      return {
        ...rest,
        date: _ddmmyyyy(r.date),
        // The printed cell. `invo_raw` keeps the stored number for anything that
        // still needs to key off it (drill-through, reconciliation).
        invo: idx.labelFor(r, pf.prefix),
        invo_raw: r.invo,
        is_proforma: Number(is_proforma) ? 1 : 0,
      };
    })
    // Ordered on the proforma cell the register prints, not on invo_raw.
    .sort(_byInvoCell(r => r.invo));
}

/**
 * Sales Journal ledger summary — the sale-type-wise breakdown printed under
 * the journal (as in the reference COLLECTION report): Cardamom & Gunny sales
 * split by Export / Inter-State / Local, then IGST/CGST/SGST, Transport,
 * Insurance, the sample-sale ⇄ trader-discount pair, TCS/TDS, and the state
 * grand total. Ledger labels carry the business-state prefix (KL / TN).
 *
 * NOTE: "Sales Through Sample" and "Discount to Traders" are a matched pair
 * derived from the auction's sample refund (Σ lots.refund) since the invoices
 * table stores no discount column — adjust the source here if your books use a
 * different figure. They net to zero so they never move the grand total.
 */
function getSalesJournalSummary(db, auctionId, saleType, cfg) {
  const auction = db.get('SELECT id, ano FROM auctions WHERE id = ?', [auctionId]);
  if (!auction) return null;
  // Same row filter as getSalesJournal — with flag_proforma_invoice on, the
  // pending drafts printed above are totalled here too, so the ledger summary
  // foots to the register it sits under.
  let q = `SELECT sale, bag, qty, amount AS cardamom, gunny, pava_hc AS transport,
             ins AS insurance, cgst, sgst, igst, tcs, tot AS total
           FROM invoices WHERE (auction_id = ? OR ano = ?)
             AND ${_journalProformaSql(_proformaMode(db, cfg).on)}`;
  const params = [auction.id, auction.ano];
  if (saleType) { q += ' AND sale = ?'; params.push(saleType); }
  const rows = db.all(q, params);

  // Per sale type: q = cardamom kilos, v = cardamom value, g = gunny value,
  // gq = gunny QUANTITY. Gunny is billed per bag (Tally unit "Nos."), so the
  // gunny lines' quantity is the bag count — the cardamom kilos would be
  // meaningless there. Was previously left blank on the gunny rows.
  const bt = { E: { q: 0, v: 0, g: 0, gq: 0 }, I: { q: 0, v: 0, g: 0, gq: 0 }, L: { q: 0, v: 0, g: 0, gq: 0 } };
  let igst = 0, cgst = 0, sgst = 0, transport = 0, insurance = 0, tcs = 0, total = 0;
  for (const r of rows) {
    const t = String(r.sale || 'L').toUpperCase();
    const b = bt[t] || (bt[t] = { q: 0, v: 0, g: 0, gq: 0 });
    b.q += Number(r.qty) || 0;
    b.v += Number(r.cardamom) || 0;
    b.g += Number(r.gunny) || 0;
    b.gq += Number(r.bag) || 0;
    igst += Number(r.igst) || 0; cgst += Number(r.cgst) || 0; sgst += Number(r.sgst) || 0;
    transport += Number(r.transport) || 0; insurance += Number(r.insurance) || 0;
    tcs += Number(r.tcs) || 0; total += Number(r.total) || 0;
  }
  const refRow = db.get('SELECT COALESCE(SUM(refund),0) AS refund FROM lots WHERE auction_id = ?', [auction.id]);
  const sampleVal = Number(refRow && refRow.refund) || 0;

  const isKL = String((cfg && cfg.business_state) || '').toUpperCase() === 'KERALA';
  const P = isKL ? 'KL' : 'TN';
  const stateLabel = isKL ? 'KERALA' : 'TAMIL NADU';
  const n = (x) => Math.round((Number(x) || 0) * 100) / 100;

  const lines = [
    { label: `${P}-Export Cardamom Sales`,   qty: n(bt.E.q), value: n(bt.E.v) },
    { label: `${P}-Inter-State Card Sales`,  qty: n(bt.I.q), value: n(bt.I.v) },
    { label: `${P}-Local Cardamom Sales`,    qty: n(bt.L.q), value: n(bt.L.v) },
    { label: `${P}-Sales Through Sample`,    qty: '',        value: n(sampleVal) },
    // Gunny quantity = bags (only shown when that sale type actually billed
    // gunny, so a zero-gunny trade doesn't sprout a stray bag count).
    { label: `${P}-Export Gunny Sales`,      qty: bt.E.g ? n(bt.E.gq) : '', value: n(bt.E.g) },
    { label: `${P}-Inter-State Gunny Sales`, qty: bt.I.g ? n(bt.I.gq) : '', value: n(bt.I.g) },
    { label: `${P}-Local Gunny Sales`,       qty: bt.L.g ? n(bt.L.gq) : '', value: n(bt.L.g) },
    { label: `${P}-IGST`,                    qty: '',        value: n(igst) },
    { label: `${P}-CGST`,                    qty: '',        value: n(cgst) },
    { label: `${P}-SGST`,                    qty: '',        value: n(sgst) },
    { label: `${P}-Transporting Charge`,     qty: '',        value: n(transport) },
    { label: `${P}-Insurance`,               qty: '',        value: n(insurance) },
    { label: `Discount to Traders`,          qty: '',        value: n(-sampleVal) },
    { label: `${P}-TCS`,                     qty: '',        value: n(tcs) },
    { label: `${P}-TDS`,                     qty: '',        value: 0 },
  ];
  return { prefix: P, stateLabel, lines, stateTotal: n(total) };
}

/**
 * Purchase Journal (PUJOUR.PRG / PPUJOUR.PRG)
 * Trade-wise purchase invoice register. Dates rendered dd/mm/yyyy.
 * type: 'dealer' (registered) or 'agri' (agriculturist bills)
 */
function getPurchaseJournal(db, auctionId, type) {
  const auction = db.get('SELECT id, ano FROM auctions WHERE id = ?', [auctionId]);
  if (!auction) return [];
  if (type === 'agri') {
    // bills table only has `ano`, not auction_id, so match by ano alone.
    const rows = db.all(
      `SELECT date, bil as bill_no, name, add_line as address, pla as place, pstate as state,
        crr as cr, pan, qty, cost, igst, net
      FROM bills WHERE ano = ? ORDER BY date, bil`,
      [auction.ano]
    );
    return rows.map(r => ({ ...r, date: _ddmmyyyy(r.date) }));
  }
  // Dealer purchases — match either by auction_id (newer rows) or ano (legacy).
  const rows = db.all(
    `SELECT date, invo as invoice_no, name, add_line as address, place, state,
      gstin, qty, amount, cgst, sgst, igst, rund, total, tds
    FROM purchases WHERE (auction_id = ? OR ano = ?) ORDER BY date, invo`,
    [auction.id, auction.ano]
  );
  return rows.map(r => ({ ...r, date: _ddmmyyyy(r.date) }));
}

/**
 * Debit Note calculation
 *
 * IMPORTANT: Debit notes are issued AGAINST PURCHASES — they record a
 * discount/adjustment we've negotiated with a registered dealer (the
 * supplier). The instrument is buyer-side: the buyer (us) issues it to
 * the seller. So the source row is always a `purchases` record, NOT a
 * sales invoice. An earlier version queried the `invoices` table by
 * mistake, allowing DNs to be created against sales transactions —
 * that's wrong and is fixed here.
 *
 * Lookup is by purchase invoice number (`purchases.invo`). When a
 * `saleType` arg is passed it's ignored — purchases don't carry sale
 * type the way sales invoices do — but we accept it positionally so
 * legacy callers (e.g. older /api/debit-notes/generate) don't break.
 */
function buildDebitNote(db, invoiceNo, saleType, discount, cfg) {
  // Resolve by purchno (`purchases.invo`). Most-recent wins if duplicates
  // exist (legacy / re-used numbers across years) — matches /generate-bulk.
  const inv = db.get(
    `SELECT * FROM purchases
      WHERE invo = ?
      ORDER BY date DESC, id DESC
      LIMIT 1`,
    [String(invoiceNo)]
  );
  if (!inv) return null;

  // GST rate for the discount itself. The DN is a service charge
  // (discount-as-credit-note), which uses the discount_gst setting
  // (typically 18%) — NOT the goods rate (gst_goods, 5% for cardamom).
  // Earlier code used gst_goods, producing wrong tax on every DN.
  const gstRate = Number(cfg.discount_gst) || Number(cfg.gst_service) || 18;

  // Sale-type-driven GST split. For DNs (which credit the DEALER), the
  // inter/intra classification depends on the dealer's GSTIN state vs
  // the company's GSTIN state — NOT on the buyer-facing lots.sale tag.
  //   1. Caller-supplied saleType wins ('L'/'I'/'E').
  //   2. Dealer GSTIN vs company GSTIN — authoritative.
  //   3. Source purchase's own GST split (igst > 0 ⇒ inter).
  //   4. Last resort: dominant lots.sale tag.
  function _stateCodeFromCr(s) {
    let c = String(s || '').trim().toUpperCase();
    if (c.startsWith('GSTIN.')) c = c.slice(6);
    else if (c.startsWith('GSTIN')) c = c.slice(5);
    return /^\d{2}/.test(c) ? c.slice(0, 2) : '';
  }
  let resolvedSale = String(saleType || '').trim().toUpperCase();
  if (resolvedSale !== 'L' && resolvedSale !== 'I' && resolvedSale !== 'E') {
    // Compare dealer GSTIN vs company GSTIN. Pull company state from
    // the actual configured GSTIN — tally_state_code defaults to '33'
    // even on Kerala installs so it isn't safe by itself.
    const bizState = String(cfg.business_state || '').toUpperCase();
    const companyGstinCandidates = bizState === 'KERALA'
      ? [cfg.kl_gstin, cfg.tn_gstin, cfg.gstin]
      : [cfg.tn_gstin, cfg.kl_gstin, cfg.gstin];
    let companyStateCode = '';
    for (const g of companyGstinCandidates) {
      const code = _stateCodeFromCr(g);
      if (code) { companyStateCode = code; break; }
    }
    if (!companyStateCode) {
      companyStateCode = String(cfg.tally_state_code
        || (bizState === 'KERALA' ? '32' : '33'));
    }
    const dealerStateCode = _stateCodeFromCr(inv.cr || inv.gstin);
    if (dealerStateCode) {
      resolvedSale = (dealerStateCode === companyStateCode) ? 'L' : 'I';
    }
  }
  // Backup: source purchase's own GST split.
  if (resolvedSale !== 'L' && resolvedSale !== 'I' && resolvedSale !== 'E') {
    if ((Number(inv.igst) || 0) > 0) resolvedSale = 'I';
    else if ((Number(inv.cgst) || 0) > 0 || (Number(inv.sgst) || 0) > 0) resolvedSale = 'L';
  }
  // Last resort — lots.sale dominant tag.
  if (resolvedSale !== 'L' && resolvedSale !== 'I' && resolvedSale !== 'E') {
    try {
      const r = db.get(
        `SELECT UPPER(TRIM(COALESCE(sale,''))) AS s, COUNT(*) AS n
           FROM lots
          WHERE auction_id = (SELECT id FROM auctions WHERE ano = ? LIMIT 1)
            AND name = ? AND amount > 0
          GROUP BY s
          ORDER BY n DESC, s
          LIMIT 1`,
        [String(inv.ano || ''), inv.name || '']
      );
      resolvedSale = (r && r.s) ? String(r.s).toUpperCase() : '';
    } catch (_) { /* fall through */ }
  }
  const isInter = (resolvedSale === 'I' || resolvedSale === 'E');

  const amount = Math.round(discount * 100) / 100;
  let cgst = 0, sgst = 0, igst = 0;

  // flag_disc_gst removed — discount is always treated as pre-tax;
  // GST is added on top.
  if (isInter) igst = Math.round(amount * gstRate / 100 * 100) / 100;
  else {
    cgst = Math.round(amount * (gstRate / 2) / 100 * 100) / 100;
    sgst = Math.round(amount * (gstRate / 2) / 100 * 100) / 100;
  }

  const total = Math.round((amount + cgst + sgst + igst) * 100) / 100;

  // Return shape mirrors the original (callers read `invoice.ano`,
  // `invoice.buyer`, etc.). Re-aliases so a purchase row works as the
  // `invoice` field without callers needing to change.
  // Map purchase fields → invoice-like fields:
  //   purchases.name  → buyer / buyer1 (party = the dealer we're crediting)
  //   purchases.state → state
  //   purchases.ano   → ano (trade number, used for DN date lookup)
  return {
    invoice: {
      ano:    inv.ano,
      state:  inv.state,
      buyer:  inv.name,
      buyer1: inv.name,
      invo:   inv.invo,
      // Carry intra/inter state of source so downstream code that reads
      // inv.igst > 0 still works.
      igst:   inv.igst,
      cgst:   inv.cgst,
      sgst:   inv.sgst,
    },
    amount, cgst, sgst, igst, total,
  };
}

/**
 * Purchase Register (lot-wise)
 * One row PER LOT — the seller-side purchase detail. Unlike the Purchase
 * Journal (one row per dealer invoice / agri bill), this is the raw lot
 * ledger: STATE, TNO, DATE, LOT, BRANCH, NAME, PLACE, GSTIN, BAG, QTY,
 * PRICE, AMOUNT, PQTY, PRATE, PURAMT, DISCOUNT, GST5, PAYABLE.
 *
 * DISCOUNT = refund, GST5 = stored GST-on-discount (`advance`), PAYABLE =
 * balance (GST already netted). In auction mode `advance` is the discount,
 * so GST5 → 0.
 *
 * Withdrawn lots (code = 'WD') ARE included even though withdrawal zeroes
 * their price/amount, so the register accounts for every lot in the auction —
 * they appear with their real BAG/QTY but zero money columns (the only
 * zero-AMOUNT rows here, since unsold lots with no code stay excluded).
 *
 * Scope: a specific auction (opts.auctionId) OR a date range across auctions
 * (opts.from/opts.to over the auction date). Auction wins when both given.
 */
function getPurchaseRegister(db, opts = {}) {
  const mode = String(opts.mode || 'e-Auction').toLowerCase();
  const discountCol = (mode === 'auction') ? 'advance' : 'refund';
  const gstCol = (mode === 'auction') ? '0' : 'advance';
  let q = `SELECT l.state AS state, a.ano AS tno, a.date AS date, l.lot_no AS lot,
      l.branch AS branch, l.name AS name, l.ppla AS place, l.cr AS gstin,
      l.bags AS bag, l.qty AS qty, l.price AS price, l.amount AS amount,
      l.pqty AS pqty, l.prate AS prate, l.puramt AS puramt,
      l.${discountCol} AS discount, l.${gstCol} AS gst5, l.balance AS payable,
      l.refund AS refund, l.com AS commission, l.cgst AS cgst, l.sgst AS sgst,
      l.igst AS igst, l.bilamt AS billamount
    FROM lots l JOIN auctions a ON a.id = l.auction_id
    WHERE (l.amount > 0 OR UPPER(TRIM(COALESCE(l.code,''))) = 'WD')`;
  const params = [];
  if (opts.auctionId) { q += ' AND l.auction_id = ?'; params.push(opts.auctionId); }
  else if (opts.from && opts.to) { q += ' AND a.date BETWEEN ? AND ?'; params.push(opts.from, opts.to); }
  q += ' ORDER BY l.state, a.ano, CAST(l.lot_no AS INTEGER), l.lot_no';
  const rows = db.all(q, params);
  return rows.map(r => ({ ...r, date: _ddmmyyyy(r.date) }));
}

/**
 * Sales Register (invoice-wise)
 * One row PER INVOICE: STATE, TNO, DATE, SALE, INVO, TRADERNAME, BIDDER,
 * BAG, QTY, AMOUNT, LORRY, GUNNY, IGST, CGST, SGST, INS, INVAMT.
 * LORRY = freight charge (pava_hc); INVAMT = invoice grand total (tot).
 *
 * Scope: a specific auction (matched by auction_id OR ano for legacy rows)
 * OR a date range across auctions. Optional saleType filter.
 */
function getSalesRegister(db, opts = {}) {
  let q = `SELECT i.state AS state, i.ano AS tno, i.date AS date, i.sale AS sale,
      i.invo AS invo, i.buyer1 AS tradername, i.buyer AS bidder,
      i.bag AS bag, i.qty AS qty, i.amount AS amount,
      i.pava_hc AS lorry, i.gunny AS gunny, i.igst AS igst, i.cgst AS cgst,
      i.sgst AS sgst, i.ins AS ins, i.tot AS invamt
    FROM invoices i`;
  const params = [];
  // Proformas never appear in the sales register — originals only.
  const where = ['COALESCE(i.is_proforma,0) = 0'];
  if (opts.auctionId) {
    const a = db.get('SELECT id, ano FROM auctions WHERE id = ?', [opts.auctionId]);
    if (a) { where.push('(i.auction_id = ? OR i.ano = ?)'); params.push(a.id, a.ano); }
    else { where.push('i.auction_id = ?'); params.push(opts.auctionId); }
  } else if (opts.from && opts.to) {
    where.push('i.date BETWEEN ? AND ?'); params.push(opts.from, opts.to);
  }
  if (opts.saleType) { where.push('i.sale = ?'); params.push(opts.saleType); }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY i.state, i.ano, i.date, i.sale, i.invo';
  const rows = db.all(q, params);
  return rows.map(r => ({ ...r, date: _ddmmyyyy(r.date) }));
}

// ═══════════════════════════════════════════════════════════════
// PER-PARTY "INDIVIDUAL" REGISTERS (cross-auction, date-range)
// ───────────────────────────────────────────────────────────────
// Three party-statement registers that span MULTIPLE auctions within a
// date range (unlike the lot/invoice registers above which are per-auction
// OR a flat date-range list). Each returns { kind, parties: [...] } where
// every party carries its own rows + summary totals so the export layer
// can render one section/page per party (with an optional single-party
// filter). Rows are returned pre-sorted by party so callers can group in
// one pass.
//   • Pooler   — the seller's own lots (lots table). Sold = amount>0.
//   • Seller   — purchase invoices raised TO the pooler (purchases table),
//                summarised per auction. INVO = count of invoices.
//   • Merchant — sales invoices raised to the buyer (invoices table), one
//                row per invoice. RECEIPT has no data source yet (no
//                receipts table) so it renders 0 / blank; closing balance
//                therefore equals the invoice total.
function _groupRegister(rows, summaryFn) {
  const parties = [];
  let cur = null;
  for (const r of rows) {
    const name = r.party || '';
    // Break on the seller's identity where the query supplies one: two
    // poolers can share a name, and grouping on the name alone merged their
    // lots — and their bill totals — into a single party (and a single
    // certificate). Registers whose query selects no trader_id behave exactly
    // as before, grouping on the name.
    const tid = (r.trader_id === undefined) ? null : r.trader_id;
    if (!cur || cur.name !== name || cur.trader_id !== tid) {
      cur = { name, trader_id: tid, gstin: '', phone: '', rows: [] };
      parties.push(cur);
    }
    if (!cur.gstin && r.gstin) cur.gstin = String(r.gstin).trim();
    // Phone is a party attribute too — rows carry a denormalised copy (a
    // register whose query doesn't select one just leaves this blank).
    // First non-empty wins.
    if (!cur.phone && r.phone) cur.phone = String(r.phone).trim();
    // The party + gstin + phone live on the group, not on each row.
    const { party, gstin, phone, trader_id, ...rest } = r;
    cur.rows.push(rest);
  }
  for (const p of parties) p.summary = summaryFn(p.rows);
  return parties;
}
const _num = (v) => Number(v) || 0;
const _sum = (rows, k) => rows.reduce((s, r) => s + _num(r[k]), 0);

// Pooler Register — one row per lot the pooler put up, across all auctions
// in range. TNo | Date | Lot | Qty | Rate | Value | P_Qty | P_Rate | PurAmt.
// Withdrawn lots (code 'WD') ARE included so the register reconciles the
// full lot list; the summary breaks the totals into Sold vs Withdrawn.
function getPoolerRegister(db, opts = {}) {
  let q = `SELECT a.ano AS tno, a.date AS date, l.lot_no AS lot, l.name AS party,
      l.trader_id AS trader_id,
      l.cr AS gstin, l.tel AS phone, l.qty AS qty, l.price AS rate, l.amount AS value,
      l.refund AS refund, l.com AS commission,
      (COALESCE(l.cgst,0) + COALESCE(l.sgst,0) + COALESCE(l.igst,0)) AS gst,
      -- Bill amount = the lot's Payable (lots.balance), so the register's
      -- BILLAMOUNT matches the payable shown on the Lots screen.
      l.balance AS billamount,
      l.pqty AS pqty, l.prate AS prate, l.puramt AS puramt,
      UPPER(TRIM(COALESCE(l.code,''))) AS code
    FROM lots l JOIN auctions a ON a.id = l.auction_id
    WHERE 1=1`;
  const params = [];
  if (opts.from && opts.to) { q += ' AND a.date BETWEEN ? AND ?'; params.push(opts.from, opts.to); }
  if (opts.party) { q += ' AND UPPER(TRIM(l.name)) = UPPER(?)'; params.push(String(opts.party).trim()); }
  // Narrow to ONE pooler when the caller knows which — the name alone can
  // match two masters (the Certificate must not certify a namesake's lots).
  const _tid = Number(opts.traderId);
  if (Number.isFinite(_tid) && _tid > 0) { q += ' AND l.trader_id = ?'; params.push(_tid); }
  q += ' ORDER BY l.name, l.trader_id, a.date, a.ano, CAST(l.lot_no AS INTEGER), l.lot_no';
  const rows = db.all(q, params).map(r => ({ ...r, date: _ddmmyyyy(r.date) }));
  const parties = _groupRegister(rows, (rs) => {
    const isWd = (r) => String(r.code || '').trim().toUpperCase() === 'WD';
    const qty = _sum(rs, 'qty');
    const value = _sum(rs, 'value');
    const pqty = _sum(rs, 'pqty');
    const puramt = _sum(rs, 'puramt');
    const refund = _sum(rs, 'refund');
    const commission = _sum(rs, 'commission');
    const gst = _sum(rs, 'gst');
    const billamount = _sum(rs, 'billamount');
    const sold = rs.filter(r => !isWd(r) && _num(r.value) > 0);
    const wd = rs.filter(isWd);
    const soldQty = sold.reduce((s, r) => s + _num(r.qty), 0);
    const soldValue = sold.reduce((s, r) => s + _num(r.value), 0);
    const wdQty = wd.reduce((s, r) => s + _num(r.qty), 0);
    const wdValue = wd.reduce((s, r) => s + _num(r.value), 0);
    return { qty, value, pqty, puramt, refund, commission, gst, billamount, soldQty, soldValue, wdQty, wdValue };
  });
  return { kind: 'pooler', parties };
}

// Seller Register ("SELLERS INDIVIDUAL") — purchase invoices to the pooler,
// summarised per auction. DATE | ANO | INVO(count) | QTY | INVOICE.
function getSellerRegister(db, opts = {}) {
  let q = `SELECT p.name AS party, MAX(p.gstin) AS gstin, p.ano AS ano, p.date AS date,
      COUNT(*) AS invo, SUM(p.qty) AS qty,
      SUM(CASE WHEN COALESCE(p.total,0) > 0 THEN p.total ELSE p.amount END) AS invoice
    FROM purchases p WHERE 1=1`;
  const params = [];
  if (opts.from && opts.to) { q += ' AND p.date BETWEEN ? AND ?'; params.push(opts.from, opts.to); }
  if (opts.party) { q += ' AND UPPER(TRIM(p.name)) = UPPER(?)'; params.push(String(opts.party).trim()); }
  q += ' GROUP BY p.trader_id, p.name, p.ano, p.date ORDER BY p.name, p.date, p.ano';
  const rows = db.all(q, params).map(r => ({ ...r, date: _ddmmyyyy(r.date) }));
  const parties = _groupRegister(rows, (rs) => {
    const invoice = _sum(rs, 'invoice');
    return { qty: _sum(rs, 'qty'), invoice, closing: invoice };
  });
  return { kind: 'seller', parties };
}

// Merchant Register ("MERCHANTS INDIVIDUAL") — sales invoices to the buyer,
// one row per invoice. DATE | TNo | INVO | RECP | QTY | INVOICE | RECEIPT.
function getMerchantRegister(db, opts = {}) {
  let q = `SELECT i.buyer1 AS party, i.gstin AS gstin, i.ano AS tno, i.date AS date,
      i.invo AS invo, '' AS recp, i.qty AS qty, i.tot AS invoice, 0 AS receipt
    FROM invoices i WHERE 1=1 AND COALESCE(i.is_proforma,0) = 0`;
  const params = [];
  if (opts.from && opts.to) { q += ' AND i.date BETWEEN ? AND ?'; params.push(opts.from, opts.to); }
  if (opts.party) { q += ' AND UPPER(TRIM(i.buyer1)) = UPPER(?)'; params.push(String(opts.party).trim()); }
  q += " ORDER BY i.buyer1, i.date, i.ano, CAST(NULLIF(i.invo,'') AS INTEGER), i.invo";
  const rows = db.all(q, params).map(r => ({ ...r, date: _ddmmyyyy(r.date) }));
  const parties = _groupRegister(rows, (rs) => {
    const invoice = _sum(rs, 'invoice');
    const receipt = _sum(rs, 'receipt');
    return { qty: _sum(rs, 'qty'), invoice, receipt, closing: invoice - receipt };
  });
  return { kind: 'merchant', parties };
}

// Distinct party names for the picker dropdown, scoped to the same source
// table + date range as the matching register.
// Returns [{ name, phone }] for the party dropdown of each individual
// register. Phone lets the UI show it alongside the name and filter on it:
//   • pooler   → lots.tel (denormalised onto the lot)
//   • seller   → traders.tel (matched on name)
//   • merchant → buyers.tel (matched on trade name buyer1)
// MAX(NULLIF(TRIM(..),'')) picks a non-empty phone when a party spans rows.
function listRegisterParties(db, opts = {}) {
  const kind = String(opts.kind || '').toLowerCase();
  const params = [];
  let q;
  if (kind === 'merchant') {
    q = `SELECT i.buyer1 AS name, MAX(NULLIF(TRIM(b.tel),'')) AS phone
         FROM invoices i
         LEFT JOIN buyers b ON UPPER(TRIM(b.buyer1)) = UPPER(TRIM(i.buyer1))
         WHERE COALESCE(i.buyer1,'') != '' AND COALESCE(i.is_proforma,0) = 0`;
    if (opts.from && opts.to) { q += ' AND i.date BETWEEN ? AND ?'; params.push(opts.from, opts.to); }
    q += ' GROUP BY i.buyer1 ORDER BY i.buyer1';
  } else if (kind === 'seller') {
    // Joined on the purchase's seller FK, falling back to a single-row name
    // match. The old bare name join matched EVERY same-named master, so two
    // dealers collapsed into one contact carrying a namesake's number.
    q = `SELECT p.name AS name, MAX(NULLIF(TRIM(t.tel),'')) AS phone
         FROM purchases p
         LEFT JOIN traders t
           ON t.id = COALESCE(p.trader_id,
                (SELECT t2.id FROM traders t2
                  WHERE UPPER(TRIM(t2.name)) = UPPER(TRIM(p.name))
                  ORDER BY t2.id LIMIT 1))
         WHERE COALESCE(p.name,'') != ''`;
    if (opts.from && opts.to) { q += ' AND p.date BETWEEN ? AND ?'; params.push(opts.from, opts.to); }
    q += ' GROUP BY p.trader_id, p.name ORDER BY p.name';
  } else {
    // One entry per seller IDENTITY, not per name: two poolers can share a
    // name, and merging them here meant the picker offered a single entry
    // whose register (and Certificate) covered both people's lots. trader_id
    // travels back so the caller can name exactly one of them.
    q = `SELECT l.name AS name, l.trader_id AS trader_id,
                MAX(NULLIF(TRIM(l.tel),'')) AS phone
         FROM lots l JOIN auctions a ON a.id = l.auction_id
         WHERE COALESCE(l.name,'') != ''`;
    if (opts.from && opts.to) { q += ' AND a.date BETWEEN ? AND ?'; params.push(opts.from, opts.to); }
    q += ' GROUP BY l.name, l.trader_id ORDER BY l.name';
  }
  return db.all(q, params).map(r => ({
    name: r.name, phone: r.phone || '',
    trader_id: (r.trader_id == null ? null : r.trader_id),
  }));
}

module.exports = {
  calculateLot,
  calculateTDS,
  calculateTCS,
  buildSalesInvoice,
  buildPurchaseInvoice,
  buildAgriBill,
  buildDebitNote,
  listAgriSellers,
  getPaymentSummary,
  getBankPaymentData,
  formatLotList,
  getTDSReturnData,
  getSalesJournal,
  getSalesJournalSummary,
  getPurchaseJournal,
  getPurchaseRegister,
  getSalesRegister,
  getPoolerRegister,
  getSellerRegister,
  getMerchantRegister,
  listRegisterParties,
  gstinStateCode,
  deriveSaleType,
  isDealerSeller,
  dealerSql,
  hasValidGstin,
  hasValidGstinSql,
};
