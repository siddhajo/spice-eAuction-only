// ── HTML invoice orchestrator ────────────────────────────────────────────
//
// Drop-in analog to invoice-pdf.js `generateSalesInvoicePDF`, but rendered via
// an HTML/CSS template instead of PDStore drawing. Signature mirrors the
// original so a route can switch with a one-line change:
//
//     const buf = await generateSalesInvoiceHtmlPDF(
//                   invoiceData, cfg, saleType, invoiceNo, invoiceDate);
//     res.setHeader('Content-Type', 'application/pdf'); res.end(buf);
//
// Responsibilities:
//   1. Build a flat, presentation-ready VIEW MODEL from the same
//      { buyer, lineItems, summary } that buildSalesInvoice() produces.
//   2. Pick the customer's template via the registry (cfg.sales_invoice_template).
//   3. Render → HTML → PDF Buffer.
//
// The view model is the CONTRACT every sales-invoice template renders against.
// All business math stays in calculations.js; this file only DERIVES DISPLAY
// values (flags, resolved party blocks, HSN summary rows) — no new totals.

const fs = require('fs');
const path = require('path');
const { effectiveCompany } = require('../invoice-pdf');
const { getInvoiceTemplate } = require('./invoice-templates');
// Shared NAME / STREET / TOWN-PIN / STATE+CODE / details-two-per-row party box.
const { partyBlock } = require('../party-block');
const { htmlToPdf } = require('./htmlToPdf');

// Logos must be embedded as data: URIs — the renderer loads the HTML from a
// data: URL / setContent, where file:// and external requests are blocked.
// Shared resolver (case/extension-tolerant) so every document type embeds the
// logo identically; returns '' if none so the template just omits the <img>.
const { logoDataUri } = require('./logo-data-uri');

function readFlag(val, defaultOn) {
  if (val === undefined || val === null || val === '') return defaultOn;
  if (typeof val === 'boolean') return val;
  return String(val).toLowerCase() === 'true';
}

// {inv_prefix}/{saleType}-{invoiceNo}/{season_short} — mirrors invoice-pdf.js.
// Proforma documents use `proforma_invoice_prefix` in place of `inv_prefix`
// (falling back to inv_prefix when it is blank), so a draft prints under its
// own series marker and is never mistaken for the original tax invoice. Same
// rule as the PDFKit engine in invoice-pdf.js.
function formatInvoiceNo(cfg, saleType, invoiceNo, isProforma) {
  const invPrefix = String(cfg.inv_prefix || '').trim();
  const pfPrefix  = String(cfg.proforma_invoice_prefix || '').trim();
  const prefix = isProforma ? (pfPrefix || invPrefix) : invPrefix;
  const season = cfg.season_short || '';
  const middle = saleType ? `${saleType}-${invoiceNo}` : String(invoiceNo);
  return [prefix, middle, season].filter((p) => p !== '' && p != null).join('/');
}

