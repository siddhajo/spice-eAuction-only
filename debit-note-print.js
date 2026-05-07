// ============================================================================
// debit-note-print.js — credit/debit note PDF print template
// ============================================================================
//
// Produces a multi-page PDF of buyer-grouped discount notes, matching the
// reference layout the user provided. Each buyer gets their own page (or
// pages — the table paginates with C/D + B/F lines when lots overflow).
//
// Page anatomy:
//   ┌───────────────────────────────────────────────┐
//   │                ORIGINAL/DUPLICATE/TRIPLICATE  │
//   │   <BUYER NAME>                                │
//   │   <BUYER ADDRESS>                             │
//   │   GSTIN: <BUYER GSTIN>                        │
//   ├───────────────────────────────────────────────┤
//   │              CREDIT NOTE/DEBIT NOTE           │
//   ├───────────────────────────────────────────────┤
//   │ <OUR COMPANY>          No.: <note_no>/<season>│
//   │ <OUR PLACE>            Date: dd/mm/yyyy       │
//   │ GSTIN: <ours>                                 │
//   │ PAN  : <ours>                                 │
//   │ STATE: <ours>                CODE: <code>     │
//   ├───────────────────────────────────────────────┤
//   │   Discount on Sale of Cardamom HSN: 09083120  │
//   ├──┬───┬─────┬─────┬───────┬────────┬──┬───────┤
//   │Sl│Lot│ Qty │Rate │ Value │Discount│  │Taxable│
//   ├──┼───┼─────┼─────┼───────┼────────┼──┼───────┤
//   │1 │041│297.6│2474 │736262 │  10050 │  │ 10050 │
//   │…                                              │
//   ├──┴───┼─────┼─────┼───────┼────────┼──┼───────┤
//   │TOTAL │     │     │       │        │  │       │
//   ├──────┴─────┴─────┼───────┴────────┴──┼───────┤
//   │                  │   GRAND TOTAL     │       │
//   ├──────────────────┴───────────────────┴───────┤
//   │ Rupees <words> Only                           │
//   │                       For <BUYER NAME>        │
//   │                       Authorised Signatory    │
//   └───────────────────────────────────────────────┘
//
// Per-lot discount split: the debit_notes table stores summary totals
// only, so we proportionally allocate the total discount across the
// buyer's lots: lot_disc = round(lot.amount × total_disc / total_value).
// The last lot absorbs the rounding remainder so the column sum exactly
// equals the stored note total.
//
// Caller passes the auction id; we pull all debit_notes whose date matches
// the auction's date, pull lots per buyer in-range, and emit one PDF.
// ============================================================================

const PDFDocument = require('pdfkit');
const { amountToWords } = require('./amount-words');

// State-name → 2-digit GST state code. Lifted from existing project conventions.
const STATE_CODES = {
  'KERALA': '32',
  'TAMIL NADU': '33',
  'KARNATAKA': '29',
  'ANDHRA PRADESH': '37',
  'TELANGANA': '36',
  'MAHARASHTRA': '27',
  'DELHI': '07',
  'GUJARAT': '24',
  'WEST BENGAL': '19',
};

function getStateCode(name) {
  if (!name) return '';
  return STATE_CODES[String(name).toUpperCase().trim()] || '';
}

// Strip the optional "GSTIN." prefix some forms store with the GSTIN, then
// return the 10-char PAN portion (positions 3-12 of the 15-char GSTIN).
function panFromGstin(gstin) {
  if (!gstin) return '';
  const bare = String(gstin).toUpperCase().startsWith('GSTIN.')
    ? String(gstin).slice(6) : String(gstin);
  return String(bare).slice(2, 12);
}

// dd/MM/yyyy from any reasonable input (ISO yyyy-MM-dd or already dd/MM/yyyy).
function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(s);
}

// Indian-style number formatting (1,23,456.78). Negative values supported.
function fmtIndian(n) {
  if (n == null || isNaN(Number(n))) return '';
  const num = Number(n);
  const abs = Math.abs(num);
  const fixed = abs.toFixed(2);
  const [whole, frac] = fixed.split('.');
  // Last 3 digits, then groups of 2
  let out;
  if (whole.length <= 3) out = whole;
  else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    out = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return (num < 0 ? '-' : '') + out + '.' + frac;
}

