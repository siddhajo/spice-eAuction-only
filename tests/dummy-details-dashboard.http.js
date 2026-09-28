// DUMMY SELLER DETAILS ON THE DASHBOARD — a masked planter grades as a planter.
//
// A lot can carry a stand-in seller (lots.dummy_name / dummy_tel / dummy_cr /
// dummy_grade). The e-Auction CSV already decides its Planter/Dealer column from
// whichever CR actually prints, so a dealer's lot masked with a planter "CR."
// number goes to the Spices Board as a planter's. The dashboard exists to
// predict what the board will see, so it now grades the same way — and ONLY the
// dashboard: invoices, bills, payments and Tally keep reading the real seller.
//
//   [depot]      Current Auction card — a masked dealer's weight moves to
//                PLANTER WT and leaves the Grade-2 / 25%-cap figure
//   [insights]   the Auction Snapshot tiles agree with it, lot for lot
//   [breakdown]  the status → grade drill-down files the masked lot under
//                Grade 1 even though lots.grade still reads '2'
//   [drill]      …and clicking that Grade 1 lists the same lot, so the count
//                and the list can never disagree
//   [split]      Insights' Grade 1 vs Grade 2 table follows too
//   [gstin-mask] a dummy GSTIN is NOT a planter — it grades as the dealer it
//                presents, SBL and all
//   [flag-off]   with flag_lot_dummy_details off every figure reverts to the
//                real seller, nothing stored is lost
//   [contained]  the lot row still holds the real seller — the dummy sits
//                alongside it, never over it
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dummy-dash-'));
const PORT = 47421;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', b => { log += b.toString(); });
srv.stderr.on('data', b => { log += b.toString(); });
function done(code) {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}

