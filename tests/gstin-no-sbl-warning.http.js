// "GSTIN, no SBL" — the lot-validation warning for the gap between the two
// dealer rules, end-to-end over HTTP on a throwaway data dir.
//
// A seller whose `cr` holds a GSTIN but whose SBL (stored in `aadhar`) is blank
// no longer changes their GRADE — Lot Entry grades on the GSTIN alone as of
// 2026-09-21, the same rule the purchase invoice and debit-note eligibility
// use. But the SBL is still REQUIRED: the Spices Board e-Auction CSV emits it
// per dealer row, and the dashboard's Grade-2 / 25%-cap band derives dealer
// status from dealerSql(cr, aadhar), so a blank one drops that seller's weight
// out of the cap. This warning names that master-data gap.
//
// Pinned here:
//   [fires]  a GSTIN seller with a blank SBL raises 'gstin_no_sbl'
//   [quiet]  a GSTIN seller WITH an SBL does not
//   [quiet]  a planter (CR number, no SBL) does not — the SBL is not expected
//   [quiet]  a CR number that merely starts with two digits is not read as a
//            GSTIN (the full 15-char shape is matched, as gstinStateCode does)
//   [grade]  it is independent of the stored grade — the master is what is
//            incomplete, so it fires on Grade-1 and Grade-2 lots alike
//   [pair]   the two grade-mismatch warnings run on the GSTIN-only rule too,
//            so a dealer with a blank SBL is never flagged as a mismatch
//            against the grade Lot Entry itself just filled in
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstin-no-sbl-'));
const PORT = 47371;
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

  const auc = await api('POST', '/api/auctions', { ano: '17', date: '2026-09-02', state: 'KERALA' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  if (!aid) { console.error('auction create failed', auc.status, auc.d); cleanup(); process.exit(1); }

  // One lot each. `grade` is what Lot Entry would have stamped, except for
  // STAMPED ESTATES, which stands for the seller an operator hand-set to
  // Grade 2 despite the missing SBL (the real-world Indel case).
  const sellers = [
    { name: 'FULL DEALER',     cr: 'GSTIN.32AAHCE4551A1Z8', sbl: 'ML/REG/10001/2021', grade: '2', lot: '101' },
    { name: 'NO SBL DEALER',   cr: 'GSTIN.32AADTC2421J1Z7', sbl: '',                  grade: '1', lot: '102' },
    { name: 'STAMPED ESTATES', cr: 'GSTIN.32AAMCM4500C1Z2', sbl: '',                  grade: '2', lot: '103' },
    { name: 'PLAIN PLANTER',   cr: 'CR.4455/19',            sbl: '',                  grade: '1', lot: '104' },
    // A CR number that OPENS with two digits — the shape that a partial
    // "starts with 2 digits" GSTIN test would misread as a dealer.
    { name: 'NUMERIC CR',      cr: 'CR.21472/19',           sbl: '',                  grade: '1', lot: '105' },
  ];
  for (const s of sellers) {
    const t = await api('POST', '/api/traders', {
      name: s.name, cr: s.cr, aadhar: s.sbl, pan: 'AAHCE4551A', tel: '9000010001' });
    const tid = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
    if (!tid) { console.error('trader create failed', s.name, t.status, t.d); cleanup(); process.exit(1); }
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no: s.lot, name: s.name, trader_id: tid,
      cr: s.cr, aadhar: s.sbl, pan: 'AAHCE4551A', tel: '9000010001',
      grade: s.grade, bags: 4, qty: 100, crop: 'CARDAMOM', branch: 'VANDANMEDU' });
    if (r.status >= 300) { console.error('lot create failed', s.name, r.status, r.d); cleanup(); process.exit(1); }
  }

  const v = await api('GET', `/api/auctions/${aid}/validate-lots`);
  if (v.status !== 200) { console.error('validate failed', v.status, v.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  const warnings = (v.d && v.d.warnings) || [];
  const byType = Object.fromEntries(warnings.map(w => [w.type, w]));
  const named = (type) => ((byType[type] && byType[type].lots) || [])
    .map(l => String(l.name || l.seller || '')).sort();

  console.log('[fires] the warning exists and names the right sellers');
  check('a "GSTIN, no SBL" warning is raised', !!byType.gstin_no_sbl,
        JSON.stringify(warnings.map(w => w.type)));
  check('…it names exactly the two GSTIN sellers with a blank SBL',
        JSON.stringify(named('gstin_no_sbl')) === JSON.stringify(['NO SBL DEALER', 'STAMPED ESTATES']),
        JSON.stringify(named('gstin_no_sbl')));
  check('…counted per lot', byType.gstin_no_sbl && byType.gstin_no_sbl.count === 2,
        String(byType.gstin_no_sbl && byType.gstin_no_sbl.count));

  console.log('\n[quiet] it stays off the sellers it does not concern');
  const flagged = new Set(named('gstin_no_sbl'));
  check('a dealer WITH an SBL is not flagged', !flagged.has('FULL DEALER'));
  check('a planter is not flagged', !flagged.has('PLAIN PLANTER'));
  check('a CR number opening with two digits is not read as a GSTIN',
        !flagged.has('NUMERIC CR'));

  console.log('\n[grade] the master gap is flagged whatever the stored grade says');
  check('the Grade-1 lot is flagged', flagged.has('NO SBL DEALER'));
  check('…and so is the Grade-2 one', flagged.has('STAMPED ESTATES'));

  console.log('\n[pair] the grade-mismatch warnings run on the same GSTIN-only rule');
  // STAMPED ESTATES is Grade 2 with a GSTIN and no SBL — exactly what Lot Entry
  // now fills in by itself. Under the old GSTIN+SBL rule this raised "Grade 2,
  // not a dealer": the app warning about its own default.
  check('a Grade-2 GSTIN dealer with a blank SBL is NOT called a grade mismatch',
        !named('grade_not_dealer').includes('STAMPED ESTATES'),
        JSON.stringify(named('grade_not_dealer')));
  check('"Grade 2, not a dealer" is reserved for a Grade-2 lot with NO GSTIN',
        named('grade_not_dealer').length === 0,
        JSON.stringify(named('grade_not_dealer')));
  // The legacy Grade-1 lot belonging to a GSTIN seller is the row that still
  // needs remediation — its commission is missing from the dealer debit note.
  check('"Dealer, not Grade 2" catches the legacy Grade-1 lot of a GSTIN seller',
        named('dealer_not_grade2').includes('NO SBL DEALER'),
        JSON.stringify(named('dealer_not_grade2')));
  check('…and does not sweep in the planters',
        !named('dealer_not_grade2').includes('PLAIN PLANTER')
        && !named('dealer_not_grade2').includes('NUMERIC CR'),
        JSON.stringify(named('dealer_not_grade2')));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
