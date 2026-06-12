/**
 * spice-board-reports.js — Reports → Spice Board section
 *
 * Three statutory cardamom-auction reports:
 *   1. buyers_statement — per-buyer aggregate, grouped Inter/Intra state
 *      (mirrors the "BUYERS STATEMENT" sheet handed to the Spices Board)
 *   2. form_d           — Advance Auction Report (single-page summary +
 *      top-5 buyer panel) — Cardamom Marketing Rules, Rule 10(1)(1)
 *   3. form_c           — Auction Report (detailed lot listing split into
 *      PLANTERS / DEALERS sections) — Cardamom Marketing Rules, Rule 5(2)
 *
 * Data layer is shared via `getReportContext()` so each report pulls a
 * single normalized lot+buyer+trader+auction shape, with optional Branch
 * / Seller / Buyer / DateRange filters layered on top of the auction id.
 */

const ExcelJS    = require('exceljs');
const PDFDocument = require('pdfkit');
const {
  fmtMoney, fmtQty, fmtPrice,
  getCompanyHeader, writeXlsxCompanyHeader,
  formatDateForDisplay,
} = require('./report-formatters');

// ── Helpers ──────────────────────────────────────────────────
// Date rendering follows the operator's `date_format` Setting. The
// module-level _dateFormat is set per-report by _loadDateFormat(db) at
// the top of each entry point so the rest of the file keeps using
// parameter-less fmtDateDMY() calls.
let _dateFormat = 'dd/mm/yyyy';
function _loadDateFormat(db) {
  try { _dateFormat = require('./company-config').getSettingsFlat(db).date_format || 'dd/mm/yyyy'; }
  catch (_) { _dateFormat = 'dd/mm/yyyy'; }
}
function fmtDateDMY(iso) {
  return formatDateForDisplay(iso, _dateFormat);
}

// Word-aware wrap: returns an array of lines where each line fits within
// `maxWidth`. Falls back to character-level breaks for tokens longer than
// the column (e.g. GSTIN/SBL strings with no whitespace). Caller must have
// the desired font + fontSize set on `doc` so widthOfString is accurate.
//
// Used by data cells to allow long values (company names, full addresses,
// long licence ids) to flow onto a second line within the same cell rather
// than being truncated with "…" or overflowing into adjacent columns.
function wrapText(doc, text, maxWidth) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return [''];
  if (doc.widthOfString(s) <= maxWidth) return [s];
  const out = [];
  const tokens = s.split(/\s+/);
  let cur = '';
  function pushChunked(tok) {
    // Token wider than the column on its own — break by characters.
    // Avoid leaving a single trailing character on its own line:
    // when only one char would remain, steal one from the previous
    // chunk so the tail line carries at least two characters.
    let chunk = '';
    const chunks = [];
    for (const ch of tok) {
      if (doc.widthOfString(chunk + ch) <= maxWidth) chunk += ch;
      else {
        if (chunk) chunks.push(chunk);
        chunk = ch;
      }
    }
    if (chunk) chunks.push(chunk);
    // Anti-orphan: if the last chunk is a single character, borrow one
    // from the previous chunk so both lines have ≥ 2 chars. Skipped when
    // the previous chunk is itself only 2 chars (would create another
    // 1-char orphan).
    if (chunks.length >= 2 && chunks[chunks.length - 1].length === 1 && chunks[chunks.length - 2].length > 2) {
      const prev = chunks[chunks.length - 2];
      const tail = chunks[chunks.length - 1];
      chunks[chunks.length - 2] = prev.slice(0, -1);
      chunks[chunks.length - 1] = prev.slice(-1) + tail;
    }
    for (let i = 0; i < chunks.length - 1; i++) out.push(chunks[i]);
    cur = chunks.length ? chunks[chunks.length - 1] : '';
  }
  for (const tok of tokens) {
    const probe = cur ? cur + ' ' + tok : tok;
    if (doc.widthOfString(probe) <= maxWidth) { cur = probe; continue; }
    if (cur) { out.push(cur); cur = ''; }
    if (doc.widthOfString(tok) > maxWidth) { pushChunked(tok); }
    else { cur = tok; }
  }
  if (cur) out.push(cur);
  // Final anti-orphan pass at the word/space level: if the LAST line is
  // a single short token (1-2 chars) AND the preceding line has more
  // than one word, pull the last word of that preceding line down so
  // the final line isn't a stub.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.length <= 2 && /\s/.test(prev)) {
      const words = prev.split(/\s+/);
      if (words.length >= 2) {
        const moved = words.pop();
        const newPrev = words.join(' ');
        const newLast = moved + ' ' + last;
        if (doc.widthOfString(newPrev) <= maxWidth && doc.widthOfString(newLast) <= maxWidth) {
          out[out.length - 2] = newPrev;
          out[out.length - 1] = newLast;
        }
      }
    }
  }
  return out.length ? out : [''];
}

function readSetting(db, key, fallback) {
  try {
    const r = db.get('SELECT value FROM company_settings WHERE key = ?', [key]);
    return (r && r.value) ? String(r.value) : (fallback || '');
  } catch (_) { return fallback || ''; }
}

// Classify a seller as PLANTER or DEALER from the registration string. Spices
// Board "CR" prefixes (or empty) → planter; "CS" prefix → dealer.
function classifySeller(cr) {
  const s = String(cr || '').trim().toUpperCase();
  if (s.startsWith('CS')) return 'DEALER';
  return 'PLANTER';
}

// ── Centralized query layer ──────────────────────────────────
// Pulls every lot for the given auction (with buyer + trader joined) and
// applies optional filters. Every report is built off this single shape so
// aggregation logic is not duplicated.
function getReportContext(db, opts) {
  opts = opts || {};
  const auctionId = opts.auctionId ? parseInt(opts.auctionId, 10) : null;
  if (!auctionId) throw new Error('auctionId is required');

  const auction = db.get('SELECT id, ano, date, crop_type, state FROM auctions WHERE id = ?', [auctionId]);
  if (!auction) throw new Error('Auction not found');

  const where = ['l.auction_id = ?'];
  const params = [auctionId];
  if (opts.branch) { where.push('UPPER(TRIM(l.branch)) = UPPER(TRIM(?))'); params.push(opts.branch); }
  if (opts.sellerId) { where.push('l.trader_id = ?'); params.push(parseInt(opts.sellerId, 10)); }
  if (opts.buyerCode) { where.push('UPPER(TRIM(COALESCE(b.code,l.code))) = UPPER(TRIM(?))'); params.push(opts.buyerCode); }
  if (opts.dateFrom) { where.push('a.date >= ?'); params.push(opts.dateFrom); }
  if (opts.dateTo)   { where.push('a.date <= ?'); params.push(opts.dateTo); }

  const rows = db.all(`
    SELECT
      l.id              AS lot_id,
      l.lot_no          AS lot,
      l.bags            AS bags,
      l.qty             AS qty,
      l.price           AS price,
      l.reserved_price  AS reserved_price,
      l.amount          AS amount,
      l.refud           AS sample_refud,
      l.refund          AS sample_refund,
      l.com             AS commission,
      l.invo            AS invo,
      l.sale            AS lot_sale,
      l.branch          AS branch,
      l.code            AS lot_code,
      l.buyer           AS lot_buyer,
      l.buyer1          AS lot_buyer1,
      l.name            AS seller_name,
      l.padd            AS seller_addr,
      l.ppla            AS seller_place,
      l.pstate          AS seller_state,
      l.cr              AS seller_cr,
      l.tel             AS seller_tel,
      l.grade           AS grade,
      l.crpt            AS crpt,
      l.litre           AS litre,
      l.moisture        AS moisture,
      l.trader_id       AS trader_id,
      t.name            AS trader_name,
      t.cr              AS trader_cr,
      t.padd            AS trader_addr,
      t.ppla            AS trader_place,
      t.pstate          AS trader_state,
      COALESCE(b.code,    l.code,    '') AS buyer_code,
      COALESCE(b.buyer,   l.buyer,   '') AS buyer_full,
      COALESCE(b.buyer1,  l.buyer1,  '') AS buyer1,
      COALESCE(b.sbl,     '')        AS buyer_sbl,
      COALESCE(b.gstin,   '')        AS buyer_gstin,
      COALESCE(b.pla,     '')        AS buyer_place,
      COALESCE(b.state,   '')        AS buyer_state,
      COALESCE(b.sale,    l.sale,    'L') AS buyer_sale
    FROM lots l
    LEFT JOIN auctions a ON a.id = l.auction_id
    LEFT JOIN traders  t ON t.id = l.trader_id
    LEFT JOIN buyers   b
      ON UPPER(TRIM(b.code))  = UPPER(TRIM(l.code))
      OR UPPER(TRIM(b.buyer)) = UPPER(TRIM(l.buyer))
    WHERE ${where.join(' AND ')}
      AND l.amount > 0
    ORDER BY CAST(l.lot_no AS INTEGER), l.lot_no
  `, params);

  return { auction, rows, auctionState: String(auction.state || '').trim().toUpperCase() };
}

// Distinct branches/sellers/buyers seen in an auction — populates the
// filter dropdowns on the client.
function getReportFilters(db, auctionId) {
  if (!auctionId) return { branches: [], sellers: [], buyers: [] };
  const aid = parseInt(auctionId, 10);
  const branches = db.all(
    `SELECT DISTINCT TRIM(branch) AS branch FROM lots
      WHERE auction_id = ? AND TRIM(COALESCE(branch,'')) <> ''
      ORDER BY branch`, [aid]).map(r => r.branch);
  const sellers = db.all(
    `SELECT DISTINCT l.trader_id AS id, COALESCE(t.name, l.name) AS name
       FROM lots l LEFT JOIN traders t ON t.id = l.trader_id
      WHERE l.auction_id = ? AND COALESCE(t.name, l.name) <> ''
      ORDER BY name`, [aid]);
  const buyers = db.all(
    `SELECT DISTINCT COALESCE(b.code, l.code) AS code,
            COALESCE(b.buyer1, b.buyer, l.buyer1, l.buyer) AS name
       FROM lots l LEFT JOIN buyers b
         ON UPPER(TRIM(b.code))  = UPPER(TRIM(l.code))
         OR UPPER(TRIM(b.buyer)) = UPPER(TRIM(l.buyer))
      WHERE l.auction_id = ? AND l.amount > 0
        AND COALESCE(b.code, l.code) <> ''
      ORDER BY name`, [aid]);
  return { branches, sellers, buyers };
}

