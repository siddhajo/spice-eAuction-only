// ── Debit Note (Tax Invoice On Commission) — HTML/template renderer ───────
//
// The Letterhead layout for a debit note (used for BOTH the dealer `debit_notes` and
// the planter `debit_notes_planter` tables — they share the same document).
// Mirrors the data assembly of the legacy PDFKit `_renderDebitNote` in
// server.js (dealer lookup → per-lot allocation of the DN amount → tax rows),
// but emits the shared Letterhead HTML look: logo letterhead + colon-aligned receiver
// block, consistent with the sales / commission / bill-of-supply templates.
//
// Engine/template selection is the same as the other docs:
//   cfg.debit_note_engine   ('html' → this renderer)
//   cfg.debit_note_template ('letterhead' default; see templates/debit-note/)

const { effectiveCompany } = require('../invoice-pdf');
const { amountToWords } = require('../amount-words');
const { getInvoiceTemplate } = require('./invoice-templates');
// Shared NAME / STREET / TOWN-PIN / STATE+CODE / details-two-per-row party box.
const { partyBlock } = require('../party-block');
const { htmlToPdf } = require('./htmlToPdf');
const { withWatermark } = require('./watermark');
const { logoDataUri } = require('./logo-data-uri');
const { formatDebitNoteNo } = require('../report-formatters');

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
// `opts.planter` marks a `debit_notes_planter` row so the number picks up the
// planter prefix/suffix settings rather than the dealer pair — the two tables
// share this renderer, so the caller has to say which it is.
function buildDebitNoteView(dn, db, cfg, opts) {
  opts = opts || {};
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
  const _rawNoteNo = dn.note_no ? String(dn.note_no).trim() : String(dn.id || '');

  return {
    co, cfg,
    title: 'Tax Invoice On Commission',
    noteNo: formatDebitNoteNo(cfg, _rawNoteNo, {
      planter: !!opts.planter,
      ano: dn.ano,
      legacy: _rawNoteNo + '/' + noteSeason,
    }),
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
      // The printable block — the same shape every other document's party
      // box uses (party-block.js).
      block: partyBlock({
        name: dealerName,
        address: rcv.padd,
        place: rcv.ppla, pin: rcv.pin,
        state, st_code: stCode,
        gstin: gstinClean, pan: rcv.pan, sbl,
      }),
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

// How many notes share ONE Chromium render. The templates are fragments, so a
// slice of them concatenates into a single HTML document that Chromium lays
// out and encodes once — which is where the saving comes from, because almost
// all of the per-note cost was the render itself plus a fresh copy of the
// logo and font subsets in every resulting PDF.
//
// Why slices and not "all of them in one go": that is a tens-of-megabytes HTML
// document to ship over CDP, which blows past the print timeout and risks an
// OOM kill of Chromium on a container. 25 matches the commission bill, which
// has run at this size for a while. Overridable for a box with more headroom.
const PAGES_PER_RENDER = (() => {
  const n = Number(process.env.DEBIT_NOTE_PAGES_PER_RENDER);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 25;
})();

// One self-contained HTML document from a slice of notes. `first` is per
// DOCUMENT, not per batch: the template emits its <style> only for the first
// fragment, so every slice needs its own copy.
//
// The watermark goes on ONCE for the whole document rather than once per note
// — the pages are fragments in a single body, and N stacked copies of a faint
// layer is not a faint layer.
function renderChunk(tpl, chunk, db, cfg, opts) {
  const pages = chunk.map((dn, i) => {
    const view = buildDebitNoteView(dn, db, cfg, opts);
    view.first = i === 0;
    return tpl.render(view);
  });
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + pages.join('') + '</body></html>';
  return htmlToPdf(withWatermark(html, cfg));
}

async function generateDebitNoteHtmlPDF(dn, db, cfg, opts) {
  const tpl = getInvoiceTemplate('debit-note', cfg);
  return renderChunk(tpl, [dn], db, cfg, opts);
}

// Batch: one merged PDF across many DN rows (mirrors the *-bulk routes).
//
// This used to render one Chromium PDF per note and merge them, which is what
// made a whole trade's planter notes unusable at volume: a 1000-lot trade
// raises ~721 of them, and that shape took 207 s to produce a 129 MB file
// (every note carrying its own copy of the 114 KB logo) with a ~1.5 GB peak.
// Slicing instead means one render per 25 notes and one set of embedded
// assets per slice. Safe alongside the DB reads buildDebitNoteView does:
// sql.js is synchronous and each slice's views are all built before its
// first await, so no two reads interleave.
async function generateDebitNotesHtmlBatchPDF(dns, db, cfg, opts) {
  const tpl = getInvoiceTemplate('debit-note', cfg);
  const list = dns || [];
  if (list.length <= PAGES_PER_RENDER) return renderChunk(tpl, list, db, cfg, opts);
  // Serial across slices: parallel renders in one Chromium only compete for
  // the memory this is trying to stay inside of. Merged in list order,
  // because note numbers run in sequence and an operator flipping through
  // the batch expects them to.
  const { mergePdfs } = require('./merge-pdf');
  const parts = [];
  for (let i = 0; i < list.length; i += PAGES_PER_RENDER) {
    parts.push(await renderChunk(tpl, list.slice(i, i + PAGES_PER_RENDER), db, cfg, opts));
  }
  return mergePdfs(parts);
}

module.exports = { buildDebitNoteView, generateDebitNoteHtmlPDF, generateDebitNotesHtmlBatchPDF };
