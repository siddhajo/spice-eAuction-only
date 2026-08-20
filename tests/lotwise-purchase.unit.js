// Lot-wise purchase invoice — behaviour test.
//
// Runs against a THROWAWAY database. SPICE_DATA_DIR must be set before db.js
// is required (it reads the env var at module load) or the live data/config.db
// is mutated.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotwise-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb, closeDb } = require(path.join(__dirname,'..','db.js'));
const CALC = require(path.join(__dirname,'..','calculations.js'));
const { buildPurchaseInvoice } = CALC;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

(async () => {
  await initDb();
  const db = getDb();

  // Confirm the migration landed.
  const cols = db.all("PRAGMA table_info(purchases)").map(c => c.name);
  console.log('\n[1] Schema');
  check('purchases.lot_no exists', cols.includes('lot_no'));
  check('purchases.lot_id exists', cols.includes('lot_id'));

  // ── Fixture: one trade, two dealers. AAA has 3 lots, BBB has 1. ──
  const GSTIN_TN = '33AAAAA0000A1Z5';   // same state as company (33) -> CGST+SGST
  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (1,'7','2026-08-10','TAMIL NADU')`);
  const lots = [
    ['101', 'AAA TRADERS', GSTIN_TN, 100, 500],
    ['102', 'AAA TRADERS', GSTIN_TN, 200, 500],
    ['103', 'AAA TRADERS', GSTIN_TN, 300, 500],
    ['104', 'BBB TRADERS', GSTIN_TN, 400, 500],
  ];
  for (const [lot_no, name, cr, qty, price] of lots) {
    db.run(`INSERT INTO lots (auction_id,lot_no,name,cr,qty,price,amount,grade,bags,reserved)
            VALUES (1,?,?,?,?,?,?, '2', 10, 0)`,
      [lot_no, name, cr, qty, price, qty * price]);
  }
  const cfg = { gst_goods: 5, business_state: 'TAMIL NADU', sb_refund: 0,
                flag_tds_purchase: false, season_start: '2026-04-01' };

  // ── Seller-wise build (no lot opts) must be unchanged ──
  console.log('\n[2] Seller-wise build is untouched');
  const sw = buildPurchaseInvoice(db, 1, 'AAA TRADERS', cfg, {});
  check('covers all 3 of the dealer lots', sw && sw.lineItems.length === 3,
        sw ? `got ${sw.lineItems.length}` : 'null');
  check('lotWise flag is false', sw && sw.lotWise === false);
  check('lotNo is empty (marks row seller-wise)', sw && sw.lotNo === '');
  check('qty is the sum of all 3 lots', sw && sw.summary.totalQty === 600,
        sw && `got ${sw.summary.totalQty}`);

  // ── Lot-wise build by lot number ──
  console.log('\n[3] Lot-wise build narrows to ONE lot');
  const lw = buildPurchaseInvoice(db, 1, 'AAA TRADERS', cfg, { lotNo: '102' });
  check('exactly one line item', lw && lw.lineItems.length === 1,
        lw ? `got ${lw.lineItems.length}` : 'null');
  check('it is the requested lot', lw && lw.lineItems[0].lot === '102');
  check('lotWise flag is true', lw && lw.lotWise === true);
  check('lotNo echoed for stamping', lw && lw.lotNo === '102');
  check('lotId echoed for stamping', lw && lw.lotId != null);
  check('qty is only that lot', lw && lw.summary.totalQty === 200,
        lw && `got ${lw.summary.totalQty}`);
  check('amount is only that lot', lw && lw.summary.totalPuramt === 100000,
        lw && `got ${lw.summary.totalPuramt}`);

  // ── Lot-wise totals must reconcile to the seller-wise total ──
  console.log('\n[4] Lot-wise documents sum back to the seller-wise total');
  let sumQty = 0, sumAmt = 0;
  for (const n of ['101', '102', '103']) {
    const one = buildPurchaseInvoice(db, 1, 'AAA TRADERS', cfg, { lotNo: n });
    sumQty += one.summary.totalQty; sumAmt += one.summary.totalPuramt;
  }
  check('qty reconciles', sumQty === sw.summary.totalQty, `${sumQty} vs ${sw.summary.totalQty}`);
  check('amount reconciles', sumAmt === sw.summary.totalPuramt, `${sumAmt} vs ${sw.summary.totalPuramt}`);

  // ── A lot belonging to another seller must not resolve ──
  console.log('\n[5] Lot narrowing still verifies seller ownership');
  const wrong = buildPurchaseInvoice(db, 1, 'AAA TRADERS', cfg, { lotNo: '104' });
  check('BBB lot does not build under AAA', wrong === null,
        wrong ? 'it built — cross-seller leak' : '');

  // ── Lot id pinning + re-import fallback ──
  console.log('\n[6] lot_id pins exactly; falls back to lot_no after re-import');
  const realId = lw.lotId;
  const byId = buildPurchaseInvoice(db, 1, 'AAA TRADERS', cfg, { lotId: realId });
  check('builds by lot id', byId && byId.lineItems[0].lot === '102');
  const stale = buildPurchaseInvoice(db, 1, 'AAA TRADERS', cfg, { lotId: 999999, lotNo: '102' });
  check('dangling lot_id recovers via lot_no', stale && stale.lineItems[0].lot === '102',
        stale ? '' : 'null — reprint would lose lot detail');
  const noRecover = buildPurchaseInvoice(db, 1, 'AAA TRADERS', cfg, { lotId: 999999 });
  check('dangling lot_id with no lot_no does NOT silently widen', noRecover === null,
        noRecover ? `built ${noRecover.lineItems.length} lines` : '');

  // ── 194Q TDS ordering: the defect this feature would have hit ──
  // Threshold 50L at 0.1%. AAA's 3 lots are 50k + 100k + 150k = 300k, so we
  // set a low threshold to force a crossing inside the trade.
  console.log('\n[7] 194Q TDS accumulates ACROSS lot-wise siblings');
  const tdsCfg = Object.assign({}, cfg, {
    flag_tds_purchase: true, flag_wgst: false,
    tds_threshold: 100000, tds_rate: 0.1, tds_purchase_rate: 0.1,
  });
  // Simulate documents being raised in order 1,2,3 — writing each row as we go,
  // exactly as generate-all does.
  const tdsSeen = [];
  for (const [i, n] of ['101', '102', '103'].entries()) {
    const invoNo = String(i + 1);
    const b = buildPurchaseInvoice(db, 1, 'AAA TRADERS', tdsCfg, { lotNo: n, docNo: invoNo });
    tdsSeen.push({ lot: n, invo: invoNo, amount: b.summary.totalPuramt, tds: b.summary.tdsAmount });
    db.run(`INSERT INTO purchases (auction_id,ano,date,state,name,gstin,invo,qty,amount,total,tds,lot_no,lot_id)
            VALUES (1,'7','2026-08-10','TAMIL NADU',?,?,?,?,?,?,?,?,?)`,
      ['AAA TRADERS', GSTIN_TN, invoNo, b.summary.totalQty, b.summary.totalPuramt,
       b.summary.grandTotal, b.summary.tdsAmount, n, b.lotId]);
  }
  console.table(tdsSeen);
  // Cumulative amounts are 50k, 150k, 300k against a 100k threshold. Only the
  // running total ABOVE the threshold may be taxed. If siblings were invisible
  // to each other every row would see prior=0 and none would ever cross.
  const totalTds = tdsSeen.reduce((a, r) => a + r.tds, 0);
  const crossed  = tdsSeen.filter(r => r.tds > 0).length;
  check('at least one lot-wise row crosses the threshold', crossed > 0,
        'no row crossed — siblings are invisible to each other');
  // Whole-trade TDS must equal what a single 300k purchase would have paid:
  // (300000 - 100000) * 0.1% = 200
  check('total TDS equals the single-document answer (200)',
        Math.abs(totalTds - 200) < 0.011, `got ${totalTds.toFixed(2)}`);

  // ── Seller-wise TDS path must be bit-for-bit unchanged ──
  console.log('\n[8] Seller-wise TDS is unaffected by the new ordering key');
  db.run('DELETE FROM purchases');
  const swTds = buildPurchaseInvoice(db, 1, 'BBB TRADERS', tdsCfg, {});
  // BBB has one 200k lot, prior 0 -> (200000-100000)*0.1% = 100
  check('seller-wise TDS still 100', Math.abs(swTds.summary.tdsAmount - 100) < 0.011,
        `got ${swTds.summary.tdsAmount}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  closeDb && closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
