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
//
// [cross-branch] `from_branch` is OPTIONAL (2026-10-07). A list of lot numbers
//   read off a sheet does not come from one depot, so blank means "take each
//   lot out of whichever depot holds it" and the split is reported per source.
//   Given explicitly it is a strict FILTER — a caller naming a source branch
//   is asserting the lots are in it. A lot already in the destination is a
//   no-op rather than an error; an unallocated number still cannot move.
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

  // ── Who may reassign at all (2026-10-07) ────────────────────────────
  // The route used to require auction_write — "create and edit TRADES" —
  // which the `operator` role does not carry. That is the main non-admin
  // role on the phone, so reassigning appeared to work for admins only,
  // whatever the feature flag said. The gate is lot_write now: moving a free
  // lot NUMBER between branch allocations is lot-floor work, and an operator
  // can already create and edit the lots themselves.
  console.log('\n[roles] the operator role can reassign, not just auction_write roles');
  await api('POST', '/api/users', { username: 'op01', password: 'op012345', role: 'operator' });
  const ol = await api('POST', '/api/login', { username: 'op01', password: 'op012345' }, null);
  const OP = ol.d && (ol.d.token || ol.d.accessToken);
  check('an operator can log in', !!OP, JSON.stringify(ol.d));

  // flag_mobile_reassign_direct is still ON from the block above.
  let op = await move(OP, ['017']);
  check('with the switch ON, an operator moves the lots', op.status === 200,
        `${op.status} ${JSON.stringify(op.d && op.d.error)}`);
  const afterOp = await api('GET', `/api/auctions/${id1}/allocation-stats`);
  const bodi2 = (afterOp.d.stats || []).find(s2 => s2.branch === 'BODINAYAKANUR') || {};
  check('…and the lot really landed', bodi2.total === 14, String(bodi2.total));

  await api('PUT', '/api/company-settings', { settings: { flag_mobile_reassign_direct: 'false' } });
  op = await move(OP, ['016']);
  check('with it OFF they are turned away by the SWITCH…', op.status === 403, `${op.status} ${JSON.stringify(op.d)}`);
  check('…not by their role — the message points at the request queue',
        /approval/i.test((op.d && op.d.error) || '') && !/auction_write/.test(JSON.stringify(op.d || {})),
        JSON.stringify(op.d));

  // Raising a REQUEST was never role-blocked and still is not: that is the
  // path an operator takes while the switch is off.
  const opReq = await api('POST', '/api/mobile/reassign-requests',
    { auction_id: id1, from_branch: 'ANAVILASAM', to_branch: 'BODINAYAKANUR', lots: ['016'], reason: 'ran out' }, OP);
  check('an operator can still raise a request with the switch off',
        opReq.status === 200, `${opReq.status} ${JSON.stringify(opReq.d)}`);

  // Widening to lot_write must not reach a role that has no write at all.
  await api('POST', '/api/users', { username: 'view01', password: 'view1234', role: 'viewer' });
  const vl = await api('POST', '/api/login', { username: 'view01', password: 'view1234' }, null);
  const VIEW = vl.d && (vl.d.token || vl.d.accessToken);
  await api('PUT', '/api/company-settings', { settings: { flag_mobile_reassign_direct: 'true' } });
  const vr = await move(VIEW, ['016']);
  check('a viewer is still refused, switch or no switch', vr.status === 403, `${vr.status} ${JSON.stringify(vr.d)}`);
  check('…and refused on the ROLE, which is the honest reason',
        /lot_write/.test(JSON.stringify(vr.d || {})), JSON.stringify(vr.d));

  // ── Cross-branch moves (2026-10-07) ─────────────────────────────────
  // from_branch is OPTIONAL. A list of lot numbers read off a sheet does not
  // come from one depot, and splitting such a move by branch was the operator
  // doing the server's bookkeeping by hand. Blank = take each lot out of
  // whichever depot holds it; given = a filter, enforced strictly.
  console.log('\n[cross-branch] one move can drain several depots');
  const a9 = await api('POST', '/api/auctions', { ano: 79, date: '2026-10-07', state: 'TAMIL NADU' });
  const id9 = a9.d && a9.d.id;
  await api('POST', `/api/auctions/${id9}/allocations`, {
    allocations: [
      { branch: 'ANAVILASAM',    start_lot: '001', end_lot: '010' },
      { branch: 'BODINAYAKANUR', start_lot: '101', end_lot: '110' },
    ],
  });
  const lotsIn = async (branch) => {
    const st = await api('GET', `/api/auctions/${id9}/allocation-stats`);
    const s9 = (st.d.stats || []).find(x => x.branch === branch);
    return s9 ? (s9.ranges || []).flatMap(r => (r.lots || []).map(l => l.lot)) : [];
  };

  let x = await api('POST', `/api/auctions/${id9}/reassign-lots`,
    { to_branch: 'CUMBUM', lots: ['003', '004', '101', '102'] });
  check('a move with NO from_branch is accepted', x.status === 200, JSON.stringify(x.d && x.d.error));
  check('…and reports the per-source split',
        JSON.stringify((x.d && x.d.sources) || []) ===
          JSON.stringify([{ branch: 'ANAVILASAM', lots: 2 }, { branch: 'BODINAYAKANUR', lots: 2 }]),
        JSON.stringify(x.d && x.d.sources));
  check('…naming both depots in the message',
        /ANAVILASAM \(2\)/.test((x.d && x.d.message) || '') && /BODINAYAKANUR \(2\)/.test((x.d && x.d.message) || ''),
        (x.d || {}).message);
  check('all four landed in CUMBUM',
        (await lotsIn('CUMBUM')).join(',') === '003,004,101,102', JSON.stringify(await lotsIn('CUMBUM')));
  check('ANAVILASAM lost exactly its two, keeping the rest',
        (await lotsIn('ANAVILASAM')).join(',') === '001,002,005,006,007,008,009,010',
        JSON.stringify(await lotsIn('ANAVILASAM')));
  check('…and BODINAYAKANUR the same',
        (await lotsIn('BODINAYAKANUR')).join(',') === '103,104,105,106,107,108,109,110',
        JSON.stringify(await lotsIn('BODINAYAKANUR')));

  // Provenance: the audit log is written per SOURCE, which is what makes the
  // 'reassigned' tile overlay cover exactly the lots that moved.
  const st9 = await api('GET', `/api/auctions/${id9}/allocation-stats`);
  const cum = (st9.d.stats || []).find(x2 => x2.branch === 'CUMBUM') || {};
  const cumStates = (cum.ranges || []).flatMap(r => (r.lots || []).map(l => `${l.lot}:${l.state}`));
  check('every moved lot is tagged reassigned, whichever depot it came from',
        cumStates.every(v => v.endsWith(':reassigned')) && cumStates.length === 4,
        JSON.stringify(cumStates));

  console.log('\n[cross-branch] an explicit FROM is still a strict filter');
  x = await api('POST', `/api/auctions/${id9}/reassign-lots`,
    { from_branch: 'ANAVILASAM', to_branch: 'CUMBUM', lots: ['005', '103'] });
  check('a lot outside the named FROM is refused, not quietly moved',
        x.status === 400 && /not allocated to ANAVILASAM/.test((x.d && x.d.error) || ''),
        `${x.status} ${JSON.stringify(x.d)}`);
  check('and nothing moved — 005 is still in ANAVILASAM',
        (await lotsIn('ANAVILASAM')).includes('005'), JSON.stringify(await lotsIn('ANAVILASAM')));

  console.log('\n[cross-branch] a lot already in the destination is a no-op');
  x = await api('POST', `/api/auctions/${id9}/reassign-lots`,
    { to_branch: 'CUMBUM', lots: ['005', '003'] });   // 003 is already in CUMBUM
  check('the move succeeds on the one that can move', x.status === 200, JSON.stringify(x.d && x.d.error));
  check('…counts the one that was already there', x.d && x.d.skippedSameBranch === 1, JSON.stringify(x.d));
  check('…says so in the message', /already in CUMBUM/.test((x.d && x.d.message) || ''), (x.d || {}).message);
  check('…and CUMBUM holds five now, not six',
        (await lotsIn('CUMBUM')).length === 5, JSON.stringify(await lotsIn('CUMBUM')));
  x = await api('POST', `/api/auctions/${id9}/reassign-lots`,
    { to_branch: 'CUMBUM', lots: ['003'] });
  check('a move with NOTHING left to move is refused, not reported as done',
        x.status === 400 && /already allocated to CUMBUM/.test((x.d && x.d.error) || ''),
        `${x.status} ${JSON.stringify(x.d)}`);

  console.log('\n[cross-branch] an unallocated number still cannot be moved');
  x = await api('POST', `/api/auctions/${id9}/reassign-lots`,
    { to_branch: 'CUMBUM', lots: ['900'] });
  check('it is refused, naming the problem',
        x.status === 400 && /not allocated to any branch/.test((x.d && x.d.error) || ''),
        `${x.status} ${JSON.stringify(x.d)}`);
  x = await api('POST', `/api/auctions/${id9}/reassign-lots`, { lots: ['006'] });
  check('and a move with no destination at all is refused',
        x.status === 400 && /to_branch required/.test((x.d && x.d.error) || ''),
        `${x.status} ${JSON.stringify(x.d)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
