// Bank Payment row ordering — behaviour test for `opts.orderByLot`.
//
// The Lot-wise Payments screen lists lots in ascending lot order, and its
// export must come out in that same order. Every other caller keeps the
// seller-wise ordering it has always had.
//
// Runs against a THROWAWAY database. SPICE_DATA_DIR must be set before db.js
// is required (it reads the env var at module load) or the live data/config.db
// is mutated.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bankorder-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb, closeDb } = require(path.join(__dirname, '..', 'db.js'));
const { getBankPaymentData } = require(path.join(__dirname, '..', 'calculations.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

(async () => {
  await initDb();
  const db = getDb();

  // ── Fixture ────────────────────────────────────────────────────────
  // Three sellers whose ALPHABETICAL order is the reverse of their lot
  // order, so the two orderings can never be confused for one another:
  //   ZEBRA   lot 5      AAA lot 40    MID lot 9 + lot 100
  // Lot order  → ZEBRA(5), MID(9), AAA(40)
  // Name order → AAA, MID, ZEBRA
  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (1,'7','2026-08-10','TAMIL NADU')`);
  const rows = [
    ['5',   'ZEBRA PLANTER'],
    ['40',  'AAA PLANTER'],
    ['9',   'MID PLANTER'],
    ['100', 'MID PLANTER'],
  ];
  for (const [lot_no, name] of rows) {
    // balance is what the "after discount" export pays out.
    db.run(`INSERT INTO lots (auction_id,lot_no,name,cr,qty,price,amount,puramt,balance,grade,bags,reserved)
            VALUES (1,?,?,'',100,500,50000,50000,50000,'2',10,0)`, [lot_no, name]);
  }
  const cfg = { flag_round: false, bank_kl_acct: '' };
  const lotsOf = r => String(r.particulars || '').replace(/^\S+\s*/, '');

  // ── Default (no orderByLot) — seller-wise, exactly as before ────────
  console.log('\n[1] Default ordering is untouched');
  const plain = getBankPaymentData(db, 1, cfg, {});
  check('one row per seller', plain.length === 3, `got ${plain.length}`);
  check('ordered by seller name',
        plain.map(r => r.beneficiaryName).join('|') === 'AAA PLANTER|MID PLANTER|ZEBRA PLANTER',
        plain.map(r => r.beneficiaryName).join('|'));

  // ── orderByLot on the whole trade ──────────────────────────────────
  console.log('\n[2] orderByLot sorts by lot number');
  const byLot = getBankPaymentData(db, 1, cfg, { orderByLot: true });
  check('same three rows', byLot.length === 3, `got ${byLot.length}`);
  check('ordered by lot, not by name',
        byLot.map(r => r.beneficiaryName).join('|') === 'ZEBRA PLANTER|MID PLANTER|AAA PLANTER',
        byLot.map(r => r.beneficiaryName).join('|'));
  check('a multi-lot row sorts on its SMALLEST lot (9, not 100)',
        lotsOf(byLot[1]) === '9,100', lotsOf(byLot[1]));

  // ── orderByLot with a lot pick — the Lot-wise screen's actual call ──
  console.log('\n[3] orderByLot with per-seller lot picks');
  const picked = getBankPaymentData(db, 1, cfg, {
    orderByLot: true,
    lots: { 'MID PLANTER': ['100'], 'AAA PLANTER': ['40'], 'ZEBRA PLANTER': ['5'] },
  });
  check('three rows', picked.length === 3, `got ${picked.length}`);
  check('picked lots order 5, 40, 100',
        picked.map(lotsOf).join('|') === '5|40|100', picked.map(lotsOf).join('|'));
  check('MID row pays only the picked lot', Number(picked[2].amount) === 50000,
        String(picked[2].amount));

  // ── The internal sort key never reaches the sheet ───────────────────
  console.log('\n[4] Row shape is clean');
  check('_lotList is stripped from ordered rows',
        byLot.every(r => !('_lotList' in r)));
  check('_lotList is stripped from unordered rows',
        plain.every(r => !('_lotList' in r)));

  console.log(`\n${pass} passed, ${fail} failed`);
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
