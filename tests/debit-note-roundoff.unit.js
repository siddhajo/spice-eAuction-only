// DEBIT NOTE — "Round Off" and the whole-rupee Grand Total.
//
// Every DN renderer (pdf/render-debit-note-html.js, the PDFKit layout in
// server.js, the dealer DN CSV in exports.js) derives its Round Off row the
// same way: `total − (amount + cgst + sgst + igst)`. So the printed row is
// only ever as good as the STORED total. Generation used to store the total
// rounded to the PAISE, which pinned Round Off at 0.00 for ever and left
// paise on the Grand Total — 73,116.96 printed where the note should read
// Round Off 0.04 and a Grand Total of 73,117.
//
// Three things must hold:
//   [A] debitNoteTotal issues whole rupees when flag_round is on, keeps the
//       paise when it is off, and reports the difference as roundOff
//   [B] the db.js backfill heals rows written before that — but only on a
//       flag_round install, only where the stored total is still the
//       paise-exact sum of its own components, and idempotently
//   [C] with a rounded total stored, the renderers' own derivation lands on
//       the same figure the document should print
const os = require('os'), path = require('path'), fs = require('fs');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

// db.js reads SPICE_DATA_DIR at require time — set it before anything pulls
// it in, or this test mutates the live data/config.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-round-'));
process.env.SPICE_DATA_DIR = TMP;

const { debitNoteTotal } = require('../calculations');

console.log('[A] debitNoteTotal honours flag_round');
{
  // The two notes from the bug report.
  const a = debitNoteTotal(61963.52, 5576.72, 5576.72, 0, { flag_round: true });
  check('rounds 73,116.96 up to 73,117', a.total === 73117 && a.roundOff === 0.04, JSON.stringify(a));
  const b = debitNoteTotal(14016.41, 1261.48, 1261.48, 0, { flag_round: true });
  check('rounds 16,539.37 down to 16,539', b.total === 16539 && b.roundOff === -0.37, JSON.stringify(b));

  const off = debitNoteTotal(61963.52, 5576.72, 5576.72, 0, { flag_round: false });
  check('flag off keeps the paise, no round off', off.total === 73116.96 && off.roundOff === 0, JSON.stringify(off));

  // Raw settings rows hand booleans back as the string "true".
  const str = debitNoteTotal(100, 9, 9, 0, { flag_round: 'true' });
  check('the string "true" counts as on', str.total === 118 && str.roundOff === 0, JSON.stringify(str));

  const exact = debitNoteTotal(1000, 90, 90, 0, { flag_round: true });
  check('an exact-rupee note rounds off by nothing', exact.total === 1180 && exact.roundOff === 0, JSON.stringify(exact));

  const inter = debitNoteTotal(14016.41, 0, 0, 2522.95, { flag_round: true });
  check('IGST notes round the same way', inter.total === 16539 && inter.roundOff === -0.36, JSON.stringify(inter));
}

async function backfill() {
  console.log('\n[B] the backfill heals rows written before the fix');
  const { initDb, getDb, closeDb } = require('../db');
  const { initCompanySettings } = require('../company-config');
  await initDb();
  let db = getDb();
  initCompanySettings(db);

  const seed = (tbl, rows) => {
    for (const r of rows) {
      db.run(`INSERT INTO ${tbl} (ano,date,state,name,note_no,amount,cgst,sgst,igst,total)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ['1', '2026-09-01', 'TAMIL NADU', r.name, r.no, r.amount, r.cgst, r.sgst, r.igst || 0, r.total]);
    }
  };
  // paise-exact totals, as generation used to store them
  seed('debit_notes', [
    { name: 'DEALER PAISE', no: '1', amount: 61963.52, cgst: 5576.72, sgst: 5576.72, total: 73116.96 },
    { name: 'DEALER EXACT', no: '2', amount: 1000,     cgst: 90,      sgst: 90,      total: 1180 },
    // Hand-adjusted: the stored total is NOT the sum of its parts. Must survive.
    { name: 'DEALER TOUCHED', no: '3', amount: 61963.52, cgst: 5576.72, sgst: 5576.72, total: 73000 },
  ]);
  seed('debit_notes_planter', [
    { name: 'PLANTER PAISE', no: '1', amount: 14016.41, cgst: 1261.48, sgst: 1261.48, total: 16539.37 },
  ]);
  const totalOf = (tbl, name) => db.get(`SELECT total FROM ${tbl} WHERE name = ?`, [name]).total;
  check('seeded with paise, as the bug left them', totalOf('debit_notes', 'DEALER PAISE') === 73116.96);

  // flag_round on, then re-run startup — that is when the backfill fires.
  db.run("UPDATE company_settings SET value = 'true' WHERE key = 'flag_round'");
  closeDb(); await initDb(); db = getDb();

  check('dealer note rounded to whole rupees', totalOf('debit_notes', 'DEALER PAISE') === 73117, String(totalOf('debit_notes', 'DEALER PAISE')));
  check('planter note rounded to whole rupees', totalOf('debit_notes_planter', 'PLANTER PAISE') === 16539, String(totalOf('debit_notes_planter', 'PLANTER PAISE')));
  check('an already-exact note is left alone', totalOf('debit_notes', 'DEALER EXACT') === 1180, String(totalOf('debit_notes', 'DEALER EXACT')));
  check('a hand-adjusted total is left alone', totalOf('debit_notes', 'DEALER TOUCHED') === 73000, String(totalOf('debit_notes', 'DEALER TOUCHED')));

  // Idempotent — a second startup must not round the rounded value again.
  closeDb(); await initDb(); db = getDb();
  check('a second startup changes nothing', totalOf('debit_notes', 'DEALER PAISE') === 73117, String(totalOf('debit_notes', 'DEALER PAISE')));

  // And with the flag off, nothing is touched at all.
  db.run("UPDATE company_settings SET value = 'false' WHERE key = 'flag_round'");
  db.run("UPDATE debit_notes SET total = 73116.96 WHERE name = 'DEALER PAISE'");
  closeDb(); await initDb(); db = getDb();
  check('flag off leaves the paise in place', totalOf('debit_notes', 'DEALER PAISE') === 73116.96, String(totalOf('debit_notes', 'DEALER PAISE')));
  closeDb();
}

function rendererDerivation() {
  console.log('\n[C] the renderers derive the printed Round Off from that total');
  // The one line every DN renderer shares.
  const derive = (dn) => Math.round((Number(dn.total || 0)
    - (Number(dn.amount || 0) + Number(dn.cgst || 0) + Number(dn.sgst || 0) + Number(dn.igst || 0))) * 100) / 100;

  const cfg = { flag_round: true };
  for (const [amount, cgst, sgst] of [[61963.52, 5576.72, 5576.72], [14016.41, 1261.48, 1261.48], [1000, 90, 90]]) {
    const t = debitNoteTotal(amount, cgst, sgst, 0, cfg);
    const printed = derive({ amount, cgst, sgst, igst: 0, total: t.total });
    check(`Round Off prints ${t.roundOff.toFixed(2)} on a ${t.total} note`, printed === t.roundOff, `${printed} vs ${t.roundOff}`);
  }
}

(async () => {
  await backfill();
  rendererDerivation();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
