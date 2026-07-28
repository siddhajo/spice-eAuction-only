// ── HTML Bill of Supply (Agri Bill) orchestrator ──────────────────────────
// Drop-in analog to invoice-pdf.js `generateAgriBillPDF(billData, cfg, billNo)`.
// GST columns are always blank (agriculturist, unregistered under Sec 2(7)).

const fs = require('fs');
const path = require('path');
const { amountToWords } = require('../amount-words');
const getCompanyIdentity = require('../_company-identity-fallback').resolve();
const { getInvoiceTemplate } = require('./invoice-templates');
const { htmlToPdf } = require('./htmlToPdf');

function readFlag(val, defaultOn) {
  if (val === undefined || val === null || val === '') return defaultOn;
  if (typeof val === 'boolean') return val;
  return String(val).toLowerCase() === 'true';
}
const sumKey = (rows, primary, fallback) =>
  rows.reduce((s, r) => s + Number(r[primary] || (fallback ? r[fallback] : 0) || 0), 0);

// Shared, case/extension-tolerant logo resolver (see pdf/logo-data-uri.js).
const { logoDataUri } = require('./logo-data-uri');

// Sister/ASP company identity used on the agri bill letterhead.
function agriCompany(cfg) {
  const ident = getCompanyIdentity(cfg);
  const isPartnership = String(cfg.is_partnership || '').toLowerCase() === 'true';
  return {
    name: cfg.s_company || ident.name || '',
    address1: cfg.s_address1 || ident.address1 || '',
    place: cfg.s_place || '',
    pin: cfg.s_pin || '',
    state: cfg.s_state || '',
    stCode: cfg.s_st_code || '',
    mobile: cfg.s_mobile || cfg.mobile || cfg.tn_phone || '',
    pan: cfg.s_pan || cfg.pan || '',
    gstin: cfg.s_gstin || '',
    sbl: cfg.s_sbl || cfg.sbl || '',
    email: cfg.s_email || cfg.email || '',
    idLabel: isPartnership ? 'PARTNERSHIP' : 'CIN',
    idValue: isPartnership ? (cfg.partnership_name || '') : (cfg.cin || ''),
    logoDataUri: logoDataUri(cfg),
    short: cfg.short_name || cfg.s_company || ident.name || '',
  };
}

function buildAgriBillView(billData, cfg, billNo) {
  const seller = billData.seller || {};
  const s = billData.summary || {};
  const lineItems = billData.lineItems || [];
  const showHsn = readFlag(cfg.flag_hsn, true);
  const stripe = readFlag(cfg.flag_invoice_stripe, true);
  const co = agriCompany(cfg);

  // Seller detail lines (consignee column is empty on a self-generated BoS).
  const sellerLines = [];
  sellerLines.push('M/s.' + (seller.name || ''));
  if (seller.address) sellerLines.push(seller.address);
  if (seller.place) sellerLines.push(String(seller.place).toUpperCase() + (seller.pan ? '   PAN:' + seller.pan : ''));
  if (seller.state) sellerLines.push('STATE:' + String(seller.state).toUpperCase() + '   CODE:' + (seller.st_code || ''));
  if (seller.cr) sellerLines.push('CR.' + String(seller.cr).replace(/^\s*CR\.?\s*/i, ''));

  const rows = lineItems.map((li) => {
    const totalQty = (li.totalQty != null) ? li.totalQty : ((li.pqty || li.qty || 0) + (li.refundQty || 0));
    return {
      lot: String(li.lot || '').padStart(3, '0'),
      qty: Number(li.qty || 0),
      totalQty,
      price: Number(li.prate || li.price || 0),
      value: Number(li.prate || li.price || 0) * Number(li.pqty || li.qty || 0),
      taxable: Number(li.puramt || li.amount || 0),
    };
  });

  const qtySum = sumKey(lineItems, 'qty');
  const totalQtySum = lineItems.reduce((a, li) =>
    a + (li.totalQty != null ? li.totalQty : ((li.pqty || li.qty || 0) + (li.refundQty || 0))), 0);
  const valueSum = lineItems.reduce((a, li) => a + (li.prate || li.price) * (li.pqty || li.qty), 0);
  const taxableSum = s.totalPuramt || sumKey(lineItems, 'puramt', 'amount');
  const netAmount = s.netAmount || s.totalPuramt || valueSum;

  return {
    cfg, co, showHsn, stripe,
    padRows: Math.max(0, 14 - rows.length),
    billNo: String(billNo),
    billDate: billData.billDate || '',
    eTradeNo: billData.eTradeNo || cfg.e_trade_no || '',
    sellerLines,
    descGoods: cfg.desc_goods || 'CARDAMOM',
    hsnCode: cfg.hsn_cardamom || '09083120',
    rows,
    totals: { qtySum, totalQtySum, valueSum, taxableSum },
    totalsRows: [
      ['Total Taxable Value', taxableSum],
      ['Total Integrated Tax', s.igst || 0],
      ['Total Central Tax', s.cgst || 0],
      ['Total State Tax', s.sgst || 0],
      ['Round UP/DOWN', s.roundDiff || 0],
    ],
    netAmount,
    netAmountWords: amountToWords(Math.round(netAmount)) + ' Only',
  };
}

async function generateAgriBillHtmlPDF(billData, cfg, billNo) {
  const view = buildAgriBillView(billData, cfg, billNo);
  const tpl = getInvoiceTemplate('agri-bill', cfg);
  return htmlToPdf(tpl.render(view));
}

// Bulk: bills = [{ billData, billNo }]. Renders each, merges to one PDF.
async function generateAgriBillsHtmlBatchPDF(bills, cfg) {
  const { mergePdfs } = require('./merge-pdf');
  const parts = [];
  for (const b of bills) parts.push(await generateAgriBillHtmlPDF(b.billData, cfg, b.billNo));
  return mergePdfs(parts);
}

module.exports = { generateAgriBillHtmlPDF, generateAgriBillsHtmlBatchPDF, buildAgriBillView };
