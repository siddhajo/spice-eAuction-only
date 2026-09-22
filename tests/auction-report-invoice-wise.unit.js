// AUCTION REPORT, INVOICE-WISE — the same report, one row per document.
//
// The buyer-wise Auction Report is computed from the LOTS and DERIVES its
// INV.AMOUNT from the sales-invoice formula: readable before a single invoice
// exists, but an estimate carrying no invoice number. This variant answers the
// other question — what has actually been BILLED — by reusing the Collection
// register's own row builder, which is what "similar to Collection" has to
// mean if the two are never to disagree about what was invoiced.
//
//   [agrees]      row for row, kilo for kilo, rupee for rupee with Collection
//   [columns]     SALE becomes INVO; AMOUNT / INV.AMOUNT are the invoice's own
//                 figures, not recomputed ones
//   [grouping]    INTER / INTRA keys on the INVOICE's sale letter, not on the
//                 buyer's state — an operator can bill across the two
//   [footer]      the stats block still counts every lot, so it does NOT move
//                 when invoices are added; the shortfall note explains the gap
//   [untouched]   the buyer-wise report still renders exactly as before
//
// Driven in-process rather than over HTTP: the server holds the database in
// memory (sql.js) and writes the file on a debounce, so a second connection
// cannot stage this state.
const os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-invwise-'));
process.env.SPICE_DATA_DIR = TMP;   // db.js reads this — never the real data dir

const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

// Read one rendered sheet back as { headers, rows, totals, note, stats }.
// `rows` are the data lines only — section strips and TOTAL lines are split
// out so a test can assert on each without re-deriving which is which.
//
// Subtotal LABELS repeat: every state section closes with its own
// "INTER-STATE SALES" / "INTRA STATE SALES" strip, so a flat label→figures map
// would silently keep only the last state's. They are keyed "<STATE> :: <label>"
// instead, with the state taken from the section strip that opened the block.
async function sheet(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf));
  const ws = wb.worksheets[0];
  const out = { name: ws.name, headers: [], rows: [], totals: {}, note: '', stats: {}, states: [] };
  const txt = (c) => {
    const v = c.value;
    if (v && v.richText) return v.richText.map(t => t.text).join('');
    return v == null ? '' : String(v);
  };
  let seenHeader = false, state = '';
  ws.eachRow((row) => {
    const c1 = txt(row.getCell(1)), c2 = txt(row.getCell(2));
    const q5 = row.getCell(5).value;
    if (c1 === 'SALE' || c1 === 'INVO') {
      out.headers = [1,2,3,4,5,6,7,8].map(i => txt(row.getCell(i)));
      seenHeader = true; return;
    }
    if (/^NOT IN THIS REGISTER/.test(c1)) { out.note = c1; return; }
    // Footer stats block: "TOTAL ARRIVALS | kgs | bags | lots".
    if (/^(TOTAL ARRIVALS|WITHDRAWN|SOLD|NOT e-AUCTIONED)$/.test(c1)) {
      out.stats[c1] = { kgs: Number(row.getCell(2).value) || 0,
                        bags: Number(row.getCell(3).value) || 0,
                        lots: Number(row.getCell(4).value) || 0 };
      return;
    }
    if (/TOTAL|SALES$/.test(c2)) {
      const key = /^GRAND TOTAL$/.test(c2) ? c2 : `${state} :: ${c2}`;
      out.totals[key] = { bag: Number(row.getCell(4).value) || 0,
                          qty: Number(row.getCell(5).value) || 0,
                          amount: Number(row.getCell(6).value) || 0 };
      return;
    }
    // A full-width state strip — merged across A:H, so every cell reads back
    // as the state name, and column 5 holds no quantity.
    if (seenHeader && c1 && c1 === c2 && typeof q5 !== 'number') {
      state = c1; out.states.push(c1); return;
    }
    // A data row always carries a numeric QUANTITY in column 5.
    if (typeof q5 === 'number' && c1) {
      out.rows.push({ state, col1: c1, bidder: c2, trade_name: txt(row.getCell(3)),
                      bag: Number(row.getCell(4).value) || 0,
                      qty: Number(q5) || 0,
                      amount: Number(row.getCell(6).value) || 0,
                      inv_amount: Number(row.getCell(7).value) || 0,
                      code: txt(row.getCell(8)) });
    }
  });
  return out;
}

