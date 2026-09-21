// FORM C — no name on a statutory return may be printed cut short.
//
// Form C is a Spices Board filing. Its eleven columns include two full
// names-and-addresses and three money columns, and its widths used to be
// fixed fractions of the page: "Name and full address of bidder" got 15.5%
// where its longest value wants 31%, while Sample Refund and Commission each
// got 7% for figures needing 5%. 310 cells were clipped across the customer's
// four trades, nearly all of them bidder names ("ELAICHIROYAL PRIVATE
// LIMITE…").
//
// Measured against real data the form needs 740pt to print every value at its
// normal 6.5pt, and 579pt even with everything shrunk to the 5pt floor.
// PORTRAIT A4 GIVES 559pt — so portrait could not show this form in full at
// any size, and re-measuring the columns alone made it worse, not better
// (1,406 clipped). The page had to turn. That is the same remedy bank_payment
// / tally_purchase / sales_taxes took, for the same reason.
//
//   [landscape]  the page is landscape, because portrait provably cannot fit
//   [fits]       long bidder and seller names print in full
//   [figures]    no money figure loses a digit to make room
//   [structure]  the statutory column count and numbering survive
//   [control]    the detector really does catch a clipped cell
//
// Driven in-process: the server holds the database in memory (sql.js) and
// writes the file on a debounce, so a second connection cannot stage this.
const os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'formc-fit-'));
process.env.SPICE_DATA_DIR = TMP;   // db.js reads this — never the real data dir

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// Decode a PDFKit document's text back out — same helper as
// tests/auction-report-column-fit.unit.js and pooler-certificate-zero-rows.
// Form C sets its cells in Helvetica, a standard-14 font under WinAnsi, where
// the ellipsis drawFittedCell appends is byte 0x85.
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
  for (const tj of raw.match(/\[[^\]]*\]\s*TJ/g) || []) {
    for (const h of tj.match(/<([0-9A-Fa-f]+)>/g) || []) {
      out += Buffer.from(h.slice(1, -1), 'hex').toString('latin1');
    }
    out += ' ';
  }
  return out;
}
const clipped = (txt) => (txt.match(/\x85/g) || []).length;
// PDFKit splits a run wherever it kerns, so a name arrives with stray spaces
// inside it ("PRIV ATE"). Compare on the letters alone.
const squash = (s) => s.replace(/\s+/g, '');

