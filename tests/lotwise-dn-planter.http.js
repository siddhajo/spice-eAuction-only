// Lot-wise DEBIT NOTE — PLANTER — end-to-end HTTP test against a live server
// on a throwaway data dir. Mirrors tests/lotwise-bills.http.js.
//
// The defining requirement: lot-wise generation is ordered by LOT NUMBER
// ASCENDING, so note numbers are handed out lot-by-lot across the whole trade
// (a planter's non-adjacent lots get non-consecutive numbers). Each lot-wise
// DN's amount is the commission + handling on that ONE grade-1 lot, so the
// lot-wise DNs for a planter sum to the seller-wise DN for that planter.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotwise-dnp-'));
const PORT = 47315;
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
async function setFlag(key, val) {
  const r = await api('PUT', '/api/company-settings', { settings: { [key]: String(val) } });
  if (r.status !== 200) throw new Error(`could not set ${key}: ${r.status} ${JSON.stringify(r.d)}`);
  const back = await api('GET', '/api/company-settings/flat');
  if (String(back.d && back.d[key]) !== String(val)) throw new Error(`${key} did not persist`);
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', b => { srvLog += b.toString(); });
srv.stderr.on('data', b => { srvLog += b.toString(); });
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in\n');

  // Company is TAMIL NADU (state code 33); planter lots carry pst_code 33 →
  // local → CGST+SGST. Explicit service GST so the split is deterministic.
  await api('PUT', '/api/company-settings', { settings: { business_state: 'TAMIL NADU', gst_service: '18', discount_gst: '18' } });

  // ── Fixture: one trade, two planters, grade-1 lots entered OUT of order. ──
  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-12', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  if (!aid) { console.error('auction create failed', auc.status, auc.d); cleanup(); process.exit(1); }

  // lot_no, planter,        com, sertax   (service base = com + sertax)
  const lots = [
    ['203', 'RAMU PLANTER',  200, 30],   // RAMU second lot  → base 230
    ['201', 'RAMU PLANTER',  100, 20],   // RAMU first lot   → base 120
    ['202', 'SELVI PLANTER', 50,  5],    // SELVI            → base 55
  ];
  const lotIdByNo = {};
  for (const [lot_no, name, com, sertax] of lots) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name, grade: '1', bags: 5, qty: 100 });
    if (r.status >= 300) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    lotIdByNo[lot_no] = lotId;
    // price/amount make the lot eligible for a Bill of Supply (amount > 0),
    // which the SELLER-WISE planter-DN path derives from. The DN service base
    // is com + sertax and is independent of amount.
    const u = await api('PUT', `/api/lots/${lotId}`, { com, sertax, pst_code: '33', pstate: 'TAMIL NADU', grade: '1', price: 400, amount: 40000 });
    if (u.status >= 300) { console.error('lot service update failed', u.status, u.d); cleanup(); process.exit(1); }
  }
  await setFlag('flag_debit_note_planter', 'true');   // feature must be enabled at all

  // NOTE: bills/generate-all auto-runs calculateLot, which recomputes each
  // lot's com/sertax from the configured commission/handling rates. So the
  // service base is whatever the app computes — this test reads the ACTUAL
  // per-lot amounts (via eligible-lots) rather than hard-coding them, and
  // asserts the invariants: per-lot DN = that lot's service, and the lot-wise
  // DNs for a planter sum to the seller-wise DN for that planter.
  let RAMU_TOTAL = 0, SELVI_TOTAL = 0;

  // ══ SELLER-WISE (lot-wise flag OFF — the default) ══════════════════
  console.log('[A] Seller-wise mode (flag OFF) — existing behaviour');
  await setFlag('flag_lotwise_dn_planter', 'false');

  // Seller-wise generate-bulk works off bills of supply, so raise them first.
  const swBills = await api('POST', `/api/bills/generate-all/${aid}`, { startBillNo: 1 });
  check('bills of supply generated for the planters', swBills.d && swBills.d.generated === 2,
        JSON.stringify(swBills.d));

  const swGen = await api('POST', `/api/debit-notes-planter/generate-bulk`, { ano: '9', startNoteNo: 1 });
  check('seller-wise bulk creates one DN per planter (2)', swGen.d && swGen.d.created === 2,
        JSON.stringify(swGen.d));

  let list = await api('GET', `/api/debit-notes-planter?ano=9`);
  let rows = (list.d && (list.d.rows || list.d)) || [];
  check('all seller-wise DN rows have blank lot_no',
        rows.length === 2 && rows.every(r => !String(r.lot_no || '').trim()),
        JSON.stringify(rows.map(r => ({ note: r.note_no, name: r.name, lot_no: r.lot_no }))));
  const ramuSw  = rows.find(r => r.name === 'RAMU PLANTER');
  const selviSw = rows.find(r => r.name === 'SELVI PLANTER');
  RAMU_TOTAL  = ramuSw  ? Number(ramuSw.amount)  : 0;
  SELVI_TOTAL = selviSw ? Number(selviSw.amount) : 0;
  check('seller-wise RAMU DN has a positive service amount',
        RAMU_TOTAL > 0, `amount ${RAMU_TOTAL}`);
  check('seller-wise DN is local (CGST+SGST, no IGST)',
        ramuSw && Number(ramuSw.igst) === 0 && (Number(ramuSw.cgst) + Number(ramuSw.sgst)) > 0,
        ramuSw && JSON.stringify({ cgst: ramuSw.cgst, sgst: ramuSw.sgst, igst: ramuSw.igst }));

  // A lot-wise request must be refused while the flag is off.
  const refused = await api('POST', `/api/debit-notes-planter/generate`,
    { ano: '9', lotNo: '201', startNoteNo: 50 });
  check('lot-wise request refused with 403 while flag is off', refused.status === 403,
        `got ${refused.status} ${JSON.stringify(refused.d)}`);

  // ══ LOT-WISE (flag ON) ═════════════════════════════════════════════
  console.log('\n[B] Lot-wise mode (flag ON)');
  for (const r of rows) await api('DELETE', `/api/debit-notes-planter/${r.id}`);
  await setFlag('flag_lotwise_dn_planter', 'true');

  const elLots = await api('GET', `/api/debit-notes-planter/eligible-lots/${aid}`);
  const elNos = (elLots.d || []).map(l => l.lot_no);
  const elAmt = Object.fromEntries((elLots.d || []).map(l => [l.lot_no, Number(l.amount)]));
  check('eligible-lots returns the 3 grade-1 lots', elLots.d && elLots.d.length === 3, JSON.stringify(elNos));
  check('eligible-lots is ordered by lot number ASCENDING (201,202,203)',
        JSON.stringify(elNos) === JSON.stringify(['201', '202', '203']), JSON.stringify(elNos));
  check('each lot carries its own positive service amount',
        elLots.d.every(l => Number(l.amount) > 0),
        JSON.stringify(elLots.d.map(l => ({ lot: l.lot_no, amt: l.amount }))));
  // The per-lot services must reconcile to the seller-wise DN totals.
  check('lot services reconcile to the seller-wise totals per planter',
        Math.abs((elAmt['201'] + elAmt['203']) - RAMU_TOTAL) < 0.01 &&
        Math.abs(elAmt['202'] - SELVI_TOTAL) < 0.01,
        JSON.stringify({ ramuLots: elAmt['201'] + elAmt['203'], RAMU_TOTAL, selviLot: elAmt['202'], SELVI_TOTAL }));

  // Flag on but no lot selected → 400 (mode mismatch).
  const noLot = await api('POST', `/api/debit-notes-planter/generate`, { ano: '9', bilno: '1', startNoteNo: 1 });
  check('single generate with no lot is refused (400) in lot-wise mode', noLot.status === 400,
        `got ${noLot.status} ${JSON.stringify(noLot.d)}`);

  // Bulk lot-wise generation, numbered from 1.
  const batch = await api('POST', `/api/debit-notes-planter/generate-bulk`, { ano: '9', startNoteNo: 1 });
  check('bulk reports lot mode', batch.d && batch.d.mode === 'lot', JSON.stringify(batch.d));
  check('bulk creates one DN per grade-1 lot (3)', batch.d && batch.d.created === 3,
        batch.d && `created ${batch.d.created}`);

  list = await api('GET', `/api/debit-notes-planter?ano=9`);
  rows = (list.d && (list.d.rows || list.d)) || [];
  check('3 lot-wise DNs exist, one per lot', rows.length === 3, `got ${rows.length}`);
  check('every DN row is stamped with its lot',
        rows.every(r => String(r.lot_no || '').trim() !== ''),
        JSON.stringify(rows.map(r => ({ note: r.note_no, lot_no: r.lot_no }))));

  // ── THE KEY REQUIREMENT: numbering follows lot-number ascending order ──
  // Sorting the DNs by note number must reproduce the lot order 201,202,203 —
  // so RAMU's two lots (201, 203) get the NON-consecutive numbers 1 and 3,
  // with SELVI's 202 taking number 2 in between.
  const byNote = rows.slice().sort((a, b) => Number(a.note_no) - Number(b.note_no));
  check('note numbers are assigned in lot-ascending order',
        JSON.stringify(byNote.map(r => r.lot_no)) === JSON.stringify(['201', '202', '203']),
        JSON.stringify(byNote.map(r => ({ note: r.note_no, lot: r.lot_no }))));
  check('lot 201 → note #1, lot 202 → note #2, lot 203 → note #3',
        Number(byNote[0].note_no) === 1 && Number(byNote[1].note_no) === 2 && Number(byNote[2].note_no) === 3,
        JSON.stringify(byNote.map(r => ({ note: r.note_no, lot: r.lot_no }))));

  // Each lot-wise DN's amount is exactly that lot's service, and the lot-wise
  // DNs for a planter sum to that planter's seller-wise DN.
  const amtByLot = Object.fromEntries(rows.map(r => [r.lot_no, Number(r.amount)]));
  check('each lot-wise DN amount equals that lot\'s service base',
        amtByLot['201'] === elAmt['201'] && amtByLot['202'] === elAmt['202'] && amtByLot['203'] === elAmt['203'],
        JSON.stringify({ dn: amtByLot, lots: elAmt }));
  check('RAMU lot-wise DNs sum to his seller-wise DN',
        Math.abs((amtByLot['201'] + amtByLot['203']) - RAMU_TOTAL) < 0.01,
        `${amtByLot['201'] + amtByLot['203']} vs ${RAMU_TOTAL}`);
  check('SELVI lot-wise DN equals her seller-wise DN',
        Math.abs(amtByLot['202'] - SELVI_TOTAL) < 0.01, `${amtByLot['202']} vs ${SELVI_TOTAL}`);

  // Duplicate guard + top-up behaviour.
  const dupe = await api('POST', `/api/debit-notes-planter/generate`,
    { ano: '9', lotNo: '201', lotId: lotIdByNo['201'], startNoteNo: 99 });
  check('re-billing the same lot is refused with 409', dupe.status === 409,
        `got ${dupe.status} ${JSON.stringify(dupe.d)}`);

  const rerun = await api('POST', `/api/debit-notes-planter/generate-bulk`, { ano: '9', startNoteNo: 10 });
  check('re-run bulk creates nothing new and skips all 3',
        rerun.d && rerun.d.created === 0 && rerun.d.skipped === 3,
        JSON.stringify({ created: rerun.d && rerun.d.created, skipped: rerun.d && rerun.d.skipped }));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.slice(-2500));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
