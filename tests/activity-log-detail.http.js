// App Activity log detail — end-to-end HTTP test against a live server booted
// on a throwaway data dir.
//
// The log used to record "generate · invoice · — · —": true, useless, and
// impossible to trace back to a document. Every assertion here is about the
// row being SPECIFIC — the document number, the party, the trade, the value.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-log-'));
const PORT = 47355;
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
function done(code) {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}

// Pull the app-scoped feed and parse each row's details blob, newest first.
async function feed() {
  const r = await api('GET', '/api/audit-log?scope=app&limit=200');
  return ((r.d && r.d.logs) || []).map(row => {
    let d = {}; try { d = JSON.parse(row.details || '{}'); } catch (_) {}
    return { action: row.action, entity: row.entity, entity_id: row.entity_id, user: row.user_id, d };
  });
}
const find = (rows, action, entity) => rows.find(r => r.action === action && (!entity || r.entity === entity));

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  // ── Fixture: one trade, two buyers, four lots ──────────────────────
  const auc = await api('POST', '/api/auctions', { ano: '7', date: '2026-08-10', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  await api('POST', '/api/buyers', { buyer: 'AK', buyer1: 'MURUGAN TRADERS', pla: 'BODI' });
  await api('POST', '/api/buyers', { buyer: 'BK', buyer1: 'SELVAM & CO', pla: 'CUMBUM' });
  const lotIds = [];
  for (const [lot_no, buyer, qty] of [['1','AK',100],['2','AK',150],['3','BK',200],['4','BK',50]]) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'PLANTER ' + lot_no, qty, grade: '1', bags: 5 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    lotIds.push(id);
    await api('PUT', `/api/lots/${id}`, { buyer, buyer1: buyer, price: 100, amount: qty * 100, bags: 5, sale: 'L' });
  }

  console.log('[A] Single sales-invoice generate');
  const g1 = await api('POST', `/api/invoices/generate/${aid}`,
    { sellerName: 'AK', buyerCode: 'AK', invoiceNo: '1201', saleType: 'L' });
  check('generate succeeded', g1.status === 200, JSON.stringify(g1.d));
  let rows = await feed();
  const gen = find(rows, 'generate', 'invoice');
  check('the generate is logged', !!gen);
  check('it names the invoice number', !!gen && /1201/.test(gen.d.doc || ''), gen && gen.d.doc);
  check('it names the buyer, not just the code',
        !!gen && /MURUGAN TRADERS/.test(gen.d.party || ''), gen && gen.d.party);
  check('it names the trade', !!gen && /#7/.test(gen.d.trade || ''), gen && gen.d.trade);
  check('it records the lot count', !!gen && gen.d.lots === '2', gen && gen.d.lots);
  check('it records which lots', !!gen && /1/.test(gen.d.lot_nos || '') && /2/.test(gen.d.lot_nos || ''),
        gen && gen.d.lot_nos);
  check('it records the quantity', !!gen && /250/.test(gen.d.qty || ''), gen && gen.d.qty);
  check('it records the invoice value', !!gen && /₹/.test(gen.d.value || ''), gen && gen.d.value);
  check('the row points at the invoice it created', !!gen && gen.entity_id > 0, gen && String(gen.entity_id));
  check('the summary line reads as a sentence',
        !!gen && /Generated Invoice 1201/.test(gen.d.summary || '') && /MURUGAN/.test(gen.d.summary || ''),
        gen && gen.d.summary);
  check('the request source is recorded', !!gen && !!gen.d.route, gen && gen.d.route);
  if (gen) console.log('       → ' + gen.d.summary);

  console.log('\n[B] Trade-wide generate-all');
  const gAll = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 1300 });
  check('generate-all succeeded', gAll.status === 200 && gAll.d.generated >= 1, JSON.stringify(gAll.d));
  rows = await feed();
  const bulk = find(rows, 'generate all', 'invoice');
  check('the batch is logged under its own action', !!bulk);
  check('it reports how many documents', !!bulk && Number(bulk.d.count) === gAll.d.generated,
        bulk && `${bulk.d.count} vs ${gAll.d.generated}`);
  check('it reports the numbers handed out', !!bulk && /1300/.test(bulk.d.numbers || ''), bulk && bulk.d.numbers);
  check('it lists each document individually',
        !!bulk && Array.isArray(bulk.d.items) && bulk.d.items.length === gAll.d.generated,
        bulk && JSON.stringify(bulk.d.items));
  check('each listed document names its buyer',
        !!bulk && (bulk.d.items || []).every(i => /SELVAM|MURUGAN/.test(i.party || '')),
        bulk && JSON.stringify((bulk.d.items || []).map(i => i.party)));
  check('it totals the value billed', !!bulk && /₹/.test(bulk.d.value || ''), bulk && bulk.d.value);
  if (bulk) console.log('       → ' + bulk.d.summary);

  console.log('\n[C] Revert');
  const invList = await api('GET', `/api/invoices?auction_id=${aid}`);
  const invRows = (invList.d && (invList.d.rows || invList.d)) || [];
  const target = invRows.find(r => String(r.invo) === '1201');
  const rev = await api('POST', `/api/invoices/${target.id}/revert`, {});
  check('revert succeeded', rev.status === 200, JSON.stringify(rev.d));
  rows = await feed();
  const revLog = find(rows, 'revert', 'invoice');
  check('the revert is logged', !!revLog);
  check('it names the invoice that was pulled back',
        !!revLog && /1201/.test(revLog.d.doc || ''), revLog && revLog.d.doc);
  check('it names the buyer it was raised for',
        !!revLog && /MURUGAN/.test(revLog.d.party || ''), revLog && revLog.d.party);
  check('it reports the lots freed', !!revLog && Number(revLog.d.lots_freed) === 2, revLog && revLog.d.lots_freed);
  if (revLog) console.log('       → ' + revLog.d.summary);

  console.log('\n[D] Master-record edit');
  const bl = await api('GET', '/api/buyers?q=AK');
  const bRows = (bl.d && (bl.d.rows || bl.d)) || [];
  const ak = bRows.find(r => r.buyer === 'AK');
  await api('PUT', `/api/buyers/${ak.id}`, Object.assign({}, ak, { pla: 'THENI' }));
  rows = await feed();
  const edit = find(rows, 'update', 'buyer');
  check('the edit is logged', !!edit);
  check('it names the buyer edited', !!edit && /MURUGAN/.test(edit.d.party || ''), edit && edit.d.party);
  check('it keeps the A→B field diff',
        !!edit && Array.isArray(edit.d.changes) && edit.d.changes.some(c => c.field === 'pla' && /THENI/.test(c.to)),
        edit && JSON.stringify(edit.d.changes));
  check('the summary says how many fields moved',
        !!edit && /field/.test(edit.d.summary || ''), edit && edit.d.summary);
  if (edit) console.log('       → ' + edit.d.summary);

  console.log('\n[E] Payments — advance + mark paid');
  const adv = await api('POST', `/api/payments/${aid}/advance`, { name: 'PLANTER 1', advance: 5000 });
  check('advance saved', adv.status === 200, JSON.stringify(adv.d));
  const mp = await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [lotIds[0], lotIds[1]] });
  check('mark-paid saved', mp.status === 200, JSON.stringify(mp.d));
  rows = await feed();
  const advLog = find(rows, 'pay advance', 'payment');
  const paidLog = find(rows, 'mark paid', 'payment');
  check('the advance is logged (it was not logged at all before)', !!advLog);
  check('it names the seller paid', !!advLog && /PLANTER 1/.test(advLog.d.party || ''), advLog && advLog.d.party);
  check('it records the amount', !!advLog && /5,000/.test(advLog.d.value || ''), advLog && advLog.d.value);
  check('the mark-paid is logged', !!paidLog);
  check('it counts the lots settled', !!paidLog && paidLog.d.lots === '2', paidLog && paidLog.d.lots);
  check('it names whose lots they were',
        !!paidLog && /PLANTER/.test(paidLog.d.sellers || ''), paidLog && paidLog.d.sellers);
  if (advLog) console.log('       → ' + advLog.d.summary);
  if (paidLog) console.log('       → ' + paidLog.d.summary);

  console.log('\n[F] User administration');
  const nu = await api('POST', '/api/users', { username: 'kumar', password: 'secret123', role: 'operator' });
  check('user created', nu.status < 300, JSON.stringify(nu.d));
  const uid = nu.d && (nu.d.id || (nu.d.user && nu.d.user.id));
  const pw = await api('PUT', `/api/users/${uid}/password`, { password: 'another123' });
  check('password reset', pw.status === 200, JSON.stringify(pw.d));
  await api('PUT', `/api/users/${uid}/role`, { role: 'manager' });
  rows = await feed();
  const mk = find(rows, 'create', 'user');
  const pwLog = find(rows, 'password reset', 'user');
  const roleLog = find(rows, 'role change', 'user');
  check('account creation is logged', !!mk && /kumar/.test(mk.d.account || ''), mk && JSON.stringify(mk.d));
  check('password reset is logged as its own action', !!pwLog, pwLog && pwLog.d.summary);
  check('the password itself never reaches the log',
        !/secret123|another123/.test(JSON.stringify(rows)));
  check('role change records the new role', !!roleLog && roleLog.d.role === 'manager',
        roleLog && JSON.stringify(roleLog.d));
  if (roleLog) console.log('       → ' + roleLog.d.summary);

  console.log('\n[G] Settings and whole-table wipes');
  await api('PUT', '/api/company-settings', { settings: { transport: '3.5', insurance: '0.25' } });
  const wipe = await api('DELETE', '/api/bills/delete-all');
  check('wipe accepted', wipe.status === 200, JSON.stringify(wipe.d));
  rows = await feed();
  const setLog = find(rows, 'update', 'settings');
  const wipeLog = rows.find(r => r.action === 'delete' && r.entity === 'bill');
  check('a settings change names the settings that moved',
        !!setLog && /transport/.test(setLog.d.summary || ''), setLog && setLog.d.summary);
  check('a table wipe reports the row count', !!wipeLog && /row/.test(wipeLog.d.summary || ''),
        wipeLog && wipeLog.d.summary);
  check('a table wipe names its rollback snapshot',
        !!wipeLog && /\.db$/.test(wipeLog.d.snapshot || ''), wipeLog && wipeLog.d.snapshot);
  if (setLog) console.log('       → ' + setLog.d.summary);
  if (wipeLog) console.log('       → ' + wipeLog.d.summary);

  console.log('\n[H] Raising an original from a proforma');
  await api('PUT', '/api/company-settings', { settings: { flag_proforma_invoice: 'true' } });
  const l9 = await api('POST', '/api/lots', { auction_id: aid, lot_no: '9', name: 'PLANTER 9', qty: 90, grade: '1', bags: 3 });
  const l9id = l9.d.id || (l9.d.lot && l9.d.lot.id);
  await api('PUT', `/api/lots/${l9id}`, { buyer: 'BK', buyer1: 'BK', price: 100, amount: 9000, bags: 3, sale: 'L' });
  const draft = await api('POST', `/api/invoices/generate/${aid}`,
    { sellerName: 'BK', buyerCode: 'BK', invoiceNo: '77', saleType: 'L', docType: 'proforma' });
  check('proforma draft generated', draft.status === 200, JSON.stringify(draft.d));
  const pfList = await api('GET', `/api/invoices?auction_id=${aid}&docType=proforma`);
  const pfRow = ((pfList.d && (pfList.d.rows || pfList.d)) || []).find(r => String(r.invo) === '77');
  const raised = await api('POST', `/api/invoices/${pfRow.id}/raise-original`, { saleType: 'L' });
  check('original raised from the draft', raised.status === 200, JSON.stringify(raised.d));
  rows = await feed();
  const draftLog = rows.find(r => r.action === 'generate' && /77/.test(r.d.doc || ''));
  const raiseLog = find(rows, 'raise original', 'invoice');
  check('the draft is logged as a proforma, not an original',
        !!draftLog && draftLog.d.kind === 'Proforma', draftLog && JSON.stringify(draftLog.d));
  check('raising an original is logged as its own action', !!raiseLog);
  check('it names the buyer the draft belonged to',
        !!raiseLog && /SELVAM/.test(raiseLog.d.party || ''), raiseLog && raiseLog.d.party);
  check('it records which draft it came from',
        !!raiseLog && String(raiseLog.d.from_proforma) === '77', raiseLog && JSON.stringify(raiseLog.d));
  if (draftLog) console.log('       → ' + draftLog.d.summary);
  if (raiseLog) console.log('       → ' + raiseLog.d.summary);

  console.log('\n[I] Every app-scoped row is self-describing');
  rows = await feed();
  const bare = rows.filter(r => !r.d.summary);
  check('no row is left without a summary', bare.length === 0,
        JSON.stringify(bare.map(r => ({ a: r.action, e: r.entity, d: r.d })).slice(0, 5)));
  check('the feed has rows for every module touched',
        new Set(rows.map(r => r.entity)).size >= 5,
        JSON.stringify([...new Set(rows.map(r => r.entity))]));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(srvLog.slice(-1500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
