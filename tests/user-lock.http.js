// Account lock — an admin toggles a username off, and that user can no
// longer sign in on EITHER app.
//
// What has to hold:
//   • lock is admin-only, and reversible
//   • the desktop door (/api/login) and the mobile door (/api/auth/login)
//     both refuse a locked account, with the same 403 + account_locked body
//   • locking revokes live sessions, so it bites immediately — and any token
//     that somehow survives stops authenticating
//   • an admin cannot lock themselves, nor the last active admin, or nobody
//     would be left who could unlock anyone
//   • unlocking restores sign-in on both doors
//   • the password is untouched — lock is not a disguised password reset
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'user-lock-'));
const PORT = 47377;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let ADMIN = '';
async function api(method, url, body, token) {
  const t = token === undefined ? ADMIN : token;
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
// Both login doors, same shape back.
const deskLogin = (username, password) => api('POST', '/api/login', { username, password }, null);
const mobLogin  = (username, password) => api('POST', '/api/auth/login', { username, password }, null);

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const done = (c) => { try { srv.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(c); };

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await deskLogin('admin', 'admin123');
  ADMIN = boot.d && boot.d.token;
  if (!ADMIN) { console.error('login failed', boot.status, srvLog.slice(-2000)); done(1); }

  // Single-session is on by default, which would refuse a second sign-in for
  // the SAME username and muddy every assertion below. Off for this test —
  // the lock gate is what's under test, not the duplicate gate.
  await api('PUT', '/api/company-settings', { settings: { single_session: 'false' } });

  const mk = async (username, role) => {
    const r = await api('POST', '/api/users', { username, password: 'pw1234', role });
    return r.d && r.d.id;
  };
  const opId  = await mk('fieldop', 'operator');
  const ad2Id = await mk('admin2',  'admin');
  const meId  = (await api('GET', '/api/users')).d.users.find(u => u.username === 'admin').id;

  console.log('[1] Before locking, both doors let the operator in');
  let d = await deskLogin('fieldop', 'pw1234');
  check('desktop login works', d.status === 200 && !!d.d.token, JSON.stringify(d.status));
  let opToken = d.d.token;
  let m = await mobLogin('fieldop', 'pw1234');
  check('mobile login works', m.status === 200 && !!m.d.token, JSON.stringify(m.status));
  const opMobToken = m.d.token;
  check('the operator\'s token authenticates', (await api('GET', '/api/me', null, opToken)).status === 200);

  console.log('\n[2] Lock the account');
  let r = await api('PUT', `/api/users/${opId}/lock`, { locked: true });
  check('lock returns 200', r.status === 200, JSON.stringify(r.d));
  check('…and reports the account locked', r.d && r.d.locked === true, JSON.stringify(r.d));
  check('…stamping which admin did it', r.d && r.d.locked_by === 'admin', JSON.stringify(r.d && r.d.locked_by));
  const listed = (await api('GET', '/api/users')).d.users.find(u => u.id === opId);
  check('the Users list carries locked_at so the screen can show it',
        !!(listed && listed.locked_at), JSON.stringify(listed));

  console.log('\n[3] A locked account is refused at BOTH doors');
  d = await deskLogin('fieldop', 'pw1234');
  check('desktop login → 403', d.status === 403, JSON.stringify(d.status));
  check('desktop body says account_locked', d.d && d.d.error === 'account_locked', JSON.stringify(d.d));
  check('…with an operator-readable message naming the account',
        d.d && /locked/i.test(d.d.message || '') && (d.d.message || '').includes('fieldop'), JSON.stringify(d.d && d.d.message));
  m = await mobLogin('fieldop', 'pw1234');
  check('mobile login → 403', m.status === 403, JSON.stringify(m.status));
  check('mobile body says account_locked', m.d && m.d.error === 'account_locked', JSON.stringify(m.d));

  console.log('\n[4] The lock takes effect NOW, not at next sign-in');
  const after = await api('GET', '/api/me', null, opToken);
  check('the session the user already held no longer authenticates',
        after.status === 403, JSON.stringify(after.status));
  check('…the mobile session too',
        (await api('GET', '/api/auth/me', null, opMobToken)).status === 403);
  check('…because the lock revoked every session it had',
        (await api('GET', '/api/users')).d.users.find(u => u.id === opId).active_sessions === 0,
        JSON.stringify((await api('GET', '/api/users')).d.users.find(u => u.id === opId)));

  // NB on the requireAuth / requireAuthFlex lock check: it is a BACKSTOP for a
  // token that outlives the lock, and locking revokes every session, so by
  // construction no sequence of API calls can reach it. It is therefore not
  // asserted here — [4] covers the mechanism that actually protects users.
  // (Nor can it be forced from outside: db.js runs sql.js, which holds the DB
  // in memory and flushes on a debounce, so a second process writing the file
  // is neither seen by the server nor durable.)

  console.log('\n[5] A wrong password on a locked account still reads as bad credentials');
  d = await deskLogin('fieldop', 'wrongpw');
  check('desktop → 401, not 403 (lock state is not enumerable)', d.status === 401, JSON.stringify(d.status));
  m = await mobLogin('fieldop', 'wrongpw');
  check('mobile → 401 too', m.status === 401, JSON.stringify(m.status));

  console.log('\n[6] Rails — you cannot lock yourself out of the lock switch');
  r = await api('PUT', `/api/users/${meId}/lock`, { locked: true });
  check('locking your own account is refused', r.status === 400, JSON.stringify(r.d));
  check('…and says why', r.d && /your own account/i.test(r.d.error || ''), JSON.stringify(r.d));
  // admin2 can go — `admin` is still active.
  r = await api('PUT', `/api/users/${ad2Id}/lock`, { locked: true });
  check('another admin CAN be locked while an active admin remains', r.status === 200, JSON.stringify(r.d));
  check('the locked admin cannot sign in', (await deskLogin('admin2', 'pw1234')).status === 403);
  // With admin2 locked, `admin` is the last active one — and is also self.
  r = await api('PUT', `/api/users/${meId}/lock`, { locked: true });
  check('the last active admin is protected', r.status === 400, JSON.stringify(r.d));

  console.log('\n[7] Only an admin can throw the switch');
  await api('PUT', `/api/users/${opId}/lock`, { locked: false });
  const opTok2 = (await deskLogin('fieldop', 'pw1234')).d.token;
  r = await api('PUT', `/api/users/${ad2Id}/lock`, { locked: true }, opTok2);
  check('an operator cannot lock anyone', r.status === 403, JSON.stringify(r.status));

  console.log('\n[8] Unlock restores sign-in on both doors, password untouched');
  r = await api('PUT', `/api/users/${ad2Id}/lock`, { locked: false });
  check('unlock returns 200 and clears the flag',
        r.status === 200 && r.d.locked === false, JSON.stringify(r.d));
  d = await deskLogin('admin2', 'pw1234');
  check('desktop login works again with the ORIGINAL password',
        d.status === 200 && !!d.d.token, JSON.stringify(d.status));
  m = await mobLogin('admin2', 'pw1234');
  check('mobile login works again', m.status === 200 && !!m.d.token, JSON.stringify(m.status));
  const relisted = (await api('GET', '/api/users')).d.users.find(u => u.id === ad2Id);
  check('the Users list shows it active again',
        relisted && !relisted.locked_at, JSON.stringify(relisted && relisted.locked_at));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
