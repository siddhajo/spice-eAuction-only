// Sales invoice list — the "Pending" doc-type filter shows proforma drafts
// whose original has NOT been raised yet (is_proforma=1 AND raised_invo blank).
// Original, Proforma and All keep their existing meaning. End-to-end HTTP test
// against a live server on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-pending-'));
const PORT = 47337;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const rowsOf = (d) => (d && (d.rows || d)) || [];
const invos = (d) => rowsOf(d).map(r => String(r.invo)).sort();

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', b => log += b); srv.stderr.on('data', b => log += b);
const done = (c) => { try { srv.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(c); };

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, log.slice(-2000)); done(1); }

  await api('PUT', '/api/company-settings', { settings: { flag_proforma_invoice: 'true', proforma_invoice_prefix: 'PI' } });
  const auc = await api('POST', '/api/auctions', { ano: '7', date: '2026-08-10', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // Insert invoices directly via the DB isn't available over HTTP, so use the
  // settings-backed test seam: create them through the invoices table by
  // POSTing lots + generating is heavy — instead assert the FILTER via the
  // documented endpoint using rows the app writes. Simplest: raise proformas
  // through the generate flow. We craft rows straight through a tiny helper
  // endpoint isn't available, so drive the real generate path minimally.
  //
  // Minimal real data: two proforma drafts (one later raised) + one direct
  // original. We write them via the invoices table using the debug importer
  // path is overkill; use the lots+generate flow.
  async function lot(lot_no, buyer) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'S', qty: 100 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    // POST /api/lots does not take buyer/price/amount — set them via PUT.
    await api('PUT', `/api/lots/${id}`, { buyer, buyer1: buyer, price: 100, amount: 10000, bags: 5, sale: 'L' });
    return id;
  }
  await lot('1', 'AAA');
  await lot('2', 'BBB');
  await lot('3', 'CCC');

  // AAA + BBB → proforma drafts; CCC → original.
  const pfA = await api('POST', `/api/invoices/generate/${aid}`, { sellerName: 'AAA', buyerCode: 'AAA', invoiceNo: '1', saleType: 'L', docType: 'proforma' });
  const pfB = await api('POST', `/api/invoices/generate/${aid}`, { sellerName: 'BBB', buyerCode: 'BBB', invoiceNo: '2', saleType: 'L', docType: 'proforma' });
  const orC = await api('POST', `/api/invoices/generate/${aid}`, { sellerName: 'CCC', buyerCode: 'CCC', invoiceNo: '5', saleType: 'L', docType: 'original' });
  check('two proforma drafts + one original were generated',
        (pfA.status < 300) && (pfB.status < 300) && (orC.status < 300),
        JSON.stringify({ a: pfA.status, b: pfB.status, c: orC.status, ea: pfA.d && pfA.d.error, eb: pfB.d && pfB.d.error, ec: orC.d && orC.d.error }));

  // Find proforma A's row id and raise it to an original (stamps raised_invo).
  const allPf = await api('GET', `/api/invoices?auction_id=${aid}&docType=proforma`);
  const rowA = rowsOf(allPf.d).find(r => r.buyer === 'AAA');
  const raise = await api('POST', `/api/invoices/${rowA.id}/raise-original`, { saleType: 'L' });
  check('proforma A raised to an original', raise.status < 300, JSON.stringify(raise.d));

  // ── Now the filter matrix ──
  const pending  = await api('GET', `/api/invoices?auction_id=${aid}&docType=pending`);
  const proforma = await api('GET', `/api/invoices?auction_id=${aid}&docType=proforma`);
  const original = await api('GET', `/api/invoices?auction_id=${aid}&docType=original`);

  console.log('[1] Pending = proforma drafts with no original raised');
  const pendRows = rowsOf(pending.d);
  check('pending shows only BBB (A was raised, C is a direct original)',
        pendRows.length === 1 && pendRows[0].buyer === 'BBB',
        JSON.stringify(pendRows.map(r => ({ buyer: r.buyer, invo: r.invo, raised: r.raised_invo }))));
  check('every pending row is a proforma with blank raised_invo',
        pendRows.every(r => Number(r.is_proforma) === 1 && !String(r.raised_invo || '').trim()));

  console.log('\n[2] The other filters are unchanged');
  check('proforma shows BOTH drafts (raised + pending)',
        rowsOf(proforma.d).filter(r => Number(r.is_proforma) === 1).length === 2,
        JSON.stringify(invos(proforma.d)));
  check('original shows the direct original AND the raised one (2)',
        rowsOf(original.d).length === 2 && rowsOf(original.d).every(r => Number(r.is_proforma) === 0),
        JSON.stringify(rowsOf(original.d).map(r => ({ buyer: r.buyer, invo: r.invo }))));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(log.slice(-2500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2500)); done(1); });
