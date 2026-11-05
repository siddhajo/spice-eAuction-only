// Moving BOOKED lots to another depot — lots and allocations together.
//
// There are two kinds of "move a lot to another branch" in this app and they
// are opposites:
//   • /api/auctions/:id/reassign-lots moves free lot NUMBERS between depot
//     allocations and REFUSES anything already booked.
//   • /api/lots/bulk-branch (this one) moves the booked LOTS — rows with a
//     seller and a weight, because the goods turned out to be at a different
//     depot — and drags their numbers' allocation along with them.
//
// The property that matters is AGREEMENT: after a move, the depot stamped on
// the lot and the depot that owns that lot NUMBER in lot_allocations must be
// the same. Leave one behind and Lot Entry goes on offering the number under
// the old depot while the booked lot sits under the new one.
//
//   [guard]   the destination must be a real depot; ids are required
//   [move]    lots.branch changes and the allocation ranges are re-cut
//   [agree]   every moved number is owned by the destination afterwards
//   [split]   a range cut in the middle leaves the right pieces behind
//   [spread]  a selection spanning two depots moves from both
//   [noop]    lots already in the destination are left alone, not an error
//   [opt]     moveAllocations:false writes only the lot column
//   [free]    the free-number mover still refuses booked lots (unchanged)
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lot-branch-'));
const PORT = 47501;
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
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const A = 'ANAVILASAM', Bd = 'BODINAYAKANUR', C = 'CUMBUM';

