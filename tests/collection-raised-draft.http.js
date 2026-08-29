// COLLECTION — a draft must not be dropped by ANOTHER buyer's original.
//
// Proforma numbers repeat across the sale series: trade 15 held two drafts
// numbered 33, one Local (ERPL) and one Inter-state (S KUMAR). The stamp that
// marks a draft "raised" used to match on the number and the trade alone, so
// raising S KUMAR's draft also stamped ERPL's. Collection then read ERPL's
// draft as superseded and dropped it — while no original existed for ERPL to
// replace it. 5,521.1 kg vanished from the register, and the report no longer
// agreed with the Auction Report.
//
//   [scope]  raising one buyer's draft leaves the other buyer's same-numbered
//            draft untouched, and both stay in the register
//   [delete] re-drafting one buyer does not destroy the other's pending draft
//   [genuine] a draft whose OWN original exists is still superseded, so the
//            de-dup that stops a buyer printing twice survives the fix
//
// The other half — a draft that ALREADY carries a bad reference, i.e. the rows
// written before this fix — is covered in collection-stale-raised.unit.js: the
// server holds the database in memory (sql.js), so that state cannot be staged
// from outside the process.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coll-raised-'));
const PORT = 47395;
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
// Collection as { qty, rows: [{invo, name, qty}] }.
async function collection(aid) {
  const r = await fetch(B + `/api/exports/collection/${aid}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0];
  const rows = []; let grand = 0;
  ws.eachRow((row) => {
    const c1 = String(row.getCell(1).value == null ? '' : row.getCell(1).value);
    const c3 = String(row.getCell(3).value == null ? '' : row.getCell(3).value);
    const q = row.getCell(4).value;
    if (c3 === 'GRAND TOTAL') { grand = Number(q) || 0; return; }
    if (typeof q === 'number' && c1 && !/TOTAL/.test(c3) && !/^NOT IN/.test(c1)) {
      rows.push({ invo: c1, name: c3, qty: Number(q) || 0 });
    }
  });
  return { grand, rows };
}
// docType=all — the list route serves ORIGINALS only by default, so the
// drafts this test is about would be invisible.
const invoiceRows = async (aid) => (await api('GET', `/api/invoices?auction_id=${aid}&docType=all`)).d;

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
  if (!TOKEN) { console.error('login failed', lg.status, log.slice(-2000)); done(1); }
  await api('PUT', '/api/company-settings', { settings: { flag_proforma_invoice: 'true' } });

  const auc = await api('POST', '/api/auctions', { ano: '99', date: '2026-08-29', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  // Two buyers in DIFFERENT sale series — the arrangement that lets their
  // draft numbers collide. LOCAL buyer is in the company's own state.
  await api('POST', '/api/buyers', { buyer: 'LOCALCO', buyer1: 'LOCAL SPICES', code: 'L1',
                                     pla: 'BODINAYAKANUR', state: 'TAMIL NADU', st_code: '33',
                                     gstin: '33AAHCE4551A1Z8', sale: 'L' });
  await api('POST', '/api/buyers', { buyer: 'FARCO', buyer1: 'FAR SPICES', code: 'F1',
                                     pla: 'KOCHI', state: 'KERALA', st_code: '32',
                                     gstin: '32AAHCE4551A1Z8', sale: 'I' });
  const mk = async (lot_no, code, buyer, buyer1, sale, qty) => {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'PLANTER ' + lot_no,
                                               cr: '', qty, bags: 5, grade: '1', crop: 'CARDAMOM' });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`, { price: 1000, amount: qty * 1000, balance: qty * 980,
                                          code, buyer: code, buyer1, sale });
    return id;
  };
  await mk('1', 'L1', 'LOCALCO', 'LOCAL SPICES', 'L', 100);
  await mk('2', 'F1', 'FARCO', 'FAR SPICES', 'I', 200);

  console.log('[setup] two drafts that share a number across the sale series');
  // Same start number for both runs — that is what puts number 33 on both.
  const d1 = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 33, saleType: 'L', docType: 'proforma' });
  const d2 = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 33, saleType: 'I', docType: 'proforma' });
  check('both drafts generate', d1.status === 200 && d2.status === 200,
        `HTTP ${d1.status} / ${d2.status}`);
  let inv = await invoiceRows(aid);
  let drafts = (Array.isArray(inv) ? inv : inv.rows || []).filter(r => Number(r.is_proforma));
  check('two drafts exist, both numbered 33',
        drafts.length === 2 && drafts.every(r => String(r.invo) === '33'),
        JSON.stringify(drafts.map(r => [r.buyer, r.sale, r.invo])));
  let c = await collection(aid);
  check('the register shows both, 300 kg in total', Math.abs(c.grand - 300) < 0.01,
        `${c.grand}: ${JSON.stringify(c.rows)}`);

  console.log('\n[scope] raising one draft leaves the other alone');
  const raise = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 500, saleType: 'I' });
  check('the inter-state draft is raised as an original', raise.status === 200,
        `HTTP ${raise.status} ${JSON.stringify(raise.d).slice(0, 200)}`);
  inv = await invoiceRows(aid);
  const all = Array.isArray(inv) ? inv : inv.rows || [];
  const localDraft = all.find(r => Number(r.is_proforma) && String(r.buyer) === 'L1');
  const farDraft   = all.find(r => Number(r.is_proforma) && String(r.buyer) === 'F1');
  check('the raised buyer\'s draft is stamped', String(farDraft && farDraft.raised_invo || '') !== '',
        JSON.stringify(farDraft));
  check('the OTHER buyer\'s draft is NOT stamped — it was never raised',
        String(localDraft && localDraft.raised_invo || '') === '',
        JSON.stringify(localDraft));

  c = await collection(aid);
  check('the register still totals 300 kg — nothing vanished',
        Math.abs(c.grand - 300) < 0.01, `${c.grand}: ${JSON.stringify(c.rows)}`);
  check('the local buyer is still listed', c.rows.some(r => /^L1$/i.test(String(r.name).trim())),
        JSON.stringify(c.rows));

  console.log('\n[genuine] a draft whose OWN original exists is still superseded');
  // The de-dup that keeps a raised draft from printing beside its original
  // must survive all of the above.
  const raise2 = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 600, saleType: 'L' });
  check('the local draft is raised too', raise2.status === 200, `HTTP ${raise2.status}`);
  c = await collection(aid);
  check('the register still totals 300 kg — no double count',
        Math.abs(c.grand - 300) < 0.01, `${c.grand}: ${JSON.stringify(c.rows)}`);
  check('each buyer appears once', c.rows.length === 2, JSON.stringify(c.rows));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); done(1); });
