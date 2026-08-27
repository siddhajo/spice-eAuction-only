// AUCTION MANAGER — flag gate + the stat band's arithmetic.
//
// The screen's whole value is that its eight numbers are trustworthy at a
// glance, so this asserts them against a hand-built trade whose expected
// figures are obvious by inspection rather than re-derived from the same
// SQL the endpoint uses.
//
// Two halves:
//   [gate]  flag_auction_manager OFF → 404 (the feature isn't on this
//           install), and ON → 200. The Auction Desk's `auction_desk` role
//           capability is a SEPARATE gate; toggling this flag must not move
//           it, and an operator (who has no auction_desk) must still reach
//           the Auction Manager.
//   [band]  sold / WD / NA / planter / buyer counts, sold weight, total
//           value, and allocated lots from the lot_allocations ranges.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auctionmgr-'));
const PORT = 47344;
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
async function setFlag(key, val) {
  const r = await api('PUT', '/api/company-settings', { settings: { [key]: String(val) } });
  if (r.status !== 200) throw new Error(`could not set ${key}: ${r.status} ${JSON.stringify(r.d)}`);
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
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  if (login.status !== 200 || !login.d || !login.d.token) {
    console.log('could not sign in as admin: ' + login.status + '\n' + srvLog);
    cleanup(); process.exit(1);
  }
  TOKEN = login.d.token;

  // ── Seed one trade ────────────────────────────────────────────────
  // 6 lots: 3 sold planters, 1 sold dealer, 1 WD, 1 NA.
  //   sold lots   = 4   (P1, P2, P3, D1)
  //   sold weight = 100 + 200 + 50 + 150 = 500
  //   total value = 100*10 + 200*10 + 50*20 + 150*30 = 1000+2000+1000+4500 = 8500
  //   planters    = 4 distinct sellers (PLANTER A twice, B, C, DEALER X)
  //   buyers      = 2 distinct buyer codes over SOLD lots (BUY1, BUY2)
  //                 — the WD lot carries BUY3, which must NOT be counted.
  const ac = await api('POST', '/api/auctions', { ano: '13', date: '2026-08-08', crop_type: 'VST' });
  const AID = ac.d && ac.d.id;
  if (!AID) { console.log('could not create auction: ' + JSON.stringify(ac.d)); cleanup(); process.exit(1); }

  // Allocation ranges 1-10 and 11-14 → 10 + 4 = 14 allocated lots. Saved
  // BEFORE the lots: the allocations route refuses a set that would leave an
  // already-entered lot outside every range.
  const al = await api('POST', `/api/auctions/${AID}/allocations`, {
    allocations: [
      { branch: 'MAIN', start_lot: '1',  end_lot: '10' },
      { branch: 'WEST', start_lot: '11', end_lot: '14' },
    ],
  });
  if (al.status !== 200) { console.log('allocations failed: ' + JSON.stringify(al.d)); cleanup(); process.exit(1); }

  // POST /api/lots takes only the ENTRY fields — price, code, buyer and
  // amount are set later by pricing, so each lot is created then updated,
  // which is also the order the real screens produce them in.
  const seed = [
    { lot_no: '1',  branch: 'MAIN', name: 'PLANTER A', cr: 'CR.',                   qty: 100, price: 10, code: 'B1', buyer: 'BUY1' },
    { lot_no: '2',  branch: 'MAIN', name: 'PLANTER A', cr: 'CR.',                   qty: 200, price: 10, code: 'B1', buyer: 'BUY1' },
    { lot_no: '10', branch: 'MAIN', name: 'PLANTER B', cr: 'CR.27771/2000',         qty:  50, price: 20, code: 'B2', buyer: 'BUY2' },
    { lot_no: '11', branch: 'WEST', name: 'DEALER X',  cr: 'GSTIN.32AAHCE4551A1Z8', qty: 150, price: 30, code: 'B2', buyer: 'BUY2' },
    { lot_no: '12', branch: 'WEST', name: 'PLANTER C', cr: 'CR.',                   qty:  80, price:  0, code: 'WD', buyer: 'BUY3' },
    { lot_no: '13', branch: 'WEST', name: 'PLANTER C', cr: 'CR.',                   qty:  70, price:  0, code: 'NA', buyer: ''     },
  ];
  for (const s of seed) {
    const r = await api('POST', '/api/lots', {
      auction_id: AID, lot_no: s.lot_no, branch: s.branch, name: s.name, cr: s.cr, bags: 1, qty: s.qty,
    });
    if (r.status !== 200 || !r.d || !r.d.lot) {
      console.log(`lot ${s.lot_no} insert failed: ${r.status} ${JSON.stringify(r.d)}`); cleanup(); process.exit(1);
    }
    const u = await api('PUT', `/api/lots/${r.d.lot.id}`, {
      price: s.price, amount: s.qty * s.price, code: s.code, buyer: s.buyer, buyer1: s.buyer,
    });
    if (u.status !== 200) {
      console.log(`lot ${s.lot_no} price update failed: ${u.status} ${JSON.stringify(u.d)}`); cleanup(); process.exit(1);
    }
  }

  // ══ GATE ═════════════════════════════════════════════════════════
  console.log('\n[gate] flag_auction_manager');
  await setFlag('flag_auction_manager', 'false');
  const off = await api('GET', `/api/auction-manager/${AID}`);
  check('OFF → 404 (feature absent, not merely forbidden)', off.status === 404,
        `got ${off.status} ${JSON.stringify(off.d)}`);

  await setFlag('flag_auction_manager', 'true');
  const on = await api('GET', `/api/auction-manager/${AID}`);
  check('ON  → 200', on.status === 200, `got ${on.status} ${JSON.stringify(on.d)}`);

  const missing = await api('GET', `/api/auction-manager/999999`);
  check('unknown trade → 404', missing.status === 404, `got ${missing.status}`);

  // The two gates are independent: this flag must not have granted or
  // revoked the Auction Desk's role capability.
  const desk = await api('GET', `/api/documents/catalog?auctionId=${AID}`);
  check('Auction Desk still reachable for admin (separate gate untouched)',
        desk.status === 200, `got ${desk.status}`);

  // ══ BAND ═════════════════════════════════════════════════════════
  console.log('\n[band] stat arithmetic');
  const s = (on.d && on.d.summary) || {};
  const a = (on.d && on.d.auction) || {};
  check('auction no echoed', String(a.ano) === '13', JSON.stringify(a));
  check('booked lots = 6',      s.bookedLots    === 6,   'got ' + s.bookedLots);
  check('sold lots = 4',        s.soldLots      === 4,   'got ' + s.soldLots);
  check('WD lots = 1',          s.wdLots        === 1,   'got ' + s.wdLots);
  check('NA lots = 1',          s.naLots        === 1,   'got ' + s.naLots);
  check('sold weight = 500',    Math.round(s.soldWeight) === 500, 'got ' + s.soldWeight);
  check('total value = 8500',   Math.round(s.totalValue) === 8500, 'got ' + s.totalValue);
  check('planters = 4 distinct sellers', s.totalPlanters === 4, 'got ' + s.totalPlanters);
  check('buyers = 2 (WD lot’s buyer excluded)', s.totalBuyers === 2, 'got ' + s.totalBuyers);
  check('allocated lots = 14 (range sizes, not row count)', s.allocatedLots === 14,
        'got ' + s.allocatedLots);
  check('booked = sold + WD + NA',
        s.bookedLots === s.soldLots + s.wdLots + s.naLots,
        `${s.bookedLots} vs ${s.soldLots}+${s.wdLots}+${s.naLots}`);

  // ══ ROWS ═════════════════════════════════════════════════════════
  // The table reads /api/lots/:id; the Billing Address column needs the
  // buyer's place resolved from the buyers master.
  console.log('\n[rows] lots feed');
  const rows = await api('GET', `/api/lots/${AID}`);
  const list = Array.isArray(rows.d) ? rows.d : (rows.d && rows.d.rows) || [];
  check('lots endpoint returns all 6', list.length === 6, 'got ' + list.length);
  check('buyer_pla present on the row shape (Billing Address column)',
        list.length > 0 && Object.prototype.hasOwnProperty.call(list[0], 'buyer_pla'),
        list.length ? Object.keys(list[0]).join(',') : 'no rows');

  // ══ ROLE ═════════════════════════════════════════════════════════
  // The flag is per-install, not per-role: an operator has no auction_desk
  // capability but must still reach the Auction Manager.
  console.log('\n[role] operator access');
  const mk = await api('POST', '/api/users', { username: 'op_am', password: 'passw0rd', role: 'operator' });
  if (mk.status === 200) {
    const adminToken = TOKEN;
    const li = await api('POST', '/api/login', { username: 'op_am', password: 'passw0rd' });
    if (li.status === 200 && li.d && li.d.token) {
      TOKEN = li.d.token;
      const opAm   = await api('GET', `/api/auction-manager/${AID}`);
      const opDesk = await api('GET', `/api/documents/catalog?auctionId=${AID}`);
      check('operator reaches Auction Manager (flag is per-install)', opAm.status === 200,
            `got ${opAm.status}`);
      check('operator still denied the Auction Desk (role gate intact)', opDesk.status === 403,
            `got ${opDesk.status}`);
    } else { check('operator sign-in', false, JSON.stringify(li.d)); }
    TOKEN = adminToken;
  } else { check('create operator user', false, JSON.stringify(mk.d)); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog); cleanup(); process.exit(1); });
