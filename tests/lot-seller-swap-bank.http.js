// Correcting the seller on a lot must not leave the OLD seller's bank pinned.
//
// `lots.bank_id` pins a lot to one of its seller's accounts. Both seller-swap
// paths — PUT /api/lots/:id and POST /api/lots/bulk-seller — rewrote every
// denormalised seller column but left bank_id alone, so a corrected lot stayed
// pinned to the previous seller's account and the bank-payment file wired that
// seller's money to a stranger. (Real case: four lots corrected to ELAICHIROYAL
// PRIVATE LIMITED kept THAMARASSERIYIL SPICES POINT's account, ₹17.5L.)
//
// End-to-end HTTP test against a live server on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'swapbank-http-'));
const PORT = 47327;
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
  console.log('logged in\n');

  // ── Fixture: two sellers, each with their own account ───────────────
  const auc = await api('POST', '/api/auctions', { ano: '7', date: '2026-08-10', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  if (!aid) { console.error('auction create failed', auc.status, auc.d); cleanup(); process.exit(1); }

  const mkSeller = async (name, acct, ifsc) => {
    const r = await api('POST', '/api/traders', {
      name, cr: '', banks: [{ acctnum: acct, ifsc, holder_name: name, is_default: 1 }],
    });
    return r.d && (r.d.id || (r.d.trader && r.d.trader.id));
  };
  const oldId = await mkSeller('OLD PLANTER',    'OLD-ACCT', 'OLDB0000001');
  const newId = await mkSeller('NEW PLANTER',    'NEW-ACCT', 'NEWB0000001');
  if (!oldId || !newId) { console.error('seller create failed'); cleanup(); process.exit(1); }

  const banksOf = async tid => (await api('GET', `/api/traders/${tid}`)).d;
  const oldBanks = (await banksOf(oldId)).banks || [];
  const newBanks = (await banksOf(newId)).banks || [];
  const oldBankId = oldBanks[0] && oldBanks[0].id;
  const newBankId = newBanks[0] && newBanks[0].id;
  check('fixture: each seller has one account',
        !!oldBankId && !!newBankId && oldBankId !== newBankId,
        `${oldBankId} / ${newBankId}`);

  const mkLot = async (lot_no) => {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, trader_id: oldId, name: 'OLD PLANTER',
      qty: 100, bags: 10, grade: '2', price: 500,
    });
    return r.d && (r.d.id || (r.d.lot && r.d.lot.id));
  };
  const lotA = await mkLot('010');
  const lotB = await mkLot('020');
  const lotC = await mkLot('030');

  // POST /api/lots does not take a price (that arrives from price entry), and
  // the calculate step skips lots with no buyer — so both are set here, or the
  // bank export at the end has nothing to pay and [5] passes vacuously.
  // Sent without trader_id, so this does not count as a seller swap.
  for (const id of [lotA, lotB, lotC]) {
    await api('PUT', `/api/lots/${id}`, { price: 500, code: 'B1' });
  }

  // Pin every lot to the OLD seller's account, the way the Payments picker does.
  const pin = await api('POST', '/api/lots/bulk-bank', { ids: [lotA, lotB, lotC], bank_id: oldBankId });
  check('lots pinned to the old seller\'s account', pin.status === 200, JSON.stringify(pin.d));

  // There is no GET /api/lots/:id — the listing is per auction. Pull the whole
  // trade and pick the row out, so the assertions read what the app really
  // stored rather than a shape this test invented.
  const lotRow = async (lotId) => {
    const r = await api('GET', `/api/lots/${aid}`);
    const arr = Array.isArray(r.d) ? r.d : (r.d && (r.d.lots || r.d.rows)) || [];
    return arr.find(l => Number(l.id) === Number(lotId)) || null;
  };
  const bankIdOf = async (lotId) => { const l = await lotRow(lotId); return l ? l.bank_id : undefined; };
  const traderOf = async (lotId) => { const l = await lotRow(lotId); return l ? l.trader_id : undefined; };
  check('pin took effect — the assertions below are not vacuous',
        (await bankIdOf(lotA)) === oldBankId, String(await bankIdOf(lotA)));

  // ── PUT /api/lots/:id swaps the seller ──────────────────────────────
  console.log('\n[1] PUT /api/lots/:id drops the previous seller\'s pin');
  const put = await api('PUT', `/api/lots/${lotA}`, { trader_id: newId });
  check('request ok', put.status === 200, `${put.status} ${JSON.stringify(put.d)}`);
  check('seller changed', (await traderOf(lotA)) === newId, String(await traderOf(lotA)));
  check('the old seller\'s account is no longer pinned',
        (await bankIdOf(lotA)) == null, String(await bankIdOf(lotA)));

  console.log('\n[2] PUT keeps a pin the NEW seller actually owns');
  const put2 = await api('PUT', `/api/lots/${lotB}`, { trader_id: newId, bank_id: newBankId });
  check('request ok', put2.status === 200, `${put2.status} ${JSON.stringify(put2.d)}`);
  check('the new seller\'s own account survives the swap',
        (await bankIdOf(lotB)) === newBankId, String(await bankIdOf(lotB)));

  // ── POST /api/lots/bulk-seller ──────────────────────────────────────
  console.log('\n[3] bulk-seller drops the previous seller\'s pin');
  const bulk = await api('POST', '/api/lots/bulk-seller', { ids: [lotC], trader_id: newId });
  check('request ok', bulk.status === 200, `${bulk.status} ${JSON.stringify(bulk.d)}`);
  check('seller changed', (await traderOf(lotC)) === newId, String(await traderOf(lotC)));
  check('the old seller\'s account is no longer pinned',
        (await bankIdOf(lotC)) == null, String(await bankIdOf(lotC)));

  console.log('\n[4] bulk-seller is idempotent — re-applying does not wipe a valid pin');
  const repin = await api('POST', '/api/lots/bulk-bank', { ids: [lotC], bank_id: newBankId });
  check('re-pinned to the new seller\'s account', repin.status === 200, JSON.stringify(repin.d));
  const bulkAgain = await api('POST', '/api/lots/bulk-seller', { ids: [lotC], trader_id: newId });
  check('request ok', bulkAgain.status === 200, `${bulkAgain.status} ${JSON.stringify(bulkAgain.d)}`);
  check('the pin the seller owns is kept',
        (await bankIdOf(lotC)) === newBankId, String(await bankIdOf(lotC)));

  // ── The export is the thing that actually matters ───────────────────
  console.log('\n[5] No bank-payment line is addressed to the old seller');
  // getBankPaymentData only pays lots with amount > 0, and amount is derived —
  // so the trade has to be calculated before the export has anything to say.
  const calc = await api('POST', `/api/lots/calculate/${aid}`, {});
  check('trade calculated', calc.status === 200, `${calc.status} ${JSON.stringify(calc.d)}`);
  const pay = await api('GET', `/api/payments/bank/${aid}`);
  const rows = Array.isArray(pay.d) ? pay.d : (pay.d && (pay.d.rows || pay.d.data)) || [];
  check('export returned rows', rows.length > 0, JSON.stringify(pay.d).slice(0, 300));
  check('every lot is paid to the new seller',
        rows.length > 0 && rows.every(r => r.beneficiaryName === 'NEW PLANTER'),
        JSON.stringify(rows.map(r => [r.beneficiaryName, r.accountNo])));
  check('no row pays into the old seller\'s account',
        rows.length > 0 && rows.every(r => r.accountNo !== 'OLD-ACCT'),
        JSON.stringify(rows.map(r => [r.beneficiaryName, r.accountNo])));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