const GSTIN = 'GSTIN.32AAMCM4500C1Z2';
const SBL   = 'ML/REG/16071/2021';
const near  = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', log.slice(-2000)); done(1); }
  console.log('logged in\n');

  const setFlag = v => api('PUT', '/api/company-settings', { settings: { flag_lot_dummy_details: v } });
  await setFlag('true');

  const auc = await api('POST', '/api/auctions', { ano: '91', date: '2026-09-18', state: 'KERALA' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // Five lots, 100 kg each, all in one depot. The two readings have to differ,
  // or a passing assertion would prove nothing:
  //   001 — real DEALER (GSTIN + SBL), stored grade 2, masked with a planter CR
  //   002 — real DEALER (GSTIN + SBL), stored grade 2, no mask  → the control
  //   003 — real PLANTER (CR, no SBL), stored grade 1, no mask  → the control
  //   004 — real PLANTER (CR) with an SBL on file, stored grade 1, masked with
  //         a GSTIN → the mask reads Grade 2, so it works in both directions
  //   005 — real DEALER (GSTIN + SBL), stored grade 2, masked with a planter CR
  // Masked: planter 001+003+005 = 300 kg, dealer 002+004 = 200 kg.
  // Unmasked: dealer 001+002+005 = 300 kg, planter 003+004 = 200 kg.
  const LOTS = [
    { lot_no: '001', name: 'REAL DEALER ONE',    cr: GSTIN,   aadhar: SBL, grade: '2',
      dummy: { dummy_name: 'DUMMY PLANTER ONE', dummy_cr: 'CR.8888' } },
    { lot_no: '002', name: 'REAL DEALER TWO',    cr: GSTIN,   aadhar: SBL, grade: '2', dummy: null },
    { lot_no: '003', name: 'REAL PLANTER THREE', cr: 'CR.33', aadhar: '',  grade: '1', dummy: null },
    { lot_no: '004', name: 'REAL PLANTER FOUR',  cr: 'CR.44', aadhar: SBL, grade: '1',
      dummy: { dummy_name: 'DUMMY DEALER FOUR', dummy_cr: GSTIN } },
    { lot_no: '005', name: 'REAL DEALER FIVE',   cr: GSTIN,   aadhar: SBL, grade: '2',
      dummy: { dummy_name: 'DUMMY PLANTER FIVE', dummy_cr: 'CR.7777' } },
  ];
  const idOf = {};
  for (const L of LOTS) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no: L.lot_no, name: L.name, cr: L.cr, aadhar: L.aadhar,
      grade: L.grade, qty: 100, bags: 10, branch: 'VANDANMEDU',
    });
    idOf[L.lot_no] = r.d.id || (r.d.lot && r.d.lot.id);
    if (L.dummy) {
      const w = await api('POST', '/api/lots/dummy-details/bulk', Object.assign({ ids: [idOf[L.lot_no]] }, L.dummy));
      if (w.status !== 200) { console.error('dummy write failed', w.status, w.d); done(1); }
    }
  }

  const depot    = async () => (await api('GET', `/api/auctions/${aid}/depot-summary`)).d;
  const insights = async () => (await api('GET', `/api/insights?auction_id=${aid}`)).d;

  // ── Current Auction card ───────────────────────────────────────────
  console.log('[depot] the Current Auction card grades on the CR that reaches the board');
  let d = await depot();
  check('crop weight covers all five lots', near(d.stats.cropWeight, 500), String(d.stats.cropWeight));
  check('the two masked dealers count as planters (300 kg, not 200)',
        near(d.stats.planterWeight, 300), String(d.stats.planterWeight));
  check('…and Dealer WT is the unmasked dealer + the GSTIN-masked planter (200 kg)',
        near(d.stats.dealerWeight, 200), String(d.stats.dealerWeight));
  check('…so the Grade-2 / 25%-cap figure equals Dealer WT',
        near(d.stats.grade2Qty, 200), String(d.stats.grade2Qty));
  const dep = (d.depots || []).find(x => x.depot === 'VANDANMEDU') || {};
  check('the per-depot row splits the same way', near(dep.planterWt, 300) && near(dep.traderWt, 200),
        `planter ${dep.planterWt} / trader ${dep.traderWt}`);

  // ── Auction Snapshot (insights totals) ─────────────────────────────
  console.log('[insights] the Auction Snapshot tiles agree with the card');
  let ins = await insights();
  check('planter weight matches', near(ins.totals.planter_weight, 300), String(ins.totals.planter_weight));
  check('trader weight matches',  near(ins.totals.trader_weight, 200),  String(ins.totals.trader_weight));
  check('grade-2 qty matches',    near(ins.totals.grade2_qty, 200),     String(ins.totals.grade2_qty));

  // ── Status → grade drill-down ──────────────────────────────────────
  console.log('[breakdown] the grade drill-down files the masked lot under Grade 1');
  const g1 = ins.gradeBreakdown.booked['1'] || {}, g2 = ins.gradeBreakdown.booked['2'] || {};
  check('Grade 1 holds three lots', Number(g1.lots) === 3, JSON.stringify(g1));
  check('Grade 2 holds two',        Number(g2.lots) === 2, JSON.stringify(g2));
  check('Grade 1 weight is 300 kg', near(g1.qty, 300), String(g1.qty));
  const brk = (ins.gradeBreakdownByBranch || {})['VANDANMEDU'] || { booked: {} };
  check('the branch-wise copy agrees', Number((brk.booked['1'] || {}).lots) === 3,
        JSON.stringify(brk.booked));

  console.log('[drill] clicking that Grade 1 lists the same lots');
  const drill = await api('GET', `/api/insights/lots?auction_id=${aid}&status=booked&grade=1`);
  const drillLots = (drill.d || []).map(r => r.lot_no).sort();
  check('the masked lot is in the Grade 1 list', drillLots.includes('001'), drillLots.join(','));
  check('three lots, matching the count', drillLots.length === 3, drillLots.join(','));
  const drill2 = await api('GET', `/api/insights/lots?auction_id=${aid}&status=booked&grade=2`);
  check('and Grade 2 lists the unmasked dealer + the GSTIN-masked planter',
        (drill2.d || []).map(r => r.lot_no).sort().join(',') === '002,004',
        (drill2.d || []).map(r => r.lot_no).join(','));

  console.log('[split] Insights’ Grade 1 vs Grade 2 table follows');
  check('Grade 1 · Planter has three lots', Number(ins.gradeSplit.grade1.lots) === 3,
        JSON.stringify(ins.gradeSplit.grade1));
  check('Grade 2 · Dealer has two',         Number(ins.gradeSplit.grade2.lots) === 2,
        JSON.stringify(ins.gradeSplit.grade2));

  console.log('[gstin-mask] a dummy GSTIN grades as the dealer it presents');
  // Lot 004 is a real planter masked with a GSTIN; its own SBL is on file, so
  // the GSTIN+SBL rule makes it Grade 2 — the mask is honoured in BOTH
  // directions, it is not a one-way "everything masked is a planter".
  check('the GSTIN-masked planter is in the Grade 2 list',
        (drill2.d || []).some(r => r.lot_no === '004'),
        (drill2.d || []).map(r => r.lot_no).join(','));
  const g1Lots = drillLots.join(',');
  check('…so it is NOT in the Grade 1 list', !g1Lots.includes('004'), g1Lots);

  // ── The flag ───────────────────────────────────────────────────────
  console.log('[flag-off] switching the feature off puts the real seller back');
  await setFlag('false');
  d = await depot(); ins = await insights();
  check('all three real dealers are Dealer WT again', near(d.stats.dealerWeight, 300), String(d.stats.dealerWeight));
  check('…and the cap figure with it',      near(d.stats.grade2Qty, 300),    String(d.stats.grade2Qty));
  check('the snapshot agrees',              near(ins.totals.trader_weight, 300), String(ins.totals.trader_weight));
  check('the GSTIN-masked planter is a planter again', near(ins.totals.planter_weight, 200),
        String(ins.totals.planter_weight));
  check('the drill-down reads the stored grade again',
        Number((ins.gradeBreakdown.booked['2'] || {}).lots) === 3,
        JSON.stringify(ins.gradeBreakdown.booked));
  const offDrill = await api('GET', `/api/insights/lots?auction_id=${aid}&status=booked&grade=2`);
  check('…and lists all three stored grade-2 lots',
        (offDrill.d || []).map(r => r.lot_no).sort().join(',') === '001,002,005',
        (offDrill.d || []).map(r => r.lot_no).join(','));

  await setFlag('true');
  d = await depot();
  check('switching it back on restores the mask, nothing was lost',
        near(d.stats.dealerWeight, 200), String(d.stats.dealerWeight));

  // ── Containment ────────────────────────────────────────────────────
  console.log('[contained] the lot row still holds the real seller');
  const lots = (await api('GET', `/api/lots/${aid}`)).d || [];
  const row = lots.find(l => l.lot_no === '001') || {};
  check('the lot still holds the real seller identity',
        row.name === 'REAL DEALER ONE' && row.cr === GSTIN && String(row.grade) === '2',
        JSON.stringify({ name: row.name, cr: row.cr, grade: row.grade }));
  // The dummy columns are readable but separate — they never overwrite the
  // real ones, which is what every invoice, bill, payment and Tally export
  // reads. tests/lot-dummy-details.unit.js covers the report side of that
  // containment; here it is the row itself.
  check('the dummy identity sits alongside it, not over it',
        String(row.dummy_name || '') === 'DUMMY PLANTER ONE' && String(row.dummy_cr || '') === 'CR.8888',
        JSON.stringify({ dummy_name: row.dummy_name, dummy_cr: row.dummy_cr }));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', log.slice(-2000)); done(1); });
