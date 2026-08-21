// PAYMENT VOUCHER (commission memorandum) for PURCHASE invoices — end-to-end
// HTTP test against a live server booted on a throwaway data dir.
// Mirrors tests/lotwise-purchase.http.js.
//
// The point of the feature: a SELLER-WISE purchase invoice covers every lot a
// dealer sold in the trade, but the voucher must print ONE A4 PAGE PER LOT,
// numbered <invoice>/1, <invoice>/2 …  A lot-wise invoice prints its single
// page with the plain number. Nothing is generated, numbered or stored.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-voucher-'));
const PORT = 47315;
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
async function pdf(url, body) {
  const r = await fetch(B + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf };
}
// Page count straight off the PDF: count "/Type /Page" objects (not /Pages).
function pageCount(buf) {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}
// Page text via poppler's pdftotext when it is installed; null when it isn't
// (the text-level assertions are then skipped, not failed).
function pdfToText(buf) {
  const f = path.join(TMP, 'probe.pdf');
  try {
    fs.writeFileSync(f, buf);
    return require('child_process')
      .execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
  } catch (_) { return null; }
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
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('logged in\n');

  // ── Fixture: one dealer with 3 lots, one with 1 ──────────────────────
  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-12', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  if (!aid) { console.error('auction create failed', auc.status, auc.d); cleanup(); process.exit(1); }

  const GST = '33AAAAA0000A1Z5';
  for (const [lot_no, name, qty, price] of [
    ['201', 'AAA TRADERS', 100, 500],
    ['202', 'AAA TRADERS', 200, 500],
    ['203', 'AAA TRADERS', 150, 500],
    ['204', 'BBB TRADERS', 300, 500],
  ]) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, cr: GST, qty,
      grade: '2', bags: 10, crop: 'CARDAMOM',
    });
    if (r.status >= 300) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    const u = await api('PUT', `/api/lots/${lotId}`, { price, amount: qty * price });
    if (u.status >= 300) { console.error('lot price update failed', u.status, u.d); cleanup(); process.exit(1); }
  }

  // ══ [A] Seller-wise invoices, voucher printed LOT-WISE ══════════════
  console.log('[A] Seller-wise purchases print one voucher page PER LOT');
  await setFlag('flag_lotwise_purchase', 'false');
  const gen = await api('POST', `/api/purchases/generate-all/${aid}`, { startInvoiceNo: 1 });
  check('generate-all ran seller-wise', gen.d && gen.d.mode === 'seller', JSON.stringify(gen.d));

  let list = await api('GET', `/api/purchases?auction_id=${aid}`);
  let rows = (list.d && (list.d.rows || list.d)) || [];
  const aaa = rows.find(r => r.name === 'AAA TRADERS');
  const bbb = rows.find(r => r.name === 'BBB TRADERS');
  check('AAA has ONE seller-wise invoice covering 3 lots (qty 450)',
        aaa && !String(aaa.lot_no || '').trim() && Number(aaa.qty) === 450,
        aaa && `lot_no=${JSON.stringify(aaa.lot_no)} qty=${aaa.qty}`);

  const v1 = await pdf('/api/purchases/commission-bulk', { ids: [aaa.id] });
  check('voucher endpoint returns 200', v1.status === 200, `got ${v1.status}`);
  check('and a real PDF', v1.buf.slice(0, 4).toString() === '%PDF');
  check('3 pages — one per lot, from ONE seller-wise invoice', pageCount(v1.buf) === 3,
        `got ${pageCount(v1.buf)} page(s)`);

  const v2 = await pdf('/api/purchases/commission-bulk', { ids: [bbb.id] });
  check('a single-lot dealer gets exactly 1 page', pageCount(v2.buf) === 1,
        `got ${pageCount(v2.buf)}`);

  const vBoth = await pdf('/api/purchases/commission-bulk', { ids: [aaa.id, bbb.id] });
  check('both dealers ticked → 4 pages total', pageCount(vBoth.buf) === 4,
        `got ${pageCount(vBoth.buf)}`);

  // Per-page numbering: <invo>/1 … for a multi-lot invoice, plain for a single
  // lot. The pages are Chrome-rendered with subset fonts, so read the text with
  // pdftotext when it is installed; skip the check (rather than fail) when not.
  // Text checks run on the Letterhead layout — the "Payment Voucher /
  // MEMORANDUM" format this feature targets. The page-count checks above
  // deliberately stay on the install's default layout.
  const vLh = await pdf('/api/purchases/commission-bulk', { ids: [aaa.id], template: 'letterhead' });
  check('letterhead layout also renders 3 pages', pageCount(vLh.buf) === 3,
        `got ${pageCount(vLh.buf)}`);
  const txt = pdfToText(vLh.buf);
  if (txt == null) {
    console.log('  skip pdftotext not installed — per-page numbering not text-checked');
  } else {
    check('multi-lot voucher pages are numbered <invoice>/1 … /3',
          [1, 2, 3].every(n => txt.includes(`${aaa.invo}/${n}`)),
          `Bill No lines: ${JSON.stringify((txt.match(/Bill No:[^\n]*/g) || []))}`);
    check('each page carries its own lot (201 / 202 / 203)',
          ['201', '202', '203'].every(l => txt.includes(`Lot No: ${l}`)),
          `Lot No lines: ${JSON.stringify((txt.match(/Lot No:[^\n]*/g) || []))}`);
    check("the dealer's GSTIN prints where a planter's CR would",
          txt.includes('GSTIN: 33AAAAA0000A1Z5'),
          'seller registration line missing from the voucher');
  }

  // ══ [B] Lot-wise invoices still print their own single page ═════════
  console.log('\n[B] Lot-wise purchases print their ONE lot');
  for (const r of rows) await api('DELETE', `/api/purchases/${r.id}`);
  await setFlag('flag_lotwise_purchase', 'true');
  const batch = await api('POST', `/api/purchases/generate-all/${aid}`, { startInvoiceNo: 20 });
  check('generate-all ran lot-wise', batch.d && batch.d.mode === 'lot', JSON.stringify(batch.d));

  list = await api('GET', `/api/purchases?auction_id=${aid}`);
  rows = (list.d && (list.d.rows || list.d)) || [];
  check('4 lot-wise invoices exist', rows.length === 4, `got ${rows.length}`);

  const one = rows.find(r => String(r.lot_no || '').trim() === '202');
  const v3 = await pdf('/api/purchases/commission-bulk', { ids: [one.id] });
  check('a lot-wise invoice prints exactly 1 voucher page', pageCount(v3.buf) === 1,
        `got ${pageCount(v3.buf)}`);

  const vAll = await pdf('/api/purchases/commission-bulk', { ids: rows.map(r => r.id) });
  check('all 4 lot-wise invoices → 4 pages, none squared', pageCount(vAll.buf) === 4,
        `got ${pageCount(vAll.buf)} — a lot-wise row must not span the whole seller`);

  // ══ [C] Guards ══════════════════════════════════════════════════════
  console.log('\n[C] Guards');
  const noIds = await api('POST', '/api/purchases/commission-bulk', { ids: [] });
  check('empty id list is refused with 400', noIds.status === 400, `got ${noIds.status}`);
  const missing = await api('POST', '/api/purchases/commission-bulk', { ids: [999999] });
  check('unknown ids are refused with 404', missing.status === 404, `got ${missing.status}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.slice(-2500));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