// ════════════════════════════════════════════════════════════
// REPORT 1 — BUYERS STATEMENT
// ════════════════════════════════════════════════════════════
function buildBuyersStatement(ctx) {
  const { auction, rows, auctionState } = ctx;
  // Group by unique buyer (code falls back to full name) so each buyer
  // appears once with their consolidated kilos/amount.
  const groups = new Map();
  for (const r of rows) {
    const key = (r.buyer_code || r.buyer_full || 'UNKNOWN').toUpperCase();
    if (!groups.has(key)) {
      groups.set(key, {
        code:    r.buyer_code,
        name:    r.buyer1 || r.buyer_full,
        place:   r.buyer_place || '',
        gstin:   r.buyer_gstin || '',
        sbl:     r.buyer_sbl || '',
        state:   r.buyer_state || '',
        sale:    String(r.buyer_sale || r.lot_sale || 'L').toUpperCase(),
        kilos:   0,
        amount:  0,
      });
    }
    const g = groups.get(key);
    g.kilos  += Number(r.qty)    || 0;
    g.amount += Number(r.amount) || 0;
  }

  // Bucket by sale type. The Sales Invoice flow already stamps every
  // lot/invoice with sale = 'L' (intra/local), 'I' (inter-state), or 'E'
  // (export), so prefer that as the source of truth. The earlier
  // buyer-state-vs-auction-state comparison was a fallback that
  // mis-classified L sales whenever a buyer's `state` field was missing
  // or didn't exactly match the auction state — the INTRA bucket then
  // showed up empty even though L invoices clearly existed.
  const inter = [], intra = [], exportS = [];
  for (const g of groups.values()) {
    const sale = String(g.sale || '').trim().toUpperCase();
    if (sale === 'E') { g.saleLabel = 'EXPORT'; exportS.push(g); continue; }
    if (sale === 'L') { g.saleLabel = 'INTRA';  intra  .push(g); continue; }
    if (sale === 'I') { g.saleLabel = 'INTER';  inter  .push(g); continue; }
    // Unknown / legacy sale type — fall back to the state heuristic.
    const bs = String(g.state || '').trim().toUpperCase();
    const isIntra = !bs || bs === auctionState;
    if (isIntra) { g.saleLabel = 'INTRA'; intra.push(g); }
    else         { g.saleLabel = 'INTER'; inter.push(g); }
  }
  const sortFn = (a, b) => (a.name || '').localeCompare(b.name || '');
  inter.sort(sortFn); intra.sort(sortFn); exportS.sort(sortFn);

  // Sequential invoice numbers per section (I 1.., L 1.., E 1..)
  let iSeq = 0, lSeq = 0, eSeq = 0;
  inter.forEach(g   => { iSeq++; g.invoice = `I ${iSeq}`; });
  intra.forEach(g   => { lSeq++; g.invoice = `L ${lSeq}`; });
  exportS.forEach(g => { eSeq++; g.invoice = `E ${eSeq}`; });

  const sum = arr => arr.reduce((a, g) => ({ kilos: a.kilos + g.kilos, amount: a.amount + g.amount }),
                                { kilos: 0, amount: 0 });
  const interTotals  = sum(inter);
  const intraTotals  = sum(intra);
  const exportTotals = sum(exportS);
  const grand = {
    kilos:  interTotals.kilos  + intraTotals.kilos  + exportTotals.kilos,
    amount: interTotals.amount + intraTotals.amount + exportTotals.amount,
  };
  // Per-sale-type breakdown for the Grand Total row (Task 7B).
  const saleTypeTotals = [
    { label: 'INTRA STATE (L)', kilos: intraTotals.kilos,  amount: intraTotals.amount },
    { label: 'INTER-STATE (I)', kilos: interTotals.kilos,  amount: interTotals.amount },
    { label: 'EXPORT (E)',      kilos: exportTotals.kilos, amount: exportTotals.amount },
  ];
  return { auction, inter, intra, export: exportS,
           interTotals, intraTotals, exportTotals,
           saleTypeTotals, grand };
}

function buyersStatementJson(db, opts) {
  const ctx = getReportContext(db, opts);
  const data = buildBuyersStatement(ctx);
  return {
    title: 'Buyers Statement',
    auction: { ano: ctx.auction.ano, date: fmtDateDMY(ctx.auction.date), state: ctx.auction.state },
    columns: [
      { key: 'invoice', header: 'INVOICE',      align: 'left' },
      { key: 'name',    header: 'TRADERS NAME', align: 'left' },
      { key: 'place',   header: 'ADDRESS',      align: 'left' },
      { key: 'kilos',   header: 'KILOS',        align: 'right', numeric: true, fmt: 'qty' },
      { key: 'amount',  header: 'AMOUNT',       align: 'right', numeric: true, fmt: 'money' },
      { key: 'gstin',   header: 'GST NO',       align: 'left' },
      { key: 'sbl',     header: 'SBL NO',       align: 'left' },
    ],
    sections: [
      { title: 'INTER-STATE SALES', rows: data.inter, totals: { label: 'INTER-STATE SALES TOTAL', kilos: data.interTotals.kilos, amount: data.interTotals.amount } },
      { title: 'INTRA STATE SALES', rows: data.intra, totals: { label: 'INTRA STATE SALES TOTAL', kilos: data.intraTotals.kilos, amount: data.intraTotals.amount } },
    ],
    grand: { label: 'GRAND TOTAL', kilos: data.grand.kilos, amount: data.grand.amount },
  };
}

async function buyersStatementXlsx(db, opts) {
  _loadDateFormat(db);
  const ctx = getReportContext(db, opts);
  const data = buildBuyersStatement(ctx);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BuyersStatement');
  ws.columns = [{ width: 10 }, { width: 30 }, { width: 20 }, { width: 12 }, { width: 18 }, { width: 22 }, { width: 22 }];
  writeXlsxCompanyHeader(wb, ws, getCompanyHeader(db), {
    colCount: 7, title: 'BUYERS STATEMENT',
    metaLines: [`AUCTION NO: ${ctx.auction.ano}`, `DATE: ${fmtDateDMY(ctx.auction.date)}`].filter(Boolean),
  });
  // Column widths re-sized so every cell fits its content on one line
  // (Excel auto-truncates only when wrapText is enabled — we keep it
  // OFF so the row stays visually flat in print preview and PDF export).
  ws.columns = [
    { width: 12 },   // INVOICE
    { width: 38 },   // TRADERS NAME
    { width: 26 },   // ADDRESS
    { width: 14 },   // KILOS
    { width: 18 },   // AMOUNT
    { width: 22 },   // GST NO
    { width: 22 },   // SBL NO
  ];
  const bodyAligns = ['left', 'left', 'left', 'right', 'right', 'left', 'left'];
  const head = ws.addRow(['INVOICE', 'TRADERS NAME', 'ADDRESS', 'KILOS', 'AMOUNT', 'GST NO', 'SBL NO']);
  head.font = { bold: true, size: 10 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E4DD' } };
  head.eachCell((c, i) => {
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    c.alignment = { horizontal: bodyAligns[i - 1] || 'center', vertical: 'middle', wrapText: false };
  });
  function emitSection(title, rows, totals) {
    if (!rows.length) return;
    const sec = ws.addRow([title]);
    ws.mergeCells(`A${sec.number}:G${sec.number}`);
    sec.font = { bold: true, size: 10 };
    sec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
    sec.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
    rows.forEach(g => {
      const r = ws.addRow([g.invoice, g.name, g.place, g.kilos, g.amount, g.gstin, g.sbl]);
      r.getCell(4).numFmt = '#,##0.000';
      r.getCell(5).numFmt = '#,##,##0.00';
      r.eachCell((c, i) => {
        c.alignment = { horizontal: bodyAligns[i - 1] || 'left', vertical: 'middle', wrapText: false };
      });
    });
    const sub = ws.addRow(['', totals.label, '', totals.kilos, totals.amount, '', '']);
    sub.font = { bold: true };
    sub.getCell(4).numFmt = '#,##0.000';
    sub.getCell(5).numFmt = '#,##,##0.00';
    sub.eachCell((c, i) => {
      c.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F5F2' } };
      c.alignment = { horizontal: bodyAligns[i - 1] || 'left', vertical: 'middle', wrapText: false };
    });
    ws.addRow([]);
  }
  emitSection('INTER-STATE SALES', data.inter, { label: 'INTER-STATE SALES TOTAL', kilos: data.interTotals.kilos, amount: data.interTotals.amount });
  emitSection('INTRA STATE SALES', data.intra, { label: 'INTRA STATE SALES TOTAL', kilos: data.intraTotals.kilos, amount: data.intraTotals.amount });
  emitSection('EXPORT SALES',      data.export, { label: 'EXPORT SALES TOTAL',     kilos: data.exportTotals.kilos, amount: data.exportTotals.amount });
  // Sale-type-wise totals row (Task 7B)
  ws.addRow([]);
  const sth = ws.addRow(['', 'SALE TYPE TOTALS', '', '', '', '', '']);
  sth.font = { bold: true, size: 10 };
  sth.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E4DD' } };
                       c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } }; });
  data.saleTypeTotals.forEach(t => {
    const r = ws.addRow(['', t.label, '', t.kilos, t.amount, '', '']);
    r.font = { bold: true };
    r.getCell(4).numFmt = '#,##0.000';
    r.getCell(5).numFmt = '#,##,##0.00';
  });
  const g = ws.addRow(['', 'GRAND TOTAL', '', data.grand.kilos, data.grand.amount, '', '']);
  g.font = { bold: true, size: 11 };
  g.getCell(4).numFmt = '#,##0.000';
  g.getCell(5).numFmt = '#,##,##0.00';
  g.eachCell(c => { c.border = { top: { style: 'double' }, bottom: { style: 'double' } };
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }; });
  return wb.xlsx.writeBuffer();
}

