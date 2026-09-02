/**
 * exports.js — All export formats
 * Replaces: EXP.PRG (11 types), TALY.PRG, KOTALLY.PRG, BANKPAY export
 */

const ExcelJS = require('exceljs');
const { collectionXlsx: newCollectionXlsx, tradeReportXlsx } = require('./auction-reports');
// Planter-vs-dealer discrimination for the Commission Bill CSV. Imported
// rather than reimplemented so this file agrees with the calculator about
// which sellers carry a real GSTIN. calculations.js does not require this
// module, so the dependency stays one-way.
const { gstinStateCode } = require('./calculations');
const {
  getCompanyHeader,
  writeXlsxCompanyHeader, xlsxNumFmtForHeader,
  formatDateForDisplay, fmtIndian,
  autofitColumns,
  formatDebitNoteNo, debitNoteSeason,
} = require('./report-formatters');

// Escape one CSV field: wrap in quotes if it contains comma/quote/newline,
// and double-up any embedded quotes. Undefined/null → empty. Shared by every
// export here that writes CSV text directly rather than converting a workbook.
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
// Defensive identity resolver — see _company-identity-fallback.js.
// Avoids "getCompanyIdentity is not a function" on partial deploys.
const getCompanyIdentity = require('./_company-identity-fallback').resolve();

// Build an XLSX buffer with a unified brand band on top and Indian-format
// numeric columns. `opts.title` is the report title shown in the middle of
// the band; `opts.metaLines` is an array of right-aligned meta strings
// (e.g. ["Trade #3", "15/04/2026", "ASP"]).
// Reusable XLSX export builder. ALL Excel exports in this app should
// route through this function so they share:
//   - The same three-zone brand band (logo + name | title | meta)
//   - The same column-header look (#E8E4DD fill, thin top/bottom borders,
//     bold 10pt, centered text)
//   - The same Indian-format numFmts via xlsxNumFmtForHeader
//   - The same per-column alignment defaults (right for numeric, center
//     for short-id columns like SL/LOT, left for everything else)
//
// columns[i] shape:
//   { key, header,
//     width:   number,         // optional, default 15
//     align:   'left'|'center'|'right',  // optional, derived from numFmt
//     numFmt:  string,         // optional, overrides xlsxNumFmtForHeader
//   }
//
// opts shape:
//   { db, companyHeader, title, metaLines,    // existing
//     bannerRow: [{ text, span, align }],      // optional row above the headers
//     grandTotal: { label, values, fillArgb }, // optional footer row
//     sections:   [{ title, rows }],           // optional grouped layout
//     spacerBetween: true,                      // blank row between groups
//   }
//
// "Grand total" row mirrors the Lorry export's footer: bold 11pt, yellow
// (`#FFF3CD`) fill, double top + bottom borders. Pass `values` keyed by
// column key — only the listed columns get numbers, the rest are blank.
// Set `label` to put a string in any one column (defaults to 'GRAND TOTAL'
// in the first non-numeric column).
// ── XLSX column autofit ──────────────────────────────────────────────────
// Size every column to its widest CONTENT instead of a hand-guessed constant,
// so nothing is truncated and no money cell renders as "####".
//
// Width is measured on the string Excel will SHOW, not the stored value: the
// numeric columns carry an Indian-grouping numFmt, so 1399354 occupies
// "13,99,354.00" — 12 characters, not 7. Decimals come from the same
// xlsxNumFmtForHeader() the writer uses to set the cell format, so the two can
// never disagree about how wide a value renders.
//
// Per column: `minWidth` (default 6) keeps short columns clickable, `maxWidth`
// (default 40) stops one long trade name from blowing the sheet out sideways.
// Mutates and returns `columns`.
function autofitXlsxColumns(columns, rows, opts = {}) {
  const pad = opts.pad == null ? 2 : opts.pad;
  const shown = (row, col) => {
    const v = row[col.key];
    if (v == null || v === '') return '';
    if (typeof v !== 'number' && !(typeof v === 'string' && v !== '' && isFinite(Number(v)))) {
      return String(v);
    }
    const fmt = col.numFmt || xlsxNumFmtForHeader(col.header) || '';
    // Decimal count straight off the numFmt pattern ("#,##0.000" → 3).
    const dot = fmt.indexOf('.');
    const decimals = dot === -1 ? (fmt ? 0 : null) : (fmt.slice(dot + 1).match(/0+/) || [''])[0].length;
    return decimals == null ? String(v) : fmtIndian(Number(v), decimals);
  };
  for (const c of columns) {
    let widest = String(c.header || '').length;
    for (const r of rows) widest = Math.max(widest, shown(r, c).length);
    c.width = Math.min(c.maxWidth || opts.maxWidth || 40,
                       Math.max(c.minWidth || opts.minWidth || 6, widest + pad));
  }
  return columns;
}

async function createExcelBuffer(sheetName, columns, rows, opts) {
  opts = opts || {};
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  // Apply column widths up front (the brand band uses these widths too).
  // These are only a seed — autofitColumns() at the end of this function
  // sizes every column to what was actually written.
  ws.columns = columns.map(c => ({ key: c.key, width: c.width || 15 }));

  // Resolve per-column numFmt + alignment ONCE so we can apply them to
  // data rows and the grand-total row uniformly.
  //
  // Default alignment policy:
  //   - explicit `align` wins
  //   - numeric columns (have a numFmt) → right
  //   - everything else → left
  const colMeta = columns.map(c => {
    const fmt = c.numFmt || xlsxNumFmtForHeader(c.header);
    const align = c.align || (fmt ? 'right' : 'left');
    return { fmt, align };
  });

  // Apply column-level numFmt + alignment FIRST, so any cells we write
  // afterwards (brand band, header row, data rows) can override it via
  // explicit per-cell alignment without being clobbered by a later
  // column.alignment cascade.
  colMeta.forEach((m, i) => {
    const colObj = ws.getColumn(i + 1);
    if (m.fmt) colObj.numFmt = m.fmt;
    colObj.alignment = { horizontal: m.align, vertical: 'middle' };
  });

  // Brand band: company name (row 1) + meta (row 2) + spacer (row 3), with
  // the column headers landing on row 4.
  //
  // `skipCompanyHeader` drops the band entirely so the column headers ARE
  // row 1. Machine-read files want that: a bank's upload form reads the first
  // row as its header, and a merged, logo-bearing title row above it either
  // breaks the parse or has to be deleted by hand every time.
  const header = opts.companyHeader || getCompanyHeader(opts.db);
  const startRow = opts.skipCompanyHeader ? 1 : writeXlsxCompanyHeader(wb, ws, header, {
    colCount: columns.length,
    metaLines: opts.metaLines || [],
  });

  // ── Banner row (optional) ──
  // A single bordered row placed directly ABOVE the column headers, laid out
  // as merged spans across the sheet width. Used by sheets that carry their
  // own letterhead line rather than the brand band — e.g. the HDFC payment
  // authorization sheet's "HDFC BANK | A/C: … | Dt: …".
  //
  //   opts.bannerRow: [{ text, span?, align? }]
  //
  // Spans are clamped to the column count, so a profile can never merge past
  // the edge of the table and corrupt the sheet.
  let headerRowNum = startRow;
  if (Array.isArray(opts.bannerRow) && opts.bannerRow.length) {
    const bRow = ws.getRow(headerRowNum);
    let ci = 1;
    for (const seg of opts.bannerRow) {
      if (ci > columns.length) break;
      const span = Math.max(1, Math.min(Number(seg.span) || 1, columns.length - ci + 1));
      const cell = bRow.getCell(ci);
      cell.value = seg.text == null ? '' : seg.text;
      if (span > 1) {
        ws.mergeCells(`${colLetter(ci)}${bRow.number}:${colLetter(ci + span - 1)}${bRow.number}`);
      }
      cell.alignment = { horizontal: seg.align || 'left', vertical: 'middle' };
      ci += span;
    }
    bRow.font = { bold: true, size: 12 };
    bRow.height = 24;
    const thinAll = { style: 'thin' };
    for (let c = 1; c <= columns.length; c++) {
      bRow.getCell(c).border = { top: thinAll, bottom: thinAll, left: thinAll, right: thinAll };
    }
    headerRowNum += 1;
  }

  // Column-header row — explicit per-cell alignment 'center' overrides
  // the column-level left/right cascade.
  const headerRow = ws.getRow(headerRowNum);
  columns.forEach((c, i) => {
    headerRow.getCell(i + 1).value = c.header;
  });
  headerRow.font = { bold: true, size: 10 };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E4DD' } };
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    // wrapText OFF: the autofit above guarantees the column is at least as
    // wide as this header, so a two-word label like "BILL AMOUNT" sits on one
    // line instead of stacking and leaving a double-height header band.
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
  });

  // Helper to emit a single data row honouring numeric coercion + per-col align
  function emitDataRow(rowObj) {
    const dataRow = ws.addRow({});
    columns.forEach((c, i) => {
      let v = rowObj[c.key];
      // Coerce string-numbers to numbers so Excel applies the numFmt.
      if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) {
        const n = Number(v);
        if (!Number.isNaN(n) && colMeta[i].fmt) v = n;
      }
      const cell = dataRow.getCell(i + 1);
      cell.value = v == null ? '' : v;
      // Per-cell alignment guard — vertical:'middle' centers text vertically
      // so rows align consistently regardless of font size differences.
      cell.alignment = { horizontal: colMeta[i].align, vertical: 'middle' };
    });
    // A row flagged `_isSubtotal` closes a group (e.g. one dealer's per-branch
    // rows in the Dealer List). Bold + a light band so it reads as a summary
    // without competing with the yellow grand-total footer below.
    if (rowObj && rowObj._isSubtotal) {
      dataRow.font = { bold: true, size: 10 };
      dataRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        cell.border = { top: { style: 'thin' } };
      });
    }
    return dataRow;
  }

  // ── Section-grouped mode (optional) ──
  // When `opts.sections` is provided, we ignore `rows` and emit each
  // section as: section header (merged, light-green) → its rows. This
  // mirrors the Lorry export's "INTER-STATE SALES" / "INTRA-STATE SALES"
  // structure but is reusable for any grouped data.
  if (Array.isArray(opts.sections) && opts.sections.length) {
    opts.sections.forEach((sec, sIdx) => {
      const titleRow = ws.addRow([sec.title || '']);
      ws.mergeCells(`A${titleRow.number}:${colLetter(columns.length)}${titleRow.number}`);
      titleRow.font = { bold: true, size: 10 };
      titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
      titleRow.alignment = { horizontal: 'left', vertical: 'middle' };
      (sec.rows || []).forEach(emitDataRow);
      if (opts.spacerBetween && sIdx < opts.sections.length - 1) ws.addRow([]);
    });
  } else {
    // Flat mode — original behaviour.
    rows.forEach(emitDataRow);
  }

  // ── Grand total footer (optional) ──
  // Lorry-export style: bold 11pt, yellow `#FFF3CD` fill, double borders.
  // Pass values keyed by column key. Numeric columns get the same numFmt
  // as the data rows for consistent rendering.
  if (opts.grandTotal) {
    const gt = opts.grandTotal;
    const cells = columns.map(c => (gt.values && gt.values[c.key] != null) ? gt.values[c.key] : '');
    // Place label in the first non-numeric column (or column 1 if all
    // columns are numeric). Caller can override by including a label
    // value directly in `gt.values`.
    if (gt.label) {
      const labelIdx = columns.findIndex(c => !colMeta[columns.indexOf(c)].fmt);
      const idx = labelIdx >= 0 ? labelIdx : 0;
      if (cells[idx] === '') cells[idx] = gt.label;
    }
    const gRow = ws.addRow(cells);
    gRow.font = { bold: true, size: 11 };
    gRow.height = 22;
    const fill = gt.fillArgb || 'FFFFF3CD';
    gRow.eachCell((cell, ci) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
      const col = columns[ci - 1];
      const m = colMeta[ci - 1];
      // Per-column total-row format override (`gt.numFmts[key]`) — lets the
      // TOTAL carry a different number format from its data cells (e.g. keep
      // thousands commas on the total while the column itself shows none).
      const ovr = col && gt.numFmts && gt.numFmts[col.key];
      if (ovr)          cell.numFmt = ovr;
      else if (m && m.fmt) cell.numFmt = m.fmt;
      cell.alignment = { horizontal: (m && m.align) || 'left', vertical: 'middle' };
    });
  }

  // ── Separate summary container (optional) ──
  // Renders a self-contained mini-ledger (Particulars | Qty | Amount) in
  // MERGED cells below the main table, so its own values — including the
  // smaller ones like gunny sales — stay legible in their own container
  // instead of being stretched thin across the wide invoice columns. Title
  // and every field are merged cells with a full thin-border grid.
  if (opts.summaryBlock && Array.isArray(opts.summaryBlock.lines) && opts.summaryBlock.lines.length) {
    const sb = opts.summaryBlock;
    const nCols = columns.length;
    const labelEnd = Math.max(1, Math.round(nCols * 0.45));
    const qtyEnd = Math.min(nCols - 1, Math.max(labelEnd + 1, Math.round(nCols * 0.66)));
    const valStart = qtyEnd + 1;
    const L = (nn) => colLetter(nn);
    const thin = { style: 'thin' };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const borderRange = (rowNum, c1, c2) => { for (let c = c1; c <= c2; c++) ws.getRow(rowNum).getCell(c).border = box; };
    const AMT_FMT = '#,##0.00', QTY_FMT = '#,##0.000';

    ws.addRow([]); // spacer separates the container from the table above

    // Title — one merged cell across every column.
    const tRow = ws.addRow([]);
    ws.mergeCells(`A${tRow.number}:${L(nCols)}${tRow.number}`);
    tRow.getCell(1).value = sb.title || 'Summary';
    tRow.font = { bold: true, size: 11 };
    tRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    tRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E4DD' } };
    borderRange(tRow.number, 1, nCols);
    tRow.height = 20;

    const heads = sb.headers || ['Particulars', 'Qty', 'Amount'];
    // Column-header row (three merged spans).
    const hRow = ws.addRow([]);
    ws.mergeCells(`A${hRow.number}:${L(labelEnd)}${hRow.number}`);
    ws.mergeCells(`${L(labelEnd + 1)}${hRow.number}:${L(qtyEnd)}${hRow.number}`);
    ws.mergeCells(`${L(valStart)}${hRow.number}:${L(nCols)}${hRow.number}`);
    hRow.getCell(1).value = heads[0];
    hRow.getCell(labelEnd + 1).value = heads[1];
    hRow.getCell(valStart).value = heads[2];
    hRow.font = { bold: true, size: 10 };
    [1, labelEnd + 1, valStart].forEach(ci => { hRow.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0EBE2' } }; });
    hRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    hRow.getCell(labelEnd + 1).alignment = { horizontal: 'right', vertical: 'middle' };
    hRow.getCell(valStart).alignment = { horizontal: 'right', vertical: 'middle' };
    borderRange(hRow.number, 1, nCols);
    hRow.height = 18;

    // Line rows.
    sb.lines.forEach(ln => {
      const r = ws.addRow([]);
      ws.mergeCells(`A${r.number}:${L(labelEnd)}${r.number}`);
      ws.mergeCells(`${L(labelEnd + 1)}${r.number}:${L(qtyEnd)}${r.number}`);
      ws.mergeCells(`${L(valStart)}${r.number}:${L(nCols)}${r.number}`);
      r.getCell(1).value = ln.label || '';
      r.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      if (ln.qty !== '' && ln.qty != null && !isNaN(Number(ln.qty))) {
        r.getCell(labelEnd + 1).value = Number(ln.qty);
        r.getCell(labelEnd + 1).numFmt = QTY_FMT;
      }
      r.getCell(labelEnd + 1).alignment = { horizontal: 'right', vertical: 'middle' };
      r.getCell(valStart).value = (ln.value == null || ln.value === '') ? '' : Number(ln.value);
      r.getCell(valStart).numFmt = AMT_FMT;
      r.getCell(valStart).alignment = { horizontal: 'right', vertical: 'middle' };
      borderRange(r.number, 1, nCols);
    });

    // Total row (highlighted).
    if (sb.total) {
      const r = ws.addRow([]);
      ws.mergeCells(`A${r.number}:${L(qtyEnd)}${r.number}`);
      ws.mergeCells(`${L(valStart)}${r.number}:${L(nCols)}${r.number}`);
      r.getCell(1).value = sb.total.label || 'TOTAL';
      r.getCell(valStart).value = (sb.total.value == null || sb.total.value === '') ? '' : Number(sb.total.value);
      r.getCell(valStart).numFmt = AMT_FMT;
      r.font = { bold: true, size: 11 };
      const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sb.fillArgb || 'FFD1E7DD' } };
      r.getCell(1).fill = fill; r.getCell(valStart).fill = fill;
      r.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      r.getCell(valStart).alignment = { horizontal: 'right', vertical: 'middle' };
      borderRange(r.number, 1, nCols);
      r.height = 20;
    }
  }

  // ── Signature / sign-off footer (optional) ──
  // A blank spacer then a bold row placing each label spread evenly across the
  // sheet width (e.g. "Prepared By" | "Checked By" | "Approved By"). Used by
  // bank-payment authorization sheets that carry a manual sign-off block.
  if (Array.isArray(opts.signatures) && opts.signatures.length) {
    ws.addRow([]);
    const n = opts.signatures.length;
    const cells = new Array(columns.length).fill('');
    opts.signatures.forEach((label, i) => {
      const col = Math.min(columns.length - 1, Math.round((i * columns.length) / n));
      cells[col] = label;
    });
    const sigRow = ws.addRow(cells);
    sigRow.font = { bold: true, size: 10 };
    sigRow.height = 22;
    sigRow.eachCell((cell) => {
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
    });
  }

  // Size every column to what was actually written. Runs LAST so it sees
  // the header band, the data, the totals and the signature row. Declared
  // `width`s stay as the seed above but no longer decide the outcome —
  // they were guesses made before anyone knew how long a seller's name
  // would be. Opt out per report with { autofit: false }.
  if (opts.autofit !== false) {
    try { autofitColumns(ws, opts.autofitOpts); } catch (_) {}
  }

  return wb.xlsx.writeBuffer();
}

