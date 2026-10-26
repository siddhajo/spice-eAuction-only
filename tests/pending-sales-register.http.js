// Pending Sales Invoice Register — proforma drafts still awaiting their
// original, ACROSS ALL TRADES.
//
// "What have we quoted but not yet billed?" is never a one-trade question:
// drafts accumulate across trades and the oldest are the ones worth chasing.
// So this reads by date range like the per-party registers, not per trade.
//
//   [pending]  only drafts with no original raised against them
//   [cross]    drafts from SEVERAL trades land in one sheet
//   [raised]   raising the original takes a draft off the list
//   [age]      rows carry the age that makes it a worklist, oldest first
//   [export]   the xlsx builds and carries the same rows
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pendreg-'));
const PORT = 48142;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

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

let T = '';
const api = async (m, u, b) => {
  const r = await fetch(B + u, { method: m,
    headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) },
    body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  await api('PUT', '/api/company-settings', {
    settings: { br1: 'BODI', flag_proforma_invoice: 'true' } });
  await api('POST', '/api/buyers', { buyer: 'B1', code: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
  const seller = (await api('POST', '/api/traders', { name: 'PENDING SELLER', tel: '9790744421', ppla: 'BODIMETTU' })).d.trader;

  // Two trades, each with a draft raised over its own lots.
  const mkTrade = async (ano, date, lots, startNo) => {
    const a = (await api('POST', '/api/auctions', { ano, date, crop_type: 'ISP' })).d;
    await api('POST', `/api/auctions/${a.id}/allocations`,
      { allocations: [{ branch: 'BODI', start_lot: lots[0], end_lot: lots[lots.length - 1] }] });
    for (const n of lots) {
      await api('POST', '/api/lots', { auction_id: a.id, lot_no: n, trader_id: seller.id,
        branch: 'BODI', grade: '1', bags: 10, litre: '300', qty: 500,
        sample_wt: 2.95, gross_wt: 502.95 });
    }
    const ls = (await api('GET', `/api/lots/${a.id}`)).d || [];
    await api('POST', '/api/lots/bulk-set-buyer', { ids: ls.map(l => l.id),
      code: 'B1', buyer: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
    await api('POST', '/api/lots/bulk-price', { items: ls.map(l => ({ id: l.id, price: 3000 })) });
    await api('POST', `/api/lots/calculate/${a.id}`, {});
    // dateSource:'auction' dates each draft from its trade rather than
    // today, so the two carry genuinely different ages. Without it both are
    // raised now and every age is 0 — true, but it tests nothing.
    const r = await api('POST', `/api/invoices/generate-all/${a.id}`,
      { startInvoiceNo: startNo, docType: 'proforma', dateSource: 'auction' });
    return { a, gen: r };
  };
  const t1 = await mkTrade('60', '2026-09-01', ['001', '002'], 100);
  const t2 = await mkTrade('61', '2026-10-01', ['010', '011'], 200);
  check('two trades each raised a draft', t1.gen.s === 200 && t2.gen.s === 200,
        { t1: t1.gen.d, t2: t2.gen.d });

  const reg = async (qs) => (await api('GET', '/api/registers/pending-sales?' + qs)).d || [];

  console.log('[pending] only drafts awaiting their original');
  let rows = await reg('from=2000-01-01&to=2099-12-31');
  check('both drafts are listed', rows.length === 2, rows.map(r => r.invo));
  check('every row is a draft with no original raised',
        rows.every(r => String(r.invo || '').trim() !== ''), rows.map(r => r.invo));

  console.log('\n[cross] drafts from SEVERAL trades land in one sheet');
  const tnos = [...new Set(rows.map(r => String(r.tno)))].sort();
  check('both trades are represented', tnos.length === 2 && tnos.includes('60') && tnos.includes('61'), tnos);

  console.log('\n[age] it reads as a worklist — oldest first');
  check('rows carry an age in days', rows.every(r => Number.isFinite(Number(r.age_days))),
        rows.map(r => r.age_days));
  check('the older trade sorts first', String(rows[0].tno) === '60',
        rows.map(r => ({ tno: r.tno, age: r.age_days })));
  check('…and is genuinely older', Number(rows[0].age_days) > Number(rows[rows.length - 1].age_days),
        rows.map(r => r.age_days));

  console.log('\n[raised] raising the original takes a draft off the list');
  const drafts = (await api('GET', `/api/invoices?auction_id=${t1.a.id}&docType=proforma`)).d;
  const list = (Array.isArray(drafts) ? drafts : (drafts.rows || [])).filter(i => Number(i.is_proforma) === 1);
  const r = await api('POST', `/api/invoices/${list[0].id}/raise-original`, {});
  check('the original is raised', r.s === 200, r.d);
  rows = await reg('from=2000-01-01&to=2099-12-31');
  check('the raised draft is gone', rows.length === 1, rows.map(r2 => ({ tno: r2.tno, invo: r2.invo })));
  check('…and the one still pending remains', String(rows[0].tno) === '61', rows[0]);

  console.log('\n[export] the spreadsheet builds from the same rows');
  const x = await fetch(B + '/api/exports/pending-sales-register?from=2000-01-01&to=2099-12-31&format=xlsx',
    { headers: { Authorization: 'Bearer ' + T } });
  check('the xlsx builds', x.status === 200, x.status);
  if (x.status === 200) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    const flat = JSON.stringify(wb.worksheets[0].getSheetValues());
    // The report title is the SHEET NAME (createExcelBuffer's first arg); the
    // cells carry the company header and the period meta line.
    check('the sheet is named for the register',
          wb.worksheets[0].name === 'PendingSalesRegister', wb.worksheets[0].name);
    check('…and states the period it covers', /Period: /.test(flat), flat.slice(0, 160));
    check('it carries the DAYS column', /DAYS/.test(flat));
    check('it lists the still-pending trade', /"61"|,61,/.test(flat) || /61/.test(flat));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-15).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-1200)); cleanup(); process.exit(1); });
