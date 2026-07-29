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
function formatInvoiceNo(cfg, saleType, invoiceNo) {
  const prefix = cfg.inv_prefix || '';
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
  };
  // Consignee (ship-to) — a real consignee if the row carries one; otherwise
  // the goods ship to the buyer themselves, so Shipped-To mirrors Billed-To in
  // full (name/address/PAN/GST/SBL) rather than showing a placeholder.
  // A genuine consignee needs a name/address/place — a stray consignee GSTIN
  // alone shouldn't produce a sparse Shipped-To; in that case mirror Billed-To.
  const hasConsignee = !!(buyer.cbuyer1 || buyer.cadd1 || buyer.cpla);
  const ship = hasConsignee ? {
    name: buyer.cbuyer1 || buyer.buyer1 || buyer.buyer || '',
    addr: buyer.cadd1 || '',
    place: [buyer.cpla, buyer.cpin].filter(Boolean).join(' - '),
    gstin: buyer.cgstin || '', state: buyer.cstate || '', stCode: buyer.cst_code || '',
    pan: buyer.cpan || '', sbl: '',
  } : { ...billTo };

  // Line items — shipped == billed for e-Auction; rate/amount are the external
  // customer price (li.price / li.amount), matching the ISP branch of the
  // PDFKit renderer.
  // Per-line tax split — CGST/SGST (intra) or IGST (inter) on each row's
  // amount, plus a line total. Used by templates (e.g. RNS) that show tax
  // per lot inline; templates that only show an HSN summary just ignore these.
  const taxOf = (amount) => {
    const a = Number(amount) || 0;
    const cgst = isInter ? 0 : +(a * gstGoods / 2 / 100).toFixed(2);
    const sgst = isInter ? 0 : +(a * gstGoods / 2 / 100).toFixed(2);
    const igst = isInter ? +(a * gstGoods / 100).toFixed(2) : 0;
    return { cgst, sgst, igst, total: +(a + cgst + sgst + igst).toFixed(2) };
  };
  const rows = lineItems.map((li, i) => {
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

  // Footer goods rows (gunny/transport/insurance) — shown only when non-zero.
  const gunny = (summary.totalBags > 0 && summary.gunnyCost > 0)
    ? { desc: 'Gunny', hsn: hsnGunny, units: `${summary.totalBags} Nos.`, bags: summary.totalBags, rate: gunnyRate, per: 'Nos.', amount: summary.gunnyCost, ...taxOf(summary.gunnyCost) } : null;
  const transport = (summary.transportCost > 0 && !hideTI)
    ? { desc: 'Transport', hsn: sacTransport, units: `${summary.totalQty.toFixed(3)} Kgs.`, qty: summary.totalQty, rate: transportRate, per: 'Kgs.', amount: summary.transportCost, ...taxOf(summary.transportCost) } : null;
  const insurance = (summary.insuranceCost > 0 && !hideTI)
    ? { desc: 'Insurance', hsn: sacInsurance, rate: insuranceRate, amount: summary.insuranceCost, ...taxOf(summary.insuranceCost) } : null;

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

  const usedRows = rows.length + (gunny ? 1 : 0) + (transport ? 1 : 0) + (insurance ? 1 : 0);
  return {
    cfg,
    co,
    padRows: Math.max(0, 13 - usedRows),
    title: 'Tax Invoice',
    invoiceNo: formatInvoiceNo(cfg, saleType, invoiceNo),
    invoiceDate: invoiceDate || null,
    auctionNo: invoiceData.auctionNo || '',
    saleType: st,
    flags: { showHsn, showBank, stripe, isInter },
    ship, billTo,
    dispatchedThrough: (invoiceData.dispatchedThrough) || cfg.dispatched_through_isp || cfg.dispatched_through || '',
    destination: buyer.cpla || buyer.pla || cfg.dispatch_destination || '',
    rows,
    gunny, transport, insurance,
    gstRate: gstGoods,
    gstHalf: gstGoods / 2,
    summary,
    hsnRows, hsnTotal,
    bank,
    forCompany: co.name || co.short || '',
  };
}

/**
 * Render a sales invoice to a PDF Buffer via the customer's HTML template.
 * Async (htmlToPdf is async) — the original PDFKit fn returned a Promise too.
 */
async function generateSalesInvoiceHtmlPDF(invoiceData, cfg, saleType, invoiceNo, invoiceDate) {
  const view = buildSalesInvoiceView(invoiceData, cfg, saleType, invoiceNo, invoiceDate);
  const tpl = getInvoiceTemplate('sales-invoice', cfg);
  const html = tpl.render(view);
  return htmlToPdf(html);
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
