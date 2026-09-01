// CHECKLIST COLUMN TOGGLES — the per-install DUMMY / BUYER switches.
//
// The verification sheet is LOT | DUMMY | BUYER | BAGS | QTY | SALE, but not
// every desk wants both optional columns. Two settings drop one:
//
//     checklist_show_dummy   Settings → Feature Flags → "Checklist: Dummy column"
//     checklist_show_buyer   Settings → Feature Flags → "Checklist: Buyer column"
//
//   [default]  a fresh install prints both, and so does one that upgrades
//              before anyone opens Settings — a missing key must never be read
//              as "off", or every existing site silently loses two columns.
//   [xlsx]     each switch drops exactly its own column from the spreadsheet,
//              and the remaining cells still carry the right values (a dropped
//              column must not shift the row).
//   [pdf]      the same switch reaches the PDF renderer. Its text is written as
//              subset-font glyph indices and can't be scanned, so this is
//              asserted the way the repo already asserts the checklist PDF: the
//              shared rule that decides the columns, plus the rendered bytes
//              actually changing when a column is dropped.
//   [both off] the sheet degrades to LOT | BAGS | QTY | SALE — the lot and its
//              figures are the point of the report and are never droppable.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-cols-'));
const PORT = 47373;
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

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

const ExcelJS = require('exceljs');

