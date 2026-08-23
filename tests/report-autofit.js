// REPORT COLUMN AUTOFIT — sheets and PDFs sized to their content.
//
// Three tiers had three different problems:
//   createExcelBuffer  every column fell back to `width || 15` — a guess
//                      made before anyone knew how long a seller's name was
//   Spice Board sheets built their own workbooks and set NO widths, so
//                      ExcelJS's 8.43 default truncated names and dates
//   table PDFs         content-aware autofit existed but was opt-in, and
//                      exactly one report had opted in
//
// This pins the shared helper's behaviour and then checks a real export
// end to end, because a helper that is never reached fixes nothing.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
const { autofitColumns } = require(path.join(ROOT, 'report-formatters'));
const { PDF_AUTOFIT, PDF_NO_AUTOFIT } = require(path.join(ROOT, 'exports-pdf'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

const sheetWith = (rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.columns = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  for (const r of rows) ws.addRow(r);
  return ws;
};

console.log('[helper] autofitColumns');
{
  const ws = sheetWith([
    { a: 'ID', b: 'SELLER', c: 'AMT' },
    { a: '1',  b: 'ELAICHIROYAL PRIVATE LIMITED', c: '1,23,456.00' },
    { a: '2',  b: 'RAMU',                          c: '99.00' },
  ]);
  autofitColumns(ws);
  const w = ws.columns.map(c => c.width);
  check('a wide column gets more room than a narrow one', w[1] > w[0], JSON.stringify(w));
  check('the widest value fits', w[1] >= 'ELAICHIROYAL PRIVATE LIMITED'.length, String(w[1]));
  check('a short column is not padded out to a fixed default', w[0] < 15, String(w[0]));
}
{
  // A single enormous cell must not push everything else off the page.
  const ws = sheetWith([{ a: 'x'.repeat(400), b: 'B', c: 'C' }]);
  autofitColumns(ws);
  check('an enormous cell is clamped', ws.columns[0].width <= 52, String(ws.columns[0].width));
}
{
  const ws = sheetWith([{ a: '', b: '', c: '' }]);
  autofitColumns(ws);
  check('an empty column keeps a usable minimum',
        ws.columns.every(c => c.width >= 8), JSON.stringify(ws.columns.map(c => c.width)));
}
{
  // The company banner is merged across every column; letting its text
  // drive the measurement would blow out column A on every report.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.columns = [{ key: 'a' }, { key: 'b' }];
  ws.mergeCells('A1:B1');
  ws.getCell('A1').value = 'INDIAN SPICES PRIVATE LIMITED — BODINAYAKANUR — GSTIN 33AAAAA0000A1Z5';
  ws.addRow({ a: 'ok', b: 'ok' });
  autofitColumns(ws);
  check('a merged banner does not blow out its column',
        ws.columns[0].width <= 12, String(ws.columns[0].width));
}
{
  const ws = sheetWith([{ a: 'line one\nline two is longer', b: 'B', c: 'C' }]);
  autofitColumns(ws);
  check('a multi-line cell measures its longest line, not the whole string',
        ws.columns[0].width < 'line one\nline two is longer'.length,
        String(ws.columns[0].width));
}

console.log('\n[pdf] autofit is the default');
check('every report type autofits unless it opts out', PDF_AUTOFIT.has('collection')
      && PDF_AUTOFIT.has('trade_report') && PDF_AUTOFIT.has('lot_payment'));
check('and the opt-out list is the only exception',
      PDF_NO_AUTOFIT instanceof Set && PDF_NO_AUTOFIT.size === 0,
      `${PDF_NO_AUTOFIT.size} opted out`);

// ── End to end: a real export off a real server ──────────────────
// A helper nothing calls fixes nothing, so pull actual workbooks and read
// their column widths back.
const os = require('os'), fs = require('fs');
const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autofit-'));
const PORT = 47561;
const B = `http://127.0.0.1:${PORT}`;
const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};
let TOKEN = '';
const api = async (m, u, b) => {
  const r = await fetch(B + u, { method: m,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: b ? JSON.stringify(b) : undefined });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', srvLog.slice(-1500)); cleanup(); process.exit(1); }

  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-12', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  // One very long seller name and one short, so a fitted sheet must give
  // the name column visibly more room than the lot-number column.
  for (const [lot_no, name] of [
    ['1',  'ELAICHIROYAL CARDAMOM PLANTATIONS PRIVATE LIMITED'],
    ['2',  'RAMU'],
  ]) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name, qty: 100,
      grade: '1', bags: 8, crop: 'CARDAMOM', branch: 'BODINAYAKANUR' });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    await api('PUT', `/api/lots/${id}`, { price: 400, amount: 40000 });
  }

  const widthsOf = async (url) => {
    const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) return null;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const ws = wb.worksheets[0];
    return ws.columns.map(c => c.width);
  };

  console.log('\n[live] real exports');
  {
    const w = await widthsOf(`/api/exports/lot_name/${aid}?format=xlsx`);
    check('a shared-builder export comes back fitted', !!w && w.length > 2, JSON.stringify(w));
    check('and its widths are not all the old fixed default',
          !!w && new Set(w).size > 1, JSON.stringify(w));
    check('with room for the longest seller name',
          !!w && Math.max(...w) >= 40, JSON.stringify(w));
  }
  {
    // Spice Board sheets build their own workbooks and previously set no
    // widths at all — ExcelJS's 8.43 default truncated everything.
    const w = await widthsOf(`/api/spice-board-reports/form_c/export?format=xlsx&auctionId=${aid}`);
    check('a Spice Board sheet is fitted too', !!w && w.some(x => x > 9), JSON.stringify(w));
  }
  {
    const r = await fetch(B + `/api/exports/lot_name/${aid}?format=pdf`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const buf = Buffer.from(await r.arrayBuffer());
    check('the PDF still renders with autofit on by default',
          r.status === 200 && buf.slice(0, 4).toString() === '%PDF' && buf.length > 1000,
          `${r.status}, ${buf.length} bytes`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); });
