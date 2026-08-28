// LOT VERIFICATION II — the buyer-code-wise hall sheet.
//
// CODE | LOT | BAG | QTY, one block per buyer code, each block closed by a
// "<CODE> Total" row carrying the block's bag count. Asserted against the
// customer's reference sheet, whose numbers are reproduced verbatim below
// (TSJ 26 bags, AGA 5, MM 19, SMS 5, KC 13).
//
//   [layout]  blocks in first-lot order, lots ascending inside a block,
//             a subtotal closing every block, and a grand total at the foot
//   [codes]   CODE comes from the BUYERS MASTER, not the copy stamped on the
//             lot — a code corrected in the master moves the lot's block
//   [edges]   'WD' gets its own block; a lot with no code trails the sheet
//             under "(NO CODE) Total" instead of vanishing
//   [route]   /api/exports/lot_verification_2/:id serves XLSX by default and
//             still converts to CSV on ?format=csv
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lotverif2-'));
const PORT = 47379;
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
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()),
           type: r.headers.get('content-type') || '' };
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

// The reference sheet, plus two rows it has no case for: a withdrawn lot and
// one that was never allotted.
const REF = [
  ['1', 'TSJ', 6, 292.6], ['19', 'TSJ', 3, 136.5], ['184', 'TSJ', 7, 330.2], ['203', 'TSJ', 10, 447.8],
  ['10', 'AGA', 1, 54.3], ['15', 'AGA', 3, 137.4], ['30', 'AGA', 1, 54],
  ['11', 'MM', 6, 282.5], ['12', 'MM', 6, 273.6], ['13', 'MM', 7, 312.2],
  ['14', 'SMS', 1, 31.3], ['73', 'SMS', 4, 145.4],
  ['16', 'KC', 5, 241.9], ['18', 'KC', 2, 95], ['27', 'KC', 1, 28], ['200', 'KC', 5, 228.4],
];
const EXTRA = [['5', 'WD', 2, 80], ['7', '', 3, 90]];

