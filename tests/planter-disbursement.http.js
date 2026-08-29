// PLANTER DISBURSEMENT — the Disbursement Register (XLSX + PDF).
//
// BILL | NAME | LOT | COMMN | SAMP | CGST | SGST | IGST | INCL | REFUND |
// SALE COST | BALANCE, one row per planter lot, closed by a totals strip.
//
//   [who]      planters only, priced lots only — a dealer (GSTIN seller), an
//              unpriced lot and a reserved lot all stay off it
//   [figures]  every money column is READ from the lot, so the register can
//              never disagree with the commission bill it is the record of
//   [samples]  REFUND and SAMP decompose the stored refund exactly:
//              REFUND − SAMP == lots.refund
//   [foots]    SALE COST + REFUND − SAMP − COMMN − INCL − GST == BALANCE,
//              and the totals strip foots the printed column
//   [bill]     the bill number comes from the bills register, and is blank
//              (never invented) when the lot has no bill yet
//   [routes]   both the spreadsheet and the PDF answer
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'planter-disb-'));
const PORT = 47391;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;

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
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
}

// Read the register back as objects keyed by its own header row, so the
// assertions name columns rather than positions.
async function sheet(aid) {
  const r = await raw(`/api/exports/planter_disbursement/${aid}`);
  if (r.status !== 200) return { status: r.status, rows: [], total: null };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0];
  let head = null; const rows = [];
  ws.eachRow((row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (c) => {
      const v = c.value;
      cells.push(v == null ? '' : (typeof v === 'object' && v.result !== undefined ? v.result : v));
    });
    // The brand band spans the sheet, so every cell of those rows repeats one
    // string — the header row is the first with distinct labels.
    if (!head) { if (String(cells[0]).trim().toUpperCase() === 'BILL') head = cells.map(v => String(v).trim()); return; }
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = cells[i]; });
    rows.push(o);
  });
  const total = rows.length ? rows[rows.length - 1] : null;
  return { status: r.status, rows: rows.slice(0, -1), total, head };
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

  // The two sample weights the SAMP / REFUND columns are cut from. Pinned
  // rather than assumed so the expected figures below are exact.
  await api('PUT', '/api/company-settings', { settings: { sb_refund: '2.85', sb_trader_sample: '0.10' } });

  const auc = await api('POST', '/api/auctions', { ano: '77', date: '2026-08-29', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // Five lots covering every case. The money columns are written explicitly:
  // the register READS them, which is the property under test.
  const mk = async (lot_no, name, cr, fields) => {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name, cr, qty: fields.qty, grade: '1', crop: 'CARDAMOM' });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`, fields);
    return id;
  };
  //  010  planter, unregistered  → no GST at all
  await mk('010', 'JISS JOSEPH', '', {
    qty: 10, price: 1000, amount: 10000, com: 128.5, sertax: 0,
    cgst: 0, sgst: 0, igst: 0, refund: 2850, balance: 12722 });
  //  011  planter, CR-tagged     → CGST + SGST, and a non-zero handling charge
  //       so INCL is proved to be `sertax` rather than a hard-coded zero
  await mk('011', 'BINOY MATHEW', 'CR.', {
    qty: 20, price: 2000, amount: 40000, com: 457, sertax: 12.34,
    cgst: 42.24, sgst: 42.24, igst: 0, refund: 5700, balance: 45146 });
  //  012  DEALER (real GSTIN)    → debit-note side, not this register
  await mk('012', 'EMPEROR SPICES', 'GSTIN.33AAHCE4551A1Z8', {
    qty: 30, price: 3000, amount: 90000, com: 1000, sertax: 0,
    cgst: 90, sgst: 90, igst: 0, refund: 8550, balance: 97370 });
  //  013  planter, never priced  → nothing to disburse
  await mk('013', 'UNPRICED PLANTER', '', { qty: 5, price: 0, amount: 0, balance: 0 });
  //  014  planter, RESERVED      → held, kept out of booked totals
  await mk('014', 'RESERVED PLANTER', '', {
    qty: 10, price: 1000, amount: 10000, com: 128.5, refund: 2850, balance: 12722, reserved: 1 });

  console.log('[who] planter lots with a price, and only those');
  let s = await sheet(aid);
  check('the register downloads', s.status === 200, `HTTP ${s.status}`);
  check('it carries the supplied column set',
        (s.head || []).join('|') === 'BILL|NAME|LOT|COMMN|SAMP|CGST|SGST|IGST|INCL|REFUND|SALE COST|BALANCE',
        (s.head || []).join('|'));
  check('two rows: the two priced planter lots',
        s.rows.length === 2 && s.rows.map(r => r.LOT).join(',') === '010,011',
        JSON.stringify(s.rows.map(r => [r.LOT, r.NAME])));
  check('the dealer lot is not on it — dealers get a debit note',
        !s.rows.some(r => String(r.NAME).includes('EMPEROR')), JSON.stringify(s.rows.map(r => r.NAME)));
  check('the unpriced lot is not on it', !s.rows.some(r => r.LOT === '013'), JSON.stringify(s.rows.map(r => r.LOT)));
  check('the reserved lot is not on it', !s.rows.some(r => r.LOT === '014'), JSON.stringify(s.rows.map(r => r.LOT)));

  console.log('\n[figures] read off the lot, not recomputed');
  const byLot = Object.fromEntries(s.rows.map(r => [r.LOT, r]));
  const a = byLot['010'], b = byLot['011'];
  check('COMMN is lots.com', near(a.COMMN, 128.5) && near(b.COMMN, 457), JSON.stringify([a.COMMN, b.COMMN]));
  // The money columns carry ONE decimal, as the reference sheet does and as
  // the Commission Bill CSV already narrows them — so a stored 42.24 prints
  // 42.20. SALE COST keeps its two.
  check('CGST / SGST / IGST are the stored figures, at the sheet\'s 1 decimal',
        near(a.CGST, 0) && near(b.CGST, 42.2) && near(b.SGST, 42.2) && near(b.IGST, 0),
        JSON.stringify([a.CGST, b.CGST, b.SGST, b.IGST]));
  check('INCL is the handling charge (lots.sertax), not a hard zero',
        near(a.INCL, 0) && near(b.INCL, 12.3), JSON.stringify([a.INCL, b.INCL]));
  check('SALE COST is lots.amount', near(a['SALE COST'], 10000) && near(b['SALE COST'], 40000),
        JSON.stringify([a['SALE COST'], b['SALE COST']]));
  check('BALANCE is the payable, in whole rupees',
        Number(a.BALANCE) === 12722 && Number(b.BALANCE) === 45146,
        JSON.stringify([a.BALANCE, b.BALANCE]));

  console.log('\n[samples] the two sample columns decompose the stored refund');
  // sb_refund 2.85 + trader 0.10 = 2.95 kg at the lot's own rate.
  check('REFUND is (sb_refund + trader sample) x price',
        near(a.REFUND, 2950) && near(b.REFUND, 5900), JSON.stringify([a.REFUND, b.REFUND]));
  check('SAMP is the trader sample x price', near(a.SAMP, 100) && near(b.SAMP, 200),
        JSON.stringify([a.SAMP, b.SAMP]));
  check('REFUND − SAMP is exactly what the app credits as refund',
        near(a.REFUND - a.SAMP, 2850) && near(b.REFUND - b.SAMP, 5700),
        JSON.stringify([a.REFUND - a.SAMP, b.REFUND - b.SAMP]));

  console.log('\n[foots] the row reconciles to the payable');
  const recon = (r) => Number(r['SALE COST']) + Number(r.REFUND) - Number(r.SAMP)
                     - Number(r.COMMN) - Number(r.INCL) - Number(r.CGST) - Number(r.SGST) - Number(r.IGST);
  // Whole-rupee rounding of the payable is the only permitted difference.
  check('lot 010 reconciles to its BALANCE', Math.abs(recon(a) - Number(a.BALANCE)) <= 0.5,
        `${recon(a)} vs ${a.BALANCE}`);
  check('lot 011 reconciles to its BALANCE', Math.abs(recon(b) - Number(b.BALANCE)) <= 0.5,
        `${recon(b)} vs ${b.BALANCE}`);
  const t = s.total;
  check('the strip is labelled TOTAL, under NAME', String(t.NAME).trim() === 'TOTAL', JSON.stringify(t));
  for (const col of ['COMMN', 'SAMP', 'CGST', 'SGST', 'IGST', 'INCL', 'REFUND', 'SALE COST', 'BALANCE']) {
    const sum = s.rows.reduce((x, r) => x + (Number(r[col]) || 0), 0);
    check(`${col} foots the printed column`, near(t[col], sum),
          `strip ${t[col]} vs rows ${sum}`);
  }

  console.log('\n[bill] the number comes from the bills register');
  check('blank while the lots carry no bill', String(a.BILL) === '' && String(b.BILL) === '',
        JSON.stringify([a.BILL, b.BILL]));
  const gen = await api('POST', `/api/bills/generate-all/${aid}`, { startBillNo: 2857 });
  check('bills generate', gen.status === 200, `HTTP ${gen.status} ${JSON.stringify(gen.d).slice(0, 200)}`);
  const bills = (await api('GET', `/api/bills?auction_id=${aid}`)).d;
  const billRows = Array.isArray(bills) ? bills : (bills && bills.rows) || [];
  s = await sheet(aid);
  const a2 = s.rows.find(r => r.LOT === '010'), b2 = s.rows.find(r => r.LOT === '011');
  const numFor = (name) => {
    const row = billRows.find(x => String(x.name || '').toUpperCase().includes(name));
    return row ? String(row.bil) : null;
  };
  check('each planter lot now shows its own bill number',
        String(a2.BILL) === numFor('JISS') && String(b2.BILL) === numFor('BINOY'),
        JSON.stringify({ sheet: [a2.BILL, b2.BILL], bills: billRows.map(x => [x.bil, x.name]) }));
  check('no bill was raised for the dealer lot, and it is still off the register',
        !s.rows.some(r => String(r.NAME).includes('EMPEROR')), JSON.stringify(s.rows.map(r => r.NAME)));

  console.log('\n[routes] both renderings answer');
  const xl = await raw(`/api/exports/planter_disbursement/${aid}`);
  check('XLSX by default', xl.status === 200 && xl.buf[0] === 0x50 && xl.buf[1] === 0x4B,
        `HTTP ${xl.status} ${xl.buf.slice(0, 4).toString('hex')}`);
  const pdf = await raw(`/api/exports/planter_disbursement/${aid}?format=pdf`);
  check('PDF renders', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF',
        `HTTP ${pdf.status} ${pdf.buf.slice(0, 8).toString()}`);
  check('…and is more than an empty page', pdf.buf.length > 3000, `${pdf.buf.length} bytes`);
  const csv = await raw(`/api/exports/planter_disbursement/${aid}?format=csv`);
  // The header row sits below the brand band, so look at the whole file
  // rather than its first few hundred bytes.
  check('?format=csv still converts the sheet', csv.status === 200 && /text\/csv/.test(csv.type)
        && /BILL.*NAME.*LOT.*COMMN/.test(csv.buf.toString()), `HTTP ${csv.status} ${csv.type}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); done(1); });
