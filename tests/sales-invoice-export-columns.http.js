// SALES INVOICES → "Export Lorry" (Excel + PDF) — COLUMN ORDER.
//
// The selected-rows lorry exports are read lorry by lorry to settle freight.
// DIST (KM) was first added next to QTY, in among the load figures; the
// office asked for it at the far right instead, clear of the money columns.
// Both formats must agree — they are printed and compared side by side.
//
//   [order]   SALE … BAGS, QTY, BILL AMOUNT, DIST (KM) — distance LAST
//   [both]    the PDF and the spreadsheet carry the same columns, in the
//             same order
//   [totals]  the TOTAL row still carries no distance. Adding up the
//             kilometres of every invoice on one lorry would state a
//             journey nobody drove.
const path = require('path'), fs = require('fs'), os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'invcols-'));
const PORT = 3000 + Math.floor(Math.random() * 1500) + 400;
const B = 'http://127.0.0.1:' + PORT;

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', b => { srvLog += b; });
srv.stderr.on('data', b => { srvLog += b; });
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

let T = '';
const api = async (m, u, b) => {
  const r = await fetch(B + u, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};
const exportSelected = async (ids, format) => {
  const r = await fetch(B + '/api/invoices/export-selected', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
    body: JSON.stringify({ ids, format }),
  });
  return { s: r.status, buf: Buffer.from(await r.arrayBuffer()) };
};
// Decode a PDFKit document's text, as the other PDF tests do.
function pdfText(buf) {
  const zlib = require('zlib');
  let raw = '';
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { raw += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) {}
  }
  let out = '';
  for (const tj of raw.match(/\[[^\]]*\]\s*TJ/g) || []) {
    for (const h of tj.match(/<([0-9A-Fa-f]+)>/g) || []) out += Buffer.from(h.slice(1, -1), 'hex').toString('latin1');
    out += ' ';
  }
  return out;
}
const squash = (s) => s.replace(/\s+/g, '');

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;

  // ── Fixture: one trade, priced lots sold to one buyer, one invoice ──
  await api('PUT', '/api/company-settings', { settings: { gunny_rate: '150', br1: 'BODI' } });
  const A = (await api('POST', '/api/auctions', { ano: '24', date: '2026-11-10', crop_type: 'ISP' })).d.id;
  await api('POST', `/api/auctions/${A}/allocations`, { allocations: [{ branch: 'BODI', from_no: 1, to_no: 40 }] });
  await api('POST', '/api/buyers',
    { buyer: 'AK', buyer1: 'MURUGAN TRADERS', pla: 'BODI', gstin: '33ALCPU9807E1Z0', pin: '625516' });
  const sel = (await api('POST', '/api/traders', { name: 'GANESHBABU', tel: '9790744444', place: 'CUMBUM' })).d;
  const sid = sel.id || sel.trader_id;
  for (const [lot, bags, qty] of [['016', 1, 33.9], ['017', 2, 57.3]]) {
    await api('POST', '/api/lots', { auction_id: A, lot_no: lot, trader_id: sid, name: 'GANESHBABU',
                                     branch: 'BODI', bags, qty, gross_wt: qty + 1 });
  }
  const lots = (await api('GET', `/api/lots/${A}`)).d || [];
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 1500 })) });
  for (const l of lots) await api('PUT', `/api/lots/${l.id}`, { buyer: 'AK' });
  await api('POST', '/api/lots/calculate/' + A, {});
  await api('POST', `/api/invoices/generate/${A}`,
    { sellerName: 'AK', buyerCode: 'AK', invoiceNo: '1201', saleType: 'L' });

  const invResp = (await api('GET', `/api/invoices?auction_id=${A}`)).d;
  const invoices = Array.isArray(invResp) ? invResp : ((invResp && invResp.rows) || []);
  const ids = invoices.map(i => i.id);
  // Without this the export 400s and every check below passes vacuously.
  check('fixture: an invoice exists to export', ids.length > 0,
        { got: invoices.length, resp: JSON.stringify(invResp).slice(0, 200) });
  if (!ids.length) { console.log('\n' + pass + ' passed, ' + (fail) + ' failed'); cleanup(); process.exit(1); }

  // ── [order] + [both] ────────────────────────────────────────────────
  console.log('\n[order] DIST (KM) sits at the far right, in both formats');

  const pdf = await exportSelected(ids, 'pdf');
  check('the PDF export succeeds', pdf.s === 200 && pdf.buf.slice(0, 5).toString() === '%PDF-', pdf.s);
  const txt = squash(pdfText(pdf.buf));
  const PDF_HEADERS = ['SALE', 'INVO', 'TRADENAME', 'GSTIN', 'BAGS', 'QTY', 'BILLAMOUNT', 'DIST(KM)'];
  const at = PDF_HEADERS.map(h => txt.indexOf(h));
  check('every PDF column header is present', at.every(v => v > -1),
        Object.fromEntries(PDF_HEADERS.map((h, i) => [h, at[i]])));
  check('…and they run left to right in that order, DIST (KM) last',
        at.every((v, i) => i === 0 || v > at[i - 1]),
        Object.fromEntries(PDF_HEADERS.map((h, i) => [h, at[i]])));
  check('…specifically, DIST (KM) comes AFTER BILL AMOUNT',
        txt.indexOf('DIST(KM)') > txt.indexOf('BILLAMOUNT'));

  const xlsx = await exportSelected(ids, 'xlsx');
  check('the Excel export succeeds', xlsx.s === 200 && xlsx.buf.length > 0, xlsx.s);
  const xp = path.join(TMP, 'out.xlsx');
  fs.writeFileSync(xp, xlsx.buf);
  const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xp);
  const ws = wb.worksheets[0];
  let headerRow = null, totalRow = null;
  ws.eachRow((row) => {
    const flat = row.values.map(v => String(v == null ? '' : (v.text || v))).join('|');
    if (!headerRow && /BILL AMOUNT/.test(flat)) headerRow = row;
    if (!totalRow && /^\|?TOTAL\|/.test(flat)) totalRow = row;
  });
  const headers = headerRow
    ? headerRow.values.slice(1).map(v => String(v == null ? '' : (v.text || v)).trim()).filter(Boolean)
    : [];
  check('the spreadsheet has a header row', headers.length > 0, headers);
  check('…ending in DIST (KM)', headers[headers.length - 1] === 'DIST (KM)', headers);
  check('…in the same order as the PDF',
        JSON.stringify(headers.map(h => h.replace(/\s+/g, '')))
          === JSON.stringify(['SALETYPE', 'INVNO', 'TRADENAME', 'GSTIN', 'BAGS', 'QTY', 'BILLAMOUNT', 'DIST(KM)']),
        headers);

  // ── [totals] ────────────────────────────────────────────────────────
  console.log('\n[totals] the TOTAL row still states no distance');
  if (totalRow) {
    const distCol = headers.indexOf('DIST (KM)') + 1;   // 1-based, header row is sliced
    const cell = totalRow.getCell(distCol + (totalRow.values.length - 1 > headers.length ? 1 : 0));
    const v = cell && cell.value;
    check('the Excel TOTAL leaves DIST (KM) empty',
          v == null || String(v.text || v).trim() === '', { value: v });
  } else {
    check('the Excel TOTAL leaves DIST (KM) empty', false, 'no TOTAL row found');
  }
  // In the PDF the totals row prints TOTAL, bags, qty and amount only.
  const afterTotal = txt.slice(txt.indexOf('TOTAL'));
  check('the PDF TOTAL row carries no extra distance figure',
        afterTotal.indexOf('DIST(KM)') === -1, afterTotal.slice(0, 120));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nCRASHED:', e && e.stack || e);
  console.error('\n--- server log ---\n' + srvLog.slice(-2000));
  cleanup();
  process.exit(1);
});