async function buyersStatementPdf(db, opts) {
  _loadDateFormat(db);
  const ctx = getReportContext(db, opts);
  const data = buildBuyersStatement(ctx);
  const company = readSetting(db, 'trade_name', readSetting(db, 'company_name', ''));
  // Place — configured Office Branch for the active business state.
  const _bsBS = String(readSetting(db, 'business_state', '')).toUpperCase();
  const _isKL = _bsBS === 'KERALA' || _bsBS === 'KL';
  const place  = readSetting(db, _isKL ? 'kl_branch' : 'tn_branch',
                  readSetting(db, 'tn_branch',
                    readSetting(db, 'kl_branch',
                      readSetting(db, 'business_place', ''))));

  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 24 });
  const buffers = []; doc.on('data', b => buffers.push(b));
  const m = 24;
  const usableW = doc.page.width - m * 2;
  // 7 cols: INVOICE | TRADERS NAME | ADDRESS | KILOS | AMOUNT | GST NO | SBL NO
  // Widths re-tuned for portrait: TRADERS NAME wider, ADDRESS+GST narrower
  // since portrait pages have only ~547pt usable.
  const colW = [
    Math.floor(usableW * 0.08),  // INVOICE
    Math.floor(usableW * 0.26),  // TRADERS NAME
    Math.floor(usableW * 0.12),  // ADDRESS
    Math.floor(usableW * 0.11),  // KILOS
    Math.floor(usableW * 0.14),  // AMOUNT
    Math.floor(usableW * 0.15),  // GST NO
    0,                            // SBL NO
  ];
  colW[6] = usableW - colW.slice(0, 6).reduce((a, b) => a + b, 0);
  const colX = [m]; for (let i = 0; i < 6; i++) colX.push(colX[i] + colW[i]);
  // Reference layout: INVOICE = left, TRADERS NAME / ADDRESS / GST / SBL = left,
  // KILOS + AMOUNT = right.  Headers stay centered above their column.
  const aligns = ['left', 'left', 'left', 'right', 'right', 'left', 'left'];
  const heads  = ['INVOICE', 'TRADERS NAME', 'ADDRESS', 'KILOS', 'AMOUNT', 'GST NO', 'SBL NO'];
  const PADX = 3;          // tighter padding for portrait
  const ROW_H = 12;
  const HEAD_H = 16;
  let y;

  // Vertical centering helper — y-offset for text of `fontH` size in a row of height `rowH`.
  function vy(rowTop, rowH, fontH) { return rowTop + (rowH - fontH) / 2; }

  // Draw column separators between [skipFrom..skipTo] left undrawn so a
  // merged label can flow across cells without visible internal pipes.
  function drawColSeparators(top, bottom, opts) {
    opts = opts || {};
    const skipFrom = opts.skipFrom == null ? -1 : opts.skipFrom;
    const skipTo   = opts.skipTo   == null ? -1 : opts.skipTo;
    for (let i = 1; i < colW.length; i++) {
      if (i > skipFrom && i <= skipTo) continue;
      const vx = colX[i];
      doc.moveTo(vx, top).lineTo(vx, bottom).lineWidth(0.4).strokeColor('#000').stroke();
    }
  }
  // Render `text` wrapped to fit `width` with the current font/size; returns
  // the height taken so the caller can grow the row to match.
  function drawWrapped(text, x, top, width, opts) {
    opts = opts || {};
    const lines = wrapText(doc, text, width);
    const lineH = (opts.lineH != null) ? opts.lineH : 9;
    let ty = top + (opts.padTop != null ? opts.padTop : 2);
    lines.forEach(line => {
      doc.text(line, x, ty, { width, align: opts.align || 'left', lineBreak: false });
      ty += lineH;
    });
    return lines.length * lineH + (opts.padTop != null ? opts.padTop : 2) + 1;
  }
  // Pre-compute total height a list of (text, width) pairs would take with
  // the current font.
  function maxWrappedH(pairs, lineH) {
    return Math.max(...pairs.map(([t, w]) => wrapText(doc, t, w).length * lineH));
  }

  function topHeader() {
    y = m;
    // Logo (Task 7C) — pulled from the configured company logo file when
    // present. Sits in the top-left; company name + place stay centered.
    const _hdr = getCompanyHeader(db);
    const LOGO_H = 40;
    if (_hdr && _hdr.logoPath) {
      try { doc.image(_hdr.logoPath, m, y, { fit: [LOGO_H, LOGO_H] }); } catch (_) { /* ignore */ }
    }
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(12);
    doc.text(company || '', m, y, { width: usableW, align: 'center' });
    y = doc.y + 2;
    if (place) {
      doc.font('Helvetica-Bold').fontSize(11);
      doc.text(place, m, y, { width: usableW, align: 'center' });
      y = doc.y + 2;
    }
    // Make sure we sit below the logo band before drawing the title.
    if (y < m + LOGO_H + 2) y = m + LOGO_H + 2;
    y += 4;
    doc.font('Helvetica-Bold').fontSize(11)
       .text('BUYERS STATEMENT', m, y, { width: usableW, align: 'center', lineBreak: false });
    y += 18;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`AUCTION NO: ${ctx.auction.ano}`,    m, y, { width: usableW / 2, align: 'left',  lineBreak: false });
    doc.text(`DATE: ${fmtDateDMY(ctx.auction.date)}`, m + usableW / 2, y, { width: usableW / 2, align: 'right', lineBreak: false });
    y += 18;
  }
  function drawHeadRow() {
    // Single-line header — fits every label by shrinking the font size
    // down to a 6pt floor (with ellipsis as a last resort). No wrap, so
    // every column header occupies the same row height as the body.
    const top = y;
    const headH = HEAD_H;
    doc.fillColor('#000').font('Helvetica-Bold');
    doc.rect(m, y, usableW, headH).lineWidth(0.7).strokeColor('#000').stroke();
    heads.forEach((h, i) => {
      const w = colW[i] - PADX * 2;
      let size = 8;
      while (size > 6) {
        doc.fontSize(size);
        if (doc.widthOfString(h) <= w) break;
        size -= 0.25;
      }
      doc.fontSize(size);
      doc.text(h, colX[i] + PADX, top + (headH - size) / 2 - 1, {
        width: w, align: 'center', lineBreak: false, ellipsis: true,
      });
    });
    drawColSeparators(top, top + headH);
    y += headH;
  }
  function ensureRoom(n) { if (y + n > doc.page.height - m - 14) { doc.addPage(); topHeader(); drawHeadRow(); } }
  // Single-line data row. Every value is shrink-fitted to its column
  // (down to a 5pt font floor) and then ellipsised — guarantees the row
  // stays on one line so the table never goes ragged.
  function row(g) {
    const cells = [g.invoice, g.name, g.place, fmtQty(g.kilos), fmtMoney(g.amount), g.gstin, g.sbl];
    const rowH = ROW_H;
    ensureRoom(rowH);
    const top = y;
    doc.fillColor('#000').font('Helvetica');
    cells.forEach((v, i) => {
      const w = colW[i] - PADX * 2;
      const text = String(v || '');
      let size = 7.5;
      while (size > 5) {
        doc.fontSize(size);
        if (doc.widthOfString(text) <= w) break;
        size -= 0.25;
      }
      doc.fontSize(size);
      doc.text(text, colX[i] + PADX, top + (rowH - size) / 2 - 1, {
        width: w, align: aligns[i], lineBreak: false, ellipsis: true,
      });
    });
    y = top + rowH;
    doc.moveTo(m, top).lineTo(m, y).moveTo(m + usableW, top).lineTo(m + usableW, y)
       .lineWidth(0.6).strokeColor('#000').stroke();
    drawColSeparators(top, y);
    // Horizontal separator under each row so every row is delimited.
    doc.moveTo(m, y).lineTo(m + usableW, y).lineWidth(0.4).strokeColor('#000').stroke();
  }
  function sectionLabel(title) {
    const top = y;
    const H = 16;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    doc.text(title, colX[0] + PADX, vy(top, H, 9), {
      width: usableW - PADX * 2, align: 'left', lineBreak: false,
    });
    y += H;
    doc.rect(m, top, usableW, y - top).lineWidth(0.6).strokeColor('#000').stroke();
  }
  function subtotalRow(label, kilos, amount) {
    const top = y;
    const H = 18;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000');
    const labelW = colW[1] + colW[2] - PADX * 2;
    doc.text(label, colX[1] + PADX, vy(top, H, 10), {
      width: labelW, align: 'left', lineBreak: false,
    });
    doc.text(fmtQty(kilos),    colX[3] + PADX, vy(top, H, 10), { width: colW[3] - PADX * 2, align: 'right', lineBreak: false });
    doc.text(fmtMoney(amount), colX[4] + PADX, vy(top, H, 10), { width: colW[4] - PADX * 2, align: 'right', lineBreak: false });
    y += H;
    doc.rect(m, top, usableW, y - top).lineWidth(0.7).strokeColor('#000').stroke();
    drawColSeparators(top, y, { skipFrom: 1, skipTo: 2 });
  }

  topHeader();
  drawHeadRow();
  function emitSection(title, rows, totals) {
    if (!rows.length) return;
    ensureRoom(16 + ROW_H + 18);
    sectionLabel(title);
    rows.forEach(g => row(g));   // row() handles its own pagination
    ensureRoom(18);
    subtotalRow(totals.label, totals.kilos, totals.amount);
  }
  emitSection('INTER-STATE SALES', data.inter, { label: 'INTER-STATE SALES TOTAL', kilos: data.interTotals.kilos, amount: data.interTotals.amount });
  emitSection('INTRA STATE SALES', data.intra, { label: 'INTRA STATE SALES TOTAL', kilos: data.intraTotals.kilos, amount: data.intraTotals.amount });
  emitSection('EXPORT SALES',      data.export, { label: 'EXPORT SALES TOTAL',     kilos: data.exportTotals.kilos, amount: data.exportTotals.amount });

  // Sale-type-wise totals (Task 7B) — shown above the grand total so the
  // user can verify the per-sale-type kilos/amount before the consolidated
  // figure. Rendered with the same column layout as subtotal rows.
  ensureRoom(18 * (data.saleTypeTotals.length + 1));
  sectionLabel('SALE TYPE TOTALS');
  data.saleTypeTotals.forEach(t => subtotalRow(t.label, t.kilos, t.amount));

  // Grand total — uses a font size close to the data rows so large values
  // (e.g. "13,62,05,969.60") stay inside their column instead of overflowing
  // into the merged-label area on the left. Cells pre-wrap and the row
  // height grows to the tallest cell.
  const gFont   = 9;
  const gLineH  = gFont + 2;
  doc.font('Helvetica-Bold').fontSize(gFont).fillColor('#000');
  const gCells = [
    { x: colX[1] + PADX, w: colW[1] + colW[2] - PADX * 2, text: 'GRAND TOTAL',                  align: 'center' },
    { x: colX[3] + PADX, w: colW[3] - PADX * 2,           text: fmtQty(data.grand.kilos),       align: 'right'  },
    { x: colX[4] + PADX, w: colW[4] - PADX * 2,           text: fmtMoney(data.grand.amount),    align: 'right'  },
  ];
  const gWrapped  = gCells.map(c => wrapText(doc, c.text, c.w));
  const gMaxLines = Math.max(...gWrapped.map(l => l.length));
  const gH        = Math.max(20, gMaxLines * gLineH + 6);
  ensureRoom(gH + 2);
  const gTop = y;
  gCells.forEach((c, i) => {
    const lines = gWrapped[i];
    let ty = gTop + (gH - lines.length * gLineH) / 2;
    lines.forEach(line => {
      doc.text(line, c.x, ty, { width: c.w, align: c.align, lineBreak: false });
      ty += gLineH;
    });
  });
  y = gTop + gH;
  doc.rect(m, gTop, usableW, y - gTop).lineWidth(0.9).strokeColor('#000').stroke();
  drawColSeparators(gTop, y, { skipFrom: 1, skipTo: 2 });

  return new Promise(resolve => { doc.on('end', () => resolve(Buffer.concat(buffers))); doc.end(); });
}

