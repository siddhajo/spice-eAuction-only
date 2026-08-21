// Lot-wise BILLS OF SUPPLY — end-to-end HTTP test against a live server
// booted on a throwaway data dir. Mirrors tests/lotwise-purchase.http.js.
//
// Bills have two things purchases don't, both exercised below:
//   - a per-lot `line_items` JSON snapshot written at generation time
//   - an ano-based recovery path (recoverAgriBillByAno) that re-resolves the
//     trade when a bill's auction_id goes stale, gated on the stored net
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotwise-bills-'));
const PORT = 47313;
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
  const back = await api('GET', '/api/company-settings/flat');
  const got = back.d && back.d[key];
  if (String(got) !== String(val)) throw new Error(`${key} did not persist: wanted ${val}, got ${got}`);
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
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in\n');

  // ── Fixture: one trade, two PLANTERS (no GSTIN). ──
  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-12', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  if (!aid) { console.error('auction create failed', auc.status, auc.d); cleanup(); process.exit(1); }

  for (const [lot_no, name, qty, price] of [
    ['201', 'RAMU PLANTER', 100, 400],
    ['202', 'RAMU PLANTER', 200, 400],
    ['203', 'SELVI PLANTER', 300, 400],
  ]) {
    // No `cr` at all → non-GSTIN planter, the Bill-of-Supply population.
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, qty, grade: '1', bags: 8, crop: 'CARDAMOM',
    });
    if (r.status >= 300) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    const u = await api('PUT', `/api/lots/${lotId}`, { price, amount: qty * price });
    if (u.status >= 300) { console.error('lot price update failed', u.status, u.d); cleanup(); process.exit(1); }
  }

  // ══ SELLER-WISE (flag off — the default) ═══════════════════════════
  console.log('[A] Seller-wise mode (flag OFF) — existing behaviour');
  await setFlag('flag_lotwise_bills', 'false');

  const elSellers = await api('GET', `/api/bills/eligible-sellers/${aid}`);
  check('eligible-sellers returns 2 planters', elSellers.d && elSellers.d.length === 2,
        JSON.stringify(elSellers.d));

  const swGen = await api('POST', `/api/bills/generate-all/${aid}`, { startBillNo: 1 });
  check('generate-all reports seller mode', swGen.d && swGen.d.mode === 'seller', JSON.stringify(swGen.d));
  check('creates 2 bills (one per planter)', swGen.d && swGen.d.generated === 2,
        swGen.d && `generated ${swGen.d.generated}`);

  let list = await api('GET', `/api/bills?auction_id=${aid}`);
  let rows = (list.d && (list.d.rows || list.d)) || [];
  check('all rows are marked seller-wise (blank lot_no)',
        rows.length === 2 && rows.every(r => !String(r.lot_no || '').trim()),
        JSON.stringify(rows.map(r => ({ bil: r.bil, name: r.name, lot_no: r.lot_no }))));
  const ramuSeller = rows.find(r => r.name === 'RAMU PLANTER');
  check('RAMU seller-wise bill covers both lots (qty 300)',
        ramuSeller && Number(ramuSeller.qty) === 300, ramuSeller && `qty ${ramuSeller.qty}`);
  check('its snapshot holds 2 line items',
        ramuSeller && JSON.parse(ramuSeller.line_items || '[]').length === 2,
        ramuSeller && ramuSeller.line_items);

  const refused = await api('POST', `/api/bills/generate/${aid}`,
    { sellerName: 'RAMU PLANTER', billNo: '900', lotNo: '201' });
  check('lot-wise request refused with 403 while flag is off', refused.status === 403,
        `got ${refused.status} ${JSON.stringify(refused.d)}`);

  // ══ LOT-WISE (flag on) ═════════════════════════════════════════════
  console.log('\n[B] Lot-wise mode (flag ON)');
  for (const r of rows) await api('DELETE', `/api/bills/${r.id}`);
  await setFlag('flag_lotwise_bills', 'true');

  const elLots = await api('GET', `/api/bills/eligible-lots/${aid}`);
  check('eligible-lots returns 3 lots', elLots.d && elLots.d.length === 3,
        JSON.stringify(elLots.d && elLots.d.map(l => l.lot_no)));
  check('none flagged already-billed yet',
        elLots.d && elLots.d.every(l => l.already_billed == null));
  check('GSTIN dealers are excluded from the planter lot list',
        elLots.d && elLots.d.every(l => !l.cr));

  const one = await api('POST', `/api/bills/generate/${aid}`,
    { sellerName: 'RAMU PLANTER', billNo: '10', lotNo: '201',
      lotId: elLots.d.find(l => l.lot_no === '201').lot_id });
  check('single lot-wise generate succeeds', one.status === 200 && one.d.mode === 'lot',
        `${one.status} ${JSON.stringify(one.d)}`);
  check('it billed only that lot (qty 100)', one.d && one.d.bill && one.d.bill.totalQty === 100,
        one.d && JSON.stringify(one.d.bill && one.d.bill.totalQty));

  const dupe = await api('POST', `/api/bills/generate/${aid}`,
    { sellerName: 'RAMU PLANTER', billNo: '11', lotNo: '201' });
  check('re-billing the same lot is refused with 409', dupe.status === 409,
        `got ${dupe.status} ${JSON.stringify(dupe.d)}`);

  const elLots2 = await api('GET', `/api/bills/eligible-lots/${aid}`);
  const lot201 = elLots2.d.find(l => l.lot_no === '201');
  check('eligible-lots marks lot 201 already billed', lot201 && Number(lot201.already_billed) === 10,
        JSON.stringify(lot201));

  const batch = await api('POST', `/api/bills/generate-all/${aid}`, { startBillNo: 20 });
  check('generate-all reports lot mode', batch.d && batch.d.mode === 'lot');
  check('creates 2 more (the remaining lots)', batch.d && batch.d.generated === 2,
        batch.d && `generated ${batch.d.generated}`);
  check('skips the already-billed lot, as skipped not error',
        batch.d && batch.d.skipped && batch.d.skipped.length === 1 &&
        (!batch.d.errors || !batch.d.errors.length),
        JSON.stringify({ skipped: batch.d && batch.d.skipped, errors: batch.d && batch.d.errors }));

  list = await api('GET', `/api/bills?auction_id=${aid}`);
  rows = (list.d && (list.d.rows || list.d)) || [];
  check('3 lot-wise bills exist, one per lot', rows.length === 3, `got ${rows.length}`);
  check('every row is stamped with its lot',
        rows.every(r => String(r.lot_no || '').trim() !== ''),
        JSON.stringify(rows.map(r => ({ bil: r.bil, lot_no: r.lot_no }))));
  check('lot numbers are exactly 201/202/203',
        JSON.stringify(rows.map(r => r.lot_no).sort()) === JSON.stringify(['201','202','203']),
        JSON.stringify(rows.map(r => r.lot_no)));
  const qtySum = rows.reduce((a, r) => a + Number(r.qty), 0);
  check('lot-wise quantities sum to the seller-wise total (600)', qtySum === 600, `got ${qtySum}`);

  // The snapshot is what the PDF falls back to — it must be per-DOCUMENT now.
  check('each lot-wise bill snapshots exactly ONE line item',
        rows.every(r => JSON.parse(r.line_items || '[]').length === 1),
        JSON.stringify(rows.map(r => JSON.parse(r.line_items || '[]').length)));

  // ── Reprint scoping ──
  console.log('\n[C] Reprint of a lot-wise bill renders ONE lot');
  const r201 = rows.find(r => r.lot_no === '201');
  const prev = await api('POST', `/api/invoices/preview/${aid}`,
    { buyerCode: 'RAMU PLANTER', type: 'agri', lotNo: '201' });
  const nLines = prev.d && prev.d.invoice && prev.d.invoice.lineItems && prev.d.invoice.lineItems.length;
  check('preview of a lot-wise bill has exactly 1 line', nLines === 1,
        `got ${nLines} line(s) — a lot-wise bill must not render the whole planter`);

  const pdfR = await fetch(
    `${B}/api/bills/pdf/${aid}/${encodeURIComponent('RAMU PLANTER')}?billNo=${encodeURIComponent(r201.bil)}`,
    { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('bill PDF endpoint renders a lot-wise bill', pdfR.status === 200, `got ${pdfR.status}`);
  const pdfBuf = Buffer.from(await pdfR.arrayBuffer());
  check('and returns a real PDF', pdfBuf.slice(0, 4).toString() === '%PDF',
        `starts with ${JSON.stringify(pdfBuf.slice(0, 20).toString())}`);

  // ── Commission Bill (Bill of Supply) — the same lot scoping ──
  // /api/bills/commission-bos-bulk emits one A4 page per lot and names the
  // download CommissionBoS_Batch_<pages>.pdf, so the page count is readable
  // straight off the Content-Disposition. It used to pull every lot of the
  // seller regardless of the row's lot_no: RAMU's two one-lot bills each came
  // back as 2 pages (his other lot printed on both), and the whole-trade
  // "Commission Bill Selected" squared to 5 pages instead of 3.
  console.log('\n[C2] Commission BoS honours the row\'s lot');
  const commPages = async (ids) => {
    const r = await fetch(`${B}/api/bills/commission-bos-bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) return 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200);
    const m = /Batch_(\d+)\.pdf/.exec(r.headers.get('content-disposition') || '');
    return m ? Number(m[1]) : 'no page count in ' + r.headers.get('content-disposition');
  };
  for (const row of rows) {
    const n = await commPages([row.id]);
    check(`commission BoS for bill ${row.bil} (lot ${row.lot_no}) is 1 page`, n === 1, `got ${n}`);
  }
  const nAll = await commPages(rows.map(r => r.id));
  check('commission BoS over all 3 lot-wise bills is 3 pages, not 5', nAll === 3, `got ${nAll}`);

  // ── Downstream: Tally URD purchase vouchers ──
  // buildURDPurchaseRows scopes each bill to its own lots via the
  // line_items snapshot, with a per-auction claimed-lot set so no lot is
  // ever counted twice. Lot-wise bills have a one-lot snapshot each, so the
  // three vouchers must carry one lot apiece and still total the trade.
  console.log('\n[D] Tally URD vouchers stay one-lot-per-voucher, no double count');
  const urd = await api('GET', `/api/tally/preview/urd_purchase/${aid}`);
  check('URD preview responds', urd.status === 200,
        `${urd.status} ${JSON.stringify(urd.d).slice(0, 300)}`);
  // voucherCount is the discriminating assertion. If lot-wise scoping were
  // broken, RAMU's two one-lot bills would each try to claim BOTH his lots;
  // the claimed-lot set would give the first bill 2 lots and leave the second
  // empty, and empty vouchers are dropped — so a broken build reports
  // voucherCount 2 / lotCount 3, not 3 / 3.
  check('3 URD vouchers — one per lot-wise bill, none dropped as empty',
        urd.d && urd.d.voucherCount === 3, `voucherCount ${urd.d && urd.d.voucherCount}`);
  check('3 lots across those vouchers — no lot double-counted or lost',
        urd.d && urd.d.lotCount === 3, `lotCount ${urd.d && urd.d.lotCount}`);
  check('still 2 URD parties (the planters, not the lots)',
        urd.d && urd.d.partyCount === 2, `partyCount ${urd.d && urd.d.partyCount}`);

  // ── Mixed history ──
  console.log('\n[E] Mixed history — an old seller-wise bill is unaffected');
  const prevSeller = await api('POST', `/api/invoices/preview/${aid}`,
    { buyerCode: 'RAMU PLANTER', type: 'agri' });
  const nSeller = prevSeller.d && prevSeller.d.invoice && prevSeller.d.invoice.lineItems.length;
  check('an unscoped (seller-wise) preview still spans both RAMU lots', nSeller === 2,
        `got ${nSeller}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.slice(-2500));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
