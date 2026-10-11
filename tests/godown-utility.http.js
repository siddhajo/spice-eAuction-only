// Godown utility (flag_godown) — the server side.
//
// The house rents godown space to the same planters it auctions for, so at the
// scale an operator is doing one of two things: booking the lot into the trade,
// or taking the goods in for STORAGE. The second is a real receipt — seller,
// bags, weight — that was never put up for sale, and that distinction has to
// survive everywhere downstream. Two properties carry the whole feature:
//
//   NUMBERING  a godown row takes its number from its own per-trade series
//              (G001, G002 …) OUTSIDE the trade's allocated ranges, so storing
//              goods never burns a lot number a bidder could have bought — and
//              the allocation check, which would refuse exactly those numbers,
//              is skipped for them.
//   EXCLUSION  every money and statutory reader skips a godown row the way it
//              skips a reserved (held) lot. Carry-forward is the one that bites
//              hardest: a godown row has no buyer code, so without the filter
//              next week's trade inherits the stored stock as unsold lots.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'godown-'));
const PORT = 47388;
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

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', br2: 'CUMBUM', flag_godown: 'true', godown_lot_prefix: 'G',
  }});
  await api('POST', '/api/auctions', { ano: '1', date: '2026-10-11', crop_type: 'ISP' });
  // BODI is allocated 001-010 — a godown number must fall outside it and still save.
  await api('POST', '/api/auctions/1/allocations', {
    allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '010' }],
  });
  await api('POST', '/api/traders', { name: 'RAVI PLANTER', tel: '9790744444', ppla: 'BODI' });

  console.log('[1] Numbering — the godown series, outside the allocation');
  let r = await api('GET', '/api/auctions/1/next-godown-lot');
  check('an empty trade starts at G001', r.d && r.d.next_lot === 'G001', r.d);

  r = await api('POST', '/api/lots', { auction_id: 1, lot_no: '001', trader_id: 1, branch: 'BODI',
    grade: '1', bags: 10, litre: '300', qty: 100.5, sample_wt: 0, gross_wt: 100.5 });
  check('a normal booking still saves, and is not a godown row',
        r.status === 200 && r.d.lot.lot_no === '001' && !Number(r.d.lot.godown), r.d && r.d.lot);

  // The phone sends no lot_no at all (the previewed number would race another
  // operator), so the server is the one that has to assign it.
  r = await api('POST', '/api/lots', { auction_id: 1, trader_id: 1, branch: 'BODI',
    grade: '1', bags: 18, litre: '300', qty: 180.5, sample_wt: 0, gross_wt: 180.5, godown: 1 });
  check('a godown entry with no lot_no is numbered G001', r.status === 200 && r.d.lot.lot_no === 'G001', r.d);
  check('and is stored as a godown row', r.status === 200 && Number(r.d.lot.godown) === 1, r.d && r.d.lot);
  const g1 = r.d.lot.id;

  r = await api('POST', '/api/lots', { auction_id: 1, trader_id: 1, branch: 'BODI',
    grade: '2', bags: 5, litre: '290', qty: 49.25, sample_wt: 0, gross_wt: 49.25, godown: 1 });
  check('the next one is G002', r.status === 200 && r.d.lot.lot_no === 'G002', r.d);
  const g2 = r.d.lot.id;
  r = await api('GET', '/api/auctions/1/next-godown-lot');
  check('the series advances to G003', r.d && r.d.next_lot === 'G003', r.d);

  console.log('\n[2] The Godown Register is the one reader that looks FOR them');
  r = await api('GET', '/api/registers/godown?auctionId=1');
  check('it lists both godown entries and no bookings',
        Array.isArray(r.d) && r.d.length === 2 && r.d.every(x => String(x.lot).startsWith('G')), r.d);
  check('with bags and both weights (no price — nothing was sold)',
        r.d[0] && r.d[0].bag === 18 && r.d[0].qty === 180.5 && r.d[0].gross_wt === 180.5 && r.d[0].price === undefined,
        r.d[0]);
  r = await api('GET', '/api/registers/godown?auctionId=1&branch=CUMBUM');
  check('the depot filter excludes other depots', Array.isArray(r.d) && r.d.length === 0, r.d);
  r = await api('GET', '/api/registers/godown?auctionId=1&branch=BODI');
  check('and keeps the right one', Array.isArray(r.d) && r.d.length === 2, r.d);
  r = await api('GET', '/api/exports/godown-register?auctionId=1&format=xlsx');
  check('it exports as XLSX', r.status === 200 && r.bytes > 3000, r);
  r = await api('GET', '/api/exports/godown-register?auctionId=1&format=pdf');
  check('…and as PDF', r.status === 200 && r.bytes > 2000, r);
  r = await api('GET', '/api/exports/godown-register?auctionId=1&format=pdf&branch=BODI');
  check('…honouring the depot filter on the PDF too', r.status === 200 && r.bytes > 2000, r);

  console.log('\n[3] Exclusion — stored stock is not part of the auction');
  r = await api('GET', '/api/registers/purchase?auctionId=1');
  check('the purchase register ignores godown rows',
        Array.isArray(r.d) && r.d.every(x => !String(x.lot).startsWith('G')), r.d);
  // The one that would have hurt: carry-forward moves lots with an empty /
  // 'NA' buyer code into the next trade, and a godown row has exactly that.
  r = await api('GET', '/api/auctions/1/carry-forward-preview');
  check('carry-forward sees only the real unsold lot, not the stored stock',
        r.d && r.d.unsold === 1, r.d);

  console.log('\n[4] Converting between the two kinds is a renumbering');
  r = await api('PUT', '/api/lots/' + g2, { godown: 0 });
  check('godown → booking is refused while it still holds a G-number',
        r.status === 400 && /godown series/i.test((r.d && r.d.error) || ''), r.d);
  r = await api('PUT', '/api/lots/' + g2, { godown: 0, lot_no: '002' });
  check('…and accepted with an auction number', r.status === 200, r.d);
  r = await api('PUT', '/api/lots/' + g2, { godown: 1 });
  check('booking → godown is accepted', r.status === 200, r.d);
  r = await api('GET', '/api/lots/1');
  const back = (r.d || []).find(l => l.id === g2);
  check('it takes a godown number again', back && back.lot_no === 'G002' && Number(back.godown) === 1, back);
  check('releasing the auction number it was holding',
        !(r.d || []).some(l => l.lot_no === '002'), (r.d || []).map(l => l.lot_no));

  console.log('\n[5] The auction\'s own measures and gates ignore stored stock');
  // 1 booking (100.5 kg) + 2 godown rows (180.5 + 49.25) exist at this point,
  // and g2 has just been converted back to a godown row.
  r = await api('GET', '/api/reports/trade-summary/1');
  const bw = (r.d && r.d.branchWise || []).find(x => x.branch === 'BODI');
  check('the trade summary counts the booking only',
        bw && Number(bw.total_qty) === 100.5 && Number(bw.lot_count) === 1, bw);
  r = await api('GET', '/api/auctions/1/depot-summary');
  const ds = r.d && (r.d.stats || r.d);
  check('the depot summary\'s crop weight is the auctioned weight',
        ds && Number(ds.cropWeight) === 100.5, ds && { cropWeight: ds.cropWeight, booked: ds.booked });
  // Lots table / Price Entry ask for bookings; the Lot Entry recent panel and
  // every older caller send nothing and still see everything.
  r = await api('GET', '/api/lots/1?godown=0');
  check('the lots list can exclude stored stock', Array.isArray(r.d) && r.d.length === 1, (r.d||[]).map(l=>l.lot_no));
  r = await api('GET', '/api/lots/1?godown=1');
  check('…or show only stored stock', Array.isArray(r.d) && r.d.length === 2, (r.d||[]).map(l=>l.lot_no));
  r = await api('GET', '/api/lots/1');
  check('…and with no filter it is unchanged — three rows, as before',
        Array.isArray(r.d) && r.d.length === 3, (r.d||[]).map(l=>l.lot_no));
  r = await api('GET', '/api/lots/1?summary=1&godown=0');
  check('the totals strip matches the filtered list',
        r.d && r.d.n === 1 && Number(r.d.qty) === 100.5, r.d);

  // Saving allocations re-validates every entered lot against the new ranges.
  // A godown number is outside them BY DESIGN, so including it here would
  // refuse every allocation change on a trade that has taken goods in.
  r = await api('POST', '/api/auctions/1/allocations', {
    allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }],
  });
  check('allocations can still be saved with stored stock on the trade',
        r.status === 200 && !(r.d && r.d.error), r.d);
  r = await api('GET', '/api/auctions/1/allocation-stats');
  const bodi = (r.d && r.d.stats || []).find(x => x.branch === 'BODI');
  check('and the allocation grid counts only the auction number as used',
        bodi && bodi.used === 1 && bodi.total === 20, bodi);

  // The Validate Lots gate clears a trade for PRICE IMPORT; stored stock is
  // never priced, so it must not be held up for (or by) it.
  r = await api('GET', '/api/auctions?limit=5');
  const a1 = (Array.isArray(r.d) ? r.d : (r.d && r.d.rows) || []).find(a => Number(a.id) === 1);
  check('the trade\'s lot count is its auction lots, not its stored stock',
        a1 && Number(a1.lot_count) === 1, a1 && { ano: a1.ano, lot_count: a1.lot_count });

  r = await api('GET', '/api/lots/validate/1');
  const flagged = JSON.stringify(r.d || {});
  check('lot validation ignores godown rows', r.status === 200 && !/G00\d/.test(flagged), flagged.slice(0, 300));

  console.log('\n[6] The flag only governs the UI — stored rows stay excluded');
  await api('PUT', '/api/company-settings', { settings: { flag_godown: 'false' } });
  r = await api('GET', '/api/registers/purchase?auctionId=1');
  check('turning the feature off does not let godown rows back into the money readers',
        Array.isArray(r.d) && r.d.every(x => !String(x.lot).startsWith('G')), r.d);
  r = await api('GET', '/api/auctions/1/carry-forward-preview');
  check('nor into carry-forward', r.d && r.d.unsold === 1, r.d);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-25).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
