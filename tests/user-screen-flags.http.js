// PER-USER SCREENS — the install flag is a DEFAULT, a user row overrides it.
//
// The case this was built for: on one install, user A works from the Auction
// Manager and user B from the Auction Desk. Neither screen is on for the whole
// site, so the override has to work in BOTH directions — turning a screen ON
// that the install has off, and OFF that the install has on.
//
//   [default]  no override → the user follows Settings → Flags, and keeps
//              following it when an admin changes it
//   [override] on/off per user, both directions, and clearing puts the screen
//              back on the default
//   [api]      the Auction Manager endpoint asks the PER-USER value — giving
//              someone the screen and then 404ing its data would be useless
//   [guard]    only user_manage may read or write another user's screens;
//              unknown keys are refused; deleting a user drops their rows
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uscr-'));
const PORT = 47372;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

async function api(method, url, body, token) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
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
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const ADMIN = boot.d && boot.d.token;
  if (!ADMIN) { console.log('login failed ' + boot.status + '\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }

  // Two managers: both have the auction_desk capability, so the only thing
  // separating what they see is the per-user screen setting.
  const mk = async (username) => {
    const r = await api('POST', '/api/users', { username, password: 'passw0rd', role: 'manager' }, ADMIN);
    const li = await api('POST', '/api/login', { username, password: 'passw0rd' });
    return { id: (r.d && (r.d.id || (r.d.user && r.d.user.id))), token: li.d && li.d.token };
  };
  const A = await mk('mgr_a');
  const B_ = await mk('mgr_b');
  const ids = (await api('GET', '/api/users', null, ADMIN)).d.users;
  A.id = (ids.find(u => u.username === 'mgr_a') || {}).id;
  B_.id = (ids.find(u => u.username === 'mgr_b') || {}).id;
  check('two managers created and signed in', !!(A.id && A.token && B_.id && B_.token),
        JSON.stringify({ a: A.id, at: !!A.token, b: B_.id, bt: !!B_.token }));

  // ══ [default] ════════════════════════════════════════════════════
  // Shipped defaults: Auction Desk ON, Auction Manager OFF.
  let sa = (await api('GET', '/api/me/screens', null, A.token)).d;
  check('with no override, a user follows the install defaults',
        sa.flag_auction_desk === 'true' && sa.flag_auction_manager === 'false', JSON.stringify(sa));

  // ══ [override] the case this exists for ══════════════════════════
  // A gets the Auction Manager (install has it OFF) and loses the Desk;
  // B is left entirely alone and must still follow the install.
  let r = await api('PUT', `/api/users/${A.id}/screens`,
    { overrides: { flag_auction_manager: true, flag_auction_desk: false } }, ADMIN);
  check('saving overrides answers with the new effective set', r.status === 200
        && r.d.screens.flag_auction_manager === 'true' && r.d.screens.flag_auction_desk === 'false',
        JSON.stringify(r.d));

  sa = (await api('GET', '/api/me/screens', null, A.token)).d;
  const sb = (await api('GET', '/api/me/screens', null, B_.token)).d;
  check('user A now has the Auction Manager the install has OFF',
        sa.flag_auction_manager === 'true', JSON.stringify(sa));
  check('…and not the Auction Desk', sa.flag_auction_desk === 'false', JSON.stringify(sa));
  check('user B is untouched — still Desk, no Manager',
        sb.flag_auction_desk === 'true' && sb.flag_auction_manager === 'false', JSON.stringify(sb));

  // ══ [api] the endpoint follows the USER, not the install ═════════
  const AID = (await api('POST', '/api/auctions', { ano: '31', date: '2026-09-02', crop_type: 'VST' }, ADMIN)).d.id;
  const amA = await api('GET', `/api/auction-manager/${AID}`, null, A.token);
  const amB = await api('GET', `/api/auction-manager/${AID}`, null, B_.token);
  check('user A can load Auction Manager data', amA.status === 200, `HTTP ${amA.status} ${JSON.stringify(amA.d)}`);
  check('user B, who does not have the screen, gets 404', amB.status === 404, `HTTP ${amB.status}`);

  // ══ [default] an admin changing the install still reaches B ══════
  await api('PUT', '/api/company-settings', { settings: { flag_auction_manager: 'true' } }, ADMIN);
  const sb2 = (await api('GET', '/api/me/screens', null, B_.token)).d;
  check('flipping the install default reaches the user with no override',
        sb2.flag_auction_manager === 'true', JSON.stringify(sb2));
  const sa2 = (await api('GET', '/api/me/screens', null, A.token)).d;
  check('…and does not disturb a user who has an explicit override',
        sa2.flag_auction_desk === 'false', JSON.stringify(sa2));

  // ══ [override] clearing returns to the default ═══════════════════
  await api('PUT', `/api/users/${A.id}/screens`, { overrides: { flag_auction_desk: null } }, ADMIN);
  const sa3 = (await api('GET', '/api/me/screens', null, A.token)).d;
  check('clearing an override puts the screen back on the install default',
        sa3.flag_auction_desk === 'true', JSON.stringify(sa3));
  const detail = (await api('GET', `/api/users/${A.id}/screens`, null, ADMIN)).d;
  const desk = detail.flags.find(f => f.key === 'flag_auction_desk');
  const mgr  = detail.flags.find(f => f.key === 'flag_auction_manager');
  check('the admin view reports a cleared screen as inherit', desk.override === null && desk.effective === true,
        JSON.stringify(desk));
  check('…and an explicit one as an override', mgr.override === true, JSON.stringify(mgr));
  const keys = detail.flags.map(f => f.key);
  check('every per-user screen is offered', detail.flags.length >= 6, keys.join(', '));
  // The Payments row picks BETWEEN two screens rather than hiding one, so it
  // carries a note saying what Off does.
  const pay = detail.flags.find(f => f.key === 'flag_lotwise_payments');
  check('lot-wise Payments is offered, with its chooser explained',
        !!pay && /seller-wise/i.test(pay.note || ''), JSON.stringify(pay));
  // A flag whose install value also gates a document or export ENDPOINT must
  // NOT be here: a per-user "on" would show the surface and then 403 its
  // data. Merchants is a Tally export card, not a screen at all.
  for (const k of ['flag_merchants', 'flag_debit_note', 'flag_debit_note_planter']) {
    check(`${k} is not offered per-user (it gates export endpoints)`, !keys.includes(k), keys.join(', '));
    const r2 = await api('PUT', `/api/users/${A.id}/screens`, { overrides: { [k]: true } }, ADMIN);
    check(`…and writing it is refused`, r2.status === 400, `HTTP ${r2.status}`);
  }

  // ══ [guard] ═════════════════════════════════════════════════════
  const asMgr = await api('GET', `/api/users/${B_.id}/screens`, null, A.token);
  check('a manager cannot read another user\'s screens', asMgr.status === 403, `HTTP ${asMgr.status}`);
  const wrote = await api('PUT', `/api/users/${B_.id}/screens`, { overrides: { flag_insights: false } }, A.token);
  check('…nor write them', wrote.status === 403, `HTTP ${wrote.status}`);
  // A lot-wise DOCUMENT flag changes how a document is built and numbered —
  // it must stay uniform across the install, unlike the lot-wise PAYMENTS
  // flag above, which only picks a screen.
  const bad = await api('PUT', `/api/users/${A.id}/screens`, { overrides: { flag_lotwise_purchase: true } }, ADMIN);
  check('a non-screen flag is refused', bad.status === 400, `HTTP ${bad.status} ${JSON.stringify(bad.d)}`);
  const missing = await api('GET', '/api/users/99999/screens', null, ADMIN);
  check('an unknown user 404s', missing.status === 404, `HTTP ${missing.status}`);

  // Deleting the user drops their overrides, so a recycled id can't inherit
  // a stranger's screen set.
  await api('DELETE', `/api/users/${A.id}`, null, ADMIN);
  const after = await api('GET', `/api/users/${A.id}/screens`, null, ADMIN);
  check('deleting a user removes their screen rows', after.status === 404, `HTTP ${after.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-3000)); cleanup(); process.exit(1); });
