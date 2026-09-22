// DUMMY SELLER DETAILS — a stand-in identity that reaches the Spices Board
// and stops there.
//
// A lot can carry dummy_name / dummy_tel / dummy_cr / dummy_grade, set in
// bulk from the Lots tab. Those four values print INSTEAD of the lot's real
// name, phone, CR/GSTIN and grade on exactly two surfaces — the e-Auction
// (Spices Board) portal CSV and Form C. The whole feature's value rests on
// that boundary holding in both directions, so this file tests both:
//
//   [csv]        the four dummy values land in the CSV's D / E / K / P columns
//   [classify]   a dummy CR also decides the Planter/Dealer code, so column C
//                and column E can never contradict each other
//   [no-leak]    a masked DEALER's real board licence does not come back out
//                through the SBL fallback
//   [form-c]     Form C prints the dummy name and the dummy registration,
//                and files the row under the section the dummy CR implies
//   [partial]    one dummy field set leaves the other three reading real
//   [contained]  a report that is NOT one of the two shows the real seller
//   [control]    with no dummy set, every one of the above reads real
const os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lot-dummy-'));
process.env.SPICE_DATA_DIR = TMP;   // db.js reads this — never the real data dir

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// Split one CSV line into cells, honouring the quoting csvEscape() applies.
function cells(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
// Column letters → index, so the assertions below read like the spec does.
const COL = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10,
              L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19 };

