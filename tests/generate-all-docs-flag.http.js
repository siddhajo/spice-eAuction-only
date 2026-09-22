// flag_generate_all_docs — the switch on Price Entry's "⚡ Generate All
// Documents" one-click run.
//
// This flag is unusual in two ways and both need holding down:
//
//   1. It DEFAULTS ON. Every other button flag here defaults off, because
//      each introduces a new surface. This one retrofits a switch onto
//      behaviour that already shipped, so defaulting it off would delete a
//      working button from every install on upgrade. An install that has
//      never seen the key must behave exactly as it did before the key
//      existed.
//   2. It gates the SERVER, not just the button. The run commits sales
//      invoices, purchases, bills of supply and debit notes across a whole
//      trade; leaving that reachable behind a CSS rule while the operator
//      believes the feature is off is not a switch, it is a decoration.
//
//   [default]   a fresh install has the flag on, and the run works
//   [off]       switching it off refuses the run with 403 — and writes nothing
//   [on-again]  switching it back on restores it
//   [plan]      the read-only review sheet is unaffected either way
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-all-flag-'));
const PORT = 47395;
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
const setFlag = v => api('PUT', '/api/company-settings', { settings: { flag_generate_all_docs: v } });

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

// Pull one step out of a plan or a run result by its pipeline id.
const stepOf = (d, id) => ((d && d.steps) || []).find(s => s.id === id);

// How many sales invoices exist — the proof that a refused run wrote nothing,
// rather than merely reporting that it didn't. The list endpoint filters by
// business state, so ask by auction id, which it also accepts.
async function invoiceCount(aid) {
  const r = await api('GET', `/api/invoices?auction_id=${aid}`);
  const rows = Array.isArray(r.d) ? r.d : (r.d && r.d.rows) || [];
  return rows.length;
}

// A minimal sellable trade: two priced lots on one local buyer, calculated.
// Buyer and price go on with a PUT after create — same shape the working
// generate-transactions.http.js fixture uses, because POST /api/lots does
// not take them.
async function makeTrade(ano, date) {
  const auc = await api('POST', '/api/auctions', { ano, date, state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  for (const lot_no of ['1', '2']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'PLANTER ' + lot_no, qty: 100,
      grade: '1', bags: 10, crop: 'CARDAMOM',
    });
    const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    await api('PUT', `/api/lots/${lotId}`, { buyer: 'BL', price: 500, amount: 50000 });
  }
  await api('POST', `/api/lots/calculate/${aid}`);
  return aid;
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', log.slice(-2000)); done(1); }
  console.log('logged in\n');
  await api('POST', '/api/buyers', { buyer: 'BL', buyer1: 'LOCAL BUYER', sale: 'L' });

  console.log('[default] a fresh install, with the key never touched, still runs');
  // The literal default, and then the behaviour it is supposed to produce.
  const DEFAULTS = require(path.join(ROOT, 'company-config.js')).DEFAULTS
                || require(path.join(ROOT, 'company-config.js')).DEFAULT_SETTINGS;
  const def = (DEFAULTS || []).find(d => d.key === 'flag_generate_all_docs');
  check('the shipped default is true', def && String(def.value) === 'true', JSON.stringify(def));

  const aidA = await makeTrade('64', '2026-09-18');
  let plan = await api('GET', `/api/auctions/${aidA}/transaction-plan`);
  check('the plan loads', plan.status === 200 && Array.isArray(plan.d.steps),
        `${plan.status} ${JSON.stringify(plan.d).slice(0, 160)}`);
  const invStep = stepOf(plan.d, 'invoices');
  check('…and offers a sales-invoice step with something pending',
        invStep && invStep.pending > 0, JSON.stringify(invStep));
  let run = await api('POST', `/api/auctions/${aidA}/generate-transactions`, {
    steps: { invoices: { start: invStep.suggestedStart || 1, sale: 'L' } },
  });
  check('the run is accepted out of the box', run.status === 200, `${run.status} ${JSON.stringify(run.d).slice(0, 200)}`);
  check('…and actually raised a document', (await invoiceCount(aidA)) > 0,
        JSON.stringify(stepOf(run.d, 'invoices')));

  console.log('[off] switching it off refuses the run, and writes nothing');
  await setFlag('false');
  const aidB = await makeTrade('65', '2026-09-19');
  const planB = (await api('GET', `/api/auctions/${aidB}/transaction-plan`)).d;
  check('the read-only sheet still loads with the flag off',
        Array.isArray(planB.steps) && stepOf(planB, 'invoices').pending > 0,
        JSON.stringify(stepOf(planB, 'invoices')));
  run = await api('POST', `/api/auctions/${aidB}/generate-transactions`, {
    steps: { invoices: { start: stepOf(planB, 'invoices').suggestedStart || 1, sale: 'L' } },
  });
  check('403, not 200', run.status === 403, `${run.status} ${JSON.stringify(run.d)}`);
  check('…and the message points the operator at the setting',
        run.d && /switched off/i.test(run.d.error || '') && /Features/i.test(run.d.error || ''),
        JSON.stringify(run.d));
  check('no invoice was raised', (await invoiceCount(aidB)) === 0, String(await invoiceCount(aidB)));

  console.log('[on-again] switching it back on restores the run');
  await setFlag('true');
  run = await api('POST', `/api/auctions/${aidB}/generate-transactions`, {
    steps: { invoices: { start: stepOf(planB, 'invoices').suggestedStart || 1, sale: 'L' } },
  });
  check('accepted again', run.status === 200, `${run.status} ${JSON.stringify(run.d).slice(0, 200)}`);
  check('…and the previously-refused trade now has its invoice',
        (await invoiceCount(aidB)) > 0, JSON.stringify(stepOf(run.d, 'invoices')));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', log.slice(-2000)); done(1); });
