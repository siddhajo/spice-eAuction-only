// Individual registers — picking ONE party out of two who share a name must
// show only that party's rows. All three filtered on the name alone, so
// selecting either "SIVAKUMAR R" listed both people's lots (and both totals)
// under the one heading. This pins that the committed identity reaches the
// register, its Excel and its PDF:
//   • pooler   → lots.trader_id
//   • seller   → purchases.trader_id
//   • merchant → trade name + GSTIN (invoices carry no buyer FK)
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Isolated DB — db.js reads SPICE_DATA_DIR, so set it BEFORE requiring db.
const os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poolreg-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb } = require(path.join(ROOT, 'db'));
const { getPoolerRegister, getSellerRegister, getMerchantRegister, listRegisterParties } =
  require(path.join(ROOT, 'calculations'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

const NAME = 'SIVAKUMAR R';
const rowCount = (reg) => (reg.parties || []).reduce((s, p) => s + p.rows.length, 0);

(async () => {
  await initDb();
  const db = getDb();
  db.run('INSERT INTO auctions (ano, date, crop_type, state) VALUES (?,?,?,?)',
         ['21', '2026-08-12', 'VST', 'TAMIL NADU']);
  const AID = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;

  // Two masters, one name, different phones — the real-world shape.
  const mkTrader = (tel) => {
    db.run('INSERT INTO traders (name, cr, tel) VALUES (?,?,?)', [NAME, 'CR.', tel]);
    return db.get('SELECT id FROM traders ORDER BY id DESC LIMIT 1').id;
  };
  const A = mkTrader('9894825232');   // three lots
  const B = mkTrader('9551940760');   // one lot

  //        lot   tid  qty  price  amount  balance
  const SEED = [
    ['101', A, 100, 1500, 150000, 148000],
    ['102', A,  50, 1600,  80000,  79000],
    ['103', A,  40, 1400,  56000,  55000],
    ['104', B,  30, 1700,  51000,  50000],
    // A lot never linked to a master: it must not ride along with either of
    // them, and it is its own pick in the register.
    ['105', null, 20, 1200, 24000, 23000],
  ];
  for (const [lot_no, tid, qty, price, amount, balance] of SEED) {
    db.run(`INSERT INTO lots (auction_id, lot_no, trader_id, name, cr, tel, qty, price, amount, balance, grade, state)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [AID, lot_no, tid, NAME, 'CR.', tid === B ? '9551940760' : '9894825232',
       qty, price, amount, balance, '1', 'TAMIL NADU']);
  }

  // The picker offers one entry per identity, each carrying its id.
  const picks = listRegisterParties(db, { kind: 'pooler' }).filter(p => p.name === NAME);
  check('picker offers one entry per pooler identity', picks.length === 3, `got ${picks.length}`);
  check('picker entries carry the trader id',
        picks.filter(p => p.trader_id != null).map(p => p.trader_id).sort((x, y) => x - y).join(',') === [A, B].join(','),
        JSON.stringify(picks));

  // The bug: name only → both people's lots.
  const both = getPoolerRegister(db, { party: NAME });
  check('name alone still spans every namesake (5 lots)', rowCount(both) === 5, String(rowCount(both)));

  // The fix: the committed id narrows to one person.
  const regA = getPoolerRegister(db, { party: NAME, traderId: String(A) });
  check('picking the first pooler shows only their 3 lots',
        regA.parties.length === 1 && rowCount(regA) === 3,
        `${regA.parties.length} parties / ${rowCount(regA)} rows`);
  check("the first pooler's total is their own, not the pair's",
        Math.round(regA.parties[0].summary.billamount) === 282000,
        regA.parties[0] && String(regA.parties[0].summary.billamount));

  const regB = getPoolerRegister(db, { party: NAME, traderId: String(B) });
  check('picking the second pooler shows only their 1 lot',
        regB.parties.length === 1 && rowCount(regB) === 1,
        `${regB.parties.length} parties / ${rowCount(regB)} rows`);
  check("the second pooler's phone is their own",
        regB.parties[0] && regB.parties[0].phone === '9551940760',
        regB.parties[0] && regB.parties[0].phone);

  // '' is a real pick (the entry with no master), NOT "no id supplied".
  const regNone = getPoolerRegister(db, { party: NAME, traderId: '' });
  check('an id-less pick shows only the unlinked lot', rowCount(regNone) === 1, String(rowCount(regNone)));

  // "All parties" must stay unfiltered — no party, no id.
  const all = getPoolerRegister(db, {});
  check('"All parties" is unaffected', rowCount(all) === 5, String(rowCount(all)));

  // Excel and PDF read the same options, so they narrow with the screen.
  const { exportIndividualRegister } = require(path.join(ROOT, 'exports'));
  const { exportPdf } = require(path.join(ROOT, 'exports-pdf'));
  const optsB = { party: NAME, traderId: String(B) };
  const xlsx = await exportIndividualRegister(db, 'pooler', optsB);
  check('Excel export renders for a single pooler', xlsx && xlsx.length > 1000, xlsx && String(xlsx.length));
  const pdfBoth = await exportPdf(db, 'pooler_individual', null, {}, { party: NAME });
  const pdfOne  = await exportPdf(db, 'pooler_individual', null, {}, optsB);
  check('PDF export honours the id (one pooler prints smaller than two)',
        pdfOne.length < pdfBoth.length, `${pdfOne.length} vs ${pdfBoth.length}`);

  // ── Seller Register — same namesake rule, keyed on purchases.trader_id ──
  //        ano  date          qty  amount  trader
  const PUR = [
    ['21', '2026-08-12', 100, 150000, A],
    ['21', '2026-08-12',  50,  80000, A],
    ['21', '2026-08-12',  30,  51000, B],
  ];
  for (const [ano, date, qty, amount, tid] of PUR) {
    db.run(`INSERT INTO purchases (ano, date, trader_id, name, gstin, qty, amount, total)
            VALUES (?,?,?,?,?,?,?,?)`,
      [ano, date, tid, NAME, '', qty, amount, amount]);
  }
  const sPicks = listRegisterParties(db, { kind: 'seller' }).filter(p => p.name === NAME);
  check('seller picker offers both dealers with their ids',
        sPicks.length === 2 && sPicks.every(p => p.trader_id != null), JSON.stringify(sPicks));
  const sBoth = getSellerRegister(db, { party: NAME });
  check('seller "all namesakes" now splits into two headings',
        sBoth.parties.length === 2, String(sBoth.parties.length));
  const sA = getSellerRegister(db, { party: NAME, traderId: String(A) });
  check("picking a seller shows only that dealer's total",
        sA.parties.length === 1 && Math.round(sA.parties[0].summary.invoice) === 230000,
        JSON.stringify(sA.parties.map(p => p.summary)));
  const sB = getSellerRegister(db, { party: NAME, traderId: String(B) });
  check('the other seller gets their own total',
        sB.parties.length === 1 && Math.round(sB.parties[0].summary.invoice) === 51000,
        JSON.stringify(sB.parties.map(p => p.summary)));

  // ── Merchant Register — invoices carry no buyer FK, so identity is the
  //    trade name + GSTIN.
  const MNAME = 'ANNAI TRADERS';
  const G1 = '33AAAAA1111A1Z5', G2 = '32BBBBB2222B1Z9';
  //        invo  gstin  qty  tot
  const INV = [
    ['1', G1, 100, 150000],
    ['2', G1,  50,  80000],
    ['3', G2,  30,  51000],
  ];
  for (const [invo, gstin, qty, tot] of INV) {
    db.run(`INSERT INTO invoices (auction_id, ano, date, invo, buyer, buyer1, gstin, qty, tot)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      [AID, '21', '2026-08-12', invo, MNAME, MNAME, gstin, qty, tot]);
  }
  const mPicks = listRegisterParties(db, { kind: 'merchant' }).filter(p => p.name === MNAME);
  check('merchant picker offers one entry per GSTIN',
        mPicks.length === 2 && mPicks.every(p => p.gstin), JSON.stringify(mPicks));
  const mBoth = getMerchantRegister(db, { party: MNAME });
  check('merchant "all namesakes" splits by GSTIN instead of merging',
        mBoth.parties.length === 2, String(mBoth.parties.length));
  const m1 = getMerchantRegister(db, { party: MNAME, gstin: G1 });
  check('picking a merchant shows only their invoices',
        m1.parties.length === 1 && rowCount(m1) === 2
          && Math.round(m1.parties[0].summary.invoice) === 230000,
        JSON.stringify(m1.parties.map(p => p.summary)));
  const m2 = getMerchantRegister(db, { party: MNAME, gstin: G2 });
  check('the other merchant gets their own single invoice',
        m2.parties.length === 1 && rowCount(m2) === 1
          && Math.round(m2.parties[0].summary.invoice) === 51000,
        JSON.stringify(m2.parties.map(p => p.summary)));
  check('merchant GSTIN match is case/space tolerant',
        rowCount(getMerchantRegister(db, { party: MNAME, gstin: '  ' + G1.toLowerCase() + ' ' })) === 2);
  const mAll = getMerchantRegister(db, {});
  check('merchant "All parties" is unfiltered', rowCount(mAll) === 3, String(rowCount(mAll)));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
