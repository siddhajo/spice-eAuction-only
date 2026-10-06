// Two decisions that used to live in the wrong place.
//
// [main depot] The trade's main / holding depot — what Close Depot pushes a
//   closed depot's free numbers into — was only reachable from inside Edit
//   Allocations, so trades reached the end of the day with it unset and
//   Close Depot refused to run. It is now asked for when the auction is
//   CREATED, validated against the configured branch list (allocations
//   usually do not exist yet at that point), and it must survive the first
//   Save Allocations even though the depot has no range of its own.
//
// [direct reassign] lot_entry carries auction_write so it can open trades in
//   the hall, which means the phone could already reach POST
//   /api/auctions/:id/reassign-lots. Whether it MAY is now a setting
//   (flag_mobile_reassign_direct), enforced here and not only in the phone's
//   UI. Desk roles (manager / admin) are never gated. The lot-level rails
//   are unchanged either way: a booked lot can never move.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-direct-'));
const PORT = 47433;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body, token) {
  const t = token === undefined ? TOKEN : token;
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
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
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const mainBranchOf = async (id) => {
  const r = await api('GET', `/api/auctions/${id}/allocation-stats`);
  return r.d && r.d.main_branch;
};

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', {
    settings: { br1: 'ANAVILASAM', br2: 'BODINAYAKANUR', br3: 'CUMBUM' },
  });

  console.log('[main depot] chosen when the trade is created');
  const a1 = await api('POST', '/api/auctions', {
    ano: 71, date: '2026-10-05', state: 'TAMIL NADU', main_branch: 'CUMBUM',
  });
  const id1 = a1.d && a1.d.id;
  check('the create accepts it', a1.status === 200 && a1.d.main_branch === 'CUMBUM', JSON.stringify(a1.d));
  check('and it is readable straight back', (await mainBranchOf(id1)) === 'CUMBUM');

  const a2 = await api('POST', '/api/auctions', {
    ano: 72, date: '2026-10-05', state: 'TAMIL NADU', main_branch: 'NOWHERE',
  });
  check('a branch nobody configured is refused, not stored',
        a2.d && a2.d.main_branch === '', JSON.stringify(a2.d));
  const a3 = await api('POST', '/api/auctions', { ano: 73, date: '2026-10-05', state: 'TAMIL NADU' });
  check('omitting it is fine — the trade just has no main depot yet',
        a3.d && a3.d.main_branch === '', JSON.stringify(a3.d));

  console.log('\n[main depot] it survives the first Save Allocations');
  // CUMBUM deliberately has NO range here: that is the normal shape on day
  // one, and close-depot does not need it to have one — it appends.
  const save = await api('POST', `/api/auctions/${id1}/allocations`, {
    allocations: [
      { branch: 'ANAVILASAM', start_lot: '001', end_lot: '020' },
      { branch: 'BODINAYAKANUR', start_lot: '101', end_lot: '110' },
    ],
    main_branch: 'CUMBUM',
  });
  check('the save goes through', save.status === 200, JSON.stringify(save.d && save.d.error));
  check('and the main depot is still CUMBUM', (await mainBranchOf(id1)) === 'CUMBUM',
        String(await mainBranchOf(id1)));

  console.log('\n[main depot] PUT leaves it alone unless it is sent');
  await api('PUT', `/api/auctions/${id1}`, { ano: 71, date: '2026-10-05', crop_type: 'VST', state: 'TAMIL NADU' });
  check('an edit that says nothing about it keeps it', (await mainBranchOf(id1)) === 'CUMBUM');
  await api('PUT', `/api/auctions/${id1}`, {
    ano: 71, date: '2026-10-05', crop_type: 'VST', state: 'TAMIL NADU', main_branch: 'ANAVILASAM',
  });
  check('sending a new one moves it', (await mainBranchOf(id1)) === 'ANAVILASAM');
  await api('PUT', `/api/auctions/${id1}`, {
    ano: 71, date: '2026-10-05', crop_type: 'VST', state: 'TAMIL NADU', main_branch: '',
  });
  check('and an explicit blank clears it', (await mainBranchOf(id1)) === '');
  await api('PUT', `/api/auctions/${id1}`, {
    ano: 71, date: '2026-10-05', crop_type: 'VST', state: 'TAMIL NADU', main_branch: 'CUMBUM',
  });

  console.log('\n[direct reassign] the field role is gated by the setting');
  await api('POST', '/api/users', { username: 'hall01', password: 'hall1234', role: 'lot_entry', branch: 'ANAVILASAM' });
  const fl = await api('POST', '/api/login', { username: 'hall01', password: 'hall1234' }, null);
  const FIELD = fl.d && (fl.d.token || fl.d.accessToken);
  check('a lot_entry user can log in', !!FIELD, JSON.stringify(fl.d));

  const move = (token, lots) => api('POST', `/api/auctions/${id1}/reassign-lots`,
    { from_branch: 'ANAVILASAM', to_branch: 'BODINAYAKANUR', lots }, token);

  let r = await move(FIELD, ['018', '019']);
  check('OFF by default — the phone is turned away', r.status === 403, JSON.stringify(r.d));
  check('and told where to go instead', /approval/i.test((r.d && r.d.error) || ''), (r.d || {}).error);

  r = await move(TOKEN, ['018']);
  check('an admin is never gated by it', r.status === 200, JSON.stringify(r.d && r.d.error));

  await api('PUT', '/api/company-settings', { settings: { flag_mobile_reassign_direct: 'true' } });
  r = await move(FIELD, ['019', '020']);
  check('switched ON, the phone moves the lots itself', r.status === 200, JSON.stringify(r.d && r.d.error));
  const stats = await api('GET', `/api/auctions/${id1}/allocation-stats`);
  const bodi = (stats.d.stats || []).find(s => s.branch === 'BODINAYAKANUR') || {};
  check('and they really landed in the other branch', bodi.total === 13, String(bodi.total));

  console.log('\n[direct reassign] the lot-level rails do not move with the flag');
  await api('POST', '/api/lots', {
    auction_id: id1, lot_no: '005', name: 'ANNAMALAI', cr: 'CR.9001',
    qty: 100, bags: 10, grade: '1', branch: 'ANAVILASAM',
  });
  r = await move(FIELD, ['005']);
  check('a booked lot is still refused, flag or no flag', r.status === 400, JSON.stringify(r.d));
  check('and the refusal names it', /already used/i.test((r.d && r.d.error) || ''), (r.d || {}).error);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
