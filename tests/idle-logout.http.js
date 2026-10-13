// Auto sign-out on inactivity (auto_logout_minutes) — the server half.
//
// The trap this feature has to avoid: the app polls in the background every
// few seconds, so "last request" is fresh all day on a screen nobody is
// sitting at. Idle is therefore measured against last_active_at — what the
// CLIENT reports as real interaction (mouse, key, touch, tab focus) — and the
// background traffic deliberately does not touch it.
//
// The window is read as a NUMBER so a sub-minute setting works; these tests
// use 0.05 (3 seconds) so the real clock can be waited out in a few seconds
// rather than minutes. Nothing about the mechanism differs at 15 minutes.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-'));
const PORT = 47392;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + JSON.stringify(detail) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let TOKEN = '';
async function api(method, url, body, token) {
  const t = token === undefined ? TOKEN : token;
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
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

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await sleep(250);
  }
  let login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' }, '');
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  console.log('[1] Off by default — an install that never asked for it is untouched');
  let r = await api('GET', '/api/me');
  check('a fresh session works', r.status === 200, r.d);
  await sleep(1500);
  r = await api('GET', '/api/me');
  check('…and keeps working with no window set', r.status === 200, r.d);
  r = await api('POST', '/api/session/activity');
  check('the heartbeat endpoint answers, reporting the window', r.status === 200 && r.d.auto_logout_minutes === 0, r.d);

  console.log('\n[2] With a window set, POLLING ALONE does not keep a session alive');
  // This is the whole point. /api/me every second is exactly what the app's
  // background polls look like, and it must not count as a person being there.
  await api('PUT', '/api/company-settings', { settings: { auto_logout_minutes: '0.05' } });  // 3 seconds
  r = await api('GET', '/api/me');
  check('the session still works immediately after the setting changes', r.status === 200, r.d);
  let polled = 0, expiredAt = null;
  for (let i = 0; i < 8; i++) {
    await sleep(900);
    const p = await api('GET', '/api/me');
    polled++;
    if (p.status === 401) { expiredAt = { poll: polled, body: p.d }; break; }
  }
  check('the session is signed out despite constant polling', !!expiredAt, { polled });
  check('…and says why, in words an operator can read',
        expiredAt && expiredAt.body.code === 'idle_logout' && /3 seconds of inactivity/.test(expiredAt.body.error || ''),
        expiredAt && expiredAt.body);
  r = await api('GET', '/api/me');
  check('the session row is destroyed, not just refused', r.status === 403, r.d);
  r = await api('POST', '/api/login', { username: 'admin', password: 'admin123' }, '');
  check('…so the username is free to sign in again at once', r.status === 200 && !!r.d.token, r.d);
  TOKEN = r.d.token;

  console.log('\n[3] Reported ACTIVITY does keep it alive');
  // Same elapsed time as above, but with the client reporting interaction.
  let aliveThroughout = true;
  for (let i = 0; i < 6; i++) {
    await sleep(900);
    const beat = await api('POST', '/api/session/activity');
    if (beat.status !== 200) { aliveThroughout = false; break; }
  }
  check('six seconds of interaction keeps the session', aliveThroughout === true);
  r = await api('GET', '/api/me');
  check('…and it is still usable afterwards', r.status === 200, r.d);

  console.log('\n[4] Turning the window off releases everyone');
  await api('PUT', '/api/company-settings', { settings: { auto_logout_minutes: '0' } });
  await sleep(2500);                       // well past the old 3-second window
  r = await api('GET', '/api/me');
  check('an idle session survives once the window is off', r.status === 200, r.d);

  console.log('\n[5] A garbage value means OFF, never "sign out instantly"');
  for (const bad of ['', 'abc', '-5']) {
    await api('PUT', '/api/company-settings', { settings: { auto_logout_minutes: bad } });
    await sleep(1200);
    r = await api('GET', '/api/me');
    check(`"${bad}" is treated as never`, r.status === 200, { bad, status: r.status, d: r.d });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