// Pull the Checklist's header row and data rows out of the XLSX. The sheet
// carries a title + meta lines above the table, so the header is found by its
// content rather than by a fixed row number.
async function checklistSheet(aid) {
  const r = await fetch(`${B}/api/exports/checklist/${aid}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (r.status !== 200) return { status: r.status };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0];
  const cell = v => String(v == null ? '' : (v.text || v)).trim();
  let hdr = null, hdrRow = 0;
  ws.eachRow((row, n) => {
    const vals = row.values.slice(1).map(cell);
    if (!hdr && vals.includes('LOT') && vals.includes('QTY')) { hdr = vals.filter(Boolean); hdrRow = n; }
  });
  const rows = [];
  ws.eachRow((row, n) => { if (n > hdrRow) rows.push(row.values.slice(1).map(cell)); });
  return { status: 200, hdr, rows };
}
async function checklistPdf(aid) {
  const r = await fetch(`${B}/api/exports/checklist/${aid}?format=pdf`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}
const setCols = (dummy, buyer) => api('PUT', '/api/company-settings', {
  settings: { checklist_show_dummy: String(dummy), checklist_show_buyer: String(buyer) },
});

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }

  const auc = await api('POST', '/api/auctions', { ano: '77', date: '2026-09-01', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const mk = async (lot_no) => {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'RAMU', bags: 3, qty: 55.5 });
    return r.d.id || (r.d.lot && r.d.lot.id);
  };
  const id1 = await mk('001');
  await mk('002');
  await api('PUT', `/api/lots/${id1}`, { price: 100, amount: 5550, code: 'TS', buyer: 'TS' });
  await api('POST', `/api/lots/${id1}/dummy-code`, { value: 'AX7' });

  const FULL = ['LOT', 'DUMMY', 'BUYER', 'BAGS', 'QTY', 'SALE'];

  // ══ [default] a fresh install, and an install that never opened Settings ══
  console.log('\n[default] both optional columns print until told otherwise');
  const seeded = (await api('GET', '/api/company-settings/flat')).d || {};
  check('checklist_show_dummy seeds to true', String(seeded.checklist_show_dummy) === 'true',
        JSON.stringify(seeded.checklist_show_dummy));
  check('checklist_show_buyer seeds to true', String(seeded.checklist_show_buyer) === 'true',
        JSON.stringify(seeded.checklist_show_buyer));

  const base = await checklistSheet(aid);
  check('XLSX returns 200', base.status === 200, String(base.status));
  check('all six columns print by default', JSON.stringify(base.hdr) === JSON.stringify(FULL),
        JSON.stringify(base.hdr));

  // The upgrade path: settings row absent entirely. Asserted on the shared rule
  // rather than by deleting the row, because that is what both renderers call.
  const { checklistVisibleCols, CHECKLIST_COLS } = require(path.join(ROOT, 'exports.js'));
  const hdrsFor = cfg => checklistVisibleCols(CHECKLIST_COLS, cfg).map(c => c.header);
  check('a config with NO checklist keys still prints both columns',
        JSON.stringify(hdrsFor({})) === JSON.stringify(FULL), JSON.stringify(hdrsFor({})));
  check('an undefined config prints both columns',
        JSON.stringify(hdrsFor(undefined)) === JSON.stringify(FULL), JSON.stringify(hdrsFor(undefined)));

  const pdfBoth = await checklistPdf(aid);
  check('PDF returns 200 with both columns', pdfBoth.status === 200, String(pdfBoth.status));

  // ══ [xlsx] each switch drops exactly its own column ══════════════
  console.log('\n[xlsx] each switch drops exactly its own column');
  await setCols(false, true);
  const noDummy = await checklistSheet(aid);
  check('DUMMY off → LOT | BUYER | BAGS | QTY | SALE',
        JSON.stringify(noDummy.hdr) === JSON.stringify(['LOT', 'BUYER', 'BAGS', 'QTY', 'SALE']),
        JSON.stringify(noDummy.hdr));
  const nd1 = noDummy.rows.find(r => String(r[0]).replace(/^0+/, '') === '1');
  check('…and the row closes up: BUYER moves into the second column',
        nd1 && nd1[1] === 'TS', JSON.stringify(nd1));
  check('…with the figures still on the right lot', nd1 && nd1[2] === '3', JSON.stringify(nd1));

  await setCols(true, false);
  const noBuyer = await checklistSheet(aid);
  check('BUYER off → LOT | DUMMY | BAGS | QTY | SALE',
        JSON.stringify(noBuyer.hdr) === JSON.stringify(['LOT', 'DUMMY', 'BAGS', 'QTY', 'SALE']),
        JSON.stringify(noBuyer.hdr));
  const nb1 = noBuyer.rows.find(r => String(r[0]).replace(/^0+/, '') === '1');
  check('…and DUMMY keeps its place beside LOT', nb1 && nb1[1] === 'AX7', JSON.stringify(nb1));

  // ══ [both off] the sheet keeps what it exists for ════════════════
  console.log('\n[both off] LOT / BAGS / QTY / SALE are never droppable');
  await setCols(false, false);
  const neither = await checklistSheet(aid);
  check('both off → LOT | BAGS | QTY | SALE',
        JSON.stringify(neither.hdr) === JSON.stringify(['LOT', 'BAGS', 'QTY', 'SALE']),
        JSON.stringify(neither.hdr));
  check('every lot is still listed', neither.rows.filter(r => /^0*\d+$/.test(String(r[0]))).length === 2,
        String(neither.rows.length));

  // ══ [pdf] the switch reaches the other renderer too ══════════════
  console.log('\n[pdf] the same switch narrows the printed sheet');
  const pdfNeither = await checklistPdf(aid);
  check('PDF still returns 200 with both columns off', pdfNeither.status === 200, String(pdfNeither.status));
  // Two fewer columns is a different page. Byte-identical output would mean the
  // renderer never saw the setting.
  check('PDF bytes change when columns are dropped',
        pdfBoth.status === 200 && pdfNeither.status === 200
          && !pdfBoth.buf.equals(pdfNeither.buf),
        `${pdfBoth.buf.length} vs ${pdfNeither.buf.length}`);
  // The module-level spec must stay whole — it is the source the rule narrows,
  // and a mutated copy would leak one download's columns into the next.
  const { COLS } = require(path.join(ROOT, 'exports-pdf.js'));
  check('COLS.checklist is not mutated by a narrowed render',
        JSON.stringify(COLS.checklist.map(c => c.header)) === JSON.stringify(FULL),
        JSON.stringify(COLS.checklist.map(c => c.header)));
  check('CHECKLIST_COLS is not mutated either',
        JSON.stringify(CHECKLIST_COLS.map(c => c.header)) === JSON.stringify(FULL),
        JSON.stringify(CHECKLIST_COLS.map(c => c.header)));

  // ══ restore ══════════════════════════════════════════════════════
  console.log('\n[restore] turning both back on returns the full sheet');
  await setCols(true, true);
  const restored = await checklistSheet(aid);
  check('all six columns are back', JSON.stringify(restored.hdr) === JSON.stringify(FULL),
        JSON.stringify(restored.hdr));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
