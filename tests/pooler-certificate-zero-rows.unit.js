// Pooler Certificate — lots with no price AND no bill amount stay OUT of the
// annexure. The certificate attests to payment received; a "0 / 0" row attests
// to nothing, and it made the annexure look like the pooler was short-paid.
//
// The Pooler REGISTER is unchanged — it still lists every lot, because it has
// to reconcile the full lot list. This test pins both halves of that.
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Isolated DB — db.js reads SPICE_DATA_DIR, so set it BEFORE requiring db.
const os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poolcert-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb } = require(path.join(ROOT, 'db'));
const { getPoolerRegister } = require(path.join(ROOT, 'calculations'));
const { renderPoolerCertificatePdf } = require(path.join(ROOT, 'exports-pdf'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// Read the visible text out of a PDFKit document: the page content streams are
// Flate-compressed, and inside them each run is a hex string in a TJ array
// (kerning splits one word across several runs, so the runs are concatenated
// in order — "2,27,000" arrives as "2,2" + "7,000").
function pdfText(buf) {
  const zlib = require('zlib');
  let raw = '';
  const s = buf.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    try { raw += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) {}
  }
  let out = '';
  // A TJ array per text run; decode every hex literal inside it, then space
  // the runs apart so two adjacent cells don't read as one token.
  for (const tj of raw.match(/\[[^\]]*\]\s*TJ/g) || []) {
    for (const h of tj.match(/<([0-9A-Fa-f]+)>/g) || []) {
      out += Buffer.from(h.slice(1, -1), 'hex').toString('latin1');
    }
    out += ' ';
  }
  return out;
}

(async () => {
  await initDb();
  const db = getDb();
  db.run('INSERT INTO auctions (ano, date, crop_type, state) VALUES (?,?,?,?)',
         ['21', '2026-08-12', 'VST', 'TAMIL NADU']);
  const AID = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;
  db.run("INSERT INTO traders (name, cr, padd, ppla) VALUES (?,?,?,?)",
         ['RAMASAMY K', 'CR.', '12 MAIN ST', 'BODI']);
  const TID = db.get('SELECT id FROM traders ORDER BY id DESC LIMIT 1').id;

  // Four lots: two sold and billed, one withdrawn (no price, no bill), one
  // still unpriced. The last two are what must not reach the certificate.
  //          lot   qty   price  amount   balance(bill)  code
  const SEED = [
    ['101', 100, 1500, 150000, 148000, ''],
    ['102',  50, 1600,  80000,  79000, ''],
    ['103',  40,    0,      0,      0, 'WD'],
    ['104',  30,    0,      0,      0, ''],
  ];
  for (const [lot_no, qty, price, amount, balance, code] of SEED) {
    db.run(`INSERT INTO lots (auction_id, lot_no, trader_id, name, cr, qty, price, amount, balance, code, grade, state)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [AID, lot_no, TID, 'RAMASAMY K', 'CR.', qty, price, amount, balance, code, '1', 'TAMIL NADU']);
  }

  const reg = getPoolerRegister(db, { from: '2026-08-01', to: '2026-08-31', traderId: TID });
  const party = (reg.parties || [])[0];
  check('register still lists every lot, priced or not',
        !!party && party.rows.length === 4, party && String(party.rows.length));
  check('register total bill is the sum of the billed lots',
        !!party && Math.round(party.summary.billamount) === 227000,
        party && String(party.summary.billamount));

  const cfg = { date_format: 'dd/mm/yyyy' };
  const buf = await renderPoolerCertificatePdf(db, cfg, {
    from: '2026-08-01', to: '2026-08-31', party: 'RAMASAMY K', traderId: TID,
  });
  check('certificate renders', Buffer.isBuffer(buf) && buf.length > 1000, buf && String(buf.length));
  const text = pdfText(buf);
  check('the billed lots are in the annexure',
        /101/.test(text) && /102/.test(text));
  check('the withdrawn lot (no price, no bill) is not',
        !/\b103\b/.test(text), 'lot 103 appeared in the certificate');
  check('the unpriced lot (no price, no bill) is not',
        !/\b104\b/.test(text), 'lot 104 appeared in the certificate');
  check('the qty total covers only the listed lots (150, not 220)',
        /150\.00|150 /.test(text) && !/220\.00/.test(text));
  check('the paragraph amount is unchanged by the filter',
        /2,27,000/.test(text), 'expected Rs. 2,27,000 in the body');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
