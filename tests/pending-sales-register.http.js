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
//   [party]    the buyer filter narrows the sheet to one buyer, by CODE
//   [raised]   raising the original takes a draft off the list
//   [columns]  ANO not TNO, and no STATE column
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
  // A SECOND buyer, so the party filter has something to leave out. With one
  // buyer every filter "works" — it just returns the whole sheet.
  await api('POST', '/api/buyers', { buyer: 'B2', code: 'B2', buyer1: 'BUYER TWO', sale: 'L' });
  const seller = (await api('POST', '/api/traders', { name: 'PENDING SELLER', tel: '9790744421', ppla: 'BODIMETTU' })).d.trader;

  // Two trades, each with a draft raised over its own lots.
  const mkTrade = async (ano, date, lots, startNo, bCode, bName, beforeRaise) => {
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
      code: bCode, buyer: bCode, buyer1: bName, sale: 'L' });
    await api('POST', '/api/lots/bulk-price', { items: ls.map(l => ({ id: l.id, price: 3000 })) });
    await api('POST', `/api/lots/calculate/${a.id}`, {});
    if (beforeRaise) await beforeRaise(a, ls);
    // dateSource:'auction' dates each draft from its trade rather than
    // today, so the two carry genuinely different ages. Without it both are
    // raised now and every age is 0 — true, but it tests nothing.
    const r = await api('POST', `/api/invoices/generate-all/${a.id}`,
      { startInvoiceNo: startNo, docType: 'proforma', dateSource: 'auction' });
    return { a, gen: r };
  };
  // ALT CODE on the FIRST trade only, so the register has to resolve one row
  // and leave the other blank — a hydrator that leaked a code across rows, or
  // keyed on the wrong invoice column, would show both or neither.
  const t1 = await mkTrade('60', '2026-09-01', ['001', '002'], 100, 'B1', 'BUYER ONE',
    async (a, ls) => {
      await api('POST', '/api/lots/dummy-code/bulk', { ids: ls.map(l => l.id), value: 'ERP' });
    });
  const t2 = await mkTrade('61', '2026-10-01', ['010', '011'], 200, 'B2', 'BUYER TWO');
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

  console.log('\n[party] the buyer filter narrows the sheet to one buyer');
  // Matched on the buyer CODE, not the trade name: names repeat across the
  // master and a name match would sweep in a namesake.
  const one = await reg('from=2000-01-01&to=2099-12-31&buyerCode=B1');
  check('one buyer, one draft', one.length === 1 && String(one[0].tno) === '60',
        one.map(r2 => ({ tno: r2.tno, bidder: r2.bidder })));
  const two = await reg('from=2000-01-01&to=2099-12-31&buyerCode=B2');
  check('…and the other buyer gets the other', two.length === 1 && String(two[0].tno) === '61',
        two.map(r2 => ({ tno: r2.tno, bidder: r2.bidder })));
  check('a buyer with no drafts gets an empty sheet, not every draft',
        (await reg('from=2000-01-01&to=2099-12-31&buyerCode=NOSUCH')).length === 0);

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

    console.log('\n[columns] ANO not TNO, and no STATE column');
    // The operator's word for the auction number is ANO, and which state
    // raised a draft does not decide whether to chase it.
    check('the auction number is headed ANO', /ANO/.test(flat), flat.slice(0, 400));
    check('…not TNO', !/TNO/.test(flat), flat.slice(0, 400));
    check('no STATE column', !/STATE/.test(flat), flat.slice(0, 400));
  }

  console.log('\n[alt code] the per-lot tag reaches the chase list');
  // The office recognises a draft by the alternate code typed in Price Entry
  // (lots.dummy_code), so the chase list carries the same column the Sales
  // Invoices list shows. Resolved through the invoice's LOTS — and a DRAFT
  // stamps lots.proforma_invo, leaving lots.invo empty, so a hydrator keyed on
  // `invo` finds nothing and the column is blank. That is the bug this pins.
  //
  // By now trade 60's draft has been raised into an original (above), so 61 is
  // the one still on the sheet; it starts UNTAGGED, which is the other half of
  // the test — a hydrator that leaked a code across rows would fill it in.
  const ls61 = (await api('GET', `/api/lots/${t2.a.id}`)).d || [];
  const row61 = async () =>
    (await reg('from=2000-01-01&to=2099-12-31')).filter(r2 => String(r2.tno) === '61')[0] || {};
  let a61 = await row61();
  check('an untagged draft carries the field, empty', 'alt_code' in a61 && a61.alt_code === '',
        { present: 'alt_code' in a61, value: a61.alt_code });
  await api('POST', '/api/lots/dummy-code/bulk', { ids: ls61.map(l => l.id), value: 'ERJ' });
  a61 = await row61();
  check('tagging its lots shows the code against the DRAFT', a61.alt_code === 'ERJ',
        { got: a61.alt_code, want: 'ERJ' });
  // Cleared means blank, not a stale code: the column is derived on every
  // read, never stored on the invoice.
  await api('POST', '/api/lots/dummy-code/bulk', { ids: ls61.map(l => l.id), value: '' });
  check('clearing the tag clears the column', (await row61()).alt_code === '');
  // Two codes under one draft are JOINED rather than one picked arbitrarily,
  // so a trade that does mix them shows that instead of hiding it.
  await api('POST', '/api/lots/' + ls61[0].id + '/dummy-code', { value: 'ERJ' });
  await api('POST', '/api/lots/' + ls61[1].id + '/dummy-code', { value: 'ERP' });
  const mixed = String((await row61()).alt_code || '').split(',').map(x => x.trim()).sort();
  check('a draft whose lots disagree shows both codes', mixed.join(',') === 'ERJ,ERP', mixed);

  // The spreadsheet carries it too — the register and its export read the
  // same builder, so the column cannot be on screen only.
  {
    const r2 = await fetch(B + '/api/exports/pending-sales-register?from=2000-01-01&to=2099-12-31&format=xlsx',
      { headers: { Authorization: 'Bearer ' + T } });
    if (r2.status === 200) {
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(Buffer.from(await r2.arrayBuffer()));
      const flat2 = JSON.stringify(wb2.worksheets[0].getSheetValues());
      check('the xlsx heads the column ALT CODE', /ALT CODE/.test(flat2), flat2.slice(0, 500));
      check('…and prints the codes it resolved', /ERJ/.test(flat2) && /ERP/.test(flat2), flat2.slice(0, 900));
    } else {
      check('the xlsx builds for the alt-code check', false, r2.status);
    }
  }

  // And the PDF, which is the one that can run out of width — this register
  // is landscape and the new column is one more to fit.
  {
    const r2 = await fetch(B + '/api/exports/pending-sales-register?from=2000-01-01&to=2099-12-31&format=pdf',
      { headers: { Authorization: 'Bearer ' + T } });
    const buf = Buffer.from(await r2.arrayBuffer());
    check('the register PDF still renders with the extra column',
          r2.status === 200 && buf.slice(0, 4).toString() === '%PDF' && buf.length > 2000,
          `${r2.status} ${buf.length}b`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-15).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-4000)); cleanup(); process.exit(1); });