(async () => {
  const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
  await initDb();
  const db = getDb();
  // initDb builds the trade tables; the settings table is owned by
  // company-config and is normally created during server boot.
  require(path.join(ROOT, 'company-config.js')).initCompanySettings(db);
  const setKey = (k, v) => db.run(
    `INSERT INTO company_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [k, v]);
  setKey('flag_proforma_invoice', 'false');

  const ar = require(path.join(ROOT, 'auction-reports.js'));
  const { exportCollection } = require(path.join(ROOT, 'exports.js'));
  const invoiceWise = () => ar.tradeReportXlsx(db, aid, { invoiceWise: true });
  const buyerWise   = () => ar.tradeReportXlsx(db, aid, {});

  // ── A trade in KERALA with two buyers: one at home, one across the border.
  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('77','2026-09-01','KERALA')`);
  const aid = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;
  db.run(`INSERT INTO buyers (buyer, buyer1, code, state) VALUES ('HOME','HOME SPICES','HS','KERALA')`);
  db.run(`INSERT INTO buyers (buyer, buyer1, code, state) VALUES ('AWAY','AWAY TRADERS','AT','TAMIL NADU')`);

  // Four lots, 100 kg each. HOME buys two, AWAY buys two.
  const mkLot = (no, code, buyer, buyer1, sale, qty, amt, bags, invo) =>
    db.run(`INSERT INTO lots (auction_id, lot_no, name, bags, qty, amount, price, code, buyer, buyer1, sale, invo)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
           [aid, no, 'PLANTER ' + no, bags, qty, amt, amt / qty, code, buyer, buyer1, sale, invo || '']);
  mkLot('1', 'HS', 'HOME', 'HOME SPICES',  'L', 100, 300000, 3, '10');
  mkLot('2', 'HS', 'HOME', 'HOME SPICES',  'L', 100, 300000, 3, '11');
  mkLot('3', 'AT', 'AWAY', 'AWAY TRADERS', 'I', 100, 400000, 4, '20');
  mkLot('4', 'AT', 'AWAY', 'AWAY TRADERS', 'I', 100, 400000, 4, '');   // not billed yet

  const mkInv = (sale, invo, buyer, buyer1, bag, qty, amount, tot) =>
    db.run(`INSERT INTO invoices (auction_id, ano, date, sale, invo, buyer, buyer1, bag, qty, amount, tot, is_proforma, raised_invo)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'')`,
           [aid, '77', '2026-09-01', sale, invo, buyer, buyer1, bag, qty, amount, tot]);
  mkInv('L', '10', 'HOME', 'HOME SPICES',  3, 100, 300000, 315000);
  mkInv('L', '11', 'HOME', 'HOME SPICES',  3, 100, 300000, 315000);
  mkInv('I', '20', 'AWAY', 'AWAY TRADERS', 4, 100, 400000, 421000);

  console.log('[columns] the SALE column becomes INVO, and the figures are the invoice\'s own');
  let s = await sheet(await invoiceWise());
  check('sheet is named apart from the buyer-wise one', s.name === 'AuctionReportInvoice', s.name);
  check('first column is INVO, the rest unchanged',
        s.headers.join('|') === 'INVO|BIDDER|TRADE NAME|BAG|QUANTITY|AMOUNT|INV.AMOUNT|CODE',
        s.headers.join('|'));
  check('one row per invoice, not per buyer', s.rows.length === 3, JSON.stringify(s.rows));
  // Inter-state leads the report (see sortReportStates), so AWAY's I-20 prints
  // above the two home-state L invoices.
  check('the INVO cell carries the sale letter with the number',
        s.rows.map(r => r.col1).join(',') === 'I 20,L 10,L 11', s.rows.map(r => r.col1).join(','));
  const away = s.rows.find(r => r.bidder === 'AWAY');
  check('AMOUNT is the invoice\'s own pre-tax figure', near(away.amount, 400000), JSON.stringify(away));
  check('INV.AMOUNT is the invoice total, not a recomputed estimate',
        near(away.inv_amount, 421000), JSON.stringify(away));
  check('CODE resolves off the buyers master', away.code === 'AT', JSON.stringify(away));

  console.log('\n[agrees] row for row with the Collection register');
  const coll = await (async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await exportCollection(db, aid)));
    const ws = wb.worksheets[0];
    const rows = [];
    ws.eachRow((row) => {
      const c1 = String(row.getCell(1).value == null ? '' : row.getCell(1).value);
      const c3 = String(row.getCell(3).value == null ? '' : row.getCell(3).value);
      const q = row.getCell(4).value;
      if (typeof q === 'number' && c1 && !/TOTAL/.test(c3) && !/^NOT IN/.test(c1)) {
        rows.push({ invo: c1, qty: Number(q) || 0, value: Number(row.getCell(5).value) || 0 });
      }
    });
    return rows;
  })();
  check('same number of documents', coll.length === s.rows.length, `${coll.length} vs ${s.rows.length}`);
  // Not the same ORDER: Collection runs in printed-invoice-number order, while
  // this report groups by state first. The same documents, either way.
  const sortJoin = xs => xs.slice().sort().join(',');
  check('the same set of invoice numbers',
        sortJoin(coll.map(r => r.invo)) === sortJoin(s.rows.map(r => r.col1)),
        `${sortJoin(coll.map(r => r.invo))} vs ${sortJoin(s.rows.map(r => r.col1))}`);
  check('same kilos', near(coll.reduce((t, r) => t + r.qty, 0), s.rows.reduce((t, r) => t + r.qty, 0)));
  check('same money — Collection\'s VALUE is this report\'s INV.AMOUNT',
        near(coll.reduce((t, r) => t + r.value, 0), s.rows.reduce((t, r) => t + r.inv_amount, 0)));

  console.log('\n[grouping] states, then INTER / INTRA off the invoice\'s own sale letter');
  // INTER-STATE first, the trade's own state (its local sales) last — the
  // order the customer reads the report in, and the order the sale letters
  // themselves fall in (I before L).
  check('an inter-state state leads', s.states[0] === 'TAMIL NADU', JSON.stringify(s.states));
  check('…and the trade\'s own state closes the report',
        s.states[s.states.length - 1] === 'KERALA', JSON.stringify(s.states));
  check('the two local invoices subtotal together',
        near(s.totals['KERALA :: INTRA STATE SALES'].qty, 200), JSON.stringify(s.totals));
  check('the inter-state invoice subtotals apart',
        near(s.totals['TAMIL NADU :: INTER-STATE SALES'].qty, 100), JSON.stringify(s.totals));
  check('GRAND TOTAL is what was invoiced — 300 kg, not the 400 sold',
        near(s.totals['GRAND TOTAL'].qty, 300), JSON.stringify(s.totals['GRAND TOTAL']));
  check('…and its AMOUNT is the invoiced 1,000,000',
        near(s.totals['GRAND TOTAL'].amount, 1000000), JSON.stringify(s.totals['GRAND TOTAL']));

  // A buyer billed under the OTHER sale letter — the operator's call, and the
  // document is the record of it. Grouping on the buyer's state would file
  // this under INTER; grouping on the invoice files it where it was billed.
  console.log('\n[grouping] a cross-letter billing follows the DOCUMENT, not the buyer\'s state');
  mkLot('5', 'AT', 'AWAY', 'AWAY TRADERS', 'L', 50, 150000, 2, '12');
  mkInv('L', '12', 'AWAY', 'AWAY TRADERS', 2, 50, 150000, 157500);
  s = await sheet(await invoiceWise());
  check('it subtotals as INTRA — the letter it was billed under',
        near(s.totals['TAMIL NADU :: INTRA STATE SALES'].qty, 50), JSON.stringify(s.totals));
  check('…not as INTER, where the buyer\'s state alone would have put it',
        near(s.totals['TAMIL NADU :: INTER-STATE SALES'].qty, 100), JSON.stringify(s.totals));
  check('…while still printing under its buyer\'s state (TAMIL NADU)',
        !!s.totals['TAMIL NADU :: TAMIL NADU STATE TOTAL'] &&
          near(s.totals['TAMIL NADU :: TAMIL NADU STATE TOTAL'].qty, 150), JSON.stringify(s.totals));
  check('and the home state is untouched at 200 kg',
        near(s.totals['KERALA :: KERALA STATE TOTAL'].qty, 200), JSON.stringify(s.totals));

  console.log('\n[footer] the stats block counts LOTS, so invoices never move it');
  check('SOLD is all 450 kg on the lots, not the 350 invoiced',
        near(s.stats.SOLD.kgs, 450), JSON.stringify(s.stats));
  check('TOTAL ARRIVALS counts every lot', s.stats['TOTAL ARRIVALS'].lots === 5,
        JSON.stringify(s.stats));
  check('the shortfall between the two is stated, not left to be guessed',
        /^NOT IN THIS REGISTER/.test(s.note) && /100\.000 kg/.test(s.note), s.note || '(no note)');

  console.log('\n[footer] a fully-billed trade says nothing extra');
  mkInv('I', '21', 'AWAY', 'AWAY TRADERS', 4, 100, 400000, 421000);
  db.run(`UPDATE lots SET invo = '21' WHERE auction_id = ? AND lot_no = '4'`, [aid]);
  s = await sheet(await invoiceWise());
  check('the register now covers the trade', near(s.totals['GRAND TOTAL'].qty, 450),
        JSON.stringify(s.totals['GRAND TOTAL']));
  check('…so the note is gone', !s.note, s.note);
  check('and GRAND TOTAL now meets SOLD', near(s.totals['GRAND TOTAL'].qty, s.stats.SOLD.kgs),
        `${s.totals['GRAND TOTAL'].qty} vs ${s.stats.SOLD.kgs}`);

  console.log('\n[proforma] drafts are listed while nothing has been raised from them');
  setKey('flag_proforma_invoice', 'true');
  setKey('proforma_invoice_prefix', 'PI');
  db.run(`INSERT INTO buyers (buyer, buyer1, code, state) VALUES ('DRAFT','DRAFT SPICES','DS','KERALA')`);
  mkLot('6', 'DS', 'DRAFT', 'DRAFT SPICES', 'L', 80, 240000, 2, '');
  db.run(`UPDATE lots SET proforma_invo = '5' WHERE auction_id = ? AND lot_no = '6'`, [aid]);
  db.run(`INSERT INTO invoices (auction_id, ano, date, sale, invo, buyer, buyer1, bag, qty, amount, tot, is_proforma, raised_invo)
          VALUES (?,'77','2026-09-01','L','5','DRAFT','DRAFT SPICES',2,80,240000,252000,1,'')`, [aid]);
  s = await sheet(await invoiceWise());
  const draft = s.rows.find(r => r.bidder === 'DRAFT');
  check('the pending draft is listed', !!draft, JSON.stringify(s.rows.map(r => r.col1)));
  check('…under its prefixed proforma number, the one the buyer holds',
        draft && draft.col1 === 'PI/L-5', draft && draft.col1);

  console.log('\n[untouched] the buyer-wise report is exactly as it was');
  const b = await sheet(await buyerWise());
  check('sheet keeps its own name', b.name === 'AuctionReport', b.name);
  check('first column is still SALE',
        b.headers.join('|') === 'SALE|BIDDER|TRADE NAME|BAG|QUANTITY|AMOUNT|INV.AMOUNT|CODE',
        b.headers.join('|'));
  check('one row per buyer code + sale, not per invoice',
        b.rows.every(r => r.col1 === 'L' || r.col1 === 'I'), JSON.stringify(b.rows.map(r => r.col1)));
  check('it totals every lot sold — 530 kg, invoiced or not',
        near(b.totals['GRAND TOTAL'].qty, 530), JSON.stringify(b.totals['GRAND TOTAL']));
  check('and it never carries the shortfall note', !b.note, b.note);
  // Both variants of the same report run in the same order — one comparator
  // feeds both (sortReportStates), and this is what stops them drifting.
  check('it runs inter-state first and the home state last, like the invoice-wise twin',
        b.states[0] === 'TAMIL NADU' && b.states[b.states.length - 1] === 'KERALA',
        JSON.stringify(b.states));
  check('…with every row still under the state section it belongs to',
        near(b.totals['KERALA :: INTRA STATE SALES'].qty, 280) &&
        near(b.totals['TAMIL NADU :: INTER-STATE SALES'].qty, 250),
        JSON.stringify(b.totals));

  console.log('\n[pdf] both variants render');
  const pdfInv = await ar.tradeReportPdf(db, aid, { invoiceWise: true });
  const pdfBuy = await ar.tradeReportPdf(db, aid, {});
  check('invoice-wise PDF is a PDF', pdfInv.slice(0, 4).toString() === '%PDF' && pdfInv.length > 2000,
        `${pdfInv.length} bytes`);
  check('buyer-wise PDF still renders', pdfBuy.slice(0, 4).toString() === '%PDF' && pdfBuy.length > 2000,
        `${pdfBuy.length} bytes`);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
