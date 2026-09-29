// FORM C — every lot PUT FOR AUCTION, not just the ones that sold.
//
// Form C is the statutory lot listing (Cardamom Marketing Rules 5(2)) filed
// beside Form D, whose own arrivals block reconciles
//     put = sold + not auctioned + withdrawn
// Form C used to list sold + withdrawn only, so every NOT-AUCTIONED lot (code
// 'NA', or blank — booked but never under the hammer) was missing and its "Qty
// put for auction" total came out short of the arrivals figure on the form
// filed with it. Now all three states are listed, the two no-sale ones with Qty
// put and zeros across the sale columns.
//
//   [rows]       a not-auctioned lot and a blank-code lot both appear
//   [zeros]      …with Qty sold / Rate / Value / Sample / Commission = 0 and
//                no bidder — the treatment withdrawn lots already got
//   [sold]       a sold lot is untouched by the widening
//   [classify]   an unsold lot still files under its seller's own section
//   [reserved]   a reserved (held) lot number stays out — it is not stock
//   [totals]     Qty put covers all five, Qty sold still only the two sales
//   [reconcile]  …so Qty put now equals Form D's "Total quantity put for
//                auction", the number sitting on the page beside it
//   [rates]      the zero rows don't drag the min / average rate down
//   [render]     the Excel and PDF builders survive them
const os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'form-c-na-'));
process.env.SPICE_DATA_DIR = TMP;   // db.js reads this — never the real data dir

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };
const r2 = n => Math.round(Number(n) * 100) / 100;

