// The invoice amount on a lot is the SERVER's to compute.
//
// Price Entry posts { price, amount } with the amount worked out in the
// browser, from the weight it had cached when the screen was opened. That
// screen never auto-refreshes, so when two people work at once — one pricing,
// one correcting a weight on the Lots tab or the phone — the price save wrote
// amount = staleQty x price: a figure matching neither weight, with nothing in
// the request wrong enough to reject.
//
//   [race]     the reported case: weight changes under an open Price Entry,
//              and the next price save must NOT store the stale amount
//   [derive]   amount follows price, and follows qty, from what is stored
//   [exact]    it is UNROUNDED — calculateLot prefers the stored amount and
//              its comment requires it to match what the operator sees
//   [respect]  a request touching neither price nor qty leaves amount alone
//   [wd]       WD / NA still zero out, as they did
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotamt-'));
const PORT = 48161;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', b => { srvLog += b; });
srv.stderr.on('data', b => { srvLog += b; });
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

let T = '';
const api = async (m, u, b) => {
  const r = await fetch(B + u, { method: m,
    headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) },
    body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  await api('PUT', '/api/company-settings', { settings: { br1: 'BODI' } });
  const seller = (await api('POST', '/api/traders', { name: 'AMT SELLER', tel: '9790744431', ppla: 'BODIMETTU' })).d.trader;
  const auc = (await api('POST', '/api/auctions', { ano: '70', date: '2026-10-26', crop_type: 'ISP' })).d;
  await api('POST', `/api/auctions/${auc.id}/allocations`,
    { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  const mkLot = async (no, qty) => {
    await api('POST', '/api/lots', { auction_id: auc.id, lot_no: no, trader_id: seller.id,
      branch: 'BODI', grade: '1', bags: 10, litre: '300', qty,
      sample_wt: 2.95, gross_wt: qty + 2.95 });
    return ((await api('GET', `/api/lots/${auc.id}`)).d || []).find(l => String(l.lot_no) === no);
  };
  const read = async (id) => ((await api('GET', `/api/lots/${auc.id}`)).d || []).find(l => l.id === id);

  console.log('[race] the weight moves under an open Price Entry');
  const lot = await mkLot('001', 500);
  check('fixture: the lot weighs 500', Number(lot.qty) === 500, lot.qty);
  // Someone else corrects the weight on the Lots tab / the phone.
  let r = await api('PUT', `/api/lots/${lot.id}`, { qty: 400 });
  check('the weight is corrected to 400', r.s === 200, r.d);
  // Price Entry, still holding qty=500, now saves a price — and posts the
  // amount it computed from the STALE weight. This is the exact payload
  // pePriceSave sends.
  r = await api('PUT', `/api/lots/${lot.id}`, { price: 3000, amount: 500 * 3000 });
  check('the price save is accepted', r.s === 200, r.d);
  let after = await read(lot.id);
  check('the stale 15,00,000 was NOT stored',
        Number(after.amount) !== 1500000, { amount: after.amount });
  check('…the amount is the stored weight x the price (400 x 3000)',
        Number(after.amount) === 1200000, { qty: after.qty, price: after.price, amount: after.amount });

  console.log('\n[derive] it follows whichever of the two moves');
  const l2 = await mkLot('002', 250);
  await api('PUT', `/api/lots/${l2.id}`, { price: 2000, amount: 999999 });
  let a2 = await read(l2.id);
  check('a price alone derives the amount, ignoring the sent one',
        Number(a2.amount) === 500000, { amount: a2.amount });
  await api('PUT', `/api/lots/${l2.id}`, { qty: 300 });
  a2 = await read(l2.id);
  check('a weight alone re-derives it against the stored price',
        Number(a2.amount) === 600000, { qty: a2.qty, price: a2.price, amount: a2.amount });
  await api('PUT', `/api/lots/${l2.id}`, { qty: 100, price: 1500 });
  a2 = await read(l2.id);
  check('both at once use both new values', Number(a2.amount) === 150000,
        { qty: a2.qty, price: a2.price, amount: a2.amount });

  console.log('\n[exact] it is not re-rounded');
  // 333.333 x 3333.33 = 1111108.88889 — a value that only survives unrounded.
  const l3 = await mkLot('003', 333.333);
  await api('PUT', `/api/lots/${l3.id}`, { price: 3333.33 });
  const a3 = await read(l3.id);
  check('the full precision is kept', Math.abs(Number(a3.amount) - (333.333 * 3333.33)) < 1e-6,
        { amount: a3.amount, expected: 333.333 * 3333.33 });

  console.log('\n[respect] an edit touching neither is left alone');
  const before = await read(l3.id);
  await api('PUT', `/api/lots/${l3.id}`, { moisture: '12' });
  const a4 = await read(l3.id);
  check('amount is unchanged by an unrelated edit',
        Number(a4.amount) === Number(before.amount), { before: before.amount, after: a4.amount });

  console.log('\n[wd] withdrawn still zeroes out');
  const l5 = await mkLot('004', 200);
  await api('PUT', `/api/lots/${l5.id}`, { price: 3000 });
  await api('POST', '/api/lots/bulk-set-buyer', { ids: [l5.id], code: 'WD' });
  const a5 = await read(l5.id);
  check('a WD lot carries no value', Number(a5.amount) === 0 && Number(a5.price) === 0,
        { price: a5.price, amount: a5.amount });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-15).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-1200)); cleanup(); process.exit(1); });