// ════════════════════════════════════════════════════════════
// REPORT 2 — FORM-D (Advance Auction Report)
// ════════════════════════════════════════════════════════════
function buildFormD(ctx, db, opts) {
  opts = opts || {};
  const { auction, rows } = ctx;
  let totalKilos = 0, totalValue = 0, maxRate = 0, minRate = Infinity, maxKg = 0, minKg = 0;
  for (const r of rows) {
    const q = Number(r.qty) || 0, a = Number(r.amount) || 0, p = Number(r.price) || 0;
    totalKilos += q; totalValue += a;
    if (p > maxRate) { maxRate = p; maxKg = q; }
    if (p < minRate && p > 0) { minRate = p; minKg = q; }
  }
  if (!isFinite(minRate)) minRate = 0;
  const avgRate = totalKilos > 0 ? (totalValue / totalKilos) : 0;

  // Top 5 buyers by kilos
  const buyerMap = new Map();
  for (const r of rows) {
    const key = (r.buyer_code || r.buyer_full || 'UNKNOWN').toUpperCase();
    if (!buyerMap.has(key)) buyerMap.set(key, { name: r.buyer1 || r.buyer_full, kilos: 0, value: 0 });
    const b = buyerMap.get(key);
    b.kilos += Number(r.qty) || 0; b.value += Number(r.amount) || 0;
  }
  const top5 = [...buyerMap.values()].sort((a, b) => b.kilos - a.kilos).slice(0, 5);
  const top5Totals = top5.reduce((a, b) => ({ kilos: a.kilos + b.kilos, value: a.value + b.value }), { kilos: 0, value: 0 });

  const seasonStart = readSetting(db, 'season_start_year', '');
  const seasonEnd   = readSetting(db, 'season_end_year', '');
  const season = (seasonStart && seasonEnd) ? `${seasonStart} - ${seasonEnd}` : readSetting(db, 'season', '');
  // e-Auction Licence — sourced from the company's SBL No. (Settings →
  // Company → SBL No.). The Spice Board treats the trader's SBL number
  // as the e-Auction licence identifier; we don't carry a separate
  // licence field in this build.
  const licence = readSetting(db, 'sbl', '');

  // Place of auction — caller-supplied value (the operator's pick from
  // the Form-D place dropdown in Spice Board menu) takes top priority.
  // Falls back to the configured branch (Address → Office Branch) for
  // the active business state, then to the legacy `business_place` key.
  const placeOverride = String(opts.place || '').trim();
  let place;
  if (placeOverride) {
    place = placeOverride;
  } else {
    const placeBizState = String(readSetting(db, 'business_state', '')).toUpperCase();
    const placeKL = placeBizState === 'KERALA' || placeBizState === 'KL';
    place = readSetting(db, placeKL ? 'kl_branch' : 'tn_branch',
              readSetting(db, 'tn_branch',
                readSetting(db, 'kl_branch',
                  readSetting(db, 'business_place', ''))));
  }
  const company = readSetting(db, 'trade_name', readSetting(db, 'company_name', ''));
  // Address resolution: pick KL block when business_state = KERALA, otherwise
  // TN block. Falls back to the bare `address1` key for legacy installs.
  const bizState = String(readSetting(db, 'business_state', '')).toUpperCase();
  const isKL     = bizState === 'KERALA' || bizState === 'KL';
  const a1key    = isKL ? 'kl_address1' : 'tn_address1';
  const a2key    = isKL ? 'kl_address2' : 'tn_address2';
  const branch   = readSetting(db, isKL ? 'kl_branch' : 'tn_branch', '');
  const address  = [readSetting(db, a1key, ''), readSetting(db, a2key, ''), branch]
                    .filter(Boolean).join(', ') || readSetting(db, 'address1', '');

  return {
    auction, season, licence, place, company, address,
    totalKilos, totalValue, maxRate, minRate, avgRate, maxKg, minKg,
    top5, top5Totals,
  };
}

function formDJson(db, opts) {
  const ctx = getReportContext(db, opts);
  const d = buildFormD(ctx, db, opts);
  return {
    title: 'FORM - D (Advance Auction Report)',
    auction: { ano: ctx.auction.ano, date: fmtDateDMY(ctx.auction.date), state: ctx.auction.state },
    summary: {
      auctioneer: d.company, address: d.address, licence: d.licence, season: d.season, place: d.place,
      auctionNo: ctx.auction.ano, auctionDate: fmtDateDMY(ctx.auction.date),
      carriedOver: 'NIL',
      freshArrivals: d.totalKilos, totalForAuction: d.totalKilos, totalSold: d.totalKilos,
      notAuctioned: 'NIL', withdrawn: 0, returnedToPlanter: 0, balance: 'NIL',
      totalValue: d.totalValue,
      maxRate: d.maxRate, maxKg: d.maxKg, minRate: d.minRate, minKg: d.minKg, avgRate: d.avgRate,
    },
    top5: d.top5.map((b, i) => ({ slNo: i + 1, name: b.name, kilos: b.kilos, value: b.value })),
    top5Totals: { label: 'TOTAL', kilos: d.top5Totals.kilos, value: d.top5Totals.value },
  };
}

async function formDXlsx(db, opts) {
  _loadDateFormat(db);
  const ctx = getReportContext(db, opts);
  const d   = buildFormD(ctx, db, opts);
  const wb  = new ExcelJS.Workbook();
  const ws  = wb.addWorksheet('FormD');
  ws.columns = [{ width: 8 }, { width: 36 }, { width: 14 }, { width: 18 }];
  writeXlsxCompanyHeader(wb, ws, getCompanyHeader(db), { colCount: 4, title: 'FORM - D (Advance Auction Report)' });

  function meta(label, value) {
    const r = ws.addRow(['', label, '', value]);
    r.getCell(2).font = { bold: false, size: 10 };
    r.getCell(2).alignment = { horizontal: 'left',  vertical: 'middle' };
    r.getCell(4).font = { bold: true,  size: 10 };
    r.getCell(4).alignment = { horizontal: 'left',  vertical: 'middle' };
  }
  meta('Name and Address of the auctioneer:', d.company);
  if (d.address) meta('', d.address);
  meta('e-Auction Licence No.', d.licence);
  meta('Season', d.season);
  meta('Auction Number', ctx.auction.ano);
  meta('Date of auction', fmtDateDMY(ctx.auction.date));
  meta('Place of auction', d.place);
  meta('Quantity carried over from previous auction (kgs)', 'NIL');
  meta('Fresh arrivals (kgs)', d.totalKilos);
  meta('Total quantity put for auction (kgs)', d.totalKilos);
  meta('Total quantity sold (kgs)', d.totalKilos);
  meta('Quantity Not Auctioned (kgs)', 'NIL');
  meta('Quantity withdrawn (kgs)', 0);
  meta('Quantity returned to planter (kgs)', 0);
  meta('Balance with the auctioneer (kgs)', 'NIL');
  meta('Total value of the sales (Rs)', d.totalValue);
  meta('Maximum price (Rs/kg)', `${fmtPrice(d.maxRate)} / kgs ${fmtQty(d.maxKg)}`);
  meta('Minimum price (Rs/kg)', `${fmtPrice(d.minRate)} / kgs ${fmtQty(d.minKg)}`);
  meta('Average price (Rs/kg)', d.avgRate);

  ws.addRow([]);
  const tHead = ws.addRow(['', 'Name of 5 Highest Buyers', '', '']);
  ws.mergeCells(`B${tHead.number}:D${tHead.number}`);
  tHead.font = { bold: true, size: 11 }; tHead.alignment = { horizontal: 'center' };

  // Headers align with body cells: Sl.No center, Buyer left, Kilos/Value right.
  const buyerAligns = ['center', 'left', 'right', 'right'];
  const ch = ws.addRow(['Sl.No', 'Buyer Name', 'Kilos', 'Value']);
  ch.font = { bold: true }; ch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E4DD' } };
  ch.eachCell((c, i) => {
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    c.alignment = { horizontal: buyerAligns[i - 1] || 'center', vertical: 'middle' };
  });
  d.top5.forEach((b, i) => {
    const r = ws.addRow([i + 1, b.name, b.kilos, b.value]);
    r.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    r.getCell(2).alignment = { horizontal: 'left',   vertical: 'middle' };
    r.getCell(3).alignment = { horizontal: 'right',  vertical: 'middle' };
    r.getCell(4).alignment = { horizontal: 'right',  vertical: 'middle' };
    r.getCell(3).numFmt = '#,##0.000';
    r.getCell(4).numFmt = '#,##,##0.00';
  });
  const t = ws.addRow(['', 'TOTAL', d.top5Totals.kilos, d.top5Totals.value]);
  t.font = { bold: true };
  t.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
  t.getCell(3).alignment = { horizontal: 'right',  vertical: 'middle' };
  t.getCell(4).alignment = { horizontal: 'right',  vertical: 'middle' };
  t.getCell(3).numFmt = '#,##0.000';
  t.getCell(4).numFmt = '#,##,##0.00';
  t.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }; });
  return wb.xlsx.writeBuffer();
}

