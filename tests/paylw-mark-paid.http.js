// Lot-wise Payments — mark-paid on export. Exported lots get lots.paid_at
// stamped (once), stay visible in the search (badged/locked on the client),
// and are reported so the UI can mark them. End-to-end HTTP test on a
// throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-paid-'));
const PORT = 47339;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const lotsOf = (d) => (d && d.lots) || [];

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', b => log += b); srv.stderr.on('data', b => log += b);
const done = (c) => { try { srv.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(c); };

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, log.slice(-2000)); done(1); }

  const auc = await api('POST', '/api/auctions', { ano: '7', date: '2026-08-10', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const idByLot = {};
  for (const lot_no of ['1', '2', '3']) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'RAMU', qty: 100 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    idByLot[lot_no] = id;
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800 });
  }

  console.log('[1] Fresh search — nothing paid yet');
  let s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  check('3 lots returned', lotsOf(s.d).length === 3, JSON.stringify(lotsOf(s.d).map(l => l.lot_no)));
  check('every lot carries a paid_at field (all null)',
        lotsOf(s.d).every(l => 'paid_at' in l && !l.paid_at),
        JSON.stringify(lotsOf(s.d).map(l => l.paid_at)));

  console.log('\n[2] Mark two lots paid');
  const mk = await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [idByLot['1'], idByLot['2']] });
  check('mark-paid reports 2 newly marked', mk.d && mk.d.marked === 2, JSON.stringify(mk.d));
  check('a paid date was returned', mk.d && /^\d{4}-\d\d-\d\d/.test(String(mk.d.paidAt || '')), JSON.stringify(mk.d && mk.d.paidAt));

  console.log('\n[3] Search still shows all 3 — paid ones just carry paid_at');
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  const byLot = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('paid lots remain in the list (not filtered out)', lotsOf(s.d).length === 3);
  check('lot 1 and 2 have paid_at set', !!byLot['1'].paid_at && !!byLot['2'].paid_at,
        JSON.stringify({ '1': byLot['1'].paid_at, '2': byLot['2'].paid_at }));
  check('lot 3 is still unpaid', !byLot['3'].paid_at);

  console.log('\n[3b] Paid lots are excluded from the bank-payment export');
  // Whole-trade bank export. RAMU has lots 1,2 paid and lot 3 unpaid, so the
  // file must carry ONLY lot 3's payable (9800), not all three (29400).
  const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
  const er = await fetch(B + `/api/exports/bank_payment/${aid}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'xlsx' }),
  });
  check('bank export responds 200', er.status === 200, `got ${er.status}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await er.arrayBuffer()));
  const ws = wb.worksheets[0];
  // Locate the amount column (header contains "AMOUNT"), then sum its numbers.
  let amtCol = null;
  ws.eachRow((row, n) => { if (amtCol) return; row.eachCell((c, ci) => { if (/AMOUNT/i.test(String(c.value || ''))) amtCol = ci; }); });
  let total = 0;
  if (amtCol) ws.eachRow((row) => { const v = row.getCell(amtCol).value; if (typeof v === 'number') total += v; });
  check('export total = only the UNPAID lot 3 payable (9800), paid lots dropped',
        Math.round(total) === 9800, `summed ${total}`);

  console.log('\n[4] Re-marking a paid lot does NOT move its date (stamped once)');
  const firstDate = byLot['1'].paid_at;
  await new Promise(r => setTimeout(r, 1100));   // ensure a different second
  const re = await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [idByLot['1'], idByLot['3']] });
  check('only lot 3 is newly marked (lot 1 already paid)', re.d && re.d.marked === 1, JSON.stringify(re.d));
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  const after = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('lot 1 keeps its ORIGINAL paid date', after['1'].paid_at === firstDate,
        `${after['1'].paid_at} vs ${firstDate}`);
  check('lot 3 is now paid too', !!after['3'].paid_at);

  console.log('\n[5] Guards');
  const empty = await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [] });
  check('empty lotIds → 400', empty.status === 400, `got ${empty.status}`);

  console.log('\n[6] Admin undo — unmark-paid clears paid_at and re-opens the lot');
  // Lots 1,2,3 are all paid by now. Undo lot 2 → it drops paid_at, becomes
  // selectable again, and re-enters the bank export.
  const un = await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [idByLot['2']] });
  check('unmark reports 1 cleared', un.d && un.d.cleared === 1, JSON.stringify(un.d));
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  const un2 = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('lot 2 is unpaid again', !un2['2'].paid_at, JSON.stringify(un2['2'].paid_at));
  check('lots 1 and 3 stay paid', !!un2['1'].paid_at && !!un2['3'].paid_at);

  console.log('\n[6b] Unmarked lot rejoins the bank export');
  const er2 = await fetch(B + `/api/exports/bank_payment/${aid}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'xlsx' }),
  });
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(await er2.arrayBuffer()));
  const ws2 = wb2.worksheets[0];
  let amtCol2 = null;
  ws2.eachRow((row) => { if (amtCol2) return; row.eachCell((c, ci) => { if (/AMOUNT/i.test(String(c.value || ''))) amtCol2 = ci; }); });
  let total2 = 0;
  if (amtCol2) ws2.eachRow((row) => { const v = row.getCell(amtCol2).value; if (typeof v === 'number') total2 += v; });
  check('export now carries only the re-opened lot 2 payable (9800)',
        Math.round(total2) === 9800, `summed ${total2}`);

  console.log('\n[6c] Unmark guards');
  const unEmpty = await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [] });
  check('empty lotIds → 400', unEmpty.status === 400, `got ${unEmpty.status}`);
  const unNoop = await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [idByLot['2']] });
  check('unmarking an already-unpaid lot clears 0 (no-op)', unNoop.d && unNoop.d.cleared === 0, JSON.stringify(unNoop.d));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(log.slice(-2500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2500)); done(1); });
