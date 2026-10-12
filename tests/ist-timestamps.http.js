// Every timestamp this app writes is Indian Standard Time.
//
// The app stamps rows with SQLite's datetime('now','localtime') in ~66
// places and with bare `new Date()` elsewhere. Both read the PROCESS
// timezone, which is UTC in the Docker/Railway container — so every stored
// stamp used to come out 5h30m behind the wall clock the operator reads it
// against, and anything entered before 05:30 IST was filed under the
// previous day. ist.js pins the process clock to Asia/Kolkata to fix that
// at the source.
//
// This test runs the server with the HOST clock deliberately set to UTC,
// which is what makes it a regression test. To watch it catch the bug,
// re-run it with SPICE_TZ=UTC (ist.js's override) — the stamps come back
// exactly 330 minutes early:
//
//   stored "2026-10-12 16:46:13" — 330min from IST, 0min from UTC
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ist-ts-'));
const PORT = 47932;
const B = `http://127.0.0.1:${PORT}`;

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, TZ: 'UTC', SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' },
  stdio: ['ignore', 'ignore', 'ignore'],
});

let T = '';
const api = async (m, u, b) => {
  const r = await fetch(B + u, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); }
};

// Minutes-into-the-day of a naive "YYYY-MM-DD HH:MM:SS" stamp.
const mins = (s) => (+String(s).slice(11, 13)) * 60 + (+String(s).slice(14, 16));

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => (p.type !== 'literal' && (a[p.type] = p.value), a), {});
  const istDay = `${ist.year}-${ist.month}-${ist.day}`;
  const istMin = (+ist.hour) * 60 + (+ist.minute);
  const iso = new Date().toISOString();
  const utcDay = iso.slice(0, 10);
  const utcMin = (+iso.slice(11, 13)) * 60 + (+iso.slice(14, 16));

  console.log(`\nHost clock is UTC.  IST now = ${istDay} ${ist.hour}:${ist.minute}`
            + `   UTC now = ${utcDay} ${iso.slice(11, 16)}\n`);

  // Shared assertion: the stamp sits on the IST clock, not the UTC one.
  const onIst = (stamp, label) => {
    const s = String(stamp || '');
    const dIst = Math.abs(mins(s) - istMin), dUtc = Math.abs(mins(s) - utcMin);
    check(label, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && s.slice(0, 10) === istDay && dIst <= 3,
      `stored "${s}" — ${dIst}min from IST, ${dUtc}min from UTC`);
  };

  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;

  const auc = await api('POST', '/api/auctions', { ano: 'IST-1', date: istDay, crop_type: 'cardamom' });
  const aid = auc.d && auc.d.id;
  const tr = await api('POST', '/api/traders', { name: 'IST SELLER', tel: '9800000000' });
  const tid = tr.d && tr.d.trader && tr.d.trader.id;
  await api('POST', '/api/lots', {
    auction_id: aid, lot_no: '1', branch: 'CUMBUM', trader_id: tid,
    name: 'IST SELLER', grade: 'AGB', bags: 1, litre: 1, qty: 1,
  });

  // lots.created_at — the stamp the operator reads on My Lots, and what the
  // edit-timeout window is measured against.
  const lots = (((await api('GET', '/api/lots?auction_id=' + aid)).d) || {}).lots || [];
  onIst((lots[0] || {}).created_at, 'lots.created_at is written in IST');

  // audit_log.created_at — the audit trail, where a 5h30m skew is worst.
  const logs = (((await api('GET', '/api/audit-log')).d) || {}).logs || [];
  onIst((logs[0] || {}).created_at, 'audit_log.created_at is written in IST');

  // sessions.last_used_at — stamped by datetime('now','localtime') on every
  // authenticated request.
  const sess = (((await api('GET', '/api/users')).d) || {});
  const users = Array.isArray(sess) ? sess : (sess.users || []);
  const admin = users.find(u => u.username === 'admin') || {};
  check('users.created_at carries the IST calendar day',
    String(admin.created_at || '').slice(0, 10) === istDay,
    `stored "${admin.created_at}" | IST ${istDay} | UTC ${utcDay}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('HARNESS ' + e.message); srv.kill(); process.exit(1); });
