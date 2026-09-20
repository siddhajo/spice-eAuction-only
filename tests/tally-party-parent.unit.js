// PARTY LEDGER PARENT GROUPS — the <PARENT> tag on a Tally LEDGER master.
//
// <PARENT> is the GROUP a party ledger is filed under (Sundry Debtors,
// Sundry Creditors, Planters…). It is not an accounting ledger and nothing
// posts to it. Three settings drive it, one per party family:
//
//   sales → tally_sales_party_parent_intra / _inter, picked by the party
//           GSTIN's state prefix against tally_state_code
//   RD    → tally_rd_party_parent, ONE group for every dealer
//   URD   → tally_purchase_planter_parent, one group for every planter
//
// Each falls back to the legacy key the code read before these existed, and
// then to the historical hardcoded value — so an install that never opens
// Settings exports exactly what it exported before. That fallback is the
// point of this test: the legacy keys are labelled like accounting ledgers
// ("Local Dealer (sales-side)") and on at least one live install they had
// been filled in with ledger names, so we cannot simply drop them.
//
// Runs against a THROWAWAY database. SPICE_DATA_DIR must be set before db.js
// is required (it reads the env var at module load) or the live
// data/config.db is mutated.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parentgrp-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb } = require(path.join(__dirname, '..', 'db.js'));
const T = require(path.join(__dirname, '..', 'tally-xml.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// Home state 32 (Kerala): a 32… party is intra, anything else inter.
const HOME = { tally_state_code: '32' };
const LEGACY = Object.assign({}, HOME, {
  tally_dealer_sale_intra:     'LEGACY-SALES-LOCAL',
  tally_dealer_sale_inter:     'LEGACY-SALES-INTER',
  tally_purchase_dealer_intra: 'LEGACY-RD-LOCAL',
  tally_purchase_dealer_inter: 'LEGACY-RD-INTER',
});
const NEW = Object.assign({}, LEGACY, {
  tally_sales_party_parent_intra: 'Sundry Debtors - KL',
  tally_sales_party_parent_inter: 'Sundry Debtors - OTHER',
  tally_rd_party_parent:          'Sundry Creditors - Dealers',
  tally_purchase_planter_parent:  'Sundry Creditors - Planters',
});

(async () => {
  await initDb();
  const db = getDb();

  db.prepare("INSERT INTO traders (id,name,cr,pan) VALUES (1,'DEALER KL','GSTIN.32AAHCE4551A1Z8','AAHCE4551A')").run();
  db.prepare("INSERT INTO traders (id,name,cr,pan) VALUES (2,'DEALER TN','GSTIN.33AAHCE4551A1Z8','AAHCE4551A')").run();
  db.prepare("INSERT INTO traders (id,name,cr,pan) VALUES (3,'PLANTER','','ABCDE1234F')").run();
  const A = db.prepare("INSERT INTO auctions (ano,date) VALUES ('9','2026-09-01')").run().lastInsertRowid;
  for (const [lot, tid, nm, cr] of [['1', 1, 'DEALER KL', 'GSTIN.32AAHCE4551A1Z8'],
                                    ['2', 2, 'DEALER TN', 'GSTIN.33AAHCE4551A1Z8'],
                                    ['3', 3, 'PLANTER', '']])
    db.prepare('INSERT INTO lots (auction_id,lot_no,trader_id,name,cr,pstate) VALUES (?,?,?,?,?,?)')
      .run(A, lot, tid, nm, cr, 'Kerala');
  db.prepare("INSERT INTO buyers (buyer,buyer1,gstin,state) VALUES ('B1','BUYER KL','32AAACB1234C1ZQ','Kerala')").run();
  db.prepare("INSERT INTO buyers (buyer,buyer1,gstin,state) VALUES ('B2','BUYER TN','33AAACB1234C1ZQ','Tamil Nadu')").run();
  for (const [b, invo] of [['B1', '101'], ['B2', '102']])
    db.prepare("INSERT INTO invoices (auction_id,ano,date,buyer,invo,sale,is_proforma) VALUES (?,'9','2026-09-01',?,?,'L',0)")
      .run(A, b, invo);

  // parent-of, by party name prefix, across all three builders
  const parents = (cfg) => {
    const rows = [].concat(T.buildSalesPartyLedgerRows(db, A, cfg),
                           T.buildRDPartyLedgerRows(db, A, cfg),
                           T.buildURDPartyLedgerRows(db, A, cfg));
    const out = {};
    for (const r of rows) out[String(r.name).split('-')[0].trim()] = r.parent;
    return out;
  };

  console.log('[1] Nothing set — the historical hardcoded values, unchanged');
  let p = parents(HOME);
  check('intra buyer  → Local Dealer-Purchase',      p['BUYER KL'] === 'Local Dealer-Purchase', p['BUYER KL']);
  check('inter buyer  → Interstate Dealer-Purchase', p['BUYER TN'] === 'Interstate Dealer-Purchase', p['BUYER TN']);
  check('intra dealer → Local Dealer',               p['DEALER KL'] === 'Local Dealer', p['DEALER KL']);
  check('inter dealer → Interstate Dealer',          p['DEALER TN'] === 'Interstate Dealer', p['DEALER TN']);
  check('planter      → Planters',                   p['PLANTER'] === 'Planters', p['PLANTER']);

  console.log('[2] Legacy keys only — an existing install is not disturbed');
  p = parents(LEGACY);
  check('intra buyer  reads tally_dealer_sale_intra',     p['BUYER KL'] === 'LEGACY-SALES-LOCAL', p['BUYER KL']);
  check('inter buyer  reads tally_dealer_sale_inter',     p['BUYER TN'] === 'LEGACY-SALES-INTER', p['BUYER TN']);
  check('intra dealer reads tally_purchase_dealer_intra', p['DEALER KL'] === 'LEGACY-RD-LOCAL', p['DEALER KL']);
  check('inter dealer reads tally_purchase_dealer_inter', p['DEALER TN'] === 'LEGACY-RD-INTER', p['DEALER TN']);

  console.log('[3] New keys set — they win over the legacy pair');
  p = parents(NEW);
  check('intra buyer  → the intra sales group', p['BUYER KL'] === 'Sundry Debtors - KL', p['BUYER KL']);
  check('inter buyer  → the inter sales group', p['BUYER TN'] === 'Sundry Debtors - OTHER', p['BUYER TN']);
  check('planter      → the URD group',         p['PLANTER'] === 'Sundry Creditors - Planters', p['PLANTER']);
  // The RD key is deliberately flat where the legacy pair split on state:
  // one group for every dealer, whichever state they are in.
  check('intra dealer → the one RD group', p['DEALER KL'] === 'Sundry Creditors - Dealers', p['DEALER KL']);
  check('inter dealer → the SAME RD group', p['DEALER TN'] === 'Sundry Creditors - Dealers', p['DEALER TN']);

  console.log('[4] Sales split follows tally_state_code, not a hardcoded 32');
  // Move the company to Tamil Nadu: the 33… buyer becomes the intra one.
  p = parents(Object.assign({}, NEW, { tally_state_code: '33' }));
  check('33… buyer is now intra', p['BUYER TN'] === 'Sundry Debtors - KL', p['BUYER TN']);
  check('32… buyer is now inter', p['BUYER KL'] === 'Sundry Debtors - OTHER', p['BUYER KL']);

  console.log('[5] The values reach the XML as <PARENT>');
  const xml = T.generLedgerXML(
    [].concat(T.buildSalesPartyLedgerRows(db, A, NEW),
              T.buildRDPartyLedgerRows(db, A, NEW),
              T.buildURDPartyLedgerRows(db, A, NEW)), NEW, {}).replace(/\r/g, '');
  for (const g of ['Sundry Debtors - KL', 'Sundry Debtors - OTHER',
                   'Sundry Creditors - Dealers', 'Sundry Creditors - Planters'])
    check(`<PARENT>${g}</PARENT> is in the ledger XML`, xml.includes(`<PARENT>${g}</PARENT>`));

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
