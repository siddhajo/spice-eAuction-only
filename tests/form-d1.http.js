// FORM-D1 (Depot-wise Auction Summary) — surfaced under Reports → Spice Board.
//
// The builder, JSON/XLSX/PDF renderers and the /api/spice-board-reports
// dispatcher entry already existed; the report simply had no UI entry, so no
// operator could reach it and the document catalog reported it unreachable.
//
// What this pins down is the arithmetic the Board is told, because the two
// figures per section are DIFFERENT measures and getting them to agree by
// accident is the easy mistake:
//   (a) put for sale — EVERY booked lot, priced or not, withdrawn or not
//   (b) sold         — only lots that fetched a price and were not WD
// Reporting (b) as the sum of the (a) rows would overstate the sale.
//
// The Traders / Growers split is hasValidGstin() — the same rule Form C uses
// for PLANTERS / DEALERS, so the two forms can never disagree about a seller.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'formd1-'));
const PORT = 47374;
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
async function raw(url) {
  const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: r.status, type: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const done = c => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(c);
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  console.log('FORM-D1 — Depot-wise Auction Summary');

  const auc = await api('POST', '/api/auctions', { ano: '91', date: '2026-09-13', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // Two sellers: one with a real GSTIN (a TRADER), one with a CR code (a GROWER).
  const TRADER = { name: 'DEALER ONE', cr: '33AAAAA1111A1Z5' };
  const GROWER = { name: 'PLANTER ONE', cr: 'CR/1234' };
  for (const t of [TRADER, GROWER]) await api('POST', '/api/traders', t);
  const tl = await api('GET', '/api/traders?search=ONE');
  const ids = {};
  for (const r of (Array.isArray(tl.d) ? tl.d : tl.d.rows)) ids[r.name] = r.id;

  // Lots across two depots. `sold` differs from `put` in exactly two ways:
  // one WD lot and one never-priced lot — both are put for sale, neither sold.
  //   BODI  : trader 100 (sold) + 50 (WD)      → put 150, sold 100
  //           grower 200 (sold)                 → put 200, sold 200
  //   MUNNAR: trader 300 (unpriced)             → put 300, sold   0
  //           grower  80 (sold) + 20 (sold)     → put 100, sold 100
  const lots = [
    ['1', 'DEALER ONE',  'BODI',   100, 1000, ''],
    ['2', 'DEALER ONE',  'BODI',    50, 1000, 'WD'],
    ['3', 'PLANTER ONE', 'BODI',   200, 1000, ''],
    ['4', 'DEALER ONE',  'MUNNAR', 300,    0, ''],
    ['5', 'PLANTER ONE', 'MUNNAR',  80, 1000, ''],
    ['6', 'PLANTER ONE', 'MUNNAR',  20, 1000, ''],
  ];
  for (const [lot_no, name, branch, qty, price, code] of lots) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name, trader_id: ids[name], qty, branch });
    const lid = r.d.id || (r.d.lot && r.d.lot.id);
    // `code` is the buyer code column AND the withdrawal marker ('WD') — the
    // same column getReportContext's price gate reads.
    await api('PUT', `/api/lots/${lid}`, {
      buyer: 'BUY1', buyer1: 'BUYER ONE', code: code || 'BUY1', branch, qty,
      price, amount: price * qty, bags: 5, sale: 'L',
    });
  }
  // Prove the fixture is what the assertions assume before trusting them.
  const seeded = await api('GET', `/api/lots/${aid}`);
  const sl = (Array.isArray(seeded.d) ? seeded.d : (seeded.d.rows || []));
  // 4 of the 6 carry money: lot 4 was never priced, and marking lot 2 WD makes
  // the app zero its amount as well — so the report's WD test is belt-and-
  // braces over the amount test, not the only thing keeping it out of (b).
  check('fixture: amounts and the WD marker actually landed',
    sl.filter(l => Number(l.amount) > 0).length === 4 &&
    sl.filter(l => String(l.code).toUpperCase() === 'WD').length === 1,
    JSON.stringify(sl.map(l => ({ lot: l.lot_no, qty: l.qty, amt: l.amount, code: l.code, br: l.branch }))));

  // ── The JSON the preview caption and the renderers share ──
  const d = await api('GET', `/api/spice-board-reports/form_d1/data?auctionId=${aid}`);
  check('form_d1 /data answers', d.status === 200 && !!d.d, `${d.status} ${JSON.stringify(d.d).slice(0, 200)}`);
  const j = d.d || {};
  check('title names the form', /FORM\s*-?\s*D1/i.test(j.title || ''), j.title);
  check('auction number rides along', (j.auction || {}).ano === '91', JSON.stringify(j.auction));
  check('two sections — Traders then Growers', (j.sections || []).length === 2,
    JSON.stringify((j.sections || []).map(s => s.title)));

  const [traders, growers] = j.sections || [];
  const byDepot = (sec) => Object.fromEntries((sec.rows || []).map(r => [r.depot, r.qty]));
  const tRows = byDepot(traders || {}), gRows = byDepot(growers || {});

  check('trader put-for-sale is per depot and includes the WD lot',
    tRows.BODI === 150 && tRows.MUNNAR === 300, JSON.stringify(tRows));
  check('grower put-for-sale is per depot', gRows.BODI === 200 && gRows.MUNNAR === 100, JSON.stringify(gRows));

  // (b) is NOT the sum of the (a) rows — that is the whole point.
  check('trader SOLD excludes the WD lot and the unpriced lot',
    (traders.totals || {}).qty === 100, JSON.stringify(traders.totals));
  check('grower SOLD counts every priced, non-WD lot',
    (growers.totals || {}).qty === 300, JSON.stringify(growers.totals));
  check('sold is strictly less than put where lots were withdrawn/unpriced',
    (traders.totals.qty) < (tRows.BODI + tRows.MUNNAR),
    `${traders.totals.qty} vs ${tRows.BODI + tRows.MUNNAR}`);

  check('grand total is every booked lot, whatever its fate',
    (j.grand || {}).qty === 750, JSON.stringify(j.grand));

  // Both sections list the SAME depots, so a depot with no trader lots still
  // prints a zero row instead of shifting the other section's rows.
  check('both sections carry the same depot list, in the same order',
    JSON.stringify((traders.rows || []).map(r => r.depot)) ===
    JSON.stringify((growers.rows || []).map(r => r.depot)),
    JSON.stringify([(traders.rows || []).map(r => r.depot), (growers.rows || []).map(r => r.depot)]));

  // ── Branch filter (the one filter the screen offers) ──
  const bodi = await api('GET', `/api/spice-board-reports/form_d1/data?auctionId=${aid}&branch=BODI`);
  const bj = bodi.d || {};
  check('?branch= narrows to that depot', (bj.sections || [])[0].rows.length === 1 &&
    bj.sections[0].rows[0].depot === 'BODI', JSON.stringify(bj.sections && bj.sections[0].rows));
  check('and the totals follow the filter', (bj.grand || {}).qty === 350, JSON.stringify(bj.grand));

  // ── Both download formats actually render ──
  const xlsx = await raw(`/api/spice-board-reports/form_d1/export?format=xlsx&auctionId=${aid}`);
  check('XLSX renders', xlsx.status === 200 && xlsx.buf.length > 1000 &&
    xlsx.buf.slice(0, 2).toString('binary') === 'PK', `${xlsx.status} ${xlsx.buf.length} ${xlsx.type}`);
  const pdf = await raw(`/api/spice-board-reports/form_d1/export?format=pdf&auctionId=${aid}`);
  check('PDF renders', pdf.status === 200 && pdf.buf.slice(0, 4).toString('binary') === '%PDF',
    `${pdf.status} ${pdf.buf.length} ${pdf.type}`);

  // ── Reachable from the document catalog (it was not, before) ──
  const cat = await api('GET', `/api/documents/catalog?auctionId=${aid}`);
  const flat = {};
  for (const g of (cat.d && cat.d.groups) || []) for (const it of g.items) flat[it.id] = it;
  const entry = flat.form_d1;
  check('form_d1 has a catalog entry', !!entry, `catalog ids: ${Object.keys(flat).join(',')}`);
  if (entry) {
    check('catalog entry offers both formats',
      (entry.formats || []).includes('pdf') && (entry.formats || []).includes('xlsx'), JSON.stringify(entry.formats));
    check('catalog entry offers no seller/buyer filter',
      !(entry.filters || []).includes('sellerId') && !(entry.filters || []).includes('buyerCode'),
      JSON.stringify(entry.filters));
  }

  // A depot-less lot must be shown, not dropped, or the tally stops reconciling.
  const nb = await api('POST', '/api/lots', { auction_id: aid, lot_no: '7', name: 'PLANTER ONE', trader_id: ids['PLANTER ONE'], qty: 40 });
  const nbid = nb.d.id || (nb.d.lot && nb.d.lot.id);
  await api('PUT', `/api/lots/${nbid}`, { buyer: 'BUY1', buyer1: 'BUYER ONE', qty: 40, price: 1000, amount: 40000, bags: 2, sale: 'L' });
  const d2 = await api('GET', `/api/spice-board-reports/form_d1/data?auctionId=${aid}`);
  const depots2 = (d2.d.sections[1].rows || []).map(r => r.depot);
  check('a lot with no depot is shown under "(no depot)", not dropped',
    depots2.includes('(no depot)'), JSON.stringify(depots2));
  check('and the grand total absorbs it', d2.d.grand.qty === 790, JSON.stringify(d2.d.grand));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); done(1); });
