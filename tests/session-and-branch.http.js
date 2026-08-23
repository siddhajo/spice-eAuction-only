// Concurrent-login control + per-user branch lock — end-to-end HTTP test
// against a live server booted on a throwaway data dir.
//
// Covers:
//   [A] single_session — a second login with the same username is refused
//       409 already_logged_in; the same browser re-authenticating with its
//       own prev_token is not; the block lifts once the session goes idle;
//       an admin can clear it immediately via revoke-sessions; the whole
//       thing can be switched off in settings.
//   [B] admin_login_alert — a second admin signing in gets an inline
//       notice, the admin already online gets a session_alerts row, and
//       acking it drains the inbox.
//   [C] branch — assign / clear a user's home branch, reject unconfigured
//       values, refuse to lock an admin, drop the lock on promotion, and
//       surface it on /api/login, /api/me and the mobile /api/auth/*.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-branch-http-'));
const PORT = 47319;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// Every call takes an explicit token so the test can hold several
// sessions at once (that's the whole point of the feature under test).
async function api(method, url, body, token) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

let ADMIN = '';   // the bootstrap admin's token

async function setSetting(key, val) {
  const r = await api('PUT', '/api/company-settings', { settings: { [key]: String(val) } }, ADMIN);
  if (r.status !== 200) throw new Error(`could not set ${key}: ${r.status} ${JSON.stringify(r.d)}`);
  const back = await api('GET', '/api/company-settings/flat', null, ADMIN);
  const got = back.d && back.d[key];
  if (String(got) !== String(val)) throw new Error(`${key} did not persist: wanted ${val}, got ${got}`);
}