(async () => {
  const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
  await initDb();
  const db = getDb();
  require(path.join(ROOT, 'company-config.js')).initCompanySettings(db);
  const sb = require(path.join(ROOT, 'spice-board-reports.js'));
  // The reports honour the install flag, not just the Lots-tab button —
  // see the [flag-off] block at the end for why that matters.
  const setFlag = v => db.run(`UPDATE company_settings SET value = ? WHERE key = 'flag_lot_dummy_details'`, [v]);
  setFlag('true');

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('77','2026-09-15','KERALA')`);
  const aid = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;
  db.run(`INSERT INTO buyers (buyer, buyer1, code, sbl, state) VALUES ('BUY','BUYER ONE','BUY','CS/B/1/202425','KERALA')`);

  const REAL_SBL = 'ML/REG/16071/2021';
  const GSTIN    = 'GSTIN.32AAMCM4500C1Z2';

  // Four lots, one per scenario. Every lot is priced and sold so it passes
  // Form C's amount gate as well as the CSV's (which has none).
  //   1 — planter, fully masked (all four dummy fields)
  //   2 — dealer (GSTIN + SBL), masked with a planter-style CR
  //   3 — planter, dummy NAME only (the partial case)
  //   4 — planter, no dummy at all (the control)
  const LOTS = [
    { lot: '001', name: 'REAL PLANTER ONE',  cr: 'CR.1111', sbl: '',       tel: '9000000001', grade: '1',
      d: { dummy_name: 'DUMMY PLANTER', dummy_tel: '9111111111', dummy_cr: 'CR.9999', dummy_grade: '2A' } },
    { lot: '002', name: 'REAL DEALER TWO',   cr: GSTIN,     sbl: REAL_SBL, tel: '9000000002', grade: '1',
      d: { dummy_name: 'DUMMY DEALER', dummy_tel: '9222222222', dummy_cr: 'CR.8888', dummy_grade: '1A' } },
    { lot: '003', name: 'REAL PLANTER THREE', cr: 'CR.3333', sbl: '',      tel: '9000000003', grade: '2',
      d: { dummy_name: 'DUMMY NAME ONLY', dummy_tel: '', dummy_cr: '', dummy_grade: '' } },
    { lot: '004', name: 'REAL PLANTER FOUR', cr: 'CR.4444', sbl: '',       tel: '9000000004', grade: '1',
      d: { dummy_name: '', dummy_tel: '', dummy_cr: '', dummy_grade: '' } },
  ];
  for (const L of LOTS) {
    db.run(`INSERT INTO traders (name, cr, aadhar, tel, ppla, pstate) VALUES (?,?,?,?,?,?)`,
           [L.name, L.cr, L.sbl, L.tel, 'NIRAPPELKADA', 'KERALA']);
    const tid = db.get('SELECT id FROM traders ORDER BY id DESC LIMIT 1').id;
    const qty = 100, price = 2000;
    db.run(`INSERT INTO lots (auction_id, trader_id, lot_no, name, cr, aadhar, tel, ppla, pstate,
                              grade, bags, qty, price, amount, refund, com, code, buyer, buyer1, sale,
                              dummy_name, dummy_tel, dummy_cr, dummy_grade)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
           [aid, tid, L.lot, L.name, L.cr, L.sbl, L.tel, 'NIRAPPELKADA', 'KERALA',
            L.grade, 5, qty, price, qty * price, 100, qty * price * 0.01, 'BUY', 'BUY', 'BUYER ONE', 'L',
            L.d.dummy_name, L.d.dummy_tel, L.d.dummy_cr, L.d.dummy_grade]);
  }

  // ── e-Auction (Spices Board) CSV ───────────────────────────────────
  console.log('[csv] the dummy values reach the portal file');
  const csv = (await sb.REPORTS.eauction_csv.csv(db, { auctionId: aid })).toString('utf8');
  const rows = csv.trim().split(/\r?\n/).slice(1).map(cells);
  const byLot = new Map(rows.map(r => [r[COL.A], r]));
  check('one CSV row per lot', rows.length === 4, `${rows.length} rows`);

  const r1 = byLot.get('001');
  check('column D prints the dummy name',   r1[COL.D] === 'DUMMY PLANTER', r1[COL.D]);
  check('column E prints the dummy CR',     r1[COL.E] === 'CR.9999',       r1[COL.E]);
  check('column K prints the dummy grade',  r1[COL.K] === '2A',            r1[COL.K]);
  check('column P prints the dummy phone',  r1[COL.P] === '9111111111',    r1[COL.P]);
  check('…and the real name is nowhere on that row', !r1.join('|').includes('REAL PLANTER ONE'), r1.join('|'));
  check('…nor the real phone',              !r1.join('|').includes('9000000001'), r1.join('|'));

  console.log('[classify] the Planter/Dealer code follows the CR that actually prints');
  const r2 = byLot.get('002');
  check('the real dealer would have coded 2', require(path.join(ROOT, 'calculations.js')).isDealerSeller(GSTIN, REAL_SBL) === true);
  check('but the masked row codes 1, matching its dummy CR', r2[COL.C] === '1', `column C = ${r2[COL.C]}`);
  check('column C and column E agree', r2[COL.C] === '1' && r2[COL.E] === 'CR.8888', `${r2[COL.C]} / ${r2[COL.E]}`);

  console.log('[no-leak] a masked dealer does not leak its real board licence');
  check("the dealer's real SBL is absent from its row", !r2.join('|').includes(REAL_SBL), r2.join('|'));
  check('…and so is its GSTIN',                          !r2.join('|').includes(GSTIN),   r2.join('|'));
  check('…and its real name',                            !r2.join('|').includes('REAL DEALER TWO'), r2.join('|'));

  console.log('[partial] a blank dummy field falls through to the real value');
  const r3 = byLot.get('003');
  check('the dummy name is used',     r3[COL.D] === 'DUMMY NAME ONLY', r3[COL.D]);
  check('but the real CR still is',   r3[COL.E] === 'CR.3333',         r3[COL.E]);
  check('and the real grade',         r3[COL.K] === '2',               r3[COL.K]);
  check('and the real phone',         r3[COL.P] === '9000000003',      r3[COL.P]);

  console.log('[control] a lot with no dummy is untouched');
  const r4 = byLot.get('004');
  check('real name',  r4[COL.D] === 'REAL PLANTER FOUR', r4[COL.D]);
  check('real CR',    r4[COL.E] === 'CR.4444',           r4[COL.E]);
  check('real grade', r4[COL.K] === '1',                 r4[COL.K]);
  check('real phone', r4[COL.P] === '9000000004',        r4[COL.P]);

  // ── Form C ─────────────────────────────────────────────────────────
  console.log('[form-c] the same substitution on the statutory return');
  const fc = sb.REPORTS.form_c.json(db, { auctionId: aid });
  const planters = fc.sections.find(s => s.title === 'PLANTERS').rows;
  const dealers  = fc.sections.find(s => s.title === 'DEALERS').rows;
  const fcByLot  = new Map([...planters, ...dealers].map(r => [r.lot, r]));

  const f1 = fcByLot.get('001');
  check('the seller column prints the dummy name', f1.seller === 'DUMMY PLANTER', f1.seller);
  check('the registration column prints the dummy CR', f1.regId === 'CR.9999', f1.regId);

  const f2 = fcByLot.get('002');
  check('a masked dealer prints its dummy name', f2.seller === 'DUMMY DEALER', f2.seller);
  check('…and its dummy CR, not the real SBL',   f2.regId === 'CR.8888', f2.regId);
  check('…and files under PLANTERS, as its dummy CR implies',
        planters.some(r => r.lot === '002'), `dealers: ${dealers.map(r => r.lot).join(',')}`);

  const f3 = fcByLot.get('003');
  check('a name-only mask keeps the real registration', f3.seller === 'DUMMY NAME ONLY' && f3.regId === 'CR.3333',
        `${f3.seller} / ${f3.regId}`);
  const f4 = fcByLot.get('004');
  check('an unmasked lot prints its real seller', f4.seller === 'REAL PLANTER FOUR' && f4.regId === 'CR.4444',
        `${f4.seller} / ${f4.regId}`);

  // Totals are quantity/money only — masking an identity must not move one.
  check('the grand total still covers all four lots', Math.round(fc.grand.qtySold) === 400, String(fc.grand.qtySold));
  check('…and their full value',                      Math.round(fc.grand.value) === 800000, String(fc.grand.value));

  // ── Containment ────────────────────────────────────────────────────
  console.log('[contained] every OTHER report still shows the real seller');
  // Buyers Statement and Form D are the two siblings built from the same
  // context rows, so they are where a leak would show up first. Litre Weight
  // carries a trade name per lot and is built from the same rows again.
  const bs = sb.REPORTS.buyers_statement.json(db, { auctionId: aid });
  const fd = sb.REPORTS.form_d.json(db, { auctionId: aid });
  const blob = JSON.stringify(bs) + JSON.stringify(fd);
  check('no dummy name appears in Buyers Statement / Form D',
        !blob.includes('DUMMY PLANTER') && !blob.includes('DUMMY DEALER') && !blob.includes('DUMMY NAME ONLY'),
        blob.slice(0, 200));

  // The lots table itself — the source every invoice, bill and payment reads.
  const lotRow = db.get(`SELECT name, tel, cr, grade FROM lots WHERE auction_id = ? AND lot_no = '001'`, [aid]);
  check('the lot row still holds the real seller identity',
        lotRow.name === 'REAL PLANTER ONE' && lotRow.tel === '9000000001'
        && lotRow.cr === 'CR.1111' && lotRow.grade === '1',
        JSON.stringify(lotRow));

  // ── The flag ───────────────────────────────────────────────────────
  console.log('[flag-off] switching the feature off stops the dummies printing');
  // Not a UI nicety: with the button gone there would be no way to see a
  // masked lot or clear it, so leaving the substitution live would keep
  // sending stand-in identities to the regulator invisibly.
  setFlag('false');
  const csvOff  = (await sb.REPORTS.eauction_csv.csv(db, { auctionId: aid })).toString('utf8');
  const offRow  = csvOff.trim().split(/\r?\n/).slice(1).map(cells).find(r => r[COL.A] === '001');
  check('the CSV is back to the real name',  offRow[COL.D] === 'REAL PLANTER ONE', offRow[COL.D]);
  check('…the real CR',                      offRow[COL.E] === 'CR.1111',          offRow[COL.E]);
  check('…the real grade',                   offRow[COL.K] === '1',                offRow[COL.K]);
  check('…and the real phone',               offRow[COL.P] === '9000000001',       offRow[COL.P]);
  const fcOff = sb.REPORTS.form_c.json(db, { auctionId: aid });
  const fcOffRow = [].concat(...fcOff.sections.map(s => s.rows)).find(r => r.lot === '001');
  check('Form C too',                        fcOffRow.seller === 'REAL PLANTER ONE', fcOffRow.seller);
  // The masked dealer goes back to DEALERS, since its real CR is a GSTIN again.
  check('…and the masked dealer files under DEALERS again',
        fcOff.sections.find(s => s.title === 'DEALERS').rows.some(r => r.lot === '002'));
  // Stored values survive the round trip — flipping the flag back restores them.
  setFlag('true');
  const backOn = (await sb.REPORTS.eauction_csv.csv(db, { auctionId: aid })).toString('utf8')
    .trim().split(/\r?\n/).slice(1).map(cells).find(r => r[COL.A] === '001');
  check('switching it back on restores the dummy, nothing was lost',
        backOn[COL.D] === 'DUMMY PLANTER', backOn[COL.D]);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
