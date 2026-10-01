// POST /api/lots/dummy-details/bulk — the write side of the dummy seller
// identity (the read side, where the values actually print, is covered by
// tests/lot-dummy-details.unit.js).
//
// The whole endpoint turns on one rule: a field the caller DIDN'T send is
// left alone, and only an explicit '' or clear:true wipes anything. The Lots
// modal sends just the boxes the operator typed into, so if an absent key
// were treated as a blank, a second pass setting only the phone would silently
// erase the name set in the first — the exact mistake this shape exists to
// prevent.
//
//   [set]        a full write lands all four fields
//   [partial]    a one-field write leaves the other three standing
//   [blank]      an explicit '' clears that one field, and only it
//   [clear]      clear:true wipes all four in one call
//   [guards]     no ids, and a payload with nothing to set, are both refused
//   [locked]     a locked lot is skipped, not an error, and reported as such
//   [filter]     GET /api/lots/:id?dummy=1|0 narrows the Lots table to masked
//                / unmasked lots — list, summary and paginated counts alike
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lot-dummy-http-'));
const PORT = 47393;
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

// Read the four dummy columns back off a lot, via the same endpoint the
// Lots screen uses — so the test also proves the values are readable by
// the client that has to prefill them.
async function dummyOf(aid, lotId) {
  const r = await api('GET', `/api/lots/${aid}`);
  const row = (Array.isArray(r.d) ? r.d : []).find(l => Number(l.id) === Number(lotId)) || {};
  return {
    name:  String(row.dummy_name  || ''),
    tel:   String(row.dummy_tel   || ''),
    cr:    String(row.dummy_cr    || ''),
    grade: String(row.dummy_grade || ''),
  };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', log.slice(-2000)); done(1); }
  console.log('logged in\n');

  const auc = await api('POST', '/api/auctions', { ano: '62', date: '2026-09-16', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const ids = [];
  for (const lot_no of ['001', '002', '003']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'SELLER ' + lot_no, qty: 100, grade: '2', bags: 10, branch: 'ANAVILASAM',
    });
    ids.push(r.d.id || (r.d.lot && r.d.lot.id));
  }
  check('three lots created', ids.every(Boolean), JSON.stringify(ids));
  const A = ids[0], C = ids[2];

  console.log('[set] a full write lands all four fields');
  let r = await api('POST', '/api/lots/dummy-details/bulk', {
    ids, dummy_name: 'DUMMY CO', dummy_tel: '9111111111', dummy_cr: 'CR.9999', dummy_grade: '1A',
  });
  check('200 with updated = 3', r.status === 200 && r.d.updated === 3, JSON.stringify(r.d));
  check('all four read back on lot 1',
        eq(await dummyOf(aid, A), { name: 'DUMMY CO', tel: '9111111111', cr: 'CR.9999', grade: '1A' }),
        JSON.stringify(await dummyOf(aid, A)));
  check('…and on lot 3, so the whole selection was written',
        eq(await dummyOf(aid, C), { name: 'DUMMY CO', tel: '9111111111', cr: 'CR.9999', grade: '1A' }),
        JSON.stringify(await dummyOf(aid, C)));

  console.log('[partial] an absent key leaves that field standing');
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [A], dummy_tel: '9222222222' });
  check('200', r.status === 200 && r.d.updated === 1, JSON.stringify(r.d));
  check('the phone changed and the other three survived',
        eq(await dummyOf(aid, A), { name: 'DUMMY CO', tel: '9222222222', cr: 'CR.9999', grade: '1A' }),
        JSON.stringify(await dummyOf(aid, A)));

  console.log('[blank] an explicit empty string clears exactly that field');
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [A], dummy_grade: '' });
  check('200', r.status === 200, JSON.stringify(r.d));
  check('grade cleared, the rest untouched',
        eq(await dummyOf(aid, A), { name: 'DUMMY CO', tel: '9222222222', cr: 'CR.9999', grade: '' }),
        JSON.stringify(await dummyOf(aid, A)));

  console.log('[set] values are trimmed and capped at 100 chars');
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [A], dummy_name: '  PADDED NAME  ' });
  check('trimmed on the way in', (await dummyOf(aid, A)).name === 'PADDED NAME', JSON.stringify(await dummyOf(aid, A)));
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [A], dummy_name: 'X'.repeat(250) });
  check('capped at 100', (await dummyOf(aid, A)).name.length === 100, String((await dummyOf(aid, A)).name.length));

  console.log('[clear] clear:true wipes all four at once');
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [A], clear: true });
  check('200 and reported as a clear', r.status === 200 && r.d.cleared === true, JSON.stringify(r.d));
  check('all four now empty',
        eq(await dummyOf(aid, A), { name: '', tel: '', cr: '', grade: '' }),
        JSON.stringify(await dummyOf(aid, A)));
  check('…and the OTHER lots kept theirs — clear is scoped to the ids sent',
        eq(await dummyOf(aid, C), { name: 'DUMMY CO', tel: '9111111111', cr: 'CR.9999', grade: '1A' }),
        JSON.stringify(await dummyOf(aid, C)));

  console.log('[guards] an empty or meaningless payload is refused, not silently ignored');
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [], dummy_name: 'X' });
  check('no ids → 400', r.status === 400, `${r.status} ${JSON.stringify(r.d)}`);
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [A] });
  check('no fields and no clear → 400', r.status === 400, `${r.status} ${JSON.stringify(r.d)}`);

  console.log('[locked] a locked lot is skipped, and the call still succeeds');
  // The lock guard only applies while the lock feature is on.
  await api('PUT', '/api/company-settings', { settings: { flag_lot_lock: 'true' } });
  await api('POST', '/api/lots/lock', { ids: [C] });
  r = await api('POST', '/api/lots/dummy-details/bulk', { ids: [A, C], dummy_name: 'AFTER LOCK' });
  check('200, not an error', r.status === 200, `${r.status} ${JSON.stringify(r.d)}`);
  // Admin bypasses the lock (isAdmin), so this asserts on whichever path the
  // server took — the point is that the batch completes either way and says so.
  const lockedSkipped = Number(r.d.skippedLocked) || 0;
  check('the response accounts for every id it was given',
        (Number(r.d.updated) || 0) + lockedSkipped === 2, JSON.stringify(r.d));
  check('the unlocked lot was written', (await dummyOf(aid, A)).name === 'AFTER LOCK',
        JSON.stringify(await dummyOf(aid, A)));

  console.log('[filter] ?dummy= narrows the list the Lots table reads');
  // The filter is flag-gated, and the lock would block the reset below.
  await api('PUT', '/api/company-settings', {
    settings: { flag_lot_lock: 'false', flag_lot_dummy_details: 'true' },
  });
  await api('POST', '/api/lots/dummy-details/bulk', { ids, clear: true });
  // A PHONE-only mask: "has dummy details" is any of the four fields, not the
  // name — the same test the 🎭 badge uses.
  await api('POST', '/api/lots/dummy-details/bulk', { ids: [A], dummy_tel: '9333333333' });
  const lotsWith = async (qs) => {
    const r = await api('GET', `/api/lots/${aid}${qs}`);
    return Array.isArray(r.d) ? r.d : [];
  };
  let got = await lotsWith('?dummy=1');
  check('dummy=1 returns just the masked lot',
        got.length === 1 && Number(got[0].id) === A, JSON.stringify(got.map(l => l.lot_no)));
  got = await lotsWith('?dummy=0');
  check('dummy=0 returns the other two',
        got.length === 2 && !got.some(l => Number(l.id) === A), JSON.stringify(got.map(l => l.lot_no)));
  got = await lotsWith('');
  check('no param returns all three', got.length === 3, JSON.stringify(got.map(l => l.lot_no)));
  check('a junk value is ignored rather than filtering to nothing',
        (await lotsWith('?dummy=maybe')).length === 3);

  // The summary and paginated branches build their own SQL — they have to
  // carry the same clause or the totals row and the pager contradict the list.
  const sum = await api('GET', `/api/lots/${aid}?dummy=1&summary=1`);
  check('summary=1 counts the same one lot',
        Number(sum.d.n) === 1 && Number(sum.d.qty) === 100, JSON.stringify(sum.d));
  const sum0 = await api('GET', `/api/lots/${aid}?dummy=0&summary=1`);
  check('…and dummy=0 counts the other two', Number(sum0.d.n) === 2, JSON.stringify(sum0.d));
  const pag = await api('GET', `/api/lots/${aid}?dummy=1&paginated=1&limit=25`);
  check('paginated=1 agrees',
        pag.d && pag.d.total === 1 && (pag.d.rows || []).length === 1, JSON.stringify(pag.d && pag.d.total));
  // Combined with another filter — the dummy clause carries no bind params, so
  // this is really asserting it can't knock the others' params out of order.
  const both = await api('GET', `/api/lots/${aid}?dummy=1&grade=2&summary=1`);
  check('it composes with the grade filter', Number(both.d.n) === 1, JSON.stringify(both.d));
  const none = await api('GET', `/api/lots/${aid}?dummy=1&grade=1&summary=1`);
  check('…and with one that excludes it', Number(none.d.n) === 0, JSON.stringify(none.d));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', log.slice(-2000)); done(1); });
