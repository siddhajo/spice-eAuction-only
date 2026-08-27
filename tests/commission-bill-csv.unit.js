// COMMISSION BILL CSV — the 22-column layout, pinned to the supplied sample.
//
// The customer gave a reference file. This reproduces its first rows from a
// seeded trade and asserts the output CELL FOR CELL. It is a characterisation
// test: if anyone changes the commission formula, the rounding, or the column
// order, this fails with the exact cell that moved.
//
// Two things it proves beyond "the columns are right":
//
//   [identity]  (SAMPLE PRICE - TRADER SAMPLE PRICE) == the `refund` figure
//               calculateLot() feeds into commission. That identity is the
//               whole reason this file reconciles against the printed bill,
//               and it holds only while sample = sb_refund + sb_trader_sample.
//   [read]      the money columns are READ from the lot, not recomputed —
//               editing a stored commission moves the CSV with it.
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Isolated DB — db.js reads SPICE_DATA_DIR, so set it BEFORE requiring db.
const os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb } = require(path.join(ROOT, 'db'));
const { exportCommissionBillCsv, CBC_COLUMNS } = require(path.join(ROOT, 'exports'));
const { calculateLot } = require(path.join(ROOT, 'calculations'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// The config the reference file was produced under.
const CFG = {
  sb_refund: '2.85',        // commission is charged on this many kg of sample
  sb_trader_sample: '0.1',  // …of which this much is the trader's
  commission: '1',
  hpc: '0',
  gst_service: '18',        // 9 + 9 intra-state
  business_state: 'KERALA',
  kl_gstin: '32AAAAA0000A1Z5',
  tally_state_code: '32',
};

// Rows lifted straight from the supplied screenshot.
//        lot   name                            cr                        qty    rate  P/T
const SEED = [
  ['1',  'ELAICHIROYAL PRIVATE LIMITED', 'GSTIN.32AAHCE4551A1Z8', 292.6, 3756, 'T'],
  ['10', 'JISS JOSEPH',                  'CR.',                    54.3, 2561, 'P'],
  ['11', 'BINOY MATHEW',                 'CR.',                   282.5, 2921, 'P'],
  ['12', 'BINOY MATHEW',                 'CR.',                   273.6, 2906, 'P'],
  ['13', 'BINOY MATHEW',                 'CR.',                   312.2, 2854, 'P'],
  ['14', 'ABUBAKKAR SIDDIQ M',           'CR.',                    31.3, 2322, 'P'],
  ['15', 'JAINULABDEEN A',               'CR.27771/2000',         137.4, 2575, 'P'],
  ['16', 'NATIONAL SPICES',              'GSTIN.32AOQPJ7535R1Z5', 241.9, 2784, 'T'],
];
// The expected cells, again from the screenshot:
//   value, samplePrice, traderSamplePrice, commission, cgst, roundOff, total
const EXPECT = {
  '1':  [1099005.60, 11080.2, 375.6, 11097.1,  998.7,  0.3, 1096616],
  '10': [ 139062.30,  7555.0, 256.1,  1463.6,  131.7, -0.2,  144634],
  '11': [ 825182.50,  8617.0, 292.1,  8335.1,  750.2,  0.1,  823672],
  '12': [ 795081.60,  8572.7, 290.6,  8033.6,  723.0, -0.1,  793884],
  '13': [ 891018.80,  8419.3, 285.4,  8991.5,  809.2,  0.2,  888543],
  '14': [  72678.60,  6849.9, 232.2,   793.0,   71.4,  0.5,   78361],
  '15': [ 353805.00,  7596.3, 257.5,  3611.4,  325.0, -0.4,  356882],
  // ── The one deliberate divergence from the reference file ──────────
  // Reference shows CGST/SGST 613.2 and ROUND OFF 0.2; we emit 613.3 / 0.4.
  // Commission here is 6,813.84, and GST at 9% is 613.2456 — which the app
  // stores as 613.25 and therefore shows as 613.3. The reference charges GST
  // on the ALREADY-ROUNDED 6,813.8 instead, giving 613.2.
  //
  // Decided (2026-08-27) to follow the app: this CSV must reconcile against
  // the commission-bill PDF and the Tally vouchers, which carry the stored
  // figure. The gap is at most ₹0.10 and only on lots whose commission has
  // exactly 5 in the second decimal. TOTAL is unaffected — 673,344 either
  // way — because ROUND OFF absorbs it.
  '16': [ 673449.60,  8212.8, 278.4,  6813.8,  613.3,  0.4,  673344],
};

(async () => {
  await initDb();
  const db = getDb();
  db.run('INSERT INTO auctions (ano, date, crop_type, state) VALUES (?,?,?,?)',
         ['13', '2026-08-08', 'VST', 'KERALA']);
  const AID = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;

  for (const [lot_no, name, cr, qty, price, _pt] of SEED) {
    const amount = Math.round(qty * price * 100) / 100;
    // Run the real calculator, then store what it produced — exactly what
    // pressing Calculate in the app does.
    const c = calculateLot({ lot_no, name, cr, qty, price, amount }, CFG);
    db.run(`INSERT INTO lots (auction_id, lot_no, name, cr, qty, price, amount, bags,
                              com, sertax, cgst, sgst, igst, pstate, pst_code, state)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [AID, lot_no, name, cr, qty, price, amount, 1,
       c.com, c.sertax, c.cgst, c.sgst, c.igst, 'KERALA', '32', 'KERALA']);
  }

  const csv = (await exportCommissionBillCsv(db, AID, CFG)).toString('utf8').replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  const cells = lines.map(l => l.split(','));
  const H = Object.fromEntries(CBC_COLUMNS.map((c, i) => [c, i]));

  console.log('[header]');
  check('22 columns in the supplied order',
        lines[0] === CBC_COLUMNS.join(','), lines[0]);
  check('one row per lot', cells.length === SEED.length + 1, `${cells.length - 1} rows`);

  console.log('\n[rows] every cell against the reference');
  for (const [lot_no, name, cr, qty, price, pt] of SEED) {
    const row = cells.slice(1).find(r => r[H['QUANTITY KG']] === String(qty));
    if (!row) { check(`lot ${lot_no} present`, false); continue; }
    const [value, sp, tsp, com, cgst, roundOff, total] = EXPECT[lot_no];
    const got = (col) => Number(row[H[col]]);
    const eq  = (col, want) => check(`lot ${lot_no} · ${col} = ${want}`, got(col) === want,
                                     `got ${row[H[col]]}`);
    check(`lot ${lot_no} · ANO`,   row[H['ANO']] === '13', row[H['ANO']]);
    check(`lot ${lot_no} · DATE`,  row[H['DATE']] === '8/8/26', row[H['DATE']]);
    // Name/CR are quoted only when they contain a comma; compare unquoted.
    check(`lot ${lot_no} · PLANTER NAME`, row[H['PLANTER NAME']] === name, row[H['PLANTER NAME']]);
    check(`lot ${lot_no} · CR/GST`, row[H['CR/GST']] === cr, row[H['CR/GST']]);
    check(`lot ${lot_no} · PLANTER/TRADER = ${pt}`, row[H['PLANTER/TRADER']] === pt, row[H['PLANTER/TRADER']]);
    eq('RATE', price);
    eq('CARDAMOM_VALUE', value);
    eq('SAMPLE KG', 2.95);
    eq('SAMPLE PRICE', sp);
    eq('TRADER SAMPLE KG', 0.1);
    eq('TRADER SAMPLE PRICE', tsp);
    eq('COMMISSION', com);
    eq('INCL. CHARGES', 0);
    eq('IGST', 0);
    eq('CGST', cgst);
    eq('SGST', cgst);
    eq('ROUND OFF', roundOff);
    eq('TOTAL', total);
    check(`lot ${lot_no} · STATE/STATECODE`,
          row[H['STATE']] === 'KERALA' && row[H['STATECODE']] === '32',
          `${row[H['STATE']]}/${row[H['STATECODE']]}`);
  }

  // ── [identity] the decomposition must equal the calculator's `refund` ──
  console.log('\n[identity] sample split reconciles with the calculator');
  let identityOk = true, detail = '';
  for (const [lot_no, name, cr, qty, price] of SEED) {
    const row = cells.slice(1).find(r => r[H['QUANTITY KG']] === String(qty));
    const split = Math.round((Number(row[H['SAMPLE PRICE']]) - Number(row[H['TRADER SAMPLE PRICE']])) * 100) / 100;
    const refund = calculateLot({ qty, price, amount: qty * price, cr }, CFG).refund;
    // Tolerance is half of the 1dp display step: SAMPLE PRICE is shown to one
    // decimal, so a rate whose sample lands on .x5 (2575 × 2.95 = 7,596.25 →
    // 7,596.3) legitimately moves the split by up to 0.05 against the
    // full-precision refund. Anything beyond that is a formula divergence.
    if (Math.abs(split - refund) > 0.051) { identityOk = false; detail += `lot ${lot_no}: ${split} vs ${refund}; `; }
  }
  check('(SAMPLE PRICE − TRADER SAMPLE PRICE) == calculateLot().refund', identityOk, detail);

  // ── [read] the CSV follows the STORED commission, not a recomputation ──
  console.log('\n[read] money columns are read from the lot');
  db.run(`UPDATE lots SET com = 1.11, cgst = 2.22, sgst = 3.33 WHERE auction_id = ? AND lot_no = '10'`, [AID]);
  const csv2 = (await exportCommissionBillCsv(db, AID, CFG)).toString('utf8').replace(/^﻿/, '');
  const row2 = csv2.trim().split('\r\n').slice(1).map(l => l.split(','))
    .find(r => r[H['QUANTITY KG']] === '54.3');
  check('an edited stored commission moves the CSV',
        Number(row2[H['COMMISSION']]) === 1.1 && Number(row2[H['CGST']]) === 2.2
        && Number(row2[H['SGST']]) === 3.3,
        `${row2[H['COMMISSION']]}/${row2[H['CGST']]}/${row2[H['SGST']]}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e)); cleanup(); process.exit(1); });
