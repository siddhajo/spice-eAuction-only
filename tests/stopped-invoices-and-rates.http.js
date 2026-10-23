// Two things the operator asked for, and the rules behind them.
//
//  [A] STOPPED INVOICES. At pricing time the operator often knows a lot must
//      not be billed yet — goods not shipped, a dispute, a buyer asking to
//      wait. Before this the only way to hold one back was to remember not to
//      tick it, which a Generate All run defeats. A stopped lot is skipped by
//      EVERY path that raises an original, and is released from the same
//      screen that stopped it.
//
//      The load-bearing distinction: a stop must never reach a document that
//      already exists. Generation paths exclude stopped lots; re-print paths
//      do not, so stopping a lot cannot retro-edit a raised invoice.
//
//  [B] PER-TRADE RATES. A rate in company_settings is ONE current value, so
//      editing it re-priced closed trades: gunny moved 150 -> 200 between
//      trade 20 and 21, and the two invoices still unraised in trade 20 then
//      billed gunny at 200 while their 90 siblings carried 150. The rate is
//      now pinned to the trade on first generation, and every later build
//      reads the pin.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stoprate-'));
const PORT = 48056;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + JSON.stringify(d) : '')); }
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
  const r = await fetch(B + u, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;

  // ── Fixture: one trade, one buyer, three priced lots ────────────────
  await api('PUT', '/api/company-settings', { settings: { gunny_rate: '150', br1: 'BODI' } });
  await api('POST', '/api/buyers', { buyer: 'B1', code: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
  const auc = await api('POST', '/api/auctions', { ano: '20', date: '2026-10-23', crop_type: 'ISP' });
  const A = auc.d && auc.d.id;
  await api('POST', `/api/auctions/${A}/allocations`, { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '050' }] });
  const seller = (await api('POST', '/api/traders', { name: 'SELLER ONE', tel: '9790744401', ppla: 'BODIMETTU' })).d.trader;
  for (const lot of ['001', '002', '003', '004', '005', '006']) {
    await api('POST', '/api/lots', { auction_id: A, lot_no: lot, trader_id: seller.id, branch: 'BODI',
      grade: '1', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  }
  let lots = (await api('GET', `/api/lots/${A}`)).d || [];
  // Through the Set Buyer Code endpoint, which is what the modal uses — and
  // which also carries the stop flag, so this is the real path.
  await api('POST', '/api/lots/bulk-set-buyer', { ids: lots.map(l => l.id),
    code: 'B1', buyer: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3000 })) });
  await api('POST', `/api/lots/calculate/${A}`, {});
  lots = (await api('GET', `/api/lots/${A}`)).d || [];
  check('fixture: six priced lots', lots.length === 6 && lots.every(l => Number(l.amount) > 0), lots.map(l => l.amount));

  console.log('\n[A1] A lot can be stopped and released');
  const victim = lots[0];
  // Two more are held back purely as FIXTURE stock for [A5], which needs
  // un-invoiced lots to raise a draft over after [A2]/[A3] have billed the
  // rest. They double as proof that a stop survives two generation runs.
  const reserve = [lots[4], lots[5]];
  let r = await api('POST', '/api/lots/bulk-hold', { ids: [victim.id], hold: true });
  check('bulk-hold stops it', r.s === 200 && r.d.updated === 1, r.d);
  await api('POST', '/api/lots/bulk-hold', { ids: reserve.map(l => l.id), hold: true });
  let now = (await api('GET', `/api/lots/${A}`)).d.find(l => l.id === victim.id);
  check('…and the lot carries the flag', Number(now.invoice_hold) === 1, now.invoice_hold);

  console.log('\n[A2] Generate All skips a stopped lot — the point of the feature');
  r = await api('POST', `/api/invoices/generate-all/${A}`, { startInvoiceNo: 1 });
  check('generation succeeds', r.s === 200, { s: r.s, d: r.d });
  console.log('    DEBUG generate-all ->', JSON.stringify(r.d).slice(0, 400));
  const invs = (await api('GET', `/api/invoices?auction_id=${A}`)).d || [];
  const rows = Array.isArray(invs) ? invs : (invs.rows || []);
  check('one invoice was raised for the buyer', rows.length === 1, rows.length);
  check('…covering only the THREE un-stopped lots', Number(rows[0].bag) === 30,
        { bags: rows[0].bag, expected: 30 });
  const stillOpen = (await api('GET', `/api/lots/${A}`)).d.find(l => l.id === victim.id);
  check('…and the stopped lot is still un-invoiced', !String(stillOpen.invo || '').trim(), stillOpen.invo);

  console.log('\n[A3] Releasing it lets the leftover bill normally');
  r = await api('POST', '/api/lots/bulk-hold', { ids: [victim.id], hold: false });
  check('release clears the flag', r.s === 200 && r.d.updated === 1, r.d);
  r = await api('POST', `/api/invoices/generate-all/${A}`, { startInvoiceNo: 2 });
  check('a second run picks the released lot up', r.s === 200, { s: r.s, d: r.d });
  const after = (await api('GET', `/api/invoices?auction_id=${A}`)).d || [];
  const arr = Array.isArray(after) ? after : (after.rows || []);
  check('…as its own invoice of 10 bags', arr.length === 2 && arr.some(i => Number(i.bag) === 10),
        arr.map(i => i.bag));

  console.log('\n[A4] An invoiced lot cannot be stopped');
  const billed = (await api('GET', `/api/lots/${A}`)).d.find(l => String(l.invo || '').trim());
  r = await api('POST', '/api/lots/bulk-hold', { ids: [billed.id], hold: true });
  check('it is refused, and named back', r.s === 200 && r.d.updated === 0 && r.d.skippedInvoiced.length === 1, r.d);

  console.log('\n[A5] A stopped lot on a PROFORMA hides the raise, and refuses it');
  // The shape the operator described: a draft exists, one of its lots is
  // stopped, and the ⬆ must disappear rather than raise a subset.
  await api('PUT', '/api/company-settings', { settings: { flag_proforma_invoice: 'true' } });
  // The two held in reserve are still un-invoiced — released now so a draft
  // can be raised over them.
  await api('POST', '/api/lots/bulk-hold', { ids: reserve.map(l => l.id), hold: false });
  const free = (await api('GET', `/api/lots/${A}`)).d.filter(l => !String(l.invo || '').trim());
  check('the reserved lots survived both runs un-invoiced', free.length === 2, free.length);
  r = await api('POST', `/api/invoices/generate-all/${A}`, { startInvoiceNo: 500, docType: 'proforma' });
  check('a proforma is raised over them', r.s === 200, { s: r.s, d: r.d });
  const draftList = (await api('GET', `/api/invoices?auction_id=${A}&docType=proforma`)).d;
  const drafts = (Array.isArray(draftList) ? draftList : (draftList.rows || [])).filter(i => Number(i.is_proforma) === 1);
  check('…and it is listed as a draft', drafts.length >= 1, drafts.length);

  const draft = drafts[0];
  check('an untouched draft reports no stopped lots', Number(draft.held_lots) === 0, draft.held_lots);

  // Stop ONE lot on that draft.
  const draftLots = (await api('GET', `/api/lots/${A}`)).d
    .filter(l => String(l.proforma_invo || '') === String(draft.invo) && !String(l.invo || '').trim());
  check('the draft has lots behind it', draftLots.length >= 1, draftLots.length);
  await api('POST', '/api/lots/bulk-hold', { ids: [draftLots[0].id], hold: true });

  const relisted = (await api('GET', `/api/invoices?auction_id=${A}&docType=proforma`)).d;
  const draft2 = (Array.isArray(relisted) ? relisted : (relisted.rows || [])).find(i => i.id === draft.id);
  check('the list now reports the stopped lot on that draft', Number(draft2.held_lots) === 1, draft2 && draft2.held_lots);

  // If EVERY remaining lot is stopped, the raise must be refused and say so.
  await api('POST', '/api/lots/bulk-hold', { ids: draftLots.map(l => l.id), hold: true });
  r = await api('POST', `/api/invoices/${draft.id}/raise-original`, {});
  check('raising a fully-stopped draft is refused', r.s === 400, { s: r.s, d: r.d });
  check('…and the message names the stop, not "nothing to ship"',
        /stopped/i.test((r.d && r.d.error) || ''), r.d);

  console.log('\n[B] The gunny rate is pinned to the trade');
  const billedRate = Number(rows[0].gunny) / Number(rows[0].bag);
  check('the trade billed gunny at the rate in force (150)', Math.abs(billedRate - 150) < 0.01, billedRate);

  // The rate moves on for the NEXT trade.
  await api('PUT', '/api/company-settings', { settings: { gunny_rate: '200', flag_proforma_invoice: 'false' } });
  const auc2 = await api('POST', '/api/auctions', { ano: '21', date: '2026-10-24', crop_type: 'ISP' });
  const A2 = auc2.d && auc2.d.id;
  await api('POST', `/api/auctions/${A2}/allocations`, { allocations: [{ branch: 'BODI', start_lot: '051', end_lot: '099' }] });
  await api('POST', '/api/lots', { auction_id: A2, lot_no: '051', trader_id: seller.id, branch: 'BODI',
    grade: '1', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  const l2 = (await api('GET', `/api/lots/${A2}`)).d || [];
  await api('POST', '/api/lots/bulk-set-buyer', { ids: l2.map(l => l.id),
    code: 'B1', buyer: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: l2.map(l => ({ id: l.id, price: 3000 })) });
  await api('POST', `/api/lots/calculate/${A2}`, {});
  await api('POST', `/api/invoices/generate-all/${A2}`, { startInvoiceNo: 90 });
  const t21 = (await api('GET', `/api/invoices?auction_id=${A2}`)).d;
  const r21 = (Array.isArray(t21) ? t21 : (t21.rows || [])).filter(i => Number(i.is_proforma) !== 1);
  check('the NEW trade bills at the new rate (200)',
        r21.length && Math.abs(Number(r21[0].gunny) / Number(r21[0].bag) - 200) < 0.01,
        r21.map(i => Number(i.gunny) / Number(i.bag)));

  // ...and the reported bug: a leftover raised in the OLD trade, afterwards.
  await api('POST', '/api/lots/bulk-hold', { ids: draftLots.map(l => l.id), hold: false });
  r = await api('POST', `/api/invoices/generate-all/${A}`, { startInvoiceNo: 600 });
  check('the leftover generates', r.s === 200, { s: r.s, d: r.d });
  const t20 = (await api('GET', `/api/invoices?auction_id=${A}`)).d;
  const r20 = (Array.isArray(t20) ? t20 : (t20.rows || [])).filter(i => Number(i.is_proforma) !== 1 && Number(i.bag) > 0);
  const rates20 = [...new Set(r20.map(i => Math.round(Number(i.gunny) / Number(i.bag))))];
  check("a leftover raised AFTER the change still bills the trade's own 150",
        rates20.length === 1 && rates20[0] === 150, { ratesSeen: rates20, invoices: r20.length });
  check('…so one trade never carries two gunny rates', rates20.length === 1, rates20);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-1500)); cleanup(); process.exit(1); });
