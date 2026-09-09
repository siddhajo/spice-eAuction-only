// POST /api/lots/bulk-price — a different price per lot, in ONE request.
//
// Price Entry's Excel import and its Save & Calculate All both used to issue a
// PUT /api/lots/:id per row and await each before sending the next. The server
// work is trivial (~1.6 ms a lot against the real 4.6 MB database), so this
// never looked slow in local testing — but the operator waits N × the network
// round trip, which is 25 seconds for a 169-lot trade on a 150 ms link, and it
// made the server export and rewrite the whole SQLite file once per lot.
//
// This endpoint has to match what the per-lot path wrote, or the import would
// get faster and wrong: amount recomputed, WD/NA lots zeroed through
// calculateLot, the price-check gate cleared, and one audit row per lot with
// its A→B diff intact.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-price-'));
const PORT = 47377;
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
let log = '';
srv.stdout.on('data', b => { log += b.toString(); });
srv.stderr.on('data', b => { log += b.toString(); });
function done(code) {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
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

  const auc = await api('POST', '/api/auctions', { ano: '61', date: '2026-09-09', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const id = {};
  for (const lot_no of ['001', '002', '003', '004', '005']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'SELLER ' + lot_no, qty: 100, grade: '2', bags: 10, branch: 'ANAVILASAM',
    });
    id[lot_no] = r.d.id || (r.d.lot && r.d.lot.id);
  }
  const lotsById = async () => {
    const r = await api('GET', `/api/lots/${aid}`);
    return Object.fromEntries((Array.isArray(r.d) ? r.d : []).map(l => [l.lot_no, l]));
  };

  console.log('[1] A different price per lot, in one call');
  let r = await api('POST', '/api/lots/bulk-price', { items: [
    { id: id['001'], price: 1500 },
    { id: id['002'], price: 2000.5 },
    { id: id['003'], price: 0 },
  ] });
  check('responds 200', r.status === 200, `${r.status} ${JSON.stringify(r.d)}`);
  check('and says it wrote three', r.d && r.d.updated === 3, JSON.stringify(r.d));
  let L = await lotsById();
  check('001 took its own price', Number(L['001'].price) === 1500, JSON.stringify(L['001'].price));
  check('002 took a different one', Number(L['002'].price) === 2000.5, JSON.stringify(L['002'].price));
  check('003 took zero — a real price, not "unset"', Number(L['003'].price) === 0, JSON.stringify(L['003'].price));
  check('004 was not in the batch and is untouched', !(Number(L['004'].price) > 0), JSON.stringify(L['004'].price));

  console.log('\n[2] Amount is derived from the lot\'s own qty, not the caller\'s');
  check('001: 100 kg × 1500', Number(L['001'].amount) === 150000, JSON.stringify(L['001'].amount));
  check('002: 100 kg × 2000.50', Number(L['002'].amount) === 200050, JSON.stringify(L['002'].amount));
  // The per-lot path took the client's own `amount`, so a qty changed by
  // someone else since the grid loaded was written as an amount matching
  // nothing. The server ignores a supplied amount and recomputes.
  await api('PUT', `/api/lots/${id['004']}`, { qty: 250 });
  await api('POST', '/api/lots/bulk-price', { items: [{ id: id['004'], price: 100, amount: 999999 }] });
  L = await lotsById();
  check('a stale amount from the caller is ignored', Number(L['004'].amount) === 25000,
        JSON.stringify([L['004'].qty, L['004'].price, L['004'].amount]));

  console.log('\n[3] A buyer code can ride along with the price');
  r = await api('POST', '/api/lots/bulk-price', { items: [{ id: id['005'], price: 1200, code: 'ABC' }] });
  L = await lotsById();
  check('the code is written', L['005'].code === 'ABC', JSON.stringify(L['005'].code));
  check('with the price', Number(L['005'].price) === 1200, JSON.stringify(L['005'].price));
  // Code alone, no price — the import allows a row that only assigns a buyer.
  await api('POST', '/api/lots/bulk-price', { items: [{ id: id['001'], code: 'XYZ' }] });
  L = await lotsById();
  check('a code-only item leaves the price alone',
        L['001'].code === 'XYZ' && Number(L['001'].price) === 1500,
        JSON.stringify([L['001'].code, L['001'].price]));

  console.log('\n[4] WD / NA zero the lot out, derived figures and all');
  await api('POST', '/api/lots/calculate/' + aid, {});
  L = await lotsById();
  check('002 has a commission to lose before we withdraw it', Number(L['002'].com) > 0,
        JSON.stringify(L['002'].com));
  r = await api('POST', '/api/lots/bulk-price', { items: [{ id: id['002'], price: 5000, code: 'WD' }] });
  check('the write is accepted', r.status === 200, `${r.status} ${JSON.stringify(r.d)}`);
  L = await lotsById();
  check('the price the file carried is overridden to 0', Number(L['002'].price) === 0, JSON.stringify(L['002'].price));
  check('amount goes with it', Number(L['002'].amount) === 0, JSON.stringify(L['002'].amount));
  check('and so does the commission', Number(L['002'].com) === 0, JSON.stringify(L['002'].com));
  check('and the payable', Number(L['002'].balance) === 0, JSON.stringify(L['002'].balance));
  // A lot already coded WD, re-priced without a code, must stay at zero.
  await api('POST', '/api/lots/bulk-price', { items: [{ id: id['002'], price: 7000 }] });
  L = await lotsById();
  check('re-pricing an already-WD lot still zeroes it', Number(L['002'].price) === 0,
        JSON.stringify(L['002'].price));

  console.log('\n[5] The audit trail survives — one row per lot, with its diff');
  const auditRows = async () => {
    const d = (await api('GET', '/api/audit-log?entity=lot&action=edit&limit=200')).d;
    return (d && d.logs) || [];
  };
  const nBefore = (await auditRows()).length;
  await api('POST', '/api/lots/bulk-price', { items: [
    { id: id['003'], price: 111 }, { id: id['004'], price: 222 },
  ] });
  const after = await auditRows();
  check('two more entries, not one summary', after.length - nBefore === 2, `${nBefore} → ${after.length}`);
  const one = after.find(x => {
    let det = x.details; try { det = JSON.parse(det); } catch (_) {}
    return det && String(det.lot_no) === '003';
  });
  check('the entry names the lot', !!one, JSON.stringify(after.slice(0, 2)));
  if (one) {
    let det = one.details; try { det = JSON.parse(det); } catch (_) {}
    const priceChange = (det.changes || []).find(c => c.field === 'price');
    check('and carries the price A→B diff', !!priceChange && Number(priceChange.to) === 111,
          JSON.stringify(det.changes));
  } else { check('and carries the price A→B diff', false, 'no entry found'); }

  console.log('\n[6] Locked lots are skipped, never fatal to the batch');
  await api('PUT', '/api/company-settings', { settings: { flag_lot_lock: 'true' } });
  const lk = await api('POST', '/api/lots/lock', { ids: [id['005']] });
  if (lk.status !== 200) console.log('       (lock endpoint returned ' + lk.status + ' — skipping the lock case)');
  if (lk.status === 200) {
    r = await api('POST', '/api/lots/bulk-price', { items: [
      { id: id['005'], price: 9999 }, { id: id['003'], price: 333 },
    ] });
    check('the batch still succeeds', r.status === 200, `${r.status} ${JSON.stringify(r.d)}`);
    check('it reports the skip', r.d && r.d.skipped_locked === 1, JSON.stringify(r.d));
    L = await lotsById();
    check('the locked lot kept its price', Number(L['005'].price) === 1200, JSON.stringify(L['005'].price));
    check('the unlocked one was written', Number(L['003'].price) === 333, JSON.stringify(L['003'].price));
    await api('POST', '/api/lots/unlock', { ids: [id['005']] });
  }
  await api('PUT', '/api/company-settings', { settings: { flag_lot_lock: 'false' } });

  console.log('\n[7] Bad input is refused before anything is written');
  const priceBefore = (await lotsById())['003'].price;
  for (const [label, body] of [
    ['no items',            { items: [] }],
    ['items missing',       {}],
    ['a non-numeric price', { items: [{ id: id['003'], price: 'abc' }] }],
    ['a negative price',    { items: [{ id: id['003'], price: -5 }] }],
  ]) {
    const bad = await api('POST', '/api/lots/bulk-price', body);
    check(`${label} → 400`, bad.status === 400, `got ${bad.status} ${JSON.stringify(bad.d)}`);
  }
  check('and 003 still holds its last good price',
        Number((await lotsById())['003'].price) === Number(priceBefore),
        JSON.stringify([priceBefore, (await lotsById())['003'].price]));
  // An id from another trade is skipped, not fatal — the file may name lots
  // that have since been deleted.
  const stray = await api('POST', '/api/lots/bulk-price', { items: [
    { id: 999999, price: 100 }, { id: id['003'], price: 444 },
  ] });
  check('a stray id is counted, not fatal', stray.status === 200 && stray.d.skipped_missing === 1,
        JSON.stringify(stray.d));
  check('the real lot in that batch was written',
        Number((await lotsById())['003'].price) === 444);

  console.log('\n[8] It clears the price-check gate, as the per-lot path did');
  // The gate is `auctions.price_checked_at`, stamped only by a clean run of
  // /api/price-check/verify. Drive the real thing: build a sheet whose SERVER
  // PRICE matches what is stored, upload it, then check a bulk price write
  // knocks the stamp back off. This matters — invoice generation is gated on
  // it, so a faster import that quietly left it standing would let a trade be
  // billed on prices nobody re-verified.
  await api('PUT', '/api/company-settings', { settings: { flag_price_check: 'true' } });
  // Every lot needs a price for the sheet below to verify cleanly.
  await api('POST', '/api/lots/bulk-price', { items: Object.values(id).map(x => ({ id: x, price: 1000 })) });
  const ExcelJS = require(path.join(ROOT, 'node_modules/exceljs'));
  const stored = await lotsById();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Check');
  ws.addRow(['LOT', 'SERVER PRICE']);
  for (const k of Object.keys(stored)) ws.addRow([stored[k].lot_no, Number(stored[k].price) || 0]);
  const xlsx = path.join(TMP, 'pricecheck.xlsx');
  await wb.xlsx.writeFile(xlsx);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(xlsx)]), 'pricecheck.xlsx');
  fd.append('auction_id', String(aid));
  const vr = await fetch(B + '/api/price-check/verify', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd,
  });
  const vd = await vr.json().catch(() => ({}));
  let pc = (await api('GET', `/api/auctions/${aid}/price-check-status`)).d;
  check('a clean verify stamps the gate', !!(pc && pc.checked),
        JSON.stringify({ verify: vr.status, gateReady: vd && vd.gateReady, pc }));
  if (pc && pc.checked) {
    await api('POST', '/api/lots/bulk-price', { items: [{ id: id['003'], price: 555 }] });
    pc = (await api('GET', `/api/auctions/${aid}/price-check-status`)).d;
    check('a bulk price write invalidates it', pc.checked === false, JSON.stringify(pc));
    check('…but the "ever verified" stamp survives, so the gate softens rather than resets',
          pc.everChecked === true && pc.stale === true, JSON.stringify(pc));
  }

  console.log('\n[9] Volume: 300 lots in a single request');
  const auc2 = await api('POST', '/api/auctions', { ano: '62', date: '2026-09-09', state: 'TAMIL NADU' });
  const aid2 = auc2.d.id || (auc2.d.auction && auc2.d.auction.id);
  const many = [];
  for (let i = 1; i <= 300; i++) {
    const rr = await api('POST', '/api/lots', {
      auction_id: aid2, lot_no: String(i).padStart(3, '0'), name: 'S' + i, qty: 100,
      grade: '2', bags: 10, branch: 'ANAVILASAM',
    });
    many.push(rr.d.id || (rr.d.lot && rr.d.lot.id));
  }
  const t0 = Date.now();
  const big = await api('POST', '/api/lots/bulk-price', {
    items: many.map((x, i) => ({ id: x, price: 1000 + i })),
  });
  const took = Date.now() - t0;
  check('300 lots written in one call', big.status === 200 && big.d.updated === 300, JSON.stringify(big.d));
  console.log(`       (one request, ${took}ms — the per-lot path was 300 round trips)`);
  const all = (await api('GET', `/api/lots/${aid2}`)).d;
  check('every lot got its own price',
        all.every(l => Number(l.price) === 1000 + (parseInt(l.lot_no, 10) - 1)),
        JSON.stringify(all.slice(0, 3).map(l => [l.lot_no, l.price])));
  check('and its own amount', all.every(l => Number(l.amount) === (Number(l.qty) || 0) * Number(l.price)));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(log.slice(-2500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2500)); done(1); });
