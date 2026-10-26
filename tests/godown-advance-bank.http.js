// Bank file for the advances paid against STORED STOCK.
//
// The office already had one for a trade's lots ("Export advance" on the
// lot-wise Payments screen). Godown stock is paid the same way and needed the
// same file — but stored stock carries NO TRADE, so the per-trade export could
// not reach it: `getAdvanceBankPaymentData` scopes on
// `la.auction_id = ? AND l.auction_id = ?`, and both are NULL on a godown row.
//
//   [file]    the sheet is the real bank layout — account, IFSC, amount
//   [scope]   it pays godown advances, and ONLY those: a trade's own lot
//             advances must not leak into the godown file, or the bank is
//             told to pay the same money twice
//   [empty]   nothing recorded → an empty file, not a crash
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gdadvbank-'));
const PORT = 48133;
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
const sheetOf = async (type, body) => {
  const r = await fetch(B + `/api/exports/${type}/0`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
    body: JSON.stringify(body) });
  if (r.status !== 200) return { status: r.status, text: (await r.text()).slice(0, 200) };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  return { status: 200, flat: JSON.stringify(wb.worksheets[0].getSheetValues()),
           rows: wb.worksheets[0].rowCount };
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  await api('PUT', '/api/company-settings', { settings: { br1: 'BODI', flag_godown: 'true' } });

  console.log('[empty] nothing recorded yet');
  let s = await sheetOf('bank_payment_advance_godown', { format: 'xlsx' });
  check('an empty godown file is produced, not an error', s.status === 200, s);

  // Two sellers: one with stored stock, one with a trade's lot. Banks ride
  // along on the trader record (syncTraderBanks).
  const mkSeller = (name, tel, acct, ifsc) => api('POST', '/api/traders', {
    name, tel, ppla: 'BODIMETTU',
    banks: [{ acctnum: acct, ifsc, bank_name: 'SBI', branch: 'BODI',
              holder_name: name, is_default: 1 }] });
  const store = (await mkSeller('GODOWN PLANTER', '9790744411', '111122223333', 'SBIN0001234')).d.trader;
  const trade = (await mkSeller('TRADE PLANTER', '9790744412', '999988887777', 'SBIN0009999')).d.trader;
  const bankIdOf = async (id) => {
    const t = (await api('GET', `/api/traders/${id}`)).d;
    const banks = (t && (t.banks || (t.trader && t.trader.banks))) || [];
    return banks.length ? banks[0].id : null;
  };

  // Stored stock — no trade at all.
  await api('POST', '/api/lots', { trader_id: store.id, branch: 'BODI', grade: '1',
    bags: 10, litre: '300', qty: 500, sample_wt: 0, gross_wt: 500, godown: 1 });
  const stock = ((await api('GET', '/api/godown/stock')).d.rows || [])[0];
  check('the godown entry carries no trade', stock && stock.auction_id == null, stock && stock.auction_id);
  let r = await api('POST', '/api/payments/lots/0/advance',
    { items: [{ lotId: stock.id, advance: 25000, bankId: await bankIdOf(store.id) }] });
  check('an advance can be paid on stored stock', r.s === 200, r.d);

  // A trade's own lot, with its own advance — the thing that must NOT leak.
  const auc = await api('POST', '/api/auctions', { ano: '50', date: '2026-10-26', crop_type: 'ISP' });
  const A = auc.d.id;
  await api('POST', `/api/auctions/${A}/allocations`, { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  await api('POST', '/api/lots', { auction_id: A, lot_no: '001', trader_id: trade.id, branch: 'BODI',
    grade: '1', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  const tradeLot = ((await api('GET', `/api/lots/${A}`)).d || []).find(l => String(l.lot_no) === '001');
  r = await api('POST', `/api/payments/lots/${A}/advance`,
    { items: [{ lotId: tradeLot.id, advance: 7777, bankId: await bankIdOf(trade.id) }] });
  check('and on a trade lot, as before', r.s === 200, r.d);

  console.log('\n[file] the godown file is the real bank layout');
  s = await sheetOf('bank_payment_advance_godown', {
    names: ['GODOWN PLANTER'], lots: { 'GODOWN PLANTER': [String(stock.lot_no)] },
    format: 'xlsx', orderBy: 'lot' });
  check('it builds', s.status === 200, s);
  check('it names the seller',      /GODOWN PLANTER/.test(s.flat || ''), s.flat && s.flat.slice(0, 200));
  check('it carries the account',   /111122223333/.test(s.flat || ''));
  check('it carries the IFSC',      /SBIN0001234/.test(s.flat || ''));
  check('it pays the recorded 25000', /25000/.test(s.flat || ''));

  console.log('\n[scope] the two files do not overlap');
  check("the godown file leaves the trade's own advance out",
        !/999988887777/.test(s.flat || '') && !/7777/.test(s.flat || ''), s.flat && s.flat.slice(0, 300));
  const t = await sheetOf('bank_payment_advance', { format: 'xlsx' });
  // The per-trade export is reached on its own route; scope 0 means no trade,
  // so it must find nothing rather than sweeping up the godown advance.
  check('the per-trade file leaves stored stock out',
        t.status !== 200 || !/111122223333/.test(t.flat || ''), t.flat && t.flat.slice(0, 200));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-15).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-1200)); cleanup(); process.exit(1); });