// Section [D] needs to age a session past the idle window without sleeping
// for 15 real minutes, which means reaching into the DB file directly. That
// is only safe with the server stopped: db.js runs on better-sqlite3 where
// available and falls back to sql.js, which holds the whole database in
// memory and flushes on a 200ms debounce — a live edit would be clobbered.
// So: let the flush land, stop the server, patch the file, start it again.
let srv = null, srvLog = '';
function startServer() {
  srv = spawn('node', [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', b => { srvLog += b.toString(); });
  srv.stderr.on('data', b => { srvLog += b.toString(); });
}
async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
}
async function stopServer() {
  await new Promise(r => setTimeout(r, 800));   // let the debounced flush land
  try { srv.kill('SIGKILL'); } catch (_) {}
  await new Promise(r => setTimeout(r, 400));
}

function cleanup() {
  try { srv && srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

startServer();

(async () => {
  await waitForServer();

  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  ADMIN = boot.d && boot.d.token;
  if (!ADMIN) { console.error('login failed', boot.status, boot.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in as bootstrap admin\n');

  // Two branches to assign from.
  await setSetting('br1', 'BODINAYAKANUR');
  await setSetting('br2', 'CUMBUM');

  // Fixtures: one operator, one second admin.
  const mk = async (username, role, branch) => {
    const r = await api('POST', '/api/users', { username, password: 'pw1234', role, branch }, ADMIN);
    if (r.status >= 300) throw new Error(`create ${username} failed: ${r.status} ${JSON.stringify(r.d)}`);
    return r.d.id;
  };
  const opId    = await mk('operator1', 'operator');
  const admin2  = await mk('admin2', 'admin');

  // ══ [A] SINGLE SESSION ═════════════════════════════════════════════
  console.log('[A] single_session — one active login per username');
  await setSetting('single_session', 'true');
  await setSetting('session_idle_minutes', '15');

  const first = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('first login succeeds', first.status === 200 && !!first.d.token,
        `${first.status} ${JSON.stringify(first.d)}`);
  const opTok = first.d.token;

  const second = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('second login is refused 409', second.status === 409, `got ${second.status}`);
  check('refusal is already_logged_in', second.d && second.d.error === 'already_logged_in',
        JSON.stringify(second.d));
  check('message names the user', second.d && /Already operator1 is logged in/.test(second.d.message || ''),
        second.d && second.d.message);

  // A wrong password must not reveal that the account is online — it has
  // to look exactly like any other bad credential.
  const wrongPw = await api('POST', '/api/login', { username: 'operator1', password: 'nope' });
  check('wrong password still 401, not 409', wrongPw.status === 401, `got ${wrongPw.status}`);

  // Same browser re-authenticating with its own live token: allowed.
  const reauth = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234', prev_token: opTok });
  check('re-login with own prev_token succeeds', reauth.status === 200 && !!reauth.d.token,
        `${reauth.status} ${JSON.stringify(reauth.d)}`);
  const opTok2 = reauth.d.token;

  // Someone else's token must not act as a skeleton key.
  const stolen = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234', prev_token: ADMIN });
  check('another user\'s token does not bypass the block', stolen.status === 409, `got ${stolen.status}`);

  // Admin escape hatch.
  const revoked = await api('POST', `/api/users/${opId}/revoke-sessions`, {}, ADMIN);
  check('admin can force sign-out', revoked.status === 200 && revoked.d.revoked >= 1,
        JSON.stringify(revoked.d));
  const afterRevoke = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('login works again after force sign-out', afterRevoke.status === 200, `got ${afterRevoke.status}`);
  check('revoked token is dead', (await api('GET', '/api/me', null, opTok2)).status === 403);

  // A 0/garbage idle window must fall back to the default rather than
  // making every session instantly stale (which would silently switch the
  // whole block off).
  await setSetting('session_idle_minutes', '0');
  const stillBlocked = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('idle window of 0 falls back to the default (still blocks)',
        stillBlocked.status === 409, `got ${stillBlocked.status}`);
  await setSetting('session_idle_minutes', '15');

  // Feature switch.
  await setSetting('single_session', 'false');
  const withFlagOff = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('block lifts when single_session is off', withFlagOff.status === 200, `got ${withFlagOff.status}`);
  await setSetting('single_session', 'true');

  // ══ [B] ADMIN CROSS-NOTIFY ═════════════════════════════════════════
  console.log('\n[B] admin_login_alert — concurrent admins notified both ways');
  await setSetting('admin_login_alert', 'true');

  // The bootstrap admin is already online (ADMIN token, just used above).
  const a2 = await api('POST', '/api/login', { username: 'admin2', password: 'pw1234' });
  check('second admin logs in', a2.status === 200, `${a2.status} ${JSON.stringify(a2.d)}`);
  check('signing-in admin is told about the other', /admin/i.test(a2.d.notice || '') && /"admin"/.test(a2.d.notice || ''),
        JSON.stringify(a2.d.notice));

  const inbox = await api('GET', '/api/session-alerts', null, ADMIN);
  check('already-online admin has an alert queued', inbox.status === 200 && (inbox.d.alerts || []).length === 1,
        JSON.stringify(inbox.d));
  const alert = (inbox.d.alerts || [])[0] || {};
  check('alert names the admin who signed in', alert.actor_username === 'admin2', JSON.stringify(alert));
  check('alert message is user-facing', /admin2/.test(alert.message || ''), alert.message);

  // Sign-out/sign-in cycles must not stack identical banners on the
  // admin who is just sitting there. Re-logging-in mints a NEW token, so
  // carry it forward — the old one is dead and would make the inbox
  // assertions below pass vacuously on a 403.
  await api('POST', `/api/users/${admin2}/revoke-sessions`, {}, ADMIN);
  const a2Repeat = await api('POST', '/api/login', { username: 'admin2', password: 'pw1234' });
  check('repeat login succeeds', a2Repeat.status === 200 && !!a2Repeat.d.token, `got ${a2Repeat.status}`);
  const afterRepeat = await api('GET', '/api/session-alerts', null, ADMIN);
  check('a repeat login does not stack a duplicate alert',
        (afterRepeat.d.alerts || []).length === 1, JSON.stringify(afterRepeat.d));

  const otherInbox = await api('GET', '/api/session-alerts', null, a2Repeat.d.token);
  check('the second admin\'s inbox is readable (token is live)', otherInbox.status === 200,
        `${otherInbox.status} ${JSON.stringify(otherInbox.d)}`);
  check('the admin who signed in gets no row of their own',
        (otherInbox.d.alerts || []).length === 0, JSON.stringify(otherInbox.d));

  await api('POST', `/api/session-alerts/${alert.id}/ack`, {}, ADMIN);
  const drained = await api('GET', '/api/session-alerts', null, ADMIN);
  check('ack drains the inbox', (drained.d.alerts || []).length === 0, JSON.stringify(drained.d));

  // A non-admin signing in must not notify anyone.
  await api('POST', `/api/users/${opId}/revoke-sessions`, {}, ADMIN);
  const opLogin = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('operator login carries no admin notice', !opLogin.d.notice, JSON.stringify(opLogin.d.notice));
  const afterOp = await api('GET', '/api/session-alerts', null, ADMIN);
  check('operator login queues no alert', (afterOp.d.alerts || []).length === 0, JSON.stringify(afterOp.d));

  await setSetting('admin_login_alert', 'false');
  await api('POST', `/api/users/${admin2}/revoke-sessions`, {}, ADMIN);
  const a2again = await api('POST', '/api/login', { username: 'admin2', password: 'pw1234' });
  check('no notice when admin_login_alert is off', !a2again.d.notice, JSON.stringify(a2again.d.notice));
  check('no alert row when admin_login_alert is off',
        ((await api('GET', '/api/session-alerts', null, ADMIN)).d.alerts || []).length === 0);
  await setSetting('admin_login_alert', 'true');

  // ══ [C] BRANCH LOCK ════════════════════════════════════════════════
  console.log('\n[C] per-user branch lock');

  const listed = await api('GET', '/api/users', null, ADMIN);
  check('/api/users returns {users, branches}',
        listed.d && Array.isArray(listed.d.users) && Array.isArray(listed.d.branches),
        JSON.stringify(Object.keys(listed.d || {})));
  check('branch list comes from settings',
        (listed.d.branches || []).join(',') === 'BODINAYAKANUR,CUMBUM',
        JSON.stringify(listed.d.branches));

  const setBr = await api('PUT', `/api/users/${opId}/branch`, { branch: 'cumbum' }, ADMIN);
  check('branch assign succeeds and uppercases', setBr.status === 200 && setBr.d.branch === 'CUMBUM',
        JSON.stringify(setBr.d));

  const badBr = await api('PUT', `/api/users/${opId}/branch`, { branch: 'NOWHERE' }, ADMIN);
  check('unconfigured branch is rejected', badBr.status === 400, `${badBr.status} ${JSON.stringify(badBr.d)}`);

  const adminBr = await api('PUT', `/api/users/${admin2}/branch`, { branch: 'CUMBUM' }, ADMIN);
  check('admins cannot be branch-locked', adminBr.status === 400, `${adminBr.status} ${JSON.stringify(adminBr.d)}`);

  // The lock must reach every surface the clients read.
  await api('POST', `/api/users/${opId}/revoke-sessions`, {}, ADMIN);
  const opFresh = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('/api/login returns the branch', opFresh.d.branch === 'CUMBUM', JSON.stringify(opFresh.d.branch));
  const meOp = await api('GET', '/api/me', null, opFresh.d.token);
  check('/api/me returns the branch', meOp.d.branch === 'CUMBUM', JSON.stringify(meOp.d));
  const usersNow = await api('GET', '/api/users', null, ADMIN);
  check('/api/users row carries the branch',
        (usersNow.d.users || []).find(u => u.id === opId)?.branch === 'CUMBUM');

  // Mobile surface — /api/auth/me is what the PWA reads on resume.
  const authMe = await api('GET', '/api/auth/me', null, opFresh.d.token);
  check('mobile /api/auth/me returns the branch', authMe.d && authMe.d.user && authMe.d.user.branch === 'CUMBUM',
        JSON.stringify(authMe.d));

  // Mobile login is gated by the same rule.
  const mobileDup = await api('POST', '/api/auth/login', { username: 'operator1', password: 'pw1234' });
  check('mobile login honours the single-session block', mobileDup.status === 409,
        `${mobileDup.status} ${JSON.stringify(mobileDup.d)}`);

  // Promotion clears the lock so a later demotion can't silently restore it.
  await api('PUT', `/api/users/${opId}/role`, { role: 'admin' }, ADMIN);
  const promoted = await api('GET', '/api/users', null, ADMIN);
  check('promotion to admin clears the branch',
        (promoted.d.users || []).find(u => u.id === opId)?.branch === '',
        JSON.stringify((promoted.d.users || []).find(u => u.id === opId)));

  // Clearing a lock is just an empty branch.
  await api('PUT', `/api/users/${opId}/role`, { role: 'operator' }, ADMIN);
  await api('PUT', `/api/users/${opId}/branch`, { branch: 'CUMBUM' }, ADMIN);
  const cleared = await api('PUT', `/api/users/${opId}/branch`, { branch: '' }, ADMIN);
  check('empty branch removes the lock', cleared.status === 200 && cleared.d.branch === '',
        JSON.stringify(cleared.d));

  // Create-with-branch, and the admin exception on create.
  await api('POST', '/api/users', { username: 'operator2', password: 'pw1234', role: 'operator', branch: 'BODINAYAKANUR' }, ADMIN);
  const withBr = (await api('GET', '/api/users', null, ADMIN)).d.users.find(u => u.username === 'operator2');
  check('create with branch stores it', withBr && withBr.branch === 'BODINAYAKANUR', JSON.stringify(withBr));
  await api('POST', '/api/users', { username: 'admin3', password: 'pw1234', role: 'admin', branch: 'CUMBUM' }, ADMIN);
  const adminNoBr = (await api('GET', '/api/users', null, ADMIN)).d.users.find(u => u.username === 'admin3');
  check('branch is dropped for a new admin', adminNoBr && adminNoBr.branch === '', JSON.stringify(adminNoBr));
  const badCreate = await api('POST', '/api/users', { username: 'operator3', password: 'pw1234', role: 'operator', branch: 'NOWHERE' }, ADMIN);
  check('create rejects an unconfigured branch', badCreate.status === 400, `${badCreate.status} ${JSON.stringify(badCreate.d)}`);

  // ══ [D] IDLE WINDOW ════════════════════════════════════════════════
  // The safety valve behind the hard block: a browser closed without
  // logging out leaves its session row behind, and that row must stop
  // blocking once it goes quiet — otherwise the user is locked out of
  // their own account for 30 days.
  console.log('\n[D] idle window releases an abandoned session');

  await api('POST', `/api/users/${opId}/revoke-sessions`, {}, ADMIN);
  const abandoned = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('operator holds a session again', abandoned.status === 200, `got ${abandoned.status}`);
  check('and it blocks a second login',
        (await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' })).status === 409);

  // Age that session past the 15-minute window.
  await stopServer();
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(TMP, 'config.db'));
  const before = raw.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(opId).c;
  raw.prepare(
    `UPDATE sessions SET last_used_at = datetime('now','localtime','-45 minutes') WHERE user_id = ?`
  ).run(opId);
  raw.close();
  check('the abandoned session survived the flush to disk', before === 1, `found ${before} rows`);

  startServer();
  await waitForServer();

  const afterIdle = await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' });
  check('a session idle past the window no longer blocks', afterIdle.status === 200,
        `${afterIdle.status} ${JSON.stringify(afterIdle.d)}`);
  // And the freshly-created session blocks again straight away, proving
  // the window is doing the work rather than the check having gone away.
  check('the new session blocks a third login',
        (await api('POST', '/api/login', { username: 'operator1', password: 'pw1234' })).status === 409);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('test crashed:', e, '\n', srvLog.slice(-3000));
  cleanup();
  process.exit(1);
});