const pickRate = (...vals) => {
  for (const v of vals) {
    if (v === undefined || v === null || v === '') continue;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
};

/**
 * Build the sales-invoice view model.
 * @returns a plain object consumed by templates/sales-invoice/*.hbs
 */
function buildSalesInvoiceView(invoiceData, cfg, saleType, invoiceNo, invoiceDate) {
  const { buyer, lineItems, summary } = invoiceData;
  const co = effectiveCompany(cfg);
  co.logoDataUri = logoDataUri(cfg);   // embed for CSP-safe rendering

  const st = String(saleType || '').toUpperCase();
  const hideTI = st === 'E';
  const showHsn = readFlag(cfg.flag_hsn, true);
  const showBank = readFlag(cfg.flag_bank, true);
  const stripe = readFlag(cfg.flag_invoice_stripe, true);

  const hsnCardamom = cfg.hsn_cardamom || '09083120';
  const hsnGunny = cfg.hsn_gunny || '63051040';
  const sacTransport = cfg.sac_transport || '996791';
  const sacInsurance = cfg.sac_insurance || '997136';
  const gstGoods = cfg.gst_goods || 5;
  const isInter = !!summary.isInterState;

  const isLocal = st === 'L';
  const transportRate = hideTI ? 0 : (isLocal
    ? pickRate(cfg.local_transport, cfg.transport, 2.5)
    : pickRate(cfg.transport, 2.5));
  const insuranceRate = hideTI ? 0 : (isLocal
    ? pickRate(cfg.local_insurance, cfg.insurance, 0.75)
    : pickRate(cfg.insurance, 0.75));
  const gunnyRate = Number(cfg.gunny_rate || 165);

  // Receiver (bill-to) — the buyer. PAN/SBL are carried so the party block can
  // align them in a second column like the reference layout.
  const billTo = {
    name: buyer.buyer1 || buyer.buyer || '',
    addr: [buyer.add1, buyer.add2].filter(Boolean).join(', '),
    place: [buyer.pla, buyer.pin].filter(Boolean).join(' - '),
    gstin: buyer.gstin || '', state: buyer.state || '', stCode: buyer.st_code || '',
    pan: buyer.pan || '', sbl: buyer.sbl || '',
    // The printable block — every layout renders THIS, so the receiver box
    // reads the same here as on the bill of supply and the commission bill.
    block: partyBlock({
      name: buyer.buyer1 || buyer.buyer || '',
      address: [buyer.add1, buyer.add2].filter(Boolean).join(', '),
      place: buyer.pla, pin: buyer.pin,
      state: buyer.state, st_code: buyer.st_code,
      gstin: buyer.gstin, pan: buyer.pan, sbl: buyer.sbl,
    }),
  };
  // Consignee (ship-to) — a real consignee if the row carries one; otherwise
  // the goods ship to the buyer themselves, so Shipped-To mirrors Billed-To in
  // full (name/address/PAN/GST/SBL) rather than showing a placeholder.
  // A genuine consignee needs a name/address/place — a stray consignee GSTIN
  // alone shouldn't produce a sparse Shipped-To; in that case mirror Billed-To.
  const hasConsignee = !!(buyer.cbuyer1 || buyer.cadd1 || buyer.cpla);
  const ship = hasConsignee ? {
    name: buyer.cbuyer1 || buyer.buyer1 || buyer.buyer || '',
    // Both consignee address lines, same as billTo above — Consignee
    // Address 2 was dropped here, so anything typed into it never reached
    // the printed Shipped-To block.
    addr: [buyer.cadd1, buyer.cadd2].filter(Boolean).join(', '),
    place: [buyer.cpla, buyer.cpin].filter(Boolean).join(' - '),
    gstin: buyer.cgstin || '', state: buyer.cstate || '', stCode: buyer.cst_code || '',
    // The consignee is often a different legal entity from the buyer, so it
    // carries its OWN PAN and SBL — never fall back to the buyer's, which
    // would print one party's statutory identifiers under another's name.
    pan: buyer.cpan || '', sbl: buyer.csbl || '',
    block: partyBlock({
      name: buyer.cbuyer1 || buyer.buyer1 || buyer.buyer || '',
      address: [buyer.cadd1, buyer.cadd2].filter(Boolean).join(', '),
      place: buyer.cpla, pin: buyer.cpin,
      state: buyer.cstate, st_code: buyer.cst_code,
      gstin: buyer.cgstin, pan: buyer.cpan, sbl: buyer.csbl,
    }),
  } : { ...billTo };

  // Line items — shipped == billed for e-Auction; rate/amount are the external
  // customer price (li.price / li.amount), matching the ISP branch of the
  // PDFKit renderer.
  // Per-line tax split — CGST/SGST (intra) or IGST (inter) on each row's
  // amount, plus a line total. Used by templates (e.g. Letterhead) that show tax
  // per lot inline; templates that only show an HSN summary just ignore these.
  const taxOf = (amount) => {
    const a = Number(amount) || 0;
    const cgst = isInter ? 0 : +(a * gstGoods / 2 / 100).toFixed(2);
    const sgst = isInter ? 0 : +(a * gstGoods / 2 / 100).toFixed(2);
    const igst = isInter ? +(a * gstGoods / 100).toFixed(2) : 0;
    return { cgst, sgst, igst, total: +(a + cgst + sgst + igst).toFixed(2) };
  };
  // Show lots in ascending lot-number order (numeric-aware, so 20 sorts before
  // 185 and "12A" naturally after 12). The invoice arrives in allocation order,
  // which reads as unsorted; the serial (sl) is assigned AFTER sorting so it
  // still runs 1..n down the page. Shared by all sales-invoice layouts.
  const sortedLineItems = lineItems.slice().sort((a, b) =>
    String(a && a.lot != null ? a.lot : '').localeCompare(
      String(b && b.lot != null ? b.lot : ''), undefined, { numeric: true }));
  const rows = sortedLineItems.map((li, i) => {
    const amount = Number(li.amount || 0);
    return {
      sl: i + 1,
      lot: li.lot || '',
      bags: li.bags || '',
      desc: 'Cardamom',
      hsn: hsnCardamom,
      qty: Number(li.qty || 0),
      rate: Number(li.price || 0),
      amount,
      ...taxOf(amount),
    };
  });

  // Footer goods rows. Gunny shows only when there are bags/cost. Transport &
  // Insurance always show for a NON-export invoice (both local AND inter-state)
  // — for a local sale the cost is 0, so the row reads "<total kilos> … 0.00",
  // the Letterhead format the customer expects. Export (hideTI) still omits them.
  const gunny = (summary.totalBags > 0 && summary.gunnyCost > 0)
    ? { desc: 'Gunny', hsn: hsnGunny, units: `${summary.totalBags} Nos.`, bags: summary.totalBags, rate: gunnyRate, per: 'Nos.', amount: summary.gunnyCost, ...taxOf(summary.gunnyCost) } : null;
  const transport = hideTI ? null
    : { desc: 'Transport', hsn: sacTransport, units: `${summary.totalQty.toFixed(3)} Kgs.`, qty: summary.totalQty, rate: transportRate, per: 'Kgs.', amount: Number(summary.transportCost || 0), ...taxOf(summary.transportCost) };
  const insurance = hideTI ? null
    : { desc: 'Insurance', hsn: sacInsurance, rate: insuranceRate, amount: Number(summary.insuranceCost || 0), ...taxOf(summary.insuranceCost) };

  // Sample — DISPLAY-ONLY row: quantity = (number of cardamom lots) × 0.100 kg
  // (the sample drawn per lot), valued at 0.100 × each lot's rate and shown as
  // a negative deduction. It does NOT feed the taxable value or grand total.
  const sample = rows.length
    ? { qty: Math.round(rows.length * 0.1 * 1000) / 1000,
        amount: Math.round(rows.reduce((s, r) => s + 0.1 * Number(r.rate || 0), 0) * 100) / 100 }
    : null;

  // HSN summary rows (same construction as invoice-pdf.js).
  const mkHsn = (hsn, desc, taxable) => ({
    hsn, desc, taxable,
    rate: gstGoods,
    cgst: isInter ? 0 : +(taxable * gstGoods / 2 / 100).toFixed(2),
    sgst: isInter ? 0 : +(taxable * gstGoods / 2 / 100).toFixed(2),
    igst: isInter ? +(taxable * gstGoods / 100).toFixed(2) : 0,
  });
  const hsnRows = [mkHsn(hsnCardamom, 'Cardamom', summary.totalAmount)];
  if (summary.gunnyCost > 0) hsnRows.push(mkHsn(hsnGunny, 'Gunny', summary.gunnyCost));
  if (summary.transportCost > 0 && !hideTI) hsnRows.push(mkHsn(sacTransport, 'Transport', summary.transportCost));
  if (summary.insuranceCost > 0 && !hideTI) hsnRows.push(mkHsn(sacInsurance, 'Insurance', summary.insuranceCost));
  const hsnTotal = {
    taxable: hsnRows.reduce((a, r) => a + r.taxable, 0),
    cgst: hsnRows.reduce((a, r) => a + r.cgst, 0),
    sgst: hsnRows.reduce((a, r) => a + r.sgst, 0),
    igst: hsnRows.reduce((a, r) => a + r.igst, 0),
  };

  // Bank block (business_state-driven, same as PDFKit).
  const bizKL = String(cfg.business_state || '').toUpperCase().trim() === 'KERALA';
  const bank = showBank ? {
    name: bizKL ? (cfg.bank_kl_name || cfg.bank_tn_name || '') : (cfg.bank_tn_name || cfg.bank_kl_name || ''),
    acct: bizKL ? (cfg.bank_kl_acct || cfg.bank_tn_acct || '') : (cfg.bank_tn_acct || cfg.bank_kl_acct || ''),
    ifsc: bizKL ? (cfg.bank_kl_ifsc || cfg.bank_tn_ifsc || '') : (cfg.bank_tn_ifsc || cfg.bank_kl_ifsc || ''),
  } : null;

  const usedRows = rows.length + (sample ? 1 : 0) + (gunny ? 1 : 0) + (transport ? 1 : 0) + (insurance ? 1 : 0);
  return {
    cfg,
    co,
    padRows: Math.max(0, 13 - usedRows),
    // Proforma documents are titled "Proforma Invoice"; `isProforma` is also
    // exposed so templates can add a watermark / "not a valid tax invoice" note.
    title: invoiceData.isProforma ? 'Proforma Invoice' : 'Tax Invoice',
    isProforma: !!invoiceData.isProforma,
    invoiceNo: formatInvoiceNo(cfg, saleType, invoiceNo, !!invoiceData.isProforma),
    invoiceDate: invoiceDate || null,
    // Operator's configured date format (Settings → date_format). Templates
    // render the invoice date with {{date invoiceDate dateFormat}} so it honors
    // the setting instead of a hardcoded dd-Mon-yy.
    dateFormat: cfg.date_format || 'dd/mm/yyyy',
    auctionNo: invoiceData.auctionNo || '',
    saleType: st,
    // HSN/SAC codes surfaced directly so templates that print a standalone
    // "Commodity: Cardamom | HSN: {{hsnCardamom}}" line render a value (they
    // were previously only embedded per-row / in the HSN summary).
    hsnCardamom, hsnGunny, sacTransport, sacInsurance,
    flags: { showHsn, showBank, stripe, isInter },
    ship, billTo,
    dispatchedThrough: (invoiceData.dispatchedThrough) || cfg.dispatched_through_isp || cfg.dispatched_through || '',
    destination: buyer.cpla || buyer.pla || cfg.dispatch_destination || '',
    rows,
    sample, gunny, transport, insurance,
    gstRate: gstGoods,
    gstHalf: gstGoods / 2,
    summary,
    hsnRows, hsnTotal,
    bank,
    forCompany: co.name || co.short || '',
  };
}

// ── Multi-page furniture (page numbers + "continued" note) ───────────────
// Only a long invoice gets these, and they can only come from Chromium's print
// header/footer: the HTML has no way to know which page a row landed on.
// They are drawn into page margins, which the layout gives up in return:
// `view.paged` drops the template's own per-page gutter so the two don't stack.
const PAGE_MARGIN_TOP_PT = 30;     // clears the "Page x of y" line (ends ~24pt down)
const PAGE_MARGIN_BOTTOM_PT = 30;  // …and the "continued" line (starts ~22pt up)
// Chromium anchors these to the paper itself (~17pt down from the top edge /
// ~14pt up from the bottom), NOT inside the margin band, and ignores vertical
// margins on them — the 30pt page margins above are simply what keeps the
// invoice frame clear of them. Side padding matches the frame's 18pt gutter so
// both lines sit flush with its right edge.
const _hfStyle = 'width:100%; padding:0 18pt; font:7.5pt Helvetica, Arial, sans-serif; color:#000; text-align:right;';
const PAGE_NO_HEADER =
  `<div style="${_hfStyle}">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
const CONTINUED_FOOTER =
  `<div style="${_hfStyle} font-style:italic;">Continued on next page..</div>`;

/**
 * Render a sales invoice to a PDF Buffer via the customer's HTML template.
 * Async (htmlToPdf is async) — the original PDFKit fn returned a Promise too.
 *
 * A one-page invoice — nearly all of them — is rendered exactly as it always
 * was, in a single pass. When it spills over, the document is rendered again
 * with page numbers and a "Continued on next page.." footer, and its LAST page
 * once more without that footer (Chromium keeps the real page number when you
 * ask it for one page range), so the note only ever promises a page that
 * exists. Costs two extra renders, and only for invoices that need them.
 */
async function generateSalesInvoiceHtmlPDF(invoiceData, cfg, saleType, invoiceNo, invoiceDate) {
  const view = buildSalesInvoiceView(invoiceData, cfg, saleType, invoiceNo, invoiceDate);
  const tpl = getInvoiceTemplate('sales-invoice', cfg);
  const plain = await htmlToPdf(tpl.render(view));

  const { pdfPageCount, dropLastPage, mergePdfs } = require('./merge-pdf');
  let pages;
  try { pages = await pdfPageCount(plain); }
  catch (_) { return plain; }        // unreadable page count — ship the plain render
  if (pages <= 1) return plain;

  // Paged layout: `paged` swaps the template's in-flow per-page gutter for a
  // real @page margin of the same purpose — which is ALSO what reserves the
  // header/footer space, since CSS page margins override the print call's (the
  // matching marginTop/marginBottom below are sent so the two can't disagree).
  const pagedHtml = tpl.render({ ...view, paged: true });
  const printOpts = {
    header: PAGE_NO_HEADER,
    marginTop: PAGE_MARGIN_TOP_PT,
    marginBottom: PAGE_MARGIN_BOTTOM_PT,
  };
  const withNote = await htmlToPdf(pagedHtml, { ...printOpts, footer: CONTINUED_FOOTER });
  // Re-measure: the margins change how much fits per page, so the paged render
  // can come out a page longer — or, for an invoice that only just spilled,
  // back down to one page, in which case the plain render is the right answer.
  const pagedCount = await pdfPageCount(withNote);
  if (pagedCount <= 1) return plain;
  const head = await dropLastPage(withNote);
  const last = await htmlToPdf(pagedHtml, { ...printOpts, pageRanges: String(pagedCount) });
  return head ? mergePdfs([head, last]) : last;
}

// Bulk: invoices = [{ invoiceData, saleType, invoiceNo, invoiceDate }].
// Renders each independently, merges the PDFs into one multi-page document.
async function generateSalesInvoicesHtmlBatchPDF(invoices, cfg) {
  const { mergePdfs } = require('./merge-pdf');
  const parts = [];
  for (const inv of invoices) {
    parts.push(await generateSalesInvoiceHtmlPDF(inv.invoiceData, cfg, inv.saleType, inv.invoiceNo, inv.invoiceDate));
  }
  return mergePdfs(parts);
}

module.exports = { generateSalesInvoiceHtmlPDF, generateSalesInvoicesHtmlBatchPDF, buildSalesInvoiceView };