(async () => {
  const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
  await initDb();
  const db = getDb();
  require(path.join(ROOT, 'company-config.js')).initCompanySettings(db);
  const sb = require(path.join(ROOT, 'spice-board-reports.js'));

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('91','2026-09-12','KERALA')`);
  const aid = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;

  // The customer's real extremes, on both sides of the form.
  const LONG_BIDDER = 'ALLUS GLOBAL SPICE TRADE LINKS PRIVATE LIMITED';
  const LONG_SELLER = 'SHAJI JOSEPH CHERUPARAMPIL PANIKULANGARA';
  const LONG_SBL    = 'CS/55713/783/202425';
  const LONG_GSTIN  = 'GSTIN.32AAMCM4500C1Z2';

  db.run(`INSERT INTO buyers (buyer, buyer1, code, sbl, state)
          VALUES ('AGS',?,'AGS',?,'KERALA')`, [LONG_BIDDER, LONG_SBL]);

  // A planter (CR registration → PLANTERS section) and a GSTIN dealer
  // (→ DEALERS section), so both buckets and both subtotal rows are drawn.
  // Big figures so the money columns are genuinely wide — the GRAND TOTAL
  // value is the widest figure anywhere on the form.
  //
  // The dealer is given NO board licence on purpose: Form C's registration
  // column prefers the seller's SBL and falls back to the `cr`, so this is
  // what puts a full 21-character GSTIN in that column — the widest value it
  // ever has to hold.
  const SELLERS = [
    { name: LONG_SELLER,                       cr: 'CR.',      sbl: 'CS/DL-231/188/202324' },
    { name: 'PANIKULANGARA SPICES TRADING CO', cr: LONG_GSTIN, sbl: '' },
  ];
  let lot = 0;
  for (const sl of SELLERS) {
    db.run(`INSERT INTO traders (name, cr, aadhar, ppla, pstate) VALUES (?,?,?,?,?)`,
           [sl.name, sl.cr, sl.sbl, 'NIRAPPELKADA', 'KERALA']);
    const tid = db.get('SELECT id FROM traders ORDER BY id DESC LIMIT 1').id;
    for (let i = 0; i < 4; i++) {
      lot += 1;
      const qty = 5634.5 + i * 100, price = 3178 + i, amount = qty * price;
      db.run(`INSERT INTO lots (auction_id, trader_id, lot_no, name, cr, aadhar, ppla, pstate,
                                bags, qty, price, amount, refund, com, code, buyer, buyer1, sale)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
             [aid, tid, String(lot).padStart(3, '0'), sl.name, sl.cr, sl.sbl, 'NIRAPPELKADA', 'KERALA',
              137, qty, price, amount, 10505.1, amount * 0.01, 'AGS', 'AGS', LONG_BIDDER, 'L']);
    }
  }

  console.log('[landscape] the page turned, because portrait provably cannot fit this form');
  const buf = await sb.REPORTS.form_c.pdf(db, { auctionId: aid });
  check('renders a PDF', buf.slice(0, 4).toString() === '%PDF', `${buf.length} bytes`);
  // A4 landscape is 841.89 x 595.28pt; portrait is the transpose. Read the
  // page box straight out of the file rather than trusting the call.
  const box = buf.toString('latin1').match(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  check('the page is wider than it is tall', box && Number(box[1]) > Number(box[2]),
        box ? `${box[1]} x ${box[2]}` : 'no MediaBox found');
  check('…and it is A4, not some other paper', box && Math.round(Number(box[1])) === 842,
        box && box[1]);

  const txt = pdfText(buf);

  console.log('\n[fits] every name prints in full');
  check('nothing on the form is clipped', clipped(txt) === 0, `${clipped(txt)} cell(s) ellipsized`);
  check('the 46-character bidder name is intact',
        squash(txt).includes(squash(LONG_BIDDER)), 'not found');
  check('the longest seller name is intact',
        squash(txt).includes(squash(LONG_SELLER)), 'not found');
  check('the bidder licence number is intact',
        squash(txt).includes(squash(LONG_SBL)), 'not found');
  check('a GSTIN registration is intact',
        squash(txt).includes('32AAMCM4500C1Z2'), 'not found');

  console.log('\n[figures] no figure loses a digit to make room');
  const { fmtMoney, fmtQty } = require(path.join(ROOT, 'report-formatters.js'));
  const g = db.get(`SELECT COALESCE(SUM(amount),0) AS v, COALESCE(SUM(qty),0) AS q
                      FROM lots WHERE auction_id = ?`, [aid]);
  check('the GRAND TOTAL value prints in full', squash(txt).includes(squash(fmtMoney(g.v))),
        fmtMoney(g.v));
  check('the GRAND TOTAL quantity prints in full', squash(txt).includes(squash(fmtQty(g.q))),
        fmtQty(g.q));

  console.log('\n[structure] the statutory layout survives');
  check('both sections are present',
        /PLANTERSTOTAL/.test(squash(txt)) && /DEALERSTOTAL/.test(squash(txt)), 'a section total is missing');
  check('the form keeps its title and rule reference',
        squash(txt).includes('FORMC') && squash(txt).includes('rules5(2)'), 'title/rule missing');
  check('the eleven-column numbering row is intact',
        /1\s*2\s*3\s*4\s*5\s*6\s*7\s*8\s*9\s*10\s*11/.test(txt.replace(/\s+/g, ' ')),
        'the 1..11 row under the headers was not found');
  check('the auctioneer confirmation is present',
        squash(txt).includes('Signatureoftheauctioneer'), 'signature block missing');

  console.log('\n[control] the detector catches a cell that genuinely cannot fit');
  // A name no page could hold. If this does NOT clip, everything above is
  // vacuous and this test is worthless.
  db.run(`UPDATE lots SET buyer1 = ? WHERE auction_id = ?`, ['X'.repeat(600), aid]);
  db.run(`UPDATE buyers SET buyer1 = ? WHERE code = 'AGS'`, ['X'.repeat(600)]);
  const wild = pdfText(await sb.REPORTS.form_c.pdf(db, { auctionId: aid }));
  check('an impossible name IS reported as clipped', clipped(wild) > 0,
        'the ellipsis detector found nothing — the checks above prove nothing');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
