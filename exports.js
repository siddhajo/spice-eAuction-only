/**
 * exports.js — All export formats
 * Replaces: EXP.PRG (11 types), TALY.PRG, KOTALLY.PRG, BANKPAY export
 */

const ExcelJS = require('exceljs');
const { collectionXlsx: newCollectionXlsx, tradeReportXlsx } = require('./auction-reports');
const {
  getCompanyHeader,
  writeXlsxCompanyHeader, xlsxNumFmtForHeader,
  formatDateForDisplay,
} = require('./report-formatters');
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
async function createExcelBuffer(sheetName, columns, rows, opts) {
  opts = opts || {};
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  // Apply column widths up front (the brand band uses these widths too).
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

  // Brand band: company name (row 1) + meta (row 2) + spacer (row 3).
  const header = opts.companyHeader || getCompanyHeader(opts.db);
  const startRow = writeXlsxCompanyHeader(wb, ws, header, {
    colCount: columns.length,
    metaLines: opts.metaLines || [],
  });

  // Column-header row — explicit per-cell alignment 'center' overrides
  // the column-level left/right cascade.
  const headerRow = ws.getRow(startRow);
  columns.forEach((c, i) => {
    headerRow.getCell(i + 1).value = c.header;
  });
  headerRow.font = { bold: true, size: 10 };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E4DD' } };
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
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
      const m = colMeta[ci - 1];
      if (m && m.fmt)   cell.numFmt = m.fmt;
      cell.alignment = { horizontal: (m && m.align) || 'left', vertical: 'middle' };
    });
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
  const rows = db.all(
    `SELECT lot_no AS lot, qty, price AS rate, amount AS cost,
            name AS seller_name, ppla AS place
       FROM lots WHERE auction_id = ?
       ORDER BY ppla, name, lot_no`, [auctionId]
  );
  const cols = [
    { header: 'LOT',         key: 'lot',         width: 8  },
    { header: 'QTY',         key: 'qty',         width: 12 },
    { header: 'RATE',        key: 'rate',        width: 10 },
    { header: 'COST',        key: 'cost',        width: 14 },
    { header: 'SELLER NAME', key: 'seller_name', width: 28 },
  ];
  // Split into sections by seller place so the XLSX shows
  // PAMPUPARA / BODI / etc. as inline section headers — mirrors
  // the PDF's grouping behaviour.
  const sections = [];
  let cur = null;
  rows.forEach(r => {
    const key = r.place || '(no place)';
    if (!cur || cur.title !== key) {
      cur = { title: key, rows: [] };
      sections.push(cur);
    }
    cur.rows.push(r);
  });
  return createExcelBuffer('LotPayment', cols, rows, {
    db, title: 'Lot Payment', metaLines: auctionMeta(db, auctionId),
    sections,
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

// ── Export Type 4: Bank Payment (RTGS/NEFT format) ───────────
async function exportBankPayment(db, auctionId, cfg, _state, extra) {
  const { getBankPaymentData } = require('./calculations');
  const sellers = (extra && extra.sellers) || null;
  // lots / excludeLots flow through to getBankPaymentData, which recomputes
  // each affected seller's payable over only the relevant lots (Payments-tab
  // tracked-export flow).
  const payments = getBankPaymentData(db, auctionId, cfg, {
    sellers,
    lots:        extra && extra.lots,
    excludeLots: extra && extra.excludeLots,
  });
  const cols = [
    { header: 'PAYSYS ID (RTGS/NEFT)',     key: 'transactionType', width: 18 },
    { header: 'DEBIT ACCOUNT',             key: 'debitAccount',    width: 20 },
    { header: 'TRAN AMOUNT',               key: 'amount',          width: 14 },
    { header: 'BENEFICIARY ACCOUNT',       key: 'accountNo',       width: 20 },
    { header: 'BENEFICIARY ACCOUNT TYPE',  key: 'accountType',     width: 16 },
    { header: 'BENEFICIARY NAME',          key: 'beneficiaryName', width: 30 },
    { header: 'BENEFICIARY ADD1',          key: 'address1',        width: 30 },
    { header: 'BENEFICIARY ADD2',          key: 'address2',        width: 20 },
    { header: 'BENEFICIARY IFSC',          key: 'ifsc',            width: 14 },
    { header: 'SENDER TO RECEIVER INFO',   key: 'remarks',         width: 50 },
  ];
  return createExcelBuffer('BankPayment', cols, payments, {
    db, title: 'Bank Payment (RTGS/NEFT)', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export Type 4b: Bank Payment (Before discount) ───────────
// Same data shape as bank_payment except `amount` is the pre-discount
// puramt (raw purchase amount before refund/GST). Per the e-Auction spec
// the Amount + SendertoRcvrInfo columns are omitted from this variant.
async function exportBankPaymentBefore(db, auctionId, cfg, _state, extra) {
  const { getBankPaymentData } = require('./calculations');
  const sellers = (extra && extra.sellers) || null;
  const payments = getBankPaymentData(db, auctionId, cfg, {
    before: true, sellers,
    lots:        extra && extra.lots,
    excludeLots: extra && extra.excludeLots,
  });
  const cols = [
    { header: 'TransactionType', key: 'transactionType', width: 16 },
    { header: 'BeneIFSCode',     key: 'ifsc',            width: 14 },
    { header: 'BeneAcctNo',      key: 'accountNo',       width: 20 },
    { header: 'BeneName',        key: 'beneficiaryName', width: 30 },
    { header: 'BeneAddLine1',    key: 'address1',        width: 30 },
    { header: 'BeneAddLine2',    key: 'address2',        width: 20 },
    { header: 'BeneAddLine3',    key: 'pin',             width: 10 },
  ];
  return createExcelBuffer('BankPaymentBefore', cols, payments, {
    db, title: 'Bank Payment (Before)', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export Type 5: Pooler-wise Register ───────────────────────
async function exportPoolerRegister(db, auctionId) {
  // PQTY / PRATE / PURAMT dropped: those are post-purchase columns the
  // Pooler Register doesn't need — they belong on bills, not the
  // per-lot pooler ledger.
  const rows = db.all(
    `SELECT state, lot_no as lot, name as poolername, branch as br, qty, price, amount
     FROM lots WHERE auction_id = ? AND amount > 0
     ORDER BY name`, [auctionId]
  );
  const cols = [
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'NAME', key: 'poolername', width: 30 },
    { header: 'BRANCH', key: 'br', width: 15 },
    { header: 'LOT', key: 'lot', width: 8 },
    { header: 'QTY', key: 'qty', width: 12 },
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
  const rows = db.all(
    `WITH cleaned AS (
       SELECT state, name, lot_no, bags, qty, sample_wt, amount,
              UPPER(TRIM(
                CASE
                  WHEN LOWER(SUBSTR(TRIM(cr),1,5)) = 'gstin'
                    THEN LTRIM(SUBSTR(TRIM(cr),6), '. :-')
                  ELSE TRIM(cr)
                END
              )) AS gstin
         FROM lots
        WHERE auction_id = ? AND amount > 0
     )
     SELECT state, name, gstin,
            COUNT(lot_no) as lots, SUM(bags) as bags, SUM(qty) as qty,
            SUM(sample_wt) as sample_wt,
            (SUM(qty) + SUM(sample_wt)) as gross_wt
       FROM cleaned
      WHERE LENGTH(gstin) = 15
      GROUP BY state, name, gstin
      ORDER BY state, name`, [auctionId]
  );
  const cols = [
    { header: 'STATE', key: 'state', width: 12 },
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'LOTS', key: 'lots', width: 6 },
    { header: 'BAGS', key: 'bags', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 },
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
  const cols = [
    { header: 'NAME', key: 'name', width: 30 },
    { header: 'CR',   key: 'cr',   width: 25 },
    { header: 'LOTS', key: 'lots', width: 6 },
    { header: 'BAGS', key: 'bags', width: 6 },
    { header: 'QTY',  key: 'qty',  width: 12 },
  ];
  return createExcelBuffer('PlanterList', cols, rows, {
    db, title: 'Planter List (Grade 1)', metaLines: auctionMeta(db, auctionId),
  });
}

// ── Export Type 9: Sales & Taxes ─────────────────────────────
async function exportSalesTaxes(db, auctionId) {
  const rows = db.all(
    `SELECT state, sale, invo, buyer1 as tradername, bags as bag, qty, 
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
  // Payable = per-lot net (lots.balance), with no debit-note subtraction.
  // The displayed column shows COMMISSION (lots.com), not discount — per the
  // Payments-tab change.
  const enriched = rows.map(r => ({
    ...r,
    commission: Number(r.commission) || 0,
    payable: Number(r.payable) || 0,
  }));
  const cols = [
    { header: 'POOLERNAME', key: 'poolername', width: 30 },
    { header: 'LOT', key: 'lot', width: 8 }, { header: 'BAG', key: 'bag', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 }, { header: 'PRICE', key: 'price', width: 10 },
    { header: 'AMOUNT', key: 'amount', width: 14 },
    { header: 'COMMISSION', key: 'commission', width: 14 },
    { header: 'PAYABLE', key: 'payable', width: 14 },
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
    discount:   Number(r.seller_discount) || 0,
    payable:    Number(r.total_payable) || 0,
  }));
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
    { header: 'DISCOUNT', key: 'discount', width: 12 },
    { header: 'PAYABLE', key: 'payable', width: 14 },
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
      discount:   sum('discount'),
      payable:    sum('payable'),
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
    `SELECT name, padd as add, ppla as place, cr as gstin, tel,
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
async function exportSalesJournal(db, auctionId, saleType) {
  const { getSalesJournal } = require('./calculations');
  const rows = getSalesJournal(db, auctionId, saleType);
  const cols = [
    { header: 'DATE', key: 'date', width: 12 },
    { header: 'SALE', key: 'sale', width: 6 },
    { header: 'INV#', key: 'invo', width: 8 },
    { header: 'BUYER', key: 'buyer', width: 8 },
    { header: 'TRADE NAME', key: 'buyer1', width: 30 },
    { header: 'GSTIN', key: 'gstin', width: 20 },
    { header: 'PLACE', key: 'place', width: 15 },
    { header: 'BAGS', key: 'bag', width: 6 },
    { header: 'QTY', key: 'qty', width: 12 },
    { header: 'CARDAMOM', key: 'cardamom', width: 14 },
    { header: 'GUNNY', key: 'gunny', width: 10 },
    { header: 'TRANSPORT', key: 'transport', width: 10 },
    { header: 'INSURANCE', key: 'insurance', width: 10 },
    { header: 'CGST', key: 'cgst', width: 10 },
    { header: 'SGST', key: 'sgst', width: 10 },
    { header: 'IGST', key: 'igst', width: 10 },
    { header: 'TCS', key: 'tcs', width: 10 },
    { header: 'ROUND', key: 'rund', width: 8 },
    { header: 'TOTAL', key: 'total', width: 14 },
  ];
  return createExcelBuffer('SalesJournal', cols, rows, {
    db, title: 'Sales Journal',
    metaLines: [...auctionMeta(db, auctionId), saleType ? `Type: ${saleType}` : ''].filter(Boolean),
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
      { header: 'TNO',    key: 'tno',    width: 8  },
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
    title: p.name + (p.gstin ? `      GSTIN: ${p.gstin}` : ''),
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
    `SELECT l.lot_no, l.branch, l.grade, l.name, l.cr, l.qty, l.litre, l.bags, l.tel,
            t.cr AS trader_cr, t.tel AS trader_tel
       FROM lots l
       LEFT JOIN traders t ON UPPER(TRIM(t.name)) = UPPER(TRIM(l.name))
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

  // Escape a CSV field: wrap in quotes if it contains comma/quote/newline,
  // and double-up any embedded quotes. Undefined/null → empty.
  const csvEscape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };

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

  // Praman classifies sellers as 1=Planter (URD/agriculturist) or
  // 2=Dealer (registered, with GSTIN). Per-lot decision based on
  // whether the seller has a GSTIN attached.
  const classify = (gstin) => (gstin && gstin.length >= 15) ? 2 : 1;

  const lines = [header.join(',')];
  for (const r of rows) {
    // Per-lot planter: name from lots.name, GSTIN from trader's `cr`
    // (preferred — master data) with the lot's own `cr` as a fallback
    // when traders join misses.
    const planterName   = (r.name || '').trim();
    const planterGstin  = stripGstinPrefix(r.trader_cr || r.cr);
    const planterMobile = (r.trader_tel || r.tel || '').trim();
    const planterDealer = classify(planterGstin);

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
  // praman_csv removed in this build (e-Auction(Praman) export disabled).
  price_list:         { fn: exportPriceList,         name: 'PriceList' },
  price_list_before:  { fn: exportPriceListBefore,   name: 'PriceListBefore' },
  bank_payment_before:{ fn: exportBankPaymentBefore, name: 'BankPaymentBefore', needsCfg: true },
  bank_payment:       { fn: exportBankPayment,       name: 'BankPayment',       needsCfg: true },
  pooler_register:    { fn: exportPoolerRegister,    name: 'PoolerRegister' },
  full_file:          { fn: exportFullFile,          name: 'FullFile' },
  collection:         { fn: exportCollection,        name: 'Collection' },
  trade_report:       { fn: exportTradeReport,       name: 'AuctionReport' },
  dealer_list:        { fn: exportDealerList,        name: 'DealerList' },
  planter_list:       { fn: exportPlanterList,       name: 'PlanterList' },
  sales_taxes:        { fn: exportSalesTaxes,        name: 'SalesTaxes' },
  payment:            { fn: exportPaymentSummary,    name: 'Payment',           needsCfg: true },
  payment_party_wise: { fn: exportPaymentPartyWise,  name: 'PaymentPartyWise',  needsCfg: true },
  tally_purchase:     { fn: exportTallyPurchase,     name: 'TallyPurchase',     needsCfg: true },
};

module.exports = {
  EXPORT_TYPES,
  // Reusable XLSX builder — exposed so other modules (lorry-reports.js etc.)
  // can route through the same standardized brand band + column-header
  // styling instead of building their own ExcelJS workbook.
  createExcelBuffer,
  exportLotSlip, exportLotSlipAfter, exportLotBuyer, exportLotName, exportLotPayment,
  exportPriceList, exportPriceListBefore,
  exportBankPayment, exportBankPaymentBefore,
  exportPoolerRegister, exportFullFile, exportCollection, exportTradeReport, exportDealerList,
  exportPlanterList,
  exportSalesTaxes, exportPaymentSummary, exportPaymentPartyWise, exportTDSReturn, exportTallyPurchase,
  exportSalesJournal, exportPurchaseJournal,
  exportPurchaseRegister, exportSalesRegister, exportIndividualRegister,
  exportSellersXlsx, exportBuyersXlsx,
};
