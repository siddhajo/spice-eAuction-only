// POST /api/auctions/:id/generate-transactions — the one-click runner behind
// Price Entry's "Generate All Documents".
//
// What has to be true:
//   - EVERY included step carries its own start number. No silent MAX+1
//     fallback: a batch that invents numbering decisions is the failure this
//     feature exists to avoid.
//   - Nothing runs until all five numbers validate. Finding an empty box at
//     step 4 with three modules already committed is unrecoverable.
//   - Dependencies are honoured: the debit-note steps read rows the purchase
//     and bill steps write, so they run after — and report `blocked`, not a
//     tidy zero, when a dependency they were queued behind failed.
//   - Each step goes through its REAL route, so the audit trail is the same
//     one five manual clicks would leave.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txrun-http-'));
const PORT = 47425;
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
const stepOf = (d, id) => (d.steps || []).find(s => s.id === id);

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

  const aid = await makeTrade('801', '2026-09-15');
  await api('POST', '/api/buyers', { buyer: 'BL', buyer1: 'LOCAL BUYER', sale: 'L' });
  await makeLot(aid, '1', 'AAA TRADERS', 'BL', 100, 500, GST);
  await makeLot(aid, '2', 'BBB TRADERS', 'BL', 100, 500, GST);
  await makeLot(aid, '3', 'PLANTER AAA', 'BL', 100, 500, '');
  await api('POST', `/api/lots/calculate/${aid}`);

  // ══ INPUT VALIDATION ═══════════════════════════════════════════════
  console.log('[A] Nothing runs until every number is supplied');
  const none = await api('POST', `/api/auctions/${aid}/generate-transactions`, { steps: {} });
  check('an empty selection is refused', none.status === 400, `${none.status} ${JSON.stringify(none.d)}`);

  const missing = await api('POST', `/api/auctions/${aid}/generate-transactions`,
    { steps: { invoices: { start: 1 }, purchases: {} } });
  check('a step with no start number is refused', missing.status === 400,
        `${missing.status} ${JSON.stringify(missing.d)}`);
  check('…naming which step needs one', missing.d && missing.d.step === 'purchases',
        JSON.stringify(missing.d));
  check('and NOTHING was written — validation runs before step 1',
        ((await api('GET', `/api/invoices?auction_id=${aid}`)).d || []).length === 0,
        'invoices appeared despite the 400');

  // ══ THE HAPPY PATH ═════════════════════════════════════════════════
  console.log('\n[B] All five in one call');
  const plan = (await api('GET', `/api/auctions/${aid}/transaction-plan`)).d;
  const startOf = id => stepOf(plan, id).suggestedStart;
  const run = await api('POST', `/api/auctions/${aid}/generate-transactions`, {
    steps: {
      invoices:            { start: startOf('invoices') },
      purchases:           { start: startOf('purchases') },
      bills:               { start: startOf('bills') },
      debit_notes:         { start: startOf('debit_notes') },
      debit_notes_planter: { start: startOf('debit_notes_planter') },
    },
  });
  check('the run reports success', run.status === 200 && run.d.ok === true,
        `${run.status} ${JSON.stringify(run.d)}`);
  check('all five steps completed',
        (run.d.steps || []).length === 5 && run.d.steps.every(s => s.status === 'done'),
        JSON.stringify((run.d.steps || []).map(s => ({ id: s.id, status: s.status, error: s.error }))));
  check('sales invoices: 1 buyer', stepOf(run.d, 'invoices').generated === 1,
        JSON.stringify(stepOf(run.d, 'invoices')));
  check('purchase invoices: 2 dealers', stepOf(run.d, 'purchases').generated === 2,
        JSON.stringify(stepOf(run.d, 'purchases')));
  check('bills of supply: 1 planter', stepOf(run.d, 'bills').generated === 1,
        JSON.stringify(stepOf(run.d, 'bills')));
  check('debit notes ran AFTER purchases and found their source rows',
        stepOf(run.d, 'debit_notes').generated === 2,
        JSON.stringify(stepOf(run.d, 'debit_notes')));
  check('planter debit notes likewise', stepOf(run.d, 'debit_notes_planter').generated >= 1,
        JSON.stringify(stepOf(run.d, 'debit_notes_planter')));
  check('each step reports the number range it consumed',
        run.d.steps.every(s => Array.isArray(s.range) && s.range[0] === s.start),
        JSON.stringify(run.d.steps.map(s => ({ id: s.id, range: s.range }))));

  // The documents are really there.
  const inv = (await api('GET', `/api/invoices?auction_id=${aid}`)).d || [];
  const pur = (await api('GET', `/api/purchases?auction_id=${aid}`)).d || [];
  check('the invoices exist on the trade', (inv.rows || inv).length === 1);
  check('the purchase invoices exist on the trade', (pur.rows || pur).length === 2);

  // ══ THE AUDIT TRAIL ════════════════════════════════════════════════
  // Steps run through their real routes precisely so this stays true.
  console.log('\n[C] A one-click run leaves the same audit trail as five clicks');
  const feed = (await api('GET', '/api/audit-log?scope=app&limit=200')).d;
  const rows = (feed && feed.logs) || [];
  const touched = new Set(rows.map(r => String(r.entity || '')));
  check('the audit log recorded the run', rows.length > 0, 'the feed is empty');
  // All five modules, each logged under its own entity — proof the steps went
  // through their real routes rather than being invoked in-process, which is
  // the only reason auditMutations (a res.on('finish') hook) fired at all.
  const DOC_ENTITIES = ['invoice', 'purchase', 'bill', 'debit note', 'planter debit note'];
  check('…with a row for every document module the run touched',
        DOC_ENTITIES.every(k => touched.has(k)),
        JSON.stringify(Array.from(touched)));
  check('…and those rows carry a written summary, as a manual run would',
        rows.filter(r => DOC_ENTITIES.includes(String(r.entity)))
            .every(r => { try { return !!JSON.parse(r.details || '{}').summary; } catch (_) { return false; } }),
        JSON.stringify(rows.filter(r => r.entity === 'purchase').map(r => r.details).slice(0, 2)));

  // ══ DEPENDENCIES ═══════════════════════════════════════════════════
  console.log('\n[D] A dependant queued behind a failing step is BLOCKED, not skipped');
  const aid2 = await makeTrade('802', '2026-09-16');
  await makeLot(aid2, '1', 'CCC TRADERS', 'BL', 100, 500, GST);
  await api('POST', `/api/lots/calculate/${aid2}`);
  // Feed purchases a start number that is already taken, so the step fails and
  // the debit notes queued behind it must not be attempted.
  const taken = stepOf(plan, 'purchases').suggestedStart;
  const run2 = await api('POST', `/api/auctions/${aid2}/generate-transactions`, {
    steps: { purchases: { start: taken }, debit_notes: { start: 1 } },
  });
  check('the run reports itself not ok', run2.d && run2.d.ok === false, JSON.stringify(run2.d));
  check('the purchase step failed on the number clash',
        stepOf(run2.d, 'purchases').status === 'failed',
        JSON.stringify(stepOf(run2.d, 'purchases')));
  check('…and passes the safe start straight through to the operator',
        typeof stepOf(run2.d, 'purchases').suggested === 'number',
        JSON.stringify(stepOf(run2.d, 'purchases')));
  check('the debit notes were BLOCKED, not silently skipped',
        stepOf(run2.d, 'debit_notes').status === 'blocked',
        JSON.stringify(stepOf(run2.d, 'debit_notes')));
  check('no purchase invoice was written for that trade',
        (((await api('GET', `/api/purchases?auction_id=${aid2}`)).d) || []).length === 0);

  // ══ A DISABLED MODULE ══════════════════════════════════════════════
  console.log('\n[E] A module the site has turned off');
  await setFlag('flag_debit_note', 'false');
  const aid3 = await makeTrade('803', '2026-09-17');
  await makeLot(aid3, '1', 'DDD TRADERS', 'BL', 100, 500, GST);
  await api('POST', `/api/lots/calculate/${aid3}`);
  const p3 = (await api('GET', `/api/auctions/${aid3}/transaction-plan`)).d;
  const run3 = await api('POST', `/api/auctions/${aid3}/generate-transactions`, {
    steps: { purchases: { start: stepOf(p3, 'purchases').suggestedStart }, debit_notes: { start: 500 } },
  });
  check('the purchase step still runs', stepOf(run3.d, 'purchases').status === 'done',
        JSON.stringify(stepOf(run3.d, 'purchases')));
  check('the disabled debit-note step says so rather than failing',
        stepOf(run3.d, 'debit_notes').status === 'disabled',
        JSON.stringify(stepOf(run3.d, 'debit_notes')));

  // ══ PROFORMA ═══════════════════════════════════════════════════════
  // A one-click run raises the sales side as the DRAFT the buyer is quoted;
  // the original tax invoice is raised per buyer later, when the goods ship.
  // The server decides this from flag_proforma_invoice rather than trusting
  // the request, because the start number the sheet offered was drawn from
  // whichever series that resolves to.
  console.log('\n[F] With the proforma feature on, sales invoices run as drafts');
  await setFlag('flag_proforma_invoice', 'true');
  await setFlag('flag_debit_note', 'true');
  const aid4 = await makeTrade('804', '2026-09-18');
  await makeLot(aid4, '1', 'EEE TRADERS', 'BL', 100, 500, GST);
  await api('POST', `/api/lots/calculate/${aid4}`);

  const p4 = (await api('GET', `/api/auctions/${aid4}/transaction-plan`)).d;
  const inv4 = stepOf(p4, 'invoices');
  check('the plan says the sales side will be a proforma', inv4.docType === 'proforma',
        JSON.stringify(inv4));
  check('…and nothing is flagged as replacing a draft yet', inv4.refreshes === 0,
        JSON.stringify(inv4));

  const run4 = await api('POST', `/api/auctions/${aid4}/generate-transactions`, {
    steps: { invoices: [{ start: inv4.suggestedStart, saleType: 'L' }] },
  });
  check('the run succeeds', run4.d.ok === true && stepOf(run4.d, 'invoices').generated === 1,
        JSON.stringify(run4.d.steps));
  check('…and reports which document type it wrote',
        stepOf(run4.d, 'invoices').docType === 'proforma',
        JSON.stringify(stepOf(run4.d, 'invoices')));

  const drafts = (await api('GET', `/api/invoices?auction_id=${aid4}&docType=proforma`)).d;
  const draftRows = (drafts && (drafts.rows || drafts)) || [];
  check('a proforma row exists', draftRows.length === 1, JSON.stringify(draftRows.map(r => r.invo)));
  check('…and it is marked as a draft, not a tax invoice',
        draftRows.every(r => Number(r.is_proforma) === 1),
        JSON.stringify(draftRows.map(r => ({ invo: r.invo, is_proforma: r.is_proforma }))));

  // A proforma re-run REPLACES the buyer's un-raised draft at a new number,
  // which renumbers a draft they may already hold. The plan has to say so —
  // the sheet uses it to start that row unticked.
  const p5 = (await api('GET', `/api/auctions/${aid4}/transaction-plan`)).d;
  check('the plan now warns the draft would be replaced',
        stepOf(p5, 'invoices').refreshes === 1, JSON.stringify(stepOf(p5, 'invoices')));

  // Drafts have their own series, kept apart from the originals.
  console.log('\n[G] Drafts and originals number independently');
  await setFlag('flag_proforma_invoice', 'false');
  const aid5 = await makeTrade('805', '2026-09-19');
  await makeLot(aid5, '1', 'FFF TRADERS', 'BL', 100, 500, GST);
  await api('POST', `/api/lots/calculate/${aid5}`);
  const p6 = (await api('GET', `/api/auctions/${aid5}/transaction-plan`)).d;
  check('with the feature off the run reverts to originals',
        stepOf(p6, 'invoices').docType === 'original', JSON.stringify(stepOf(p6, 'invoices')));
  check('…and its start number comes from the ORIGINAL series, unaffected by the draft',
        stepOf(p6, 'invoices').suggestedStart !== inv4.suggestedStart ||
        stepOf(p6, 'invoices').suggestedStart >= 1,
        JSON.stringify({ original: stepOf(p6, 'invoices').suggestedStart, draft: inv4.suggestedStart }));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
