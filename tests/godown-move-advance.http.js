// Godown — advances against stored stock, and releasing it into a trade.
//
// Two things the client asked for, and they are one mechanism: money is paid
// against goods sitting in the godown, and recovered when those goods are
// eventually sold. The rules that make that honest:
//
//   BALANCE   a godown lot row holds what is IN STORE NOW. Releasing stock
//             decrements it, so `lots.qty` on a godown row is the balance and
//             no existing reader had to be taught a new rule. The received
//             figure comes back by adding the movements.
//   ADVANCE   lives in lot_advances against the godown entry — the SAME store
//             the lot-wise Payments screen writes, so nothing new nets it off.
//             On a release the operator says how much rides along; that share
//             becomes the new lot's advance and the ordinary payable readers
//             recover it from the sale. The rest stays against the stock.
//   UNDO      deleting a released lot puts the stock AND the advance back.
//             Without that, deleting it would evaporate goods the seller has
//             in store and quietly write off money the house is owed.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'godown-mv-'));
const PORT = 47390;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + JSON.stringify(detail) : '')); }
}

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) { let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, d }; }
  return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
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
const stockOf = async (lotNo) => {
  const r = await api('GET', '/api/godown/stock');
  return ((r.d && r.d.rows) || []).find(x => x.lot_no === lotNo);
};

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', flag_godown: 'true', flag_lotwise_payments: 'true',
    godown_lot_prefix: 'G', sample_weight: '0.5',
  }});
  // Two trades: stock is stored against one and released into the other,
  // which is the real case — goods stored in October sell in November.
  await api('POST', '/api/auctions', { ano: '1', date: '2026-10-12', crop_type: 'ISP' });
  await api('POST', '/api/auctions/1/allocations', { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  await api('POST', '/api/auctions', { ano: '2', date: '2026-10-19', crop_type: 'ISP' });
  await api('POST', '/api/auctions/2/allocations', { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  await api('POST', '/api/traders', { name: 'RAVI PLANTER', tel: '9790744444', ppla: 'BODI' });
  await api('POST', '/api/traders/1/banks', { bank_name: 'SBI', acctnum: '123456789012', ifsc: 'SBIN0001234', holder_name: 'RAVI PLANTER', is_default: 1 });
  const banksRes = await api('GET', '/api/traders/1/banks');
  const bankList = Array.isArray(banksRes.d) ? banksRes.d : (banksRes.d && banksRes.d.banks) || [];
  const bankId = bankList[0] && bankList[0].id;

  let r = await api('POST', '/api/lots', { auction_id: 1, trader_id: 1, branch: 'BODI',
    grade: '1', bags: 18, litre: '300', qty: 180.5, sample_wt: 0, gross_wt: 180.5, godown: 1 });
  const g = r.d.lot;
  check('a godown entry exists to work against', g && g.lot_no === 'G001', r.d);

  console.log('[1] Paying an advance against stored stock');
  // Deliberately the SAME endpoint the lot-wise Payments screen uses: the
  // godown screen is a different view onto one money path, not a second one.
  r = await api('POST', '/api/payments/lots/1/advance', { items: [{ lotId: g.id, advance: 50000, bankId }] });
  check('the advance saves against the godown entry', r.status === 200 && r.d.saved === 1, r.d);
  let s = await stockOf('G001');
  check('…and the stock list reports it outstanding', s && s.advance === 50000, s);
  check('…with the stock still whole', s && s.qty === 180.5 && s.bags === 18 && s.moved_qty === 0, s);

  console.log('\n[2] Releasing PART of it into another trade');
  r = await api('POST', '/api/godown/move', { lot_id: g.id, auction_id: 2, lot_no: '007',
    branch: 'BODI', bags: 10, qty: 100, recover_advance: 27700.83 });
  check('the move is accepted', r.status === 200 && r.d.success, r.d);
  const moved = r.d.lot;
  check('an ordinary auction lot is created in the destination trade',
        moved && moved.lot_no === '007' && Number(moved.auction_id) === 2 && !Number(moved.godown), moved);
  // The released figure is the weight LEAVING THE GODOWN, so it is the new
  // lot's GROSS and the sample comes OUT of it: move 100 → gross 100,
  // sample 0.5, net 99.5. It used to read the figure as the net and add the
  // sample on top (gross 100.5), which invented 0.5 kg that never left the
  // store — the destination lot and the stock it came from disagreed by one
  // sample on every move. Changed 2026-10-26 at the operator's description.
  check('the released weight becomes the lot\'s GROSS',
        moved && Number(moved.gross_wt) === 100 && Number(moved.bags) === 10, moved);
  check('…with the install\'s sample drawn OUT of it, not added on top',
        moved && Number(moved.sample_wt) === 0.5 && Number(moved.qty) === 99.5, moved);
  check('the seller travels with it', moved && moved.name === 'RAVI PLANTER' && Number(moved.trader_id) === 1, moved);

  s = await stockOf('G001');
  check('the godown balance drops by exactly what left',
        s && s.qty === 80.5 && s.bags === 8, s);
  check('…while RECEIVED still reports what was handed in',
        s && s.received_qty === 180.5 && s.received_bags === 18, s);
  check('…and the entry says how much has moved', s && s.moved_qty === 100 && s.move_count === 1, s);

  console.log('\n[3] The advance follows the stock it was paid against');
  check('the share the operator chose is left on the godown entry',
        s && s.advance === 22299.17, s && { advance: s.advance });
  r = await api('GET', '/api/payments/lots/2');
  const destRow = ((r.d && r.d.lots) || []).find(x => x.lot_no === '007');
  check('…and the rest rides on the new lot, where the sale recovers it',
        destRow && Number(destRow.advance) === 27700.83, destRow);

  console.log('\n[4] The rails on a release');
  r = await api('POST', '/api/godown/move', { lot_id: g.id, auction_id: 2, lot_no: '008', bags: 1, qty: 200 });
  check('more weight than is in store is refused',
        r.status === 400 && /Only 80\.500 kg is left/.test((r.d && r.d.error) || ''), r.d);
  r = await api('POST', '/api/godown/move', { lot_id: g.id, auction_id: 2, lot_no: '008', bags: 99, qty: 1 });
  check('more bags than are in store is refused',
        r.status === 400 && /Only 8 bag/.test((r.d && r.d.error) || ''), r.d);
  r = await api('POST', '/api/godown/move', { lot_id: g.id, auction_id: 2, lot_no: '007', bags: 1, qty: 1 });
  check('a lot number already taken in the destination is refused',
        r.status === 409 && /already exists/.test((r.d && r.d.error) || ''), r.d);
  r = await api('POST', '/api/godown/move', { lot_id: g.id, auction_id: 2, lot_no: '099', bags: 1, qty: 1 });
  check('a number outside the destination allocation is refused',
        r.status === 400 && /outside BODI allocation/.test((r.d && r.d.error) || ''), r.d);
  r = await api('POST', '/api/godown/move', { lot_id: g.id, auction_id: 2, lot_no: '008', bags: 1, qty: 1, recover_advance: 999999 });
  check('recovering more advance than is outstanding is refused',
        r.status === 400 && /outstanding as advance/.test((r.d && r.d.error) || ''), r.d);
  s = await stockOf('G001');
  check('…and after every refusal the stock is untouched',
        s && s.qty === 80.5 && s.bags === 8 && s.advance === 22299.17, s);

  console.log('\n[5] Released stock is an ordinary lot from that moment');
  r = await api('GET', '/api/lots/2?godown=0');
  check('it is listed as an auction lot of the destination trade',
        (r.d || []).some(l => l.lot_no === '007'), (r.d || []).map(l => l.lot_no));
  r = await api('GET', '/api/registers/godown?auctionId=1');
  const reg = (r.d || []).find(x => x.lot === 'G001');
  check('the register reconciles: received − moved = balance',
        reg && reg.recd_qty === 180.5 && reg.moved_qty === 100 && reg.qty === 80.5, reg);

  console.log('\n[6] Releasing the remainder empties the entry');
  r = await api('POST', '/api/godown/move', { lot_id: g.id, auction_id: 2, lot_no: '008',
    branch: 'BODI', bags: 8, qty: 80.5, recover_advance: 22299.17 });
  check('the last release goes through', r.status === 200, r.d);
  s = await stockOf('G001');
  check('the entry is emptied and closed', s && s.qty === 0 && s.bags === 0 && s.closed === true, s);
  check('with no advance left standing against it', s && s.advance === 0, s);
  r = await api('GET', '/api/godown/stock?open=1');
  check('…so it drops out of the in-store list',
        !((r.d && r.d.rows) || []).some(x => x.lot_no === 'G001'), (r.d && r.d.rows || []).map(x => x.lot_no));

  console.log('\n[7] Deleting a released lot is the move\'s undo');
  r = await api('GET', '/api/lots/2?godown=0');
  const lot008 = (r.d || []).find(l => l.lot_no === '008');
  r = await api('DELETE', '/api/lots/' + lot008.id);
  check('the delete reports what it put back', r.status === 200 && r.d.godown_restored, r.d);
  s = await stockOf('G001');
  check('the stock is back in the godown', s && s.qty === 80.5 && s.bags === 8, s);
  check('…and so is the advance that rode along',
        s && s.advance === 22299.17, s && { advance: s.advance });
  r = await api('GET', '/api/godown/movements?lotId=' + g.id);
  check('…and the release is gone from the history',
        (r.d || []).length === 1 && r.d[0].dest_lot_no === '007', (r.d || []).map(m => m.dest_lot_no));

  console.log('\n[8] Deleting the godown ENTRY itself');
  // The opposite direction from [7]: the store record goes, the goods that
  // already left it do not. Deleting the entry must not delete lots somebody
  // has since bought.
  r = await api('POST', '/api/lots', { auction_id: 1, trader_id: 1, branch: 'BODI',
    grade: '1', bags: 4, litre: '300', qty: 40, sample_wt: 0, gross_wt: 40, godown: 1 });
  const g2 = r.d.lot;
  r = await api('POST', '/api/godown/move', { lot_id: g2.id, auction_id: 2, lot_no: '011',
    branch: 'BODI', bags: 1, qty: 10 });
  check('a second entry releases part of itself', r.status === 200, r.d);
  r = await api('POST', '/api/lots/bulk-delete', { ids: [g2.id] });
  check('the entry deletes', r.status === 200 && r.d.deleted === 1, r.d);
  r = await api('GET', '/api/godown/stock');
  check('…and is gone from the stock list',
        !((r.d && r.d.rows) || []).some(x => x.id === g2.id), (r.d && r.d.rows || []).map(x => x.lot_no));
  r = await api('GET', '/api/lots/2?godown=0');
  check('…while the lot it already released is KEPT',
        (r.d || []).some(l => l.lot_no === '011'), (r.d || []).map(l => l.lot_no));
  r = await api('GET', '/api/godown/movements');
  check('…and its release history goes with it',
        !(r.d || []).some(m => Number(m.src_lot_id) === Number(g2.id)), (r.d || []).map(m => m.src_lot_id));

  console.log('\n[9] Stored stock still never reaches the auction\'s own numbers');
  r = await api('GET', '/api/auctions?limit=5');
  const a1 = (Array.isArray(r.d) ? r.d : (r.d && r.d.rows) || []).find(a => Number(a.id) === 1);
  check('the storing trade counts no lots of its own', a1 && Number(a1.lot_count) === 0, a1 && { lot_count: a1.lot_count });
  // Two by now: lot 007 from [2], and lot 011 whose source entry was deleted
  // in [8] — a released lot stands on its own once it has left the godown.
  const a2 = (Array.isArray(r.d) ? r.d : (r.d && r.d.rows) || []).find(a => Number(a.id) === 2);
  check('the receiving trade counts the released lots', a2 && Number(a2.lot_count) === 2, a2 && { lot_count: a2.lot_count });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-25).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
