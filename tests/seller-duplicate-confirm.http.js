// Sellers may share a PAN (family members on one PAN, a pooler split across
// several seller rows) — editing either of them used to be impossible: every
// create/update path hard-blocked on a duplicate PAN, so an operator couldn't
// even fix a phone number on the second row.
//
// New rule: USER ID is the only field that must be unique. GSTIN / PAN /
// (name + phone) collisions answer 409 + confirmable:true once, and go through
// when the client re-sends with confirm_duplicate.
//
// End-to-end HTTP test against a live server on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'seller-dup-http-'));
const PORT = 47431;
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

function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const PAN = 'AAAPZ1234C';

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in\n');

  const idOf = (d) => (d && (d.id || (d.trader && d.trader.id))) || null;

  console.log('— create two sellers sharing one PAN —');
  const a = await api('POST', '/api/traders', { name: 'PAN SHARER ONE', pan: PAN, tel: '9000000001', user_id: 'S9001' });
  const idA = idOf(a.d);
  check('first seller created', a.status < 300 && idA, `${a.status} ${JSON.stringify(a.d)}`);

  const b1 = await api('POST', '/api/traders', { name: 'PAN SHARER TWO', pan: PAN, tel: '9000000002', user_id: 'S9002' });
  // The bridge (which owns this route when mounted) never blocks on PAN; the
  // native fallback answers 409 + confirmable. Both are acceptable — what must
  // NOT happen is an unconfirmable block.
  check('second seller w/ same PAN is not hard-blocked',
    b1.status < 300 || (b1.status === 409 && b1.d && b1.d.confirmable),
    `${b1.status} ${JSON.stringify(b1.d)}`);

  let idB = idOf(b1.d);
  if (!idB) {
    const b2 = await api('POST', '/api/traders', { name: 'PAN SHARER TWO', pan: PAN, tel: '9000000002', user_id: 'S9002', confirm_duplicate: true });
    idB = idOf(b2.d);
    check('confirm_duplicate lets the second seller through', b2.status < 300 && idB, `${b2.status} ${JSON.stringify(b2.d)}`);
  }

  console.log('\n— edit either seller while the PAN is shared (the reported bug) —');
  const e1 = await api('PUT', `/api/traders/${idA}`, {
    name: 'PAN SHARER ONE', pan: PAN, tel: '9111111111', user_id: 'S9001', confirm_duplicate: true,
  });
  check('edit of seller A saves', e1.status < 300, `${e1.status} ${JSON.stringify(e1.d)}`);

  const e2 = await api('PUT', `/api/traders/${idB}`, {
    name: 'PAN SHARER TWO', pan: PAN, tel: '9222222222', user_id: 'S9002', confirm_duplicate: true,
  });
  check('edit of seller B saves', e2.status < 300, `${e2.status} ${JSON.stringify(e2.d)}`);

  const after = await api('GET', `/api/traders/${idA}`);
  check('seller A phone actually changed', after.d && String(after.d.tel) === '9111111111',
    JSON.stringify(after.d && { tel: after.d.tel, pan: after.d.pan }));
  check('seller A keeps the shared PAN', after.d && String(after.d.pan || '').toUpperCase() === PAN,
    JSON.stringify(after.d && { pan: after.d.pan }));

  console.log('\n— USER ID stays hard-unique (no confirm path) —');
  const clash = await api('PUT', `/api/traders/${idB}`, {
    name: 'PAN SHARER TWO', pan: PAN, tel: '9222222222', user_id: 'S9001', confirm_duplicate: true,
  });
  check('duplicate User ID rejected even WITH confirm_duplicate', clash.status === 409,
    `${clash.status} ${JSON.stringify(clash.d)}`);
  check('rejection names the User ID', clash.d && /user id/i.test(clash.d.error || ''),
    JSON.stringify(clash.d));

  const clashCreate = await api('POST', '/api/traders', {
    name: 'THIRD PARTY', pan: 'BBBPZ9999C', tel: '9333333333', user_id: 'S9001', confirm_duplicate: true,
  });
  check('duplicate User ID rejected on create too', clashCreate.status === 409,
    `${clashCreate.status} ${JSON.stringify(clashCreate.d)}`);

  const stillB = await api('GET', `/api/traders/${idB}`);
  check('seller B user_id unchanged after the rejected edit',
    stillB.d && String(stillB.d.user_id) === 'S9002', JSON.stringify(stillB.d && { user_id: stillB.d.user_id }));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
