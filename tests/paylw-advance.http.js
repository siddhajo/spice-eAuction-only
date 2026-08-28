// Lot-wise Payments — Pay Advance. An advance recorded against individual lots
// comes off that lot's Payable in the search, off its line in a lot-picked bank
// export, and off the seller's whole-seller export line too. End-to-end HTTP
// test on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-adv-'));
const PORT = 47341;
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

// Sum the AMOUNT column of a bank-payment xlsx export.
const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
async function bankExportTotal(aid, body) {
  const r = await fetch(B + `/api/exports/bank_payment/${aid}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ format: 'xlsx' }, body || {})),
  });
  if (!r.ok) return { status: r.status, total: NaN };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0];
  let col = null;
  ws.eachRow((row) => { if (col) return; row.eachCell((c, ci) => { if (/AMOUNT/i.test(String(c.value || ''))) col = ci; }); });
  let total = 0;
  if (col) ws.eachRow((row) => { const v = row.getCell(col).value; if (typeof v === 'number') total += v; });
  return { status: r.status, total };
}

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

  // One seller, three priced lots of 9800 payable each (29400 in total).
  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-12', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const tr = await api('POST', '/api/traders', { name: 'RAMU', user_id: 'P9001' });
  const traderId = tr.d && (tr.d.id || (tr.d.trader && tr.d.trader.id));
  const bk = await api('POST', `/api/traders/${traderId}/banks`,
    { acctnum: '1111222233', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'RAMU', make_default: true });
  const bankId = bk.d && Array.isArray(bk.d.banks) && bk.d.banks.length ? bk.d.banks[0].id : null;
  check('seller + default bank created', !!traderId && !!bankId, JSON.stringify({ traderId, bankId }));

  const idByLot = {};
  for (const lot_no of ['1', '2', '3']) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'RAMU', trader_id: traderId, user_id: 'P9001', qty: 100 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    idByLot[lot_no] = id;
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800 });
  }

  console.log('[1] Fresh search — no advances yet');
  let s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  check('3 lots returned', lotsOf(s.d).length === 3);
  check('every lot reports advance 0 and payable = balance',
        lotsOf(s.d).every(l => l.advance === 0 && l.payable === 9800 && l.payable_gross === 9800),
        JSON.stringify(lotsOf(s.d).map(l => [l.lot_no, l.advance, l.payable, l.payable_gross])));

  console.log('\n[2] Pay an advance on two lots');
  const sv = await api('POST', `/api/payments/lots/${aid}/advance`, {
    items: [
      { lotId: idByLot['1'], advance: 5000, bankId },
      { lotId: idByLot['2'], advance: 1200.5, bankId },
    ],
  });
  check('2 saved, 0 cleared', sv.d && sv.d.saved === 2 && sv.d.cleared === 0, JSON.stringify(sv.d));
  check('a paid date was returned', sv.d && /^\d{4}-\d\d-\d\d/.test(String(sv.d.paidAt || '')), JSON.stringify(sv.d && sv.d.paidAt));

  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  let byLot = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('lot 1 payable is net of its 5000 advance',
        byLot['1'].advance === 5000 && byLot['1'].payable === 4800 && byLot['1'].payable_gross === 9800,
        JSON.stringify(byLot['1']));
  check('lot 2 nets the 1200.50 advance',
        byLot['2'].advance === 1200.5 && Math.round(byLot['2'].payable * 100) === 859950,
        JSON.stringify([byLot['2'].advance, byLot['2'].payable]));
  check('lot 3 is untouched', byLot['3'].advance === 0 && byLot['3'].payable === 9800);
  check('the advance records the bank it was paid into',
        byLot['1'].advance_bank_id === bankId, JSON.stringify(byLot['1'].advance_bank_id));
  check('the advance carries a date for the row badge',
        /^\d{4}-\d\d-\d\d/.test(String(byLot['1'].advance_at || '')), JSON.stringify(byLot['1'].advance_at));

  console.log('\n[3] Whole-seller bank export deducts the advances');
  // 29400 gross − 5000 − 1200.50 = 23199.50
  let ex = await bankExportTotal(aid);
  check('export responds 200', ex.status === 200, `got ${ex.status}`);
  check('whole-seller export total is net of both advances',
        Math.round(ex.total * 100) === 2319950, `summed ${ex.total}`);

  console.log('\n[4] Lot-picked export (what the lot-wise screen sends) deducts them too');
  // Picking lots 1 and 2 only: (9800 − 5000) + (9800 − 1200.50) = 13399.50
  ex = await bankExportTotal(aid, { names: ['RAMU'], lots: { RAMU: ['1', '2'] }, orderBy: 'lot' });
  check('lot-picked export total is net of both advances',
        Math.round(ex.total * 100) === 1339950, `summed ${ex.total}`);

  console.log('\n[5] Guards');
  const over = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['3'], advance: 9800.01 }] });
  check('an advance above the lot payable → 400', over.status === 400, `got ${over.status}`);
  check('the rejection names the lot', /lot 3/i.test(String(over.d && over.d.error || '')), JSON.stringify(over.d));

  const foreign = await api('POST', '/api/traders', { name: 'OTHER SELLER', user_id: 'P9002' });
  const otherId = foreign.d && (foreign.d.id || (foreign.d.trader && foreign.d.trader.id));
  const ob = await api('POST', `/api/traders/${otherId}/banks`, { acctnum: '9999888877', ifsc: 'ICIC0001234' });
  const otherBank = ob.d && Array.isArray(ob.d.banks) && ob.d.banks.length ? ob.d.banks[0].id : null;
  const wrongBank = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['3'], advance: 100, bankId: otherBank }] });
  check("another seller's bank account → 400", wrongBank.status === 400, `got ${wrongBank.status}`);

  const empty = await api('POST', `/api/payments/lots/${aid}/advance`, { items: [] });
  check('empty items → 400', empty.status === 400, `got ${empty.status}`);

  const strayTrade = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: 99999, advance: 100 }] });
  check('a lot id from outside the trade → 400', strayTrade.status === 400, `got ${strayTrade.status}`);

  console.log('\n[5b] A rejected batch writes NOTHING — lot 3 stays clean');
  const mixed = await api('POST', `/api/payments/lots/${aid}/advance`, {
    items: [{ lotId: idByLot['3'], advance: 500 }, { lotId: idByLot['1'], advance: 999999 }],
  });
  check('the batch is rejected as a whole', mixed.status === 400, `got ${mixed.status}`);
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  byLot = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('lot 3 got no advance from the rejected batch', byLot['3'].advance === 0, JSON.stringify(byLot['3'].advance));
  check('lot 1 keeps its original 5000', byLot['1'].advance === 5000, JSON.stringify(byLot['1'].advance));

  console.log('\n[6] Re-paying REPLACES rather than adds; 0 clears');
  const again = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['1'], advance: 7000, bankId }] });
  check('re-pay saves 1', again.d && again.d.saved === 1, JSON.stringify(again.d));
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  byLot = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('lot 1 now carries 7000, not 12000', byLot['1'].advance === 7000 && byLot['1'].payable === 2800,
        JSON.stringify([byLot['1'].advance, byLot['1'].payable]));

  const clr = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['2'], advance: 0 }] });
  check('advance 0 clears the row', clr.d && clr.d.cleared === 1 && clr.d.saved === 0, JSON.stringify(clr.d));
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  byLot = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('lot 2 is back to its full payable', byLot['2'].advance === 0 && byLot['2'].payable === 9800,
        JSON.stringify([byLot['2'].advance, byLot['2'].payable]));
  const clrNoop = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['2'], advance: 0 }] });
  check('clearing an already-clear lot is a no-op', clrNoop.d && clrNoop.d.cleared === 0, JSON.stringify(clrNoop.d));

  console.log('\n[7] A lot already paid out cannot take an advance');
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [idByLot['3']] });
  const onPaid = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['3'], advance: 100 }] });
  check('advance on a paid lot → 400', onPaid.status === 400, `got ${onPaid.status}`);
  check('the message points at the paid stamp', /already marked paid/i.test(String(onPaid.d && onPaid.d.error || '')),
        JSON.stringify(onPaid.d));

  console.log('\n[8] The Payments roll-up nets lot advances off the payable too');
  // Lots 1 (7000 advance) and 2 (none) are unpaid; lot 3 is paid out but still
  // counted by the roll-up. 29400 gross − 7000 = 22400.
  const sum = await api('GET', `/api/payments/${aid}`);
  const rows = (sum.d && (sum.d.payments || sum.d.summary || sum.d)) || [];
  const ramu = Array.isArray(rows) ? rows.find(r => String(r.name || '').toUpperCase() === 'RAMU') : null;
  check('the seller row reports the lot advance separately',
        !!ramu && Number(ramu.lot_advance) === 7000, JSON.stringify(ramu && ramu.lot_advance));
  check('total_payable is net of it', !!ramu && Math.round(Number(ramu.total_payable)) === 22400,
        JSON.stringify(ramu && ramu.total_payable));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(log.slice(-2500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2500)); done(1); });
