// Sales Journal under the proforma flow (flag_proforma_invoice), against a
// THROWAWAY database.
//
// Flag OFF — the journal is the original tax-invoice register it has always
//            been: raised originals only, bare "I 2009" numbers, drafts absent.
// Flag ON  — every row quotes the PROFORMA number the buyer holds, and PENDING
//            drafts (nothing raised from them yet) join the register.
//
// The interesting cases are the ones raised_invo alone gets wrong, which is why
// proforma-refs.js prefers the per-lot stamps:
//   • SPLIT       — one draft shipped as two originals; only the first carries
//                   a raised_invo back-reference.
//   • SALE CHANGE — drafted Local, billed Inter-state; the sale-keyed lookup
//                   misses and the printed letter must stay the DRAFT's own.
//   • DIRECT      — billed with no draft at all; falls back to the bare number.
const os = require('os'), path = require('path'), fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-proforma-'));
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

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('9', '2026-08-12', 'TAMIL NADU')`);
  const AID = db.get(`SELECT id FROM auctions WHERE ano = '9'`).id;

  // invoices: is_proforma 1 = draft. raised_invo = the original it became.
  // Numbers below are deliberately reused across the two series (draft 5 and
  // original 5 both exist) — that overlap is what made the old union-based
  // resolution print phantom numbers.
  const inv = (o) => {
    const r = Object.assign({
      is_proforma: 0, raised_invo: '', sale: 'L', bag: 10, qty: 100,
      amount: 40000, gunny: 0, pava_hc: 0, ins: 0,
      cgst: 0, sgst: 0, igst: 0, tcs: 0, rund: 0, tot: 40000,
      gstin: '', place: 'BODI',
    }, o);
    db.run(
      `INSERT INTO invoices (auction_id, ano, date, sale, invo, buyer, buyer1, gstin, place,
         bag, qty, amount, gunny, pava_hc, ins, cgst, sgst, igst, tcs, rund, tot,
         is_proforma, raised_invo)
       VALUES (?,'9','2026-08-12',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [AID, r.sale, String(r.invo), r.buyer, r.buyer1 || r.buyer, r.gstin, r.place,
       r.bag, r.qty, r.amount, r.gunny, r.pava_hc, r.ins, r.cgst, r.sgst, r.igst,
       r.tcs, r.rund, r.tot, r.is_proforma, r.raised_invo]
    );
  };
  const lot = (lot_no, buyer, invo, pf, sale) => db.run(
    `INSERT INTO lots (auction_id, lot_no, name, buyer, invo, proforma_invo, sale, qty, price, amount)
     VALUES (?,?,?,?,?,?,?,100,400,40000)`,
    [AID, lot_no, 'GROWER', buyer, String(invo), String(pf), sale || 'L']
  );

  // ARUL — plain: draft 5 raised as original 101, back-reference intact.
  inv({ invo: 5,   buyer: 'ARUL',    is_proforma: 1, raised_invo: '101' });
  inv({ invo: 101, buyer: 'ARUL' });
  lot('301', 'ARUL', 101, 5, 'L');

  // HANIFA — SPLIT: draft 6 shipped as originals 102 and 103. The generate
  // path stamped raised_invo on the draft once (→102), so 103 has no
  // back-reference and only the lot stamp can answer for it.
  inv({ invo: 6,   buyer: 'HANIFA',  is_proforma: 1, raised_invo: '102' });
  inv({ invo: 102, buyer: 'HANIFA' });
  inv({ invo: 103, buyer: 'HANIFA' });
  lot('302', 'HANIFA', 102, 6, 'L');
  lot('303', 'HANIFA', 103, 6, 'L');

  // RAJA — SALE CHANGE: drafted Local (PI/L-7), billed Inter-state (I 104).
  // The printed letter must stay the DRAFT's own L, not the invoice's I.
  inv({ invo: 7,   buyer: 'RAJA', sale: 'L', is_proforma: 1, raised_invo: '104' });
  inv({ invo: 104, buyer: 'RAJA', sale: 'I' });
  lot('304', 'RAJA', 104, 7, 'I');

  // MURUGAN — PENDING draft, nothing raised from it.
  inv({ invo: 8, buyer: 'MURUGAN', is_proforma: 1, raised_invo: '', tot: 67500, amount: 67500 });

  // SELVAM — billed DIRECTLY, no draft anywhere.
  inv({ invo: 105, buyer: 'SELVAM', sale: 'I' });

  const CFG_OFF = { flag_proforma_invoice: 'false', proforma_invoice_prefix: 'PI' };
  const CFG_ON  = { flag_proforma_invoice: 'true',  proforma_invoice_prefix: 'PI' };
  const byBuyer = (rows) => Object.fromEntries(rows.map(r => [r.buyer, r]));

  // ── Flag OFF ───────────────────────────────────────────────────────
  console.log('[1] Flag OFF — unchanged original register');
  const off = calc.getSalesJournal(db, AID, null, CFG_OFF);
  check('lists only raised originals (5 rows)', off.length === 5, `got ${off.length}`);
  check('no draft rows leak in', off.every(r => !r.is_proforma));
  check('numbers stay in the bare legacy form',
        byBuyer(off)['ARUL'].invo === '101',
        `got ${JSON.stringify(byBuyer(off)['ARUL'].invo)}`);
  check('MURUGAN\'s pending draft is absent', !byBuyer(off)['MURUGAN']);

  // ── Flag ON ────────────────────────────────────────────────────────
  console.log('\n[2] Flag ON — proforma numbers + pending drafts');
  const on = calc.getSalesJournal(db, AID, null, CFG_ON);
  const B = byBuyer(on);
  check('pending draft joins the register (6 rows)', on.length === 6, `got ${on.length}`);
  check('ARUL prints his draft number, not the original',
        B['ARUL'].invo === 'PI/L-5', `got ${JSON.stringify(B['ARUL'].invo)}`);
  check('the stored original is still available as invo_raw',
        B['ARUL'].invo_raw === '101', `got ${JSON.stringify(B['ARUL'].invo_raw)}`);

  // SPLIT — both originals must resolve back to the one draft. Before the lot
  // stamps were consulted, 103 fell through to the bare "L 103".
  const hanifa = on.filter(r => r.buyer === 'HANIFA').map(r => r.invo).sort();
  check('SPLIT: both originals resolve to the same draft PI/L-6',
        JSON.stringify(hanifa) === JSON.stringify(['PI/L-6', 'PI/L-6']),
        JSON.stringify(hanifa));

  // SALE CHANGE — the letter is the draft's, the row's own sale stays 'I'.
  check('SALE CHANGE: prints the DRAFT\'s letter (PI/L-7, not PI/I-7)',
        B['RAJA'].invo === 'PI/L-7', `got ${JSON.stringify(B['RAJA'].invo)}`);
  check('SALE CHANGE: the row still reports its own sale type (I)',
        B['RAJA'].sale === 'I', `got ${JSON.stringify(B['RAJA'].sale)}`);

  check('PENDING draft prints its own number under the prefix',
        B['MURUGAN'].invo === 'PI/L-8', `got ${JSON.stringify(B['MURUGAN'].invo)}`);
  check('PENDING draft is flagged so the UI/exports can tag it',
        B['MURUGAN'].is_proforma === 1);
  check('DIRECT-billed invoice falls back to the bare original number',
        B['SELVAM'].invo === 'I 105', `got ${JSON.stringify(B['SELVAM'].invo)}`);
  check('no phantom numbers: every cell is a single number',
        on.every(r => !String(r.invo).includes(',')),
        JSON.stringify(on.map(r => r.invo)));

  // ── Summary foots to the register ──────────────────────────────────
  console.log('\n[3] Ledger summary totals exactly the rows printed above');
  const sumOff = calc.getSalesJournalSummary(db, AID, null, CFG_OFF);
  const sumOn  = calc.getSalesJournalSummary(db, AID, null, CFG_ON);
  const rowTot = (rows) => Math.round(rows.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100;
  check('flag OFF: summary total == sum of the OFF rows',
        sumOff.stateTotal === rowTot(off), `${sumOff.stateTotal} vs ${rowTot(off)}`);
  check('flag ON: summary total == sum of the ON rows (draft included)',
        sumOn.stateTotal === rowTot(on), `${sumOn.stateTotal} vs ${rowTot(on)}`);
  check('flag ON total exceeds OFF by exactly the pending draft (67500)',
        Math.round((sumOn.stateTotal - sumOff.stateTotal) * 100) / 100 === 67500,
        `diff ${sumOn.stateTotal - sumOff.stateTotal}`);

  // ── Sale-type filter still applies to both row kinds ────────────────
  console.log('\n[4] The sale-type filter still applies');
  const onI = calc.getSalesJournal(db, AID, 'I', CFG_ON);
  check('filtering sale=I keeps RAJA and SELVAM only',
        onI.length === 2 && onI.every(r => r.sale === 'I'),
        JSON.stringify(onI.map(r => ({ b: r.buyer, s: r.sale }))));
  check('a draft is filtered by its OWN sale type, not the original\'s',
        !calc.getSalesJournal(db, AID, 'I', CFG_ON).some(r => r.buyer === 'MURUGAN'));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
