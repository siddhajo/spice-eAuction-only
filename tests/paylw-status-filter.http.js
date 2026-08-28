// Lot-wise Payments — the PAYMENT STATUS filter (paid / advance paid / unpaid).
//
//   [partition] the three buckets cover every matching lot exactly once, and
//               the counts add up to the match — a paid lot that also carries
//               an advance counts as paid, not both
//   [filter]    each value returns exactly its own bucket
//   [combine]   it composes with the seller, lot and bank-account filters
//               instead of overriding them
//   [counts]    the counts describe the WHOLE match, so they don't shrink to
//               the filtered list once a status is chosen
//   [explain]   a lot asked for by number and hidden by this filter says so,
//               rather than being blamed on the bank-account toggle
//   [guard]     an unknown status is rejected, not silently ignored
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-status-'));
const PORT = 47387;
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
const search = (aid, qs) => api('GET', `/api/payments/lots/${aid}?${qs}`);
const lotNos = (d) => ((d && d.lots) || []).map(l => String(l.lot_no)).sort((a, b) => Number(a) - Number(b)).join(',');

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

  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-28', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // RAMU banks with us; SELVAM has no account at all, so his lots are the
  // "unlinked" ones the bank-account filter separates.
  const tr = await api('POST', '/api/traders', { name: 'RAMU', user_id: 'P9001' });
  const ramu = tr.d && (tr.d.id || (tr.d.trader && tr.d.trader.id));
  await api('POST', `/api/traders/${ramu}/banks`,
    { acctnum: '1111222233', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'RAMU', make_default: true });
  const tr2 = await api('POST', '/api/traders', { name: 'SELVAM', user_id: 'P9002' });
  const selvam = tr2.d && (tr2.d.id || (tr2.d.trader && tr2.d.trader.id));

  //   1  RAMU    advance 5000, then PAID   → paid  (the overlap case)
  //   2  RAMU    advance 1200              → advance
  //   3  RAMU    PAID                      → paid
  //   4  RAMU    nothing                   → unpaid
  //   5  SELVAM  advance 800               → advance, and unlinked
  //   6  SELVAM  nothing                   → unpaid, and unlinked
  const idByLot = {};
  for (const [lot_no, name, traderId] of [
    ['1', 'RAMU', ramu], ['2', 'RAMU', ramu], ['3', 'RAMU', ramu], ['4', 'RAMU', ramu],
    ['5', 'SELVAM', selvam], ['6', 'SELVAM', selvam],
  ]) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name, trader_id: traderId, user_id: name === 'RAMU' ? 'P9001' : 'P9002', qty: 100 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    idByLot[lot_no] = id;
    // A buyer code, as a genuinely sold lot carries: without one the
    // missing-lot explainer reports "not auctioned" and never reaches the
    // filter reasons this test is about.
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800, code: 'B1', sale: 'L' });
  }
  await api('POST', `/api/payments/lots/${aid}/advance`, { items: [
    { lotId: idByLot['1'], advance: 5000 },
    { lotId: idByLot['2'], advance: 1200 },
    { lotId: idByLot['5'], advance: 800 },
  ]});
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [idByLot['1'], idByLot['3']] });

  console.log('[partition] the three buckets cover the match exactly once');
  let all = await search(aid, 'link=all&status=all');
  check('all six lots are listed with no status filter', lotNos(all.d) === '1,2,3,4,5,6', lotNos(all.d));
  const c = all.d.statusCounts || {};
  check('counts are paid 2 · advance 2 · unpaid 2',
        c.paid === 2 && c.advance === 2 && c.unpaid === 2, JSON.stringify(c));
  check('…and they add up to the match',
        (c.paid + c.advance + c.unpaid) === all.d.totalMatched, JSON.stringify([c, all.d.totalMatched]));

  console.log('\n[filter] each value returns its own bucket');
  let r = await search(aid, 'link=all&status=paid');
  check('paid → lots 1 and 3', lotNos(r.d) === '1,3', lotNos(r.d));
  check('a lot that was advanced BEFORE being paid counts as paid only',
        (r.d.lots.find(l => String(l.lot_no) === '1') || {}).advance === 5000, JSON.stringify(r.d.lots.map(l => [l.lot_no, l.advance])));
  r = await search(aid, 'link=all&status=advance');
  check('advance → lots 2 and 5, the part-paid ones still owed', lotNos(r.d) === '2,5', lotNos(r.d));
  check('…and none of them is a paid lot',
        (r.d.lots || []).every(l => !l.paid_at), JSON.stringify((r.d.lots || []).map(l => [l.lot_no, l.paid_at])));
  r = await search(aid, 'link=all&status=unpaid');
  check('unpaid → lots 4 and 6, where nothing has moved', lotNos(r.d) === '4,6', lotNos(r.d));
  check('…carrying no advance and no paid stamp',
        (r.d.lots || []).every(l => !l.paid_at && !(Number(l.advance) > 0)), JSON.stringify(r.d.lots.map(l => [l.lot_no, l.advance])));

  console.log('\n[combine] it composes with the other filters');
  r = await search(aid, 'link=all&status=advance&seller=SELVAM');
  check('advance + seller → only SELVAM\'s advanced lot 5', lotNos(r.d) === '5', lotNos(r.d));
  r = await search(aid, 'link=linked&status=advance');
  check('advance + linked drops the seller with no account', lotNos(r.d) === '2', lotNos(r.d));
  r = await search(aid, 'link=unlinked&status=advance');
  check('advance + unlinked keeps only that seller', lotNos(r.d) === '5', lotNos(r.d));
  r = await search(aid, 'link=all&status=unpaid&lots=4,6');
  check('advance + lot numbers narrows to the typed lots', lotNos(r.d) === '4,6', lotNos(r.d));
  r = await search(aid, 'link=all&status=paid&seller=SELVAM');
  check('a combination nothing satisfies returns nothing, not everything',
        lotNos(r.d) === '' && r.d.count === 0, lotNos(r.d));

  console.log('\n[counts] they describe the whole match, not the filtered list');
  r = await search(aid, 'link=all&status=paid');
  const pc = r.d.statusCounts || {};
  check('with paid selected, the counts still read 2/2/2',
        pc.paid === 2 && pc.advance === 2 && pc.unpaid === 2, JSON.stringify(pc));
  check('…while the returned rows are just the two paid ones',
        r.d.count === 2 && r.d.status === 'paid', JSON.stringify([r.d.count, r.d.status]));
  r = await search(aid, 'link=all&status=all&seller=SELVAM');
  const sc = r.d.statusCounts || {};
  check('the counts follow the seller filter, since that IS the match',
        sc.paid === 0 && sc.advance === 1 && sc.unpaid === 1, JSON.stringify(sc));

  console.log('\n[explain] a lot hidden by this filter says so');
  r = await search(aid, 'link=all&status=paid&lots=2');
  const m = (r.d.missing || [])[0] || {};
  check('lot 2 is explained, not silently absent', m.lot === '2', JSON.stringify(r.d.missing));
  check('…blamed on the status filter, not the bank-account toggle',
        m.reason === 'status_filter', JSON.stringify(m));
  check('…and it says which state the lot is actually in',
        m.status === 'advance' && m.wanted === 'paid', JSON.stringify(m));
  // The link toggle must still own its own explanation when IT is the cause.
  r = await search(aid, 'link=linked&status=all&lots=6');
  const m2 = (r.d.missing || [])[0] || {};
  check('a lot hidden by the bank-account filter still reads as link_filter',
        m2.reason === 'link_filter' && m2.linked === false, JSON.stringify(m2));

  console.log('\n[guard] a bad status is rejected');
  const bad = await search(aid, 'link=all&status=part');
  check('unknown status → 400', bad.status === 400, `HTTP ${bad.status}`);
  check('…naming the values it takes', /all.*paid.*advance.*unpaid/i.test(String(bad.d && bad.d.error || '')),
        JSON.stringify(bad.d));
  const omitted = await search(aid, 'link=all');
  check('omitting it defaults to every status', omitted.d.status === 'all' && omitted.d.count === 6,
        JSON.stringify([omitted.d.status, omitted.d.count]));

  console.log('\n[live] the buckets follow the money');
  // Undo lot 2's advance: it must move advance → unpaid.
  await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: idByLot['2'], advance: 0 }] });
  r = await search(aid, 'link=all&status=unpaid');
  check('clearing an advance moves that lot to unpaid', lotNos(r.d) === '2,4,6', lotNos(r.d));
  // Undo lot 3's paid stamp: it must move paid → unpaid (it never had one).
  await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [idByLot['3']] });
  r = await search(aid, 'link=all&status=paid');
  check('undoing a paid stamp takes that lot out of paid', lotNos(r.d) === '1', lotNos(r.d));
  r = await search(aid, 'link=all&status=all');
  const c2 = r.d.statusCounts || {};
  check('the counts follow: paid 1 · advance 1 · unpaid 4',
        c2.paid === 1 && c2.advance === 1 && c2.unpaid === 4, JSON.stringify(c2));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); done(1); });