(async () => {
  const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
  await initDb();
  const db = getDb();
  require(path.join(ROOT, 'company-config.js')).initCompanySettings(db);
  const sb = require(path.join(ROOT, 'spice-board-reports.js'));

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('84','2026-09-20','KERALA')`);
  const aid = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;
  db.run(`INSERT INTO buyers (buyer, buyer1, code, sbl, state) VALUES ('BUY','BUYER ONE','BUY','CS/B/1/202425','KERALA')`);

  const GSTIN = 'GSTIN.32AAMCM4500C1Z2';
  // One lot per state. Two sellers per class so the section split is provable
  // on the unsold rows as well as the sold ones.
  //   001 planter, SOLD          006 planter, RESERVED (held lot number)
  //   002 dealer,  SOLD          003 planter, WITHDRAWN
  //   004 planter, NOT AUCTIONED ('NA')
  //   005 dealer,  NOT AUCTIONED (blank code — never priced)
  const LOTS = [
    { lot: '001', name: 'PLANTER SOLD',   cr: 'CR.1111', qty: 100, price: 2000, code: 'BUY', reserved: 0 },
    { lot: '002', name: 'DEALER SOLD',    cr: GSTIN,     qty: 100, price: 2100, code: 'BUY', reserved: 0 },
    { lot: '003', name: 'PLANTER WD',     cr: 'CR.3333', qty: 100, price: 0,    code: 'WD',  reserved: 0 },
    { lot: '004', name: 'PLANTER NA',     cr: 'CR.4444', qty: 100, price: 0,    code: 'NA',  reserved: 0 },
    { lot: '005', name: 'DEALER BLANK',   cr: GSTIN,     qty: 100, price: 0,    code: '',    reserved: 0 },
    { lot: '006', name: 'PLANTER HELD',   cr: 'CR.6666', qty: 50,  price: 0,    code: '',    reserved: 1 },
  ];
  for (const L of LOTS) {
    db.run(`INSERT INTO traders (name, cr, tel, ppla, pstate) VALUES (?,?,?,?,?)`,
           [L.name, L.cr, '9000000000', 'NIRAPPELKADA', 'KERALA']);
    const tid = db.get('SELECT id FROM traders ORDER BY id DESC LIMIT 1').id;
    const amount = L.qty * L.price;
    db.run(`INSERT INTO lots (auction_id, trader_id, lot_no, name, cr, tel, ppla, pstate, branch,
                              grade, bags, qty, price, amount, refund, com, code, buyer, buyer1, sale, reserved)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
           [aid, tid, L.lot, L.name, L.cr, '9000000000', 'NIRAPPELKADA', 'KERALA', 'VANDANMEDU',
            '1', 5, L.qty, L.price, amount, amount ? 100 : 0, amount ? amount * 0.01 : 0,
            L.code, L.code ? 'BUY' : '', L.code ? 'BUYER ONE' : '', 'L', L.reserved]);
  }

  const fc = sb.REPORTS.form_c.json(db, { auctionId: aid });
  const rows = [].concat(...fc.sections.map(s => s.rows));
  const byLot = new Map(rows.map(r => [r.lot, r]));
  const planters = fc.sections.find(s => s.title === 'PLANTERS');
  const dealers  = fc.sections.find(s => s.title === 'DEALERS');

  console.log('[rows] the not-auctioned lots are listed');
  check('the NA lot is on the form',         byLot.has('004'), [...byLot.keys()].join(','));
  check('so is the blank-code lot',          byLot.has('005'), [...byLot.keys()].join(','));
  check('five lots in all',                  rows.length === 5, `${rows.length}: ${[...byLot.keys()].join(',')}`);

  console.log('[zeros] they carry Qty put and nothing else');
  for (const lot of ['004', '005']) {
    const r = byLot.get(lot) || {};
    check(`lot ${lot} reports its Qty put`, r2(r.qtyPut) === 100, String(r.qtyPut));
    check(`lot ${lot} sold nothing`,
          r2(r.qtySold) === 0 && r2(r.rate) === 0 && r2(r.value) === 0
          && r2(r.sample) === 0 && r2(r.commission) === 0,
          JSON.stringify({ qtySold: r.qtySold, rate: r.rate, value: r.value, sample: r.sample, commission: r.commission }));
    check(`lot ${lot} names no bidder`, !r.buyer && !r.sbl, `${r.buyer} / ${r.sbl}`);
  }
  // The same treatment withdrawn lots already had — the two states now differ
  // only in which Form D row they land in (returned to planter vs balance).
  const wd = byLot.get('003') || {};
  check('the withdrawn lot reads the same way',
        r2(wd.qtyPut) === 100 && r2(wd.qtySold) === 0 && !wd.buyer, JSON.stringify(wd));

  console.log('[sold] a sale is untouched by the widening');
  const s1 = byLot.get('001') || {};
  check('qty sold, rate and value all print', r2(s1.qtySold) === 100 && r2(s1.rate) === 2000 && r2(s1.value) === 200000,
        JSON.stringify({ qtySold: s1.qtySold, rate: s1.rate, value: s1.value }));
  check('…and the bidder', s1.buyer === 'BUYER ONE', s1.buyer);

  console.log('[classify] an unsold lot files under its own seller class');
  check('the blank-code DEALER is under DEALERS', dealers.rows.some(r => r.lot === '005'),
        dealers.rows.map(r => r.lot).join(','));
  check('the NA PLANTER is under PLANTERS',       planters.rows.some(r => r.lot === '004'),
        planters.rows.map(r => r.lot).join(','));

  console.log('[reserved] a held lot number is not stock');
  check('the reserved lot is absent', !byLot.has('006'), [...byLot.keys()].join(','));

  console.log('[totals] Qty put covers every lot put up; Qty sold only the sales');
  check('PLANTERS put 300',  r2(planters.totals.qtyPut)  === 300, String(planters.totals.qtyPut));
  check('PLANTERS sold 100', r2(planters.totals.qtySold) === 100, String(planters.totals.qtySold));
  check('DEALERS put 200',   r2(dealers.totals.qtyPut)   === 200, String(dealers.totals.qtyPut));
  check('DEALERS sold 100',  r2(dealers.totals.qtySold)  === 100, String(dealers.totals.qtySold));
  check('grand put 500',     r2(fc.grand.qtyPut)  === 500, String(fc.grand.qtyPut));
  check('grand sold 200',    r2(fc.grand.qtySold) === 200, String(fc.grand.qtySold));
  check('grand value is the two sales only', r2(fc.grand.value) === 410000, String(fc.grand.value));

  console.log('[reconcile] Form C now agrees with the Form D beside it');
  const fd = sb.REPORTS.form_d.json(db, { auctionId: aid });
  const q = fd.summary;
  check('Qty put = Form D "Total quantity put for auction"',
        r2(fc.grand.qtyPut) === r2(q.totalForAuction),
        `${fc.grand.qtyPut} vs ${q.totalForAuction}`);
  check('…and Form D still splits it sold + not auctioned + withdrawn',
        r2(q.totalSold + q.notAuctioned + q.withdrawn) === r2(q.totalForAuction),
        JSON.stringify({ totalForAuction: q.totalForAuction, totalSold: q.totalSold,
                         notAuctioned: q.notAuctioned, withdrawn: q.withdrawn }));
  check('Form C\'s Qty sold matches Form D\'s too', r2(fc.grand.qtySold) === r2(q.totalSold),
        `${fc.grand.qtySold} vs ${q.totalSold}`);

  console.log('[rates] the zero rows stay out of the rate band');
  check('min rate is the cheaper sale, not 0', r2(fc.meta.minRate) === 2000, String(fc.meta.minRate));
  check('max rate is the dearer sale',         r2(fc.meta.maxRate) === 2100, String(fc.meta.maxRate));
  check('average is value / qty SOLD',         r2(fc.meta.avgRate) === 2050, String(fc.meta.avgRate));

  console.log('[render] the Excel and PDF builders survive the zero rows');
  const xlsx = await sb.REPORTS.form_c.xlsx(db, { auctionId: aid });
  check('XLSX renders', Buffer.isBuffer(Buffer.from(xlsx)) && Buffer.from(xlsx).slice(0, 2).toString('binary') === 'PK',
        String(Buffer.from(xlsx).length));
  const pdf = await sb.REPORTS.form_c.pdf(db, { auctionId: aid });
  check('PDF renders',  Buffer.from(pdf).slice(0, 4).toString('binary') === '%PDF', String(Buffer.from(pdf).length));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
