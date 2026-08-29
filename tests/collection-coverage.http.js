// COLLECTION vs the AUCTION REPORT — why the two can disagree, and the note
// that now says so.
//
// Collection is an INVOICE register: it lists documents that were issued.
// The Auction Report is computed from the LOTS, so it shows every buyer the
// moment a lot is priced. The two therefore differ by exactly what has not
// been invoiced — and a register that silently prints fewer rows reads as
// lost records rather than as work still to do.
//
//   [complete]  fully invoiced trade → the two agree, and the register says
//               nothing extra
//   [partial]   invoice one buyer of two → Collection is short by the other
//               buyer's quantity, and SAYS so
//   [orphaned]  lots stamped with invoice numbers whose invoice rows are gone
//               → the register is empty and calls that out specifically, which
//               is the case that reads as "missing records"
//   [totals]    the note never touches the money: the grand total is always
//               exactly what was invoiced
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coll-cover-'));
const PORT = 47393;
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
async function raw(url) {
  const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}

// The Collection sheet, as { rows, grandTotalQty, note }.
async function collection(aid) {
  const r = await raw(`/api/exports/collection/${aid}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0];
  let grand = null, note = null, data = 0;
  ws.eachRow((row) => {
    const c1 = String(row.getCell(1).value == null ? '' : row.getCell(1).value);
    const c3 = String(row.getCell(3).value == null ? '' : row.getCell(3).value);
    if (/^NOT IN THIS REGISTER/.test(c1)) { note = c1; return; }
    if (c3 === 'GRAND TOTAL') { grand = Number(row.getCell(4).value) || 0; return; }
    if (typeof row.getCell(4).value === 'number' && c1 && !/TOTAL/.test(c3)) data++;
  });
  return { status: r.status, rows: data, grand, note };
}
// The Auction Report's own QUANTITY total, for the consistency assertion.
async function auctionReportQty(aid) {
  const r = await raw(`/api/exports/trade_report/${aid}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0];
  let qty = 0;
  ws.eachRow((row) => {
    const label = String(row.getCell(2).value || '');
    if (label === 'GRAND TOTAL') qty = Number(row.getCell(5).value) || 0;
  });
  return qty;
}

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

  const auc = await api('POST', '/api/auctions', { ano: '88', date: '2026-08-29', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  for (const [code, name] of [['B1', 'ANKIT SPICES'], ['B2', 'MAR TRADERS']]) {
    await api('POST', '/api/buyers', { buyer: code, buyer1: name, code, pla: 'BODINAYAKANUR',
                                       state: 'TAMIL NADU', st_code: '33', gstin: '33AAHCE4551A1Z8' });
  }
  // Two buyers, two lots each, 100 kg per lot — 400 kg sold in the trade.
  const lotIds = {};
  for (const [lot_no, code, buyer] of [
    ['1', 'B1', 'ANKIT SPICES'], ['2', 'B1', 'ANKIT SPICES'],
    ['3', 'B2', 'MAR TRADERS'],  ['4', 'B2', 'MAR TRADERS'],
  ]) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'PLANTER ' + lot_no,
                                               cr: '', qty: 100, bags: 5, grade: '1', crop: 'CARDAMOM' });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    lotIds[lot_no] = id;
    await api('PUT', `/api/lots/${id}`, { price: 1000, amount: 100000, balance: 98000,
                                          code, buyer: code, buyer1: buyer, sale: 'L' });
  }

  const soldQty = await auctionReportQty(aid);
  check('the Auction Report sees all 400 kg', Math.abs(soldQty - 400) < 0.01, String(soldQty));

  console.log('\n[orphaned] lots stamped with invoice numbers whose rows are gone');
  // The state that reads as "Collection is missing records": every lot claims
  // to have been billed, and the register holds nothing.
  for (const n of ['1', '2', '3', '4']) {
    await api('PUT', `/api/lots/${lotIds[n]}`, { invo: String(100 + Number(n)) });
  }
  let c = await collection(aid);
  check('the register is empty', c.rows === 0, `${c.rows} rows`);
  check('…and says so, rather than looking like a short trade', !!c.note, String(c.note));
  check('…naming the whole sold quantity as uncovered',
        /400\.000 kg of the 400\.000 kg/.test(String(c.note)), String(c.note));
  check('…and calling out the stamped-but-absent documents',
        /already carry an invoice or proforma number/.test(String(c.note))
        && /deleted or never imported/.test(String(c.note)), String(c.note));
  check('it points at the Auction Report for the difference',
        /Auction Report is computed from the lots/.test(String(c.note)), String(c.note));

  console.log('\n[complete] a fully invoiced trade says nothing extra');
  // Clear the hand-written stamps and bill the trade properly.
  for (const n of ['1', '2', '3', '4']) await api('PUT', `/api/lots/${lotIds[n]}`, { invo: '' });
  const gen = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 1 });
  check('invoices generate for the whole trade', gen.status === 200,
        `HTTP ${gen.status} ${JSON.stringify(gen.d).slice(0, 200)}`);
  c = await collection(aid);
  const arQty = await auctionReportQty(aid);
  check('Collection now covers the whole trade', Math.abs((c.grand || 0) - arQty) < 1,
        `collection ${c.grand} vs auction report ${arQty}`);
  check('…and the register says nothing extra', !c.note, String(c.note));
  const invoiced = c.grand || 0;

  console.log('\n[partial] two more lots are sold but not yet billed');
  for (const lot_no of ['5', '6']) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'PLANTER ' + lot_no,
                                               cr: '', qty: 100, bags: 5, grade: '1', crop: 'CARDAMOM' });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`, { price: 1000, amount: 100000, balance: 98000,
                                          code: 'B2', buyer: 'B2', buyer1: 'MAR TRADERS', sale: 'L' });
  }
  const soldNow = await auctionReportQty(aid);
  check('the Auction Report picks the new lots up at once', Math.abs(soldNow - 600) < 0.01, String(soldNow));
  c = await collection(aid);
  check('the register still lists only what was invoiced', Math.abs((c.grand || 0) - invoiced) < 0.001,
        `${c.grand} vs ${invoiced}`);
  check('the shortfall is stated in kilos', !!c.note && /NOT IN THIS REGISTER/.test(String(c.note)), String(c.note));
  check('…and it equals sold − invoiced',
        new RegExp(`${(600 - invoiced).toFixed(3).replace('.', '\\.')} kg of the 600\\.000 kg`).test(String(c.note)),
        `expected ${(600 - invoiced).toFixed(3)}; note: ${c.note}`);
  check('the un-billed lots are described as not yet invoiced',
        /2 lots have not been invoiced yet/.test(String(c.note)), String(c.note));
  check('…and it does NOT claim documents went missing — nothing was ever raised for them',
        !/deleted or never imported/.test(String(c.note)), String(c.note));

  console.log('\n[totals] the note never touches the money');
  check('the grand total is exactly what was invoiced', Math.abs((c.grand || 0) - invoiced) < 0.001,
        `${c.grand} vs ${invoiced}`);

  console.log('\n[pdf] the twin renders in the same state');
  const pdf = await raw(`/api/exports/collection/${aid}?format=pdf`);
  check('the PDF still renders', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF',
        `HTTP ${pdf.status}`);
  check('…and is a real page', pdf.buf.length > 2000, `${pdf.buf.length} bytes`);

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); done(1); });
