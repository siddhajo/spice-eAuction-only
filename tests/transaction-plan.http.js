// GET /api/auctions/:id/transaction-plan — the review sheet behind the
// one-click "generate every document for this trade" flow.
//
// The plan's job is to be TRUE BEFORE the run, which is harder than it looks:
//
//   - The two debit-note steps read rows the earlier steps have not written
//     yet. On a fresh trade their own tables are empty, so a naive count says
//     "nothing to do" and the operator under-numbers the trade. They must
//     predict from `lots` and SAY that is what they are doing (`basis`).
//   - Every `suggestedStart` has to be a number the corresponding generate
//     route actually accepts. A suggestion that gets refused by the range
//     claim is worse than no suggestion at all, so the test feeds each one
//     straight back into its own endpoint.
//   - A step turned off for the site must say WHY, not just report false.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txplan-http-'));
const PORT = 47423;
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
  if (r.status !== 200) throw new Error(`could not set ${key}: ${r.status}`);
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

const GST = '33AAAAA0000A1Z5';
async function makeTrade(ano, date) {
  const r = await api('POST', '/api/auctions', { ano, date, state: 'TAMIL NADU' });
  const aid = r.d && (r.d.id || (r.d.auction && r.d.auction.id));
  if (!aid) { console.error('auction create failed', r.status, r.d); cleanup(); process.exit(1); }
  return aid;
}
async function makeLot(aid, lot_no, name, buyer, qty, price, cr) {
  const r = await api('POST', '/api/lots', {
    auction_id: aid, lot_no, name, cr: cr || '', qty,
    grade: cr ? '2' : '1', bags: 10, crop: 'CARDAMOM',
  });
  const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
  if (!lotId) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
  await api('PUT', `/api/lots/${lotId}`, { buyer: buyer || '', price, amount: qty * price });
  return lotId;
}
const stepOf = (plan, id) => (plan.steps || []).find(s => s.id === id);

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in\n');

  await setFlag('flag_debit_note', 'true');
  await setFlag('flag_debit_note_planter', 'true');

  // ══ A trade with nothing priced ════════════════════════════════════
  console.log('[A] A trade with no prices yet');
  const empty = await makeTrade('601', '2026-09-01');
  await makeLot(empty, '1', 'PLANTER ZERO', 'BL', 100, 0, '');
  const p0 = await api('GET', `/api/auctions/${empty}/transaction-plan`);
  check('the plan responds', p0.status === 200, `${p0.status} ${JSON.stringify(p0.d)}`);
  check('it reports the no-prices blocker rather than offering numbers',
        (p0.d.blockers || []).some(b => b.gate === 'no_prices'),
        JSON.stringify(p0.d.blockers));
  check('every pipeline step is listed even so', (p0.d.steps || []).length === 5,
        `got ${(p0.d.steps || []).length}`);

  // ══ A real trade ═══════════════════════════════════════════════════
  console.log('\n[B] A priced trade — counts before anything is generated');
  const aid = await makeTrade('602', '2026-09-02');
  await api('POST', '/api/buyers', { buyer: 'BL', buyer1: 'LOCAL BUYER', sale: 'L' });
  await makeLot(aid, '1', 'AAA TRADERS', 'BL', 100, 500, GST);   // grade 2 → purchase + DN
  await makeLot(aid, '2', 'BBB TRADERS', 'BL', 100, 500, GST);   // grade 2 → purchase + DN
  await makeLot(aid, '3', 'PLANTER AAA', 'BL', 100, 500, '');    // grade 1 → bill + DN-planter
  // Save & Calculate is what fills lots.com / lots.sertax, and the debit-note
  // counts are derived from those — so the plan is only meaningful after it.
  await api('POST', `/api/lots/calculate/${aid}`);

  const plan = (await api('GET', `/api/auctions/${aid}/transaction-plan`)).d;
  check('no blockers on a priced trade', (plan.blockers || []).length === 0,
        JSON.stringify(plan.blockers));
  check('sales invoices are pending (one buyer)', stepOf(plan, 'invoices').pending === 1,
        JSON.stringify(stepOf(plan, 'invoices')));
  check('purchase invoices are pending (two dealers)', stepOf(plan, 'purchases').pending === 2,
        JSON.stringify(stepOf(plan, 'purchases')));
  check('bills of supply are pending (one planter)', stepOf(plan, 'bills').pending === 1,
        JSON.stringify(stepOf(plan, 'bills')));
  check('totalPending adds the steps up',
        plan.totalPending === plan.steps.reduce((a, s) => a + (s.pending || 0), 0),
        `${plan.totalPending}`);

  // The point of `basis`: purchases do not exist yet, so the dealer DN count
  // can only be a prediction off `lots` — and it must say so.
  const dn = stepOf(plan, 'debit_notes');
  check('the dealer DN step predicts from lots while `purchases` is empty',
        dn.basis === 'predicted', JSON.stringify(dn));
  check('…and predicts a non-zero count, not a silent zero', dn.pending > 0,
        JSON.stringify(dn));
  check('it declares its dependency on purchases',
        JSON.stringify(dn.after) === JSON.stringify(['purchases']), JSON.stringify(dn.after));

  // ══ The suggestions have to actually work ══════════════════════════
  console.log('\n[C] Every suggestedStart is accepted by its own endpoint');
  const sInv = stepOf(plan, 'invoices').suggestedStart;
  const sPur = stepOf(plan, 'purchases').suggestedStart;
  const sBil = stepOf(plan, 'bills').suggestedStart;
  check('each step offers a positive start number',
        [sInv, sPur, sBil].every(n => Number.isInteger(n) && n > 0),
        JSON.stringify({ sInv, sPur, sBil }));

  const rInv = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: sInv });
  check('the suggested sales-invoice start is accepted', rInv.status === 200 && rInv.d.generated === 1,
        `${rInv.status} ${JSON.stringify(rInv.d && (rInv.d.error || rInv.d.generated))}`);
  const rPur = await api('POST', `/api/purchases/generate-all/${aid}`, { startInvoiceNo: sPur });
  check('the suggested purchase start is accepted', rPur.status === 200 && rPur.d.generated === 2,
        `${rPur.status} ${JSON.stringify(rPur.d && (rPur.d.error || rPur.d.generated))}`);
  const rBil = await api('POST', `/api/bills/generate-all/${aid}`, { startBillNo: sBil });
  check('the suggested bill start is accepted', rBil.status === 200 && rBil.d.generated === 1,
        `${rBil.status} ${JSON.stringify(rBil.d && (rBil.d.error || rBil.d.generated))}`);

  // ══ The plan moves with the trade ══════════════════════════════════
  console.log('\n[D] After the first three steps run');
  const plan2 = (await api('GET', `/api/auctions/${aid}/transaction-plan`)).d;
  check('sales invoices now report nothing pending', stepOf(plan2, 'invoices').pending === 0,
        JSON.stringify(stepOf(plan2, 'invoices')));
  check('…and report what was generated', stepOf(plan2, 'invoices').generated >= 1,
        JSON.stringify(stepOf(plan2, 'invoices')));
  const dn2 = stepOf(plan2, 'debit_notes');
  check('the dealer DN count is now ACTUAL — its source rows exist',
        dn2.basis === 'actual', JSON.stringify(dn2));
  check('and it still owes the same two notes', dn2.pending === 2, JSON.stringify(dn2));

  const rDn = await api('POST', '/api/debit-notes/generate-bulk',
    { ano: '602', startNoteNo: dn2.suggestedStart });
  check('the suggested DN start is accepted', rDn.status === 200,
        `${rDn.status} ${JSON.stringify(rDn.d)}`);
  const dnp2 = stepOf(plan2, 'debit_notes_planter');
  const rDnp = await api('POST', '/api/debit-notes-planter/generate-bulk',
    { ano: '602', startNoteNo: dnp2.suggestedStart });
  check('the suggested planter-DN start is accepted', rDnp.status === 200,
        `${rDnp.status} ${JSON.stringify(rDnp.d)}`);

  const plan3 = (await api('GET', `/api/auctions/${aid}/transaction-plan`)).d;
  check('every step owes nothing now — all five top up',
        plan3.totalPending === 0,
        JSON.stringify(plan3.steps.map(s => ({ id: s.id, pending: s.pending }))));

  // The guard that makes that true. Seller-wise purchases and bills had NO
  // top-up check until 2026-09-21: every run re-invoiced every party, so a
  // second click left one dealer holding two invoices for the same lots under
  // different numbers. The number-collision claim does not catch it — the
  // second run's numbers are genuinely free.
  console.log('\n[D2] A re-run writes nothing, rather than a duplicate set');
  const before = ((await api('GET', `/api/purchases?auction_id=${aid}`)).d || []).length;
  const rerun = await api('POST', `/api/auctions/${aid}/generate-transactions`, {
    steps: { purchases: { start: stepOf(plan3, 'purchases').suggestedStart },
             bills:     { start: stepOf(plan3, 'bills').suggestedStart } },
  });
  const purStep = (rerun.d.steps || []).find(s => s.id === 'purchases');
  check('the re-run creates no purchase invoices', purStep && purStep.generated === 0,
        JSON.stringify(purStep));
  check('…reporting them as skipped, not failed',
        purStep && purStep.skipped === 2 && !purStep.errors, JSON.stringify(purStep));
  check('and the trade still holds exactly the originals',
        ((await api('GET', `/api/purchases?auction_id=${aid}`)).d || []).length === before,
        'a duplicate set was written');

  // ══ A step the site has turned off ═════════════════════════════════
  console.log('\n[E] A disabled module says why');
  await setFlag('flag_debit_note', 'false');
  const plan4 = (await api('GET', `/api/auctions/${aid}/transaction-plan`)).d;
  const off = stepOf(plan4, 'debit_notes');
  check('the dealer DN step reports itself unavailable', off.enabled === false, JSON.stringify(off));
  check('…with a reason naming the flag',
        typeof off.disabledReason === 'string' && off.disabledReason.includes('flag_debit_note'),
        JSON.stringify(off.disabledReason));
  check('…and offers no start number for a run that cannot happen',
        off.suggestedStart === null && off.pending === 0, JSON.stringify(off));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
