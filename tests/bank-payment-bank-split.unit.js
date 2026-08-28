// Bank Payment per-bank splitting — behaviour test for the lot-filtered export.
//
// When the Payments screen exports a picked subset of lots, getBankPaymentData
// emits one payment line per DESTINATION ACCOUNT. Two things must hold:
//
//   • a lot's pinned bank (lots.bank_id) is honoured only when that account
//     belongs to the seller being paid. trader_banks ids are recycled —
//     syncTraderBanks deletes and re-inserts a seller's rows on every save —
//     so a stale pin can name another seller's account, and paying it would
//     wire this seller's money to that one;
//   • lines are keyed on the account finally resolved, not on the raw bank_id.
//     A stale pin, an untagged lot and a lot pinned to the seller's own default
//     all land in the same account and must come out as ONE line, not three.
//
// Runs against a THROWAWAY database. SPICE_DATA_DIR must be set before db.js
// is required (it reads the env var at module load) or the live data/config.db
// is mutated.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'banksplit-'));
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
  // SELLER (trader 1) owns two accounts; OTHER (trader 2) owns one. The
  // seller's lots carry, deliberately, every kind of pin there is:
  //
  //   lot 010  bank 1   own default account          → OWN-A
  //   lot 020  bank 2   own second account           → OWN-B
  //   lot 030  bank 9   OTHER seller's account       → stale/recycled id
  //   lot 040  bank 77  no such row (deleted)        → dangling id
  //   lot 050  NULL     untagged                     → seller default
  //
  // Lots 030/040/050 all resolve to OWN-A, the seller's default — as does
  // lot 010's explicit pin. So the correct output is TWO lines: OWN-A for
  // 010+030+040+050, and OWN-B for 020.
  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (1,'7','2026-08-10','TAMIL NADU')`);
  db.run(`INSERT INTO traders (id,name,cr,ifsc,acctnum) VALUES (1,'SELLER PLANTER','','LEGACY0001','legacy-acct')`);
  db.run(`INSERT INTO traders (id,name,cr,ifsc,acctnum) VALUES (2,'OTHER PLANTER','','OTHR0000001','other-legacy')`);
  db.run(`INSERT INTO trader_banks (id,trader_id,acctnum,ifsc,holder_name,is_default) VALUES (1,1,'OWN-A','OWNA0000001','SELLER PLANTER',1)`);
  db.run(`INSERT INTO trader_banks (id,trader_id,acctnum,ifsc,holder_name,is_default) VALUES (2,1,'OWN-B','OWNB0000001','SELLER PLANTER',0)`);
  db.run(`INSERT INTO trader_banks (id,trader_id,acctnum,ifsc,holder_name,is_default) VALUES (9,2,'OTHER-ACCT','OTHR0000001','OTHER PLANTER',1)`);

  const lotRows = [
    ['010', 1],
    ['020', 2],
    ['030', 9],     // belongs to trader 2 — must NOT be paid
    ['040', 77],    // no such bank row
    ['050', null],
  ];
  for (const [lot_no, bank_id] of lotRows) {
    db.run(`INSERT INTO lots (auction_id,lot_no,trader_id,name,cr,bank_id,qty,price,amount,puramt,balance,grade,bags,reserved)
            VALUES (1,?,1,'SELLER PLANTER','',?,100,500,50000,50000,50000,'2',10,0)`, [lot_no, bank_id]);
  }
  const cfg = { flag_round: false, bank_kl_acct: '' };
  const ALL = ['010', '020', '030', '040', '050'];
  const pick = (lots) => getBankPaymentData(db, 1, cfg, { lots: { 'SELLER PLANTER': lots } });
  const lotsOf = r => String(r.particulars || '').replace(/^\S+\s*/, '');
  const byAcct = (rows, acct) => rows.filter(r => r.accountNo === acct);

  // ── A stale pin must never move money to another seller ─────────────
  console.log('\n[1] A bank_id the seller does not own is not a routing instruction');
  const stale = pick(['030']);
  check('one row', stale.length === 1, `got ${stale.length}`);
  check('NOT paid into the other seller\'s account',
        stale[0].accountNo !== 'OTHER-ACCT', stale[0].accountNo);
  check('paid into the seller\'s own default instead',
        stale[0].accountNo === 'OWN-A' && stale[0].ifsc === 'OWNA0000001',
        `${stale[0].accountNo} / ${stale[0].ifsc}`);
  check('beneficiary is the seller, not the other party',
        stale[0].beneficiaryName === 'SELLER PLANTER', stale[0].beneficiaryName);

  console.log('\n[2] A dangling bank_id falls back to the default too');
  const dangling = pick(['040']);
  check('one row', dangling.length === 1, `got ${dangling.length}`);
  check('routed to the default account', dangling[0].accountNo === 'OWN-A', dangling[0].accountNo);

  // ── Genuine multi-bank splits still split ───────────────────────────
  console.log('\n[3] Lots spanning two of the seller\'s OWN accounts still split');
  const twoOwn = pick(['010', '020']);
  check('two rows', twoOwn.length === 2, `got ${twoOwn.length}`);
  check('lot 010 → OWN-A', byAcct(twoOwn, 'OWN-A').map(lotsOf).join() === '010',
        JSON.stringify(twoOwn.map(r => [lotsOf(r), r.accountNo])));
  check('lot 020 → OWN-B', byAcct(twoOwn, 'OWN-B').map(lotsOf).join() === '020',
        JSON.stringify(twoOwn.map(r => [lotsOf(r), r.accountNo])));
  check('each row pays only its own lot',
        twoOwn.every(r => Number(r.amount) === 50000), JSON.stringify(twoOwn.map(r => r.amount)));

  console.log('\n[4] A non-default pin alongside untagged lots still splits');
  // The untagged lot follows the default (OWN-A); the pinned one must keep
  // going to OWN-B rather than being merged into the default.
  const pinPlusUntagged = pick(['020', '050']);
  check('two rows', pinPlusUntagged.length === 2, `got ${pinPlusUntagged.length}`);
  check('pinned lot 020 keeps OWN-B',
        byAcct(pinPlusUntagged, 'OWN-B').map(lotsOf).join() === '020',
        JSON.stringify(pinPlusUntagged.map(r => [lotsOf(r), r.accountNo])));
  check('untagged lot 050 takes the default OWN-A',
        byAcct(pinPlusUntagged, 'OWN-A').map(lotsOf).join() === '050',
        JSON.stringify(pinPlusUntagged.map(r => [lotsOf(r), r.accountNo])));

  // ── Same destination reached different ways → one line ──────────────
  console.log('\n[5] Different bank_ids resolving to ONE account merge into one line');
  const merged = pick(['010', '030', '040', '050']);   // explicit-default + stale + dangling + untagged
  check('one row, not four', merged.length === 1, `got ${merged.length}: ` +
        JSON.stringify(merged.map(r => [lotsOf(r), r.accountNo])));
  check('carries all four lots', lotsOf(merged[0]) === '010,030,040,050', lotsOf(merged[0]));
  check('carries the full total', Number(merged[0].amount) === 200000, String(merged[0].amount));

  console.log('\n[6] The whole picked set: two lines, nothing lost, nothing misrouted');
  const all = pick(ALL);
  check('exactly two rows', all.length === 2, `got ${all.length}: ` +
        JSON.stringify(all.map(r => [lotsOf(r), r.accountNo])));
  check('total equals every picked lot',
        all.reduce((s, r) => s + Number(r.amount), 0) === 250000,
        String(all.reduce((s, r) => s + Number(r.amount), 0)));
  check('no line addressed to the other seller',
        all.every(r => r.accountNo !== 'OTHER-ACCT'),
        JSON.stringify(all.map(r => r.accountNo)));
  check('every lot appears exactly once',
        all.map(lotsOf).join(',').split(',').sort().join() === ALL.join(),
        all.map(lotsOf).join(' | '));

  console.log('\n[7] The unfiltered whole-seller export is untouched');
  // No lot filter → one seller-level row on the default account, as always.
  const plain = getBankPaymentData(db, 1, cfg, {});
  check('single row for the seller', plain.length === 1, `got ${plain.length}`);
  check('on the default account', plain[0].accountNo === 'OWN-A', plain[0].accountNo);
  check('paying the whole trade', Number(plain[0].amount) === 250000, String(plain[0].amount));

  // ── The badge must agree with the export ────────────────────────────
  // "Multiple banks" tells the operator to export each account's lots
  // separately. If it fires for a seller the export pays on ONE line, it is
  // sending them to split a file that cannot be split.
  console.log('\n[8] The "multiple banks" badge counts destinations, not pins');
  const { getPaymentSummary } = require(path.join(__dirname, '..', 'calculations.js'));
  const badgeFor = (name) => {
    const row = getPaymentSummary(db, 1, null, cfg).find(r => r.name === name);
    return row ? row.multipleBanks : undefined;
  };
  // As fixtured, SELLER's lots span OWN-A and OWN-B — genuinely two accounts.
  check('fires for a seller whose lots really do span two accounts',
        badgeFor('SELLER PLANTER') === true, String(badgeFor('SELLER PLANTER')));

  // Now leave only lots that all resolve to the default: the explicit pin on
  // OWN-A (lot 010), the stale pin, the dangling pin and the untagged lot.
  db.run(`DELETE FROM lots WHERE lot_no = '020'`);
  check('silent once every lot resolves to the same account',
        badgeFor('SELLER PLANTER') === false, String(badgeFor('SELLER PLANTER')));
  check('and the export agrees — one line',
        pick(['010', '030', '040', '050']).length === 1);

  // A lot pinned to the seller's own DEFAULT is the same destination as an
  // untagged lot, not a second account — the old pin-counting logic called
  // this "multiple banks" and it is why ELAICHIROYAL carried the badge.
  console.log('\n[9] A pin naming the default is not a second account');
  db.run(`UPDATE lots SET bank_id = NULL WHERE lot_no IN ('030','040')`);
  check('one lot pinned to the default + untagged lots is not "multiple"',
        badgeFor('SELLER PLANTER') === false, String(badgeFor('SELLER PLANTER')));

  console.log(`\n${pass} passed, ${fail} failed`);
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
