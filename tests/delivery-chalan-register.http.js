// Delivery Challan Register — the challan book, as a report.
//
// Before this, a printed challan left NO trace: the serial counter advanced,
// the PDF went to the printer, and the app could not answer "which challans
// went out last week?". So the register needed a record to read, and the
// record is written when a challan prints
// (POST /api/delivery-chalan/record).
//
// Consequence worth knowing, and asserted here: the register lists challans
// issued from the moment recording began. Challans printed before that are
// not recoverable — there is nothing to recover them from.
//
//   [record]  a printed challan is logged, keyed on its NUMBER
//   [reprint] re-printing the same number updates that row, never duplicates
//   [typed]   a hand-typed number (no serial claimed) is still in the book
//   [sheet]   the register exports, with the challans and a reconciling total
//   [scope]   trade and date-range scoping both work
//   [gate]    with flag_delivery_chalan off the export refuses and says why
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-reg-'));
const PORT = 47481;
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
async function sheet(qs) {
  const r = await fetch(B + `/api/exports/delivery-chalan-register${qs || ''}`,
                        { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!r.ok) {
    let e = null; try { e = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8')); } catch (_) {}
    return { status: r.status, error: e && e.error, rows: [], head: [] };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0];
  // The sheet carries title/meta lines above the header, so find the header by
  // its first column rather than assuming a row number.
  let head = null; const rows = [];
  ws.eachRow((row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (c) => {
      const v = c.value;
      cells.push(v == null ? '' : (typeof v === 'object' && v.result !== undefined ? v.result : v));
    });
    const up = cells.map(v => String(v).trim().toUpperCase());
    if (!head) { if (up.includes('CHALAN NO')) head = up; return; }
    // createExcelBuffer appends a grand-total row; it is not a challan, and
    // counting it as one made every row count out by exactly one.
    if (String(cells[0] || '').trim().toUpperCase() === 'TOTAL') return;
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = cells[i]; });
    rows.push(o);
  });
  return { status: r.status, rows, head: head || [] };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', {
    settings: { flag_delivery_chalan: 'true', chalan_next_no: '195', chalan_prefix: 'RNS-', br1: 'ANAVILASAM' },
  });
  const auc = await api('POST', '/api/auctions', { ano: '81', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  console.log('[record] a printed challan is logged');
  {
    const claim = await api('POST', '/api/delivery-chalan/claim-no', {});
    check('a serial is claimed and prefixed', claim.status === 200 && claim.d.no === 'RNS-195',
      JSON.stringify(claim.d));
    const rec = await api('POST', '/api/delivery-chalan/record', {
      chalanNo: claim.d.no, serial: claim.d.serial, auctionId: aid,
      date: '2026-10-20', time: '10:30', branch: 'ANAVILASAM',
      veh: 'tn66h1234', mode: 'By Lorry', receiver: 'KOCHI WAREHOUSE',
      lots: [{ lot_no: '12' }, { lot_no: '3' }, { lot_no: '7' }],
      bags: 30, qty: 300, value: 600000,
    });
    check('the challan records', rec.status === 200 && rec.d.ok, JSON.stringify(rec.d));
    const s = await sheet();
    check('it appears in the register', s.rows.length === 1, `${s.rows.length} rows`);
    const r0 = s.rows[0];
    check('…under its own number', String(r0['CHALAN NO']) === 'RNS-195', String(r0['CHALAN NO']));
    check('…with the vehicle upper-cased', String(r0.VEHICLE) === 'TN66H1234', String(r0.VEHICLE));
    check('…the receiver', /KOCHI WAREHOUSE/.test(String(r0.RECEIVER)), String(r0.RECEIVER));
    check('…the trade number', String(r0.TNO) === '81', String(r0.TNO));
    check('…and the lots, numerically sorted as the challan prints them',
      String(r0.LOTS) === '3,7,12', String(r0.LOTS));
    check('bags / qty / value carried through',
      Number(r0.BAGS) === 30 && Number(r0.QTY) === 300 && Number(r0.VALUE) === 600000,
      JSON.stringify([r0.BAGS, r0.QTY, r0.VALUE]));
    check('the lot count is derived, not trusted', Number(r0['NO OF LOTS']) === 3,
      String(r0['NO OF LOTS']));
  }

  console.log('[reprint] the same number updates its row');
  {
    const again = await api('POST', '/api/delivery-chalan/record', {
      chalanNo: 'RNS-195', serial: 195, auctionId: aid,
      date: '2026-10-20', time: '11:45', branch: 'ANAVILASAM',
      veh: 'TN66H9999', mode: 'By Lorry', receiver: 'KOCHI WAREHOUSE',
      lots: [{ lot_no: '3' }], bags: 10, qty: 100, value: 200000,
    });
    check('the re-print records', again.status === 200, JSON.stringify(again.d));
    const s = await sheet();
    check('still ONE row for that number — no duplicate serial',
      s.rows.length === 1, `${s.rows.length} rows: ${s.rows.map(r => r['CHALAN NO']).join(', ')}`);
    check('…carrying the corrected lorry', String(s.rows[0].VEHICLE) === 'TN66H9999',
      String(s.rows[0].VEHICLE));
    check('…and the corrected figures', Number(s.rows[0].BAGS) === 10, String(s.rows[0].BAGS));
  }

  console.log('[typed] a hand-typed number is in the book too');
  {
    // No claim at all — the operator typed over the preview (continuing a
    // paper book, or re-issuing a lost challan). It must still be recorded.
    const rec = await api('POST', '/api/delivery-chalan/record', {
      chalanNo: 'RNS-012/OLD', auctionId: aid, date: '2026-10-19', time: '09:00',
      branch: 'ANAVILASAM', veh: 'TN66H4321', mode: 'By Lorry', receiver: 'MADURAI',
      lots: [{ lot_no: '9' }], bags: 5, qty: 50, value: 100000,
    });
    check('it records with no serial', rec.status === 200, JSON.stringify(rec.d));
    const s = await sheet();
    check('two challans in the book now', s.rows.length === 2,
      s.rows.map(r => r['CHALAN NO']).join(', '));
    // Serial order, with the serial-less one last — a numbered book is read
    // for gaps, and a hand-typed challan has no place in that sequence.
    check('the serialled challan sorts first',
      String(s.rows[0]['CHALAN NO']) === 'RNS-195'
      && String(s.rows[1]['CHALAN NO']) === 'RNS-012/OLD',
      s.rows.map(r => r['CHALAN NO']).join(' | '));
    const bad = await api('POST', '/api/delivery-chalan/record', { lots: [] });
    check('a record with no number is refused', bad.status === 400 && /chalanNo/.test(bad.d.error || ''),
      bad.status + ' ' + JSON.stringify(bad.d));
  }

  console.log('[sheet] the register totals reconcile');
  {
    const s = await sheet();
    check('the header is the challan book\'s, not a money register\'s',
      ['CHALAN NO', 'DATE', 'VEHICLE', 'RECEIVER', 'LOTS', 'BAGS', 'QTY'].every(h => s.head.includes(h)),
      s.head.join(' | '));
    // 10 + 5 bags, 100 + 50 qty across the two rows.
    const sum = (k) => s.rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    check('BAGS sum to what the two challans carried', sum('BAGS') === 15, String(sum('BAGS')));
    check('QTY sums likewise', sum('QTY') === 150, String(sum('QTY')));
  }

  console.log('[scope] trade and date-range scoping');
  {
    const byTrade = await sheet(`?auctionId=${aid}`);
    check('scoped to the trade, both challans are in it', byTrade.rows.length === 2,
      String(byTrade.rows.length));
    const other = await api('POST', '/api/auctions', { ano: '82', date: '2026-10-25', state: 'TAMIL NADU' });
    const aid2 = other.d && (other.d.id || (other.d.auction && other.d.auction.id));
    const byOther = await sheet(`?auctionId=${aid2}`);
    check('another trade\'s register is empty', byOther.rows.length === 0, String(byOther.rows.length));
    const inRange = await sheet('?from=2026-10-20&to=2026-10-31');
    check('a date range keeps only the challans dated inside it',
      inRange.rows.length === 1 && String(inRange.rows[0]['CHALAN NO']) === 'RNS-195',
      inRange.rows.map(r => `${r['CHALAN NO']}@${r.DATE}`).join(', '));
    const wide = await sheet('?from=2026-10-01&to=2026-10-31');
    check('a wider range keeps both', wide.rows.length === 2, String(wide.rows.length));
  }

  console.log('[gate] the feature flag gates the export');
  {
    await api('PUT', '/api/company-settings', { settings: { flag_delivery_chalan: 'false' } });
    const off = await sheet();
    check('with the feature off the export refuses', off.status === 403, String(off.status));
    check('…and names the setting to turn on', /Delivery Challan/i.test(off.error || ''),
      String(off.error));
    await api('PUT', '/api/company-settings', { settings: { flag_delivery_chalan: 'true' } });
    const on = await sheet();
    check('turning it back on restores the register', on.status === 200 && on.rows.length === 2,
      `${on.status} / ${on.rows.length}`);
  }

  console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} ok, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
