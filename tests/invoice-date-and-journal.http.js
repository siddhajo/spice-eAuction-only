// Where the date on an invoice — and on the Tally vouchers built from it —
// actually comes from.
//
// Reported as "the Merchants XML date is +1 of the auction date". The export
// is faithful: it prints the INVOICE date, and an invoice is dated by
// `dateSource` — "today" (the day it is raised) or "auction". Generate on the
// morning after the auction with the default and every document, including
// the XML, carries that later day. So this pins THREE things:
//
//   1. nothing in the export shifts a date — `toTallyDate` is pure string
//      work, so no Date object is ever built from a date-only string here;
//   2. an install can now DEFAULT to the auction date (invoice_date_source),
//      so a site that files by auction day stops re-picking the dropdown;
//   3. the Merchants journal — ONE voucher consolidating every invoice in the
//      trade — is dated by the AUCTION, at the operator's instruction. It is
//      that trade's merchant control entry, so it belongs on the auction's
//      day whatever date the invoices were raised under. It used to take
//      `rows[0].date`: the lowest-numbered invoice of the first sale type,
//      which is arbitrary once a trade spans two days.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'invdate-'));
const PORT = 47398;
const B = `http://127.0.0.1:${PORT}`;
const AUCTION_DATE = '2026-10-17';
const AUCTION_YMD  = '20261017';

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
  return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('utf8') };
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
const todayYMD = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const journalDate = (xml) => (String(xml).match(/<DATE>(\d{8})<\/DATE>/) || [])[1] || '';
const wipeInvoices = async () => {
  const inv = (await api('GET', '/api/invoices?auction_id=1')).d || [];
  for (const i of (Array.isArray(inv) ? inv : [])) await api('DELETE', '/api/invoices/' + i.id);
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', trade_name: 'RNS SPICES', gst_goods: '5', commission: '1',
    business_state: 'TAMIL NADU', flag_merchants: 'true' } });
  await api('POST', '/api/auctions', { ano: '20', date: AUCTION_DATE, crop_type: 'ISP' });
  await api('POST', '/api/auctions/1/allocations', { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  for (const [code, name] of [['B1', 'MURUGAN TRADERS'], ['B2', 'SECOND TRADER']]) {
    await api('POST', '/api/buyers', { buyer: code, buyer1: name, pla: 'CUMBUM',
      gstin: `33ALCPU9807E1Z${code === 'B1' ? '0' : '9'}`, add1: 'MAIN ST' });
  }
  const sellers = [];
  for (const [n, tel, lot] of [['RAVI PLANTER', '9790744441', '001'], ['MEENA ESTATE', '9790744442', '002']]) {
    const t = (await api('POST', '/api/traders', { name: n, tel, ppla: 'BODIMETTU' })).d.trader;
    await api('POST', '/api/lots', { auction_id: 1, lot_no: lot, trader_id: t.id, branch: 'BODI',
      grade: '1', bags: 10, litre: '300', qty: 400, sample_wt: 2.95, gross_wt: 402.95 });
    sellers.push(lot);
  }
  const lots = (await api('GET', '/api/lots/1')).d || [];
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3152 })) });
  for (const [lot, code, name] of [['001', 'B1', 'MURUGAN TRADERS'], ['002', 'B2', 'SECOND TRADER']]) {
    const ids = lots.filter(l => l.lot_no === lot).map(l => l.id);
    await api('POST', '/api/lots/bulk-set-buyer', { ids, code, buyer: code, buyer1: name, sale: 'L' });
  }
  await api('POST', '/api/lots/calculate/1', {});

  console.log('[1] Auction-dated invoices reach Tally on the auction day');
  await wipeInvoices();
  let r = await api('POST', '/api/invoices/generate-all/1', { startInvoiceNo: 1, dateSource: 'auction' });
  check('invoices raise on the auction date', r.status === 200, r.d && r.d.error);
  let rows = (await api('GET', '/api/invoices?auction_id=1')).d || [];
  check('…and carry it', rows.length === 2 && rows.every(x => x.date === AUCTION_DATE), rows.map(x => x.date));
  let xml = (await api('GET', '/api/tally/export/merchants/1')).text;
  check('the Merchants journal reaches Tally on the auction day, to the day',
        journalDate(xml) === AUCTION_YMD, { journal: journalDate(xml), expected: AUCTION_YMD });

  console.log('\n[2] The journal stays on the auction day even when invoices do not');
  await wipeInvoices();
  r = await api('POST', '/api/invoices/generate-all/1', { startInvoiceNo: 1, dateSource: 'today' });
  rows = (await api('GET', '/api/invoices?auction_id=1')).d || [];
  xml = (await api('GET', '/api/tally/export/merchants/1')).text;
  check('invoices raised "today" carry today', rows.every(x => x.date.replace(/-/g, '') === todayYMD()),
        rows.map(x => x.date));
  check('…and the journal is STILL the auction date', journalDate(xml) === AUCTION_YMD,
        { journal: journalDate(xml), auction: AUCTION_YMD, invoices: rows.map(x => x.date) });
  // The sales vouchers are tax documents and must keep their own dates — only
  // the consolidating journal is dated by the trade.
  const salesXml = (await api('GET', '/api/tally/export/sales/1')).text;
  check('the SALES vouchers keep the invoice date, not the auction date',
        salesXml.includes(`<DATE>${todayYMD()}</DATE>`) && !salesXml.includes(`<DATE>${AUCTION_YMD}</DATE>`),
        { today: todayYMD(), auction: AUCTION_YMD });

  console.log('\n[3] The install can default to the auction date');
  // This is the fix for the report: set it once, and a caller that sends no
  // choice (an older client, a script, the modal left untouched) gets it.
  for (const [def, expect] of [['auction', AUCTION_DATE], ['today', null]]) {
    await api('PUT', '/api/company-settings', { settings: { invoice_date_source: def } });
    await wipeInvoices();
    await api('POST', '/api/invoices/generate/1', { saleType: 'L', buyerCode: 'B1', invoiceNo: '1' });  // no dateSource
    const got = ((await api('GET', '/api/invoices?auction_id=1')).d || [])[0] || {};
    const want = expect || new Date().toISOString().slice(0, 10);
    check(`default "${def}" is applied when the caller sends none`, got.date === want, { got: got.date, want });
  }
  // A caller that DOES choose still wins.
  await api('PUT', '/api/company-settings', { settings: { invoice_date_source: 'auction' } });
  await wipeInvoices();
  await api('POST', '/api/invoices/generate/1', { saleType: 'L', buyerCode: 'B1', invoiceNo: '1', dateSource: 'today' });
  const overridden = ((await api('GET', '/api/invoices?auction_id=1')).d || [])[0] || {};
  check('an explicit choice still overrides the default',
        overridden.date === new Date().toISOString().slice(0, 10), overridden.date);

  console.log('\n[4] One date for the trade, however the invoices were raised');
  // A trade part-invoiced on auction day and finished the next morning: the
  // journal used to take whichever row sorted first, which is arbitrary.
  await wipeInvoices();
  await api('POST', '/api/invoices/generate/1', { saleType: 'L', buyerCode: 'B1', invoiceNo: '1', dateSource: 'auction' });
  await api('POST', '/api/invoices/generate/1', { saleType: 'L', buyerCode: 'B2', invoiceNo: '2', dateSource: 'today' });
  rows = (await api('GET', '/api/invoices?auction_id=1')).d || [];
  const dates = rows.map(x => x.date).sort();
  check('the trade genuinely spans two dates', dates.length === 2 && dates[0] !== dates[1], dates);
  xml = (await api('GET', '/api/tally/export/merchants/1')).text;
  check('the journal is the auction date regardless', journalDate(xml) === AUCTION_YMD,
        { journal: journalDate(xml), dates });
  check('exactly one journal voucher carries it',
        (xml.match(/<DATE>/g) || []).length === 1, (xml.match(/<DATE>\d+<\/DATE>/g) || []));
  // There is no "export only these" for this one, and that is right: a
  // consolidated journal for a SUBSET of a trade's invoices would credit the
  // control ledger with a figure that reconciles against nothing. The refusal
  // is asserted so the absence stays deliberate rather than looking like a
  // gap somebody should fill.
  const laterInvoice = rows.find(x => x.date.replace(/-/g, '') === todayYMD());
  const sel = await api('POST', '/api/tally/export-selected/merchants/1', { ids: [laterInvoice.id] });
  check('a partial journal is refused, not silently built', sel.status === 400,
        { status: sel.status });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-25).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
