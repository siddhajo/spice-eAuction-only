// Document-number RANGE CLAIM — end-to-end HTTP test.
//
// Every batch generate now reserves its numbers BEFORE writing a row
// (doc-numbering.js). Two things have to hold, and they pull in opposite
// directions:
//
//   1. A start that would land on numbers already in the SAME series is
//      refused with 409 + a safe `suggested`, and NOTHING is written. Before
//      this, invoices/purchases/bills accepted any positive integer and wrote
//      a trade full of duplicate numbers — there is no UNIQUE index on any
//      document-number column to catch it afterwards.
//   2. A start that only "collides" in a DIFFERENT series is fine. Sale L #33
//      and sale I #33 are different documents; trade 7's note #5 and trade 8's
//      note #5 are different documents. Over-refusing here would block
//      legitimate runs, which is just as broken as under-refusing.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'docno-http-'));
const PORT = 47421;
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

const GST = '33AAAAA0000A1Z5';   // grade-2 dealer → purchase invoice side
async function makeTrade(ano, date) {
  const r = await api('POST', '/api/auctions', { ano, date, state: 'TAMIL NADU' });
  const aid = r.d && (r.d.id || (r.d.auction && r.d.auction.id));
  if (!aid) { console.error('auction create failed', r.status, r.d); cleanup(); process.exit(1); }
  return aid;
}
// `cr` blank → agriculturist (bill of supply); `cr` set → dealer (purchase).
// POST /api/lots is the pre-trade entry form: it carries no buyer, price or
// amount (those arrive at Price Entry), so they go on in a follow-up PUT.
async function makeLot(aid, lot_no, name, buyer, qty, price, cr) {
  const r = await api('POST', '/api/lots', {
    auction_id: aid, lot_no, name, cr: cr || '', qty,
    grade: cr ? '2' : '1', bags: 10, crop: 'CARDAMOM',
  });
  const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
  if (!lotId) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
  const u = await api('PUT', `/api/lots/${lotId}`, { buyer: buyer || '', price, amount: qty * price });
  if (u.status >= 300) { console.error('lot price update failed', u.status, u.d); cleanup(); process.exit(1); }
  return lotId;
}
async function countRows(url) {
  const r = await api('GET', url);
  const rows = (r.d && (r.d.rows || r.d)) || [];
  return rows.length;
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in\n');

  // ══ SALES INVOICES ═════════════════════════════════════════════════
  // The sales series is GLOBAL per sale type, so the trade a buyer sits in
  // is irrelevant to whether their number is free.
  console.log('[A] Sales invoices — one series per sale type');
  const t1 = await makeTrade('501', '2026-09-01');
  await api('POST', '/api/buyers', { buyer: 'BL', buyer1: 'LOCAL BUYER', sale: 'L' });
  await api('POST', '/api/buyers', { buyer: 'BI', buyer1: 'INTER BUYER', sale: 'I' });
  await makeLot(t1, '1', 'PLANTER ONE', 'BL', 100, 500, '');
  await makeLot(t1, '2', 'PLANTER TWO', 'BI', 100, 500, '');

  const gL = await api('POST', `/api/invoices/generate-all/${t1}`, { startInvoiceNo: 33, saleType: 'L' });
  check('sale L generates from #33', gL.status === 200 && gL.d.generated === 1,
        `${gL.status} ${JSON.stringify(gL.d && (gL.d.error || gL.d.generated))}`);

  const gI = await api('POST', `/api/invoices/generate-all/${t1}`, { startInvoiceNo: 33, saleType: 'I' });
  check('sale I may ALSO start at #33 — a different series, not a collision',
        gI.status === 200 && gI.d.generated === 1,
        `${gI.status} ${JSON.stringify(gI.d && (gI.d.error || gI.d.generated))}`);

  // A second trade, same sale type, re-using the number that is now taken.
  const t2 = await makeTrade('502', '2026-09-02');
  await makeLot(t2, '1', 'PLANTER ONE', 'BL', 100, 500, '');
  const before = await countRows(`/api/invoices?auction_id=${t2}`);
  const clash = await api('POST', `/api/invoices/generate-all/${t2}`, { startInvoiceNo: 33, saleType: 'L' });
  check('re-using #33 in sale L is refused with 409', clash.status === 409,
        `${clash.status} ${JSON.stringify(clash.d)}`);
  check('the refusal names the taken number and a safe start',
        clash.d && Array.isArray(clash.d.collisions) && clash.d.collisions.includes(33) &&
        clash.d.suggested === 34,
        JSON.stringify(clash.d));
  check('and NOTHING was written — the claim ran before the first insert',
        (await countRows(`/api/invoices?auction_id=${t2}`)) === before,
        'rows appeared despite the 409');

  const ok34 = await api('POST', `/api/invoices/generate-all/${t2}`, { startInvoiceNo: 34, saleType: 'L' });
  check('the suggested start goes through', ok34.status === 200 && ok34.d.generated === 1,
        `${ok34.status} ${JSON.stringify(ok34.d && (ok34.d.error || ok34.d.generated))}`);

  // A batch with NO sale-type filter bills each buyer under their own default
  // sale while ONE counter runs across the whole batch. Each series therefore
  // receives a sparse, non-contiguous subset of the numbers — which is the
  // case a plain [start, start+n-1] window gets wrong in both directions.
  console.log('\n[A2] A mixed-sale batch splits its numbers across two series');
  const t3 = await makeTrade('503', '2026-09-07');
  await makeLot(t3, '1', 'PLANTER ONE', 'BI', 100, 500, '');   // sale I
  await makeLot(t3, '2', 'PLANTER TWO', 'BL', 100, 500, '');   // sale L
  const mixed = await api('POST', `/api/invoices/generate-all/${t3}`, { startInvoiceNo: 50 });
  check('the mixed batch generates both invoices', mixed.status === 200 && mixed.d.generated === 2,
        `${mixed.status} ${JSON.stringify(mixed.d && (mixed.d.error || mixed.d.generated))}`);
  // Buyers are walked in buyer-code order, so BI takes #50 (sale I) and
  // BL takes #51 (sale L) — one number in each series, not two in either.
  const byNo = {};
  for (const r of mixed.d.results || []) byNo[r.invoiceNo] = r.sale;
  check('#50 landed in sale I and #51 in sale L', byNo['50'] === 'I' && byNo['51'] === 'L',
        JSON.stringify(mixed.d.results));

  const t4 = await makeTrade('504', '2026-09-08');
  await makeLot(t4, '1', 'PLANTER ONE', 'BI', 100, 500, '');
  const free51 = await api('POST', `/api/invoices/generate-all/${t4}`, { startInvoiceNo: 51, saleType: 'I' });
  check('#51 is still FREE in sale I — it was only ever used in sale L',
        free51.status === 200 && free51.d.generated === 1,
        `${free51.status} ${JSON.stringify(free51.d && (free51.d.error || free51.d.generated))}`);

  const t5 = await makeTrade('505', '2026-09-09');
  await makeLot(t5, '1', 'PLANTER ONE', 'BI', 100, 500, '');
  const busy50 = await api('POST', `/api/invoices/generate-all/${t5}`, { startInvoiceNo: 50, saleType: 'I' });
  check('but #50 IS taken in sale I, and is refused', busy50.status === 409,
        `${busy50.status} ${JSON.stringify(busy50.d)}`);

  // ══ PURCHASE INVOICES ══════════════════════════════════════════════
  // One running series across EVERY trade — a fresh trade does not reset it.
  console.log('\n[B] Purchase invoices — one running series across trades');
  const p1 = await makeTrade('511', '2026-09-03');
  await makeLot(p1, '1', 'AAA TRADERS', '', 100, 500, GST);
  await makeLot(p1, '2', 'BBB TRADERS', '', 100, 500, GST);
  const pg = await api('POST', `/api/purchases/generate-all/${p1}`, { startInvoiceNo: 100 });
  check('first trade takes #100-#101', pg.status === 200 && pg.d.generated === 2,
        `${pg.status} ${JSON.stringify(pg.d && (pg.d.error || pg.d.generated))}`);

  const p2 = await makeTrade('512', '2026-09-04');
  await makeLot(p2, '1', 'CCC TRADERS', '', 100, 500, GST);
  const pBefore = await countRows(`/api/purchases?auction_id=${p2}`);
  const pClash = await api('POST', `/api/purchases/generate-all/${p2}`, { startInvoiceNo: 101 });
  check('a NEW trade starting at #101 is refused — the series is global',
        pClash.status === 409, `${pClash.status} ${JSON.stringify(pClash.d)}`);
  check('nothing was written for the refused purchase run',
        (await countRows(`/api/purchases?auction_id=${p2}`)) === pBefore);
  const pOk = await api('POST', `/api/purchases/generate-all/${p2}`,
    { startInvoiceNo: pClash.d && pClash.d.suggested });
  check('its suggested start goes through', pOk.status === 200 && pOk.d.generated === 1,
        `${pOk.status} ${JSON.stringify(pOk.d && (pOk.d.error || pOk.d.generated))}`);

  // ══ BILLS OF SUPPLY ════════════════════════════════════════════════
  console.log('\n[C] Bills of supply — same running-series rule');
  const b1 = await makeTrade('521', '2026-09-05');
  await makeLot(b1, '1', 'PLANTER AAA', '', 100, 500, '');
  const bg = await api('POST', `/api/bills/generate-all/${b1}`, { startBillNo: 2857 });
  check('first bill takes #2857', bg.status === 200 && bg.d.generated === 1,
        `${bg.status} ${JSON.stringify(bg.d && (bg.d.error || bg.d.generated))}`);

  const b2 = await makeTrade('522', '2026-09-06');
  await makeLot(b2, '1', 'PLANTER BBB', '', 100, 500, '');
  const bBefore = await countRows(`/api/bills?auction_id=${b2}`);
  const bClash = await api('POST', `/api/bills/generate-all/${b2}`, { startBillNo: 2857 });
  check('re-using #2857 is refused with 409', bClash.status === 409,
        `${bClash.status} ${JSON.stringify(bClash.d)}`);
  check('nothing was written for the refused bill run',
        (await countRows(`/api/bills?auction_id=${b2}`)) === bBefore);
  check('it suggests #2858', bClash.d && bClash.d.suggested === 2858, JSON.stringify(bClash.d));

  // ══ PLANTER DEBIT NOTES ════════════════════════════════════════════
  // The opposite scope: PER-TRADE. Trade 522's note #1 must not block
  // trade 521's note #1 — over-refusing here is the regression to watch for,
  // since these two series live in one table keyed only by `ano`.
  console.log('\n[D] Planter debit notes — per-trade series, not global');
  await api('PUT', '/api/company-settings', { settings: { flag_debit_note_planter: 'true' } });
  const d1 = await api('POST', '/api/debit-notes-planter/generate-bulk', { ano: '521', startNoteNo: 1 });
  check('trade 521 numbers its planter DN from #1', d1.status === 200,
        `${d1.status} ${JSON.stringify(d1.d)}`);
  const d2 = await api('POST', '/api/debit-notes-planter/generate-bulk', { ano: '522', startNoteNo: 1 });
  check('trade 522 may ALSO start at #1 — a per-trade series', d2.status === 200,
        `${d2.status} ${JSON.stringify(d2.d)}`);

  const made = (d1.d && d1.d.created) || 0;
  if (made > 0) {
    const dClash = await api('POST', '/api/debit-notes-planter/generate-bulk', { ano: '521', startNoteNo: 1 });
    check('but re-using #1 WITHIN trade 521 is still refused or skipped as done',
          dClash.status === 409 || (dClash.status === 200 && dClash.d.created === 0),
          `${dClash.status} ${JSON.stringify(dClash.d)}`);
  } else {
    // No service charge on the fixture's lots → nothing to number. The
    // per-trade scoping above is still proven; say so rather than assert on
    // a series that was never written.
    console.log('  --   (fixture produced no planter DNs; within-trade reuse not exercised)');
  }

  // ══ BAD INPUT ══════════════════════════════════════════════════════
  console.log('\n[E] A start number that is not a positive integer');
  const bad = await api('POST', `/api/bills/generate-all/${b2}`, { startBillNo: 0 });
  check('zero is refused with 400', bad.status === 400, `${bad.status} ${JSON.stringify(bad.d)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