// Local helper — A1 column letter. Mirrors the one in writeXlsxCompanyHeader
// but kept private here so we don't widen that module's exports.
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Build the common XLSX header meta lines for a given auction. Returns
// an array like ["e-TRADE No: 3", "Date: 15/04/2026"]. The crop type
// (ISP/ASP) is omitted — the active preset is already shown via the logo
// and company name in the brand block.
function auctionMeta(db, auctionId) {
  if (!auctionId) return [];
  try {
    const a = db.get(
      'SELECT ano, date, crop_type FROM auctions WHERE id = ?', [auctionId]
    );
    if (!a) return [];
    // Format the meta date using the operator's `date_format` Setting
    // so every XLSX export's brand band stays consistent with the rest
    // of the app (list views, PDFs).
    let dateFmt = 'dd/mm/yyyy';
    try { dateFmt = require('./company-config').getSettingsFlat(db).date_format || 'dd/mm/yyyy'; }
    catch (_) { /* settings unavailable — fall back to default */ }
    const dt = formatDateForDisplay(a.date, dateFmt);
    const meta = [];
    if (a.ano) meta.push(`e-AUCTION No: ${a.ano}`);
    if (dt) meta.push(`Date: ${dt}`);
    return meta;
  } catch (_) { return []; }
}

// ── Export Type 1: Lot Slip (before trade) ───────────────────
async function exportLotSlip(db, auctionId, state) {
  const rows = db.all(
    `SELECT state, lot_no as lot, name, grade, bags as bag, qty, litre
     FROM lots WHERE auction_id = ? ${state ? 'AND state = ?' : ''}
     ORDER BY lot_no`, state ? [auctionId, state] : [auctionId]
  );
  const cols = [
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'LOT', key: 'lot', width: 8 },
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'GRADE', key: 'grade', width: 8 },
    { header: 'BAG', key: 'bag', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'LITRE', key: 'litre', width: 10 },
  ];
  return createExcelBuffer('LotSlip', cols, rows, {
    db, title: 'Lot Slip', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export Type 2: Lot Slip After Trade (with price/buyer) ───
async function exportLotSlipAfter(db, auctionId, state) {
  const rows = db.all(
    `SELECT state, lot_no as lot, name, bags as bag, qty, price, amount, code
     FROM lots WHERE auction_id = ? ${state ? 'AND state = ?' : ''}
     ORDER BY lot_no`, state ? [auctionId, state] : [auctionId]
  );
  const cols = [
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'LOT', key: 'lot', width: 8 },
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'BAG', key: 'bag', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'PRICE', key: 'price', width: 10 },
    { header: 'AMOUNT', key: 'amount', width: 14 },
    { header: 'CODE', key: 'code', width: 8 },
  ];
  return createExcelBuffer('LotSlipAfter', cols, rows, {
    db, title: 'Lot Slip (After Trade)', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Lot Buyer: per-lot buyer name + place (KL/TN) ─────────────
// LOT | BUYER (trade name) | PLACE (KL/TN) | BAG | QTY
// Includes lots whether or not a buyer is assigned — empty cells
// stay blank so the operator can spot un-coded lots at a glance.
async function exportLotBuyer(db, auctionId) {
  const rows = db.all(
    `SELECT lot_no AS lot,
            COALESCE(NULLIF(buyer1,''), buyer) AS buyer,
            sale AS place,
            bags AS bag, qty
       FROM lots WHERE auction_id = ? ORDER BY lot_no`, [auctionId]
  );
  const cols = [
    { header: 'LOT',   key: 'lot',   width: 8  },
    { header: 'BUYER', key: 'buyer', width: 28 },
    { header: 'PLACE', key: 'place', width: 8  },
    { header: 'BAG',   key: 'bag',   width: 6  },
    { header: 'QTY',   key: 'qty',   width: 12 },
  ];
  return createExcelBuffer('LotBuyer', cols, rows, {
    db, title: 'Lot Buyer', metaLines: auctionMeta(db, auctionId),
    grandTotal: {
      label: 'TOTAL',
      values: {
        bag: rows.reduce((s, r) => s + (Number(r.bag) || 0), 0),
        qty: rows.reduce((s, r) => s + (Number(r.qty) || 0), 0),
      },
    },
  });
}

// ── Checklist: post-auction lot/buyer/sale verification sheet ─
// LOT | DUMMY | BUYER | BAGS | QTY | SALE — the sheet the desk reads down after
// the trade to confirm each lot went to the right buyer under the right sale
// type.
//
// DUMMY is lots.dummy_code, the free-text tag the operator types per lot in
// Price Entry. It sits next to LOT because that is the pair the desk checks
// against its own pricing notes; blank for lots that were never tagged.
//
// BUYER is the short buyer CODE (TS, AG, MM…), not the trade name: the whole
// point is a narrow sheet you can scan a column of, and the full name already
// has its own report (Lot Buyer).
//
// SALE is lots.sale — 'L' local / 'I' inter-state (derived from the buyer's
// GSTIN state vs the company state; see calculations.js). A withdrawn lot
// stores 'W' but prints as 'WD', matching the WD that already stands in its
// buyer column so the row reads consistently.
//
// Every lot is listed, withdrawn ones included — a checklist that silently
// dropped rows would defeat its purpose.
//
// DUMMY and BUYER are each optional per install (Settings → Feature Flags →
// "Checklist: Dummy column" / "Checklist: Buyer column"). Some desks read the
// sheet against their own pricing notes and need the tag; others only want to
// see who took the lot. See checklistColumns below — the PDF renderer applies
// the SAME rule, so the two formats can't drift apart.
const CHECKLIST_COLS = [
  { header: 'LOT',   key: 'lot',   width: 8  },
  { header: 'DUMMY', key: 'dummy', width: 12 },
  { header: 'BUYER', key: 'buyer', width: 12 },
  { header: 'BAGS',  key: 'bag',   width: 7  },
  { header: 'QTY',   key: 'qty',   width: 12, numFmt: '#,##0.000', align: 'right' },
  { header: 'SALE',  key: 'sale',  width: 8  },
];

// Which of the two optional Checklist columns this install prints.
//
// A MISSING key means the column SHOWS: the sheet has always carried both, so
// an install that upgrades before anyone visits Settings keeps printing the
// Checklist it printed yesterday. Only an explicit 'false' hides one.
function checklistColumnsOn(cfg) {
  const on = (k) => {
    const v = String((cfg && cfg[k]) != null ? cfg[k] : '').trim().toLowerCase();
    return v === '' ? true : (v === 'true' || v === '1');
  };
  return { dummy: on('checklist_show_dummy'), buyer: on('checklist_show_buyer') };
}

// Narrow a Checklist column spec to the columns this install prints. Takes the
// spec rather than owning one, because the two renderers legitimately differ:
// the XLSX carries numFmt/align on QTY, the PDF sizes its own widths. Sharing
// the RULE (not the spec) is what keeps the formats in step without flattening
// one onto the other.
//
// LOT / BAGS / QTY / SALE are never optional — the lot and its figures are what
// the sheet is for. Returns a fresh array; the source spec is never mutated.
function checklistVisibleCols(cols, cfg) {
  const show = checklistColumnsOn(cfg);
  return (cols || []).filter(c =>
    (c.key !== 'dummy' || show.dummy) && (c.key !== 'buyer' || show.buyer));
}

async function exportChecklist(db, auctionId, cfg) {
  const rows = db.all(
    `SELECT lot_no AS lot,
            COALESCE(dummy_code,'') AS dummy,
            code AS buyer,
            bags AS bag,
            qty,
            CASE WHEN UPPER(TRIM(COALESCE(sale,''))) = 'W' THEN 'WD'
                 ELSE UPPER(TRIM(COALESCE(sale,''))) END AS sale
       FROM lots WHERE auction_id = ? ORDER BY lot_no`, [auctionId]
  );
  const cols = checklistVisibleCols(CHECKLIST_COLS, cfg);
  return createExcelBuffer('Checklist', cols, rows, {
    db, title: 'Checklist', metaLines: auctionMeta(db, auctionId),
    grandTotal: {
      label: 'TOTAL',
      values: {
        bag: rows.reduce((s, r) => s + (Number(r.bag) || 0), 0),
        qty: rows.reduce((s, r) => s + (Number(r.qty) || 0), 0),
      },
    },
  });
}

// ── THARAI LIST ──────────────────────────────────────────────────────
// Buyer-wise bag and kilo totals for one trade, split by SALE TYPE: the
// INTER-state buyers on one side, the LOCAL ones on the other. It is the
// sheet the office reads to see who took how much, and it gets checked
// against the Checklist's grand total — which is exactly why withdrawn
// lots are carried as their own line rather than dropped:
//
//     INTER bags + LOCAL bags + WD bags  ==  the trade's bag count
//
// SALE is lots.sale, the same 'L' / 'I' / 'W' the Checklist prints (see
// exportChecklist above). Any OTHER value — a lot with no sale type set
// yet — lands in its own bucket and is reported, so bags can never
// silently vanish between this sheet and the Checklist. The reference
// trade had none; a mid-auction one will.
//
// The buyer is lots.code verbatim, deliberately NOT buyerCodeResolver's
// master lookup (defined just below). The office's own sheet lists NS and
// NS-1 as separate buyers, and the resolver would fold one into the other
// wherever the master disagrees with what price entry stamped on the lot.
//
// Order: bags DESCENDING, then code A→Z to break ties. That is the order
// the reference sheet is in, and it puts the biggest taker at the top of
// each side, which is where the eye starts.
function tharaiListData(db, auctionId) {
  const rows = db.all(
    `SELECT UPPER(TRIM(COALESCE(code,''))) AS code,
            UPPER(TRIM(COALESCE(sale,''))) AS sale,
            COALESCE(bags,0)               AS bags,
            COALESCE(qty,0)                AS qty
       FROM lots WHERE auction_id = ?`, [auctionId]
  );
  const sides = { I: new Map(), L: new Map() };
  const tally = { I: { bags: 0, qty: 0 }, L: { bags: 0, qty: 0 },
                  W: { bags: 0, qty: 0 }, other: { bags: 0, qty: 0 } };
  for (const r of rows) {
    const bags = Number(r.bags) || 0, qty = Number(r.qty) || 0;
    const bucket = (r.sale === 'I' || r.sale === 'L') ? r.sale
                 : (r.sale === 'W' ? 'W' : 'other');
    tally[bucket].bags += bags;
    tally[bucket].qty  += qty;
    if (bucket !== 'I' && bucket !== 'L') continue;
    const key = r.code || '—';
    const g = sides[bucket].get(key) || { code: key, bags: 0, qty: 0 };
    g.bags += bags; g.qty += qty;
    sides[bucket].set(key, g);
  }
  const order = (m) => [...m.values()].sort(
    (a, b) => (b.bags - a.bags) || String(a.code).localeCompare(String(b.code)));
  const t = tally;
  return {
    inter: order(sides.I), local: order(sides.L), tally,
    totalBags: t.I.bags + t.L.bags + t.W.bags + t.other.bags,
    totalQty:  t.I.qty  + t.L.qty  + t.W.qty  + t.other.qty,
  };
}

// The two sides sit SIDE BY SIDE, as they do on the office's sheet, rather
// than stacked: the whole point of the layout is that one trade's buyers
// fit on a single page you can take in at a glance. Column keys are
// prefixed i_ / l_ so one flat row object can carry both sides.
async function exportTharaiList(db, auctionId) {
  const d = tharaiListData(db, auctionId);
  const n = Math.max(d.inter.length, d.local.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = d.inter[i], b = d.local[i];
    rows.push({
      i_buyer: a ? a.code : '', i_qty: a ? a.qty : null, i_bags: a ? a.bags : null,
      l_buyer: b ? b.code : '', l_qty: b ? b.qty : null, l_bags: b ? b.bags : null,
    });
  }
  const cols = [
    { header: 'INTER BUYER', key: 'i_buyer', width: 14 },
    { header: 'QTY',         key: 'i_qty',   width: 13, numFmt: '#,##0.000', align: 'right' },
    { header: 'BAGS',        key: 'i_bags',  width: 8,  numFmt: '#,##0',     align: 'right' },
    { header: '',            key: '_gap',    width: 3 },
    { header: 'LOCAL BUYER', key: 'l_buyer', width: 14 },
    { header: 'QTY',         key: 'l_qty',   width: 13, numFmt: '#,##0.000', align: 'right' },
    { header: 'BAGS',        key: 'l_bags',  width: 8,  numFmt: '#,##0',     align: 'right' },
  ];
  // The bag reconciliation rides in the brand band rather than as extra
  // rows under the table: it is the figure the sheet is checked by, and it
  // stays visible without scrolling to the bottom of a 40-row sheet.
  const meta = auctionMeta(db, auctionId);
  meta.push(`INTER ${d.tally.I.bags} · LOCAL ${d.tally.L.bags} · WD ${d.tally.W.bags}`
          + (d.tally.other.bags ? ` · UNCLASSIFIED ${d.tally.other.bags}` : '')
          + ` · TOTAL ${d.totalBags} bags`);
  return createExcelBuffer('Tharai List', cols, rows, {
    db, title: 'Tharai List', metaLines: meta,
    grandTotal: {
      label: 'TOTAL',
      values: { i_qty: d.tally.I.qty, i_bags: d.tally.I.bags,
                l_qty: d.tally.L.qty, l_bags: d.tally.L.bags },
    },
  });
}

// Resolve a lot's short buyer CODE from the BUYERS MASTER rather than from
// lots.code: the lot carries a copy stamped at price-entry time, and if the
// buyer's code was corrected in the master afterwards the two disagree. A code
// match against the master wins, a trade-name match is the fallback, and
// lots.code stands only when neither matches — a buyer who was never added to
// the master, and the non-sale markers ('WD' withdrawn, 'NA' not auctioned)
// that have no master row by design.
//
// Built in JS rather than as a SQL join: matching a lot on "code OR name"
// inside a JOIN fans the row out once per duplicate buyer record, and
// duplicates in the master are common. Two maps, first-write-wins over an
// id-ordered scan, give the lowest-id row per key — the same tie-break the
// Spice Board reports use.
//
// Returns a `(lot) => code` closure; the caller pays for the master scan once.
// Shared by both verification sheets so they can never disagree about which
// code a lot belongs under.
function buyerCodeResolver(db) {
  const byCode = new Map(), byName = new Map();
  for (const b of db.all(`SELECT code, buyer FROM buyers ORDER BY id`)) {
    const code = String(b.code || '').trim();
    if (!code) continue;
    const ck = code.toUpperCase();
    if (!byCode.has(ck)) byCode.set(ck, code);
    const nk = String(b.buyer || '').trim().toUpperCase();
    if (nk && !byName.has(nk)) byName.set(nk, code);
  }
  return (l) => {
    const c = String(l.code || '').trim();
    if (c && byCode.has(c.toUpperCase())) return byCode.get(c.toUpperCase());
    const n = String(l.buyer || '').trim().toUpperCase();
    if (n && byName.has(n)) return byName.get(n);
    return c;   // unknown to the master — show what the lot carries
  };
}

// ── Lot Verification: two-up LOT | BAG | QTY | BUYER sheet ───
// The hall's read-down verification sheet, in the customer-supplied layout:
// the four columns LOT | BAG | QTY | BUYER repeated TWICE across the page,
// so a trade of 200 lots prints on half the paper it otherwise would.
//
// Fill order is column-major ("down then across"): the first half of the
// lots runs down the LEFT block, the second half down the RIGHT one. That
// keeps each block in unbroken lot order, which is the whole point — you
// read one column top to bottom against the tags in your hand. Row-major
// would interleave (1,2 / 3,4) and force you to zig-zag.
//
// With an odd lot count the left block carries the extra row and the right
// block's last row is blank — never a half-populated row.
//
// BUYER is the short buyer CODE, resolved from the BUYERS MASTER — see
// buyerCodeResolver above for why the lot's own copy is not trusted.
//
// Every lot is listed in lot-number order, withdrawn and unsold included —
// a verification sheet that silently dropped rows would defeat its purpose.
// Rows + the two block totals, built ONCE and shared with the PDF twin in
// exports-pdf.js — the two renderings must never deal the lots differently or
// resolve a buyer code by a different rule.
function lotVerificationData(db, auctionId) {
  const lots = db.all(
    `SELECT lot_no AS lot, bags AS bag, qty,
            COALESCE(code,'')  AS code,
            COALESCE(buyer,'') AS buyer
       FROM lots WHERE auction_id = ?
      ORDER BY CAST(lot_no AS INTEGER), lot_no`, [auctionId]
  );

  const buyerCode = buyerCodeResolver(db);

  // Deal the lots into two blocks, then pair them off row by row.
  const split = Math.ceil(lots.length / 2);
  const left = lots.slice(0, split), right = lots.slice(split);
  const rows = left.map((l, i) => {
    const r = right[i];
    return {
      lot:  l.lot, bag:  l.bag, qty:  l.qty, buyer:  buyerCode(l),
      lot2: r ? r.lot   : '', bag2: r ? r.bag : '',
      qty2: r ? r.qty   : '', buyer2: r ? buyerCode(r) : '',
    };
  });
  return { rows, left, right };
}

const LOT_VERIF_COLS = [
  { header: 'LOT',   key: 'lot',    width: 8  },
  { header: 'BAG',   key: 'bag',    width: 7  },
  { header: 'QTY',   key: 'qty',    width: 12 },
  { header: 'BUYER', key: 'buyer',  width: 12 },
  { header: 'LOT',   key: 'lot2',   width: 8  },
  { header: 'BAG',   key: 'bag2',   width: 7  },
  { header: 'QTY',   key: 'qty2',   width: 12 },
  { header: 'BUYER', key: 'buyer2', width: 12 },
];
// Each block totals ITSELF, so the keys name both halves. Summing the paired
// rows gives the same answer as summing each block on its own — every row
// holds exactly one left lot and at most one right lot.
const LOT_VERIF_TOTAL_KEYS = ['bag', 'qty', 'bag2', 'qty2'];

async function exportLotVerification(db, auctionId) {
  const { rows, left, right } = lotVerificationData(db, auctionId);
  const cols = LOT_VERIF_COLS;
  const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return createExcelBuffer('LotVerification', cols, rows, {
    db, title: 'Lot Verification', metaLines: auctionMeta(db, auctionId),
    // Each block totals ITSELF. A single combined figure spanning both would
    // sit under one block's columns and read as that block's total.
    grandTotal: {
      label: 'TOTAL',
      values: {
        bag:  sum(left,  'bag'), qty:  sum(left,  'qty'),
        lot2: left.length && right.length ? 'TOTAL' : '',
        bag2: sum(right, 'bag'), qty2: sum(right, 'qty'),
      },
    },
  });
}

// ── Lot Verification II: the same sheet, buyer-code-wise ─────
// CODE | LOT | BAG | QTY, in the customer-supplied layout: one block per
// buyer code, closed by a "<CODE> Total" row carrying that buyer's bag
// count. Lot Verification (above) is read down by lot; this one is read
// block by block, so the bags handed over under one code can be counted
// against a single figure.
//
// ── Ordering ───────────────────────────────────────────────────────
// Groups appear in the order their FIRST lot was auctioned, not
// alphabetically — the reference sheet opens TSJ (earliest lot 1), AGA
// (10), MM (11), SMS (14), KC (16). Inside a group the lots run
// ascending. Both fall out of the lot-ordered query plus first-seen Map
// insertion order, so there is no second sort to keep in step.
//
// ── Which lots ─────────────────────────────────────────────────────
// Every lot, including the non-sale markers 'WD' (withdrawn) and 'NA'
// (not auctioned) — those are real codes on the lot and they get their
// own block, for the same reason the Checklist keeps them: a
// verification sheet that silently dropped rows would defeat its
// purpose. A lot with NO code at all has not been allotted to anyone;
// those sort last and their block reads "(NO CODE) Total" so the gap is
// visible instead of blending into a real buyer's block.
//
// CODE is resolved through buyerCodeResolver, the same rule Lot
// Verification uses, so a code corrected in the master after price entry
// moves the lot in BOTH sheets or neither.
//
// ── Why the group rows carry BAG only ──────────────────────────────
// QTY is deliberately blank on them, exactly as on the reference: the
// block total is a bag count, the figure the hall actually counts
// against. The grand total at the foot carries both, being the sheet's
// bottom line rather than a per-block check.
// Same contract as lotVerificationData: one grouping, used by both renderings.
function lotVerification2Data(db, auctionId) {
  const lots = db.all(
    `SELECT lot_no AS lot, bags AS bag, qty,
            COALESCE(code,'')  AS code,
            COALESCE(buyer,'') AS buyer
       FROM lots WHERE auction_id = ?
      ORDER BY CAST(lot_no AS INTEGER), lot_no`, [auctionId]
  );
  const buyerCode = buyerCodeResolver(db);

  // Bucket by resolved code. The query is already lot-ordered, so the Map's
  // insertion order IS "earliest lot first" and each bucket is already
  // ascending — no re-sorting.
  const groups = new Map();
  for (const l of lots) {
    const code = buyerCode(l);
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(l);
  }
  // Un-allotted lots trail the coded blocks whatever lot number they carry.
  const codes = [...groups.keys()].filter(c => c !== '');
  if (groups.has('')) codes.push('');

  const rows = [];
  for (const code of codes) {
    const block = groups.get(code);
    for (const l of block) rows.push({ code, lot: l.lot, bag: l.bag, qty: l.qty });
    rows.push({
      code: `${code || '(NO CODE)'} Total`,
      bag: block.reduce((s, l) => s + (Number(l.bag) || 0), 0),
      _isSubtotal: true,
    });
  }
  return { rows, lots };
}

const LOT_VERIF2_COLS = [
  { header: 'CODE', key: 'code', width: 12 },
  { header: 'LOT',  key: 'lot',  width: 8  },
  { header: 'BAG',  key: 'bag',  width: 7  },
  { header: 'QTY',  key: 'qty',  width: 12 },
];
const LOT_VERIF2_TOTAL_KEYS = ['bag', 'qty'];

async function exportLotVerification2(db, auctionId) {
  const { rows, lots } = lotVerification2Data(db, auctionId);
  const cols = LOT_VERIF2_COLS;
  return createExcelBuffer('LotVerificationII', cols, rows, {
    db, title: 'Lot Verification II', metaLines: auctionMeta(db, auctionId),
    grandTotal: {
      label: 'TOTAL',
      values: {
        bag: lots.reduce((s, l) => s + (Number(l.bag) || 0), 0),
        // Summing kilos in binary floating point leaves 3261.1000000000004.
        // Excel's numFmt would hide it, but ?format=csv writes the raw value
        // out — so round to the 3 decimals the column shows.
        qty: Math.round(lots.reduce((s, l) => s + (Number(l.qty) || 0), 0) * 1000) / 1000,
      },
    },
  });
}

// ── Lot Name: per-lot seller name + price + blank control ─────
// LOT | NAME (seller) | PLACE (KL/TN) | BAG | QTY | PRICE | CONTROL
// PRICE auto-fills from lot.price when set; CONTROL is left blank
// for hand-written verification on the printed sheet.
async function exportLotName(db, auctionId) {
  const rows = db.all(
    `SELECT lot_no AS lot, name, sale AS place,
            bags AS bag, qty, price
       FROM lots WHERE auction_id = ? ORDER BY lot_no`, [auctionId]
  );
  rows.forEach(r => { r.control = ''; });
  const cols = [
    { header: 'LOT',     key: 'lot',     width: 8  },
    { header: 'NAME',    key: 'name',    width: 28 },
    { header: 'PLACE',   key: 'place',   width: 8  },
    { header: 'BAG',     key: 'bag',     width: 6  },
    { header: 'QTY',     key: 'qty',     width: 12 },
    { header: 'PRICE',   key: 'price',   width: 10 },
    { header: 'CONTROL', key: 'control', width: 12 },
  ];
  return createExcelBuffer('LotName', cols, rows, {
    db, title: 'Lot Name', metaLines: auctionMeta(db, auctionId),
    grandTotal: {
      label: 'TOTAL',
      values: {
        bag: rows.reduce((s, r) => s + (Number(r.bag) || 0), 0),
        qty: rows.reduce((s, r) => s + (Number(r.qty) || 0), 0),
      },
    },
  });
}

// ── Lot Payment: per-lot cost grouped by seller place ─────────
// LOT | QTY | RATE | COST | SELLER NAME, grouped by seller place
// (lot.ppla) with one section header per place. PQTY/PRATE/PURAMT
// columns are intentionally dropped — bills carry the post-purchase
// numbers; this is the per-lot cost view only.
async function exportLotPayment(db, auctionId) {
  // Flat, LOT-ordered sheet: one row per lot in lot-number order, carrying the
  // branch (BR), seller name, quantity, rate and bill amount. `lot2` repeats
  // the lot number in the trailing column as a reading aid for the wide row —
  // the same lot marker appears on both the left and right edges. Matches the
  // attached "Lot | BR | Name | Qty | Rate | Bill Amt | Lot" layout.
  //
  // BILL AMT is the seller's PAYABLE, not the gross sale value. It reads
  // `lots.balance`, which is where calculateLot stores the payable:
  //
  //     payable = round( amount + refund − commission − handling − GST )
  //     result.balance = result.payable            (calculations.js)
  //
  // There is no column literally named `payable` on `lots` — `balance` is it.
  // This used to read `amount` (qty × price), which is the figure BEFORE
  // commission, handling and GST come off, so the sheet overstated what each
  // seller was actually paid.
  const rows = db.all(
    `SELECT lot_no AS lot, branch AS br, name, qty, price AS rate,
            balance AS cost, lot_no AS lot2
       FROM lots WHERE auction_id = ?
       ORDER BY CAST(lot_no AS INTEGER), lot_no`, [auctionId]
  );
  // Autofit each column to its content so nothing is truncated and the branch
  // (BR) sits on one line, instead of the fixed width:6 that cut it off.
  // `minWidth` on NAME keeps the column readable even for a sheet of short
  // seller names; the shared helper caps every column at 40 so one very long
  // name can't blow the sheet width out.
  const cols = [
    { header: 'LOT',      key: 'lot'  },
    { header: 'BR',       key: 'br'   },
    { header: 'NAME',     key: 'name', minWidth: 16 },
    { header: 'QTY',      key: 'qty'  },
    { header: 'RATE',     key: 'rate' },
    { header: 'BILL AMT', key: 'cost' },
    { header: 'LOT',      key: 'lot2' },
  ];
  autofitXlsxColumns(cols, rows);
  return createExcelBuffer('LotPayment', cols, rows, {
    db, title: 'Lot Payment', metaLines: auctionMeta(db, auctionId),
    grandTotal: {
      label: 'TOTAL',
      values: {
        qty:  rows.reduce((s, r) => s + (Number(r.qty)  || 0), 0),
        cost: rows.reduce((s, r) => s + (Number(r.cost) || 0), 0),
      },
    },
  });
}

// ── Export Type 3: Price List ─────────────────────────────────
async function exportPriceList(db, auctionId) {
  const rows = db.all(
    `SELECT lot_no as lot, bags as bag, qty, price, code, buyer as bidder
     FROM lots WHERE auction_id = ? ORDER BY lot_no`, [auctionId]
  );
  const cols = [
    { header: 'LOT', key: 'lot', width: 8 },
    { header: 'BAG', key: 'bag', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'PRICE', key: 'price', width: 10 },
    { header: 'CODE', key: 'code', width: 8 },
    { header: 'BIDDER', key: 'bidder', width: 20 },
  ];
  return createExcelBuffer('PriceList', cols, rows, {
    db, title: 'Price List', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export Type 3b: Price List (Before Trade) ─────────────────
// Same shape as Price List but trade-result columns (PRICE, CODE,
// BIDDER) are dropped — meaningful only AFTER buyers bid on lots.
// Useful pre-trade for handing buyers a printable lot inventory.
async function exportPriceListBefore(db, auctionId) {
  // Join the parent auction so every row carries its ANO + date — the
  // sheet is handed out per-trade, so denormalising onto each line keeps
  // a printout intelligible even when columns are reordered/cropped.
  const rows = db.all(
    `SELECT a.ano AS ano, a.date AS date,
            l.lot_no AS lot, l.bags AS bag, l.qty AS qty
       FROM lots l
       JOIN auctions a ON a.id = l.auction_id
      WHERE l.auction_id = ?
      ORDER BY l.lot_no`, [auctionId]
  );
  // Render the date with the operator's configured `date_format`.
  // Centralising via formatDateForDisplay keeps this report aligned
  // with auctionMeta and every other PDF / XLSX in the app.
  const cfg = (function(){ try { return require('./company-config').getSettingsFlat(db); } catch(_) { return {}; } })();
  const dateFmt = cfg.date_format || 'dd/mm/yyyy';
  rows.forEach(r => {
    r.date = formatDateForDisplay(r.date, dateFmt);
    // PRICE, CODE and TRADE NAME are intentionally left blank — buyers
    // fill them in by hand on the printed sheet during the pre-trade walk.
    r.price = '';
    r.code = '';
    r.trade_name = '';
  });
  const cols = [
    { header: 'AUCTION NO',  key: 'ano',        width: 12 },
    { header: 'DATE',        key: 'date',       width: 12 },
    { header: 'LOT',         key: 'lot',        width: 10 },
    { header: 'BAG',         key: 'bag',        width: 8  },
    { header: 'QTY',         key: 'qty',        width: 14 },
    { header: 'PRICE',       key: 'price',      width: 10 },
    { header: 'CODE',        key: 'code',       width: 10 },
    { header: 'TRADE NAME',  key: 'trade_name', width: 22 },
  ];
  return createExcelBuffer('PriceListBefore', cols, rows, {
    db, title: 'Price List (Before)', metaLines: auctionMeta(db, auctionId),
    grandTotal: {
      label: 'TOTAL',
      values: {
        bag: rows.reduce((s, r) => s + (Number(r.bag) || 0), 0),
        qty: rows.reduce((s, r) => s + (Number(r.qty) || 0), 0),
      },
    },
  });
}

// ── Bank Payment (config-driven column layout) ───────────────
// Column layouts live in bank-formats.js keyed by the `bank_format` company
// setting, so the same codebase serves each customer's bank upload template
// without a fork. The payment DATA is identical across formats — only which
// columns are emitted (and any per-cell transform) differs. `view` is the
// resolved profile face (the profile itself for the after variant, or its
// `.before` face for the pre-discount variant).
function renderBankPaymentView(db, auctionId, view, payments, cfg) {
  const cols = view.columns;
  // Apply optional per-column value transforms (e.g. amount → "1234.00" text
  // for banks that want a fixed-decimal string). Only clone rows when needed.
  const hasXform = cols.some(c => typeof c.format === 'function');
  const rows = hasXform
    ? payments.map(p => {
        const o = Object.assign({}, p);
        for (const c of cols) if (typeof c.format === 'function') o[c.key] = c.format(p[c.key], p);
        return o;
      })
    : payments;
  // Strip the non-ExcelJS `format` key before handing columns to the builder.
  const cleanCols = cols.map(({ format, ...rest }) => rest);
  // Optional Total row (sums `amount`) + sign-off footer — profiles that set
  // `total: true` / `signatures: [...]` get an authorization-sheet layout.
  const extra = {};
  if (view.total) {
    const sum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    extra.grandTotal = { label: 'Total', values: { amount: sum } };
    // Let the profile give the TOTAL a different amount format from the data
    // cells (e.g. keep the thousands comma on the total while the column shows
    // plain digits for a bank upload).
    if (view.totalAmountFmt) extra.grandTotal.numFmts = { amount: view.totalAmountFmt };
  }
  if (Array.isArray(view.signatures) && view.signatures.length) {
    extra.signatures = view.signatures;
  }
  // Optional letterhead line above the column headers. The profile owns the
  // wording; we supply the values it can't know: the firm's own debit account
  // (identical on every row of a batch) and TODAY — this sheet is a payment
  // authorization raised and signed on the day it is exported, so it carries
  // the export date, not the auction date.
  if (typeof view.banner === 'function') {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    extra.bannerRow = view.banner({
      cfg: cfg || {},
      debitAccount: (cfg && cfg.bank_kl_acct) || (payments[0] && payments[0].debitAccount) || '',
      exportDate: `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`,
      columnCount: cols.length,
    });
  }
  return createExcelBuffer(view.sheetName, cleanCols, rows, {
    db,
    title: view.title,
    metaLines: view.includeMeta === false ? [] : auctionMeta(db, auctionId),
    // No brand band on the bank file — the column headers must be row 1.
    // This sheet is uploaded to a bank portal, not read across a desk, and
    // the logo/company row plus the e-AUCTION meta row above the headers had
    // to be deleted by hand before every upload.
    skipCompanyHeader: true,
    ...extra,
  });
}

// ── Export Type 4: Bank Payment (after discount) ─────────────
async function exportBankPayment(db, auctionId, cfg, _state, extra) {
  const { getBankPaymentData } = require('./calculations');
  const { getBankFormat } = require('./bank-formats');
  const sellers = (extra && extra.sellers) || null;
  // sellerKeys are the identity form ('id:<trader_id>') of the same selection —
  // they take precedence so ticking one of two same-named sellers exports only
  // that one. lots / excludeLots flow through to getBankPaymentData, which
  // recomputes each affected seller's payable over only the relevant lots.
  // orderByLot is set by the Lot-wise Payments screen so the sheet comes out
  // in the same lot order the operator ticked the rows in.
  const payments = getBankPaymentData(db, auctionId, cfg, {
    sellers,
    sellerKeys: (extra && extra.sellerKeys) || null,
    lots:        extra && extra.lots,
    excludeLots: extra && extra.excludeLots,
    orderByLot:  !!(extra && extra.orderByLot),
  });
  const fmt = getBankFormat(cfg && cfg.bank_format);
  return renderBankPaymentView(db, auctionId, fmt, payments, cfg);
}

// ── Export Type 4c: Bank Payment — ADVANCES ──────────────────
// The bank file that MOVES the advance money, in the same profile layout as
// the payable file above so it uploads to the bank portal identically. One
// line per seller per destination account, amounting to the advances recorded
// against the lots (lot_advances) — see getAdvanceBankPaymentData.
//
// Raised from the lot-wise Payments screen's Pay Advance dialog, which posts
// the picked lots the same way the payable export does. Nothing is stamped by
// this export: an advance is already recorded when it is saved, and the
// payable file deducts it from then on, so the file is a transport of money
// already on the books rather than an event of its own.
async function exportBankPaymentAdvance(db, auctionId, cfg, _state, extra) {
  const { getAdvanceBankPaymentData } = require('./calculations');
  const { getBankFormat } = require('./bank-formats');
  const payments = getAdvanceBankPaymentData(db, auctionId, cfg, {
    sellers:    (extra && extra.sellers) || null,
    sellerKeys: (extra && extra.sellerKeys) || null,
    lots:        extra && extra.lots,
    orderByLot:  !!(extra && extra.orderByLot),
  });
  const fmt = getBankFormat(cfg && cfg.bank_format);
  return renderBankPaymentView(db, auctionId, fmt, payments, cfg);
}

// ── Export Type 4b: Bank Payment (Before discount) ───────────
// Same data shape as bank_payment except `amount` is the pre-discount
// puramt (raw purchase amount before refund/GST). Uses the active profile's
// `before` layout, falling back to the default profile's when the selected
// format doesn't define one.
async function exportBankPaymentBefore(db, auctionId, cfg, _state, extra) {
  const { getBankPaymentData } = require('./calculations');
  const { getBankFormat, BANK_FORMATS, DEFAULT_BANK_FORMAT } = require('./bank-formats');
  const sellers = (extra && extra.sellers) || null;
  const payments = getBankPaymentData(db, auctionId, cfg, {
    before: true, sellers,
    sellerKeys: (extra && extra.sellerKeys) || null,
    lots:        extra && extra.lots,
    excludeLots: extra && extra.excludeLots,
    orderByLot:  !!(extra && extra.orderByLot),
  });
  const fmt = getBankFormat(cfg && cfg.bank_format);
  const view = fmt.before || BANK_FORMATS[DEFAULT_BANK_FORMAT].before;
  return renderBankPaymentView(db, auctionId, view, payments, cfg);
}

// ── Export Type 5: Pooler-wise Register ───────────────────────
async function exportPoolerRegister(db, auctionId) {
  // PQTY / PRATE / PURAMT dropped: those are post-purchase columns the
  // Pooler Register doesn't need — they belong on bills, not the
  // per-lot pooler ledger.
  const rows = db.all(
    `SELECT state, lot_no as lot, name as poolername, branch as br, qty, price, amount
     FROM lots WHERE auction_id = ? AND COALESCE(reserved,0) = 0
     ORDER BY name`, [auctionId]
  );
  // Gross Qty = net qty + the SB Sample Refund (cfg.sb_refund) added back per
  // lot. One row per lot here, so it's a single sample refund per row.
  const sbRefund = Number((require('./company-config').getSettingsFlat(db) || {}).sb_refund) || 0;
  for (const r of rows) r.gross_qty = (Number(r.qty) || 0) + sbRefund;
  const cols = [
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'NAME', key: 'poolername', width: 30 },
    { header: 'BRANCH', key: 'br', width: 15 },
    { header: 'LOT', key: 'lot', width: 8 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'GROSS QTY', key: 'gross_qty', width: 12, numFmt: '#,##0.000', align: 'right' },
    { header: 'PRICE', key: 'price', width: 10 },
    { header: 'AMOUNT', key: 'amount', width: 14 },
  ];
  return createExcelBuffer('PoolerRegister', cols, rows, {
    db, title: 'Pooler Register', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export Type 6: Full File ─────────────────────────────────
async function exportFullFile(db, auctionId) {
  const rows = db.all(`SELECT * FROM lots WHERE auction_id = ? ORDER BY lot_no`, [auctionId]);
  const cols = [
    { header: 'STATE', key: 'state' }, { header: 'LOT', key: 'lot_no', width: 8 },
    { header: 'CROP', key: 'crop' }, { header: 'GRADE', key: 'grade' },
    { header: 'CRPT', key: 'crpt' }, { header: 'BRANCH', key: 'branch', width: 15 },
    { header: 'NAME', key: 'name', width: 30 }, { header: 'CR', key: 'cr', width: 25 },
    { header: 'PAN', key: 'pan' }, { header: 'TEL', key: 'tel' },
    { header: 'BAG', key: 'bags', width: 6 }, { header: 'QTY', key: 'qty', width: 12 },
    { header: 'PRICE', key: 'price', width: 10 }, { header: 'AMOUNT', key: 'amount', width: 14 },
    { header: 'CODE', key: 'code' }, { header: 'BUYER', key: 'buyer', width: 15 },
    { header: 'BUYER1', key: 'buyer1', width: 20 }, { header: 'SALE', key: 'sale' },
    { header: 'INVO', key: 'invo' },
    { header: 'COM', key: 'com' }, { header: 'CGST', key: 'cgst' },
    { header: 'SGST', key: 'sgst' }, { header: 'IGST', key: 'igst' },
    { header: 'ADVANCE', key: 'advance', width: 14 }, { header: 'BALANCE', key: 'balance', width: 14 },
  ];
  return createExcelBuffer('FullFile', cols, rows, {
    db, title: 'Full File', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export Type 7: Collection (invoice register) ─────────────
// Mirrors COLLECTION.pdf: one row per sales invoice issued, grouped by buyer
// state. Columns: SALE+INVO | TRADE NAME (firm) | NAME (buyer) | QTY | VALUE.
async function exportCollection(db, auctionId) {
  return newCollectionXlsx(db, auctionId);
}

// ── Export Type 8: Dealer List ────────────────────────────────
// Dealers are sellers whose `cr` field stores a GSTIN. Storage is
// inconsistent across imports — values appear as "GSTIN.<15>", "gstin <15>",
// "gstin<15>", or bare 15-char alphanumeric. The earlier query
// `WHERE cr LIKE '%GST%'` skipped the bare-15 case (silently returning
// an empty XLSX) and SUBSTR(cr,7,15) hard-coded a 6-char prefix.
//
// Fix: compute a clean GSTIN inline (strip any 'gstin' prefix +
// punctuation/whitespace, uppercase) and filter on its length being
// exactly 15. Works for every storage form.
async function exportDealerList(db, auctionId) {
  const { hasValidGstinSql } = require('./calculations');
  // One row per dealer PER BRANCH, closed by a "<NAME> TOTAL" row — a dealer
  // who sold from two branches gets two rows plus their total. Branch is
  // normalised to '—' when a lot carries none, so unbranched lots stay
  // visible instead of merging into a neighbouring branch's row.
  const rows = db.all(
    `WITH cleaned AS (
       SELECT state, name, lot_no, bags, qty, sample_wt, amount,
              NULLIF(TRIM(COALESCE(branch,'')),'') AS branch,
              UPPER(TRIM(
                CASE
                  WHEN LOWER(SUBSTR(TRIM(cr),1,5)) = 'gstin'
                    THEN LTRIM(SUBSTR(TRIM(cr),6), '. :-')
                  ELSE TRIM(cr)
                END
              )) AS gstin
         FROM lots
        WHERE auction_id = ? AND COALESCE(reserved,0) = 0
          AND ${hasValidGstinSql('cr')}
     )
     SELECT state, name, gstin, COALESCE(branch,'—') AS branch,
            COUNT(lot_no) as lots, SUM(bags) as bags, SUM(qty) as qty,
            SUM(sample_wt) as sample_wt,
            (SUM(qty) + SUM(sample_wt)) as gross_wt
       FROM cleaned
      GROUP BY state, name, gstin, branch
      -- Alphabetical by dealer name. UPPER(TRIM(..)) because SQLite's default
      -- collation is binary: a plain ORDER BY name files every lowercase name
      -- after every uppercase one, so "Anil" landed below "ZZZ". State moved
      -- behind the name — the list is read by looking a dealer up, not by
      -- state. Name+GSTIN stay adjacent so a dealer's branch rows read as one
      -- block (and the PDF twin can number the dealer once per block).
      ORDER BY UPPER(TRIM(name)), gstin, state, branch`, [auctionId]
  );
  // Gross Qty = net qty + SB Sample Refund × lot count (one sample refund per
  // lot). Computed from cfg.sb_refund so it's independent of the per-lot
  // stored sample_wt (which feeds the SAMPLE WT / GROSS WT columns below).
  const sbRefund = Number((require('./company-config').getSettingsFlat(db) || {}).sb_refund) || 0;
  for (const r of rows) r.gross_qty = (Number(r.qty) || 0) + (Number(r.lots) || 0) * sbRefund;
  // Per-dealer "<NAME> TOTAL" subtotal rows were dropped per user request —
  // the sheet is a flat one-row-per-branch list now. Keep the rows ordered by
  // name so a dealer's branches still read as one block.
  const cols = [
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'BRANCH', key: 'branch', width: 16 },
    { header: 'LOTS', key: 'lots', width: 6 },
    { header: 'BAGS', key: 'bags', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'GROSS QTY', key: 'gross_qty', width: 12, numFmt: '#,##0.000', align: 'right' },
    // Sample weight, then gross weight = QTY + SAMPLE WT (per dad's spec).
    // Explicit 3-decimal numFmt so both weigh columns match the QTY format.
    { header: 'SAMPLE WT', key: 'sample_wt', width: 12, numFmt: '#,##0.000', align: 'right' },
    { header: 'GROSS WT',  key: 'gross_wt',  width: 12, numFmt: '#,##0.000', align: 'right' },
  ];
  return createExcelBuffer('DealerList', cols, rows, {
    db, title: 'Dealer List', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export: Planter List (Grade 1) ───────────────────────────
// Pre-trade counterpart to the Dealer List: one row per grade-1 planter
// (agriculturist / pooler) with their lot count, bags and quantity. Grade is
// matched TRIM-insensitively since lot grades may carry stray whitespace, and
// — unlike the Dealer List — there is NO amount>0 gate so the list is usable
// before pricing (the whole point of a pre-trade snapshot). The CR column
// shows the planter's registration number with the stored "CR." prefix
// stripped, mirroring how the Dealer List cleans the "GSTIN." prefix.
async function exportPlanterList(db, auctionId) {
  const rows = db.all(
    `WITH cleaned AS (
       SELECT name, bags, qty, lot_no,
              TRIM(CASE
                WHEN LOWER(SUBSTR(TRIM(cr),1,3)) = 'cr.'
                  THEN LTRIM(SUBSTR(TRIM(cr),4), '. :-')
                ELSE TRIM(cr)
              END) AS cr
         FROM lots
        WHERE auction_id = ? AND TRIM(COALESCE(grade,'')) = '1'
     )
     SELECT name, cr,
            COUNT(lot_no) as lots, SUM(bags) as bags, SUM(qty) as qty
       FROM cleaned
      GROUP BY name, cr
      ORDER BY name`, [auctionId]
  );
  // Gross Qty = net qty + SB Sample Refund × lot count (one sample refund per
  // lot) — the same rule the Dealer List and the pooler lists use, so the
  // party lists all agree on what "gross" means.
  const sbRefund = Number((require('./company-config').getSettingsFlat(db) || {}).sb_refund) || 0;
  for (const r of rows) r.gross_qty = (Number(r.qty) || 0) + (Number(r.lots) || 0) * sbRefund;
  const cols = [
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'CR',   key: 'cr',   width: 25 },
    { header: 'LOTS', key: 'lots', width: 6 },
    { header: 'BAGS', key: 'bags', width: 6 },
    { header: 'QTY',  key: 'qty',  width: 12, numFmt: '#,##0.000' },
    { header: 'GROSS QTY', key: 'gross_qty', width: 12, numFmt: '#,##0.000', align: 'right' },
  ];
  return createExcelBuffer('PlanterList', cols, rows, {
    db, title: 'Planter List (Grade 1)', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export: Dealer List (Party-wise) ─────────────────────────
// Consolidated one row per registered dealer (a seller whose `cr` holds a
// valid 15-char GSTIN), grouped strictly by party (name + cleaned GSTIN)
// across the whole trade. This is the party-wise counterpart to the plain
// Dealer List (exportDealerList) — same GSTIN-cleaning rule, but it also
// rolls up the AMOUNT so the file doubles as a per-dealer value summary.
async function exportDealerListPartyWise(db, auctionId) {
  const { hasValidGstinSql } = require('./calculations');
  const rows = db.all(
    `WITH cleaned AS (
       SELECT state, name, lot_no, bags, qty, amount,
              NULLIF(TRIM(COALESCE(branch,'')),'') AS branch,
              UPPER(TRIM(
                CASE
                  WHEN LOWER(SUBSTR(TRIM(cr),1,5)) = 'gstin'
                    THEN LTRIM(SUBSTR(TRIM(cr),6), '. :-')
                  ELSE TRIM(cr)
                END
              )) AS gstin
         FROM lots
        WHERE auction_id = ? AND COALESCE(reserved,0) = 0
          -- Previous rule: registered dealer = cr holds a valid GSTIN (SBL ignored).
          AND ${hasValidGstinSql('cr')}
     )
     SELECT state, name, gstin, COALESCE(branch,'—') AS branch,
            COUNT(lot_no) as lots, SUM(bags) as bags, SUM(qty) as qty,
            SUM(amount) as amount
       FROM cleaned
      GROUP BY name, gstin, branch
      -- Case-insensitive alphabetical — see exportDealerList.
      ORDER BY UPPER(TRIM(name)), gstin, branch`, [auctionId]
  );
  // Gross Qty = net qty + SB Sample Refund × lot count (one sample refund per lot).
  const sbRefund = Number((require('./company-config').getSettingsFlat(db) || {}).sb_refund) || 0;
  for (const r of rows) r.gross_qty = (Number(r.qty) || 0) + (Number(r.lots) || 0) * sbRefund;
  // No per-dealer "<NAME> TOTAL" rows — see exportDealerList. Only the yellow
  // grand-total footer below closes the sheet.
  const cols = [
    { header: 'STATE',  key: 'state',  width: 12 },
    { header: 'NAME',   key: 'name',   width: 30 },
    { header: 'GSTIN',  key: 'gstin',  width: 18 },
    { header: 'BRANCH', key: 'branch', width: 16 },
    { header: 'LOTS',   key: 'lots',   width: 6  },
    { header: 'BAGS',   key: 'bags',   width: 6  },
    { header: 'QTY',    key: 'qty',    width: 12, numFmt: '#,##0.000' },
    { header: 'GROSS QTY', key: 'gross_qty', width: 12, numFmt: '#,##0.000', align: 'right' },
    { header: 'AMOUNT', key: 'amount', width: 16, numFmt: '#,##0.00'  },
  ];
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return createExcelBuffer('DealerListPartyWise', cols, rows, {
    db, title: 'Dealer List (Party-wise)', metaLines: auctionMeta(db, auctionId),
    grandTotal: { label: 'TOTAL', values: {
      lots: sum('lots'), bags: sum('bags'), qty: sum('qty'), gross_qty: sum('gross_qty'), amount: sum('amount'),
    } },
  });
}

// ── Export: Pooler List consolidated (Party-wise) ────────────
// The Pooler Register (which is one row per lot) rolled up to a single line
// per pooler: lot count, bags, qty, value and bill amount. Covers every
// seller in the trade — priced or not, so the list is usable before price
// import (unpriced lots simply show zero value). No GSTIN gate either —
// poolers are agriculturists who typically have none.
async function exportPoolerListConsolidated(db, auctionId) {
  const rows = db.all(
    `SELECT name, MAX(cr) as cr,
            COUNT(lot_no) as lots, SUM(bags) as bags, SUM(qty) as qty,
            SUM(amount) as value, SUM(bilamt) as billamount
       FROM lots
      WHERE auction_id = ? AND COALESCE(reserved,0) = 0
      GROUP BY name
      ORDER BY name`, [auctionId]
  );
  // Gross Qty = net qty + SB Sample Refund × lot count (one sample refund per lot).
  const sbRefund = Number((require('./company-config').getSettingsFlat(db) || {}).sb_refund) || 0;
  for (const r of rows) r.gross_qty = (Number(r.qty) || 0) + (Number(r.lots) || 0) * sbRefund;
  const cols = [
    { header: 'NAME',       key: 'name',       width: 30 },
    { header: 'CR/GSTIN',   key: 'cr',         width: 20 },
    { header: 'LOTS',       key: 'lots',       width: 6  },
    { header: 'BAGS',       key: 'bags',       width: 6  },
    { header: 'QTY',        key: 'qty',        width: 12, numFmt: '#,##0.000' },
    { header: 'GROSS QTY',  key: 'gross_qty',  width: 12, numFmt: '#,##0.000', align: 'right' },
    { header: 'VALUE',      key: 'value',      width: 16, numFmt: '#,##0.00'  },
    { header: 'BILLAMOUNT', key: 'billamount', width: 16, numFmt: '#,##0.00'  },
  ];
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return createExcelBuffer('PoolerListConsolidated', cols, rows, {
    db, title: 'Pooler List consolidated (Party-wise)', metaLines: auctionMeta(db, auctionId),
    grandTotal: { label: 'TOTAL', values: {
      lots: sum('lots'), bags: sum('bags'), qty: sum('qty'), gross_qty: sum('gross_qty'),
      value: sum('value'), billamount: sum('billamount'),
    } },
  });
}

// ── Export Type 9: Sales & Taxes ─────────────────────────────
async function exportSalesTaxes(db, auctionId) {
  const rows = db.all(
    // `bag`, not `bags` — the invoices table spells it singular (db.js:386).
    // The plural alias made this export fail with "no such column: bags" for
    // every trade until the document-catalog coverage test flagged it.
    `SELECT state, sale, invo, buyer1 as tradername, bag, qty,
      amount as cardamom_cost, gunny as gunny_cost,
      cgst, sgst, igst, tcs, pava_hc as transport, ins as insurance, tot as total
     FROM invoices WHERE ano = (SELECT ano FROM auctions WHERE id = ?)
     ORDER BY sale, invo`, [auctionId]
  );
  const cols = [
    { header: 'STATE', key: 'state' }, { header: 'SALE', key: 'sale' },
    { header: 'INVO', key: 'invo' }, { header: 'TRADERNAME', key: 'tradername', width: 25 },
    { header: 'BAG', key: 'bag', width: 6 }, { header: 'QTY', key: 'qty', width: 12 },
    { header: 'CARDAMOM', key: 'cardamom_cost', width: 14 },
    { header: 'GUNNY', key: 'gunny_cost', width: 10 },
    { header: 'CGST', key: 'cgst', width: 12 }, { header: 'SGST', key: 'sgst', width: 12 },
    { header: 'IGST', key: 'igst', width: 12 }, { header: 'TCS', key: 'tcs', width: 10 },
    { header: 'TRANSPORT', key: 'transport', width: 10 },
    { header: 'INSURANCE', key: 'insurance', width: 10 },
    { header: 'TOTAL', key: 'total', width: 14 },
  ];
  return createExcelBuffer('SalesTaxes', cols, rows, {
    db, title: 'Sales & Taxes', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export: Payment Summary ──────────────────────────────────
async function exportPaymentSummary(db, auctionId, cfg, _state, extra) {
  const sellersFilter = (extra && Array.isArray(extra.sellers) && extra.sellers.length)
    ? new Set(extra.sellers.map(s => String(s).trim().toUpperCase()))
    : null;
  // Payable is the per-lot net (lots.balance). Debit notes are NOT
  // subtracted here — they are separate documents and no longer affect the
  // Payments payable, matching getPaymentSummary and the on-screen Payments
  // tab. (discountCol still drives which per-lot policy-discount column the
  // detail rows read, by business mode.)
  const mode = (cfg && cfg.business_mode || 'e-Auction').toLowerCase();
  const discountCol = (mode === 'auction') ? 'advance' : 'refund';
  let rows = db.all(
    `SELECT name as poolername, lot_no as lot, bags as bag, qty, price, amount,
      ${discountCol} as lot_discount, com as commission, balance as payable
     FROM lots WHERE auction_id = ? AND amount > 0
     ORDER BY state, name`, [auctionId]
  );
  if (sellersFilter) {
    rows = rows.filter(r => sellersFilter.has(String(r.poolername || '').trim().toUpperCase()));
  }
  // Per-seller lot-picks + already-exported exclusions (Payments tab's
  // tracked-export flow). lots → keep ONLY these lot rows for the seller;
  // excludeLots → drop these (already shipped before). Both compose.
  const _lotSets = (m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const o = {}; let any = false;
    for (const k of Object.keys(m)) {
      const arr = Array.isArray(m[k]) ? m[k].map(x => String(x)) : [];
      if (arr.length) { o[String(k).trim().toUpperCase()] = new Set(arr); any = true; }
    }
    return any ? o : null;
  };
  const lotPicksU   = _lotSets(extra && extra.lots);
  const excludeLotsU = _lotSets(extra && extra.excludeLots);
  if (lotPicksU || excludeLotsU) {
    rows = rows.filter(r => {
      const key = String(r.poolername || '').trim().toUpperCase();
      const lotKey = String(r.lot);
      const picks = lotPicksU && lotPicksU[key];
      if (picks && !picks.has(lotKey)) return false;
      const excl = excludeLotsU && excludeLotsU[key];
      if (excl && excl.has(lotKey)) return false;
      return true;
    });
  }
  // Seller-level Advance (deducted from Payable) and display-only settlement
  // Discount come from getPaymentSummary so this per-lot export agrees with
  // the Payments tab. They're emitted once per seller (on the seller's first
  // lot row) since they're seller-level, not per-lot, figures.
  const { getPaymentSummary } = require('./calculations');
  const summ = getPaymentSummary(db, auctionId, _state, cfg) || [];
  const advByName = {}, discByName = {};
  summ.forEach(s => {
    const k = String(s.name || '').trim().toUpperCase();
    advByName[k]  = Number(s.advance) || 0;
    discByName[k] = Number(s.seller_discount) || 0;
  });
  // Payable = per-lot net (lots.balance), with no debit-note subtraction.
  // The displayed column shows COMMISSION (lots.com), not discount — per the
  // Payments-tab change.
  const _sellerSeen = new Set();
  const enriched = rows.map(r => {
    const k = String(r.poolername || '').trim().toUpperCase();
    const firstForSeller = !_sellerSeen.has(k);
    if (firstForSeller) _sellerSeen.add(k);
    return {
      ...r,
      commission: Number(r.commission) || 0,
      payable: Number(r.payable) || 0,
      // Once-per-seller so column totals equal each seller's single value.
      advance:  firstForSeller ? (advByName[k]  || 0) : 0,
      discount: firstForSeller ? (discByName[k] || 0) : 0,
    };
  });
  const cols = [
    { header: 'POOLERNAME', key: 'poolername', width: 30 },
    { header: 'LOT', key: 'lot', width: 8 }, { header: 'BAG', key: 'bag', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 }, { header: 'PRICE', key: 'price', width: 10 },
    { header: 'AMOUNT', key: 'amount', width: 14 },
    { header: 'COMMISSION', key: 'commission', width: 14 },
    { header: 'PAYABLE', key: 'payable', width: 14 },
    { header: 'ADVANCE', key: 'advance', width: 12 },
    { header: 'DISCOUNT', key: 'discount', width: 12 },
  ];
  // Footer totals — sum every numeric column. The earlier export had no
  // totals row, so users had to compute payable/discount sums manually
  // in Excel before reconciling with bank transfers. PRICE/PRATE are
  // omitted from the sum (averaging rates makes no business sense; a
  // sum would mislead readers).
  const sum = (key) => enriched.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const grandTotal = {
    label: 'GRAND TOTAL',
    values: {
      bag:     sum('bag'),
      qty:     sum('qty'),
      amount:  sum('amount'),
      commission:sum('commission'),
      payable: sum('payable'),
      advance: sum('advance'),
      discount:sum('discount'),
    },
  };
  return createExcelBuffer('Payment', cols, enriched, {
    db, title: 'Payment Summary', metaLines: auctionMeta(db, auctionId),
    grandTotal,
  });
}

// ── Export: Payment Summary — Party-wise ─────────────────────
// One row per party (seller), aggregated, mirroring the on-screen Payments
// tab. Built from calculations.getPaymentSummary so the figures (incl. the
// purchase TDS column) match the list, lot modal and statement exactly.
async function exportPaymentPartyWise(db, auctionId, cfg, state, extra) {
  const { getPaymentSummary } = require('./calculations');
  const sellersFilter = (extra && Array.isArray(extra.sellers) && extra.sellers.length)
    ? new Set(extra.sellers.map(s => String(s).trim().toUpperCase()))
    : null;
  let rows = getPaymentSummary(db, auctionId, state, cfg) || [];
  if (sellersFilter) {
    rows = rows.filter(r => sellersFilter.has(String(r.name || '').trim().toUpperCase()));
  }
  const enriched = rows.map(r => ({
    poolername: r.name || '',
    lots:       Number(r.lot_count) || 0,
    qty:        Number(r.total_qty) || 0,
    amount:     Number(r.total_amount) || 0,
    purchase:   Number(r.purchase_value) || 0,
    commission: Number(r.total_commission) || 0,
    gst:        Number(r.total_tax) || 0,
    tds:        Number(r.tds) || 0,
    net:        Number(r.net_amount) || 0,
    advance:    Number(r.advance) || 0,
    payable:    Number(r.total_payable) || 0,
    discount:   Number(r.seller_discount) || 0,
  }));
  // Column order mirrors the Payments tab: Net → Advance → Payable → Discount.
  // Payable = Net − Advance; Discount is display-only (never affects Payable).
  const cols = [
    { header: 'POOLERNAME', key: 'poolername', width: 30 },
    { header: 'LOTS', key: 'lots', width: 7 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'AMOUNT', key: 'amount', width: 14 },
    { header: 'PURCHASE', key: 'purchase', width: 14 },
    { header: 'COMMISSION', key: 'commission', width: 14 },
    { header: 'GST', key: 'gst', width: 12 },
    { header: 'TDS', key: 'tds', width: 12 },
    { header: 'NET AMOUNT', key: 'net', width: 14 },
    { header: 'ADVANCE', key: 'advance', width: 12 },
    { header: 'PAYABLE', key: 'payable', width: 14 },
    { header: 'DISCOUNT', key: 'discount', width: 12 },
  ];
  const sum = (key) => enriched.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const grandTotal = {
    label: 'GRAND TOTAL',
    values: {
      lots:       sum('lots'),
      qty:        sum('qty'),
      amount:     sum('amount'),
      purchase:   sum('purchase'),
      commission: sum('commission'),
      gst:        sum('gst'),
      tds:        sum('tds'),
      net:        sum('net'),
      advance:    sum('advance'),
      payable:    sum('payable'),
      discount:   sum('discount'),
    },
  };
  return createExcelBuffer('PaymentPartyWise', cols, enriched, {
    db, title: 'Payment Summary — Party-wise', metaLines: auctionMeta(db, auctionId),
    grandTotal,
  });
}

// ── Export: TDS Return ───────────────────────────────────────
async function exportTDSReturn(db, fromDate, toDate) {
  const { getTDSReturnData } = require('./calculations');
  const rows = getTDSReturnData(db, fromDate, toDate, 'invoice');
  const cols = [
    { header: 'INVOICE', key: 'invoice', width: 10 },
    { header: 'DATE', key: 'date', width: 12 },
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'PAN', key: 'pan', width: 12 },
    { header: 'ASSESS_VALUE', key: 'assess_value', width: 14 },
    { header: 'TDS', key: 'tds', width: 12 },
  ];
  return createExcelBuffer('TDSReturn', cols, rows, {
    db, title: 'TDS Return', metaLines: [`From: ${fromDate}`, `To: ${toDate}`],
  });
}

// ── Export: Tally format (TALY.PRG — purchase data for accounting)
async function exportTallyPurchase(db, auctionId, cfg) {
  const mode = (cfg && cfg.business_mode || 'e-Auction').toLowerCase();
  const discountCol = (mode === 'auction') ? 'advance' : 'refund';
  const rows = db.all(
    // ADD is a SQLite keyword, so the alias has to be quoted — unquoted it
    // is a syntax error and this export failed for every trade. The column
    // name itself must stay `add`: the cols[] mapping below and the TALY.PRG
    // consumer both expect that key.
    `SELECT name, padd as "add", ppla as place, cr as gstin, tel,
      lot_no as lot, bags as bag, pqty as qty, prate as price, puramt as amount,
      cgst, sgst, igst, ${discountCol} as discount, puramt as bilamt
     FROM lots WHERE auction_id = ? AND amount > 0
      AND cr NOT LIKE 'GSTIN.%'
     ORDER BY name`, [auctionId]
  );
  const cols = [
    { header: 'NAME', key: 'name', width: 30 }, { header: 'ADD', key: 'add', width: 30 },
    { header: 'PLACE', key: 'place', width: 15 }, { header: 'GSTIN', key: 'gstin', width: 20 },
    { header: 'TEL', key: 'tel', width: 14 }, { header: 'LOT', key: 'lot', width: 8 },
    { header: 'BAG', key: 'bag', width: 6 }, { header: 'QTY', key: 'qty', width: 12 },
    { header: 'PRICE', key: 'price', width: 10 }, { header: 'AMOUNT', key: 'amount', width: 14 },
    { header: 'CGST', key: 'cgst', width: 12 }, { header: 'SGST', key: 'sgst', width: 12 },
    { header: 'IGST', key: 'igst', width: 12 }, { header: 'DISCOUNT', key: 'discount', width: 14 },
    { header: 'BILAMT', key: 'bilamt', width: 14 },
  ];
  return createExcelBuffer('TallyPurchase', cols, rows, {
    db, title: 'Tally Purchase', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export: Sales Journal (JOUR.PRG) ────────────────────────
// Trade-based: filters by auction_id; dates rendered dd/mm/yyyy.
// Date / Buyer / GSTIN / Place columns dropped per request — the register
// keeps the sale/invoice/trade-name identity and the money columns.
// Widths below are only the FLOOR — autofitXlsxColumns() sizes each column to
// its content just before the buffer is built. The register is wide and its
// money columns run to eight figures, so fixed widths pushed the rupee cells
// into "####".
// No SALE column — the sheet is already scoped by the Sale Type filter (and
// says so in metaLines), and the sale-type breakdown is what the ledger
// summary block is for. `sale` still arrives on every row and still drives the
// register's ORDER (see getSalesJournal); it just isn't printed.
//
// Shared with the PDF twin in exports-pdf.js so the register cannot list one
// set of columns on paper and another in the spreadsheet.
const SALES_JOURNAL_COLS = [
  { header: 'INV#', key: 'invo', minWidth: 8 },
  // No maxWidth override — the helper's 40 cap comfortably fits the longest
  // real trade names ("PANIKULANGARA SPICES TRADING COMPANY", 36 chars).
  { header: 'TRADE NAME', key: 'buyer1', minWidth: 16 },
  { header: 'BAGS', key: 'bag', minWidth: 6 },
  { header: 'QTY', key: 'qty', minWidth: 10 },
  { header: 'CARDAMOM', key: 'cardamom', minWidth: 12 },
  { header: 'GUNNY', key: 'gunny', minWidth: 9 },
  { header: 'TRANSPORT', key: 'transport', minWidth: 11 },
  { header: 'INSURANCE', key: 'insurance', minWidth: 11 },
  { header: 'CGST', key: 'cgst', minWidth: 9 },
  { header: 'SGST', key: 'sgst', minWidth: 9 },
  { header: 'IGST', key: 'igst', minWidth: 9 },
  { header: 'TCS', key: 'tcs', minWidth: 8 },
  { header: 'ROUND', key: 'rund', minWidth: 8 },
  { header: 'TOTAL', key: 'total', minWidth: 12 },
];
const SALES_JOURNAL_TOTAL_KEYS =
  ['bag','qty','cardamom','gunny','transport','insurance','cgst','sgst','igst','tcs','rund','total'];

async function exportSalesJournal(db, auctionId, saleType) {
  const calc = require('./calculations');
  const cfg = require('./company-config').getSettingsFlat(db);
  // Same cfg the summary uses, so the XLSX register and its ledger block agree
  // on whether proforma mode is on (see the note over getSalesJournal).
  const rows = calc.getSalesJournal(db, auctionId, saleType, cfg);
  // Shared with the PDF twin — see SALES_JOURNAL_COLS above. Copied into a
  // fresh array because autofitXlsxColumns writes measured widths onto the
  // column objects, and the shared spec must not accumulate one sheet's
  // widths and hand them to the next caller.
  const cols = SALES_JOURNAL_COLS.map(c => ({ ...c }));
  // Column-sum "Total" row.
  const sumKeys = SALES_JOURNAL_TOTAL_KEYS;
  const totalRow = { buyer1: 'Total' };
  for (const k of sumKeys) totalRow[k] = rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  // Measure the totals row too — its sums are the widest numbers on the sheet.
  autofitXlsxColumns(cols, [...rows, totalRow]);
  // Sale-type ledger summary (as in the COLLECTION reference). Rendered as its
  // OWN merged-cell container (Particulars | Qty | Amount) below the invoice
  // register, so each value — including the smaller gunny-sales lines — stays
  // legible instead of being stretched across the wide invoice columns.
  const summary = calc.getSalesJournalSummary(db, auctionId, saleType, cfg);
  const sections = [{ title: 'SALES INVOICES', rows: [...rows, totalRow] }];
  return createExcelBuffer('SalesJournal', cols, [], {
    db, title: 'Sales Journal',
    metaLines: [...auctionMeta(db, auctionId), saleType ? `Type: ${saleType}` : ''].filter(Boolean),
    sections, spacerBetween: true,
    summaryBlock: summary ? {
      title: `${summary.stateLabel} — LEDGER SUMMARY`,
      headers: ['Particulars', 'Qty', 'Amount'],
      lines: summary.lines.map(l => ({ label: l.label, qty: l.qty, value: l.value })),
      total: { label: `${summary.stateLabel} TOTAL`, value: summary.stateTotal },
      fillArgb: 'FFD1E7DD',
    } : null,
  });
}

// ── Export: Purchase Journal (PUJOUR.PRG / PPUJOUR.PRG) ────
// Trade-based: filters by auction_id (or ano for legacy bills);
// dates rendered dd/mm/yyyy.
async function exportPurchaseJournal(db, auctionId, type) {
  const { getPurchaseJournal } = require('./calculations');
  const rows = getPurchaseJournal(db, auctionId, type);
  const cols = type === 'agri' ? [
    { header: 'DATE', key: 'date', width: 12 },
    { header: 'BILL#', key: 'bill_no', width: 8 },
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'ADDRESS', key: 'address', width: 30 },
    { header: 'PLACE', key: 'place', width: 15 },
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'CR', key: 'cr', width: 15 },
    { header: 'PAN', key: 'pan', width: 12 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'COST', key: 'cost', width: 14 },
    { header: 'IGST', key: 'igst', width: 10 },
    { header: 'NET', key: 'net', width: 14 },
  ] : [
    { header: 'DATE', key: 'date', width: 12 },
    { header: 'INV#', key: 'invoice_no', width: 8 },
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'ADDRESS', key: 'address', width: 30 },
    { header: 'PLACE', key: 'place', width: 15 },
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'GSTIN', key: 'gstin', width: 20 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'AMOUNT', key: 'amount', width: 14 },
    { header: 'CGST', key: 'cgst', width: 10 },
    { header: 'SGST', key: 'sgst', width: 10 },
    { header: 'IGST', key: 'igst', width: 10 },
    { header: 'ROUND', key: 'rund', width: 8 },
    { header: 'TOTAL', key: 'total', width: 14 },
    { header: 'TDS', key: 'tds', width: 10 },
  ];
  const name = type === 'agri' ? 'AgriBillJournal' : 'PurchaseJournal';
  return createExcelBuffer(name, cols, rows, {
    db,
    title: type === 'agri' ? 'Agri Bill Journal' : 'Purchase Journal',
    metaLines: auctionMeta(db, auctionId),
  });
}

// ══════════════════════════════════════════════════════════════
// REGISTERS — lot-wise Purchase / invoice-wise Sales (XLSX)
// ══════════════════════════════════════════════════════════════

// Header meta lines for the Registers — auction (when scoped to one) or a
// date range (when spanning auctions), plus an optional sale-type note.
function registerMeta(db, opts) {
  const lines = [];
  if (opts && opts.auctionId) lines.push(...auctionMeta(db, opts.auctionId));
  else if (opts && opts.from && opts.to) lines.push(`Period: ${opts.from} to ${opts.to}`);
  else lines.push('All auctions');
  if (opts && opts.saleType) lines.push(`Sale: ${opts.saleType}`);
  return lines.filter(Boolean);
}

// ── Export: Purchase Register (lot-wise) ───────────────────
async function exportPurchaseRegister(db, opts = {}) {
  const { getPurchaseRegister } = require('./calculations');
  const rows = getPurchaseRegister(db, opts);
  const cols = [
    { header: 'STATE',  key: 'state',  width: 14 },
    { header: 'TNO',    key: 'tno',    width: 6  },
    { header: 'DATE',   key: 'date',   width: 12 },
    { header: 'LOT',    key: 'lot',    width: 8  },
    { header: 'BRANCH', key: 'branch', width: 10 },
    { header: 'NAME',   key: 'name',   width: 28 },
    { header: 'PLACE',  key: 'place',  width: 14 },
    { header: 'GSTIN',  key: 'gstin',  width: 18 },
    { header: 'BAG',    key: 'bag',    width: 6  },
    { header: 'QTY',    key: 'qty',    width: 11, numFmt: '#,##0.000' },
    { header: 'PRICE',  key: 'price',  width: 10, numFmt: '#,##0.00' },
    { header: 'AMOUNT', key: 'amount', width: 14, numFmt: '#,##0.00' },
    { header: 'REFUND', key: 'refund', width: 12, numFmt: '#,##0.00' },
    { header: 'COMMISSION', key: 'commission', width: 13, numFmt: '#,##0.00' },
    { header: 'CGST',   key: 'cgst',   width: 11, numFmt: '#,##0.00' },
    { header: 'SGST',   key: 'sgst',   width: 11, numFmt: '#,##0.00' },
    { header: 'IGST',   key: 'igst',   width: 11, numFmt: '#,##0.00' },
    { header: 'BILLAMOUNT', key: 'billamount', width: 14, numFmt: '#,##0.00' },
  ];
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const grandTotal = { label: 'TOTAL', values: {
    bag: sum('bag'), qty: sum('qty'), amount: sum('amount'),
    refund: sum('refund'), commission: sum('commission'),
    cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), billamount: sum('billamount'),
  }};
  return createExcelBuffer('PurchaseRegister', cols, rows, {
    db, title: 'Purchase Register', metaLines: registerMeta(db, opts), grandTotal,
  });
}

// ── Export: Sales Register (invoice-wise) ──────────────────
async function exportSalesRegister(db, opts = {}) {
  const { getSalesRegister } = require('./calculations');
  const rows = getSalesRegister(db, opts);
  const cols = [
    { header: 'STATE',  key: 'state',  width: 14 },
    { header: 'TNO',    key: 'tno',    width: 6  },
    { header: 'DATE',   key: 'date',   width: 12 },
    { header: 'SALE',   key: 'sale',   width: 6  },
    { header: 'INVO',   key: 'invo',   width: 8  },
    { header: 'TRADERNAME', key: 'tradername', width: 30 },
    { header: 'BIDDER', key: 'bidder', width: 10 },
    { header: 'BAG',    key: 'bag',    width: 6  },
    { header: 'QTY',    key: 'qty',    width: 11, numFmt: '#,##0.000' },
    { header: 'AMOUNT', key: 'amount', width: 14, numFmt: '#,##0.00' },
    { header: 'GUNNY',  key: 'gunny',  width: 10, numFmt: '#,##0.00' },
    { header: 'TRANSPORT', key: 'lorry', width: 11, numFmt: '#,##0.00' },
    { header: 'INSURANCE', key: 'ins',  width: 11, numFmt: '#,##0.00' },
    { header: 'CGST',   key: 'cgst',   width: 10, numFmt: '#,##0.00' },
    { header: 'SGST',   key: 'sgst',   width: 10, numFmt: '#,##0.00' },
    { header: 'IGST',   key: 'igst',   width: 10, numFmt: '#,##0.00' },
    { header: 'INVAMT', key: 'invamt', width: 14, numFmt: '#,##0.00' },
  ];
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const grandTotal = { label: 'TOTAL', values: {
    bag: sum('bag'), qty: sum('qty'), amount: sum('amount'), lorry: sum('lorry'),
    gunny: sum('gunny'), igst: sum('igst'), cgst: sum('cgst'), sgst: sum('sgst'),
    ins: sum('ins'), invamt: sum('invamt'),
  }};
  return createExcelBuffer('SalesRegister', cols, rows, {
    db, title: 'Sales Register', metaLines: registerMeta(db, opts), grandTotal,
  });
}

// ── Export: Per-party "Individual" Registers (cross-auction) ───────
// Pooler / Seller / Merchant statements, one section per party. Shares the
// createExcelBuffer section-grouped mode: each party becomes a banded
// section (name + GSTIN) followed by its rows, a bold TOTAL subtotal, and a
// summary line (Sold/Withdrawn for poolers, Closing Balance for the others).
// `labelKey` is the first column the TOTAL/summary labels land in.
const INDIVIDUAL_REG_DEFS = {
  pooler: {
    sheet: 'PoolerRegister', title: 'Pooler Register', labelKey: 'tno',
    cols: [
      { header: 'ANO',    key: 'tno',    width: 8  },
      { header: 'DATE',   key: 'date',   width: 12 },
      { header: 'LOT',    key: 'lot',    width: 8  },
      { header: 'QTY',    key: 'qty',    width: 12, numFmt: '#,##0.000' },
      { header: 'RATE',   key: 'rate',   width: 11, numFmt: '#,##0.00'  },
      { header: 'VALUE',  key: 'value',  width: 16, numFmt: '#,##0.00'  },
      { header: 'REFUND', key: 'refund', width: 12, numFmt: '#,##0.00'  },
      { header: 'COMMISSION', key: 'commission', width: 13, numFmt: '#,##0.00' },
      { header: 'GST',    key: 'gst',    width: 12, numFmt: '#,##0.00'  },
      { header: 'BILLAMOUNT', key: 'billamount', width: 16, numFmt: '#,##0.00' },
    ],
    summaryRows: (p) => ([
      { _isSubtotal: true, tno: 'Total',     qty: p.summary.qty,     value: p.summary.value, refund: p.summary.refund, commission: p.summary.commission, gst: p.summary.gst, billamount: p.summary.billamount },
      { _isSubtotal: true, tno: 'Sold',      qty: p.summary.soldQty, value: p.summary.soldValue },
      { _isSubtotal: true, tno: 'Withdrawn', qty: p.summary.wdQty,   value: p.summary.wdValue },
    ]),
    grandKeys: ['qty', 'value', 'refund', 'commission', 'gst', 'billamount'],
  },
  seller: {
    sheet: 'SellerRegister', title: 'Sellers Individual', labelKey: 'date',
    cols: [
      { header: 'DATE',    key: 'date',    width: 12 },
      { header: 'ANO',     key: 'ano',     width: 8  },
      { header: 'INVO',    key: 'invo',    width: 8,  numFmt: '#,##0' },
      { header: 'QTY',     key: 'qty',     width: 12, numFmt: '#,##0.000' },
      { header: 'INVOICE', key: 'invoice', width: 16, numFmt: '#,##0.00' },
    ],
    summaryRows: (p) => ([
      { _isSubtotal: true, date: 'Total',           qty: p.summary.qty, invoice: p.summary.invoice },
      { _isSubtotal: true, date: 'Closing Balance', invoice: p.summary.closing },
    ]),
    grandKeys: ['qty', 'invoice'],
  },
  merchant: {
    sheet: 'MerchantRegister', title: 'Merchants Individual', labelKey: 'date',
    cols: [
      { header: 'DATE',    key: 'date',    width: 12 },
      { header: 'TNO',     key: 'tno',     width: 8  },
      { header: 'INVO',    key: 'invo',    width: 8  },
      { header: 'RECP',    key: 'recp',    width: 8  },
      { header: 'QTY',     key: 'qty',     width: 12, numFmt: '#,##0.000' },
      { header: 'INVOICE', key: 'invoice', width: 16, numFmt: '#,##0.00' },
      { header: 'RECEIPT', key: 'receipt', width: 16, numFmt: '#,##0.00' },
    ],
    summaryRows: (p) => ([
      { _isSubtotal: true, date: 'Total',           qty: p.summary.qty, invoice: p.summary.invoice, receipt: p.summary.receipt },
      { _isSubtotal: true, date: 'Closing Balance', invoice: p.summary.closing },
    ]),
    grandKeys: ['qty', 'invoice', 'receipt'],
  },
};

function individualRegisterData(db, kind, opts) {
  const { getPoolerRegister, getSellerRegister, getMerchantRegister } = require('./calculations');
  if (kind === 'seller')   return getSellerRegister(db, opts);
  if (kind === 'merchant') return getMerchantRegister(db, opts);
  return getPoolerRegister(db, opts);
}

async function exportIndividualRegister(db, kind, opts = {}) {
  const def = INDIVIDUAL_REG_DEFS[kind];
  if (!def) throw new Error(`Unknown individual register kind: ${kind}`);
  const data = individualRegisterData(db, kind, opts);
  const sections = data.parties.map(p => ({
    // Party banner carries GSTIN and phone, matching the on-screen register
    // and the PDF banner — the phone is the number the office calls back on.
    title: p.name
      + (p.gstin ? `      GSTIN: ${p.gstin}` : '')
      + (p.phone ? `      Ph: ${p.phone}` : ''),
    rows: [...p.rows, ...def.summaryRows(p)],
  }));
  // Grand total across every party in the file.
  const gv = {};
  def.grandKeys.forEach(k => {
    gv[k] = data.parties.reduce((s, p) => s + (Number(p.summary[k]) || 0), 0);
  });
  gv[def.labelKey] = 'GRAND TOTAL';
  return createExcelBuffer(def.sheet, def.cols, [], {
    db, title: def.title, metaLines: registerMeta(db, opts),
    sections, spacerBetween: true,
    grandTotal: { values: gv },
  });
}

// ── Export: Praman CSV (Lot Slip in Praman auction platform format) ──
// Produces a CSV (NOT xlsx) matching the column layout required by Praman's
// lot-upload interface. Returns a Buffer of CSV text.
//
// "Lot Company" column (col 2) is the registered Praman uploader identity —
// resolved from company_settings (`short_name` → `logo` short code). NO
// hardcoded fallback: if neither is configured the cell is left blank,
// surfacing the misconfiguration rather than leaking a stale literal.
async function exportPramanCSV(db, auctionId, cfg, state) {
  // Praman expects PER-LOT planter info — the seller (and their GSTIN)
  // for each individual lot, not a single legal-entity stamp on every
  // row. The earlier export used `getCompanyIdentity(cfg)` and wrote
  // the company's own name + GSTIN on every row, which surfaced as
  // "VANDANMEDU SPICES" (or whatever trade_name was set) repeated for
  // every lot — wrong for the Praman upload, which uses these fields
  // to identify each lot's actual seller.
  //
  // Fix: pull lots.name (seller per lot) and the trader's `cr`
  // (stored as the GSTIN). Falls back to the company identity ONLY if
  // a lot has no associated seller record (legacy data, partial
  // imports).
  const rows = db.all(
    `SELECT l.lot_no, l.branch, l.grade, l.name, l.cr, l.aadhar, l.qty, l.litre, l.bags, l.tel,
            t.cr AS trader_cr, t.aadhar AS trader_aadhar, t.tel AS trader_tel
       FROM lots l
       -- Joined on the seller FK, not the name. Two sellers can share a name
       -- (two "BASKARAN S"), and a name join matched BOTH master rows, so
       -- every one of their lots was emitted TWICE. trader_id is unique per
       -- master row, so each lot yields exactly one line; lots that predate
       -- the FK fall back to a name match narrowed to a single row.
       LEFT JOIN traders t
         ON t.id = COALESCE(l.trader_id,
              (SELECT t2.id FROM traders t2
                WHERE UPPER(TRIM(t2.name)) = UPPER(TRIM(l.name))
                ORDER BY t2.id LIMIT 1))
      WHERE l.auction_id = ? ${state ? 'AND l.state = ?' : ''}
      ORDER BY CAST(l.lot_no AS INTEGER), l.lot_no`,
    state ? [auctionId, state] : [auctionId]
  );

  const header = [
    'Lot Number', 'Lot Company', 'Collection Centre', 'Planter/Dealer',
    'Planter Name', 'CRNO/SBL No', 'Quantity(Kg)', 'Litre Weight(Gms)',
    'Bags', 'Grade Type', 'Grade', 'Reserved Price', 'Auction Start Price(Rs)',
    'Immature Seeds(%)', 'Moisture Content(%)', 'Planter Mobile Number',
    'Youtube Video Link'
  ];

  // GSTIN extractor — `cr` may be stored as "GSTIN.<15>", "gstin.<15>",
  // bare 15-char, or empty. Strip the prefix if present.
  const stripGstinPrefix = (raw) => {
    let s = String(raw || '').trim();
    if (/^gstin\.?/i.test(s)) s = s.replace(/^gstin\.?/i, '');
    return s;
  };

  // Lot company short code — first check for a dedicated Praman value
  // (Settings → Integrations → Praman Lot Company Code). If unset,
  // fall back to the company-wide `short_name` (Settings → Company →
  // Short Name) via the identity resolver. This split lets the user
  // register a different short code with Praman than what they use
  // elsewhere (e.g. invoice prefixes, logo derivation) without
  // touching every other code path.
  // Lot company code on the Praman CSV — derived from the company
  // identity resolver. The dedicated `praman_company` setting was
  // dropped; the resolver already picks short_name → logo code →
  // first word of trade_name, which covers every install we've seen.
  const identity = getCompanyIdentity(cfg);
  const lotCompany = identity.shortName || '';

  // Praman classifies sellers as 1=Planter (URD/agriculturist) or 2=Dealer
  // (registered). Previous rule: dealer = cr holds a valid GSTIN (SBL ignored)
  // so it matches the Dealer List, calculator and payments split.
  const { hasValidGstin } = require('./calculations');
  const classify = (cr) => (hasValidGstin(cr) ? 2 : 1);

  const lines = [header.join(',')];
  for (const r of rows) {
    // Per-lot planter: name from lots.name, GSTIN from trader's `cr`
    // (preferred — master data) with the lot's own `cr` as a fallback
    // when traders join misses.
    const planterName   = (r.name || '').trim();
    const planterGstin  = stripGstinPrefix(r.trader_cr || r.cr);
    const planterMobile = (r.trader_tel || r.tel || '').trim();
    const planterDealer = classify(r.trader_cr || r.cr);

    lines.push([
      r.lot_no || '',
      lotCompany,
      r.branch || '',
      planterDealer,
      planterName,
      planterGstin,
      r.qty || '',
      r.litre || '',
      r.bags || '',
      '', // Grade Type (not captured — blank as per sample)
      '', // Grade (Praman's own grade codes, not ours — blank)
      '', // Reserved Price (blank)
      '', // Auction Start Price (blank)
      '', // Immature Seeds (blank)
      '', // Moisture Content (blank)
      planterMobile,
      '', // Youtube link (blank)
    ].map(csvEscape).join(','));
  }

  // CSV text → Buffer. Prefix with BOM so Excel on Windows opens with
  // UTF-8 correctly (otherwise accented characters break).
  return Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
}

// ── Export: Dealer Invoice CSV (dealer debit-note register) ──────────────
// One flat row per DEALER debit note in the trade — the "Tax Invoice On
// Commission" raised to each registered (Grade 2) seller. CSV only, and
// deliberately WITHOUT the brand band every XLSX export carries: this is a
// data feed whose column set and order are fixed by the layout it replaces,
// so extra rows above the headers would break the consumer.
//
// Every derived figure comes from buildDebitNoteView() — the SAME view model
// the printed debit note renders from — so a line in this register can never
// disagree with the document it summarises. Two consequences worth knowing
// before changing either side:
//
//   • LOT_COUNT / TOTAL_QUANTITY / CARDAMOM_VALUE cover ALL of the dealer's
//     priced lots in the trade, because that is the set the DN body prints —
//     even though COMMISSION itself is the GRADE-2 commission the DN was
//     generated from (see /api/debit-notes/generate). A seller holding both
//     grades therefore shows a commission that is not 1:1 with the cardamom
//     value on the same row. That is the document, not a bug in the register.
//   • INCIDENT_CHARGES is always 0 — the DN carries no incidental line today.
//     The column exists so SUB TOTAL stays reconcilable as
//     COMMISSION + INCIDENT_CHARGES rather than being a bare restatement.
//
// INVOICE NO is the DEALER ref form ("150/26-27/SE") — the number Tally and
// the IRP JSON already use for these notes, not the shorter form printed on
// the PDF ("150/26-27"). Both come from formatDebitNoteNo, so a site that has
// set debit_note_prefix/_suffix gets its own format here too.
async function exportDealerInvoiceCsv(db, auctionId, cfg) {
  const { buildDebitNoteView } = require('./pdf/render-debit-note-html');
  const { refSuffix } = require('./tally-xml');

  const header = [
    'ANO', 'DATE', 'INVOICE NO', 'DEALER NAME', 'STATE', 'STATECODE', 'CR/GST',
    'LOT_COUNT', 'TOTAL_QUANTITY', 'CARDAMOM_VALUE', 'COMMISSION',
    'INCIDENT_CHARGES', 'SUB TOTAL', 'IGST', 'CGST', 'SGST',
    'ROUND OFF', 'GRAND TOTAL',
  ];
  const lines = [header.join(',')];
  const toBuffer = () => Buffer.from('﻿' + lines.join('\r\n'), 'utf8');

  const auction = db.get('SELECT id, ano FROM auctions WHERE id = ?', [auctionId]);
  if (!auction) return toBuffer();

  // Matched on auction_id OR ano: debit_notes gained auction_id in a later
  // migration, so notes raised before it key off the trade number alone
  // (same pattern as the Sales Journal). Ordered by note number ascending —
  // note_no is TEXT holding a numeric string, hence the CAST.
  const notes = db.all(
    `SELECT * FROM debit_notes WHERE (auction_id = ? OR ano = ?)
      ORDER BY CAST(note_no AS INTEGER), note_no, date`,
    [auction.id, auction.ano]
  );

  const dateFmt = (cfg && cfg.date_format) || 'dd/mm/yyyy';
  const season  = debitNoteSeason(cfg);
  const refTail = refSuffix(cfg, 'tally_dn_dealer_ref_suffix', 'SE');
  const n2 = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
  const n3 = (v) => (Math.round((Number(v) || 0) * 1000) / 1000).toFixed(3);

  for (const dn of notes) {
    const view  = buildDebitNoteView(dn, db, cfg, { planter: false });
    const rawNo = String(dn.note_no || dn.id || '').trim();

    // A dealer with no priced lots leaves buildDebitNoteView with one
    // PLACEHOLDER row (lot '—') so the printed note still shows its amount.
    // It is not a lot, so it must not be counted as one here.
    const lotCount = view.rows.filter(r => r.lot && r.lot !== '—').length;

    // The paise the stored total absorbs — recomputed rather than read off
    // view.taxRows so this can't break if that array is reordered.
    const roundOff = Math.round((Number(dn.total || 0)
      - (Number(dn.amount || 0) + Number(dn.cgst || 0)
       + Number(dn.sgst || 0) + Number(dn.igst || 0))) * 100) / 100;

    // `traders.cr` is stored either as "GSTIN.<15>" or bare, depending on
    // whether the seller was typed in or bulk-imported. The view hands back
    // the bare form; re-prefixing normalises both storage shapes to the one
    // this layout expects, and a seller with no GSTIN stays blank rather than
    // emitting a lone "GSTIN.".
    const gstin = view.receiver.gstin ? 'GSTIN.' + view.receiver.gstin : '';

    lines.push([
      dn.ano || '',
      formatDateForDisplay(dn.date, dateFmt),
      formatDebitNoteNo(cfg, rawNo, {
        planter: false, ano: dn.ano,
        legacy: season ? `${rawNo}/${season}${refTail}` : `${rawNo}${refTail}`,
      }),
      dn.name || '',
      view.receiver.state || dn.state || '',
      view.receiver.stCode || '',
      gstin,
      lotCount,
      n3(view.totals.qty),
      n2(view.totals.value),
      n2(view.totals.commission),
      n2(view.totals.incidental),
      n2(view.totals.taxable),
      n2(dn.igst),
      n2(dn.cgst),
      n2(dn.sgst),
      n2(roundOff),
      n2(dn.total),
    ].map(csvEscape).join(','));
  }

  return toBuffer();
}

// ── Export Type 12: Trade Report (BUYERS LIST FOR VERIFICATION) ──
async function exportTradeReport(db, auctionId, _state, extra) {
  return tradeReportXlsx(db, auctionId, extra || {});
}

// ── Export router ────────────────────────────────────────────
// ── Master Data: Sellers (mirrors the NAM.DBF column set) ─────
// Full, unfiltered seller master. Column order/names match exportTradersDbf
// in dbf-exports.js so the .xlsx and .dbf outputs are equivalent. All
// columns are text (no numFmt) to preserve leading zeros in PIN / account
// numbers / phone numbers.
async function exportSellersXlsx(db) {
  const rows = db.all('SELECT * FROM traders ORDER BY name');
  const cols = [
    { header: 'NAME',      key: 'name',        width: 30 },
    { header: 'CR',        key: 'cr',          width: 22 },
    { header: 'PAN',       key: 'pan',         width: 14 },
    { header: 'TAN',       key: 'tan',         width: 14 },
    { header: 'TEL',       key: 'tel',         width: 16 },
    { header: 'AADHAR',    key: 'aadhar',      width: 16 },
    { header: 'PADD',      key: 'padd',        width: 40 },
    { header: 'PPLA',      key: 'ppla',        width: 18 },
    { header: 'PIN',       key: 'pin',         width: 10 },
    { header: 'PSTATE',    key: 'pstate',      width: 16 },
    { header: 'PST_CODE',  key: 'pst_code',    width: 10 },
    { header: 'IFSC',      key: 'ifsc',        width: 14 },
    { header: 'ACCTNUM',   key: 'acctnum',     width: 20 },
    { header: 'HOLDER_NM', key: 'holder_name', width: 30 },
    { header: 'USER_ID',   key: 'user_id',     width: 16 },
    { header: 'DOB',       key: 'dob',         width: 14 },
  ];
  return createExcelBuffer('Sellers', cols, rows, { db, title: 'Sellers' });
}

// ── Master Data: Buyers (mirrors the SBL.DBF column set) ──────
async function exportBuyersXlsx(db) {
  const rows = db.all('SELECT * FROM buyers ORDER BY buyer');
  // SALE defaults to 'L' to match the DBF export's fallback.
  rows.forEach(r => { if (!r.sale) r.sale = 'L'; });
  const cols = [
    { header: 'BUYER',   key: 'buyer',   width: 12 },
    { header: 'BUYER1',  key: 'buyer1',  width: 30 },
    { header: 'ADD1',    key: 'add1',    width: 40 },
    { header: 'ADD2',    key: 'add2',    width: 40 },
    { header: 'PLA',     key: 'pla',     width: 18 },
    { header: 'PIN',     key: 'pin',     width: 10 },
    { header: 'STATE',   key: 'state',   width: 16 },
    { header: 'ST_CODE', key: 'st_code', width: 10 },
    { header: 'GSTIN',   key: 'gstin',   width: 18 },
    { header: 'PAN',     key: 'pan',     width: 14 },
    { header: 'TAN',     key: 'tan',     width: 14 },
    { header: 'TEL',     key: 'tel',     width: 16 },
    { header: 'TI',      key: 'ti',      width: 12 },
    { header: 'SALE',    key: 'sale',    width: 6 },
  ];
  return createExcelBuffer('Buyers', cols, rows, { db, title: 'Buyers' });
}

const EXPORT_TYPES = {
  lot_slip:           { fn: exportLotSlip,           name: 'LotSlip' },
  lot_slip_after:     { fn: exportLotSlipAfter,      name: 'LotSlipAfter' },
  lot_buyer:          { fn: exportLotBuyer,          name: 'LotBuyer' },
  lot_name:           { fn: exportLotName,           name: 'LotName' },
  lot_payment:        { fn: exportLotPayment,        name: 'LotPayment' },
  // needsCfg so the route hands it the settings the DUMMY / BUYER column
  // switches live in (see checklistColumns).
  checklist:          { fn: exportChecklist,         name: 'Checklist', needsCfg: true },
  tharai_list:        { fn: exportTharaiList,        name: 'TharaiList' },
  // Two-up LOT/BAG/QTY/BUYER verification sheet. Native XLSX — the Auction
  // Downloads tile asks for xlsx, not the generic ?format=csv conversion,
  // because flattening a two-block sheet to CSV loses the layout that is
  // the whole reason it exists.
  lot_verification:   { fn: exportLotVerification,   name: 'LotVerification' },
  // The same sheet grouped by buyer code, with a per-code bag subtotal. Also
  // served as xlsx: the "<CODE> Total" rows are what make it readable, and a
  // flat CSV drops the banding that separates one buyer's block from the next.
  // ?format=csv still works on the route for anyone who wants the raw rows.
  lot_verification_2: { fn: exportLotVerification2,  name: 'LotVerificationII' },
  // praman_csv removed in this build (e-Auction(Praman) export disabled).
  price_list:         { fn: exportPriceList,         name: 'PriceList' },
  price_list_before:  { fn: exportPriceListBefore,   name: 'PriceListBefore' },
  bank_payment_before:{ fn: exportBankPaymentBefore, name: 'BankPaymentBefore', needsCfg: true },
  bank_payment:       { fn: exportBankPayment,       name: 'BankPayment',       needsCfg: true },
  // The advances file — same bank profile, but it pays the advances recorded
  // against lots instead of the payable. Raised from Pay Advance on the
  // lot-wise Payments screen; the POST route carries the picked lots.
  bank_payment_advance:{ fn: exportBankPaymentAdvance, name: 'BankPaymentAdvance', needsCfg: true },
  pooler_register:    { fn: exportPoolerRegister,    name: 'PoolerRegister' },
  full_file:          { fn: exportFullFile,          name: 'FullFile' },
  // Writes CSV directly (bespoke 22-column layout), so ext/mime are set
  // here and the route's generic xlsx→csv conversion is skipped.
  commission_bill_csv:{ fn: exportCommissionBillCsv, name: 'CommissionBill', needsCfg: true,
                        ext: 'csv', mime: 'text/csv; charset=utf-8' },
  collection:         { fn: exportCollection,        name: 'Collection' },
  trade_report:       { fn: exportTradeReport,       name: 'AuctionReport' },
  dealer_list:        { fn: exportDealerList,        name: 'DealerList' },
  dealer_list_party_wise:   { fn: exportDealerListPartyWise,   name: 'DealerListPartyWise' },
  pooler_list_consolidated: { fn: exportPoolerListConsolidated, name: 'PoolerListConsolidated' },
  planter_list:       { fn: exportPlanterList,       name: 'PlanterList' },
  sales_taxes:        { fn: exportSalesTaxes,        name: 'SalesTaxes' },
  // Emits CSV text directly (ext/mime override the xlsx default). The generic
  // route sees ext:'csv' and skips the workbook→CSV conversion, so ?format=csv
  // and no format at all both serve the same bytes.
  dealer_invoice_csv: { fn: exportDealerInvoiceCsv,  name: 'DealerInvoice',     needsCfg: true,
                        ext: 'csv', mime: 'text/csv; charset=utf-8' },
  // Disbursement Register — dealer side. Needs cfg for the trader-sample kg
  // that splits SAMP out of the stored refund. Has a PDF twin (same rows, see
  // exports-pdf.js), so ?format=pdf on this type works too.
  dealer_disbursement:{ fn: exportDealerDisbursement, name: 'DealerDisbursement', needsCfg: true },
  // Disbursement register — one row per planter lot, in the customer's
  // supplied layout. needsCfg: the two sample columns are cut from
  // sb_refund / sb_trader_sample.
  planter_disbursement:{ fn: exportPlanterDisbursement, name: 'PlanterDisbursement', needsCfg: true },
  payment:            { fn: exportPaymentSummary,    name: 'Payment',           needsCfg: true },
  payment_party_wise: { fn: exportPaymentPartyWise,  name: 'PaymentPartyWise',  needsCfg: true },
  tally_purchase:     { fn: exportTallyPurchase,     name: 'TallyPurchase',     needsCfg: true },
};

// ── COMMISSION BILL CSV ──────────────────────────────────────────────
// One row per LOT, in the 22-column layout the customer supplied. Not an
// XLSX-turned-CSV: the column set is bespoke, so this writes CSV directly.
//
// ── Where the numbers come from ────────────────────────────────────
// Every figure is READ from the lot, not recomputed. calculateLot() has
// already written com / sertax / cgst / sgst / igst when the operator ran
// Calculate, and those same stored values are what the commission bill PDF
// and the Tally vouchers render. Deriving them a second time here would let
// this file disagree with the documents it is supposed to describe.
//
// The reference layout decomposes the app's own formula rather than using a
// different one. calculateLot computes:
//     refund     = sb_refund kg x rate
//     commission = (amount + refund) x commission%
// and the layout splits `refund` into its two constituent parts:
//     SAMPLE KG        = sb_refund + sb_trader_sample
//     TRADER SAMPLE KG = sb_trader_sample
// so that (SAMPLE PRICE - TRADER SAMPLE PRICE) == refund exactly. That
// identity is what makes COMMISSION reconcile against the printed bill;
// tests/commission-bill-csv.unit.js pins it.
//
// ── Precision ──────────────────────────────────────────────────────
// The layout carries ONE decimal on the money columns while the lot stores
// two. Rounding the stored 2dp value to 1dp reproduces the reference
// exactly — verified against the supplied sample — so the presentation is
// narrowed here and nowhere else. TOTAL is a whole number; ROUND OFF is the
// difference, and is the only column computed rather than read.
const CBC_COLUMNS = [
  'ANO', 'DATE', 'INVOICE NO', 'QUANTITY KG', 'RATE', 'CARDAMOM_VALUE',
  'PLANTER NAME', 'CR/GST', 'PLANTER/TRADER', 'SAMPLE KG', 'SAMPLE PRICE',
  'TRADER SAMPLE KG', 'TRADER SAMPLE PRICE', 'COMMISSION', 'INCL. CHARGES',
  'IGST', 'CGST', 'SGST', 'ROUND OFF', 'TOTAL', 'STATE', 'STATECODE',
];

// RFC-4180 quoting: only when the value needs it, so the common case stays
// readable in a text editor.
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function exportCommissionBillCsv(db, auctionId, cfg, _state, _extra) {
  cfg = cfg || {};
  const auction = db.get('SELECT ano, date FROM auctions WHERE id = ?', [auctionId]) || {};
  const lots = db.all(
    `SELECT * FROM lots WHERE auction_id = ? ORDER BY CAST(lot_no AS INTEGER), lot_no`,
    [auctionId]);

  // Commission-bill number per lot. Bills are keyed by lot_no when the trade
  // was raised lot-wise (flag_lotwise_bills) and by seller name when it was
  // raised seller-wise, so build both lookups and prefer the more specific.
  // A lot with no bill yet leaves the column blank rather than inventing a
  // number.
  const bills = db.all('SELECT bil, name, lot_no FROM bills WHERE ano = ?', [String(auction.ano || '')]);
  const billByLot = new Map(), billByName = new Map();
  for (const b of bills) {
    const no = b.bil == null || b.bil === '' ? '' : String(b.bil);
    if (!no) continue;
    const lotKey = String(b.lot_no || '').trim();
    if (lotKey) billByLot.set(lotKey, no);
    else billByName.set(String(b.name || '').trim().toUpperCase(), no);
  }

  const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  // The two sample weights. sb_refund is their DIFFERENCE (it is what the
  // commission is actually computed on), so the planter's sample is the sum.
  const traderSampleKg = Number(cfg.sb_trader_sample) || 0;
  const sampleKg       = r2((Number(cfg.sb_refund) || 0) + traderSampleKg);
  const stateCodeFor = (name) => {
    const s = String(name || '').trim().toUpperCase();
    if (s === 'KERALA') return '32';
    if (s === 'TAMIL NADU' || s === 'TAMILNADU') return '33';
    // Fall back to the configured Tally state code rather than guessing.
    return String(cfg.tally_state_code || '');
  };
  // d/m/yy, as in the supplied sample.
  const dmy = (iso) => {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso || '');
    return `${Number(m[3])}/${Number(m[2])}/${m[1].slice(2)}`;
  };

  const rows = [CBC_COLUMNS.join(',')];
  for (const l of lots) {
    const rate   = Number(l.price)  || 0;
    const value  = Number(l.amount) || 0;
    const sp     = r1(sampleKg * rate);
    const tsp    = r1(traderSampleKg * rate);
    const com    = r1(l.com);
    const charge = r1(l.sertax);
    const igst   = r1(l.igst);
    const cgst   = r1(l.cgst);
    const sgst   = r1(l.sgst);
    // Net payable to the seller: the cardamom plus the sample they are
    // credited for, less the trader's sample and everything the auctioneer
    // deducts (commission, handling, and the GST charged on both).
    const net    = value + sp - tsp - com - charge - igst - cgst - sgst;
    const total  = Math.round(net);
    const lotKey = String(l.lot_no || '').trim();
    rows.push([
      auction.ano == null ? '' : auction.ano,
      dmy(auction.date),
      billByLot.get(lotKey) || billByName.get(String(l.name || '').trim().toUpperCase()) || '',
      r2(l.qty), rate, r2(value),
      l.name || '', l.cr || '',
      // T when the seller carries a real GSTIN, P otherwise — the same
      // planter/dealer split hasValidGstin() makes everywhere else.
      gstinStateCode(l.cr) ? 'T' : 'P',
      sampleKg, sp, traderSampleKg, tsp,
      com, charge, igst, cgst, sgst,
      r2(total - net), total,
      l.pstate || l.state || '',
      l.pst_code || stateCodeFor(l.pstate || l.state),
    ].map(csvCell).join(','));
  }
  // BOM so Excel opens the file as UTF-8 rather than mangling seller names.
  return Buffer.from('﻿' + rows.join('\r\n') + '\r\n', 'utf8');
}

// ── PLANTER DISBURSEMENT REGISTER ────────────────────────────────────
// BILL | NAME | LOT | COMMN | SAMP | CGST | SGST | IGST | INCL | REFUND |
// SALE COST | BALANCE — one row per PLANTER lot, closed by a totals strip.
// The office's record of what goes out to the planters for a trade, in the
// customer-supplied layout.
//
// ── Who is on it ───────────────────────────────────────────────────
// Planters only: `NOT hasValidGstin(cr)`, the same GSTIN-only rule that
// decides who gets a commission bill rather than a dealer debit note (see
// listAgriSellers). Priced lots only — a withdrawn or unpriced lot has no
// disbursement to register — and reserved lots are excluded, as everywhere
// else. Lot-number order, which is the order the bill numbers run in.
//
// ── Where the numbers come from ────────────────────────────────────
// Every figure is READ from the lot, never recomputed: calculateLot has
// already written com / sertax / cgst / sgst / igst, and those same stored
// values are what the commission bill PDF and the Tally vouchers print.
// Deriving them again here would let this register disagree with the
// documents it is the record of.
//
// The two sample columns decompose `lots.refund` exactly as the Commission
// Bill CSV does (see CBC_COLUMNS above), because the reference sheet does:
//
//     REFUND = (sb_refund + sb_trader_sample) x price    the planter's sample
//     SAMP   =  sb_trader_sample             x price    the trader's cut
//     REFUND - SAMP == lots.refund                      what the app credits
//
// so the register's own columns reconcile to the payable:
//
//     SALE COST + REFUND - SAMP - COMMN - INCL - CGST - SGST - IGST = BALANCE
//
// INCL is `lots.sertax`, the handling charge (cfg.hpc) — the CBC calls the
// same column "INCL. CHARGES".
//
// ── Precision ──────────────────────────────────────────────────────
// The money columns carry ONE decimal, matching the reference (COMMN 1,463.60
// for a stored 1,463.61) and the Commission Bill CSV's own narrowing. SALE
// COST keeps its two. BALANCE is whole rupees — that is what `lots.balance`
// holds and what the seller is actually settled in (see calculateLot), and
// rounding it here is what makes the column foot to the reference.
//
// Shared by the XLSX and the PDF (exports-pdf.js reads this same builder), so
// the two cannot list different lots or different figures.
function planterDisbursementRows(db, auctionId, cfg) {
  cfg = cfg || {};
  const { hasValidGstinSql } = require('./calculations');
  const auction = db.get('SELECT ano, date FROM auctions WHERE id = ?', [auctionId]) || {};
  const lots = db.all(
    `SELECT lot_no, name, price, amount, com, sertax, cgst, sgst, igst, balance
       FROM lots
      WHERE auction_id = ? AND amount > 0 AND COALESCE(reserved,0) = 0
        AND NOT ${hasValidGstinSql('cr')}
      ORDER BY CAST(lot_no AS INTEGER), lot_no`, [auctionId]) || [];

  // Commission-bill number per lot — the same lookup the Commission Bill CSV
  // uses. Bills are keyed by lot_no when the trade was raised lot-wise
  // (flag_lotwise_bills) and by seller name when it was raised seller-wise, so
  // both lookups are built and the more specific wins. A lot with no bill yet
  // leaves the column blank rather than inventing a number; in seller-wise
  // mode one number legitimately repeats down a seller's lots.
  const bills = db.all('SELECT bil, name, lot_no FROM bills WHERE ano = ?',
                       [String(auction.ano || '')]) || [];
  const billByLot = new Map(), billByName = new Map();
  for (const b of bills) {
    const no = b.bil == null || b.bil === '' ? '' : String(b.bil);
    if (!no) continue;
    const lotKey = String(b.lot_no || '').trim();
    if (lotKey) billByLot.set(lotKey, no);
    else billByName.set(String(b.name || '').trim().toUpperCase(), no);
  }

  const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const traderSampleKg = Number(cfg.sb_trader_sample) || 0;
  const sampleKg       = r2((Number(cfg.sb_refund) || 0) + traderSampleKg);

  return lots.map(l => {
    const rate   = Number(l.price) || 0;
    const lotKey = String(l.lot_no || '').trim();
    return {
      bill: billByLot.get(lotKey)
            || billByName.get(String(l.name || '').trim().toUpperCase()) || '',
      name: l.name || '',
      lot:  l.lot_no,
      commn:  r1(l.com),
      samp:   r1(traderSampleKg * rate),
      cgst:   r1(l.cgst),
      sgst:   r1(l.sgst),
      igst:   r1(l.igst),
      incl:   r1(l.sertax),
      refund: r1(sampleKg * rate),
      cost:   r2(l.amount),
      // Whole rupees — the figure the seller is actually paid.
      balance: Math.round(Number(l.balance) || 0),
    };
  });
}

// Column set, shared with the PDF twin so the two carry the same headers in
// the same order. Money columns get an explicit numFmt: 'COMMN' / 'SAMP' /
// 'INCL' / 'SALE COST' are not names xlsxNumFmtForHeader knows, and without
// one they would land as unformatted, left-aligned cells.
const PLANTER_DISB_COLS = [
  { header: 'BILL',      key: 'bill',    width: 10 },
  { header: 'NAME',      key: 'name',    width: 28 },
  { header: 'LOT',       key: 'lot',     width: 8  },
  { header: 'COMMN',     key: 'commn',   width: 13, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'SAMP',      key: 'samp',    width: 11, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'CGST',      key: 'cgst',    width: 12, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'SGST',      key: 'sgst',    width: 12, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'IGST',      key: 'igst',    width: 11, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'INCL',      key: 'incl',    width: 11, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'REFUND',    key: 'refund',  width: 13, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'SALE COST', key: 'cost',    width: 16, numFmt: '#,##,##0.00', align: 'right' },
  { header: 'BALANCE',   key: 'balance', width: 16, numFmt: '#,##,##0.00', align: 'right' },
];
// The columns the totals strip foots. BILL / NAME / LOT are identifiers, so
// nothing is summed there.
const PLANTER_DISB_TOTAL_KEYS =
  ['commn', 'samp', 'cgst', 'sgst', 'igst', 'incl', 'refund', 'cost', 'balance'];

async function exportPlanterDisbursement(db, auctionId, cfg) {
  const rows = planterDisbursementRows(db, auctionId, cfg);
  const total = {};
  for (const k of PLANTER_DISB_TOTAL_KEYS) {
    total[k] = Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
  }
  return createExcelBuffer('PlanterDisbursement', PLANTER_DISB_COLS, rows, {
    db, title: 'Disbursement Register', metaLines: auctionMeta(db, auctionId),
    // The label goes in NAME, not in the `label` option: that one drops the
    // word in the first non-numeric column, which here is the 3-character BILL.
    grandTotal: { values: { name: 'TOTAL', ...total } },
  });
}

// ── DISBURSEMENT REGISTER — DEALER ───────────────────────────────────
// The dealer half of the register above: one row per lot belonging to a
// REGISTERED seller, showing what the lot sold for and what the dealer is
// left with after commission and tax. Same twelve columns, same order, same
// meaning — planters and dealers are the two complementary halves of the
// trade, and the office reads the two sheets side by side.
//
// Dealer = hasValidGstinSql, `cr` holding a full 15-char GSTIN — the exact
// complement of the planter builder's NOT, so between them the two registers
// cover every priced lot in the trade once and only once. This is a payments
// surface, so it takes that ordinary rule rather than the GSTIN+SBL rule kept
// for the Dashboard / Lot Entry / e-Auction CSV.
//
// ── Where the numbers come from ────────────────────────────────────
// Identical to the planter builder — see its note. Every figure is READ off
// the lot, the two sample columns decompose `lots.refund` the same way, INCL
// is `lots.sertax`, and BALANCE is the stored whole-rupee payable, so:
//
//     SALE COST + REFUND - SAMP - COMMN - INCL - CGST - SGST - IGST = BALANCE
//
// ── BILL ───────────────────────────────────────────────────────────
// The dealer's debit note ("Tax Invoice On Commission") for the trade, which
// is the dealer-side counterpart of the planter's commission bill.
//
// `debit_notes` carries no lot_no — per-lot dealer notes are not built yet
// (the planter table has them, this one does not) — so ONE note covers all of
// a dealer's lots and its number legitimately repeats down that dealer's
// rows. Resolved by trader_id first, falling back to name only when the note
// predates trader linking: two sellers can share a name, and matching on it
// alone would put one dealer's note number on another's lot.
//
// ── Precision ──────────────────────────────────────────────────────
// The money columns keep TWO decimals — the exact stored figures — where the
// planter register narrows to one. These are the values the debit note, the
// Tally voucher and the bank file already carry, so the register reconciles
// against the documents rather than against the legacy sheet's 10-paise
// rounding. BALANCE is whole rupees either way, so the two registers still
// foot to the same payable.
function dealerDisbursementRows(db, auctionId, cfg) {
  cfg = cfg || {};
  const { hasValidGstinSql } = require('./calculations');
  const auction = db.get('SELECT id, ano FROM auctions WHERE id = ?', [auctionId]) || {};
  const lots = db.all(
    `SELECT lot_no, name, trader_id, price, amount, com, sertax, cgst, sgst, igst, balance
       FROM lots
      WHERE auction_id = ? AND amount > 0 AND COALESCE(reserved,0) = 0
        AND ${hasValidGstinSql('cr')}
      ORDER BY CAST(lot_no AS INTEGER), lot_no`, [auctionId]) || [];

  // Matched on auction_id OR ano: debit_notes gained auction_id in a later
  // migration, so notes raised before it key off the trade number alone (the
  // same pattern the Dealer Invoice CSV uses). Ordered by note number so that
  // when a dealer somehow holds two notes, the lower one is the first write
  // and therefore shows consistently on every one of their rows.
  const notes = db.all(
    `SELECT note_no, name, trader_id FROM debit_notes
      WHERE (auction_id = ? OR ano = ?)
      ORDER BY CAST(note_no AS INTEGER), note_no`,
    [auction.id, String(auction.ano || '')]) || [];
  const noteByTrader = new Map(), noteByName = new Map();
  for (const n of notes) {
    const no = String(n.note_no == null ? '' : n.note_no).trim();
    if (!no) continue;
    if (n.trader_id != null && !noteByTrader.has(n.trader_id)) noteByTrader.set(n.trader_id, no);
    const k = String(n.name || '').trim().toUpperCase();
    if (k && !noteByName.has(k)) noteByName.set(k, no);
  }

  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const traderSampleKg = Number(cfg.sb_trader_sample) || 0;
  const sampleKg       = r2((Number(cfg.sb_refund) || 0) + traderSampleKg);

  return lots.map(l => {
    const rate = Number(l.price) || 0;
    return {
      // Blank when the note has not been generated — the lot and its balance
      // still belong in the register, so an ungenerated note must not drop it.
      bill: (l.trader_id != null && noteByTrader.get(l.trader_id))
            || noteByName.get(String(l.name || '').trim().toUpperCase()) || '',
      name: l.name || '',
      lot:  l.lot_no,
      commn:  r2(l.com),
      samp:   r2(traderSampleKg * rate),
      cgst:   r2(l.cgst),
      sgst:   r2(l.sgst),
      igst:   r2(l.igst),
      incl:   r2(l.sertax),
      refund: r2(sampleKg * rate),
      cost:   r2(l.amount),
      // Whole rupees — the figure the dealer is actually paid.
      balance: Math.round(Number(l.balance) || 0),
    };
  });
}

// Same twelve columns as the planter register — reused rather than restated
// so the two sheets can never drift apart in header text, order or format.
const DEALER_DISB_COLS       = PLANTER_DISB_COLS;
const DEALER_DISB_TOTAL_KEYS = PLANTER_DISB_TOTAL_KEYS;

async function exportDealerDisbursement(db, auctionId, cfg) {
  const rows = dealerDisbursementRows(db, auctionId, cfg);
  const total = {};
  for (const k of DEALER_DISB_TOTAL_KEYS) {
    total[k] = Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
  }
  return createExcelBuffer('DealerDisbursement', DEALER_DISB_COLS, rows, {
    db, title: 'Disbursement Register', metaLines: auctionMeta(db, auctionId),
    grandTotal: { label: 'TOTAL', values: total },
  });
}

// ── XLSX → CSV ───────────────────────────────────────────────────────
// Every export here builds its workbook through createExcelBuffer, which
// makes exactly ONE worksheet. That is what makes this conversion safe: a
// CSV can only ever represent one sheet, so re-reading the workbook and
// writing its single sheet loses nothing.
//
// Re-parsing the buffer rather than teaching each export to emit both
// formats is deliberate — there are 40-odd of them, and a second output
// path per export is 40 chances for the CSV to drift from the XLSX. This
// way the two are the same data by construction.
//
// Note the CSV carries the brand band (the company header rows written
// above the column headers) exactly as the spreadsheet does — it is a
// faithful conversion, not a re-shaped data dump.
//
// Throws on a workbook with more than one sheet rather than silently
// serving the first: that would be quiet data loss, and no current export
// produces one.
async function xlsxToCsvBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  if (wb.worksheets.length === 0) throw new Error('Workbook has no worksheet to convert to CSV');
  if (wb.worksheets.length > 1) {
    throw new Error(`Cannot convert a ${wb.worksheets.length}-sheet workbook to CSV — `
                  + `download the XLSX instead`);
  }
  return await wb.csv.writeBuffer({ sheetName: wb.worksheets[0].name });
}

// ── CSV → XLSX ───────────────────────────────────────────────────────
// The mirror of xlsxToCsvBuffer, for the two exports that write CSV text
// DIRECTLY (Commission Bill, Dealer Invoice). Their column sets are bespoke
// data feeds, so they never build a workbook — which left them the only
// members of the Auction Downloads screen that could not be served as a
// spreadsheet.
//
// Re-parsing the CSV rather than teaching those two exports to also emit
// XLSX is the same trade xlsxToCsvBuffer makes in the other direction: one
// builder, one source of truth, no chance of the two renderings disagreeing
// about a figure.
//
// Deliberately NOT routed through createExcelBuffer: these feeds carry their
// own fixed header row, and the brand band that builder writes above the
// columns would shift every row and break the layout the office's books read.
// What this adds is only what a spreadsheet needs to be usable — a bold,
// frozen header row, real numbers in the money columns, and fitted widths.

// RFC-4180 reader. Handles quoted fields, embedded commas/quotes/newlines,
// and both CRLF and LF line endings. Returns an array of string arrays.
function parseCsvText(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') { if (text[i + 1] === '\n') i++; rows.push(row.concat(field)); row = []; field = ''; continue; }
    if (c === '\n') { rows.push(row.concat(field)); row = []; field = ''; continue; }
    field += c;
  }
  // A trailing newline leaves an empty pending row — don't emit it.
  if (field !== '' || row.length) rows.push(row.concat(field));
  return rows;
}

// Numbers must land as numbers or the sheet won't sum, but over-eager
// coercion is worse than none: a lot number "007", a 15-digit phone or a
// GSTIN turned into a float is silent data loss. So only plain decimals of
// sane length, with no leading zero padding, become numeric.
function csvCellValue(s) {
  if (s === '') return null;
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return s;
  if (s.replace(/[-.]/g, '').length > 12) return s;
  return Number(s);
}

async function csvToXlsxBuffer(buffer, sheetName) {
  // Strip the UTF-8 BOM the CSV exports write for Excel's benefit — it would
  // otherwise become part of the first header cell's text.
  const text = Buffer.from(buffer).toString('utf8').replace(/^﻿/, '');
  const rows = parseCsvText(text);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(sheetName || 'Sheet1').slice(0, 31));
  rows.forEach((r, i) => {
    const cells = r.map(csvCellValue);
    const added = ws.addRow(cells);
    if (i === 0) added.font = { bold: true };
  });
  if (rows.length) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    autofitColumns(ws);
  }
  return await wb.xlsx.writeBuffer();
}

module.exports = {
  EXPORT_TYPES,
  xlsxToCsvBuffer,
  csvToXlsxBuffer,
  exportCommissionBillCsv, CBC_COLUMNS,
  // Reusable XLSX builder — exposed so other modules (lorry-reports.js etc.)
  // can route through the same standardized brand band + column-header
  // styling instead of building their own ExcelJS workbook.
  createExcelBuffer,
  exportLotSlip, exportLotSlipAfter, exportLotBuyer, exportLotName, exportLotPayment,
  exportChecklist, exportLotVerification, exportLotVerification2,
  // Shared with the PDF twins for the same reason as the Disbursement
  // Registers below — one deal of the lots, one buyer-code rule, two renderings.
  lotVerificationData,  LOT_VERIF_COLS,  LOT_VERIF_TOTAL_KEYS,
  lotVerification2Data, LOT_VERIF2_COLS, LOT_VERIF2_TOTAL_KEYS,
  // Exported for the same reason as tharaiListData below: the PDF renderer must
  // apply the operator's column switches through the exact rule the spreadsheet
  // uses, not a second copy of it.
  checklistVisibleCols, checklistColumnsOn, CHECKLIST_COLS,
  // tharaiListData is exported so the PDF renderer builds from the SAME
  // grouping, split and ordering the spreadsheet does — the two must never
  // disagree about who took how many bags.
  exportTharaiList, tharaiListData,
  exportPriceList, exportPriceListBefore,
  exportBankPayment, exportBankPaymentBefore, exportBankPaymentAdvance,
  exportPoolerRegister, exportFullFile, exportCollection, exportTradeReport, exportDealerList,
  exportDealerListPartyWise, exportPoolerListConsolidated,
  exportPlanterList,
  exportSalesTaxes, exportPaymentSummary, exportPaymentPartyWise, exportTDSReturn, exportTallyPurchase,
  exportSalesJournal, exportPurchaseJournal,
  // Shared with the PDF twin — one column spec, two renderings.
  SALES_JOURNAL_COLS, SALES_JOURNAL_TOTAL_KEYS,
  exportPurchaseRegister, exportSalesRegister, exportIndividualRegister,
  exportSellersXlsx, exportBuyersXlsx,
  exportDealerInvoiceCsv,
  // Shared with the PDF twin (exports-pdf.js) so the two renderings cannot
  // list different lots, columns or figures.
  exportPlanterDisbursement, planterDisbursementRows,
  PLANTER_DISB_COLS, PLANTER_DISB_TOTAL_KEYS,
  exportDealerDisbursement, dealerDisbursementRows,
  DEALER_DISB_COLS, DEALER_DISB_TOTAL_KEYS,
};
