// An advance is paid to the seller RIGHT AFTER LOT ENTRY — before the auction,
// long before the price import. The lot-wise Payments screen listed only priced
// lots (`l.amount > 0`), so those lots were invisible and the operator was told
// "Not auctioned — booked but never sold, so there is nothing to pay" about a
// lot that simply had not gone under the hammer yet. The Pay Advance endpoint
// refused them a second time with "price it before paying an advance".
//
// A lot awaiting its price is now listed with a zero payable and can carry an
// advance; only 'WD' and 'NA' — the codes that mean it will NEVER pay — are
// refused. An unpriced lot still cannot be marked paid or exported, and an
// advance the eventual price comes in under is reported as `over_advance`
// rather than silently clamped out of sight.
//
// End-to-end HTTP test against a live server on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-unpriced-'));
const PORT = 47361;
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
const lotsOf = (d) => (d && Array.isArray(d.lots)) ? d.lots : [];
const byLotNo = (d) => Object.fromEntries(lotsOf(d).map(l => [String(l.lot_no).replace(/^0+(?=\d)/, ''), l]));

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
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', log.slice(-3000)); done(1); }
  console.log('logged in\n');

  const auc = await api('POST', '/api/auctions', { ano: 901, date: '2026-09-09', crop_type: 'RNS', state: 'KERALA' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const tr = await api('POST', '/api/traders', { name: 'RAMU', user_id: 'P9001' });
  const traderId = tr.d && (tr.d.id || (tr.d.trader && tr.d.trader.id));
  const bk = await api('POST', `/api/traders/${traderId}/banks`,
    { acctnum: '1111222233', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'RAMU', make_default: true });
  const bankId = bk.d && Array.isArray(bk.d.banks) && bk.d.banks.length ? bk.d.banks[0].id : null;

  // The four states a lot can be in on the morning after lot entry.
  const id = {};
  for (const lot_no of ['1', '2', '3', '4']) {
    const r = await api('POST', '/api/lots',
      { auction_id: aid, lot_no, name: 'RAMU', trader_id: traderId, user_id: 'P9001', qty: 100 });
    id[lot_no] = r.d.id || (r.d.lot && r.d.lot.id);
  }
  // 1 — entered, no code, no price: the state an advance is paid in.
  // 2 — priced and payable.
  await api('PUT', `/api/lots/${id['2']}`, { price: 100, amount: 10000, balance: 9800 });
  // 3 — withdrawn, 4 — not auctioned: neither will ever pay.
  await api('PUT', `/api/lots/${id['3']}`, { code: 'WD' });
  await api('PUT', `/api/lots/${id['4']}`, { code: 'NA' });

  console.log('[1] A lot with no price yet is LISTED, ready for an advance');
  let s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  let L = byLotNo(s.d);
  check('the unpriced lot 1 is in the results', !!L['1'], JSON.stringify(Object.keys(L)));
  check('the priced lot 2 is still there', !!L['2']);
  check('WD and NA lots stay out', !L['3'] && !L['4'], JSON.stringify(Object.keys(L)));
  check('lot 1 is flagged unpriced with a zero payable',
        L['1'] && L['1'].unpriced === true && L['1'].payable === 0 && L['1'].payable_gross === 0,
        JSON.stringify(L['1'] && [L['1'].unpriced, L['1'].payable, L['1'].payable_gross]));
  check('the priced lot is NOT flagged unpriced', L['2'] && L['2'].unpriced === false,
        JSON.stringify(L['2'] && L['2'].unpriced));
  check('neither lot starts over-advanced',
        L['1'].over_advance === 0 && L['2'].over_advance === 0);

  console.log('\n[2] "Why isn\'t my lot here?" no longer mislabels an unauctioned lot');
  s = await api('GET', `/api/payments/lots/${aid}?link=all&lots=1,3,4,77`);
  const miss = Object.fromEntries(((s.d && s.d.missing) || []).map(m => [String(m.lot), m.reason]));
  check('lot 1 is not reported missing at all — it is in the results', miss['1'] === undefined,
        JSON.stringify(s.d && s.d.missing));
  check('lot 3 is reported withdrawn', miss['3'] === 'withdrawn', JSON.stringify(miss));
  check('lot 4 is reported not_auctioned', miss['4'] === 'not_auctioned', JSON.stringify(miss));
  check('a lot number that does not exist is still reported missing', miss['77'] === 'missing', JSON.stringify(miss));

  console.log('\n[3] Pay the advance on the unpriced lot');
  const sv = await api('POST', `/api/payments/lots/${aid}/advance`,
    { items: [{ lotId: id['1'], advance: 5000, bankId }] });
  check('the advance is accepted', sv.status === 200 && sv.d && sv.d.saved === 1,
        `${sv.status} ${JSON.stringify(sv.d)}`);
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  L = byLotNo(s.d);
  check('lot 1 carries the 5000', L['1'].advance === 5000, JSON.stringify(L['1'].advance));
  check('its payable stays 0 — there is nothing to net it off yet', L['1'].payable === 0);
  check('it records the account the money went to', L['1'].advance_bank_id === bankId);
  check('it is not called over-advanced while there is no price',
        L['1'].over_advance === 0, JSON.stringify(L['1'].over_advance));
  check('the advance status bucket counts it',
        s.d.statusCounts && s.d.statusCounts.advance === 1, JSON.stringify(s.d.statusCounts));

  console.log('\n[4] An unpriced lot still cannot be PAID OUT');
  const mp = await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [id['1']] });
  check('mark-paid on an unpriced lot → 400', mp.status === 400, `got ${mp.status}`);
  check('the message says why', /not priced yet/i.test(String(mp.d && mp.d.error || '')), JSON.stringify(mp.d));
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  check('it was not stamped paid', !byLotNo(s.d)['1'].paid_at, JSON.stringify(byLotNo(s.d)['1'].paid_at));
  const mpMixed = await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [id['1'], id['2']] });
  check('a batch mixing one unpriced lot is rejected whole', mpMixed.status === 400, `got ${mpMixed.status}`);
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  check('the priced lot in that batch was NOT stamped either', !byLotNo(s.d)['2'].paid_at,
        JSON.stringify(byLotNo(s.d)['2'].paid_at));

  console.log('\n[5] WD / NA lots are still refused an advance');
  const onWd = await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: id['3'], advance: 100 }] });
  check('advance on a withdrawn lot → 400', onWd.status === 400, `got ${onWd.status}`);
  check('the message says withdrawn', /withdrawn/i.test(String(onWd.d && onWd.d.error || '')), JSON.stringify(onWd.d));
  const onNa = await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: id['4'], advance: 100 }] });
  check('advance on a not-auctioned lot → 400', onNa.status === 400, `got ${onNa.status}`);
  check('the message says not auctioned', /not auctioned/i.test(String(onNa.d && onNa.d.error || '')),
        JSON.stringify(onNa.d));

  console.log('\n[6] A PRICED lot is still capped at its payable');
  const over = await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: id['2'], advance: 9800.01 }] });
  check('an advance above a priced lot payable → 400', over.status === 400, `got ${over.status}`);

  console.log('\n[7] The price arrives UNDER the advance — the excess is reported, not hidden');
  await api('PUT', `/api/lots/${id['1']}`, { price: 30, amount: 3000, balance: 3000 });
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  L = byLotNo(s.d);
  check('lot 1 is no longer unpriced', L['1'].unpriced === false);
  check('its payable is floored at 0', L['1'].payable === 0, JSON.stringify(L['1'].payable));
  check('the 2000 overpayment is reported', L['1'].over_advance === 2000, JSON.stringify(L['1'].over_advance));
  check('it can be marked paid now that it is priced',
        (await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [id['1']] })).status === 200);
  await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [id['1']] });

  console.log('\n[8] A price ABOVE the advance nets normally and reports no excess');
  await api('PUT', `/api/lots/${id['1']}`, { price: 90, amount: 9000, balance: 9000 });
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  L = byLotNo(s.d);
  check('payable is gross less the advance', L['1'].payable === 4000 && L['1'].payable_gross === 9000,
        JSON.stringify([L['1'].payable, L['1'].payable_gross]));
  check('nothing is over-advanced', L['1'].over_advance === 0, JSON.stringify(L['1'].over_advance));

  console.log('\n[9] A pre-price advance is netted off the per-seller roll-up that lists unpriced lots');
  // Back to unpriced, advance intact: the roll-up must not lose sight of money
  // already out of the door.
  await api('PUT', `/api/lots/${id['1']}`, { price: 0, amount: 0, balance: 0 });
  s = await api('GET', `/api/payments/lots/${aid}?link=all`);
  check('lot 1 is unpriced again but keeps its advance',
        byLotNo(s.d)['1'].unpriced === true && byLotNo(s.d)['1'].advance === 5000,
        JSON.stringify([byLotNo(s.d)['1'].unpriced, byLotNo(s.d)['1'].advance]));
  const sumU = await api('GET', `/api/payments/${aid}?includeUnpriced=1`);
  const rowsU = (sumU.d && (sumU.d.payments || sumU.d.summary || sumU.d)) || [];
  const ramuU = Array.isArray(rowsU) ? rowsU.find(r => String(r.name || '').toUpperCase() === 'RAMU') : null;
  check('includeUnpriced roll-up reports the pre-price advance',
        !!ramuU && Number(ramuU.lot_advance) === 5000, JSON.stringify(ramuU && ramuU.lot_advance));
  // 9800 (lot 2, the only priced lot) − 5000 already advanced = 4800.
  check('and takes it off the payable', !!ramuU && Math.round(Number(ramuU.total_payable)) === 4800,
        JSON.stringify(ramuU && ramuU.total_payable));

  console.log('\n[10] The advance bank file still pays it');
  const ex = await api('POST', `/api/exports/bank_payment_advance/${aid}`,
    { names: ['RAMU'], lots: { RAMU: ['1'] }, format: 'csv', orderBy: 'lot' });
  check('the advance export responds 200', ex.status === 200 || ex.status === 0, `got ${ex.status}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(log.slice(-2500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2500)); done(1); });
