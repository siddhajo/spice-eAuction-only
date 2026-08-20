// Lot-wise purchase invoices — end-to-end HTTP test against a live server
// booted on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotwise-http-'));
const PORT = 47311;
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

// Set a flag through the settings API so we exercise the same path the UI uses.
// PUT /api/company-settings takes { settings: { key: value } } — a plain
// object keyed by setting name.
async function setFlag(key, val) {
  const r = await api('PUT', '/api/company-settings', { settings: { [key]: String(val) } });
  if (r.status !== 200) throw new Error(`could not set ${key}: ${r.status} ${JSON.stringify(r.d)}`);
  // Read back — a silent no-op write would make every downstream assertion
  // in this test meaningless.
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
  // Wait for boot
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in\n');

  // ── Fixture ────────────────────────────────────────────────────────
  const auc = await api('POST', '/api/auctions', { ano: '7', date: '2026-08-10', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  if (!aid) { console.error('auction create failed', auc.status, auc.d); cleanup(); process.exit(1); }

  const GST = '33AAAAA0000A1Z5';
  for (const [lot_no, name, qty, price] of [
    ['101', 'AAA TRADERS', 100, 500],
    ['102', 'AAA TRADERS', 200, 500],
    ['103', 'BBB TRADERS', 300, 500],
  ]) {
    // POST /api/lots is the pre-trade entry form — it does not take price or
    // amount (those arrive at price entry), so set them with a follow-up PUT.
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, cr: GST, qty,
      grade: '2', bags: 10, crop: 'CARDAMOM',
    });
    if (r.status >= 300) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    const u = await api('PUT', `/api/lots/${lotId}`, { price, amount: qty * price });
    if (u.status >= 300) { console.error('lot price update failed', u.status, u.d); cleanup(); process.exit(1); }
  }

  // ══ SELLER-WISE (flag off — the default) ═══════════════════════════
  console.log('[A] Seller-wise mode (flag OFF) — existing behaviour');
  await setFlag('flag_lotwise_purchase', 'false');

  const elSellers = await api('GET', `/api/purchases/eligible-sellers/${aid}`);
  check('eligible-sellers returns 2 dealers', elSellers.d && elSellers.d.length === 2,
        JSON.stringify(elSellers.d));

  const swGen = await api('POST', `/api/purchases/generate-all/${aid}`, { startInvoiceNo: 1 });
  check('generate-all reports seller mode', swGen.d && swGen.d.mode === 'seller', JSON.stringify(swGen.d));
  check('creates 2 invoices (one per dealer)', swGen.d && swGen.d.generated === 2,
        swGen.d && `generated ${swGen.d.generated}`);

  let list = await api('GET', `/api/purchases?auction_id=${aid}`);
  let rows = (list.d && (list.d.rows || list.d)) || [];
  check('all rows are marked seller-wise (blank lot_no)',
        rows.length === 2 && rows.every(r => !String(r.lot_no || '').trim()),
        JSON.stringify(rows.map(r => ({ invo: r.invo, name: r.name, lot_no: r.lot_no }))));
  const aaaSeller = rows.find(r => r.name === 'AAA TRADERS');
  check('AAA seller-wise invoice covers both lots (qty 300)',
        aaaSeller && Number(aaaSeller.qty) === 300, aaaSeller && `qty ${aaaSeller.qty}`);

  // A lot-wise request must be REFUSED while the flag is off.
  const refused = await api('POST', `/api/purchases/generate/${aid}`,
    { sellerName: 'AAA TRADERS', invoiceNo: '900', lotNo: '101' });
  check('lot-wise request refused with 403 while flag is off', refused.status === 403,
        `got ${refused.status} ${JSON.stringify(refused.d)}`);

  // ══ LOT-WISE (flag on) ═════════════════════════════════════════════
  console.log('\n[B] Lot-wise mode (flag ON)');
  // Clear the seller-wise docs so the trade starts clean.
  for (const r of rows) await api('DELETE', `/api/purchases/${r.id}`);
  await setFlag('flag_lotwise_purchase', 'true');

  const elLots = await api('GET', `/api/purchases/eligible-lots/${aid}`);
  check('eligible-lots returns 3 lots', elLots.d && elLots.d.length === 3,
        JSON.stringify(elLots.d && elLots.d.map(l => l.lot_no)));
  check('none flagged already-invoiced yet',
        elLots.d && elLots.d.every(l => !l.already_invoiced));
  check('each lot carries its seller + lot id',
        elLots.d && elLots.d.every(l => l.name && l.lot_id != null));

  // Single lot-wise generate
  const one = await api('POST', `/api/purchases/generate/${aid}`,
    { sellerName: 'AAA TRADERS', invoiceNo: '10', lotNo: '101',
      lotId: elLots.d.find(l => l.lot_no === '101').lot_id });
  check('single lot-wise generate succeeds', one.status === 200 && one.d.mode === 'lot',
        `${one.status} ${JSON.stringify(one.d)}`);
  check('it invoiced only that lot (qty 100)', one.d && one.d.invoice && one.d.invoice.totalQty === 100,
        one.d && JSON.stringify(one.d.invoice && one.d.invoice.totalQty));

  // Duplicate guard
  const dupe = await api('POST', `/api/purchases/generate/${aid}`,
    { sellerName: 'AAA TRADERS', invoiceNo: '11', lotNo: '101' });
  check('re-invoicing the same lot is refused with 409', dupe.status === 409,
        `got ${dupe.status} ${JSON.stringify(dupe.d)}`);

  // eligible-lots now marks it done
  const elLots2 = await api('GET', `/api/purchases/eligible-lots/${aid}`);
  const lot101 = elLots2.d.find(l => l.lot_no === '101');
  check('eligible-lots marks lot 101 already invoiced', lot101 && lot101.already_invoiced === '10',
        JSON.stringify(lot101));

  // Batch tops up the rest, skipping the done one
  const batch = await api('POST', `/api/purchases/generate-all/${aid}`, { startInvoiceNo: 20 });
  check('generate-all reports lot mode', batch.d && batch.d.mode === 'lot');
  check('creates 2 more (the remaining lots)', batch.d && batch.d.generated === 2,
        batch.d && `generated ${batch.d.generated}`);
  check('skips the already-invoiced lot, as skipped not error',
        batch.d && batch.d.skipped && batch.d.skipped.length === 1 &&
        (!batch.d.errors || !batch.d.errors.length),
        JSON.stringify({ skipped: batch.d && batch.d.skipped, errors: batch.d && batch.d.errors }));

  list = await api('GET', `/api/purchases?auction_id=${aid}`);
  rows = (list.d && (list.d.rows || list.d)) || [];
  check('3 lot-wise invoices exist, one per lot', rows.length === 3,
        `got ${rows.length}`);
  check('every row is stamped with its lot',
        rows.every(r => String(r.lot_no || '').trim() !== ''),
        JSON.stringify(rows.map(r => ({ invo: r.invo, lot_no: r.lot_no }))));
  check('lot numbers are exactly 101/102/103',
        JSON.stringify(rows.map(r => r.lot_no).sort()) === JSON.stringify(['101','102','103']),
        JSON.stringify(rows.map(r => r.lot_no)));
  const qtySum = rows.reduce((a, r) => a + Number(r.qty), 0);
  check('lot-wise quantities sum to the seller-wise total (600)', qtySum === 600, `got ${qtySum}`);

  // ── The reprint-scoping defect ──
  console.log('\n[C] Reprint of a lot-wise invoice renders ONE lot');
  const r101 = rows.find(r => r.lot_no === '101');
  const prev = await api('POST', `/api/invoices/preview/${aid}`,
    { buyerCode: 'AAA TRADERS', type: 'purchase', lotNo: '101', invoiceNo: r101.invo });
  const nLines = prev.d && prev.d.invoice && prev.d.invoice.lineItems && prev.d.invoice.lineItems.length;
  check('preview of a lot-wise invoice has exactly 1 line', nLines === 1,
        `got ${nLines} line(s) — a lot-wise invoice must not render the whole seller`);

  // The REAL reprint path (the PDF endpoint), not just the preview — this is
  // the call the "View PDF" button makes, and the one that would have rendered
  // every seller lot onto a single-lot invoice.
  const pdfR = await fetch(
    `${B}/api/purchases/pdf/${aid}/${encodeURIComponent('AAA TRADERS')}?invoiceNo=${encodeURIComponent(r101.invo)}`,
    { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('purchase PDF endpoint renders a lot-wise invoice', pdfR.status === 200,
        `got ${pdfR.status}`);
  const pdfBuf = Buffer.from(await pdfR.arrayBuffer());
  check('and returns a real PDF', pdfBuf.slice(0, 4).toString() === '%PDF',
        `starts with ${JSON.stringify(pdfBuf.slice(0, 20).toString())}`);

  // ── Mixed history: a seller-wise row still reprints seller-wise ──
  console.log('\n[D] Mixed history — an old seller-wise row is unaffected by the flag');
  const prevSeller = await api('POST', `/api/invoices/preview/${aid}`,
    { buyerCode: 'AAA TRADERS', type: 'purchase' });
  const nSeller = prevSeller.d && prevSeller.d.invoice && prevSeller.d.invoice.lineItems.length;
  check('an unscoped (seller-wise) preview still spans both AAA lots', nSeller === 2,
        `got ${nSeller}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.slice(-2500));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
