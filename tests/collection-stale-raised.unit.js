// COLLECTION — a draft whose `raised_invo` points at a document that is not
// the buyer's own must still be printed.
//
// This is the state the customer's trade 15 was in. The stamp that marks a
// draft "raised" used to match on the draft number and the trade alone, so
// raising S KUMAR's Inter-state draft 33 also stamped ERPL's Local draft 33.
// Collection read ERPL's draft as superseded and dropped it — and no original
// existed for ERPL to take its place, so 5,521.1 kg simply left the register.
//
// The stamping is buyer-scoped now (server.js), but rows written before that
// still carry the bad reference. The register therefore has to stand on its
// own: it verifies the original exists FOR THAT BUYER instead of trusting the
// flag. That is what this pins.
//
// Driven in-process rather than over HTTP: the server holds the database in
// memory (sql.js) and writes the file on a debounce, so a second connection
// cannot stage this state.
const os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coll-stale-'));
process.env.SPICE_DATA_DIR = TMP;   // db.js reads this — never the real data dir

const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// The register, as { grand, rows:[{invo, name, qty}] }.
async function collection(db, aid) {
  const { exportCollection } = require(path.join(ROOT, 'exports.js'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await exportCollection(db, aid)));
  const ws = wb.worksheets[0];
  const rows = []; let grand = 0;
  ws.eachRow((row) => {
    const c1 = String(row.getCell(1).value == null ? '' : row.getCell(1).value);
    const c3 = String(row.getCell(3).value == null ? '' : row.getCell(3).value);
    const q = row.getCell(4).value;
    if (c3 === 'GRAND TOTAL') { grand = Number(q) || 0; return; }
    if (typeof q === 'number' && c1 && !/TOTAL/.test(c3) && !/^NOT IN/.test(c1)) {
      rows.push({ invo: c1, name: c3, qty: Number(q) || 0 });
    }
  });
  return { grand, rows };
}

