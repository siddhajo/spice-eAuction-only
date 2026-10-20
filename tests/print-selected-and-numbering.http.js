// Three things the customer reported, and the rules behind them.
//
//  1. SEPARATE PDFs. "Print Selected" returns ONE merged PDF, which is right
//     for a print run and wrong for sending each party their own copy. The
//     new /api/documents/pdf-zip returns the same documents as a .zip of one
//     PDF each, named "<doc no>_<PARTY>.pdf". It asks this server's own bulk
//     route for one id at a time so a party's copy cannot drift from the
//     office copy.
//
//  2. ONE INVOICE PER PAGE in the merged PDF. The report was invoices running
//     continuously down the sheet. This pins the property for EVERY engine —
//     PDFKit and the HTML templates — because the two reach it by different
//     means (doc.addPage() vs .pi-page + .pi-page { page-break-before }), and
//     a regression in either is invisible until somebody prints.
//
//  3. DEBIT-NOTE NUMBERS CONTINUE across trades. They used to restart at 1 for
//     every trade: the series is scoped per trade for COLLISION purposes (and
//     existing data relies on that), but what the operator is OFFERED now runs
//     on from the highest note anywhere.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'printsel-'));
const PORT = 47394;
const B = `http://127.0.0.1:${PORT}`;

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
  if (ct.includes('json')) { let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, d, headers: r.headers }; }
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
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
const pageCount = async (buf) => (await require('pdf-lib').PDFDocument.load(buf)).getPageCount();

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', trade_name: 'RNS SPICES', flag_debit_note: 'true', flag_debit_note_planter: 'true',
    // A service debit note bills the COMMISSION on a dealer's lots — with the
    // rate at 0 there is nothing to raise and every purchase is skipped.
    commission: '1', gst_service: '18', gst_goods: '5',
  }});
  await api('POST', '/api/auctions', { ano: '20', date: '2026-10-17', crop_type: 'ISP' });
  await api('POST', '/api/auctions/1/allocations', { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '050' }] });
  // Three DEALERS (GSTIN + SBL) — a purchase invoice is a dealer document.
  const names = ['ABSAL SPICES', 'ANAKKARA TRADERS', 'ASMI SPICES'];
  for (let i = 0; i < names.length; i++) {
    const t = (await api('POST', '/api/traders', {
      name: names[i], tel: '979074444' + i, ppla: 'CUMBUM',
      cr: 'GSTIN.33ALCPU9807E1Z' + i, aadhar: 'SBL' + i })).d.trader;
    for (let k = 0; k < 2; k++) {
      await api('POST', '/api/lots', { auction_id: 1, lot_no: String(1 + i * 2 + k).padStart(3, '0'),
        // Grade 2 = the dealer class, which is what a service debit note bills
        // commission on (gradedCommission reads lots.grade).
        trader_id: t.id, branch: 'BODI', grade: '2', bags: 10, litre: '300',
        qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
    }
  }
  let all = (await api('GET', '/api/lots/1')).d || [];
  await api('POST', '/api/lots/bulk-price', { items: all.map(l => ({ id: l.id, price: 3152, code: 'B1', buyer: 'B1' })) });
  await api('POST', '/api/lots/calculate/1', {});
  let r = await api('POST', '/api/purchases/generate-all/1', { startInvoiceNo: 1 });
  check('three purchase invoices exist to print', r.status === 200 && r.d.generated === 3, r.d);
  const purchases = (await api('GET', '/api/purchases?auction_id=1')).d || [];
  const ids = purchases.map(p => p.id);

  console.log('[1] One invoice per page in the merged PDF');
  // Every engine, because they reach it differently: PDFKit calls addPage()
  // per document, the HTML templates rely on .pi-page + .pi-page.
  for (const [label, body] of [
    ['default layout',      { ids }],
    ['classic (PDFKit)',    { ids, template: 'classic' }],
    ['modern (HTML)',       { ids, template: 'modern' }],
    ['letterhead (HTML)',   { ids, template: 'letterhead' }],
  ]) {
    const res = await api('POST', '/api/purchases/pdf-bulk', body);
    if (res.status !== 200) { check(`${label} renders`, false, { status: res.status }); continue; }
    const pages = await pageCount(res.buf);
    check(`${label}: 3 invoices → 3 pages, never run together`, pages === 3, { label, pages });
  }

  console.log('\n[2] Separate PDFs — one file per party, named for them');
  r = await api('POST', '/api/documents/pdf-zip', { kind: 'purchases', ids });
  check('the zip builds', r.status === 200 && r.buf && r.buf.length > 1000, { status: r.status });
  const zipPath = path.join(TMP, 'sep.zip');
  fs.writeFileSync(zipPath, r.buf);
  const listing = require('child_process').execSync(`unzip -Z1 "${zipPath}"`).toString().trim().split('\n');
  check('one file per selected document', listing.length === 3, listing);
  // NAME_AUCTIONNO.pdf — the party first (that is what somebody hunting for
  // the file knows) and the TRADE number after it. The document number is
  // deliberately absent: the operator files by party and trade, and the
  // number that matters is the one printed inside.
  check('each is named "NAME_AUCTIONNO.pdf"',
        listing.includes('ABSAL_SPICES_20.pdf') && listing.includes('ANAKKARA_TRADERS_20.pdf')
        && listing.includes('ASMI_SPICES_20.pdf'), listing);
  check('…with no document number in the name', !listing.some(n => /^\d+_/.test(n)), listing);
  const cd = r.headers.get('content-disposition') || '';
  check('the archive names the trade, like every other download', /20/.test(cd) && /\.zip/.test(cd), cd);
  // Each member must be a real, single-invoice PDF — not a copy of the merged one.
  const one = require('child_process').execSync(`unzip -p "${zipPath}" ABSAL_SPICES_20.pdf`, { maxBuffer: 1 << 26 });
  check('a member is a one-invoice PDF', (await pageCount(one)) === 1, { pages: await pageCount(one) });

  console.log('\n[2b] One party, several documents in the same trade');
  // Dropping the document number from the name made this ORDINARY: lot-wise
  // purchase invoices give one dealer a document per lot, and all of them
  // want the same file name. The archive must keep every file.
  await api('PUT', '/api/company-settings', { settings: { flag_lotwise_purchase: 'true' } });
  // Read the id back rather than guessing it — this block sits before the
  // one that adds trade 21, so a hard-coded id silently targets nothing.
  const made = await api('POST', '/api/auctions', { ano: '31', date: '2026-10-24', crop_type: 'ISP' });
  const A2 = made.d && made.d.id;
  check('a second trade exists for the clash test', !!A2, made.d);
  await api('POST', `/api/auctions/${A2}/allocations`, { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  for (const lot of ['001', '002']) {
    await api('POST', '/api/lots', { auction_id: A2, lot_no: lot, trader_id: 1, branch: 'BODI',
      grade: '2', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  }
  const lots2 = (await api('GET', `/api/lots/${A2}`)).d || [];
  await api('POST', '/api/lots/bulk-price', { items: lots2.map(l => ({ id: l.id, price: 3152, code: 'B1', buyer: 'B1' })) });
  await api('POST', `/api/lots/calculate/${A2}`, {});
  r = await api('POST', `/api/purchases/generate-all/${A2}`, { startInvoiceNo: 50 });
  const lw = ((await api('GET', `/api/purchases?auction_id=${A2}`)).d || []);
  check('one dealer has two lot-wise invoices in one trade', lw.length === 2, lw.map(x => x.invo));
  r = await api('POST', '/api/documents/pdf-zip', { kind: 'purchases', ids: lw.map(x => x.id) });
  const zip2 = path.join(TMP, 'sep2.zip');
  fs.writeFileSync(zip2, r.buf);
  const listing2 = require('child_process').execSync(`unzip -Z1 "${zip2}"`).toString().trim().split('\n');
  check('both files survive the name clash', listing2.length === 2, listing2);
  check('…the first keeps the plain name', listing2.includes('ABSAL_SPICES_31.pdf'), listing2);
  check('…and the second is numbered, not overwritten',
        listing2.includes('ABSAL_SPICES_31 (2).pdf'), listing2);
  await api('PUT', '/api/company-settings', { settings: { flag_lotwise_purchase: 'false' } });

  console.log('\n[2c] URD Purchase prints the document that screen issues');
  // The screen shows exactly ONE print button — flag_bos_purchase_bill picks
  // whether it is a Bill of Supply or a Commission Bill — so Separate PDFs
  // has to produce the same one. A zip of the document the site does not
  // issue is a stack of paper the operator cannot use.
  const planter = (await api('POST', '/api/traders', { name: 'RAVI PLANTER', tel: '9790744477', ppla: 'BODIMETTU' })).d.trader;
  await api('POST', '/api/lots', { auction_id: 1, lot_no: '030', trader_id: planter.id, branch: 'BODI',
    grade: '1', bags: 10, litre: '300', qty: 400, sample_wt: 2.95, gross_wt: 402.95 });
  const pl = ((await api('GET', '/api/lots/1')).d || []).filter(l => l.lot_no === '030');
  await api('POST', '/api/lots/bulk-price', { items: pl.map(l => ({ id: l.id, price: 3152, code: 'B1', buyer: 'B1' })) });
  await api('POST', '/api/lots/calculate/1', {});
  r = await api('POST', '/api/bills/generate-all/1', { startBillNo: 1 });
  const billIds = ((await api('GET', '/api/bills?auction_id=1')).d || []).map(b => b.id);
  check('a bill of supply exists for the planter', billIds.length === 1, { billIds, gen: r.d && r.d.error });

  const zipNames = async (kind) => {
    const res = await api('POST', '/api/documents/pdf-zip', { kind, ids: billIds });
    if (res.status !== 200) return { status: res.status, err: res.d };
    const f = path.join(TMP, kind + '.zip');
    fs.writeFileSync(f, res.buf);
    return {
      status: 200,
      names: require('child_process').execSync(`unzip -Z1 "${f}"`).toString().trim().split('\n'),
      archive: (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || '',
      first: require('child_process').execSync(`unzip -p "${f}" "RAVI_PLANTER_20.pdf"`, { maxBuffer: 1 << 26 }),
    };
  };
  const bos = await zipNames('bills');
  check('the bill-of-supply kind zips', bos.status === 200, bos);
  check('…under a readable archive name', /^BillsOfSupply_/.test(bos.archive || ''), bos.archive);
  const com = await zipNames('bills_commission');
  check('the commission kind zips', com.status === 200, com);
  check('…named for the commission bill', /^CommissionBills_/.test(com.archive || ''), com.archive);
  check('both name their files the same way — by party and trade',
        (bos.names || []).includes('RAVI_PLANTER_20.pdf') && (com.names || []).includes('RAVI_PLANTER_20.pdf'),
        { bos: bos.names, com: com.names });
  // The documents themselves must actually differ — same rows, two formats.
  check('and they are genuinely different documents, not the same PDF twice',
        bos.first && com.first && Buffer.compare(bos.first, com.first) !== 0,
        { bos: bos.first && bos.first.length, com: com.first && com.first.length });

  console.log('\n[3] The rails on separate PDFs');
  r = await api('POST', '/api/documents/pdf-zip', { kind: 'nonsense', ids });
  check('an unknown document kind is refused', r.status === 400, r.d);
  r = await api('POST', '/api/documents/pdf-zip', { kind: 'purchases', ids: [] });
  check('an empty selection is refused', r.status === 400, r.d);
  r = await api('POST', '/api/documents/pdf-zip', { kind: 'purchases', ids: Array.from({ length: 301 }, (_, i) => i + 1) });
  check('an oversized run is refused with a number, not a timeout',
        r.status === 400 && /301/.test((r.d && r.d.error) || ''), r.d);

  console.log('\n[4] Debit-note numbers continue across trades');
  r = await api('GET', '/api/debit-notes/next-note-no?ano=20');
  check('an empty series still starts at 1', r.d && r.d.next === 1, r.d);
  r = await api('POST', '/api/debit-notes/generate-bulk', { ano: '20', startNoteNo: 41 });
  check('three debit notes are raised in trade 20', r.status === 200 && (r.d.generated || []).length === 3, { status: r.status, d: r.d });
  r = await api('GET', '/api/debit-notes/next-note-no?ano=20');
  check('the same trade continues from its own last note', r.d && r.d.next === 44, r.d);
  // The point of the change: a NEW trade must not restart at 1.
  await api('POST', '/api/auctions', { ano: '21', date: '2026-10-24', crop_type: 'ISP' });
  r = await api('GET', '/api/debit-notes/next-note-no?ano=21');
  check('a NEW trade carries on from 44, instead of restarting at 1', r.d && r.d.next === 44, r.d);
  r = await api('GET', '/api/debit-notes-planter/next-note-no?ano=21');
  check('the planter series behaves the same way', r.d && r.d.next === 1, r.d);   // none raised yet anywhere

  // The Generate All review sheet must agree with the tab — the complaint was
  // that it showed 1 while the series was already past 40.
  r = await api('GET', '/api/auctions/2/transaction-plan');
  const steps = (r.d && r.d.steps) || [];
  const dnStep = steps.find(s => s.id === 'debit_notes');
  check('Generate All offers the running number too, not 1',
        dnStep && dnStep.suggestedStart === 44, dnStep && { suggestedStart: dnStep.suggestedStart });

  console.log('\n[5] Numbers stay unique where it matters');
  // The SCOPE is unchanged — still per-trade — so this needs a real collision
  // inside trade 20: another dealer to raise a note for, asked to start at a
  // number that trade already holds.
  const t4 = (await api('POST', '/api/traders', {
    name: 'BODI ESTATE', tel: '9790744499', ppla: 'CUMBUM',
    cr: 'GSTIN.33ALCPU9807E1Z9', aadhar: 'SBL9' })).d.trader;
  await api('POST', '/api/lots', { auction_id: 1, lot_no: '020', trader_id: t4.id, branch: 'BODI',
    grade: '2', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
  const fresh = ((await api('GET', '/api/lots/1')).d || []).filter(l => l.lot_no === '020');
  await api('POST', '/api/lots/bulk-price', { items: fresh.map(l => ({ id: l.id, price: 3152, code: 'B1', buyer: 'B1' })) });
  await api('POST', '/api/lots/calculate/1', {});
  await api('POST', '/api/purchases/generate-all/1', { startInvoiceNo: 10 });
  r = await api('POST', '/api/debit-notes/generate-bulk', { ano: '20', startNoteNo: 41 });
  const err = (r.d && r.d.error) || '';
  check('a start that collides inside the trade is still refused', r.status === 409, { status: r.status, err });
  // The advice must be the number the START field itself offers. Advising
  // this trade's own next (44 happens to be both here) rather than a number
  // the form would never suggest is the point.
  check('…and the advice is the running number', /44/.test(err), err);
  r = await api('POST', '/api/debit-notes/generate-bulk', { ano: '20', startNoteNo: 44 });
  check('…and taking that advice works', r.status === 200 && (r.d.generated || []).length === 1, r.d);
  r = await api('GET', '/api/debit-notes/next-note-no?ano=21');
  check('the running number moves on for the next trade', r.d && r.d.next === 45, r.d);

  console.log('\n[6] Debit notes name their separate PDFs NAME_SB_AUCTIONNO.pdf');
  // Every document kind otherwise lands in the operator's Downloads folder
  // under the same party-and-trade name, so a debit note was indistinguishable
  // from that party's purchase invoice for the same trade. 'SB' (Spices
  // Board — the abbreviation the SB Sample Refund setting already uses) is
  // the constant that tells them apart. Runs after [4], which is what raised
  // the notes.
  const dnIds = ((await api('GET', '/api/debit-notes?ano=20')).d || []).map(x => x.id);
  check('trade 20 has debit notes to zip', dnIds.length >= 3, dnIds);
  r = await api('POST', '/api/documents/pdf-zip', { kind: 'debit_notes', ids: dnIds.slice(0, 3) });
  check('the debit-note kind zips', r.status === 200, { status: r.status, d: r.d });
  const dnZip = path.join(TMP, 'dn.zip');
  fs.writeFileSync(dnZip, r.buf);
  const dnNames = require('child_process').execSync(`unzip -Z1 "${dnZip}"`).toString().trim().split('\n');
  check('every file carries the SB tag between party and trade',
        dnNames.length === 3 && dnNames.every(n => /^.+_SB_20\.pdf$/.test(n)), dnNames);
  // The tag sits BETWEEN the two, not appended — a name ending "_20_SB.pdf"
  // would sort and scan differently in the folder.
  check('…and the trade number is still last', dnNames.every(n => /_20\.pdf$/.test(n)), dnNames);

  // Planter debit notes are the same document family and take the same tag.
  await api('POST', '/api/debit-notes-planter/generate-bulk', { ano: '20', startNoteNo: 1 });
  const dnpIds = ((await api('GET', '/api/debit-notes-planter?ano=20')).d || []).map(x => x.id);
  if (dnpIds.length) {
    r = await api('POST', '/api/documents/pdf-zip', { kind: 'debit_notes_planter', ids: dnpIds.slice(0, 2) });
    check('the planter debit-note kind zips', r.status === 200, { status: r.status, d: r.d });
    const dnpZip = path.join(TMP, 'dnp.zip');
    fs.writeFileSync(dnpZip, r.buf);
    const dnpNames = require('child_process').execSync(`unzip -Z1 "${dnpZip}"`).toString().trim().split('\n');
    check('planter debit notes carry the SB tag too',
          dnpNames.every(n => /^.+_SB_20\.pdf$/.test(n)), dnpNames);
  } else {
    check('planter debit notes exist to check', false, 'none raised for trade 20');
  }

  // The tag belongs to debit notes ALONE — adding it everywhere would defeat
  // the point of having it.
  r = await api('POST', '/api/documents/pdf-zip', { kind: 'purchases', ids });
  const pZip = path.join(TMP, 'pur-notag.zip');
  fs.writeFileSync(pZip, r.buf);
  const pNames = require('child_process').execSync(`unzip -Z1 "${pZip}"`).toString().trim().split('\n');
  check('purchase invoices are NOT tagged', pNames.every(n => !/_SB_/.test(n)), pNames);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-25).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
