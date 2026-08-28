// lots.bank_id integrity — the pin must keep meaning what the operator meant.
//
// A lot's `bank_id` pins it to one of the seller's accounts. Two source-level
// bugs used to break that pin, both of them ending in money addressed to the
// wrong account or a payment file split for no reason:
//
//   • syncTraderBanks deleted and re-inserted a seller's bank rows on EVERY
//     save. trader_banks is AUTOINCREMENT, so the rebuilt rows came back with
//     new ids and every existing pin was orphaned — a seller whose address was
//     corrected silently lost the routing on all their lots.
//   • correcting the SELLER on a lot rewrote every denormalised seller column
//     but left bank_id alone, so the lot stayed pinned to the previous
//     seller's account and the bank file paid that stranger.
//
// Runs against a THROWAWAY database. SPICE_DATA_DIR must be set before db.js
// is required (it reads the env var at module load) or the live data/config.db
// is mutated.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bankpin-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb, closeDb } = require(path.join(__dirname, '..', 'db.js'));
const { syncTraderBanks } = require(path.join(__dirname, '..', 'trader-lot-sync.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

(async () => {
  await initDb();
  const db = getDb();
  const banksOf = tid => db.all('SELECT id, acctnum, ifsc, bank_name, branch, account_type, is_default FROM trader_banks WHERE trader_id = ? ORDER BY id', [tid]);

  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (1,'7','2026-08-10','TAMIL NADU')`);
  db.run(`INSERT INTO traders (id,name,cr) VALUES (1,'SELLER PLANTER','')`);
  db.run(`INSERT INTO traders (id,name,cr) VALUES (2,'OTHER PLANTER','')`);

  // ── Ids survive an ordinary re-save ─────────────────────────────────
  console.log('\n[1] Re-saving a seller keeps each account\'s id');
  syncTraderBanks(db, 1, [
    { acctnum: 'AAA-111', ifsc: 'aaaa0000001', bank_name: 'Alpha', is_default: 1 },
    { acctnum: 'BBB-222', ifsc: 'BBBB0000002', bank_name: 'Beta' },
  ]);
  const first = banksOf(1);
  check('two accounts stored', first.length === 2, `got ${first.length}`);
  const idA = first[0].id, idB = first[1].id;

  // The operator edits the seller's address; the client re-POSTs the same
  // accounts (with the bank name tweaked) as part of the whole trader record.
  syncTraderBanks(db, 1, [
    { acctnum: 'AAA-111', ifsc: 'AAAA0000001', bank_name: 'Alpha Bank Ltd', is_default: 1 },
    { acctnum: 'BBB-222', ifsc: 'BBBB0000002', bank_name: 'Beta' },
  ]);
  const second = banksOf(1);
  check('still two accounts', second.length === 2, `got ${second.length}`);
  check('account A kept its id', second[0].id === idA, `${idA} → ${second[0].id}`);
  check('account B kept its id', second[1].id === idB, `${idB} → ${second[1].id}`);
  check('editable detail was updated in place',
        second[0].bank_name === 'Alpha Bank Ltd', second[0].bank_name);
  check('ifsc is matched case-insensitively, not treated as a new account',
        second[0].ifsc === 'AAAA0000001', second[0].ifsc);

  // ── A pinned lot survives that re-save ──────────────────────────────
  console.log('\n[2] A lot pinned to an account survives the seller being edited');
  db.run(`INSERT INTO lots (auction_id,lot_no,trader_id,name,cr,bank_id,qty,price,amount,puramt,balance,grade,bags,reserved)
          VALUES (1,'010',1,'SELLER PLANTER','',?,100,500,50000,50000,50000,'2',10,0)`, [idB]);
  syncTraderBanks(db, 1, [
    { acctnum: 'AAA-111', ifsc: 'AAAA0000001', bank_name: 'Alpha Bank Ltd', is_default: 1 },
    { acctnum: 'BBB-222', ifsc: 'BBBB0000002', bank_name: 'Beta' },
  ]);
  const pinned = db.get(`SELECT bank_id FROM lots WHERE lot_no = '010'`);
  check('pin still points at account B', pinned.bank_id === idB, `${idB} → ${pinned.bank_id}`);
  check('account B still exists',
        !!db.get('SELECT 1 AS x FROM trader_banks WHERE id = ?', [idB]));

  // ── Genuine changes still take effect ───────────────────────────────
  console.log('\n[3] Adding and removing accounts still works');
  syncTraderBanks(db, 1, [
    { acctnum: 'AAA-111', ifsc: 'AAAA0000001', bank_name: 'Alpha Bank Ltd', is_default: 1 },
    { acctnum: 'CCC-333', ifsc: 'CCCC0000003', bank_name: 'Gamma' },
  ]);
  const third = banksOf(1);
  check('B removed, C added, still two rows', third.length === 2, `got ${third.length}`);
  check('A still holds its original id', third.some(b => b.id === idA));
  check('B is gone', !third.some(b => b.id === idB));
  check('C got a fresh id, not B\'s', !third.some(b => b.acctnum === 'CCC-333' && b.id === idB),
        JSON.stringify(third.map(b => [b.id, b.acctnum])));
  check('the orphaned pin is left in place for readers to ignore',
        db.get(`SELECT bank_id FROM lots WHERE lot_no='010'`).bank_id === idB);

  console.log('\n[4] The default is preserved when the client omits the flag');
  syncTraderBanks(db, 1, [
    { acctnum: 'CCC-333', ifsc: 'CCCC0000003', bank_name: 'Gamma' },
    { acctnum: 'AAA-111', ifsc: 'AAAA0000001', bank_name: 'Alpha Bank Ltd' },
  ]);
  const fourth = banksOf(1);
  check('A is still the default', fourth.find(b => b.acctnum === 'AAA-111').is_default === 1,
        JSON.stringify(fourth.map(b => [b.acctnum, b.is_default])));
  check('exactly one default', fourth.filter(b => b.is_default === 1).length === 1);
  check('legacy traders columns mirror the default',
        db.get('SELECT acctnum FROM traders WHERE id = 1').acctnum === 'AAA-111');

  console.log('\n[5] Duplicate entries each keep their own row');
  syncTraderBanks(db, 2, [
    { acctnum: 'DUP-1', ifsc: 'DDDD0000001', bank_name: 'One' },
    { acctnum: 'DUP-1', ifsc: 'DDDD0000001', bank_name: 'Two' },
  ]);
  const dupFirst = banksOf(2);
  check('two rows for the duplicated account', dupFirst.length === 2, `got ${dupFirst.length}`);
  syncTraderBanks(db, 2, [
    { acctnum: 'DUP-1', ifsc: 'DDDD0000001', bank_name: 'One' },
    { acctnum: 'DUP-1', ifsc: 'DDDD0000001', bank_name: 'Two' },
  ]);
  const dupSecond = banksOf(2);
  check('both ids survive the re-save',
        dupSecond.map(b => b.id).join() === dupFirst.map(b => b.id).join(),
        `${dupFirst.map(b => b.id)} → ${dupSecond.map(b => b.id)}`);

  console.log('\n[6] Clearing every account empties the table for that seller');
  syncTraderBanks(db, 2, []);
  check('no rows left', banksOf(2).length === 0, `got ${banksOf(2).length}`);
  check('legacy traders columns cleared too',
        db.get('SELECT acctnum FROM traders WHERE id = 2').acctnum === '');
  check('the other seller is untouched', banksOf(1).length === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