async function formDPdf(db, opts) {
  _loadDateFormat(db);
  const ctx = getReportContext(db, opts);
  const d   = buildFormD(ctx, db, opts);
  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 40 });
  const buffers = []; doc.on('data', b => buffers.push(b));
  const m = 40, usableW = doc.page.width - m * 2;

  // ── Outer bordered box (matches reference: single ruled rectangle around
  //    the entire FORM-D content). We compute the body height after laying
  //    out the inner lines, then draw the box behind everything.
  let y = m;
  const boxTop = y;
  const innerPad = 16;
  let innerY = y + innerPad;
  const innerL = m + innerPad;
  const innerW = usableW - innerPad * 2;

  // Logo (Task 8) — anchored top-left inside the box so the FORM-D heading
  // still centres on the page. Drawn before the title so the title row's Y
  // can advance past it if needed.
  const _hdrFD = getCompanyHeader(db);
  const LOGO_H_FD = 44;
  if (_hdrFD && _hdrFD.logoPath) {
    try { doc.image(_hdrFD.logoPath, innerL, innerY, { fit: [LOGO_H_FD, LOGO_H_FD] }); }
    catch (_) { /* ignore */ }
  }

  // Centered header lines
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(13)
     .text('FORM - D', innerL, innerY, { width: innerW, align: 'center', lineBreak: false });
  innerY += 18;
  doc.font('Helvetica').fontSize(10)
     .text('[See rule 10(1)(1)]', innerL, innerY, { width: innerW, align: 'center', lineBreak: false });
  innerY += 18;
  doc.font('Helvetica').fontSize(11)
     .text('(Advance Auction Report)', innerL, innerY, { width: innerW, align: 'center', lineBreak: false });
  innerY += 24;
  // Make sure body sits below the logo band.
  if (_hdrFD && _hdrFD.logoPath && innerY < (boxTop + innerPad + LOGO_H_FD + 4)) {
    innerY = boxTop + innerPad + LOGO_H_FD + 4;
  }

  // ── Two-column layout: fixed label width + fixed value column.
  //    Every value starts at the same X so colons line up vertically.
  const LABEL_W = 250;            // width of the label cell
  const VAL_X   = innerL + LABEL_W;
  const VAL_W   = innerW - LABEL_W;
  const LINE_H  = 16;

  // Auctioneer block: label on first line, value(s) WRAP within VAL_W
  // (no fitText — long company names should wrap to 2-3 lines, not be cut).
  doc.font('Helvetica').fontSize(10).fillColor('#000')
     .text('Name and Address of the auctioneer:', innerL, innerY, { width: LABEL_W, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10)
     .text(d.company || '', VAL_X, innerY, { width: VAL_W, align: 'left' });
  innerY = doc.y + 2;
  if (d.address) {
    doc.font('Helvetica-Bold').fontSize(10)
       .text(d.address, VAL_X, innerY, { width: VAL_W, align: 'left' });
    innerY = doc.y + 4;
  }

  // Single labelled row. Both label and value WRAP to multiple lines when
  // they exceed their column width — the row's height grows to fit. This
  // way long company names / long licence ids show in full.
  function row(label, value, opts) {
    opts = opts || {};
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    const labelLines = wrapText(doc, label, LABEL_W);
    doc.font(opts.bold === false ? 'Helvetica' : 'Helvetica-Bold').fontSize(10).fillColor('#000');
    const valueLines = wrapText(doc, String(value == null ? '' : value), VAL_W);
    const lines = Math.max(labelLines.length, valueLines.length);
    const lineH = 12;
    // Render label (plain font)
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    labelLines.forEach((ln, i) => {
      doc.text(ln, innerL, innerY + i * lineH, { width: LABEL_W, lineBreak: false });
    });
    // Render value (bold)
    doc.font(opts.bold === false ? 'Helvetica' : 'Helvetica-Bold').fontSize(10).fillColor('#000');
    valueLines.forEach((ln, i) => {
      doc.text(ln, VAL_X, innerY + i * lineH, { width: VAL_W, align: opts.align || 'left', lineBreak: false });
    });
    innerY += lines * lineH + 2;
  }
  // Plain continuation line (label spans full label width, no value).
  function cont(label) {
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    const lines = wrapText(doc, label, LABEL_W);
    const lineH = 12;
    lines.forEach((ln, i) => doc.text(ln, innerL, innerY + i * lineH, { width: LABEL_W, lineBreak: false }));
    innerY += lines.length * lineH + 2;
  }

  // Every label/value row left-aligns its value so the column of figures
  // lines up vertically. Previously some rows were { align: 'right' }
  // (mostly the numeric ones) and others left-aligned — this produced
  // the "random right alignment" inconsistency the user flagged.
  row('E-Auction Licence No.', d.licence);
  innerY += 4;
  row('(s) Season',            d.season);
  row('(t) Auction Number',    ctx.auction.ano);
  row('(u) Date of auction',   fmtDateDMY(ctx.auction.date));
  row('(v) Place of auction',  d.place);
  row('(w) Quantity carried over from',   'NIL');
  cont('     previous auction (kgs)');
  row('(x) Fresh arrivals (kgs)',         fmtQty(d.totalKilos));
  row('(y) Total quantity put for auction (kgs)', fmtQty(d.totalKilos));
  cont('     [Total of Sl.No. 5 and 6]');
  row('(z) Total quantity sold (kgs)',    fmtQty(d.totalKilos));
  row('(zz) Quantity Not Auctioned (Kgs.)', 'NIL');
  row('(aa) Quantity withdrawn (kgs)',    '0.000');
  row('(bb) Quantity returned to planter (kgs)',  '0.000');
  row('(cc) Balance with the auctioneer (kgs)',   'NIL');
  row('(dd) Total value of the sales (Rs)',       fmtMoney(d.totalValue));
  row('(ee) Maximum price (Rs/kg)',  `${fmtPrice(d.maxRate)}  /kgs ${fmtQty(d.maxKg)}`);
  row('(ff) Minimum price (Rs/kg)',  `${fmtPrice(d.minRate)}  /kgs ${fmtQty(d.minKg)}`);
  row('(gg) Average price (Rs/kg)',  fmtPrice(d.avgRate));
  innerY += 8;

  // Draw the outer box now that we know the content height
  const boxBottom = innerY;
  doc.rect(m, boxTop, usableW, boxBottom - boxTop).lineWidth(0.9).strokeColor('#000').stroke();

  // ── 5 Highest Buyers (separate table below the box) ──
  let y2 = boxBottom + 22;
  doc.font('Helvetica-Bold').fontSize(11)
     .text('Name of 5 Highest Buyers', m, y2, { width: usableW, align: 'center', lineBreak: false });
  y2 += 14;
  const ulW = 180;
  const ulX = m + (usableW - ulW) / 2;
  doc.moveTo(ulX, y2).lineTo(ulX + ulW, y2).lineWidth(0.6).strokeColor('#000').stroke();
  y2 += 8;

  // 4-col table — Sl.No (narrow centered) | Buyer (wide left) | Kilos (right) | Value (right)
  const cw = [50, usableW - 50 - 130 - 160, 130, 160];
  const cx = [m]; for (let i = 0; i < cw.length - 1; i++) cx.push(cx[i] + cw[i]);
  const PADX = 6;
  function vy2(top, rowH, fontH) { return top + (rowH - fontH) / 2; }
  function buyerCols(top, bottom, opts) {
    opts = opts || {};
    const sf = opts.skipFrom == null ? -1 : opts.skipFrom;
    const st = opts.skipTo   == null ? -1 : opts.skipTo;
    for (let i = 1; i < cw.length; i++) {
      if (i > sf && i <= st) continue;
      doc.moveTo(cx[i], top).lineTo(cx[i], bottom).lineWidth(0.5).strokeColor('#000').stroke();
    }
  }
  const aligns2 = ['center', 'left', 'right', 'right'];

  // Header row — each header cell uses the SAME alignment as the body
  // cells below it, so Kilos/Value headers right-align over their
  // right-aligned numbers and "Buyer Name" left-aligns over the names.
  // (Centered headers over right-aligned numbers looked off-axis.)
  const headH = 22;
  doc.rect(m, y2, usableW, headH).lineWidth(0.7).strokeColor('#000').stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
  ['Sl.No', 'Buyer Name', 'Kilos', 'Value'].forEach((h, i) =>
    doc.text(h, cx[i] + PADX, vy2(y2, headH, 11), {
      width: cw[i] - PADX * 2, align: aligns2[i], lineBreak: false,
    }));
  buyerCols(y2, y2 + headH);
  y2 += headH;

  // Each buyer row wraps its name to multiple lines if needed; row height
  // grows to the tallest cell so long names like "POOJA GOWTHAM TRADING
  // COMPANY" show in full instead of being truncated.
  const lineH2 = 12;
  d.top5.forEach((b, i) => {
    const rTop = y2;
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    const cells = [String(i + 1), b.name, fmtQty(b.kilos), fmtMoney(b.value)];
    const cellLines = cells.map((v, ci) => wrapText(doc, String(v || ''), cw[ci] - PADX * 2));
    const maxLines = Math.max(...cellLines.map(l => l.length));
    const rH = Math.max(18, maxLines * lineH2 + 6);
    cells.forEach((v, ci) => {
      const w = cw[ci] - PADX * 2;
      const lines = cellLines[ci];
      let ty = rTop + (rH - lines.length * lineH2) / 2;
      lines.forEach(line => {
        doc.text(line, cx[ci] + PADX, ty, { width: w, align: aligns2[ci], lineBreak: false });
        ty += lineH2;
      });
    });
    y2 += rH;
    doc.moveTo(m, rTop).lineTo(m, y2).moveTo(m + usableW, rTop).lineTo(m + usableW, y2)
       .lineWidth(0.6).strokeColor('#000').stroke();
    buyerCols(rTop, y2);
    // Horizontal separator under each row so every row is delimited.
    doc.moveTo(m, y2).lineTo(m + usableW, y2).lineWidth(0.4).strokeColor('#000').stroke();
  });

  // TOTAL row — label centered across cols 1+2 (Sl.No + Buyer Name)
  const totTop = y2, totH = 20;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
  doc.text('TOTAL', cx[0] + PADX, vy2(totTop, totH, 11), {
    width: cw[0] + cw[1] - PADX * 2, align: 'center', lineBreak: false,
  });
  doc.text(fmtQty(d.top5Totals.kilos),   cx[2] + PADX, vy2(totTop, totH, 11), { width: cw[2] - PADX * 2, align: 'right', lineBreak: false });
  doc.text(fmtMoney(d.top5Totals.value), cx[3] + PADX, vy2(totTop, totH, 11), { width: cw[3] - PADX * 2, align: 'right', lineBreak: false });
  y2 += totH;
  doc.rect(m, totTop, usableW, y2 - totTop).lineWidth(0.7).strokeColor('#000').stroke();
  buyerCols(totTop, y2, { skipFrom: 0, skipTo: 1 });

  // ── Footer (Place / For COMPANY / Date / Signatory) ──
  y2 += 26;
  doc.font('Helvetica').fontSize(10).fillColor('#000');
  const halfW = usableW / 2;
  // Allow the company name to wrap on a second line so "For <very long
  // company name>" doesn't get clipped at the right edge.
  const placeLines  = wrapText(doc, `Place : ${d.place || ''}`, halfW);
  const forLines    = wrapText(doc, `For ${d.company || ''}`,   halfW);
  const lH = 14;
  const footerH = Math.max(placeLines.length, forLines.length) * lH;
  placeLines.forEach((ln, i) => doc.text(ln, m, y2 + i * lH, { width: halfW, align: 'left',  lineBreak: false }));
  forLines.forEach((ln, i)   => doc.text(ln, m + halfW, y2 + i * lH, { width: halfW, align: 'right', lineBreak: false }));
  y2 += footerH + 4;
  doc.text(`Date  : ${fmtDateDMY(ctx.auction.date)}`, m, y2, { lineBreak: false });
  y2 += 32;
  doc.font('Helvetica-Bold').fontSize(10)
     .text('Authorised Signatory', m, y2, { width: usableW, align: 'right', lineBreak: false });

  return new Promise(resolve => { doc.on('end', () => resolve(Buffer.concat(buffers))); doc.end(); });
}

// ════════════════════════════════════════════════════════════
// REPORT 3 — FORM-C (Auction Report)
// ════════════════════════════════════════════════════════════
// A seller is a "GSTIN dealer" when their registration string is a GSTIN
// (with or without the "GSTIN." prefix). Spices Board CS-prefixed dealers
// without a real GSTIN are still classified as DEALER by classifySeller
// but excluded from the GSTIN-dealer subtotal.
function isGstinDealer(cr) {
  let s = String(cr || '').trim().toUpperCase();
  if (s.startsWith('GSTIN.')) s = s.slice(6);
  else if (s.startsWith('GSTIN')) s = s.slice(5);
  return /^\d{2}[A-Z0-9]{13}$/.test(s);
}