(async () => {
  const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
  await initDb();
  const db = getDb();
  // initDb builds the trade tables; the settings table is owned by
  // company-config and is normally created during server boot.
  require(path.join(ROOT, 'company-config.js')).initCompanySettings(db);
  const setFlag = (v) => db.run(
    `INSERT INTO company_settings (key, value) VALUES ('flag_proforma_invoice', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [v]);
  setFlag('true');

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('99','2026-08-29','TAMIL NADU')`);
  const aid = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;
  for (const [code, name, st] of [['L1', 'LOCAL SPICES', 'TAMIL NADU'], ['F1', 'FAR SPICES', 'KERALA']]) {
    db.run(`INSERT INTO buyers (buyer, buyer1, code, state) VALUES (?,?,?,?)`, [code, name, code, st]);
  }
  // One lot each. The Local buyer's lot carries a draft stamp only; the
  // Inter-state buyer's carries a real original.
  db.run(`INSERT INTO lots (auction_id, lot_no, name, qty, amount, price, code, buyer, buyer1, sale, proforma_invo)
          VALUES (?,'1','PLANTER A',100,100000,1000,'L1','L1','LOCAL SPICES','L','33')`, [aid]);
  db.run(`INSERT INTO lots (auction_id, lot_no, name, qty, amount, price, code, buyer, buyer1, sale, invo, proforma_invo)
          VALUES (?,'2','PLANTER B',200,200000,1000,'F1','F1','FAR SPICES','I','500','33')`, [aid]);

  const mkInv = (sale, invo, buyer, buyer1, qty, tot, pf, raised) =>
    db.run(`INSERT INTO invoices (auction_id, ano, date, sale, invo, buyer, buyer1, qty, tot, is_proforma, raised_invo)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
           [aid, '99', '2026-08-29', sale, invo, buyer, buyer1, qty, tot, pf, raised]);

  // Two drafts numbered 33 — one per sale series, exactly as in trade 15 —
  // and ONE original, raised for the Inter-state buyer only.
  mkInv('L', '33',  'L1', 'LOCAL SPICES', 100, 100000, 1, '');
  mkInv('I', '33',  'F1', 'FAR SPICES',   200, 200000, 1, '500');
  mkInv('I', '500', 'F1', 'FAR SPICES',   200, 200000, 0, '');

  console.log('[healthy] the register covers both buyers');
  let c = await collection(db, aid);
  check('300 kg in total', Math.abs(c.grand - 300) < 0.01, `${c.grand}: ${JSON.stringify(c.rows)}`);
  check('the raised draft does not print beside its original',
        c.rows.length === 2, JSON.stringify(c.rows));

  console.log('\n[stale] the local draft is stamped from the OTHER buyer\'s original');
  // Exactly what the un-scoped UPDATE used to do.
  db.run(`UPDATE invoices SET raised_invo = '500' WHERE auction_id = ? AND buyer = 'L1' AND is_proforma = 1`, [aid]);
  const stamped = db.get(`SELECT raised_invo FROM invoices WHERE auction_id = ? AND buyer = 'L1' AND is_proforma = 1`, [aid]);
  check('the draft now claims to have been raised as 500', String(stamped.raised_invo) === '500',
        JSON.stringify(stamped));
  check('…and no original 500 exists for THAT buyer',
        !db.get(`SELECT 1 x FROM invoices WHERE auction_id = ? AND buyer = 'L1' AND COALESCE(is_proforma,0) = 0 AND invo = '500'`, [aid]),
        'an L1 original 500 unexpectedly exists');

  c = await collection(db, aid);
  check('the draft is STILL in the register', c.rows.some(r => String(r.name).trim() === 'L1'),
        JSON.stringify(c.rows));
  check('…so the total is unchanged at 300 kg — nothing vanished',
        Math.abs(c.grand - 300) < 0.01, `${c.grand}: ${JSON.stringify(c.rows)}`);

  console.log('\n[genuine] a draft whose own original IS present stays superseded');
  // The Inter-state draft 33 points at 500, which really is F1's original.
  const far = c.rows.filter(r => String(r.name).trim() === 'F1');
  check('the far buyer prints once, not twice', far.length === 1, JSON.stringify(far));
  check('…at the original\'s quantity', Math.abs(far[0].qty - 200) < 0.01, JSON.stringify(far));

  console.log('\n[sale change] drafted Local, billed Inter-state');
  // The Generate modal lets the operator raise a draft under a DIFFERENT sale
  // type than it was drafted under. The draft records the number it became but
  // not that number's series, so the identity check has to fall back from the
  // triple to number + buyer — otherwise a genuinely-raised draft reads as
  // pending and prints beside its own original, counting the buyer twice.
  db.run(`INSERT INTO buyers (buyer, buyer1, code, state) VALUES ('S1','SWITCH SPICES','S1','KERALA')`);
  db.run(`INSERT INTO lots (auction_id, lot_no, name, qty, amount, price, code, buyer, buyer1, sale, invo, proforma_invo)
          VALUES (?,'3','PLANTER C',50,50000,1000,'S1','S1','SWITCH SPICES','I','700','44')`, [aid]);
  // Draft raised as Local 44; the original went out Inter-state as 700.
  mkInv('L', '44',  'S1', 'SWITCH SPICES', 50, 50000, 1, '700');
  mkInv('I', '700', 'S1', 'SWITCH SPICES', 50, 50000, 0, '');
  setFlag('true');
  c = await collection(db, aid);
  const sw = c.rows.filter(r => String(r.name).trim() === 'S1');
  check('the buyer prints once, not twice', sw.length === 1, JSON.stringify(c.rows));
  check('…as the original, 50 kg', Math.abs(sw[0].qty - 50) < 0.01, JSON.stringify(sw));
  check('the trade total is 350 kg, not 400', Math.abs(c.grand - 350) < 0.01,
        `${c.grand}: ${JSON.stringify(c.rows)}`);

  console.log('\n[off] with the proforma feature off, only originals are read');
  setFlag('false');
  c = await collection(db, aid);
  check('only the originals are listed', c.rows.length === 2 && Math.abs(c.grand - 250) < 0.01,
        `${c.grand}: ${JSON.stringify(c.rows)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
