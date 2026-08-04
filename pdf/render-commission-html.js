// ── HTML Commission Bill orchestrator (batch / multi-page) ────────────────
// Analog to invoice-pdf.js `generateCommissionBoSBatchPDF(payloads, cfg)`.
// The download route is batch-only and prints one A4 page per bill, so this
// renders each bill to a page fragment and combines them into ONE HTML doc
// (page breaks between). payloads = [{ billNo, billData }, ...].

const fs = require('fs');
const path = require('path');
const { effectiveCompany } = require('../invoice-pdf');
const { amountToWords } = require('../amount-words');
const { getInvoiceTemplate } = require('./invoice-templates');
const { htmlToPdf } = require('./htmlToPdf');

// Shared, case/extension-tolerant logo resolver (see pdf/logo-data-uri.js).
const { logoDataUri } = require('./logo-data-uri');

function buildCommissionView(billData, cfg, billNo, first) {
  const co = effectiveCompany(cfg);
  co.logoDataUri = logoDataUri(cfg);
  const seller = billData.seller || {};
  const purchaser = billData.purchaser || {};
  const auction = billData.auction || {};
  const li = (billData.lineItems && billData.lineItems[0]) || {};
  const gstRate = billData.gstRate != null ? billData.gstRate : (Number(cfg.commission_gst_rate) || 9.0);
  const cgst = Number(billData.cgst || 0), sgst = Number(billData.sgst || 0), igst = Number(billData.igst || 0);
  const commission = Number(billData.commission || 0);
  const cardamomCost = Number(li.cardamomCost || (li.qty || 0) * (li.rate || 0));
  const refundAmount = Number(li.refundAmount || 0);
  const nett = billData.nett != null ? billData.nett
    : (cardamomCost + refundAmount - commission - cgst - sgst - igst);

  const sellerLines = [];
  sellerLines.push('Sri/M/s.' + (seller.name || ''));
  if (seller.address) sellerLines.push(seller.address);
  if (seller.place) sellerLines.push(String(seller.place).toUpperCase());
  if (seller.state) sellerLines.push(String(seller.state).toUpperCase() + ' CODE:' + (seller.st_code || ''));
  sellerLines.push('CR.' + String(seller.cr || '').replace(/^\s*CR\.?\s*/i, '') + (seller.pan ? ' [PAN:' + seller.pan + ']' : ''));

  const purchaserLines = [];
  purchaserLines.push('M/s.' + (purchaser.name || '') + (purchaser.invo ? ' [INV:' + purchaser.invo + ']' : ''));
  if (purchaser.address) purchaserLines.push(purchaser.address);
  if (purchaser.place) purchaserLines.push(String(purchaser.place).toUpperCase() + (purchaser.pin ? ' [PIN:' + purchaser.pin + ']' : ''));
  if (purchaser.state) purchaserLines.push(String(purchaser.state).toUpperCase() + ' CODE:' + (purchaser.st_code || '') + (purchaser.sbl ? ' [SBL:' + purchaser.sbl + ']' : ''));
  purchaserLines.push('GSTIN:' + (purchaser.gstin || '') + (purchaser.pan ? ' [PAN:' + purchaser.pan + ']' : ''));

  // Optional "trader sample" deduction (some customers show it as a
  // separate row and fold its weight into the SAMPLE REFUND line). Source, in
  // priority order: an explicit route-supplied value, a per-line field, then
  // the company setting `sb_trader_sample` ("Trader Sample (Kgs)") — the last
  // of which is what makes it appear at all on the standard Letterhead commission
  // bill, since no route populates the per-line fields today. Rate mirrors the
  // lot rate; amount is qty × rate.
  const tsKg = Number(cfg && cfg.sb_trader_sample) || 0;
  const traderSample = billData.traderSample
    || (li.traderSampleQty || li.traderSampleAmount
        ? { qty: Number(li.traderSampleQty || 0), rate: Number(li.rate || 0), amount: Number(li.traderSampleAmount || 0) }
        : (tsKg > 0
            ? { qty: tsKg, rate: Number(li.rate || 0), amount: Math.round(tsKg * Number(li.rate || 0) * 100) / 100 }
            : null));
  // Grand Total is nett rounded to the whole rupee; the paise become "Round Off".
  // If the route supplies an explicit roundDiff, honor it instead.
  const grandTotal = billData.roundDiff != null ? nett + Number(billData.roundDiff) : Math.round(nett);
  const roundDiff = billData.roundDiff != null
    ? Number(billData.roundDiff)
    : Math.round((grandTotal - nett) * 100) / 100;

  // Combined single-line address: "<address>, <place>-<pin> <state>" with no
  // "Place:" label. Trailing comma/space on the stored address is trimmed so we
  // don't get a doubled comma before the place.
  const addressFull = (p) => {
    const addr  = String((p && p.address) || '').trim().replace(/[,\s]+$/, '');
    const place = String((p && p.place) || '').trim();
    const pin   = String((p && p.pin) || '').trim();
    const placePin = place ? (pin ? place + '-' + pin : place) : pin;
    const line = [addr, placePin].filter(Boolean).join(', ');
    return [line, String((p && p.state) || '').trim()].filter(Boolean).join(' ');
  };

  return {
    first, cfg, co,
    // Show the seller's phone + bank account on the bill (Letterhead layout), gated by
    // the flag_commission_bank toggle. Coerced to a real boolean so Handlebars
    // {{#if}} works (a string "false" would otherwise read as truthy).
    showSellerBank: ['true', '1', 'yes', 'on'].includes(String((cfg && cfg.flag_commission_bank) || '').trim().toLowerCase()),
    // Party objects — let alternate templates lay out seller/buyer freely.
    // `cr` is normalized to strip any stored "CR."/"CR " label prefix so a
    // template that prints "CR.{{seller.cr}}" doesn't double it to "CR.CR.…".
    seller: { ...seller, cr: String(seller.cr || '').replace(/^\s*CR[.\s]+/i, ''), addressFull: addressFull(seller) },
    purchaser: { ...purchaser, addressFull: addressFull(purchaser) },
    crpt: billData.crpt || '',
    billNo: String(billNo),
    lotNo: /^\d+$/.test(String(li.lot || '')) ? String(li.lot).padStart(3, '0') : (li.lot || ''),
    subtitle: '[ MEMORANDAM OF CARDAMOM SOLD THROUGH ' + (cfg.short_name || '') + ' ]',
    ano: auction.ano || '', auctionDate: auction.date || '',
    gstRate,
    sellerLines, purchaserLines,
    hsnCardamom: billData.hsnCardamom || cfg.hsn_cardamom || '09083120',
    hsnCommission: billData.hsnCommission || '996111',
    cardamom: {
      lot: /^\d+$/.test(String(li.lot || '')) ? String(li.lot).padStart(3, '0') : (li.lot || '—'),
      qty: Number(li.qty || 0), bags: li.bags || '', rate: Number(li.rate || 0), cost: cardamomCost,
    },
    refund: (li.refundQty > 0 || refundAmount > 0)
      ? { qty: Number(li.refundQty || 0), rate: Number(li.refundRate || 0), amount: refundAmount } : null,
    // Letterhead layout shows the SAMPLE REFUND line as (sample refund + trader sample):
    // the gross sample weight returned to the seller. The separate TRADER SAMPLE
    // deduction row still applies, so the net sample effect (and the Grand Total)
    // is unchanged — this only relabels what the operator sees on that line.
    sampleRefund: (() => {
      const rQ = Number(li.refundQty || 0), rA = refundAmount;
      const tQ = traderSample ? Number(traderSample.qty || 0) : 0;
      const tA = traderSample ? Number(traderSample.amount || 0) : 0;
      if (rQ + tQ <= 0 && rA + tA <= 0) return null;
      return { qty: rQ + tQ, rate: Number(li.refundRate || li.rate || 0), amount: rA + tA };
    })(),
    traderSample,
    commission: {
      amount: commission,
      cgstRate: cgst > 0 ? gstRate.toFixed(1) + '%' : '', cgst,
      sgstRate: sgst > 0 ? gstRate.toFixed(1) + '%' : '', sgst,
      igstRate: igst > 0 ? (2 * gstRate).toFixed(1) + '%' : '', igst,
    },
    tax: { taxable: commission, cgst, sgst, igst },
    roundDiff,
    nett,
    grandTotal,
    nettWords: amountToWords(Math.round(grandTotal)) + ' Only',
    forCo: 'for ' + (cfg.short_name || co.short || co.name || ''),
  };
}

async function generateCommissionBoSHtmlPDF(payloads, cfg) {
  const tpl = getInvoiceTemplate('commission-bill', cfg);
  const pages = payloads.map((p, i) =>
    tpl.render(buildCommissionView(p.billData, cfg, p.billNo, i === 0)));
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    pages.join('') + '</body></html>';
  return htmlToPdf(html);
}

module.exports = { generateCommissionBoSHtmlPDF, buildCommissionView };