function buildFormC(ctx) {
  const { auction, rows } = ctx;
  const planters = [], dealers = [];
  let maxRate = 0, minRate = Infinity, totalKilos = 0, totalValue = 0;
  for (const r of rows) {
    const seller = r.trader_name || r.seller_name || '';
    const cr = r.trader_cr || r.seller_cr || '';
    const place = r.trader_place || r.seller_place || '';
    const item = {
      lot:    r.lot,
      seller: seller,
      address: place,
      regId:  cr,
      qtyPut: Number(r.qty) || 0,
      qtySold: Number(r.qty) || 0,
      rate:   Number(r.price) || 0,
      value:  Number(r.amount) || 0,
      sample: Number(r.sample_refund || r.sample_refud) || 0,
      commission: Number(r.commission) || 0,
      buyer:  r.buyer1 || r.buyer_full || '',
      sbl:    r.buyer_sbl || '',
      hasGstin: isGstinDealer(cr),
    };
    // Form C bucketing rule (user spec): rows whose registration parses
    // as a GSTIN go under DEALERS; everything else (CR codes, blank,
    // Board CS-codes without a GSTIN) goes under PLANTERS. The legacy
    // classifySeller() CS-prefix rule is no longer used here — it
    // mis-classified Spices Board CS dealers without a GSTIN as dealers.
    (item.hasGstin ? dealers : planters).push(item);
    if (item.rate > maxRate) maxRate = item.rate;
    if (item.rate < minRate && item.rate > 0) minRate = item.rate;
    totalKilos += item.qtySold; totalValue += item.value;
  }
  // Sort each bucket by Estate Registration # / Board Licence # so the
  // PDF, Excel, and JSON outputs are deterministic and grouped by SBL.
  // Empty/non-numeric IDs sink to the bottom of their bucket.
  const _sblSort = (a, b) => {
    const aw = String(a.regId || '').trim();
    const bw = String(b.regId || '').trim();
    if (!aw && bw) return 1;
    if (aw && !bw) return -1;
    return aw.localeCompare(bw, 'en', { numeric: true, sensitivity: 'base' });
  };
  planters.sort(_sblSort);
  dealers.sort(_sblSort);
  if (!isFinite(minRate)) minRate = 0;
  const avg = totalKilos > 0 ? totalValue / totalKilos : 0;
  const sum = arr => arr.reduce((a, x) => ({ kilos: a.kilos + x.qtySold, value: a.value + x.value }), { kilos: 0, value: 0 });
  // Dealers ARE the GSTIN dealers now (the planter/dealer split is keyed
  // on isGstinDealer). Keep `gstinDealers`/`gstinDealerTotals` for API
  // back-compat but they're identical to `dealers`/`dealersTotals`.
  return {
    auction, planters, dealers,
    plantersTotals: sum(planters), dealersTotals: sum(dealers),
    gstinDealers: dealers,
    gstinDealerTotals: sum(dealers),
    grand: { kilos: totalKilos, value: totalValue },
    maxRate, minRate, avgRate: avg,
  };
}

function formCJson(db, opts) {
  const ctx = getReportContext(db, opts);
  const d = buildFormC(ctx);
  const licence = readSetting(db, 'sbl', '');
  const seasonStart = readSetting(db, 'season_start_year', '');
  const seasonEnd   = readSetting(db, 'season_end_year', '');
  const season = (seasonStart && seasonEnd) ? `${seasonStart} - ${seasonEnd}` : readSetting(db, 'season', '');
  const cols = [
    { key: 'slNo',       header: 'Sl.No' },
    { key: 'seller',     header: 'Name and full address of the planter/dealer' },
    { key: 'regId',      header: 'Estate Registration #/Board licence #' },
    { key: 'qtyPut',     header: 'Qty put for auction', numeric: true, fmt: 'qty' },
    { key: 'qtySold',    header: 'Qty sold (kgs)', numeric: true, fmt: 'qty' },
    { key: 'rate',       header: 'Rate Rs./kg', numeric: true, fmt: 'price' },
    { key: 'value',      header: 'Value (Rs.)', numeric: true, fmt: 'money' },
    { key: 'sample',     header: 'Sample Refund (Rs.)', numeric: true, fmt: 'money' },
    { key: 'commission', header: 'Commission (Rs.)', numeric: true, fmt: 'money' },
    { key: 'buyer',      header: 'Name and full address of bidder' },
    { key: 'sbl',        header: 'Spices Board licence number' },
  ];
  const numberRows = arr => arr.map((r, i) => Object.assign({ slNo: i + 1 }, r));
  return {
    title: 'FORM - C (Auction Report)',
    auction: { ano: ctx.auction.ano, date: fmtDateDMY(ctx.auction.date), state: ctx.auction.state },
    meta: { licence, season, maxRate: d.maxRate, minRate: d.minRate, avgRate: d.avgRate },
    columns: cols,
    sections: [
      { title: 'PLANTERS', rows: numberRows(d.planters), totals: { label: 'PLANTERS TOTAL', qtyPut: d.plantersTotals.kilos, qtySold: d.plantersTotals.kilos, value: d.plantersTotals.value } },
      { title: 'DEALERS',  rows: numberRows(d.dealers),  totals: { label: 'DEALERS TOTAL',  qtyPut: d.dealersTotals.kilos,  qtySold: d.dealersTotals.kilos,  value: d.dealersTotals.value } },
    ],
    grand: { label: 'GRAND TOTAL', qtyPut: d.grand.kilos, qtySold: d.grand.kilos, value: d.grand.value },
  };
}

async function formCXlsx(db, opts) {
  _loadDateFormat(db);
  const ctx = getReportContext(db, opts);
  const d   = buildFormC(ctx);
  const licence = readSetting(db, 'sbl', '');
  const seasonStart = readSetting(db, 'season_start_year', '');
  const seasonEnd   = readSetting(db, 'season_end_year', '');
  const season = (seasonStart && seasonEnd) ? `${seasonStart} - ${seasonEnd}` : readSetting(db, 'season', '');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('FormC');
  ws.columns = [
    { width: 6 }, { width: 28 }, { width: 18 }, { width: 12 }, { width: 12 },
    { width: 10 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 26 }, { width: 22 },
  ];
  writeXlsxCompanyHeader(wb, ws, getCompanyHeader(db), {
    colCount: 11, title: 'FORM C — Auction Report',
    metaLines: [
      `e-Auction Licence: ${licence}`,
      `Season: ${season}`,
      `Auction No: ${ctx.auction.ano}    Date: ${fmtDateDMY(ctx.auction.date)}`,
      `Max: ${fmtPrice(d.maxRate)}   Min: ${fmtPrice(d.minRate)}   Avg: ${fmtPrice(d.avgRate)}`,
    ].filter(Boolean),
  });
  const heads = ['Sl.No', 'Name & address of planter/dealer', 'Estate Reg / Licence #', 'Qty put', 'Qty sold (kgs)',
                 'Rate Rs./kg', 'Value (Rs.)', 'Sample Refund', 'Commission', 'Bidder', 'Spices Board Licence'];
  const head = ws.addRow(heads);
  head.font = { bold: true, size: 9 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E4DD' } };
  head.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
                       c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  function emitSection(title, rows, totals) {
    if (!rows.length) return;
    const sec = ws.addRow([title]);
    ws.mergeCells(`A${sec.number}:K${sec.number}`);
    sec.font = { bold: true, size: 10 };
    sec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
    // Strip the season-year hyphen in registration IDs (e.g.
    // "CS/55450/520/23-24" → "CS/55450/520/2324") so Excel renders the
    // ID on a single line and Spice Board's import doesn't choke on
    // the cosmetic dash.
    const stripYearHyphen = (s) =>
      String(s == null ? '' : s).trim().replace(/(\d{2})-(\d{2})\b/g, '$1$2');
    rows.forEach((r, i) => {
      const dr = ws.addRow([i + 1, r.seller, stripYearHyphen(r.regId), r.qtyPut, r.qtySold, r.rate, r.value, r.sample, r.commission, r.buyer, stripYearHyphen(r.sbl)]);
      dr.getCell(4).numFmt = '#,##0.000'; dr.getCell(5).numFmt = '#,##0.000';
      dr.getCell(6).numFmt = '#,##0.00';  dr.getCell(7).numFmt = '#,##,##0.00';
      dr.getCell(8).numFmt = '#,##0.00';  dr.getCell(9).numFmt = '#,##0.00';
    });
    const t = ws.addRow(['', totals.label, '', totals.qtyPut, totals.qtySold, '', totals.value, '', '', '', '']);
    t.font = { bold: true };
    t.getCell(4).numFmt = '#,##0.000'; t.getCell(5).numFmt = '#,##0.000'; t.getCell(7).numFmt = '#,##,##0.00';
    t.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
                      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F5F2' } }; });
    ws.addRow([]);
  }
  emitSection('PLANTERS', d.planters, { label: 'PLANTERS TOTAL', qtyPut: d.plantersTotals.kilos, qtySold: d.plantersTotals.kilos, value: d.plantersTotals.value });
  emitSection('DEALERS',  d.dealers,  { label: 'DEALERS TOTAL',  qtyPut: d.dealersTotals.kilos,  qtySold: d.dealersTotals.kilos,  value: d.dealersTotals.value });
  // GRAND TOTAL = planters + dealers. (DEALERS == GSTIN dealers now —
  // see classification rule in buildFormC — so no separate GSTIN row.)
  const g = ws.addRow(['', 'GRAND TOTAL', '', d.grand.kilos, d.grand.kilos, '', d.grand.value, '', '', '', '']);
  g.font = { bold: true, size: 11 };
  g.getCell(4).numFmt = '#,##0.000'; g.getCell(5).numFmt = '#,##0.000'; g.getCell(7).numFmt = '#,##,##0.00';
  g.eachCell(c => { c.border = { top: { style: 'double' }, bottom: { style: 'double' } };
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }; });
  return wb.xlsx.writeBuffer();
}

