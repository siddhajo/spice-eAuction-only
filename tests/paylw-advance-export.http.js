// Lot-wise Payments — the ADVANCE bank file, and undoing an advance.
//
//   [export]  /api/exports/bank_payment_advance pays the ADVANCES, in the same
//             RTGS/NEFT layout as the payable file, one line per seller per
//             destination account
//   [route]   the advance is routed to the account it was recorded against,
//             and an account the seller does not own falls back to their
//             default rather than paying a stranger
//   [scope]   lots that carry no advance, and lots already paid out, stay out
//             of the file — their advance has already come off that payment
//   [undo]    clearing an advance (what the row-wise ↩ Undo advance and the
//             bulk "Undo advance" send) puts the money back on the payable and
//             takes the lot out of the advance file
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-advexp-'));
const PORT = 47383;
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

// Read a bank-payment xlsx back as objects keyed by its own header row, so the
// assertions can talk about ACCOUNT / AMOUNT / REMARKS rather than positions.
async function bankSheet(type, aid, body) {
  const r = await fetch(B + `/api/exports/${type}/${aid}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ format: 'xlsx' }, body || {})),
  });
  if (!r.ok) return { status: r.status, rows: [] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0];
  let head = null; const rows = [];
  ws.eachRow((row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (c) => {
      const v = c.value;
      cells.push(v == null ? '' : (typeof v === 'object' && v.result !== undefined ? v.result : v));
    });
    if (!head) { head = cells.map(v => String(v).trim().toUpperCase()); return; }
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = cells[i]; });
    rows.push(o);
  });
  return { status: r.status, rows, head };
}
const amtCol = (head) => head.find(h => /AMOUNT/i.test(h));
const numeric = (rows, col) => rows.filter(r => typeof r[col] === 'number');

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

  // One seller with TWO accounts, four priced lots of 9800 payable each.
  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-28', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const tr = await api('POST', '/api/traders', { name: 'RAMU', user_id: 'P9001' });
  const traderId = tr.d && (tr.d.id || (tr.d.trader && tr.d.trader.id));
  await api('POST', `/api/traders/${traderId}/banks`,
    { acctnum: '1111222233', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'RAMU', make_default: true });
  const bk2 = await api('POST', `/api/traders/${traderId}/banks`,
    { acctnum: '4444555566', ifsc: 'SBIN0009999', bank_name: 'SBI', holder_name: 'RAMU' });
  // The save route answers with the seller's full bank list.
  const bankList = (bk2.d && bk2.d.banks) || [];
  const defBank = bankList.find(b => String(b.acctnum) === '1111222233');
  const altBank = bankList.find(b => String(b.acctnum) === '4444555566');
  check('seller has two accounts on file', !!defBank && !!altBank, JSON.stringify(bankList));

  const idByLot = {};
  for (const lot_no of ['1', '2', '3', '4']) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'RAMU', trader_id: traderId, user_id: 'P9001', qty: 100 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    idByLot[lot_no] = id;
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800 });
  }

  // Lot 1 → the default account, lot 2 → the second account, lot 3 → no
  // account recorded. Lot 4 carries no advance at all.
  const sv = await api('POST', `/api/payments/lots/${aid}/advance`, { items: [
    { lotId: idByLot['1'], advance: 5000,   bankId: defBank.id },
    { lotId: idByLot['2'], advance: 1200.5, bankId: altBank.id },
    { lotId: idByLot['3'], advance: 300,    bankId: null },
  ]});
  check('three advances recorded', sv.d && sv.d.saved === 3, JSON.stringify(sv.d));

  console.log('\n[export] the advance file pays the advances');
  let sheet = await bankSheet('bank_payment_advance', aid, { names: ['RAMU'], lots: { RAMU: ['1', '2', '3', '4'] }, orderBy: 'lot' });
  check('export responds 200', sheet.status === 200, `HTTP ${sheet.status}`);
  const AMT = amtCol(sheet.head || []);
  check('it carries the bank profile\'s own AMOUNT column', !!AMT, (sheet.head || []).join(' | '));
  let money = numeric(sheet.rows, AMT);
  const total = money.reduce((s, r) => s + r[AMT], 0);
  check('total is the advances, not the payable',
        Math.round(total * 100) === 650050, `summed ${total} (expected 6500.50)`);

  console.log('\n[route] one line per destination account');
  // The default profile calls these "BENEFICIARY ACCOUNT" and "SENDER TO
  // RECEIVER INFO"; matched by meaning so a profile change doesn't silently
  // stop asserting.
  const ACC = (sheet.head || []).find(h => /ACCOUNT/i.test(h) && !/DEBIT|TYPE/i.test(h)) || 'BENEFICIARY ACCOUNT';
  const byAcct = {};
  for (const r of money) byAcct[String(r[ACC] || '').trim()] = (byAcct[String(r[ACC] || '').trim()] || 0) + r[AMT];
  // Lot 1 (5000, default account) and lot 3 (300, no account → default) merge
  // into one line; lot 2's 1200.50 is a separate account, so a separate line.
  check('the default account is one line of 5300',
        Math.round((byAcct['1111222233'] || 0) * 100) === 530000, JSON.stringify(byAcct));
  check('the second account is its own line of 1200.50',
        Math.round((byAcct['4444555566'] || 0) * 100) === 120050, JSON.stringify(byAcct));
  check('exactly two payment lines', money.length === 2, `${money.length} lines: ${JSON.stringify(byAcct)}`);

  const REM = (sheet.head || []).find(h => /REMARK|RECEIVER INFO|NARRATION/i.test(h));
  if (REM) {
    check('REMARKS says ADVANCE, so a statement can tell the two files apart',
          money.every(r => /ADVANCE/i.test(String(r[REM] || ''))),
          JSON.stringify(money.map(r => r[REM])));
  } else check('the profile carries a REMARKS column', false, (sheet.head || []).join(' | '));

  console.log('\n[scope] only lots that carry an advance');
  // Lot 4 has none, so picking it alone must produce no payment line at all.
  sheet = await bankSheet('bank_payment_advance', aid, { names: ['RAMU'], lots: { RAMU: ['4'] } });
  check('a lot with no advance exports no line', numeric(sheet.rows, AMT).length === 0,
        JSON.stringify(sheet.rows));

  console.log('\n[route] an account the seller no longer owns falls back');
  // The API refuses to record an advance into a stranger's account at all.
  const other = await api('POST', '/api/traders', { name: 'OTHER SELLER', user_id: 'P9002' });
  const otherId = other.d && (other.d.id || (other.d.trader && other.d.trader.id));
  const ob = await api('POST', `/api/traders/${otherId}/banks`, { acctnum: '9999888877', ifsc: 'ICIC0001234' });
  const obList = (ob.d && ob.d.banks) || [];
  const strangerBank = obList.length ? obList[obList.length - 1].id : null;
  const rejected = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['3'], advance: 300, bankId: strangerBank }] });
  check('recording one into a stranger\'s account is refused', rejected.status === 400, `HTTP ${rejected.status}`);
  // The id can still go stale AFTER the fact: re-saving a seller deletes and
  // reinserts their bank rows (syncTraderBanks), so the id the advance was
  // recorded against no longer exists — and trader_banks ids are recycled, so
  // it may by now belong to someone else entirely. The money must fall back to
  // this seller's own default rather than follow the id.
  const resave = await api('PUT', `/api/traders/${traderId}`, {
    name: 'RAMU', user_id: 'P9001',
    banks: [{ acctnum: '1111222233', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'RAMU', is_default: 1 }],
  });
  check('the seller re-saves with only the default account', resave.status === 200, JSON.stringify(resave.d));
  sheet = await bankSheet('bank_payment_advance', aid, { names: ['RAMU'], lots: { RAMU: ['1', '2', '3'] }, orderBy: 'lot' });
  money = numeric(sheet.rows, AMT);
  const acctTotals = {};
  for (const r of money) acctTotals[String(r[ACC] || '').trim()] = (acctTotals[String(r[ACC] || '').trim()] || 0) + r[AMT];
  check('no account outside this seller\'s own is paid',
        Object.keys(acctTotals).every(a => a === '1111222233'), JSON.stringify(acctTotals));
  check('the whole 6500.50 falls back to their default, as one line',
        money.length === 1 && Math.round((acctTotals['1111222233'] || 0) * 100) === 650050,
        `${money.length} line(s): ${JSON.stringify(acctTotals)}`);

  console.log('\n[scope] a paid-out lot leaves the advance file');
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [idByLot['2']] });
  sheet = await bankSheet('bank_payment_advance', aid, { names: ['RAMU'], lots: { RAMU: ['1', '2', '3'] } });
  money = numeric(sheet.rows, AMT);
  check('its advance is not re-exported once the lot is settled',
        Math.round(money.reduce((s, r) => s + r[AMT], 0) * 100) === 530000,
        JSON.stringify(money.map(r => r[AMT])));
  await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [idByLot['2']] });

  console.log('\n[undo] clearing an advance returns the money to the payable');
  // What the row-wise "↩ Undo advance" sends.
  const undo1 = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['1'], advance: 0 }] });
  check('one lot cleared', undo1.d && undo1.d.cleared === 1 && undo1.d.saved === 0, JSON.stringify(undo1.d));
  let s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  let byLot = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('lot 1 is back to its full payable',
        byLot['1'].advance === 0 && byLot['1'].payable === 9800, JSON.stringify(byLot['1']));
  sheet = await bankSheet('bank_payment_advance', aid, { names: ['RAMU'], lots: { RAMU: ['1', '2', '3'] } });
  money = numeric(sheet.rows, AMT);
  check('and it is gone from the advance file',
        Math.round(money.reduce((s2, r) => s2 + r[AMT], 0) * 100) === 150050,
        `summed ${money.reduce((s2, r) => s2 + r[AMT], 0)} (expected 1500.50)`);

  // What the bulk "↩ Undo advance (n)" sends — every remaining advance at once.
  const undoAll = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: idByLot['2'], advance: 0 }, { lotId: idByLot['3'], advance: 0 }] });
  check('the batch clears both in one call', undoAll.d && undoAll.d.cleared === 2, JSON.stringify(undoAll.d));
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  byLot = Object.fromEntries(lotsOf(s.d).map(l => [l.lot_no, l]));
  check('no lot carries an advance any more',
        lotsOf(s.d).every(l => (Number(l.advance) || 0) === 0),
        JSON.stringify(lotsOf(s.d).map(l => [l.lot_no, l.advance])));
  check('every payable is back to 9800',
        lotsOf(s.d).every(l => l.payable === 9800),
        JSON.stringify(lotsOf(s.d).map(l => [l.lot_no, l.payable])));
  sheet = await bankSheet('bank_payment_advance', aid, { names: ['RAMU'], lots: { RAMU: ['1', '2', '3', '4'] } });
  check('the advance file is now empty', numeric(sheet.rows, AMT).length === 0,
        JSON.stringify(sheet.rows));

  console.log('\n[undo] a settled lot keeps its advance until the paid stamp goes');
  await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: idByLot['4'], advance: 700 }] });
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [idByLot['4']] });
  const onPaid = await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: idByLot['4'], advance: 0 }] });
  check('clearing a paid lot\'s advance is refused', onPaid.status === 400, `HTTP ${onPaid.status}`);
  check('…and the refusal says to undo the paid stamp first',
        /paid/i.test(String(onPaid.d && onPaid.d.error || '')), JSON.stringify(onPaid.d));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); done(1); });
