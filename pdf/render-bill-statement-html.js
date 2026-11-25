// ── Bill Statement (RD purchase) — one A4 page per DEALER ────────────────
//
// The Payment Voucher next to it prints one page per LOT. A dealer with
// twenty lots therefore gets twenty pages, which is the right document for
// filing against each sale and the wrong one for telling the dealer what he
// is owed. This is that second view: one page, one row per lot, and the
// payment arithmetic closed off at the bottom — total, less TDS, net.
//
// Both are built from the SAME per-lot numbers (purchaseCommissionContext →
// commissionPagesFromLots in server.js), so they cannot drift apart.

const { effectiveCompany } = require('../invoice-pdf');
const { amountToWords } = require('../amount-words');
const { getInvoiceTemplate } = require('./invoice-templates');
const { partyBlock } = require('../party-block');
const { htmlToPdf } = require('./htmlToPdf');
const { withWatermark } = require('./watermark');
const { logoDataUri } = require('./logo-data-uri');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One statement's view model. `stmt` is what the route assembles:
//   { seller, auction:{ano,date}, perLot:[{line, commission, cgst, sgst, igst, nett}], tds }
function buildStatementView(stmt, cfg, first) {
  const co = effectiveCompany(cfg);
  co.logoDataUri = logoDataUri(cfg);
  const seller = stmt.seller || {};
  const auction = stmt.auction || {};

  // The seller's phone and bank account ride the party box only when the
  // commission-bank flag is on — same rule as the Payment Voucher, so the
  // two documents show a dealer the same way.
  const showSellerBank = ['true', '1', 'yes', 'on']
    .includes(String((cfg && cfg.flag_commission_bank) || '').trim().toLowerCase());
  const sellerBlock = partyBlock(seller, { omit: showSellerBank ? [] : ['PH', 'A/C'] });

  // One row per lot. Payable is rounded to the rupee per ROW, and the total
  // is the sum of those rounded rows — not a rounded sum. The dealer is paid
  // in whole rupees per lot, so the column has to add up to what the column
  // says, not to a figure recomputed from the paise.
  const rows = (stmt.perLot || []).map((pl, i) => {
    const li = pl.line || {};
    const gst = round2(Number(pl.cgst || 0) + Number(pl.sgst || 0) + Number(pl.igst || 0));
    return {
      sl: i + 1,
      lot: li.lot == null ? '' : String(li.lot),
      qty: Number(li.qty || 0),
      amount: round2(li.cardamomCost),
      refund: round2(li.refundAmount),
      commission: round2(pl.commission),
      gst,
      payable: Math.round(Number(pl.nett) || 0),
    };
  });

  const totalPayable = rows.reduce((a, r) => a + r.payable, 0);
  // TDS is NOT recomputed here. It is 194Q, it depends on a running annual
  // threshold, and the figure the office already deducted is the one stored
  // on the purchase row — recomputing it would quietly disagree with the
  // bank file and the Payments screen.
  const tds = Math.round(Number(stmt.tds) || 0);
  const net = totalPayable - tds;

  return {
    first: !!first,
    cfg,
    co,
    ano: auction.ano == null ? '' : String(auction.ano),
    auctionDate: auction.date || '',
    seller: { block: sellerBlock },
    rows,
    totalPayable,
    tds,
    net,
    netWords: amountToWords(Math.round(net)) + ' only',
  };
}

// Same slicing rule as the commission bills: every page carries its own
// inline logo data: URI, so a whole trade's statements concatenated is a
// document big enough to time Chromium out. Render in slices, merge in order.
const PAGES_PER_RENDER = (() => {
  const n = Number(process.env.BILL_STATEMENT_PAGES_PER_RENDER);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 25;
})();

function renderChunk(tpl, chunk, cfg) {
  const pages = chunk.map((s, i) => tpl.render(buildStatementView(s, cfg, i === 0)));
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    pages.join('') + '</body></html>';
  return htmlToPdf(withWatermark(html, cfg, 'commission_bill'));
}

async function generateBillStatementPDF(statements, cfg) {
  const tpl = getInvoiceTemplate('bill-statement', cfg);
  const list = statements || [];
  if (list.length <= PAGES_PER_RENDER) return renderChunk(tpl, list, cfg);
  const { mergePdfs } = require('./merge-pdf');
  const parts = [];
  for (let i = 0; i < list.length; i += PAGES_PER_RENDER) {
    parts.push(await renderChunk(tpl, list.slice(i, i + PAGES_PER_RENDER), cfg));
  }
  return mergePdfs(parts);
}

module.exports = { generateBillStatementPDF, buildStatementView };