// Same but with no decimal places — used for the Rate column.
function fmtIndianInt(n) {
  if (n == null || isNaN(Number(n))) return '';
  const v = Math.round(Number(n));
  const s = String(Math.abs(v));
  let out;
  if (s.length <= 3) out = s;
  else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    out = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return (v < 0 ? '-' : '') + out + '.00';
}

// Quantity always shown to 3 decimals (e.g. 297.600).
function fmtQty(n) {
  if (n == null || isNaN(Number(n))) return '';
  const v = Number(n);
  const s = v.toFixed(3);
  const [whole, frac] = s.split('.');
  let head;
  if (whole.length <= 3) head = whole;
  else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    head = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return head + '.' + frac;
}

// ── Per-lot discount split ────────────────────────────────────────────────
// Allocate total_discount across `lots` proportionally to lot.amount, with
// the LAST lot absorbing the rounding remainder so the column sum matches
// the stored note total exactly.
function splitDiscount(lots, totalDiscount) {
  const totalValue = lots.reduce((s, l) => s + Number(l.amount || 0), 0);
  if (!totalValue || !lots.length) return lots.map(() => 0);
  const ratio = totalDiscount / totalValue;
  const out = lots.map(l => Math.round(Number(l.amount || 0) * ratio));
  // Reconcile rounding drift onto the LAST lot so the column sum exactly
  // equals the stored note total. Matches the reference template's
  // observed allocation (drift lands on the last row, not the largest).
  const sum = out.reduce((s, v) => s + v, 0);
  const drift = Math.round(totalDiscount - sum);
  if (drift !== 0 && out.length) {
    out[out.length - 1] += drift;
  }
  return out;
}

// ── Layout constants (A4 portrait, 20pt margin) ───────────────────────────
const PAGE_W = 595.28; // A4 width in points
const PAGE_H = 841.89; // A4 height in points
const M = 24;          // margin
const X0 = M;
const X1 = PAGE_W - M;
const W = X1 - X0;

// Column geometry for the lot-detail table. Widths chosen to match the
// reference layout proportions at A4 width.
const COLS = (() => {
  // sl, lot, qty, rate, value, discount, blank, taxable
  const w = [28, 32, 70, 60, 95, 80, 60, 95];
  const sum = w.reduce((s, v) => s + v, 0);
  // Scale to fit available width
  const scale = W / sum;
  const widths = w.map(v => v * scale);
  const xs = [X0];
  for (let i = 0; i < widths.length; i++) xs.push(xs[i] + widths[i]);
  return { widths, xs };
})();

const ROW_H = 14;     // height of a single lot row
const ROWS_PER_PAGE = 15; // matches reference (page 7 GREEN LEAF shows 15 lots before C/D)

// ── Drawing helpers ───────────────────────────────────────────────────────

