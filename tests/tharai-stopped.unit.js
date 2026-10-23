// Tharai List — lots STOPPED in Price Entry.
//
// The sheet exists to reconcile: INTER + LOCAL + WD bags must equal the
// trade's bags, which is what lets the office check it against the arrivals.
// A stopped lot was still sold and still arrived, so it is ANNOTATED, never
// moved or subtracted — the one rule a change here must not break.
//
//   [count]  STOPPED is a memo total, and the reconciliation still foots.
//   [tint]   A code row is marked when ANY of its lots is stopped, because a
//            PART-stopped buyer is exactly the one worth seeing.
//   [quiet]  A trade with nothing stopped gains no STOPPED line at all.
//
// tharaiListData is the ONE source both the spreadsheet and the PDF read
// (see exports.js), so testing it covers both renderings.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tharaistop-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb } = require(path.join(__dirname, '..', 'db.js'));
const { tharaiListData } = require(path.join(__dirname, '..', 'exports.js'));

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '\n         ' + JSON.stringify(d) : '')); }
};

(async () => {
  await initDb();
  const db = getDb();
  db.run("INSERT INTO auctions (ano, date, crop_type, state) VALUES ('90','2026-10-23','ISP','TAMIL NADU')");
  const A = db.get("SELECT id FROM auctions WHERE ano='90'").id;

  // Two buyers on the INTER side, one on LOCAL, plus a withdrawn lot.
  const lot = (no, code, sale, bags, qty, held) => db.run(
    `INSERT INTO lots (auction_id, lot_no, code, buyer, sale, bags, qty, amount, invoice_hold)
     VALUES (?,?,?,?,?,?,?,?,?)`, [A, no, code, code, sale, bags, qty, 1000, held]);
  lot('001', 'AA', 'I', 10, 500, 0);
  lot('002', 'AA', 'I',  5, 250, 1);   // AA is PART stopped
  lot('003', 'BB', 'I',  8, 400, 0);   // BB is clean
  lot('004', 'CC', 'L', 12, 600, 1);   // CC is wholly stopped
  lot('005', 'DD', 'W',  3, 150, 0);   // withdrawn

  const d = tharaiListData(db, A, {});

  console.log('[count] STOPPED is a memo total, and the sheet still foots');
  check('stopped bags are counted', d.stopped.bags === 17, d.stopped);
  check('…and stopped qty with them', Math.abs(d.stopped.qty - 850) < 0.001, d.stopped);
  check('…across both sides, not one', d.stopped.lots === 2, d.stopped);
  // 10+5+8 inter, 12 local, 3 WD = 38
  check('the reconciliation still foots', d.totalBags === 38, d.totalBags);
  check('…because stopped bags stay INSIDE their own side',
        d.tally.I.bags === 23 && d.tally.L.bags === 12 && d.tally.W.bags === 3,
        { I: d.tally.I.bags, L: d.tally.L.bags, W: d.tally.W.bags });

  console.log('\n[tint] a code is marked when ANY of its lots is stopped');
  const AA = d.inter.find(r => r.code === 'AA');
  const BB = d.inter.find(r => r.code === 'BB');
  const CC = d.local.find(r => r.code === 'CC');
  check('a PART-stopped buyer is marked', AA && AA.held === 1, AA);
  check('…and keeps its full bags, not just the live ones', AA && AA.bags === 15, AA);
  check('a clean buyer is not marked', BB && !BB.held, BB);
  check('a wholly-stopped buyer is marked', CC && CC.held === 1, CC);

  console.log('\n[quiet] nothing stopped → no STOPPED line');
  db.run('UPDATE lots SET invoice_hold = 0 WHERE auction_id = ?', [A]);
  const clean = tharaiListData(db, A, {});
  check('stopped totals fall to zero', clean.stopped.bags === 0 && clean.stopped.lots === 0, clean.stopped);
  check('…no code row is marked', ![...clean.inter, ...clean.local].some(r => r.held),
        [...clean.inter, ...clean.local].map(r => r.held));
  check('…and the trade still foots', clean.totalBags === 38, clean.totalBags);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