async function formCPdf(db, opts) {
  _loadDateFormat(db);
  const ctx = getReportContext(db, opts);
  const d   = buildFormC(ctx);
  const licence = readSetting(db, 'sbl', '');
  const seasonStart = readSetting(db, 'season_start_year', '');
  const seasonEnd   = readSetting(db, 'season_end_year', '');
  const season = (seasonStart && seasonEnd) ? `${seasonStart} - ${seasonEnd}` : readSetting(db, 'season', '');
  // Place — configured Office Branch for the active business state.
  const _fcBS = String(readSetting(db, 'business_state', '')).toUpperCase();
  const _fcKL = _fcBS === 'KERALA' || _fcBS === 'KL';
  const place = readSetting(db, _fcKL ? 'kl_branch' : 'tn_branch',
                  readSetting(db, 'tn_branch',
                    readSetting(db, 'kl_branch',
                      readSetting(db, 'business_place', ''))));

  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 18 });
  const buffers = []; doc.on('data', b => buffers.push(b));
  const m = 18, usableW = doc.page.width - m * 2;

  // ── 11-column geometry — proportions tuned for portrait A4
  // (~559pt usable). Numeric cols stay narrow but readable at 7pt; the two
  // free-text columns (planter/dealer + bidder) get the most width.
  const cw = [
    Math.floor(usableW * 0.04),   // 1  Sl.No
    Math.floor(usableW * 0.16),   // 2  Name & address of planter/dealer
    Math.floor(usableW * 0.10),   // 3  Estate Registration #/Board licence #
    Math.floor(usableW * 0.07),   // 4  Qty put for auction
    Math.floor(usableW * 0.07),   // 5  Qty sold (kgs)
    Math.floor(usableW * 0.06),   // 6  Rate Rs./kg
    Math.floor(usableW * 0.10),   // 7  Value (Rs.)
    Math.floor(usableW * 0.07),   // 8  Sample Refund (Rs.)
    Math.floor(usableW * 0.07),   // 9  Commission (Rs.)
    Math.floor(usableW * 0.155),  // 10 Bidder name & address
    0,                            // 11 Spices Board licence number
  ];
  cw[10] = usableW - cw.slice(0, 10).reduce((a, b) => a + b, 0);
  const cx = [m]; for (let i = 0; i < cw.length - 1; i++) cx.push(cx[i] + cw[i]);
  // Reference alignment: Sl.No center, names + bidder + licence left, all
  // numeric columns right.  Headers always centered above their column.
  const aligns = ['center', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left'];
  // Single-string column headers — wrapText handles line breaks at word
  // boundaries so words never split mid-character. Previous version
  // pre-split into chunks like "Estate Regis / tration #/Bo / ard
  // licence#" which produced ugly wrappings (single letters on new
  // lines, broken words). Hyphenated-style breaks are introduced as
  // explicit slashes / spaces so the wrapper has natural break points.
  const headTitles = [
    'Sl. No.',
    'Name and full address of the planter / dealer',
    'Estate Registration # / Board licence #',
    'Qty put for auction',
    'Qty sold (kgs)',
    'Rate Rs./kg',
    'Value (Rs.)',
    'Sample Refund (Rs.)',
    'Commission (Rs.)',
    'Name and full address of bidder',
    'Spices Board licence number',
  ];
  const PADX = 2;          // tight padding for portrait
  let y;

  function vy(top, rowH, fontH) { return top + (rowH - fontH) / 2; }

  // Skip column separators inside [skipFrom..skipTo] so a merged label can flow.
  function drawColSeparators(top, bottom, opts) {
    opts = opts || {};
    const lw = opts.lw || 0.4;
    const sf = opts.skipFrom == null ? -1 : opts.skipFrom;
    const st = opts.skipTo   == null ? -1 : opts.skipTo;
    for (let i = 1; i < cw.length; i++) {
      if (i > sf && i <= st) continue;
      doc.moveTo(cx[i], top).lineTo(cx[i], bottom).lineWidth(lw).strokeColor('#000').stroke();
    }
  }

  function topHeader() {
    y = m;
    // Logo (Task 9) — anchored top-left so the centered title remains
    // visually balanced. We then advance Y to clear the logo height.
    const _hdrFC = getCompanyHeader(db);
    const LOGO_H_FC = 40;
    if (_hdrFC && _hdrFC.logoPath) {
      try { doc.image(_hdrFC.logoPath, m, y, { fit: [LOGO_H_FC, LOGO_H_FC] }); }
      catch (_) { /* ignore */ }
    }
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(12)
       .text('FORM C', m, y, { width: usableW, align: 'center', lineBreak: false });
    y += 16;
    doc.font('Helvetica').fontSize(9.5)
       .text('See rules 5(2) and 10(1)(R)', m, y, { width: usableW, align: 'center', lineBreak: false });
    y += 14;
    doc.font('Helvetica-Bold').fontSize(10.5)
       .text('Auction Report', m, y, { width: usableW, align: 'center', lineBreak: false });
    y += 14;
    doc.font('Helvetica').fontSize(7.5)
       .text('(Separate report should be furnished for auctioning of cardamom received from (1) Planter (2) Dealer)',
             m, y, { width: usableW, align: 'center', lineBreak: false });
    y += 14;
    // Meta layout:
    //   Row 0 (full width): E-Auction Licence No  — own line so a long
    //                       licence string never wraps inside a narrow
    //                       1/3 column.
    //   Row 1: eAuction No    | SEASON       | Maximum Price
    //   Row 2: Date of auction|              | Minimum Price
    //   Row 3:                |              | Average Price
    const colW3   = usableW / 3;
    const lLeft   = m;
    const lMid    = m + colW3;
    const lRight  = m + colW3 * 2;
    const lineH   = 13;
    doc.font('Helvetica').fontSize(8.5).fillColor('#000');
    function metaCell(text, x, w, align) {
      const lines = wrapText(doc, text, w);
      lines.forEach((ln, i) => doc.text(ln, x, y + i * lineH, { width: w, align, lineBreak: false }));
      return lines.length;
    }
    // Row 0 — Licence on its own full-width line, left aligned.
    const h0 = metaCell(`E-Auction Licence No: ${licence}`, lLeft, usableW, 'left');
    y += h0 * lineH;
    // Row 1
    let h1 = 1;
    h1 = Math.max(h1, metaCell(`eAuction No: ${ctx.auction.ano}`,                  lLeft,  colW3, 'left'));
    h1 = Math.max(h1, metaCell(`SEASON: ${season}`,                                lMid,   colW3, 'center'));
    h1 = Math.max(h1, metaCell(`Maximum Price:Rs. ${fmtPrice(d.maxRate)}`,         lRight, colW3, 'right'));
    y += h1 * lineH;
    // Row 2
    let h2 = 1;
    h2 = Math.max(h2, metaCell(`Date of auction: ${fmtDateDMY(ctx.auction.date)}`, lLeft,  colW3, 'left'));
    h2 = Math.max(h2, metaCell(`Minimum Price:Rs. ${fmtPrice(d.minRate)}`,         lRight, colW3, 'right'));
    y += h2 * lineH;
    // Row 3 — Average price only
    let h3 = 1;
    h3 = Math.max(h3, metaCell(`Average Price:Rs. ${fmtPrice(d.avgRate)}`,         lRight, colW3, 'right'));
    y += h3 * lineH;
    y += 6;
    drawHeadRow();
  }

  function drawHeadRow() {
    // Header height grows to accommodate the wrapped column titles.
    // Auto-shrink the header font so titles fit each column on a single
    // line when possible; only wrap onto a second line when the column is
    // truly too narrow even at the minimum font size. This prevents the
    // "single letter on a new line" artefact that the previous fixed
    // 6.5pt + word-wrap chain produced for awkward column widths.
    const lineH = 8;
    doc.fillColor('#000').font('Helvetica');
    // Per-column font size: start at 7pt, shrink down to 5.5pt only if
    // needed to keep the title on one line.
    const colFontSizes = headTitles.map((title, i) => {
      const w = cw[i] - PADX * 2;
      let size = 7;
      while (size > 5.5) {
        doc.fontSize(size);
        if (doc.widthOfString(title) <= w) return size;
        size -= 0.25;
      }
      return 5.5;
    });
    const wrapped = headTitles.map((title, i) => {
      const w = cw[i] - PADX * 2;
      doc.fontSize(colFontSizes[i]);
      return wrapText(doc, title, w);
    });
    const HEAD_H = Math.max(32, Math.max(...wrapped.map(l => l.length)) * lineH + 6);
    const top = y;
    doc.rect(m, y, usableW, HEAD_H).lineWidth(0.7).strokeColor('#000').stroke();
    wrapped.forEach((lines, i) => {
      const w = cw[i] - PADX * 2;
      doc.fontSize(colFontSizes[i]);
      let ty = y + (HEAD_H - lines.length * lineH) / 2;
      lines.forEach(line => {
        doc.text(line, cx[i] + PADX, ty, { width: w, align: 'center', lineBreak: false });
        ty += lineH;
      });
    });
    drawColSeparators(top, top + HEAD_H);
    y += HEAD_H;
    const numTop = y, numH = 12;
    doc.rect(m, y, usableW, numH).lineWidth(0.6).strokeColor('#000').stroke();
    doc.font('Helvetica').fontSize(7);
    for (let i = 0; i < cw.length; i++) {
      doc.text(String(i + 1), cx[i] + PADX, vy(numTop, numH, 8), {
        width: cw[i] - PADX * 2, align: 'center', lineBreak: false,
      });
    }
    drawColSeparators(numTop, numTop + numH);
    y += numH;
  }

  function ensureRoom(n) { if (y + n > doc.page.height - m - 10) { doc.addPage(); topHeader(); } }

  // Normalise an ID-like value (CR/Estate Registration #) so it doesn't
  // wrap at incidental hyphens. The Spice Board pattern uses a trailing
  // year range like "CS/55450/520/23-24"; the season-year hyphen is
  // purely cosmetic and breaks the value across two lines when the
  // column is narrow. We collapse just THAT trailing "NN-NN" segment
  // into "NNNN" (e.g. "23-24" → "2324") — other internal hyphens (rare,
  // but possible in dealer codes) are left alone.
  function normaliseRegId(s) {
    if (!s) return '';
    return String(s).trim().replace(/(\d{2})-(\d{2})\b/g, '$1$2');
  }
  // Find the largest font size in [minSize..baseSize] (0.25pt steps) at
  // which `text` renders on a single line within `maxWidth`. Returns
  // null when even at minSize it still wraps — caller should fall back
  // to multi-line wrap.
  function fitFontSize(text, maxWidth, baseSize, minSize) {
    if (!text) return baseSize;
    const prevSize = doc._fontSize;
    let size = baseSize;
    while (size >= minSize) {
      doc.fontSize(size);
      if (doc.widthOfString(text) <= maxWidth) {
        doc.fontSize(prevSize);
        return size;
      }
      size -= 0.25;
    }
    doc.fontSize(prevSize);
    return null;
  }

  function row(r, idx, sectionStartIdx) {
    const slNo = String(sectionStartIdx + idx + 1).padStart(3, '0');
    const BASE_FONT = 6.5;
    const MIN_FONT  = 5.0;
    doc.fillColor('#000').font('Helvetica').fontSize(BASE_FONT);
    const cells = [
      slNo, r.seller, normaliseRegId(r.regId),
      fmtQty(r.qtyPut), fmtQty(r.qtySold), fmtPrice(r.rate),
      fmtMoney(r.value), fmtMoney(r.sample), fmtMoney(r.commission),
      r.buyer, normaliseRegId(r.sbl),
    ];
    const lineH = 8;
    // For each cell: try to fit on ONE line by shrinking the font down
    // to MIN_FONT. Only if it still doesn't fit at MIN_FONT do we wrap
    // to multiple lines (at MIN_FONT) — so ID-like values such as
    // "CS/55450/520/2324" always render on a single line.
    const cellFontSizes = cells.map((v, ci) => {
      const w = cw[ci] - PADX * 2;
      const text = String(v || '');
      return fitFontSize(text, w, BASE_FONT, MIN_FONT) || MIN_FONT;
    });
    const cellLines = cells.map((v, ci) => {
      doc.fontSize(cellFontSizes[ci]);
      return wrapText(doc, String(v || ''), cw[ci] - PADX * 2);
    });
    const rowH = Math.max(11, Math.max(...cellLines.map(l => l.length)) * lineH + 4);
    ensureRoom(rowH);
    const top = y;
    cellLines.forEach((lines, ci) => {
      const w = cw[ci] - PADX * 2;
      doc.fontSize(cellFontSizes[ci]);
      let ty = top + (rowH - lines.length * lineH) / 2;
      lines.forEach(line => {
        doc.text(line, cx[ci] + PADX, ty, { width: w, align: aligns[ci], lineBreak: false });
        ty += lineH;
      });
    });
    y = top + rowH;
    doc.moveTo(m, top).lineTo(m, y).moveTo(m + usableW, top).lineTo(m + usableW, y)
       .lineWidth(0.5).strokeColor('#000').stroke();
    // Full-width horizontal separator after every data row, so the listing
    // reads as a proper ruled grid (previously only the left/right borders and
    // column separators were drawn, leaving rows visually unseparated).
    doc.moveTo(m, y).lineTo(m + usableW, y).lineWidth(0.4).strokeColor('#000').stroke();
    drawColSeparators(top, y);
  }

  // Totals row — uses the SAME font size as data rows (6.5pt) so the
  // formatted numeric values stay within their narrow columns. Larger fonts
  // overflow into the merged-label area on the left, which is what produced
  // the visible overlap. Bold + slightly taller row keeps totals visually
  // distinct without needing a bigger font.
  function totalsRow(label, totals, opts) {
    opts = opts || {};
    const isGrand = !!opts.grand;
    const baseFont = isGrand ? 7.5 : 7;
    const MIN_FONT = 5.0;
    doc.font('Helvetica-Bold').fillColor('#000');
    const labelW = cw[0] + cw[1] + cw[2] - PADX * 2;
    const cells = [
      { x: cx[0] + PADX, w: labelW,                  text: label,                   align: 'center' },
      { x: cx[3] + PADX, w: cw[3] - PADX * 2,        text: fmtQty(totals.qtyPut),   align: 'right' },
      { x: cx[4] + PADX, w: cw[4] - PADX * 2,        text: fmtQty(totals.qtySold),  align: 'right' },
      { x: cx[6] + PADX, w: cw[6] - PADX * 2,        text: fmtMoney(totals.value),  align: 'right' },
    ];
    // Auto-shrink each cell so the big totals numbers (e.g.
    // "13,62,049.000") render on a single line. Only wrap to a second
    // line if even MIN_FONT can't fit — previously 7pt + word-wrap split
    // numbers across two lines, often with two digits dangling on the
    // second line.
    const cellFontSizes = cells.map(c => fitFontSize(c.text, c.w, baseFont, MIN_FONT) || MIN_FONT);
    const wrapped = cells.map((c, i) => {
      doc.fontSize(cellFontSizes[i]);
      return wrapText(doc, c.text, c.w);
    });
    const lineH = baseFont + 2;
    const maxLines = Math.max(...wrapped.map(l => l.length));
    const H = Math.max(isGrand ? 18 : 16, maxLines * lineH + 4);
    const top = y;
    cells.forEach((c, i) => {
      const lines = wrapped[i];
      doc.fontSize(cellFontSizes[i]);
      let ty = top + (H - lines.length * lineH) / 2;
      lines.forEach(line => {
        doc.text(line, c.x, ty, { width: c.w, align: c.align, lineBreak: false });
        ty += lineH;
      });
    });
    y = top + H;
    doc.rect(m, top, usableW, y - top).lineWidth(isGrand ? 0.9 : 0.7).strokeColor('#000').stroke();
    drawColSeparators(top, y, { skipFrom: 0, skipTo: 2 });
  }

  topHeader();

  let runningStart = 0;
  function emitSection(title, rows, totals) {
    if (!rows.length) return;
    rows.forEach((r, i) => row(r, i, runningStart)); // row() handles its own pagination
    ensureRoom(18);
    totalsRow(title, totals);
    runningStart += rows.length;
  }
  emitSection('PLANTERS TOTAL', d.planters, { qtyPut: d.plantersTotals.kilos, qtySold: d.plantersTotals.kilos, value: d.plantersTotals.value });
  emitSection('DEALERS TOTAL',  d.dealers,  { qtyPut: d.dealersTotals.kilos,  qtySold: d.dealersTotals.kilos,  value: d.dealersTotals.value });

  // GRAND TOTAL = planters + dealers. (DEALERS == GSTIN dealers now —
  // see classification rule in buildFormC — so no separate GSTIN row.)
  ensureRoom(20);
  totalsRow('GRAND TOTAL', { qtyPut: d.grand.kilos, qtySold: d.grand.kilos, value: d.grand.value }, { grand: true });

  // Auctioneer confirmation block (matches reference verbatim)
  ensureRoom(70);
  y += 10;
  doc.font('Helvetica').fontSize(7.5).fillColor('#000');
  const confirmation =
    'I/We confirm that no discount or commission other than the one per cent commission permitted to me/us by the rules has been ' +
    'accepted by me/us or received from the owners of cardamom sold in the auction and nor have I/We passed on any cardamom or ' +
    'commission to the purchasers.';
  doc.text(confirmation, m, y, { width: usableW, align: 'justify' });
  y = doc.y + 16;
  doc.font('Helvetica').fontSize(9);
  doc.text(`Place :${place || ''}`, m, y, { width: usableW / 2, align: 'left',  lineBreak: false });
  doc.text('Signature of the auctioneer', m + usableW / 2, y, { width: usableW / 2, align: 'right', lineBreak: false });
  y += 14;
  doc.text(`Date  :${fmtDateDMY(ctx.auction.date)}`, m, y, { lineBreak: false });

  return new Promise(resolve => { doc.on('end', () => resolve(Buffer.concat(buffers))); doc.end(); });
}

