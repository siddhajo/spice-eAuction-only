// Sales Journal ORDER — by the invoice number the register prints: sale letter
// first, then the number numerically.
//
//     PI/I-1, PI/I-2, PI/I-20, PI/L-1, PI/L-10
//
// Two defects this pins:
//   • TEXT collation on `invo` put "10" ahead of "2" (PI/I-10 above PI/I-2);
//   • in proforma mode the printed cell is the DRAFT's number, numbered
//     independently of the original behind it, so the register was ordered on
//     a number it never shows.
const os = require('os'), path = require('path'), fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-order-'));
process.env.SPICE_DATA_DIR = TMP;   // must be set BEFORE db.js is required

const ROOT = path.join(__dirname, '..');
const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
const calc = require(path.join(ROOT, 'calculations.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }

(async () => {
  await initDb();
  const db = getDb();

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('11', '2026-08-14', 'TAMIL NADU')`);
  const AID = db.get(`SELECT id FROM auctions WHERE ano = '11'`).id;

  const inv = (o) => {
    const r = Object.assign({
      is_proforma: 0, raised_invo: '', sale: 'L', bag: 10, qty: 100,
      amount: 40000, gunny: 0, pava_hc: 0, ins: 0,
      cgst: 0, sgst: 0, igst: 0, tcs: 0, rund: 0, tot: 40000,
      gstin: '', place: 'BODI', date: '2026-08-14',
    }, o);
    db.run(
      `INSERT INTO invoices (auction_id, ano, date, sale, invo, buyer, buyer1, gstin, place,
         bag, qty, amount, gunny, pava_hc, ins, cgst, sgst, igst, tcs, rund, tot,
         is_proforma, raised_invo)
       VALUES (?,'11',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [AID, r.date, r.sale, String(r.invo), r.buyer, r.buyer1 || r.buyer, r.gstin, r.place,
       r.bag, r.qty, r.amount, r.gunny, r.pava_hc, r.ins, r.cgst, r.sgst, r.igst,
       r.tcs, r.rund, r.tot, r.is_proforma, r.raised_invo]
    );
  };
  const lot = (lot_no, buyer, invo, pf, sale) => db.run(
    `INSERT INTO lots (auction_id, lot_no, name, buyer, invo, proforma_invo, sale, qty, price, amount)
     VALUES (?,?,?,?,?,?,?,100,400,40000)`,
    [AID, lot_no, 'GROWER', buyer, String(invo), String(pf), sale || 'L']
  );

  // Drafts numbered so that TEXT order (1, 10, 2, 20) differs from numeric
  // order (1, 2, 10, 20), and inserted out of order so the fix can't pass by
  // accident. Originals are numbered in the OPPOSITE order to the drafts, so
  // ordering on the original number can't produce the draft order either.
  //   draft PI/I-20 → original 101      draft PI/L-10 → original 104
  //   draft PI/I-2  → original 102      draft PI/L-1  → original 105
  //   draft PI/I-1  → original 103
  const plan = [
    // [draftNo, sale, originalNo, buyer]
    [20, 'I', 101, 'BUYER_A'],
    [2,  'I', 102, 'BUYER_B'],
    [1,  'I', 103, 'BUYER_C'],
    [10, 'L', 104, 'BUYER_D'],
    [1,  'L', 105, 'BUYER_E'],
  ];
  let lotNo = 400;
  for (const [pf, sale, orig, buyer] of plan) {
    inv({ invo: pf,   buyer, sale, is_proforma: 1, raised_invo: String(orig) });
    inv({ invo: orig, buyer, sale });
    lot(String(++lotNo), buyer, orig, pf, sale);
  }
  // A PENDING draft (nothing raised) must take its place in the same sequence,
  // not be appended at the end.
  inv({ invo: 3, buyer: 'BUYER_F', sale: 'I', is_proforma: 1, raised_invo: '' });

  const CFG_ON  = { flag_proforma_invoice: 'true',  proforma_invoice_prefix: 'PI' };
  const CFG_OFF = { flag_proforma_invoice: 'false', proforma_invoice_prefix: 'PI' };

  console.log('[1] Proforma mode — ordered by the printed PI number');
  const on = calc.getSalesJournal(db, AID, null, CFG_ON);
  const cells = on.map(r => r.invo);
  const want = ['PI/I-1', 'PI/I-2', 'PI/I-3', 'PI/I-20', 'PI/L-1', 'PI/L-10'];
  check('rows come out PI/I-1, PI/I-2, PI/I-3, PI/I-20, PI/L-1, PI/L-10',
        JSON.stringify(cells) === JSON.stringify(want), JSON.stringify(cells));
  check('20 sorts AFTER 2 (numeric, not text)',
        cells.indexOf('PI/I-20') > cells.indexOf('PI/I-2'), JSON.stringify(cells));
  check('10 sorts AFTER 1 in the L series',
        cells.indexOf('PI/L-10') > cells.indexOf('PI/L-1'), JSON.stringify(cells));
  check('the I series comes before the L series',
        cells.indexOf('PI/L-1') > cells.indexOf('PI/I-20'), JSON.stringify(cells));
  check('the pending draft takes its place in sequence (PI/I-3), not the end',
        cells.indexOf('PI/I-3') === 2, JSON.stringify(cells));
  check('every original still resolves to its own draft',
        on.every(r => r.invo.startsWith('PI/')), JSON.stringify(cells));

  console.log('\n[2] Flag OFF — same rule on the bare original numbers');
  const off = calc.getSalesJournal(db, AID, null, CFG_OFF);
  const offCells = off.map(r => `${r.sale} ${r.invo}`);
  check('originals only, ordered I 101 … I 103 then L 104, L 105',
        JSON.stringify(offCells) === JSON.stringify(['I 101', 'I 102', 'I 103', 'L 104', 'L 105']),
        JSON.stringify(offCells));
  check('no drafts leak into the OFF register', off.length === 5, `got ${off.length}`);

  console.log('\n[3] The sale-type filter still applies, in the same order');
  const onI = calc.getSalesJournal(db, AID, 'I', CFG_ON).map(r => r.invo);
  check('sale=I keeps the I rows in numeric order',
        JSON.stringify(onI) === JSON.stringify(['PI/I-1', 'PI/I-2', 'PI/I-3', 'PI/I-20']),
        JSON.stringify(onI));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
