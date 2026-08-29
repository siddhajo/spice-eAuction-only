// DISBURSEMENT REGISTER — dealer side. Behaviour test for the two Auction
// Downloads tiles (XLSX + PDF), both fed by dealerDisbursementRows().
//
// What is pinned here is what makes the register trustworthy as a money
// document:
//
//   [reference] the figures reproduce the customer's supplied sheet
//   [identity]  the register's own columns foot to the stored payable:
//               SALE COST + REFUND - SAMP - COMMN - INCL - CGST - SGST - IGST
//                 = BALANCE
//   [scope]     dealers only, priced + non-reserved only, lot-number order
//   [bill]      the dealer's debit note, resolved by trader_id not by name
//   [render]    XLSX carries the numbers as numbers with a TOTAL strip, and
//               the PDF twin renders off the SAME rows
//
// Runs against a THROWAWAY database. SPICE_DATA_DIR must be set before db.js
// is required (it reads the env var at module load) or the live data/config.db
// is mutated.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dealerdisb-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb } = require(path.join(__dirname, '..', 'db.js'));
const {
  dealerDisbursementRows, exportDealerDisbursement, DEALER_DISB_COLS,
} = require(path.join(__dirname, '..', 'exports.js'));
const { exportPdf } = require(path.join(__dirname, '..', 'exports-pdf.js'));
const { calculateLot } = require(path.join(__dirname, '..', 'calculations.js'));
const ExcelJS = require('exceljs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

// The live site's rates — the reference sheet was produced under these.
const CFG = {
  sb_refund: 2.85, sb_trader_sample: 0.1, commission: 1, hpc: 0,
  gst_service: 18, business_state: 'KERALA', kl_gstin: '32AAHCE4551A1Z8',
};

(async () => {
  await initDb();
  const db = getDb();
  // initDb() does not create company_settings — the server does that at boot
  // via initCompanySettings(). The PDF path reads settings (getSettingsFlat),
  // so a bare initDb() would leave it querying a table that does not exist.
  require(path.join(__dirname, '..', 'company-config.js')).initCompanySettings(db);
  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (1,'13','2026-08-08','KERALA')`);

  // Lots 001 and 016 are rows 1 and 2 of the supplied sheet, to the paisa.
  // 103 is interstate (33 vs the company's 32) so it takes IGST. 200 is a
  // PLANTER and belongs to the other register. 300 is unpriced, 400 reserved.
  const LOTS = [
    ['001', 'ELAICHIROYAL PRIVATE LIMITED', 'GSTIN.32AAHCE4551A1Z8', 292.6, 3756, 0],
    ['016', 'NATIONAL SPICES',              'GSTIN.32AERPA1234B1Z9', 241.9, 2784, 0],
    ['103', 'ABSAL SPICES',                 'GSTIN.33AAHCE4551A1Z8', 371.3, 3755, 0],
    ['200', 'SOME PLANTER',                 'CR.',                   100,   3000, 0],
    ['300', 'UNPRICED DEALER',              'GSTIN.32AAHCE4551A1Z8', 50,    0,    0],
    ['400', 'RESERVED DEALER',              'GSTIN.32AAHCE4551A1Z8', 50,    3000, 1],
  ];
  const traderIds = {};
  for (const [lot, name, cr, qty, price, reserved] of LOTS) {
    db.run(`INSERT INTO traders (name, cr) VALUES (?,?)`, [name, cr]);
    const tid = db.get('SELECT last_insert_rowid() AS id').id;
    traderIds[name] = tid;
    const amount = Math.round(qty * price * 100) / 100;
    const c = calculateLot({ qty, price, amount, cr }, CFG);
    db.run(
      `INSERT INTO lots (auction_id,lot_no,name,cr,trader_id,bags,qty,price,amount,reserved,
                         com,sertax,cgst,sgst,igst,refund,balance)
       VALUES (1,?,?,?,?,10,?,?,?,?,?,?,?,?,?,?,?)`,
      [lot, name, cr, tid, qty, price, amount, reserved,
       c.com, c.sertax, c.cgst, c.sgst, c.igst, c.refund, c.balance]);
  }
  // One debit note per dealer, numbered as on the sheet. ELAICHIROYAL gets a
  // SECOND, higher-numbered note to prove the lower one wins.
  const NOTES = [
    ['2856', 'ABSAL SPICES'], ['2857', 'ELAICHIROYAL PRIVATE LIMITED'],
    ['2858', 'NATIONAL SPICES'], ['2999', 'ELAICHIROYAL PRIVATE LIMITED'],
  ];
  for (const [no, name] of NOTES) {
    db.run(`INSERT INTO debit_notes (ano,date,name,note_no,auction_id,trader_id)
            VALUES ('13','2026-08-08',?,?,1,?)`, [name, no, traderIds[name]]);
  }

  const rows = dealerDisbursementRows(db, 1, CFG);
  const byLot = Object.fromEntries(rows.map(r => [String(r.lot), r]));

  console.log('\n[scope] dealers only, priced and unreserved, in lot order');
  check('three rows — the three priced, unreserved dealer lots', rows.length === 3,
        JSON.stringify(rows.map(r => r.lot)));
  check('the planter lot is not in the dealer register', !byLot['200']);
  check('an unpriced dealer lot is excluded', !byLot['300']);
  check('a reserved dealer lot is excluded', !byLot['400']);
  check('lot order is numeric', rows.map(r => r.lot).join(',') === '001,016,103',
        rows.map(r => r.lot).join(','));

  console.log('\n[reference] the supplied sheet, row for row');
  const r1 = byLot['001'];
  check('001 COMMN 11,097.10',   near(r1.commn, 11097.10),  String(r1.commn));
  check('001 SAMP 375.60',       near(r1.samp, 375.60),     String(r1.samp));
  check('001 REFUND 11,080.20',  near(r1.refund, 11080.20), String(r1.refund));
  check('001 SALE COST 10,99,005.60', near(r1.cost, 1099005.60), String(r1.cost));
  // The reference's 998.70 is its own 10-paise rounding; we carry the exact
  // stored figure, which is what the debit note and bank file use.
  check('001 CGST/SGST are the exact stored 998.74 (ref rounds to 998.70)',
        near(r1.cgst, 998.74) && near(r1.sgst, 998.74), `${r1.cgst}/${r1.sgst}`);
  check('001 BALANCE is the whole-rupee 10,96,616 — matches the reference exactly',
        r1.balance === 1096616, String(r1.balance));
  const r2 = byLot['016'];
  check('016 SAMP 278.40',       near(r2.samp, 278.40),     String(r2.samp));
  check('016 REFUND 8,212.80',   near(r2.refund, 8212.80),  String(r2.refund));
  check('016 SALE COST 6,73,449.60', near(r2.cost, 673449.60), String(r2.cost));
  check('016 BALANCE 6,73,344 — matches the reference exactly',
        r2.balance === 673344, String(r2.balance));

  console.log('\n[identity] the columns foot to the stored payable');
  for (const r of rows) {
    const calc = Math.round(r.cost + r.refund - r.samp - r.commn - r.incl - r.cgst - r.sgst - r.igst);
    check(`lot ${r.lot}: COST + REFUND - SAMP - COMMN - INCL - GST = BALANCE`,
          calc === r.balance, `computed ${calc} vs stored ${r.balance}`);
  }
  // REFUND - SAMP must be exactly what calculateLot credited, or the identity
  // above is a coincidence rather than a property.
  check('REFUND − SAMP is the stored lots.refund',
        rows.every(r => {
          const stored = db.get('SELECT refund FROM lots WHERE auction_id=1 AND lot_no=?', [r.lot]).refund;
          return near(Math.round((r.refund - r.samp) * 100) / 100, stored);
        }));

  console.log('\n[tax] interstate dealers take IGST, local ones CGST+SGST');
  check('001 (state 32 = company state) is CGST+SGST, no IGST',
        r1.cgst > 0 && r1.sgst > 0 && r1.igst === 0);
  check('103 (state 33 ≠ company) is IGST only',
        byLot['103'].igst > 0 && byLot['103'].cgst === 0 && byLot['103'].sgst === 0,
        JSON.stringify(byLot['103']));

  console.log('\n[bill] the dealer debit note, by trader');
  check('001 carries ELAICHIROYAL’s note', r1.bill === '2857', r1.bill);
  check('016 carries NATIONAL’s note',     r2.bill === '2858', r2.bill);
  check('103 carries ABSAL’s note',        byLot['103'].bill === '2856', byLot['103'].bill);
  check('a dealer with two notes shows the LOWER number, not the later one',
        r1.bill === '2857');
  // A note whose trader_id never matched must not leak onto another dealer.
  db.run(`INSERT INTO lots (auction_id,lot_no,name,cr,trader_id,bags,qty,price,amount,com,balance)
          VALUES (1,'500','NO NOTE DEALER','GSTIN.32AAHCE4551A1Z8',NULL,10,10,100,1000,10,990)`);
  const withOrphan = dealerDisbursementRows(db, 1, CFG);
  const orphan = withOrphan.find(r => String(r.lot) === '500');
  check('a dealer with no debit note gets a BLANK bill, and is still listed',
        !!orphan && orphan.bill === '' && orphan.balance === 990,
        JSON.stringify(orphan));

  console.log('\n[render] XLSX');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await exportDealerDisbursement(db, 1, CFG)));
  const ws = wb.worksheets[0];
  const HDR = 4;   // rows 1-3 are the brand band
  const val = (r, c) => { const v = ws.getRow(r).getCell(c).value; return v == null ? '' : v; };
  check('the twelve supplied headers, in order',
        [...Array(12).keys()].map(i => val(HDR, i + 1)).join(',')
          === 'BILL,NAME,LOT,COMMN,SAMP,CGST,SGST,IGST,INCL,REFUND,SALE COST,BALANCE',
        [...Array(12).keys()].map(i => val(HDR, i + 1)).join(','));
  check('the column set is shared with the planter register byte for byte',
        DEALER_DISB_COLS === require(path.join(__dirname, '..', 'exports.js')).PLANTER_DISB_COLS);
  const d1 = ws.getRow(HDR + 1);
  check('money columns are numbers, not text',
        [4, 5, 6, 7, 8, 9, 10, 11, 12].every(c => typeof d1.getCell(c).value === 'number'),
        [4, 5, 6, 7, 8, 9, 10, 11, 12].map(c => typeof d1.getCell(c).value).join(','));
  check('LOT stays text so 001 keeps its leading zeros',
        d1.getCell(3).value === '001', JSON.stringify(d1.getCell(3).value));
  check('money columns carry the Indian 2-decimal numFmt',
        d1.getCell(4).numFmt === '#,##,##0.00' && d1.getCell(12).numFmt === '#,##,##0.00');
  // 4 dealer rows now (the orphan was added above) + the TOTAL strip.
  const T = HDR + withOrphan.length + 1;
  check('a TOTAL strip closes the sheet', val(T, 1) === 'TOTAL', String(val(T, 1)));
  check('TOTAL foots SALE COST', near(val(T, 11), withOrphan.reduce((s, r) => s + r.cost, 0)),
        `${val(T, 11)}`);
  check('TOTAL foots BALANCE', near(val(T, 12), withOrphan.reduce((s, r) => s + r.balance, 0)),
        `${val(T, 12)}`);

  console.log('\n[render] PDF twin');
  const pdf = await exportPdf(db, 'dealer_disbursement', 1, CFG, {});
  const buf = Buffer.from(pdf);
  check('renders a real PDF', buf.slice(0, 4).toString() === '%PDF' && buf.length > 1000,
        `${buf.slice(0, 8).toString('hex')} len ${buf.length}`);

  console.log('\n[edge] a trade with no dealer lots');
  db.run(`INSERT INTO auctions (id,ano,date) VALUES (2,'14','2026-08-09')`);
  check('no dealers → no rows, no crash', dealerDisbursementRows(db, 2, CFG).length === 0);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(await exportDealerDisbursement(db, 2, CFG)));
  check('…and the empty sheet still carries its headers',
        wb2.worksheets[0].getRow(HDR).getCell(1).value === 'BILL');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); cleanup(); process.exit(1); });