// ════════════════════════════════════════════════════════════
// REPORT 4 — e-Auction (Spices Board) CSV export (Task 7)
// ════════════════════════════════════════════════════════════
// One row per lot. Columns intentionally match the Spices Board portal
// upload schema so users can hand it straight off to the regulator
// without massaging. All company-facing values are sourced from
// `cfg`/settings (no hardcoded fallbacks beyond a defensive "" empty).
// Decimal precision: kg → 3dp, price → 2dp, value/refund/commission → 2dp.
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
async function eauctionCsv(db, opts) {
  const ctx = getReportContext(db, opts);

  // Spice Board portal upload schema. 20 columns, one row per lot.
  // Headers + column order match the ITCPC reference CSV exactly so
  // the file lands on the portal without any post-processing.
  //   - Column C "Planter/Dealer": 1 = planter (CR.* or blank CR),
  //     2 = dealer (CS/* GSTIN-prefixed). Sourced from the seller's
  //     registration string via classifySeller().
  //   - Column F "Crop Receipt Number": from lots.crpt (entered in
  //     Lot Entry — auto-increments per lot, editable).
  //   - Column L "Reserved Price": from lots.reserved_price (Lot
  //     Entry; flag-gated input).
  //   - Column M "Auction Start Price(Rs)": blank — not currently
  //     captured in the lot row.
  //   - Other blanks (J/N/Q/S/T) follow the portal's sample template
  //     where the board fills them in post-upload.
  const headers = [
    'Lot Number',              // A
    'Collection Centre',       // B
    'Planter/Dealer',          // C
    'Planter Name',            // D
    'CRNO/SBL No',             // E
    'Crop Receipt Number',     // F
    'Quantity(Kg)',            // G
    'Litre Weight(Gms)',       // H
    'Bags',                    // I
    'Grade Type',              // J  (filled by board after grading)
    'Grade',                   // K
    'Reserved Price',          // L
    'Auction Start Price(Rs)', // M
    'Immature Seeds(%)',       // N
    'Moisture Content(%)',     // O
    'Planter Mobile Number',   // P
    'Special Lot (Yes/No)',    // Q
    'Colour ',                 // R  (trailing space mirrors the reference template)
    'Size',                    // S
    'Rejection/Split',         // T
  ];
  const lines = [headers.map(csvEscape).join(',')];

  const fmt1 = n => {
    const v = Number(n || 0);
    return Number.isFinite(v) && v !== 0 ? v.toFixed(1) : '';
  };
  // Reserved price renders as integer when the operator typed a whole
  // number; otherwise up to 2 dp. Blank when 0/null.
  const fmtReserved = n => {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v === 0) return '';
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  };
  // litre/moisture/tel come through as TEXT in the schema — keep them
  // as-is so manually entered values like "430" or "6.9" round-trip
  // exactly to the portal without any formatter side-effects.
  const passText = v => (v == null ? '' : String(v).trim());

  for (const r of (ctx.rows || [])) {
    // Planter/Dealer code: 1 for planter, 2 for dealer.
    const cr = r.seller_cr || r.trader_cr || '';
    const planterOrDealer = classifySeller(cr) === 'DEALER' ? '2' : '1';

    lines.push([
      r.lot || '',                                       // A  Lot Number
      r.branch || '',                                    // B  Collection Centre (branch — VANDANMEDU, PARATHODU, …)
      planterOrDealer,                                   // C  Planter/Dealer (1 / 2)
      r.trader_name || r.seller_name || '',              // D  Planter Name
      cr,                                                // E  CRNO/SBL No
      passText(r.crpt),                                  // F  Crop Receipt Number  ← Lot Entry
      fmt1(r.qty),                                       // G  Quantity(Kg)
      passText(r.litre),                                 // H  Litre Weight(Gms)
      r.bags != null ? String(r.bags) : '',              // I  Bags
      '',                                                // J  Grade Type
      passText(r.grade),                                 // K  Grade
      fmtReserved(r.reserved_price),                     // L  Reserved Price  ← Lot Entry
      '',                                                // M  Auction Start Price(Rs)
      '',                                                // N  Immature Seeds(%)
      passText(r.moisture),                              // O  Moisture Content(%)
      passText(r.seller_tel),                            // P  Planter Mobile Number
      '',                                                // Q  Special Lot (Yes/No)
      'green',                                           // R  Colour  (cardamom)
      '',                                                // S  Size
      '',                                                // T  Rejection/Split
    ].map(csvEscape).join(','));
  }

  // Returning a Buffer keeps the dispatcher contract uniform with the
  // xlsx/pdf siblings (which already return Buffer / Promise<Buffer>).
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

// ════════════════════════════════════════════════════════════
// Dispatcher
// ════════════════════════════════════════════════════════════
const REPORTS = {
  buyers_statement: { label: 'Buyers Statement', name: 'BuyersStatement',
                      json: buyersStatementJson, xlsx: buyersStatementXlsx, pdf: buyersStatementPdf },
  form_d:           { label: 'FORM-D (Advance Auction Report)', name: 'FormD',
                      json: formDJson, xlsx: formDXlsx, pdf: formDPdf },
  form_c:           { label: 'FORM-C (Auction Report)', name: 'FormC',
                      json: formCJson, xlsx: formCXlsx, pdf: formCPdf },
  eauction_csv:     { label: 'e-Auction (Spices Board) CSV', name: 'EAuctionCSV',
                      csv: eauctionCsv },
};

module.exports = { REPORTS, getReportFilters };
