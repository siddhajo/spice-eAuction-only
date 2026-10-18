// Which documents carry the watermark — per-document switches.
//
// The mark used to be all-or-nothing: `flag_pdf_watermark` governed every PDF
// the app prints. The operator wanted it on the documents that LEAVE the
// building and not on the internal paper, so each document kind now has its
// own switch under the master one.
//
// Two levels, and the order is the thing to protect:
//   • master OFF  ⇒ nothing is stamped, whatever the per-document keys say;
//   • master ON   ⇒ each kind answers for itself, defaulting to ON so an
//                   upgrade changes nothing for anyone.
//   • no kind passed ⇒ the master answer alone, so any call site that was
//                   never taught about kinds keeps its old behaviour instead
//                   of silently losing its mark.
//
// The PDF half matters as much as the resolution half: the two engines stamp
// by completely different means (a fixed HTML layer vs a PDFKit hook on
// addPage), so a switch that works in one can do nothing in the other.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-doc-'));
const PORT = 47396;
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
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
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
  // ══ The resolution rules, in-process ═════════════════════════════
  const wm = require(path.join(ROOT, 'pdf', 'watermark'));
  console.log('[1] Master beats everything');
  check('master off silences a kind that is on',
        wm.watermarkOn({ flag_pdf_watermark: 'false', pdf_watermark_sales_invoice: 'true' }, 'sales_invoice') === false);
  check('…and the no-kind callers too',
        wm.watermarkOn({ flag_pdf_watermark: 'false' }) === false);
  check('the pre-widening alias still switches everything off',
        wm.watermarkOn({ flag_invoice_watermark: 'false' }, 'reports') === false);

  console.log('\n[2] Everything defaults ON — an upgrade changes nothing');
  for (const kind of Object.keys(wm.WATERMARK_KINDS)) {
    check(`${kind} is stamped with nothing configured`, wm.watermarkOn({}, kind) === true);
  }
  check('and so is a caller that passes no kind at all', wm.watermarkOn({}) === true);

  console.log('\n[3] One switch moves one document');
  const off = { pdf_watermark_sales_invoice: 'false' };
  check('the switched-off kind goes quiet', wm.watermarkOn(off, 'sales_invoice') === false);
  check('…its neighbours do not', wm.watermarkOn(off, 'purchase_invoice') === true
        && wm.watermarkOn(off, 'reports') === true);
  check('the two debit notes are separate documents',
        wm.watermarkOn({ pdf_watermark_debit_note_planter: 'false' }, 'debit_note') === true
        && wm.watermarkOn({ pdf_watermark_debit_note_planter: 'false' }, 'debit_note_planter') === false);
  check('a kind nothing knows about falls back to the master',
        wm.watermarkOn({ pdf_watermark_sales_invoice: 'false' }, 'no_such_document') === true);
  check('settings read as real booleans work too (getSettingsFlat returns those)',
        wm.watermarkOn({ pdf_watermark_commission_bill: false }, 'commission_bill') === false);
  check('…and the file resolver follows the same answer',
        wm.watermarkFile({ flag_pdf_watermark: 'false' }, 'sales_invoice') === '');

  // ══ And in the PDFs themselves ═══════════════════════════════════
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', trade_name: 'RNS SPICES', commission: '1', gst_service: '18', gst_goods: '5' } });
  await api('POST', '/api/auctions', { ano: '20', date: '2026-10-17', crop_type: 'ISP' });
  await api('POST', '/api/auctions/1/allocations', { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '050' }] });
  const t = (await api('POST', '/api/traders', { name: 'ABSAL SPICES', tel: '9790744440',
    ppla: 'CUMBUM', cr: 'GSTIN.33ALCPU9807E1Z0', aadhar: 'SBL0' })).d.trader;
  await api('POST', '/api/lots', { auction_id: 1, lot_no: '001', trader_id: t.id, branch: 'BODI',
    grade: '2', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  const lots = (await api('GET', '/api/lots/1')).d || [];
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3152, code: 'B1', buyer: 'B1' })) });
  await api('POST', '/api/lots/calculate/1', {});
  await api('POST', '/api/purchases/generate-all/1', { startInvoiceNo: 1 });
  const ids = ((await api('GET', '/api/purchases?auction_id=1')).d || []).map(p => p.id);

  // A stamped PDF embeds the logo image; an unstamped one does not. Both
  // engines are measured because they stamp by entirely different means.
  const pdfkitSize = async () => (await api('POST', '/api/purchases/pdf-bulk', { ids, template: 'classic' })).buf.length;
  const htmlSize   = async () => (await api('POST', '/api/purchases/pdf-bulk', { ids, template: 'modern' })).buf.length;
  const reportSize = async () => (await api('GET', '/api/exports/purchase-register?auctionId=1&format=pdf')).buf.length;
  const set = (o) => api('PUT', '/api/company-settings', { settings: o });

  console.log('\n[4] The switch reaches the actual PDF — both engines');
  const on = { pdfkit: await pdfkitSize(), html: await htmlSize(), report: await reportSize() };
  await set({ pdf_watermark_purchase_invoice: 'false' });
  const purOff = { pdfkit: await pdfkitSize(), html: await htmlSize(), report: await reportSize() };
  check('PDFKit drops the mark', purOff.pdfkit < on.pdfkit, { on: on.pdfkit, off: purOff.pdfkit });
  check('the HTML engine drops it too', purOff.html < on.html, { on: on.html, off: purOff.html });
  check('and the REPORT is untouched by an invoice switch',
        purOff.report === on.report, { on: on.report, off: purOff.report });

  console.log('\n[5] …and the reverse: reports off leaves the invoice marked');
  await set({ pdf_watermark_purchase_invoice: 'true', pdf_watermark_reports: 'false' });
  const repOff = { pdfkit: await pdfkitSize(), html: await htmlSize(), report: await reportSize() };
  check('the purchase invoice is stamped again', repOff.pdfkit === on.pdfkit && repOff.html === on.html,
        { pdfkit: repOff.pdfkit, html: repOff.html });
  check('the report changed when its own switch moved', repOff.report !== on.report,
        { on: on.report, off: repOff.report });

  console.log('\n[6] Master off still silences everything');
  await set({ flag_pdf_watermark: 'false' });
  const masterOff = { pdfkit: await pdfkitSize(), html: await htmlSize(), report: await reportSize() };
  check('both invoice engines are unmarked',
        masterOff.pdfkit === purOff.pdfkit && masterOff.html === purOff.html, masterOff);
  check('…and so is the report', masterOff.report === repOff.report, masterOff);

  console.log('\n[7] Every switch is a real setting an admin can see');
  await set({ flag_pdf_watermark: 'true' });
  const cfg = (await api('GET', '/api/company-settings/flat')).d || {};
  const missing = Object.values(wm.WATERMARK_KINDS).filter(k => cfg[k] === undefined);
  check('all seven keys exist in company settings', missing.length === 0, missing);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
