// AUCTION REPORT (both variants) — TRADE NAME must not come out truncated.
//
// The PDF's column widths used to be fixed fractions of the page, and they
// sized TRADE NAME for names shorter than the customer's. "SPICEMANNA
// EVERGREEN EXPORTS PRIVATE LIMITED" wants 228pt and was given 92, so it
// printed as "SPICEMANNA EVERGREEN EX…" — while AMOUNT and INV.AMOUNT each
// sat on ~24pt of slack, sized for figures wider than any the trade prints.
// Across the customer's four trades, both variants, 19 cells were clipped.
//
// Widths are now measured over everything the report prints, and the
// shortfall — when there is one — is taken from the figure columns rather
// than from the names: a money value set a point smaller is still exact, a
// firm name cut short is not.
//
//   [fits]      long firm and bidder names print in full, both variants
//   [headers]   …and no column title is truncated to buy that room
//   [control]   the detector really does catch a clipped cell
//   [figures]   no figure loses a digit to make room
//   [totals]    a four-digit BAG total is not cut to "1…"
//
// Driven in-process: the server holds the database in memory (sql.js) and
// writes the file on a debounce, so a second connection cannot stage this.
const os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-colfit-'));
process.env.SPICE_DATA_DIR = TMP;   // db.js reads this — never the real data dir

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// Decode a PDFKit document's text back out. Same helper as
// tests/pooler-certificate-zero-rows.unit.js: one TJ array per text run, so
// the runs are concatenated in order and spaced apart.
//
// The reports use Helvetica — a standard-14 font under WinAnsiEncoding, where
// the ellipsis drawFittedCell appends is byte 0x85. Counting those counts
// exactly the cells that had to be cut.
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
// The decoder splits a run wherever PDFKit kerns, so a name arrives with
// stray spaces inside it ("PRIV ATE"). Compare on the letters alone.
const squash = (s) => s.replace(/\s+/g, '');

(async () => {
  const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
  await initDb();
  const db = getDb();
  require(path.join(ROOT, 'company-config.js')).initCompanySettings(db);
  const ar = require(path.join(ROOT, 'auction-reports.js'));

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('88','2026-09-10','KERALA')`);
  const aid = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;

  // The customer's real extremes: the longest firm name and the longest
  // bidder name in their data, plus a buyer across the border so both the
  // INTER and INTRA sections are exercised.
  const LONG_FIRM  = 'ALLUS GLOBAL SPICE TRADE LINKS PRIVATE LIMITED';
  const LONG_FIRM2 = 'SPICEMANNA EVERGREEN EXPORTS PRIVATE LIMITED';
  const LONG_BID   = 'ABUBAKKAR SIDDIQ M';
  const PARTIES = [
    { code: 'AGS',  bid: 'SANTHOSH JOSE AGS', firm: LONG_FIRM,  st: 'KERALA',     sale: 'L' },
    { code: 'SVA',  bid: 'THOMAS MATHEW SVT', firm: 'SPICE VALLEY TRADING PRIVATE LIMITED', st: 'KERALA', sale: 'L' },
    { code: 'SEE',  bid: LONG_BID,            firm: LONG_FIRM2, st: 'TAMIL NADU', sale: 'I' },
  ];
  for (const p of PARTIES) {
    db.run(`INSERT INTO buyers (buyer, buyer1, code, state) VALUES (?,?,?,?)`,
           [p.bid, p.firm, p.code, p.st]);
  }
  // Big enough figures that the money columns are genuinely wide, and a bag
  // count whose TOTAL runs to four digits — the case that used to print "1…".
  let lot = 0;
  const mkInv = (p, invo, bag, qty, amount, tot) =>
    db.run(`INSERT INTO invoices (auction_id, ano, date, sale, invo, buyer, buyer1, bag, qty, amount, tot, is_proforma, raised_invo)
            VALUES (?,'88','2026-09-10',?,?,?,?,?,?,?,?,0,'')`,
           [aid, p.sale, invo, p.bid, p.firm, bag, qty, amount, tot]);
  for (const p of PARTIES) {
    for (let i = 0; i < 3; i++) {
      lot += 1;
      const bag = 137 + i * 40, qty = 6298.6 + i * 100, amount = 19927127.1 + i * 1000;
      db.run(`INSERT INTO lots (auction_id, lot_no, name, bags, qty, amount, price, code, buyer, buyer1, sale, invo)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
             [aid, String(lot), 'PLANTER ' + lot, bag, qty, amount, amount / qty,
              p.code, p.bid, p.firm, p.sale, String(lot)]);
      mkInv(p, String(lot), bag, qty, amount, Math.round(amount * 1.0514));
    }
  }

  // What the GRAND TOTAL strip will print, computed the way the report does.
  const { fmtMoney } = require(path.join(ROOT, 'report-formatters.js'));
  const grandMoney = fmtMoney(
    db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM lots WHERE auction_id = ?`, [aid]).s);

  for (const [name, opts] of [['buyer-wise', {}], ['invoice-wise', { invoiceWise: true }]]) {
    console.log(`\n[fits] ${name}`);
    const txt = pdfText(await ar.tradeReportPdf(db, aid, opts));
    check('nothing in the report is clipped', clipped(txt) === 0,
          `${clipped(txt)} cell(s) ellipsized`);
    check(`the 46-character firm name prints in full`,
          squash(txt).includes(squash(LONG_FIRM)), 'not found intact');
    check('…and so does the longest bidder name',
          squash(txt).includes(squash(LONG_BID)), 'not found intact');

    console.log(`[headers] ${name}`);
    for (const h of ['S.NO', name === 'invoice-wise' ? 'INVO' : 'SALE', 'BIDDER',
                     'TRADE NAME', 'BAG', 'QUANTITY', 'AMOUNT', 'INV.AMOUNT', 'CODE']) {
      check(`the ${h} title is not truncated`, squash(txt).includes(squash(h)), h);
    }

    console.log(`[figures] ${name}`);
    // The money and BAG totals must print in full — a figure column may
    // shrink, it may not drop a digit. Checked on the GRAND TOTAL rather than
    // on a row: the buyer-wise report groups by buyer code, so no row of it
    // carries a single invoice's figure.
    const bagTotal = String(PARTIES.length * (137 + 177 + 217));
    check(`the ${bagTotal}-bag grand total is not cut`, squash(txt).includes(bagTotal), bagTotal);
    check('the grand-total money figure prints in full',
          squash(txt).includes(squash(grandMoney)), grandMoney);
  }

  console.log('\n[control] the detector catches a cell that genuinely cannot fit');
  // A name no portrait page could hold. If this does NOT clip, the assertions
  // above are vacuous and the test is worthless.
  db.run(`UPDATE buyers SET buyer1 = ? WHERE code = 'AGS'`, ['X'.repeat(400)]);
  db.run(`UPDATE lots SET buyer1 = ? WHERE auction_id = ? AND code = 'AGS'`, ['X'.repeat(400), aid]);
  db.run(`UPDATE invoices SET buyer1 = ? WHERE auction_id = ? AND buyer = ?`,
         ['X'.repeat(400), aid, 'SANTHOSH JOSE AGS']);
  const wild = pdfText(await ar.tradeReportPdf(db, aid, { invoiceWise: true }));
  check('an impossible name IS reported as clipped', clipped(wild) > 0,
        'the ellipsis detector found nothing — the checks above prove nothing');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
