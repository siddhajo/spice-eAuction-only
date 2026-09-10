// THARAI LIST — grouping by DUMMY CODE instead of BUYER CODE.
//
// The sheet totals bags and kilos per party, INTER on one side and LOCAL on
// the other. Which identifier names those rows is a house habit: the buyer
// code stamped at price entry (the default, and what the sheet has always
// been) or the Price Entry DUMMY CODE, for a desk that prices against its own
// tags. Both bases are always reachable — the `tharai_dummy_code` flag picks
// the install default, ?by=dummy / ?by=code overrides it per download.
//
// The fixture is deliberately built so the two bases DISAGREE about the row
// count and the ordering: two buyer codes share one dummy tag, and one lot
// carries no tag at all. A sheet that silently ignored the basis, or that fell
// back to the buyer code for the untagged lot, would look right under the
// default and wrong here.
//
// The invariant that must hold under BOTH bases: every lot is still counted,
// on its own side, so INTER + LOCAL + WD bags still equals the trade's bags.
// Only the name on each row changes.
//
// Asserted through the RENDERED SPREADSHEET for the same reason the sibling
// tharai-list.http.js is: db.js opens its own handle off SPICE_DATA_DIR and a
// direct in-process call would read an empty database while the server holds
// the real one.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tharai-dummy-'));
const PORT = 47418;
const B = `http://127.0.0.1:${PORT}`;

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

// [lot, buyerCode, dummyCode, bags, qty, sale]
//
// LOCAL: AA and BB both tag their lots D1, so by dummy code they collapse into
//        ONE row of 9 bags where by buyer code they are two rows of 5 and 4.
//        CC tags D2 (3 bags). DD tags nothing → the '—' row.
// INTER: EE tags D3 (7 bags), FF tags D3 as well (2 bags) → one row of 9.
// W:     one withdrawn lot, on neither side but in the reconciliation.
const REF = [
  ['001', 'AA', 'D1', 5, 100.500, 'L'],
  ['002', 'BB', 'D1', 4,  80.250, 'L'],
  ['003', 'CC', 'D2', 3,  60.000, 'L'],
  ['004', 'DD', '',   2,  40.000, 'L'],
  ['005', 'EE', 'D3', 7, 140.000, 'I'],
  ['006', 'FF', 'D3', 2,  35.000, 'I'],
  ['007', 'GG', 'D4', 6, 120.000, 'W'],
];
const TOTAL_BAGS = REF.reduce((s, r) => s + r[3], 0);   // 29

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); }
                             else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

const XLSX = require('xlsx');