function box(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

// Draw a horizontal line of column dividers across the table at row `y`.
function colDividers(doc, y) {
  for (let i = 1; i < COLS.xs.length; i++) {
    doc.moveTo(COLS.xs[i], y).lineTo(COLS.xs[i], y + ROW_H).stroke();
  }
}

// Centred or right-aligned text inside a column cell.
function cellText(doc, text, colIdx, y, opts = {}) {
  const x = COLS.xs[colIdx];
  const w = COLS.widths[colIdx];
  const align = opts.align || 'center';
  const padX = 3;
  doc.text(String(text == null ? '' : text), x + padX, y + 3, {
    width: w - padX * 2,
    height: ROW_H - 4,
    align,
    lineBreak: false,
  });
}

// ── Page renderer ─────────────────────────────────────────────────────────
// Renders one buyer page (or one of several for the same buyer). Returns
// the y position after the last drawn element.
function renderBuyerPage(doc, buyer, ourCfg, pageInfo) {
  // pageInfo = {
  //   lots: [{lot_no, qty, price, amount, discount}],   ← lots for THIS page
  //   totals: { qty, value, discount },                  ← rolling totals up to and including this page
  //   carryFromPrev: { qty, value, discount } | null,    ← B/F line if not page 1
  //   isLastPage: bool,                                  ← controls TOTAL vs C/D row + grand total
  //   pageNum: 1-based,
  //   totalPages: total pages for this buyer
  // }
  const { lots, totals, carryFromPrev, isLastPage, pageNum, totalPages } = pageInfo;

  let y = M;

  // ── Header band: buyer name + address + GSTIN ──
  doc.font('Helvetica').fontSize(8.5).text('ORIGINAL/DUPLICATE/TRIPLICATE', X0, y + 2, { width: W, align: 'right' });
  y += 14;
  doc.font('Helvetica-Bold').fontSize(13).text(buyer.name, X0, y, { width: W, align: 'center' });
  y += 16;
  doc.font('Helvetica').fontSize(8.5).text(buyer.address || '', X0, y, { width: W, align: 'center' });
  y += 11;
  // Buyer GSTIN + (page indicator if multi-page)
  let buyerLine = `GSTIN:${buyer.gstin || ''}`;
  if (totalPages > 1) buyerLine += `   Page:${pageNum}`;
  doc.text(buyerLine, X0, y, { width: W, align: 'center' });
  y += 14;
  box(doc, X0, M, W, y - M);

  // ── Title band: CREDIT NOTE/DEBIT NOTE ──
  const titleH = 18;
  box(doc, X0, y, W, titleH);
  doc.font('Helvetica-Bold').fontSize(11).text('CREDIT NOTE/DEBIT NOTE', X0, y + 4, { width: W, align: 'center' });
  y += titleH;

  // ── Our-company info band ──
  const infoH = 70;
  box(doc, X0, y, W, infoH);
  let yy = y + 4;
  doc.font('Helvetica-Bold').fontSize(10).text(ourCfg.companyName || '', X0 + 6, yy);
  // Right column: No. and Date — anchored at the right of the band
  const rightX = X0 + W * 0.6;
  doc.font('Helvetica').fontSize(9).text(`No.: ${ourCfg.noteNo || ''}/${ourCfg.season || ''}`, rightX, yy, { width: W * 0.4 - 6, align: 'right' });
  yy += 12;
  doc.font('Helvetica').fontSize(9).text(ourCfg.place || '', X0 + 6, yy);
  doc.text(`Date :${ourCfg.date || ''}`, rightX, yy, { width: W * 0.4 - 6, align: 'right' });
  yy += 12;
  doc.text(`GSTIN : ${ourCfg.gstin || ''}`, X0 + 6, yy);
  yy += 11;
  doc.text(`PAN   : ${ourCfg.pan || ''}`, X0 + 6, yy);
  yy += 11;
  doc.text(`STATE : ${(ourCfg.state || '').toUpperCase()}`, X0 + 6, yy);
  doc.text(`CODE: ${ourCfg.stateCode || ''}`, rightX, yy, { width: W * 0.4 - 6, align: 'right' });
  y += infoH;

  // ── Description band ──
  const descH = 16;
  box(doc, X0, y, W, descH);
  doc.font('Helvetica').fontSize(9).text(
    `Discount on Sale of Cardamom         HSN CODE: ${ourCfg.hsn || '09083120'}`,
    X0 + 6, y + 3, { width: W - 12 }
  );
  y += descH;

  // ── Table header ──
  const headerH = 22;
  box(doc, X0, y, W, headerH);
  // Vertical column dividers across the header
  for (let i = 1; i < COLS.xs.length; i++) {
    doc.moveTo(COLS.xs[i], y).lineTo(COLS.xs[i], y + headerH).stroke();
  }
  doc.font('Helvetica-Bold').fontSize(8);
  const headers = [
    ['Sl', 'No'],
    ['Lot', 'No'],
    ['Quantity', '(kgs)'],
    ['Rate/kg', '(Rs)'],
    ['Value', '(Rs)'],
    ['Discount', '(Rs)'],
    ['', ''],
    ['TaxableValue', '(Rs)'],
  ];
  for (let i = 0; i < headers.length; i++) {
    const [a, b] = headers[i];
    doc.text(a, COLS.xs[i] + 2, y + 3, { width: COLS.widths[i] - 4, align: 'center', lineBreak: false });
    doc.text(b, COLS.xs[i] + 2, y + 12, { width: COLS.widths[i] - 4, align: 'center', lineBreak: false });
  }
  y += headerH;

  // ── B/F line if this is a continuation page ──
  doc.font('Helvetica').fontSize(9);
  if (carryFromPrev) {
    box(doc, X0, y, W, ROW_H);
    colDividers(doc, y);
    cellText(doc, 'B / F', 0, y, { align: 'center' });
    // Lot column blank
    cellText(doc, fmtQty(carryFromPrev.qty), 2, y, { align: 'right' });
    // Rate blank
    cellText(doc, fmtIndian(carryFromPrev.value), 4, y, { align: 'right' });
    cellText(doc, fmtIndian(carryFromPrev.discount), 5, y, { align: 'right' });
    cellText(doc, fmtIndian(carryFromPrev.discount), 7, y, { align: 'right' });
    y += ROW_H;
  }

  // ── Lot rows ──
  // Pad with blank rows so the band is always the same visual size,
  // matching the reference (which has a fixed-height table area).
  const targetRows = ROWS_PER_PAGE - (carryFromPrev ? 1 : 0);
  for (let i = 0; i < targetRows; i++) {
    box(doc, X0, y, W, ROW_H);
    colDividers(doc, y);
    if (i < lots.length) {
      const lot = lots[i];
      cellText(doc, String(lot.serial), 0, y, { align: 'center' });
      cellText(doc, lot.lot_no || '', 1, y, { align: 'center' });
      cellText(doc, fmtQty(lot.qty), 2, y, { align: 'right' });
      cellText(doc, fmtIndianInt(lot.price), 3, y, { align: 'right' });
      cellText(doc, fmtIndian(lot.amount), 4, y, { align: 'right' });
      cellText(doc, fmtIndian(lot.discount), 5, y, { align: 'right' });
      cellText(doc, fmtIndian(lot.discount), 7, y, { align: 'right' });
    }
    y += ROW_H;
  }

  // ── Totals row (TOTAL on last page; C/D on continuation) ──
  box(doc, X0, y, W, ROW_H);
  colDividers(doc, y);
  doc.font('Helvetica-Bold').fontSize(9);
  if (isLastPage) {
    // Span Sl + Lot columns visually for "TOTAL"
    doc.text('TOTAL', COLS.xs[0] + 3, y + 3, {
      width: COLS.xs[2] - COLS.xs[0] - 6, align: 'center', lineBreak: false,
    });
    cellText(doc, fmtQty(totals.qty), 2, y, { align: 'right' });
    cellText(doc, fmtIndian(totals.value), 4, y, { align: 'right' });
    cellText(doc, fmtIndian(totals.discount), 5, y, { align: 'right' });
    cellText(doc, fmtIndian(totals.discount), 7, y, { align: 'right' });
  } else {
    doc.text('C / D', COLS.xs[0] + 3, y + 3, {
      width: COLS.xs[2] - COLS.xs[0] - 6, align: 'center', lineBreak: false,
    });
    cellText(doc, fmtQty(totals.qty), 2, y, { align: 'right' });
    cellText(doc, fmtIndian(totals.value), 4, y, { align: 'right' });
    cellText(doc, fmtIndian(totals.discount), 5, y, { align: 'right' });
    cellText(doc, fmtIndian(totals.discount), 7, y, { align: 'right' });
  }
  doc.font('Helvetica').fontSize(9);
  y += ROW_H;

  // ── Grand total row ──
  const gtH = ROW_H + 2;
  box(doc, X0, y, W, gtH);
  // Split: left half blank, right side label + amount
  const labelX = X0 + W * 0.45;
  doc.moveTo(labelX, y).lineTo(labelX, y + gtH).stroke();
  // amount cell divider (matching the reference's last-column box)
  const amtX = COLS.xs[7];
  doc.moveTo(amtX, y).lineTo(amtX, y + gtH).stroke();
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('GRAND TOTAL', labelX + 4, y + 4, {
    width: amtX - labelX - 8, align: 'center', lineBreak: false,
  });
  if (isLastPage) {
    doc.text(fmtIndian(totals.discount), amtX + 3, y + 4, {
      width: COLS.widths[7] - 6, align: 'right', lineBreak: false,
    });
  } else {
    doc.text(fmtIndian(0), amtX + 3, y + 4, {
      width: COLS.widths[7] - 6, align: 'right', lineBreak: false,
    });
  }
  doc.font('Helvetica').fontSize(9);
  y += gtH;

  // ── Footer band: amount in words + signature ──
  const footH = 90;
  box(doc, X0, y, W, footH);
  let fy = y + 8;
  if (isLastPage) {
    const words = `${amountToWords(totals.discount)} Only`;
    doc.font('Helvetica').fontSize(9).text(words, X0 + 8, fy, { width: W - 16 });
  } else {
    doc.font('Helvetica').fontSize(9).text('Rupees.....', X0 + 8, fy, { width: W - 16 });
  }
  fy += 30;
  doc.font('Helvetica-Bold').fontSize(9).text(`For ${buyer.name}`, X0 + W * 0.55, fy, {
    width: W * 0.45 - 8, align: 'right',
  });
  fy += 30;
  doc.font('Helvetica').fontSize(9).text('Authorised Signatory', X0 + W * 0.55, fy, {
    width: W * 0.45 - 8, align: 'right',
  });
  if (!isLastPage) {
    doc.font('Helvetica-Oblique').fontSize(8).text('[Continued.....]', X0 + 8, y + footH - 14);
    doc.font('Helvetica').fontSize(9);
  }
  y += footH;
  return y;
}

// ── Top-level entry point ─────────────────────────────────────────────────
//
// `buyers` is an array of:
//   {
//     name, address, gstin,
//     noteNo, date,
//     totalDiscount,
//     lots: [{ lot_no, qty, price, amount }],
//   }
// `cfg` has our-company details: companyName, place, gstin, pan, state, season, hsn.
// Returns Promise<Buffer> of the assembled PDF.
function generateDebitNoteBatchPDF(buyers, cfg) {
  if (!Array.isArray(buyers) || buyers.length === 0) {
    return Promise.reject(new Error('No debit notes to print'));
  }

  const ourCompany = cfg.tally_company_name || cfg.short_name || 'VANDANMEDU SPICES TRADING LLP';
  const ourCfg = {
    companyName: ourCompany,
    place:       cfg.place || cfg.kl_branch || '',
    gstin:       cfg.gstin || '',
    pan:         panFromGstin(cfg.gstin || ''),
    state:       cfg.state || '',
    stateCode:   getStateCode(cfg.state),
    season:      cfg.tally_season || cfg.season_code || '',
    hsn:         cfg.tally_hsn_cardamom || '09083120',
  };

  const doc = new PDFDocument({ size: 'A4', margin: M, autoFirstPage: false });
  const buffers = [];
  doc.on('data', b => buffers.push(b));

  for (const buyer of buyers) {
    // Compute per-lot discount split
    const lots = (buyer.lots || []).map((l, i) => ({ ...l, serial: i + 1 }));
    const splits = splitDiscount(lots, Number(buyer.totalDiscount || 0));
    for (let i = 0; i < lots.length; i++) lots[i].discount = splits[i];

    // Paginate
    const pages = [];
    let cursor = 0;
    let runningTotals = { qty: 0, value: 0, discount: 0 };
    while (cursor < lots.length) {
      const isFirst = pages.length === 0;
      // First page can fit ROWS_PER_PAGE rows; continuation pages have a B/F
      // row at the top, so they can fit (ROWS_PER_PAGE - 1) lot rows.
      const slotsThisPage = isFirst ? ROWS_PER_PAGE : (ROWS_PER_PAGE - 1);
      const pageLots = lots.slice(cursor, cursor + slotsThisPage);
      cursor += slotsThisPage;
      // Update running totals (running totals include this page)
      const pageQty = pageLots.reduce((s, l) => s + Number(l.qty || 0), 0);
      const pageVal = pageLots.reduce((s, l) => s + Number(l.amount || 0), 0);
      const pageDisc = pageLots.reduce((s, l) => s + Number(l.discount || 0), 0);
      const carryFromPrev = isFirst ? null : { ...runningTotals };
      runningTotals = {
        qty: runningTotals.qty + pageQty,
        value: runningTotals.value + pageVal,
        discount: runningTotals.discount + pageDisc,
      };
      pages.push({
        lots: pageLots,
        carryFromPrev,
        totals: { ...runningTotals },
        isLastPage: cursor >= lots.length,
      });
    }
    // Tag with pageNum/totalPages
    for (let i = 0; i < pages.length; i++) {
      pages[i].pageNum = i + 1;
      pages[i].totalPages = pages.length;
    }

    // Per-buyer ourCfg overlay (date, note number)
    const buyerOurCfg = {
      ...ourCfg,
      date:   fmtDate(buyer.date),
      noteNo: buyer.noteNo || '',
    };

    for (const pi of pages) {
      doc.addPage({ size: 'A4', margin: M });
      renderBuyerPage(doc, buyer, buyerOurCfg, pi);
    }
  }

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { generateDebitNoteBatchPDF, splitDiscount, panFromGstin, getStateCode };
