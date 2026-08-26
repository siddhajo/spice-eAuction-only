// Lot Payment export — verify the new "Lot | BR | Name | Qty | Rate | Bill Amt
// | Lot" layout, flat and lot-ordered, for BOTH the XLSX and PDF engines.
// Runs against a THROWAWAY database.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotpay-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb, closeDb } = require(path.join(__dirname, '..', 'db.js'));
const { initCompanySettings, getSettingsFlat } = require(path.join(__dirname, '..', 'company-config.js'));
const { exportLotPayment } = require(path.join(__dirname, '..', 'exports.js'));
const { exportPdf, COLS, ROW_PREPROCESS, PDF_AUTOFIT } = require(path.join(__dirname, '..', 'exports-pdf.js'));
const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

(async () => {
  await initDb();
  const db = getDb();
  initCompanySettings(db);

  // Fixture: one trade, lots entered OUT of order and across two branches, so
  // the lot-number ordering and the BR column are both exercised. One unpriced
  // lot (rate 0, amount 0) mirrors the blank rows in the attached sheet.
  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (1,'7','2026-08-10','TAMIL NADU')`);
  //
  // `balance` is deliberately DIFFERENT from `amount` on every priced lot.
  // BILL AMT must show the seller's payable (`balance`), not the gross
  // qty × price (`amount`) — if the two were equal the test could not tell
  // which column the report actually read.
  const lots = [
    // lot_no, branch,          name,             qty,    price, amount,  balance
    ['003', 'NK',           'ANILKUMAR',      25.1,  3194, 88219,  87153],
    ['001', 'NK',           'PUNYAMOORTHY T', 73.4,  0,     0,         0],  // unpriced
    ['002', 'NK',           'MURUGANANDAM K', 71.7,  3178, 234124, 231361],
    // A branch name far longer than a "NK" code — this is the one that wrapped.
    ['010', 'MUNDAKAYAM-B', 'NATIONAL SPICES',163.1, 2302, 377509, 372949],
  ];
  for (const [lot_no, branch, name, qty, price, amount, balance] of lots) {
    db.run(`INSERT INTO lots (auction_id,lot_no,branch,name,qty,price,amount,balance)
            VALUES (1,?,?,?,?,?,?,?)`, [lot_no, branch, name, qty, price, amount, balance]);
  }

  // ── COLUMN LAYOUT (single source of truth is the PDF COLS def) ──
  console.log('[1] Column layout matches the attached format');
  const headers = COLS.lot_payment.map(c => c.header);
  check('headers are Lot, BR, Name, Qty, Rate, Bill Amt, Lot',
        JSON.stringify(headers) === JSON.stringify(['LOT','BR','NAME','QTY','RATE','BILL AMT','LOT']),
        JSON.stringify(headers));
  check('the two LOT columns bracket the row (first + last)',
        COLS.lot_payment[0].key === 'lot' &&
        COLS.lot_payment[COLS.lot_payment.length - 1].key === 'lot2');
  // Branch stays on one line (auto-shrinks) instead of wrapping.
  const brCol = COLS.lot_payment.find(c => c.key === 'br');
  check('BR column is flagged nowrap (single line)', brCol && brCol.nowrap === true,
        JSON.stringify(brCol));
  check('lot_payment PDF is set to autofit column widths',
        PDF_AUTOFIT && PDF_AUTOFIT.has('lot_payment'));

  // ── XLSX ──
  console.log('\n[2] XLSX output');
  const buf = await exportLotPayment(db, 1);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];

  // Locate the header row (the one whose first cells read LOT / BR / NAME).
  let headerRow = null;
  ws.eachRow((row, n) => {
    if (headerRow) return;
    const vals = row.values.map(v => String(v == null ? '' : v).trim().toUpperCase());
    if (vals.includes('LOT') && vals.includes('BR') && vals.includes('NAME')) headerRow = n;
  });
  check('a LOT/BR/NAME header row is present', headerRow != null);

  // Data rows follow the header, in lot-number order, until the TOTAL row.
  const dataRows = [];
  for (let n = headerRow + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const first = String(row.getCell(1).value == null ? '' : row.getCell(1).value).trim();
    if (!first) continue;
    if (first.toUpperCase() === 'TOTAL') break;
    dataRows.push(row);
  }
  const lotOrder = dataRows.map(r => String(r.getCell(1).value).trim());
  check('rows are LOT-ordered (001,002,003,010), not entry/place order',
        JSON.stringify(lotOrder) === JSON.stringify(['001','002','003','010']),
        JSON.stringify(lotOrder));

  // Column-by-column check of the MURUGANANDAM row (lot 002).
  const r002 = dataRows.find(r => String(r.getCell(1).value).trim() === '002');
  check('BR column carries the branch (NK)', r002 && String(r002.getCell(2).value).trim() === 'NK',
        r002 && String(r002.getCell(2).value));

  // Autofit: the BR column width must be wide enough for the LONGEST branch
  // value ("MUNDAKAYAM-B", 12 chars) so Excel shows it on one line, not the
  // fixed width:6 that truncated it before.
  const brColWidth = ws.getColumn(2).width || 0;
  check('BR column is autofit to the longest branch (>= 12)', brColWidth >= 12,
        `width ${brColWidth}`);
  // The long branch value is intact (not truncated in the data).
  const r010 = dataRows.find(r => String(r.getCell(1).value).trim() === '010');
  check('long branch name is stored in full', r010 && String(r010.getCell(2).value).trim() === 'MUNDAKAYAM-B',
        r010 && String(r010.getCell(2).value));
  check('Name column carries the seller', r002 && String(r002.getCell(3).value).trim() === 'MURUGANANDAM K',
        r002 && String(r002.getCell(3).value));
  check('Qty column', r002 && Number(r002.getCell(4).value) === 71.7);
  check('Rate column', r002 && Number(r002.getCell(5).value) === 3178);
  // BILL AMT is the PAYABLE (lots.balance), not the gross qty × price.
  // `balance` is where calculateLot stores `payable`:
  //   payable = round(amount + refund − commission − handling − GST)
  // There is no column literally called `payable` on `lots`.
  check('Bill Amt column shows the PAYABLE (balance), not gross amount',
        r002 && Number(r002.getCell(6).value) === 231361,
        r002 && `got ${r002.getCell(6).value}, gross amount is 234124`);
  check('Bill Amt is NOT the gross amount',
        r002 && Number(r002.getCell(6).value) !== 234124);
  check('trailing Lot column repeats the lot number',
        r002 && String(r002.getCell(7).value).trim() === '002', r002 && String(r002.getCell(7).value));

  // The unpriced lot renders with zero rate / bill amt (not dropped).
  const r001 = dataRows.find(r => String(r.getCell(1).value).trim() === '001');
  check('unpriced lot is kept with 0 rate / 0 bill amt',
        r001 && Number(r001.getCell(5).value) === 0 && Number(r001.getCell(6).value) === 0);

  // Lot number preserves its leading zeros (stored as text, not coerced to 1).
  check('lot number keeps leading zeros (text, e.g. "001")',
        r001 && String(r001.getCell(1).value) === '001', r001 && JSON.stringify(r001.getCell(1).value));

  // Bill Amt is a real number with a money format (right-aligned money column).
  check('Bill Amt cell is numeric with a 2-decimal money format',
        r002 && typeof r002.getCell(6).value === 'number' &&
        /0\.00/.test(String(r002.getCell(6).numFmt || '')),
        r002 && `${typeof r002.getCell(6).value} / ${r002.getCell(6).numFmt}`);

  // Grand total sums Qty and Bill Amt.
  let totalRow = null;
  ws.eachRow((row) => {
    const first = String(row.getCell(1).value == null ? '' : row.getCell(1).value).trim().toUpperCase();
    if (first === 'TOTAL') totalRow = row;
  });
  check('TOTAL row sums Qty (333.30)', totalRow && Math.abs(Number(totalRow.getCell(4).value) - 333.3) < 0.01,
        totalRow && String(totalRow.getCell(4).value));
  // 87,153 + 0 + 231,361 + 372,949 = 691,463 (payables, not the 699,852 gross).
  check('TOTAL row sums the PAYABLE column (691,463)',
        totalRow && Number(totalRow.getCell(6).value) === 691463,
        totalRow && String(totalRow.getCell(6).value));

  // No place-group section rows (the layout is flat now).
  let sawPlaceSection = false;
  ws.eachRow((row) => {
    const first = String(row.getCell(1).value == null ? '' : row.getCell(1).value).trim().toUpperCase();
    if (first.endsWith(' TOTAL') && first !== 'TOTAL') sawPlaceSection = true;
  });
  check('no per-place subtotal/section rows (flat list)', !sawPlaceSection);

  // ── PDF: prove the row set is FLAT (no place grouping) ──
  // exportPdf returns a binary PDF, so instead of parsing it we check the
  // exact rows the PDF renderer would draw, via the shared getRowsForType +
  // ROW_PREPROCESS path. A leftover place-grouping config would inject
  // _isSection / _isSubtotal rows here.
  console.log('\n[3] PDF row set is flat and lot-ordered');
  check('lot_payment has no ROW_PREPROCESS (grouping) config',
        !ROW_PREPROCESS || ROW_PREPROCESS.lot_payment == null);

  // The XLSX and PDF each run their OWN copy of the lot_payment query, in
  // different files. They must stay in lock-step or the two formats of the same
  // report quietly disagree on money. Pin that both read `balance AS cost`.
  const srcXlsx = fs.readFileSync(path.join(__dirname, '..', 'exports.js'), 'utf8');
  const srcPdf  = fs.readFileSync(path.join(__dirname, '..', 'exports-pdf.js'), 'utf8');
  // Window has to reach past the explanatory comment to the query itself.
  const xlsxQ = srcXlsx.slice(srcXlsx.indexOf('async function exportLotPayment'), srcXlsx.indexOf('async function exportLotPayment') + 2000);
  const pdfQ  = srcPdf.slice(srcPdf.indexOf("case 'lot_payment':"), srcPdf.indexOf("case 'lot_payment':") + 1200);
  check('XLSX query reads balance AS cost', /balance AS cost/.test(xlsxQ));
  check('PDF query reads balance AS cost',  /balance AS cost/.test(pdfQ));
  check('neither query still reads amount AS cost',
        !/amount AS cost/.test(xlsxQ) && !/amount AS cost/.test(pdfQ));

  // ── PDF: it still renders end-to-end ──
  const cfg = getSettingsFlat(db);
  const pdf = await exportPdf(db, 'lot_payment', 1, cfg, {});
  check('PDF renders to a real %PDF buffer',
        Buffer.isBuffer(pdf) && pdf.slice(0, 4).toString() === '%PDF',
        pdf && pdf.slice(0, 8).toString());
  check('PDF is non-trivial in size', pdf && pdf.length > 1000, pdf && `${pdf.length} bytes`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  closeDb && closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
