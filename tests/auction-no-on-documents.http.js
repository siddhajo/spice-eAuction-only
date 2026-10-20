// Every document prints the TRADE NUMBER, never the row id.
//
// `auctions.ano` is the number the office, the buyer and the Spices Board all
// use; `auctions.id` is a row id that merely looks like one. A purchase
// invoice was printing the id — "e-AUCTION No: 21" on a sheet whose own note
// line, two inches below, said "Auction Sales in Auction No: 20". Both name
// the same trade.
//
// THE FIXTURE IS THE TEST. Trade #20 is created SECOND, so its id is 2 and its
// ano is 20: every assertion below would pass by accident if the two matched,
// which is exactly why the bug survived — on a fresh install the first trade
// is id 1 / ano 1 and nothing looks wrong.
//
// Reading the PDFs needs `pdftotext` (poppler). Without it those checks are
// skipped and say so, rather than silently reporting success.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ano-doc-'));
const PORT = 47397;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0, skipped = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + JSON.stringify(detail) : '')); }
}
const skip = (name, why) => { skipped++; console.log('  skip ' + name + ' — ' + why); };

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

let HAVE_PDFTOTEXT = false;
try { execSync('pdftotext -v 2>&1'); HAVE_PDFTOTEXT = true; } catch (_) { HAVE_PDFTOTEXT = false; }
function pdfText(buf) {
  const f = path.join(TMP, 'probe.pdf');
  fs.writeFileSync(f, buf);
  try { return execSync(`pdftotext -layout "${f}" - 2>/dev/null`, { maxBuffer: 1 << 26 }).toString(); }
  catch (_) { return ''; }
}
// Every number printed anywhere near an auction-number label. Both layouts are
// covered: "e-AUCTION No: 20" on one line (PDFKit), and a label row with the
// value in the row beneath (the HTML table layouts) — which is why this looks
// forward through the next line too, rather than demanding one tidy line.
function auctionNosIn(text) {
  const lines = String(text || '').split(/\r?\n/);
  const found = [];
  const LABEL = /e-?\s*auction\s*no|auction\s*no/i;
  for (let i = 0; i < lines.length; i++) {
    if (!LABEL.test(lines[i])) continue;
    const sameLine = lines[i].replace(/.*?(?:e-?\s*auction\s*no|auction\s*no)[^0-9]{0,10}/i, '');
    const m1 = sameLine.match(/^(\d{1,6})/);
    if (m1) { found.push(m1[1]); continue; }
    // Table layout: the value sits in the row BENEATH its label, in the same
    // column. Taking the row's first number instead would read the INVOICE NO
    // column — which is how this check first "passed" against the wrong field.
    const col = lines[i].search(/e-?\s*auction\s*no/i);
    const next = lines[i + 1] || '';
    const window = col >= 0 ? next.slice(Math.max(0, col - 4), col + 30) : next;
    const m2 = window.match(/(\d{1,6})/);
    if (m2) found.push(m2[1]);
  }
  return found;
}

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', trade_name: 'RNS SPICES', commission: '1', gst_service: '18', gst_goods: '5',
    flag_debit_note: 'true', flag_debit_note_planter: 'true' } });
  // A decoy trade first, so the one under test has id 2 and ano 20.
  await api('POST', '/api/auctions', { ano: '19', date: '2026-10-10', crop_type: 'ISP' });
  await api('POST', '/api/auctions', { ano: '20', date: '2026-10-17', crop_type: 'ISP' });
  const AID = 2, ANO = '20';
  const a = (await api('GET', '/api/auctions?limit=5')).d;
  const row = (Array.isArray(a) ? a : (a && a.rows) || []).find(x => Number(x.id) === AID);
  check('the fixture has id 2 but trade number 20 — the two must differ',
        row && String(row.ano) === ANO && Number(row.id) === 2, row && { id: row.id, ano: row.ano });

  await api('POST', `/api/auctions/${AID}/allocations`, { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '050' }] });
  const dealer = (await api('POST', '/api/traders', { name: 'ABSAL SPICES', tel: '9790744440',
    ppla: 'CUMBUM', cr: 'GSTIN.33ALCPU9807E1Z0', aadhar: 'SBL0' })).d.trader;
  const planter = (await api('POST', '/api/traders', { name: 'RAVI PLANTER', tel: '9790744441', ppla: 'BODIMETTU' })).d.trader;
  await api('POST', '/api/lots', { auction_id: AID, lot_no: '001', trader_id: dealer.id, branch: 'BODI',
    grade: '2', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  await api('POST', '/api/lots', { auction_id: AID, lot_no: '002', trader_id: planter.id, branch: 'BODI',
    grade: '1', bags: 10, litre: '300', qty: 400, sample_wt: 2.95, gross_wt: 402.95 });
  const lots = (await api('GET', `/api/lots/${AID}`)).d || [];
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3152, code: 'B1', buyer: 'B1' })) });
  await api('POST', `/api/lots/calculate/${AID}`, {});
  await api('POST', `/api/purchases/generate-all/${AID}`, { startInvoiceNo: 1 });
  await api('POST', `/api/bills/generate-all/${AID}`, { startBillNo: 1 });
  const purIds  = ((await api('GET', `/api/purchases?auction_id=${AID}`)).d || []).map(p => p.id);
  const billRows = (await api('GET', `/api/bills?auction_id=${AID}`)).d || [];
  check('a purchase invoice and a bill of supply exist to print',
        purIds.length === 1 && billRows.length === 1, { purIds, bills: billRows.length });
  check('the stored bill already carries the trade number', String(billRows[0].ano) === ANO, billRows[0] && billRows[0].ano);

  // Every surface that prints an auction number for this trade.
  const surfaces = [
    ['purchase invoice · PDFKit',        () => api('POST', '/api/purchases/pdf-bulk', { ids: purIds, template: 'classic' })],
    ['purchase invoice · HTML',          () => api('POST', '/api/purchases/pdf-bulk', { ids: purIds, template: 'modern' })],
    ['bill of supply · bulk · PDFKit',   () => api('POST', '/api/bills/pdf-bulk', { ids: billRows.map(b => b.id), template: 'classic' })],
    ['bill of supply · bulk · HTML',     () => api('POST', '/api/bills/pdf-bulk', { ids: billRows.map(b => b.id), template: 'modern' })],
    ['bill of supply · single · PDFKit', () => api('GET', `/api/bills/pdf/${AID}/${encodeURIComponent('RAVI PLANTER')}?template=classic`)],
    ['bill of supply · single · HTML',   () => api('GET', `/api/bills/pdf/${AID}/${encodeURIComponent('RAVI PLANTER')}?template=modern`)],
  ];

  console.log('\n[1] The number printed is the TRADE number, not the row id');
  if (!HAVE_PDFTOTEXT) {
    skip('every PDF surface', 'pdftotext (poppler) is not installed — install it to run these');
  } else {
    for (const [label, call] of surfaces) {
      const res = await call();
      if (res.status !== 200) { check(label + ' renders', false, { status: res.status }); continue; }
      const nos = auctionNosIn(pdfText(res.buf));
      check(`${label}: says ${ANO}`, nos.includes(ANO), { found: nos });
      // The id is 2 — a lone "2" anywhere a trade number belongs is the bug.
      check(`${label}: never says the row id`, !nos.includes(String(AID)), { found: nos });
    }
  }

  console.log('\n[2] A document never contradicts itself');
  // The purchase invoice prints the trade twice — the header strip reads
  // `eTradeNo`, the note line reads `auctionNo`. They were two different
  // fields resolved two different ways, which is how one sheet came to name
  // two trades; they must now agree.
  if (!HAVE_PDFTOTEXT) {
    skip('the purchase invoice names one trade', 'pdftotext not installed');
  } else {
    const res = await api('POST', '/api/purchases/pdf-bulk', { ids: purIds, template: 'modern' });
    const text = pdfText(res.buf);
    const header = auctionNosIn(text);
    const note = (text.match(/Auction Sales in Auction No:\s*(\d+)/i) || [])[1];
    check('the note line names the trade', note === ANO, { note });
    check('…and the header strip names the same one', header.includes(ANO) && !header.includes(String(AID)),
          { header, note });
  }

  console.log('\n[3] The documents that were already right stay right');
  // Commission bill, debit note and sales invoice resolve the number from
  // `ano` fields rather than an id, and are guarded here so a future change
  // cannot quietly regress them to the id the way the invoice did.
  const dn = await api('POST', '/api/debit-notes/generate-bulk', { ano: ANO, startNoteNo: 41 });
  check('a debit note can be raised for the trade', dn.status === 200 && (dn.d.generated || []).length === 1, dn.d);
  const dnRows = (await api('GET', `/api/debit-notes?ano=${ANO}`)).d || [];
  check('the debit note stores the trade number, not the id',
        dnRows.length === 1 && String(dnRows[0].ano) === ANO, dnRows[0] && { ano: dnRows[0].ano });
  if (HAVE_PDFTOTEXT && dnRows.length) {
    const res = await api('POST', '/api/debit-notes/pdf-bulk', { ids: [dnRows[0].id], template: 'modern' });
    if (res.status === 200) {
      const nos = auctionNosIn(pdfText(res.buf));
      check('the debit note prints the trade number', nos.includes(ANO), { found: nos });
      check('…and not the row id', !nos.includes(String(AID)), { found: nos });
    } else check('the debit note renders', false, { status: res.status });
  } else if (!HAVE_PDFTOTEXT) {
    skip('the debit note PDF', 'pdftotext not installed');
  }

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-25).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
