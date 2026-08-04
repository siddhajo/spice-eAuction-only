// ── HTML Purchase Invoice orchestrator ────────────────────────────────────
// Drop-in analog to invoice-pdf.js `generatePurchaseInvoicePDF(invoiceData,
// cfg, invoiceNo)`. Builds a view model from the same enriched invoiceData the
// route passes today, renders templates/purchase-invoice/<template>.hbs → PDF.
// All math stays in calculations.js / the route; this only derives display.

const { effectiveCompany } = require('../invoice-pdf');
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

function buildPurchaseInvoiceView(invoiceData, cfg, invoiceNo) {
  const seller = invoiceData.seller || {};
  const s = invoiceData.summary || {};
  const lineItems = invoiceData.lineItems || [];
  const showHsn = readFlag(cfg.flag_hsn, true);
  const stripe = readFlag(cfg.flag_invoice_stripe, true);

  // Buyer (the purchaser — our company). Same fallback chain as the PDFKit path.
  const ident = getCompanyIdentity(cfg);
  const coEff = effectiveCompany(cfg);
  const buyer = invoiceData.buyer || {
    name: ident.name, address: ident.address1, place: '', pin: '',
    state: ident.state, st_code: ident.stateCode, gstin: ident.gstin, pan: ident.pan,
  };
  const buyerGstin = buyer.gstin || coEff.gstin || '';
  const buyerStCode = buyer.st_code || coEff.stateCode || '';

  // Detail grid pairs (colon rows in the PDFKit version).
  const leftPairs = [
    ['TRANSPORT', invoiceData.transport || 'BY ROAD'],
    ['VEHICLE NO', invoiceData.vehicleNo || ''],
    ['STATION', invoiceData.station || (seller.place || '').toUpperCase()],
    ['e-AUCTION No', invoiceData.eTradeNo || ''],
  ];
  const rightPairs = [
    ['INVOICE NO', ''],  // blank in the reference layout
    ['DATE', invoiceData.invoiceDate || ''],
    ['PLACE OF SUPPLY', (cfg.s_place || '').toUpperCase() + (cfg.s_state ? '  [' + String(cfg.s_state).toUpperCase() + ']' : '')],
    ['REVERSE CHARGE', ''],
  ];

  // Party (billed to / shipped to) — identical content both columns.
  const plainLines = [(buyer.name || '').toUpperCase()];
  const buyerAddr = [buyer.address, buyer.place ? 'DOOR No.650, ' + buyer.place : '']
    .filter(Boolean).join(', ').toUpperCase();
  if (buyerAddr) plainLines.push(buyerAddr);
  const pairLines = [];
  if (buyerGstin) pairLines.push(['GSTIN', buyerGstin]);
  if (buyer.pan) pairLines.push(['PAN', buyer.pan]);
  if (buyer.state) pairLines.push(['STATE', String(buyer.state).toUpperCase() + '     CODE:' + buyerStCode]);

  // Per-lot trader-sample quantity (Kgs), flat from settings — same value the
  // commission bill uses. 0 when the feature is off.
  const traderSampleKg = Number(cfg.sb_trader_sample) || 0;

  // Line items.
  const rows = lineItems.map((li) => {
    const qty = Number(li.qty || 0);
    const totalQty = (li.totalQty != null) ? li.totalQty : ((li.pqty || li.qty || 0) + (li.refundQty || 0));
    // Sample-bag refund weight added to reach Total Qty (cfg.sb_refund per lot).
    const refundKg = Math.max(0, totalQty - qty);
    return {
      lot: String(li.lot || '').padStart(3, '0'),
      qty,
      // Sample (kg)   = sample refund + trader sample.
      // Discount (kg) = trader sample.
      // Total Qty stays qty + sample refund, since the trader sample is both
      // added (Sample) and removed (Discount): qty + Sample − Discount.
      sample: +(refundKg + traderSampleKg).toFixed(3),
      discount: +(traderSampleKg).toFixed(3),
      totalQty,
      price: Number(li.prate || li.price || 0),
      value: Number(li.prate || li.price || 0) * Number(li.pqty || li.qty || 0),
      taxable: Number(li.puramt || li.amount || 0),
      cgst: Number(li.cgst || 0),
      sgst: Number(li.sgst || 0),
      igst: Number(li.igst || 0),
    };
  });

  const taxableSum = sumKey(lineItems, 'puramt', 'amount');
  const totalCgst = sumKey(lineItems, 'cgst') || s.totalCgst || s.cgst || 0;
  const totalSgst = sumKey(lineItems, 'sgst') || s.totalSgst || s.sgst || 0;
  const totalIgst = sumKey(lineItems, 'igst') || s.totalIgst || s.igst || 0;
  const valueSum = lineItems.reduce((a, li) => a + (li.prate || li.price) * (li.pqty || li.qty), 0);
  const qtySum = sumKey(lineItems, 'qty');
  const totalQtySum = lineItems.reduce((a, li) =>
    a + (li.totalQty != null ? li.totalQty : ((li.pqty || li.qty || 0) + (li.refundQty || 0))), 0);

  const roundDiff = s.roundDiff || 0;
  const totalValue = s.grandTotal || (taxableSum + totalCgst + totalSgst + totalIgst + roundDiff);
  const tdsAmount = s.tdsAmount || 0;
  const invoiceAmount = s.invoiceAmount || (totalValue - tdsAmount);

  const totalsRows = [
    ['Total Taxable Value', taxableSum],
    ['Total Integrated Tax', totalIgst],
    ['Total Central Tax', totalCgst],
    ['Total State Tax', totalSgst],
    ['Round UP/DOWN', roundDiff],
  ];
  if (s.addlCharge && s.addlCharge !== 0) {
    totalsRows.push([(s.addlChargeName || cfg.addl_charge_name || 'Additional Charge').toString(), s.addlCharge]);
  }

  return {
    cfg, showHsn, stripe,
    padRows: Math.max(0, 14 - rows.length),
    seller: {
      name: (seller.name || '').toUpperCase(),
      addr: [seller.address, seller.place, seller.pin].filter(Boolean).join(', '),
      // Strip any stored "GSTIN." label prefix — the letterhead template prints
      // its own "GSTIN." so a stored "GSTIN.32…" would otherwise double up.
      gstin: String(seller.gstin || seller.cr || '').replace(/^\s*GSTIN[.\s]*/i, ''),
      pan: seller.pan || '',
      sbl: seller.sbl || seller.aadhar || '',   // SBL is stored in traders.aadhar
    },
    leftPairs, rightPairs, plainLines, pairLines,
    auctionNo: invoiceData.auctionNo || invoiceData.eTradeNo || '',
    saleDate: invoiceData.invoiceDate || '',
    descGoods: cfg.desc_goods || 'CARDAMOM',
    hsnCode: cfg.hsn_cardamom || '09083120',
    rows,
    totals: { qtySum, totalQtySum, valueSum, taxableSum, totalCgst, totalSgst, totalIgst },
    // SubTotal = taxable + all taxes (before TDS / round-off).
    subTotal: +(taxableSum + totalCgst + totalSgst + totalIgst).toFixed(2),
    gstRate: Number(cfg.gst_goods || 5),
    gstHalf: Number(cfg.gst_goods || 5) / 2,
    roundDiff,
    totalsRows,
    totalValue,
    tdsAmount,
    invoiceAmount,
    invoiceAmountWords: amountToWords(Math.round(invoiceAmount)) + ' Only',
    forSeller: 'For ' + (seller.name || '').toUpperCase(),
  };
}

async function generatePurchaseInvoiceHtmlPDF(invoiceData, cfg, invoiceNo) {
  const view = buildPurchaseInvoiceView(invoiceData, cfg, invoiceNo);
  const tpl = getInvoiceTemplate('purchase-invoice', cfg);
  return htmlToPdf(tpl.render(view));
}

// Bulk: invoices = [{ invoiceData, invoiceNo }]. Renders each, merges to one PDF.
async function generatePurchaseInvoicesHtmlBatchPDF(invoices, cfg) {
  const { mergePdfs } = require('./merge-pdf');
  const parts = [];
  for (const inv of invoices) parts.push(await generatePurchaseInvoiceHtmlPDF(inv.invoiceData, cfg, inv.invoiceNo));
  return mergePdfs(parts);
}

module.exports = { generatePurchaseInvoiceHtmlPDF, generatePurchaseInvoicesHtmlBatchPDF, buildPurchaseInvoiceView };
