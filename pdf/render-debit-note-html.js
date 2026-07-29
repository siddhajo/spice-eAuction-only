// ── Debit Note (Tax Invoice On Commission) — HTML/template renderer ───────
//
// The RNS layout for a debit note (used for BOTH the dealer `debit_notes` and
// the planter `debit_notes_planter` tables — they share the same document).
// Mirrors the data assembly of the legacy PDFKit `_renderDebitNote` in
// server.js (dealer lookup → per-lot allocation of the DN amount → tax rows),
// but emits the shared RNS HTML look: logo letterhead + colon-aligned receiver
// block, consistent with the sales / commission / bill-of-supply templates.
//
// Engine/template selection is the same as the other docs:
//   cfg.debit_note_engine   ('html' → this renderer)
//   cfg.debit_note_template ('rns' default; see templates/debit-note/)

const { effectiveCompany } = require('../invoice-pdf');
const { amountToWords } = require('../amount-words');
const { getInvoiceTemplate } = require('./invoice-templates');
const { htmlToPdf } = require('./htmlToPdf');
const { logoDataUri } = require('./logo-data-uri');

const _MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
// Handles ISO (yyyy-mm-dd) AND the stored "16-Aug-25" style → DD/MM/YYYY.
function fmtDate(d) {
  if (!d) return '';
  const s = String(d);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{1,2})[-/]([A-Za-z]{3})[A-Za-z]*[-/](\d{2,4})/);
  if (m) {
    const mm = _MON[m[2].toLowerCase()] || m[2];
    const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${String(m[1]).padStart(2, '0')}/${mm}/${yyyy}`;
  }
  return s;
}

// Build the template view model from a stored debit-note row + a DB handle.
// `db` is the better-sqlite wrapper (has .get/.all), matching server.js usage.
function buildDebitNoteView(dn, db, cfg) {
  const co = effectiveCompany(cfg);
  co.logoDataUri = logoDataUri(cfg);

  // A Debit Note is a purchase-side instrument — `dn.name` is the DEALER
  // (supplier) name, looked up in `traders` for the receiver address/GSTIN.
  const dealerName = String(dn.name || '').trim();
  const rcv = (dealerName
    ? db.get('SELECT * FROM traders WHERE UPPER(name) = UPPER(?) LIMIT 1', [dealerName])
    : null) || {};

  const auction = db.get('SELECT * FROM auctions WHERE ano = ? LIMIT 1', [dn.ano]);
  let lots = [];
  if (auction) {
    lots = db.all(
      `SELECT lot_no, qty, prate, puramt, pqty
         FROM lots
        WHERE auction_id = ?
          AND UPPER(COALESCE(name,'')) = UPPER(?)
          AND amount > 0
        ORDER BY CAST(lot_no AS INTEGER), lot_no`,
      [auction.id, dealerName]
    );
  }

  // Distribute the DN amount across lots proportionally to puramt so the
  // per-lot Commission column sums back to the DN total.
  const totalPuramt = lots.reduce((s, l) => s + Number(l.puramt || 0), 0);
  const dnAmount = Number(dn.amount || 0);
  if (lots.length && totalPuramt > 0) {
    let allocated = 0;
    lots = lots.map((l, idx) => {
      const isLast = idx === lots.length - 1;
      const share = isLast
        ? Math.round((dnAmount - allocated) * 100) / 100
        : Math.round((dnAmount * Number(l.puramt) / totalPuramt) * 100) / 100;
      allocated += share;
      return { ...l, discount: share };
    });
  } else {
    lots = [{ lot_no: '—', qty: 0, prate: 0, puramt: 0, discount: dnAmount }];
  }

  const rows = lots.map((l, i) => ({
    sl: i + 1,
    lot: l.lot_no || '',
    qty: Number(l.qty || 0),
    rate: Number(l.prate || 0),
    value: Number(l.qty || 0) * Number(l.prate || 0),
    commission: Number(l.discount || 0),
    incidental: 0,
  }));
  const totals = {
    qty: rows.reduce((s, r) => s + r.qty, 0),
    value: rows.reduce((s, r) => s + r.value, 0),
    commission: rows.reduce((s, r) => s + r.commission, 0),
    incidental: rows.reduce((s, r) => s + r.incidental, 0),
  };
  totals.taxable = totals.commission + totals.incidental;

  const rRate = Number(cfg.discount_gst) || Number(cfg.gst_service) || 18;
  const halfRate = rRate / 2;
  const roundOff = Math.round((Number(dn.total || 0)
    - (Number(dn.amount || 0) + Number(dn.cgst || 0) + Number(dn.sgst || 0) + Number(dn.igst || 0))) * 100) / 100;

  const gstinClean = String(rcv.cr || '').trim().replace(/^GSTIN\.?/i, '').trim();
  const sbl = String(rcv.aadhar || '').trim();          // SBL lives in traders.aadhar
  const state = String(rcv.pstate || dn.state || '').trim().toUpperCase();
  const stCode = String(rcv.pst_code || '').trim();
  const noteSeason = cfg.season_short || cfg.tally_season || '26-27';

  return {
    co, cfg,
    title: 'Tax Invoice On Commission',
    noteNo: (dn.note_no ? String(dn.note_no).trim() : String(dn.id || '')) + '/' + noteSeason,
    // NB: field is `noteDate`, not `date` — `date` is a registered Handlebars
    // helper, so `{{date}}` would invoke the helper instead of this value.
    noteDate: fmtDate(dn.date),
    ano: dn.ano || '',
    auctionDate: fmtDate(auction && auction.date),
    receiver: {
      name: dealerName,
      addr: String(rcv.padd || '').trim(),
      place: [rcv.ppla, rcv.pin].filter((s) => s && String(s).trim()).join(' '),
      gstin: gstinClean,
      pan: String(rcv.pan || '').trim(),
      sbl,
      state, stCode,
      placeOfSupply: (stCode ? stCode + ' ' : '') + state,
      aadhar: '', // aadhar column is repurposed for SBL on traders
      nature: cfg.commission_nature || 'Service of an Auctioneer/Commission Agent',
      sac: cfg.commission_sac || '996111',
    },
    rows,
    padRows: Math.max(0, 12 - rows.length),
    totals,
    taxRows: [
      { label: `CGST @ ${halfRate}% on C&H`, amt: Number(dn.cgst || 0) },
      { label: `SGST @ ${halfRate}% on C&H`, amt: Number(dn.sgst || 0) },
      { label: `IGST @ ${rRate}% on C&H`, amt: Number(dn.igst || 0) },
      { label: 'Round Off', amt: roundOff },
    ],
    grandTotal: Number(dn.total || 0),
    grandTotalWords: amountToWords(Number(dn.total || 0)) + ' Only',
    forCo: 'For ' + (co.short || co.name || '').toUpperCase(),
  };
}

async function generateDebitNoteHtmlPDF(dn, db, cfg) {
  const view = buildDebitNoteView(dn, db, cfg);
  const tpl = getInvoiceTemplate('debit-note', cfg);
  return htmlToPdf(tpl.render(view));
}

// Batch: one merged PDF across many DN rows (mirrors the *-bulk routes).
async function generateDebitNotesHtmlBatchPDF(dns, db, cfg) {
  const { mergePdfs } = require('./merge-pdf');
  const buffers = [];
  for (const dn of dns) buffers.push(await generateDebitNoteHtmlPDF(dn, db, cfg));
  return buffers.length === 1 ? buffers[0] : mergePdfs(buffers);
}

module.exports = { buildDebitNoteView, generateDebitNoteHtmlPDF, generateDebitNotesHtmlBatchPDF };