// Parse one rendered sheet into { header, inter[], local[], meta } — the same
// shape whichever basis it was built on, so the assertions below read the two
// renderings identically.
async function readSheet(aid, query) {
  const r = await fetch(`${B}/api/exports/tharai_list/${aid}?format=xlsx${query || ''}`,
    { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (r.status !== 200) return { status: r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const hi = grid.findIndex(row => (row || []).some(c => /^INTER (BUYER|DUMMY)$/.test(String(c || '').trim())));
  if (hi < 0) return { status: 200, header: null, grid };
  const header = (grid[hi] || []).map(c => String(c == null ? '' : c).trim());
  const body = [];
  let totalRow = null;
  for (let i = hi + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    if (String(row[0] || '').trim().toUpperCase() === 'TOTAL') { totalRow = row; break; }
    if (row.length) body.push(row);
  }
  const num = v => Number(v) || 0;
  const side = (bi, qi, gi) => body
    .filter(row => String(row[bi] || '').trim() !== '')
    .map(row => ({ code: String(row[bi]).trim(), qty: num(row[qi]), bags: num(row[gi]) }));
  const meta = grid.slice(0, hi).flat()
    .map(c => String(c == null ? '' : c)).find(s => /TOTAL \d+ bags/.test(s)) || '';
  return {
    status: 200, header, meta,
    inter: side(0, 1, 2), local: side(4, 5, 6),
    interBags: num(totalRow && totalRow[2]), localBags: num(totalRow && totalRow[6]),
    wdBags:    num((meta.match(/WD (\d+)/) || [])[1]),
    totalBags: num((meta.match(/TOTAL (\d+) bags/) || [])[1]),
  };
}

const setFlag = on => api('PUT', '/api/company-settings',
  { settings: { tharai_dummy_code: String(on) } });
const codes = rows => rows.map(r => `${r.code}/${r.bags}`).join(' ');

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', srvLog.slice(-1500)); cleanup(); process.exit(1); }

  const auc = await api('POST', '/api/auctions', { ano: '91', date: '2026-09-10', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  for (const [lot_no, code, dummy, bags, qty, sale] of REF) {
    const c = await api('POST', '/api/lots',
      { auction_id: aid, lot_no, name: 'SELLER ' + lot_no, bags, qty, grade: '1', crop: 'CARDAMOM' });
    const id = c.d && (c.d.id || (c.d.lot && c.d.lot.id));
    await api('PUT', `/api/lots/${id}`, { code, sale, bags, qty, price: 100, amount: qty * 100 });
    if (dummy) await api('POST', `/api/lots/${id}/dummy-code`, { value: dummy });
  }

  // ══ [A] the default is unchanged ══════════════════════════════
  console.log('\n[A] a fresh install still groups by BUYER code');
  const seeded = (await api('GET', '/api/company-settings/flat')).d || {};
  check('tharai_dummy_code seeds to false', String(seeded.tharai_dummy_code) === 'false',
        JSON.stringify(seeded.tharai_dummy_code));
  const byCode = await readSheet(aid);
  check('XLSX returns 200', byCode.status === 200, String(byCode.status));
  check('headers say BUYER',
        byCode.header && byCode.header[0] === 'INTER BUYER' && byCode.header[4] === 'LOCAL BUYER',
        JSON.stringify(byCode.header));
  check('LOCAL is four buyer rows AA/BB/CC/DD',
        codes(byCode.local) === 'AA/5 BB/4 CC/3 DD/2', codes(byCode.local));
  check('INTER is two buyer rows EE/FF',
        codes(byCode.inter) === 'EE/7 FF/2', codes(byCode.inter));

  // ══ [B] ?by=dummy — the same lots, keyed on the dummy tag ═════
  console.log('\n[B] ?by=dummy groups the same lots by DUMMY code');
  const byDummy = await readSheet(aid, '&by=dummy');
  check('XLSX returns 200', byDummy.status === 200, String(byDummy.status));
  check('headers say DUMMY',
        byDummy.header && byDummy.header[0] === 'INTER DUMMY' && byDummy.header[4] === 'LOCAL DUMMY',
        JSON.stringify(byDummy.header));
  // AA(5) + BB(4) share tag D1 → one row of 9, which now outranks D2 and '—'.
  check('AA and BB collapse into one D1 row of 9 bags, ahead of D2',
        codes(byDummy.local) === 'D1/9 D2/3 \u2014/2', codes(byDummy.local));
  check('the untagged lot is its own — row, not folded into DD',
        byDummy.local.some(r => r.code === '—' && r.bags === 2)
        && !byDummy.local.some(r => r.code === 'DD'), codes(byDummy.local));
  check('EE and FF collapse into one D3 row of 9 bags',
        codes(byDummy.inter) === 'D3/9', codes(byDummy.inter));

  // ══ [C] the reconciliation holds under both bases ═════════════
  console.log('\n[C] no bags gained or lost by changing the basis');
  for (const [name, d] of [['by code', byCode], ['by dummy', byDummy]]) {
    check(`${name}: INTER 9 + LOCAL 14 + WD 6 = ${TOTAL_BAGS}`,
          d.interBags === 9 && d.localBags === 14 && d.wdBags === 6 && d.totalBags === TOTAL_BAGS,
          `I=${d.interBags} L=${d.localBags} W=${d.wdBags} T=${d.totalBags}`);
  }

  // ══ [D] the flag sets the default, ?by= overrides it ═════════
  console.log('\n[D] the flag picks the default; ?by= overrides it either way');
  await setFlag(true);
  const flagOn = await readSheet(aid);
  check('flag ON → the plain download is by dummy code',
        flagOn.header && flagOn.header[0] === 'INTER DUMMY', JSON.stringify(flagOn.header));
  const forcedCode = await readSheet(aid, '&by=code');
  check('…and ?by=code still gets the buyer-code sheet',
        forcedCode.header && forcedCode.header[0] === 'INTER BUYER'
        && codes(forcedCode.local) === 'AA/5 BB/4 CC/3 DD/2',
        JSON.stringify(forcedCode.header) + ' ' + codes(forcedCode.local));
  await setFlag(false);
  const flagOff = await readSheet(aid, '&by=dummy');
  check('flag OFF + ?by=dummy → still the dummy sheet',
        flagOff.header && flagOff.header[0] === 'INTER DUMMY', JSON.stringify(flagOff.header));

  // ══ [E] the PDF follows the same basis ════════════════════════
  console.log('\n[E] the PDF renders under both bases');
  for (const q of ['', '&by=dummy', '&by=code']) {
    const r = await fetch(`${B}/api/exports/tharai_list/${aid}?format=pdf${q}`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const buf = Buffer.from(await r.arrayBuffer());
    check(`PDF ?format=pdf${q} → 200, non-empty`, r.status === 200 && buf.length > 1000,
          `${r.status} / ${buf.length} bytes`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-1500)); cleanup(); process.exit(1); });
