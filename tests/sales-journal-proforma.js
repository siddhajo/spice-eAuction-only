// Sales Journal + its ledger summary, in proforma mode, against a THROWAWAY db.
//
// Regression for the duplicate-rows bug: when flag_proforma_invoice is ON the
// journal must read PROFORMA invoices ONLY — never originals. Mixing the two
// streams printed the same sale twice (a pending draft AND its directly-billed
// original, both under the same "PI/L-nn" number) and double-counted the
// ledger totals underneath.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-pf-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb, closeDb } = require(path.join(__dirname, '..', 'db.js'));
const { initCompanySettings } = require(path.join(__dirname, '..', 'company-config.js'));
const calc = require(path.join(__dirname, '..', 'calculations.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

function invoiceRow(o) {
  const db = getDb();
  db.run(`INSERT INTO invoices
    (auction_id,ano,date,state,sale,invo,buyer,buyer1,qty,amount,bag,cgst,sgst,tot,is_proforma,raised_invo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [o.aid, o.ano, '2026-08-10', 'TAMIL NADU', o.sale, o.invo, o.buyer, o.buyer1,
     o.qty, o.amount, o.bag, o.cgst || 0, o.sgst || 0, o.tot, o.is_proforma, o.raised_invo || '']);
}

(async () => {
  await initDb();
  const db = getDb();
  initCompanySettings(db);

  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (14,'14','2026-08-10','TAMIL NADU')`);

  // ── Fixture mirroring the reported live data (auction 14) ──
  // Buyer A: DUPLICATE TRIGGER — a directly-billed original (invo 3) AND a
  //          still-pending proforma (invo 23, raised_invo empty), same lots.
  invoiceRow({ aid:14, ano:'14', sale:'L', invo:'3',  buyer:'A', buyer1:'ALLUS',       qty:6516.2, amount:20795106.2, bag:145, tot:21865312, is_proforma:0 });
  invoiceRow({ aid:14, ano:'14', sale:'L', invo:'23', buyer:'A', buyer1:'ALLUS',       qty:6516.2, amount:20795106.2, bag:145, tot:21865312, is_proforma:1, raised_invo:'' });
  // Lot stamps that make the original (invo 3) map back to proforma 23 — this
  // is what made BOTH rows print "PI/L-23" under the old mixed filter.
  db.run(`INSERT INTO lots (auction_id,lot_no,buyer,buyer1,invo,proforma_invo,bags,amount) VALUES (14,'1','A','ALLUS','3','23',145,20795106.2)`);

  // Buyer B: properly raised — proforma 25 was raised as original 9.
  invoiceRow({ aid:14, ano:'14', sale:'L', invo:'9',  buyer:'B', buyer1:'AZIA',        qty:156.1, amount:481757.3, bag:4, tot:506685, is_proforma:0 });
  invoiceRow({ aid:14, ano:'14', sale:'L', invo:'25', buyer:'B', buyer1:'AZIA',        qty:156.1, amount:481757.3, bag:4, tot:506685, is_proforma:1, raised_invo:'9' });

  // ── Proforma mode ON — journal reads proformas ONLY ──
  console.log('[1] Proforma mode ON — proforma rows only, no duplicates');
  const cfgOn = { flag_proforma_invoice: 'true', proforma_invoice_prefix: 'PI', business_state: 'TAMIL NADU' };
  const jOn = calc.getSalesJournal(db, 14, '', cfgOn);
  const cells = jOn.map(r => r.invo);
  check('journal shows exactly 2 rows (one per proforma)', jOn.length === 2, JSON.stringify(cells));
  check('cells are the proforma numbers PI/L-23 and PI/L-25',
        JSON.stringify(cells.slice().sort()) === JSON.stringify(['PI/L-23', 'PI/L-25']),
        JSON.stringify(cells));
  check('no printed-invoice cell appears twice',
        new Set(cells).size === cells.length, JSON.stringify(cells));
  check('no ORIGINAL (bare-number) rows leaked in',
        jOn.every(r => String(r.invo).startsWith('PI/')), JSON.stringify(cells));
  check('every journal row is flagged proforma',
        jOn.every(r => Number(r.is_proforma) === 1));

  // Ledger summary must foot to the proforma rows only (not doubled).
  const sumOn = calc.getSalesJournalSummary(db, 14, '', cfgOn);
  // Local cardamom value = A(20795106.2) + B(481757.3) = 21276863.5
  const localLine = sumOn.lines.find(l => /Local Cardamom Sales/.test(l.label));
  check('ledger Local Cardamom value totals the 2 proformas (not doubled)',
        Math.abs(localLine.value - 21276863.5) < 0.1, `got ${localLine.value}`);
  check('ledger state total = sum of the 2 proforma invoice totals',
        Math.abs(sumOn.stateTotal - (21865312 + 506685)) < 0.1, `got ${sumOn.stateTotal}`);

  // ── Proforma mode OFF — journal reads originals ONLY (unchanged) ──
  console.log('\n[2] Proforma mode OFF — originals only (legacy behaviour)');
  const cfgOff = { flag_proforma_invoice: 'false', business_state: 'TAMIL NADU' };
  const jOff = calc.getSalesJournal(db, 14, '', cfgOff);
  const offCells = jOff.map(r => r.invo);
  check('journal shows the 2 originals', jOff.length === 2, JSON.stringify(offCells));
  check('no proforma prefix in classic mode',
        jOff.every(r => !String(r.invo).startsWith('PI/')), JSON.stringify(offCells));
  const sumOff = calc.getSalesJournalSummary(db, 14, '', cfgOff);
  check('classic ledger total = sum of the 2 original totals',
        Math.abs(sumOff.stateTotal - (21865312 + 506685)) < 0.1, `got ${sumOff.stateTotal}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  closeDb && closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