// Read the sheet back as [[code, lot, bag, qty], …], dropping the brand band
// and the column-header row so the assertions talk about data only.
async function readSheet(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const out = [];
  let seenHeader = false;
  ws.eachRow((r) => {
    const cells = [1, 2, 3, 4].map(c => {
      const v = r.getCell(c).value;
      return v == null ? '' : (typeof v === 'object' && v.result !== undefined ? v.result : v);
    });
    if (!seenHeader) { if (String(cells[0]).toUpperCase() === 'CODE') seenHeader = true; return; }
    if (cells.every(v => v === '')) return;
    out.push(cells);
  });
  return out;
}

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.log('login failed ' + boot.status + '\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }

  const aid = (await api('POST', '/api/auctions', { ano: '77', date: '2026-08-28', crop_type: 'VST' })).d.id;
  for (const [code, name] of [['TSJ', 'TSJ SPICES'], ['AGA', 'AGA TRADERS'], ['MM', 'MM EXPORTS'],
                              ['SMS', 'SMS COMPANY'], ['KC', 'KC SPICES']]) {
    await api('POST', '/api/buyers', { buyer: name, buyer1: name, code, pla: 'BODINAYAKANUR',
                                       state: 'TAMIL NADU', st_code: '33' });
  }
  // Lots are created in a deliberately jumbled order — the sheet's ordering
  // must come from the lot numbers, not from insertion order.
  for (const [lot, code, bags, qty] of [...REF].reverse().concat(EXTRA)) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no: lot, name: 'SELLER ' + lot,
                                               bags, qty, grade: '1', crop: 'CARDAMOM' });
    const id = r.d.lot && r.d.lot.id;
    await api('PUT', `/api/lots/${id}`, { code, buyer: code ? code + ' X' : '', price: 100, amount: qty * 100 });
  }

  console.log('\n[route] the export downloads');
  const xl = await raw(`/api/exports/lot_verification_2/${aid}`);
  check('XLSX by default', xl.status === 200 && xl.buf[0] === 0x50 && xl.buf[1] === 0x4B,
        `HTTP ${xl.status}, bytes ${xl.buf.slice(0, 4).toString('hex')}`);
  const csv = await raw(`/api/exports/lot_verification_2/${aid}?format=csv`);
  check('?format=csv converts', csv.status === 200 && /text\/csv/.test(csv.type)
        && !(csv.buf[0] === 0x50 && csv.buf[1] === 0x4B), `HTTP ${csv.status} ${csv.type}`);

  const rows = await readSheet(xl.buf);
  const s = (v) => String(v == null ? '' : v);

  console.log('\n[layout] blocks, order and subtotals');
  // Blocks in first-lot order: TSJ (lot 1), WD (5), AGA (10), MM (11),
  // SMS (14), KC (16), then the un-allotted lot last whatever its number.
  const totalRows = rows.filter(r => / Total$/.test(s(r[0])));
  check('block order follows each code\'s first lot',
        totalRows.map(r => s(r[0])).join(' | ')
          === 'TSJ Total | WD Total | AGA Total | MM Total | SMS Total | KC Total | (NO CODE) Total',
        totalRows.map(r => s(r[0])).join(' | '));

  const bagOf = (label) => { const r = totalRows.find(t => s(t[0]) === label); return r ? Number(r[2]) : null; };
  for (const [label, bags] of [['TSJ Total', 26], ['AGA Total', 5], ['MM Total', 19],
                               ['SMS Total', 5], ['KC Total', 13]]) {
    check(`${label} = ${bags} bags (reference)`, bagOf(label) === bags, `got ${bagOf(label)}`);
  }
  check('subtotal rows carry no QTY, as on the reference',
        totalRows.every(r => s(r[3]) === ''), JSON.stringify(totalRows));

  // Lots ascending WITHIN a block, numerically — 203 after 19, not before.
  const tsj = rows.filter(r => s(r[0]) === 'TSJ').map(r => s(r[1]));
  check('lots run ascending inside a block', tsj.join(',') === '1,19,184,203', tsj.join(','));

  console.log('\n[edges] non-sale and un-allotted lots');
  check('WD keeps its own block', bagOf('WD Total') === 2, `got ${bagOf('WD Total')}`);
  const noCode = rows.filter(r => s(r[0]) === '' );
  check('the un-allotted lot is listed with a blank CODE',
        noCode.length === 1 && s(noCode[0][1]) === '7', JSON.stringify(noCode));
  check('…and closes the sheet under "(NO CODE) Total"', bagOf('(NO CODE) Total') === 3,
        `got ${bagOf('(NO CODE) Total')}`);

  console.log('\n[total] the foot');
  const foot = rows[rows.length - 1];
  const bagSum = REF.concat(EXTRA).reduce((t, r) => t + r[2], 0);
  const qtySum = Math.round(REF.concat(EXTRA).reduce((t, r) => t + r[3], 0) * 1000) / 1000;
  check('grand total counts every lot, withdrawn and un-allotted included',
        s(foot[0]) === 'TOTAL' && Number(foot[2]) === bagSum && Number(foot[3]) === qtySum,
        JSON.stringify(foot) + ` expected ${bagSum} / ${qtySum}`);

  console.log('\n[codes] the buyers master decides the block');
  // A lot carrying a stale code but the buyer's real trade name belongs in
  // that buyer's block: buyerCodeResolver falls back to a name match against
  // the master, the same rule Lot Verification uses. Without it this lot
  // would open a phantom "OLD" block of its own.
  {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no: '250', name: 'SELLER 250',
                                               bags: 4, qty: 120, grade: '1', crop: 'CARDAMOM' });
    await api('PUT', `/api/lots/${r.d.lot.id}`, { code: 'OLD', buyer: 'KC SPICES', price: 100, amount: 12000 });
    const again = await readSheet((await raw(`/api/exports/lot_verification_2/${aid}`)).buf);
    const labels = again.filter(t => / Total$/.test(s(t[0]))).map(t => s(t[0]));
    const kc = again.find(t => s(t[0]) === 'KC Total');
    check('a name match against the master pulls the lot into that buyer\'s block',
          !labels.includes('OLD Total') && kc && Number(kc[2]) === 17,
          `labels ${labels.join(' | ')} · KC bags ${kc && kc[2]}`);
    check('…and the lot itself is listed under the master\'s code',
          again.some(t => s(t[0]) === 'KC' && s(t[1]) === '250'),
          JSON.stringify(again.filter(t => s(t[1]) === '250')));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