// Expand the stored ranges into "which depot owns this lot number".
async function ownerMap(aid) {
  const r = await api('GET', `/api/auctions/${aid}/allocations`);
  const out = {};
  for (const a of ((r.d && r.d.allocations) || [])) {
    const s = parseInt(String(a.start_lot).replace(/\D/g, ''), 10);
    const e = parseInt(String(a.end_lot).replace(/\D/g, ''), 10);
    const pad = String(a.start_lot).replace(/\d+$/, '').length
      ? 0 : String(a.start_lot).length;
    for (let n = s; n <= e; n++) {
      out[String(n).padStart(pad || String(a.start_lot).length, '0')] = a.branch;
    }
  }
  return out;
}
// GET /api/lots answers { lots, stats, pagination, filters } — not a bare
// array. Ask for every lot explicitly so a default page size can never make
// a "lot didn't move" assertion pass by simply not returning it.
const lotsOf = async (aid) => {
  const d = (await api('GET', `/api/lots?auction_id=${aid}&limit=1000`)).d || {};
  return Array.isArray(d) ? d : (d.lots || []);
};

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: { br1: A, br2: Bd, br3: C } });
  const auc = await api('POST', '/api/auctions', { ano: '101', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  // Allocations: 001-010 to ANAVILASAM, 011-020 to BODINAYAKANUR.
  const alloc = await api('POST', `/api/auctions/${aid}/allocations`, {
    allocations: [
      { branch: A,  start_lot: '001', end_lot: '010' },
      { branch: Bd, start_lot: '011', end_lot: '020' },
    ],
  });
  check('fixture allocations saved', alloc.status === 200, JSON.stringify(alloc.d).slice(0, 200));

  // Book six lots: 003,004,005 in A and 012,013 in B, plus 008 in A.
  const idOf = {};
  for (const [lot_no, br] of [['003', A], ['004', A], ['005', A], ['008', A], ['012', Bd], ['013', Bd]]) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'SELLER ' + lot_no, cr: '', qty: 100, bags: 10,
      grade: '1', crop: 'CARDAMOM', branch: br,
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    if (!id) { console.error('lot failed', lot_no, r.status, r.d); cleanup(); process.exit(1); }
    idOf[lot_no] = id;
  }
  check('six lots booked', Object.keys(idOf).length === 6);

  console.log('[guard] the destination has to be a real depot');
  {
    const noIds = await api('POST', '/api/lots/bulk-branch', { branch: C });
    check('ids[] is required', noIds.status === 400 && /ids/.test(noIds.d.error || ''),
      JSON.stringify(noIds.d));
    const bad = await api('POST', '/api/lots/bulk-branch', { ids: [idOf['003']], branch: 'NOWHERE' });
    check('an unconfigured depot is refused, listing the real ones',
      bad.status === 400 && /not one of this install/i.test(bad.d.error || '')
      && new RegExp(A).test(bad.d.error || ''),
      JSON.stringify(bad.d));
    const blank = await api('POST', '/api/lots/bulk-branch', { ids: [idOf['003']], branch: '' });
    check('a blank depot is refused', blank.status === 400, JSON.stringify(blank.d));
  }

  console.log('[move] the lots move and the ranges are re-cut');
  {
    const r = await api('POST', '/api/lots/bulk-branch', {
      ids: [idOf['003'], idOf['004']], branch: C,
    });
    check('the move succeeds', r.status === 200 && r.d.updated === 2, JSON.stringify(r.d).slice(0, 240));
    check('it reports where they came from', (r.d.from || {})[A] === 2, JSON.stringify(r.d.from));
    check('…and that allocations were re-cut', r.d.allocations_moved === true);
    const lots = await lotsOf(aid);
    const br = (no) => (lots.find(l => String(l.lot_no) === no) || {}).branch;
    check('lots.branch is the new depot', br('003') === C && br('004') === C,
      `${br('003')} / ${br('004')}`);
    check('their neighbours are untouched', br('005') === A && br('008') === A,
      `${br('005')} / ${br('008')}`);
  }

  console.log('[agree] the lot and its number agree about the depot');
  {
    const own = await ownerMap(aid);
    check('003 is owned by the destination', own['003'] === C, String(own['003']));
    check('004 too', own['004'] === C, String(own['004']));
    const lots = await lotsOf(aid);
    const disagree = lots.filter(l => {
      const o = own[String(l.lot_no)];
      return o && String(o).toUpperCase() !== String(l.branch || '').toUpperCase();
    });
    check('NO booked lot disagrees with its allocation — the whole point',
      disagree.length === 0,
      JSON.stringify(disagree.map(l => [l.lot_no, l.branch, own[String(l.lot_no)]])));
  }

  console.log('[split] the source range is cut, not clobbered');
  {
    const own = await ownerMap(aid);
    // 001-010 was ANAVILASAM; 003-004 left, so 001-002 and 005-010 stay.
    check('001 and 002 are still ANAVILASAM', own['001'] === A && own['002'] === A,
      `${own['001']} / ${own['002']}`);
    check('005..010 are still ANAVILASAM',
      ['005', '006', '007', '008', '009', '010'].every(n => own[n] === A),
      JSON.stringify(['005', '010'].map(n => own[n])));
    check('the other depot is untouched',
      ['011', '012', '020'].every(n => own[n] === Bd),
      JSON.stringify(['011', '012', '020'].map(n => own[n])));
    const r = await api('GET', `/api/auctions/${aid}/allocations`);
    const mine = ((r.d && r.d.allocations) || []).filter(a => a.branch === A)
      .map(a => `${a.start_lot}-${a.end_lot}`).sort();
    check('ANAVILASAM is left as two tidy ranges, not six singles',
      mine.length === 2 && mine.join(' ') === '001-002 005-010', mine.join(' '));
  }

  console.log('[spread] a selection across two depots moves from both');
  {
    const r = await api('POST', '/api/lots/bulk-branch', {
      ids: [idOf['005'], idOf['012']], branch: C,
    });
    check('both move', r.status === 200 && r.d.updated === 2, JSON.stringify(r.d).slice(0, 200));
    check('the report names both sources',
      (r.d.from || {})[A] === 1 && (r.d.from || {})[Bd] === 1, JSON.stringify(r.d.from));
    const own = await ownerMap(aid);
    check('005 and 012 now belong to the destination',
      own['005'] === C && own['012'] === C, `${own['005']} / ${own['012']}`);
    check('011 and 013 stayed behind', own['011'] === Bd && own['013'] === Bd,
      `${own['011']} / ${own['013']}`);
    // The destination's numbers should coalesce where they touch: it now
    // holds 003,004,005 and 012.
    const al = await api('GET', `/api/auctions/${aid}/allocations`);
    const dest = ((al.d && al.d.allocations) || []).filter(a => a.branch === C)
      .map(a => `${a.start_lot}-${a.end_lot}`).sort();
    check('the destination merges 003-005 instead of keeping three ranges',
      dest.includes('003-005'), dest.join(' '));
  }

  console.log('[noop] lots already there are left alone');
  {
    const r = await api('POST', '/api/lots/bulk-branch', { ids: [idOf['003']], branch: C });
    check('no error, nothing updated', r.status === 200 && r.d.updated === 0,
      JSON.stringify(r.d).slice(0, 200));
    check('it says they are already there', r.d.already_there === 1, String(r.d.already_there));
    const own = await ownerMap(aid);
    check('and the allocation is unharmed', own['003'] === C, String(own['003']));
  }

  console.log('[opt] moveAllocations:false writes only the lot column');
  {
    const before = await ownerMap(aid);
    const r = await api('POST', '/api/lots/bulk-branch', {
      ids: [idOf['013']], branch: C, moveAllocations: false,
    });
    check('the lot moves', r.status === 200 && r.d.updated === 1, JSON.stringify(r.d).slice(0, 200));
    check('it says allocations were left alone', r.d.allocations_moved === false);
    const after = await ownerMap(aid);
    check('013 is still allocated to its old depot',
      after['013'] === Bd && before['013'] === Bd, `${before['013']} → ${after['013']}`);
    const lots = await lotsOf(aid);
    check('…while the lot row itself reads the new depot',
      (lots.find(l => String(l.lot_no) === '013') || {}).branch === C,
      (lots.find(l => String(l.lot_no) === '013') || {}).branch);
    // Put it back so the suite leaves a consistent trade behind.
    await api('POST', '/api/lots/bulk-branch', { ids: [idOf['013']], branch: C });
  }

  console.log('[preview] the dry run reports without writing');
  {
    const before = await ownerMap(aid);
    const p = await api('POST', '/api/lots/bulk-branch/preview', {
      ids: [idOf['008']], branch: C,
    });
    check('the preview answers', p.status === 200, JSON.stringify(p.d).slice(0, 200));
    check('it counts what would move', p.d.movable === 1, String(p.d.movable));
    check('…names the source depot', (p.d.from || []).some(f => f.branch === A),
      JSON.stringify(p.d.from));
    check('…lists the configured depots for the picker',
      (p.d.branches || []).includes(C), JSON.stringify(p.d.branches));
    check('…and shows the lot numbers as ranges', (p.d.ranges || []).includes('008'),
      JSON.stringify(p.d.ranges));
    const after = await ownerMap(aid);
    check('NOTHING was written', JSON.stringify(before) === JSON.stringify(after));
  }

  console.log('[free] the free-number mover still refuses booked lots');
  {
    // 008 is booked — the other endpoint must still say no, unchanged by the
    // shared re-cut helper both now use.
    const r = await api('POST', `/api/auctions/${aid}/reassign-lots`, {
      to_branch: C, lots: ['008'],
    });
    check('booked lots are still refused there', r.status === 400 && /already used/i.test(r.d.error || ''),
      r.status + ' ' + JSON.stringify(r.d));
    // …and a genuinely free number still moves.
    const free = await api('POST', `/api/auctions/${aid}/reassign-lots`, {
      to_branch: C, lots: ['020'],
    });
    check('a free number still moves', free.status === 200, JSON.stringify(free.d).slice(0, 160));
    const own = await ownerMap(aid);
    check('…and lands in the destination', own['020'] === C, String(own['020']));
  }

  console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} ok, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
