// Lot Verification export — the two-up LOT | BAG | QTY | BUYER sheet.
//
// The sheet's whole value is its SHAPE: four columns repeated twice across
// the page, filled column-major so each block runs in unbroken lot order.
// Everything pinned here is something that silently ruins the printed sheet
// if it regresses:
//
//   [layout]  8 columns, headers repeat, first half left / second half right
//   [order]   lot numbers sort numerically ('10' after '7', not after '1')
//   [buyer]   BUYER is the code resolved from the BUYERS MASTER, not the
//             copy stamped on the lot at price-entry time
//   [types]   BAG/QTY land as real numbers with Indian numFmts — the
//             reference file's text-stored numbers are what we're avoiding
//   [totals]  each block totals ITSELF, not the sheet
//
// Runs against a THROWAWAY database. SPICE_DATA_DIR must be set before db.js
// is required (it reads the env var at module load) or the live data/config.db
// is mutated.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotverif-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb } = require(path.join(__dirname, '..', 'db.js'));
const { exportLotVerification } = require(path.join(__dirname, '..', 'exports.js'));
const ExcelJS = require('exceljs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

(async () => {
  await initDb();
  const db = getDb();

  db.run(`INSERT INTO auctions (id,ano,date,crop_type) VALUES (1,'13','2026-08-08','VST')`);

  // Buyers master.
  for (const [buyer, code] of [['ANKIT SPICES', 'B2'], ['TOP SPICE', 'TS'], ['AGRO MILLS', 'AG']]) {
    db.run(`INSERT INTO buyers (buyer,buyer1,code) VALUES (?,?,?)`, [buyer, buyer, code]);
  }

  // SEVEN lots — an odd count, so the left block must carry the extra row
  // and the right block's last row must be blank rather than half-filled.
  // Lot '10' is entered before '7' and must still sort after it.
  const LOTS = [
    ['1',  12, 100.5,  'B2', 'ANKIT SPICES'],
    ['2',  10,  85,    'ts', 'TOP SPICE'],       // lower-case code on the lot
    ['3',   9,  72.25, '',   'AGRO MILLS'],      // no code — name match only
    ['4',  14, 120,    'ZZ', 'GHOST TRADER'],    // absent from the master
    ['5',   6,  50,    'B2', 'ANKIT SPICES'],
    ['10', 11,  95.75, 'AG', 'AGRO MILLS'],
    ['7',   8,  60,    '',   ''],                // unsold / withdrawn
  ];
  for (const [lot, bags, qty, code, buyer] of LOTS) {
    db.run(`INSERT INTO lots (auction_id,lot_no,name,bags,qty,code,buyer)
            VALUES (1,?,?,?,?,?,?)`, [lot, 'SELLER ' + lot, bags, qty, code, buyer]);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await exportLotVerification(db, 1)));
  const ws = wb.worksheets[0];
  // The brand band occupies rows 1-3; column headers land on row 4.
  const HDR = 4;
  const cell = (r, c) => {
    const v = ws.getRow(r).getCell(c).value;
    return v == null ? '' : (v.richText ? v.richText.map(t => t.text).join('') : v);
  };
  const rowVals = r => [1, 2, 3, 4, 5, 6, 7, 8].map(c => cell(r, c));

  console.log('\n[layout] two blocks of four columns');
  check('the sheet is 8 columns wide', ws.columnCount === 8, `got ${ws.columnCount}`);
  check('headers repeat LOT|BAG|QTY|BUYER twice',
        rowVals(HDR).join(',') === 'LOT,BAG,QTY,BUYER,LOT,BAG,QTY,BUYER',
        rowVals(HDR).join(','));
  // 7 lots → ceil(7/2)=4 body rows, plus the TOTAL row.
  check('7 lots print on 4 body rows', ws.rowCount === HDR + 4 + 1,
        `rowCount ${ws.rowCount}`);

  console.log('\n[order] column-major fill, numeric lot sort');
  const leftLots  = [1, 2, 3, 4].map(i => String(cell(HDR + i, 1)));
  const rightLots = [1, 2, 3, 4].map(i => String(cell(HDR + i, 5)));
  check('left block holds the first half in lot order',
        leftLots.join(',') === '1,2,3,4', leftLots.join(','));
  // '5','7','10' — a string sort would give '10','5','7'.
  check('right block holds the second half, sorted numerically',
        rightLots.join(',') === '5,7,10,', rightLots.join(','));
  check('the odd lot out leaves the last right-block row fully blank',
        [5, 6, 7, 8].every(c => cell(HDR + 4, c) === ''),
        JSON.stringify([5, 6, 7, 8].map(c => cell(HDR + 4, c))));

  console.log('\n[buyer] code resolved from the buyers master');
  check("a lower-case lot code takes the master's canonical casing",
        cell(HDR + 2, 4) === 'TS', String(cell(HDR + 2, 4)));
  check('a lot with no code is matched on trade name',
        cell(HDR + 3, 4) === 'AG', String(cell(HDR + 3, 4)));
  check('a buyer absent from the master keeps the code on the lot',
        cell(HDR + 4, 4) === 'ZZ', String(cell(HDR + 4, 4)));
  check('an unsold lot shows a blank buyer, not a dropped row',
        cell(HDR + 2, 5) === '7' && cell(HDR + 2, 8) === '',
        `lot ${cell(HDR + 2, 5)} buyer ${JSON.stringify(cell(HDR + 2, 8))}`);

  console.log('\n[types] numbers are numbers, not text');
  const d = ws.getRow(HDR + 1);
  check('BAG and QTY are numeric in both blocks',
        [2, 3, 6, 7].every(c => typeof d.getCell(c).value === 'number'),
        [2, 3, 6, 7].map(c => typeof d.getCell(c).value).join(','));
  check('LOT stays text so alphanumeric / leading-zero lots survive',
        typeof d.getCell(1).value === 'string' && typeof d.getCell(5).value === 'string');
  check('BAG carries the integer numFmt', d.getCell(2).numFmt === '#,##0' && d.getCell(6).numFmt === '#,##0',
        `${d.getCell(2).numFmt} / ${d.getCell(6).numFmt}`);
  check('QTY carries the 3-decimal numFmt', d.getCell(3).numFmt === '#,##0.000' && d.getCell(7).numFmt === '#,##0.000',
        `${d.getCell(3).numFmt} / ${d.getCell(7).numFmt}`);

  console.log('\n[totals] each block totals itself');
  const T = HDR + 5;
  check('both blocks are labelled TOTAL', cell(T, 1) === 'TOTAL' && cell(T, 5) === 'TOTAL',
        `${cell(T, 1)} / ${cell(T, 5)}`);
  // left = lots 1,2,3,4 → bags 12+10+9+14 = 45, qty 100.5+85+72.25+120 = 377.75
  check('left block bags total 45', cell(T, 2) === 45, String(cell(T, 2)));
  check('left block qty totals 377.75', Math.abs(cell(T, 3) - 377.75) < 1e-9, String(cell(T, 3)));
  // right = lots 5,7,10 → bags 6+8+11 = 25, qty 50+60+95.75 = 205.75
  check('right block bags total 25', cell(T, 6) === 25, String(cell(T, 6)));
  check('right block qty totals 205.75', Math.abs(cell(T, 7) - 205.75) < 1e-9, String(cell(T, 7)));

  console.log('\n[edge] an empty trade still produces a valid sheet');
  db.run(`INSERT INTO auctions (id,ano,date) VALUES (2,'14','2026-08-09')`);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(await exportLotVerification(db, 2)));
  check('no lots → headers only, no crash', wb2.worksheets[0].getRow(HDR).getCell(1).value === 'LOT');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); cleanup(); process.exit(1); });
