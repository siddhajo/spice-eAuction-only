// Two or more operators adding sellers at the same moment.
//
// The question this answers — asked on 2026-10-15 — is "will they get a
// unique constraint error?". No: `traders` carries NO unique index at all
// (the only one in the schema is idx_birthday_once). Every uniqueness rule is
// application code, and the rules are not the same for every field:
//
//   name + phone  → folds into the seller already on file (`deduped: true`)
//   user_id       → hard 409, no confirm path
//   GSTIN / PAN   → not checked server-side at all, deliberately (a pooler
//                   split across rows, family on one PAN, the shared "CR."
//                   placeholder)
//
// None of it races, because the duplicate SELECT and the INSERT run in a
// single uninterrupted turn of the event loop: one Node process, sql.js is
// synchronous, and the handler is not async. The parallel cases below are the
// guard on that — they would start creating duplicates the moment somebody
// made the handler async, or ran a second instance.
//
// Also pinned here: WHICH handler serves these paths. mobile-bridge.js owns
// POST and PUT /api/traders, and server.js carried shadowed copies with
// DIFFERENT rules until they were removed. A re-added copy would be
// unreachable and would misdescribe the app to the next reader, so the shape
// of the response is asserted to prove the bridge is the one answering.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'seller-conc-'));
const PORT = 47404;
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

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const done = (c) => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(c);
};

const countSellers = async () => {
  const r = await api('GET', '/api/traders?page=1&pageSize=500');
  const rows = (r.d && (r.d.rows || r.d)) || [];
  return rows.length;
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, srvLog.slice(-2000)); done(1); }

  console.log('Who actually serves these routes');
  const one = await api('POST', '/api/traders', { name: 'ROUTE PROBE', tel: '9500000001' });
  // The bridge answers 201 { trader }; the removed server.js copy answered
  // 200 { success, id }. The shape IS the proof.
  check('POST /api/traders is served by the bridge',
    one.status === 201 && !!(one.d && one.d.trader && one.d.trader.id),
    `${one.status} ${JSON.stringify(one.d).slice(0, 160)}`);
  const upd = await api('PUT', `/api/traders/${one.d.trader.id}`, { name: 'ROUTE PROBE', tel: '9500000002' });
  // Likewise: the bridge returns the updated row, the removed copy did not.
  check('PUT /api/traders/:id is served by the bridge',
    upd.status === 200 && !!(upd.d && upd.d.trader),
    `${upd.status} ${JSON.stringify(upd.d).slice(0, 160)}`);

  console.log('\n[A] twelve operators, twelve different sellers, all at once');
  let before = await countSellers();
  let rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    api('POST', '/api/traders', { name: 'SELLER ' + i, tel: '90000000' + String(i).padStart(2, '0'), cr: 'CR.' + i })));
  const ids = new Set(rs.map(r => r.d && r.d.trader && r.d.trader.id));
  check('all twelve succeed', rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.status)));
  check('…as twelve separate rows', (await countSellers()) - before === 12);
  check('…with twelve distinct ids', ids.size === 12, String(ids.size));

  console.log('\n[B] five operators adding the SAME person simultaneously');
  before = await countSellers();
  rs = await Promise.all(Array.from({ length: 5 }, () =>
    api('POST', '/api/traders', { name: 'RACE SELLER', tel: '9111111111' })));
  check('exactly ONE row is created', (await countSellers()) - before === 1,
    String((await countSellers()) - before));
  check('…and every operator is handed that same seller',
    new Set(rs.map(r => r.d && r.d.trader && r.d.trader.id)).size === 1,
    JSON.stringify(rs.map(r => r.d && r.d.trader && r.d.trader.id)));
  // The four that folded in MUST say so. Without this the UI cannot tell the
  // operator they are now working against somebody else's record — which may
  // carry a different bank account from the one they were about to set up.
  check('…four of them flagged `deduped`, so the UI can say so',
    rs.filter(r => r.d && r.d.deduped).length === 4,
    JSON.stringify(rs.map(r => !!(r.d && r.d.deduped))));

  console.log('\n[C] five operators, one User ID — the single hard-unique field');
  before = await countSellers();
  rs = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    api('POST', '/api/traders', { name: 'UID ' + i, tel: '92222222' + String(i).padStart(2, '0'), user_id: 'U-777' })));
  check('one row created, four refused', (await countSellers()) - before === 1
    && rs.filter(r => r.status === 409).length === 4, JSON.stringify(rs.map(r => r.status)));
  const blocked = rs.find(r => r.status === 409);
  // The message has to name the collision — it is all the operator gets now
  // that the client no longer pre-checks.
  check('…and the refusal names the seller it collides with',
    blocked && /already used by seller/.test(blocked.d.error || ''), JSON.stringify(blocked && blocked.d));

  console.log('\n[D] a shared GSTIN is NOT a duplicate here');
  before = await countSellers();
  rs = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    api('POST', '/api/traders', { name: 'GST FIRM ' + i, tel: '9333333' + String(i).padStart(3, '0'), cr: '33AAAAA0000A1Z5' })));
  check('four rows, no refusal', (await countSellers()) - before === 4
    && rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.status)));

  console.log('\n[E] nothing anywhere raised a constraint');
  check('no SQLITE_CONSTRAINT in the server log',
    !/SQLITE_CONSTRAINT|UNIQUE constraint/.test(srvLog),
    srvLog.slice(-400));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
