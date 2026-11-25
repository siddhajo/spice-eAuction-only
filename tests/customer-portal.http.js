// CUSTOMER PORTAL (/my) — a seller or buyer signing in with their phone and
// downloading their OWN documents.
//
// The feature's whole value is a negative: the customer must see their own
// paperwork and NOTHING ELSE. So most of what follows asserts absence —
// another party's document is refused, a proforma draft is invisible, a
// stopped invoice is withheld, an unknown number learns nothing. A portal
// that merely LISTS correctly is not proof of anything; every check here
// that matters goes at the document fetch, because that is the request that
// actually hands bytes to a stranger.
//
// One phone may hold SEVERAL parties — a deliberate business decision
// (2026-11-13): households and planter groups share a handset. [D] pins that
// behaviour down, including the part that makes it survivable: a revoke
// takes effect on the next request, not at next sign-in.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
const PORT = 47412;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '\n         ' + JSON.stringify(d) : '')); }
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
  const r = await fetch(B + u, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};
// The portal speaks with its own token, never the operator's.
const portal = async (m, u, b, tok) => {
  const r = await fetch(B + u, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};
const raw = async (u) => {
  const r = await fetch(B + u);
  const buf = Buffer.from(await r.arrayBuffer());
  return { s: r.status, type: r.headers.get('content-type') || '',
           cd: r.headers.get('content-disposition') || '', buf };
};

// The log channel is the only one that exists until an SMS or WhatsApp
// channel is connected, so the test reads the code the way an admin would.
const codeFor = (pkey) => {
  const hits = srvLog.match(new RegExp(`OTP for ${pkey}: (\\d{6})`, 'g')) || [];
  const last = hits[hits.length - 1];
  return last ? last.slice(-6) : '';
};
const signIn = async (phone) => {
  await portal('POST', '/api/portal/otp/request', { phone });
  await new Promise(r => setTimeout(r, 120));   // let the log line land
  const v = await portal('POST', '/api/portal/otp/verify', { phone, code: codeFor(phone) });
  return v;
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;

  // ── Fixture ────────────────────────────────────────────────────────────
  // Two sellers on ONE handset (the shared-phone case), a third seller on
  // their own, and a buyer. Everything is created through the app's real
  // endpoints so the documents are the ones the office would have raised.
  await api('PUT', '/api/company-settings', { settings: { gunny_rate: '150', br1: 'BODI' } });
  const A = (await api('POST', '/api/auctions', { ano: '30', date: '2026-11-10', crop_type: 'ISP' })).d.id;
  await api('POST', `/api/auctions/${A}/allocations`,
    { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '050' }] });

  const SHARED = '9790700001';   // two sellers answer on this one
  const SOLO   = '9790700002';   // one seller
  const BUYERP = '9790700003';   // the buyer
  // [F2] needs a number with its throttle budget untouched: the per-phone
  // limit is three requests a quarter hour, and [B]/[F] spend the others.
  const WAP    = '9790700004';
  // Holds no document and never will: the only way left to observe the
  // un-enrolled case now that raising a bill enrols a seller on its own.
  const NODOC  = '9790700009';

  const mk = (name, tel) => api('POST', '/api/traders',
    { name, tel, ppla: 'BODIMETTU', pstate: 'TAMIL NADU' }).then(r => r.d.trader);
  const sA = await mk('FATHER PLANTER', SHARED);
  const sB = await mk('SON PLANTER', SHARED);
  const sC = await mk('OTHER PLANTER', SOLO);
  const sD = await mk('WA PLANTER', WAP);
  await mk('NO DOCS PLANTER', NODOC);        // deliberately gets no lots
  await api('POST', '/api/buyers',
    { buyer: 'BUY1', code: 'BUY1', buyer1: 'BUYER ONE', sale: 'L', tel: BUYERP });

  let lotNo = 1;
  const addLot = async (seller) => {
    const no = String(lotNo++).padStart(3, '0');
    await api('POST', '/api/lots', { auction_id: A, lot_no: no, trader_id: seller.id, branch: 'BODI',
      grade: '1', bags: 10, litre: '300', qty: 500, sample_wt: 2.95, gross_wt: 502.95 });
    return no;
  };
  for (const s of [sA, sB, sC, sD]) { await addLot(s); await addLot(s); }

  let lots = (await api('GET', `/api/lots/${A}`)).d || [];
  await api('POST', '/api/lots/bulk-set-buyer',
    { ids: lots.map(l => l.id), code: 'BUY1', buyer: 'BUY1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3000 })) });
  await api('POST', `/api/lots/calculate/${A}`, {});
  await api('POST', `/api/invoices/generate-all/${A}`, { startInvoiceNo: 1 });
  await api('POST', `/api/bills/generate-all/${A}`, { startBillNo: 1 });
  // Planter debit notes too — [C] asserts a seller is NOT shown them, and an
  // exclusion proves nothing unless the thing being excluded exists.
  await api('PUT', '/api/company-settings', { settings: { flag_debit_note_planter: 'true' } });
  await api('POST', '/api/debit-notes-planter/generate-bulk', { ano: '30', startNo: 1 });
  check('fixture: eight priced lots across four sellers', (await api('GET', `/api/lots/${A}`)).d.length === 8);

  const bills = (await api('GET', `/api/bills?auction_id=${A}`)).d;
  const billRows = Array.isArray(bills) ? bills : (bills.rows || []);
  check('fixture: a bill of supply per seller', billRows.length === 4, billRows.length);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[A] The door is shut until the flag opens it');
  let r = await portal('GET', '/api/portal/config');
  check('portal config 404s while the flag is off', r.s === 404, r.s);
  check('/my 404s too', (await raw('/my')).s === 404);
  r = await api('GET', '/api/portal/admin/links');
  check('…but an admin can still prepare enrolments', r.s === 200, r.s);

  await api('PUT', '/api/company-settings', { settings: { flag_customer_portal: 'true' } });
  check('flag on → the portal answers', (await portal('GET', '/api/portal/config')).s === 200);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[B] Nothing is visible until a link grants it');
  r = await portal('POST', '/api/portal/otp/request', { phone: NODOC });
  check('an un-enrolled number is accepted without complaint', r.s === 200, r.d);
  check('…and no code is issued for it', codeFor(NODOC) === '', codeFor(NODOC));

  // The fixture already raised bills and invoices, and raising a document
  // enrols its party (see [B2]) — so by now the seed has nothing left to do.
  // Its remaining job is BACKFILL: parties whose documents predate the
  // feature. That is what the revoke-then-reseed below actually tests.
  r = await api('POST', '/api/portal/admin/seed', {});
  check('seed dry run writes nothing', r.s === 200 && r.d.written === 0, r.d);
  check('…and sees every party holding a document',
        r.d.sellers === 4 && r.d.buyers === 1, r.d);
  check('…counting the shared handset', r.d.sharedPhones === 1 && r.d.partiesOnSharedPhones === 2, r.d);
  r = await api('POST', '/api/portal/admin/seed', { commit: true });
  check('…and committing is a no-op once auto-enrolment has run',
        r.s === 200 && r.d.written === 0, r.d);

  // Backfill: revoke one party, re-seed, and it comes back.
  const someLink = (await api('GET', '/api/portal/admin/links')).d.rows
    .find(x => x.party_kind === 'seller');
  await api('POST', `/api/portal/admin/links/${someLink.id}/revoke`);
  r = await api('POST', '/api/portal/admin/seed', { commit: true });
  check('seed backfills a party that has no link', r.s === 200 && r.d.written === 1, r.d);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[B2] A party enrolled later is picked up on its own');
  // The seed is a snapshot. Without auto-enrolment every planter onboarded
  // afterwards silently cannot sign in — same cheerful "code sent", nothing
  // arrives, nothing anywhere says why.
  const LATE = '9790700007';
  const sLate = await mk('LATE PLANTER', LATE);
  r = await api('GET', '/api/portal/admin/links');
  check('a brand-new seller is not enrolled by merely existing',
        !r.d.rows.some(x => x.party_id === sLate.id && x.party_kind === 'seller'),
        r.d.rows.filter(x => x.party_id === sLate.id));

  const lateLot = await addLot(sLate);
  let lateLots = (await api('GET', `/api/lots/${A}`)).d.filter(l => String(l.lot_no) === lateLot);
  await api('POST', '/api/lots/bulk-set-buyer',
    { ids: lateLots.map(l => l.id), code: 'BUY1', buyer: 'BUY1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: lateLots.map(l => ({ id: l.id, price: 3000 })) });
  await api('POST', `/api/lots/calculate/${A}`, {});
  await api('POST', `/api/bills/generate-all/${A}`, { startBillNo: 90 });

  r = await api('GET', '/api/portal/admin/links');
  const lateLink = r.d.rows.find(x => x.party_kind === 'seller' && x.party_id === sLate.id);
  check('…but raising their first bill enrols them', !!lateLink, r.d.total);
  check('…recorded as automatic, not as a hand-made grant',
        lateLink && lateLink.source === 'auto', lateLink && lateLink.source);

  const vLate = await signIn(LATE);
  const lastLateCode = codeFor(LATE);
  check('…and they can sign in straight away', vLate.s === 200 && !!vLate.d.token, vLate.d);
  r = await portal('GET', `/api/portal/documents?party=seller:${sLate.id}`, null, vLate.d.token);
  check('…to exactly their own bill', r.s === 200 && r.d.documents.length === 1, r.d.documents);

  // The rule that keeps auto-enrolment from being destructive.
  const CORRECTED = '9790700008';
  await api('POST', '/api/portal/admin/links/' + lateLink.id + '/revoke');
  await api('POST', '/api/portal/admin/links',
    { party_kind: 'seller', party_id: sLate.id, phone: CORRECTED });
  await api('POST', `/api/bills/generate-all/${A}`, { startBillNo: 95 });
  r = await api('GET', '/api/portal/admin/links');
  const nowLinks = r.d.rows.filter(x => x.party_kind === 'seller' && x.party_id === sLate.id);
  // ── A link this code OWNS follows the master ──
  // These two rules pull in opposite directions and both matter: a grant an
  // admin made by hand is sacred, a grant auto-enrolment made is only ever
  // a copy of the master and must track it. Live data had two sellers whose
  // number was corrected on the master after enrolment: they could not sign
  // in, and whoever held the OLD number still could.
  const MOVED = '9790700011';
  const sMoved = await mk('MOVED PLANTER', '9790700010');
  const movedLot = await addLot(sMoved);
  let ml = (await api('GET', `/api/lots/${A}`)).d.filter(l => String(l.lot_no) === movedLot);
  await api('POST', '/api/lots/bulk-set-buyer',
    { ids: ml.map(l => l.id), code: 'BUY1', buyer: 'BUY1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: ml.map(l => ({ id: l.id, price: 3000 })) });
  await api('POST', `/api/lots/calculate/${A}`, {});
  await api('POST', `/api/bills/generate-all/${A}`, { startBillNo: 120 });
  let mlink = (await api('GET', '/api/portal/admin/links')).d.rows
    .find(x => x.party_kind === 'seller' && x.party_id === sMoved.id);
  check('auto-enrolled on the number the master held', mlink && mlink.phone_key === '9790700010', mlink);

  // The office corrects the number on the master. Both repair paths run
  // the SAME autoEnrol, so the seed is the one exercised here — it is also
  // the realistic fix for links already stale in a live database. (A bill
  // cannot be the trigger in this fixture: bills are seller-wise, so the
  // seller already has one and generate-all raises no second.)
  const upd = await api('PUT', `/api/traders/${sMoved.id}`, { name: 'MOVED PLANTER', tel: MOVED });
  check('fixture: the master number was changed', upd.s === 200, upd.d);
  // AT THE EDIT, not at the next bill. Waiting for the next document left
  // the previous holder reading this seller's paperwork until the next
  // trade — usually the exact reason the number was being corrected.
  const atEdit = (await api('GET', '/api/portal/admin/links')).d.rows
    .filter(x => x.party_kind === 'seller' && x.party_id === sMoved.id);
  check('the grant moves the moment the master is corrected',
        atEdit.length === 1 && atEdit[0].phone_key === MOVED, atEdit.map(x => x.phone_key));
  // …and the seed is then a no-op, because the edit already fixed it.
  r = await api('POST', '/api/portal/admin/seed', { commit: true });
  check('a re-seed then has nothing left to repair', r.s === 200 && r.d.written === 0, r.d);

  // Editing a phone must never CREATE access: enrolment waits for a document.
  const sIdle = await mk('NEVER TRADED', '9790700012');
  await api('PUT', `/api/traders/${sIdle.id}`, { name: 'NEVER TRADED', tel: '9790700013' });
  check('…but editing a phone never enrols someone who holds no document',
        !(await api('GET', '/api/portal/admin/links')).d.rows
          .some(x => x.party_kind === 'seller' && x.party_id === sIdle.id));

  const after2 = (await api('GET', '/api/portal/admin/links')).d.rows
    .filter(x => x.party_kind === 'seller' && x.party_id === sMoved.id);
  check('…and the grant FOLLOWS a corrected master number',
        after2.length === 1 && after2[0].phone_key === MOVED, after2.map(x => x.phone_key));
  check('…so the old number is locked out',
        (await signIn('9790700010')).s !== 200, 'old number still signs in');

  check("a corrected number is NOT undone by the next bill",
        nowLinks.length === 1 && nowLinks[0].phone_key === CORRECTED,
        nowLinks.map(x => x.phone_key));
  check('…so the stale master number stays locked out',
        (await portal('POST', '/api/portal/otp/request', { phone: LATE })).s === 200
        && codeFor(LATE) === lastLateCode, 'a new code was issued to the old number');

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[C] A seller signs in and sees their own documents');
  const vC = await signIn(SOLO);
  check('sign-in succeeds', vC.s === 200 && !!vC.d.token, vC.d);
  check('…resolving to exactly one party', vC.d.parties.length === 1, vC.d.parties);
  const tokC = vC.d.token, idC = vC.d.parties[0].id;

  r = await portal('GET', `/api/portal/documents?party=seller:${idC}`, null, tokC);
  check('their commission bill is listed', r.s === 200 && r.d.documents.some(d => d.kind === 'bill'), r.d);
  const myBill = r.d.documents.find(d => d.kind === 'bill');
  check('…labelled as a Commission Bill, not a Bill of Supply',
        myBill && myBill.label === 'Commission Bill', myBill && myBill.label);

  // ── The row says what the document says ──
  // The list used to show bills.net (the gross bill-of-supply value) while
  // the document it opens prints the NETT after commission and GST. A row
  // whose figure is absent from the PDF behind it is a phone call.
  const billRow = billRows.find(x => x.id === myBill.id);
  const dnFor = (await api('GET', '/api/debit-notes-planter?ano=30')).d;
  const dnRows2 = Array.isArray(dnFor) ? dnFor : (dnFor && dnFor.rows) || [];
  const myDn = dnRows2.find(x => x.trader_id === idC);
  check('fixture: this bill really does carry a commission',
        !!myDn && Number(myDn.total) > 0, myDn && myDn.total);
  check('the row shows the NETT, not the gross bill value',
        Number(myBill.amount) < Number(billRow.net),
        { row: myBill.amount, grossNet: billRow.net });
  check('…short by the commission, to the rupee',
        Math.abs((Number(billRow.net) - Number(myBill.amount)) - Number(myDn.total)) <= 1,
        { gross: billRow.net, row: myBill.amount, commission: myDn.total });
  const snap = (await portal('GET', `/api/portal/documents?party=seller:${idC}`, null, tokC)).d;
  const yearTotal = snap.totals['2026-27'];
  check('…and the year headline adds up those same rows',
        yearTotal && Math.abs(yearTotal.amount
          - snap.documents.filter(d => d.date >= '2026-04-01')
              .reduce((a, d) => a + d.amount, 0)) < 0.01,
        yearTotal);

  // ── Lot numbers on the row ──
  // A grower checks a bill against the lots they brought, so the row names
  // them. Each document kind keeps them somewhere different, which is the
  // thing most likely to rot: bills and invoices in line_items, purchases
  // nowhere at all (seller-wise, lot_no blank) so they come from `lots`.
  check('a commission bill names its lot', Array.isArray(myBill.lots) && myBill.lots.length >= 1,
        myBill && myBill.lots);
  const billLots = (await api('GET', `/api/bills?auction_id=${A}`)).d;
  const billRow2 = (Array.isArray(billLots) ? billLots : billLots.rows || []).find(x => x.id === myBill.id);
  check('…the same lot the bill was raised for',
        !billRow2 || !String(billRow2.lot_no || '').trim()
          || myBill.lots.includes(String(billRow2.lot_no).trim()),
        { row: myBill.lots, billLotNo: billRow2 && billRow2.lot_no });

  const pdf = await raw(`/api/portal/documents/bill/${myBill.id}/pdf?token=${tokC}`);
  check('…and downloads as a real PDF', pdf.s === 200 && pdf.buf.slice(0, 4).toString() === '%PDF',
        { s: pdf.s, head: pdf.buf.slice(0, 8).toString() });

  // Two actions on the row: view in a tab, or save. Same bytes, different
  // Content-Disposition — a phone will not offer "save" on an inline PDF.
  const inlineHdr = await fetch(B + `/api/portal/documents/bill/${myBill.id}/pdf?token=${tokC}`);
  const saveHdr   = await fetch(B + `/api/portal/documents/bill/${myBill.id}/pdf?token=${tokC}&dl=1`);
  check('viewing serves it inline',
        /^inline;/.test(inlineHdr.headers.get('content-disposition') || ''),
        inlineHdr.headers.get('content-disposition'));
  check('…and ?dl=1 serves it as a download',
        /^attachment;/.test(saveHdr.headers.get('content-disposition') || ''),
        saveHdr.headers.get('content-disposition'));

  // The office's own copy of the same document. Identical bytes but for the
  // trailer /ID, which both engines regenerate per render — so compare the
  // body, which is what the customer and the auditor actually read.
  // Through the COMMISSION BILL route, because that is the layout a planter
  // is served — the per-lot memorandum that shows cardamom cost, sample
  // refund, commission, GST and NETT, not the bare Bill of Supply.
  const office = await fetch(B + '/api/bills/commission-bos-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
    body: JSON.stringify({ ids: [myBill.id] }),
  });
  const officeBuf = Buffer.from(await office.arrayBuffer());
  check('…byte-identical to the office copy, bar the per-render id',
        officeBuf.length === pdf.buf.length
        && officeBuf.slice(0, officeBuf.length - 120).equals(pdf.buf.slice(0, pdf.buf.length - 120)),
        { office: officeBuf.length, portal: pdf.buf.length });

  // ── The checks the feature exists to pass ──
  const theirs = billRows.find(b => b.trader_id !== idC);
  r = await portal('GET', `/api/portal/documents/bill/${theirs.id}/pdf`, null, tokC);
  check("another seller's bill is refused", r.s === 403, { s: r.s, d: r.d });
  r = await portal('GET', `/api/portal/documents?party=seller:${theirs.trader_id}`, null, tokC);
  check("…and so is listing a party they do not hold", r.s === 403, r.s);
  // A seller is shown the commission bill and nothing else. Their debit note
  // is the GST note for the commission the bill already shows as a deduction,
  // and two documents for one deduction reads as being charged twice.
  const dnAll = (await api('GET', `/api/debit-notes-planter?ano=30`)).d;
  const dnList = Array.isArray(dnAll) ? dnAll : (dnAll && dnAll.rows) || [];
  check('fixture: planter debit notes exist', dnList.length > 0, dnList.length);
  r = await portal('GET', `/api/portal/documents?party=seller:${idC}`, null, tokC);
  check('…but none is listed for the seller',
        !r.d.documents.some(d => d.kind === 'dn-planter'), r.d.documents.map(d => d.kind));
  const mine = dnList.find(x => x.trader_id === idC) || dnList[0];
  r = await portal('GET', `/api/portal/documents/dn-planter/${mine.id}/pdf`, null, tokC);
  check('…and the URL is a dead end even for their own note', r.s === 404, { s: r.s, d: r.d });

  check('no token at all is refused', (await raw(`/api/portal/documents/bill/${myBill.id}/pdf`)).s === 401);
  check('a made-up token is refused',
        (await raw(`/api/portal/documents/bill/${myBill.id}/pdf?token=deadbeef`)).s === 401);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[C2] A whole period as ONE file');
  // The period is resolved SERVER-side from fy/month, so the bundle is by
  // construction the same set the list showed and there is no id list to
  // tamper with. These checks are mostly about that boundary.
  const fy = '2026-27';
  let bulk = await raw(`/api/portal/documents/bulk?party=seller:${idC}&fy=${fy}&token=${tokC}`);
  check('the year downloads as one PDF',
        bulk.s === 200 && bulk.buf.slice(0, 4).toString() === '%PDF', { s: bulk.s });
  const { PDFDocument } = require('pdf-lib');
  const yearPages = (await PDFDocument.load(bulk.buf)).getPageCount();
  check('…covering every document in the year', yearPages >= 2, yearPages);

  bulk = await raw(`/api/portal/documents/bulk?party=seller:${idC}&fy=${fy}&month=2026-11&token=${tokC}`);
  const monthPages = bulk.s === 200 ? (await PDFDocument.load(bulk.buf)).getPageCount() : 0;
  check('a single month is a strict subset of the year',
        bulk.s === 200 && monthPages > 0 && monthPages <= yearPages, { monthPages, yearPages });

  r = await portal('GET', `/api/portal/documents/bulk?party=seller:${idC}&fy=2019-20`, null, tokC);
  check('an empty period says so rather than sending an empty file', r.s === 404, { s: r.s, d: r.d });

  r = await portal('GET', `/api/portal/documents/bulk?party=seller:${theirs.trader_id}&fy=${fy}`, null, tokC);
  check("…and another party's bundle is refused", r.s === 403, r.s);
  check('a bundle with no token is refused',
        (await raw(`/api/portal/documents/bulk?party=seller:${idC}&fy=${fy}`)).s === 401);

  // ── A hand-picked selection ──
  // The page offers checkboxes, so the bundle route also takes ?ids=. Unlike
  // the period form it CANNOT derive the set itself, so every id is checked
  // against the party's own documents — this is the one place in the portal
  // where the browser names the rows.
  const all = (await portal('GET', `/api/portal/documents?party=seller:${idC}`, null, tokC)).d.documents;
  const twoIds = all.slice(0, 2).map(d => d.id);
  bulk = await raw(`/api/portal/documents/bulk?party=seller:${idC}&ids=${twoIds.join(',')}&token=${tokC}`);
  const pickPages = bulk.s === 200 ? (await PDFDocument.load(bulk.buf)).getPageCount() : 0;
  // This seller holds one bill in the fixture, so a "selection" of it is the
  // whole year — the subset relation is <=, and asserting < would only be
  // testing the fixture. What matters here is that ?ids= renders at all and
  // never reaches past the year.
  check('a hand-picked selection downloads as one PDF',
        bulk.s === 200 && pickPages > 0 && pickPages <= yearPages, { pickPages, yearPages });
  check('…and the selection is exactly the documents asked for',
        bulk.s === 200
        && /attachment;/.test(bulk.cd || '')
        && new RegExp(`_${twoIds.length}_documents\\.pdf`).test(bulk.cd || ''),
        bulk.cd);

  r = await portal('GET',
    `/api/portal/documents/bulk?party=seller:${idC}&ids=${twoIds.join(',')},${theirs.id}`, null, tokC);
  check("…and one foreign id in the list poisons the whole request", r.s === 403, { s: r.s, d: r.d });
  r = await portal('GET', `/api/portal/documents/bulk?party=seller:${idC}&ids=0`, null, tokC);
  check('…as does an id that exists nowhere', r.s === 403, r.s);

  // Every document in a bundle is audited individually, not as one "bulk" row
  // — the audit question is always "who got THAT bill".
  const audit = (await api('GET', '/api/portal/admin/downloads')).d.rows;
  check('every document in a bundle is logged on its own',
        audit.filter(x => x.party_id === idC && x.doc_kind === 'bill').length >= yearPages ? true
          : audit.filter(x => x.party_id === idC).length > 1,
        audit.filter(x => x.party_id === idC).length);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[C3] A registered dealer gets their purchase invoice');
  // A seller with a GSTIN is billed by PURCHASE INVOICE, not a bill of
  // supply. Until these were added, every dealer signed in to an empty
  // screen with nothing saying why — 57 of them on the live install.
  let dealerPurchaseId = null;
  const DEALER = '9790700020';
  const sDealer = await mk('DEALER SPICES', DEALER);
  await api('PUT', `/api/traders/${sDealer.id}`,
    { name: 'DEALER SPICES', tel: DEALER, cr: '33AAAAA0000A1Z5' });
  const dLot = await addLot(sDealer);
  let dl = (await api('GET', `/api/lots/${A}`)).d.filter(l => String(l.lot_no) === dLot);
  await api('POST', '/api/lots/bulk-set-buyer',
    { ids: dl.map(l => l.id), code: 'BUY1', buyer: 'BUY1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: dl.map(l => ({ id: l.id, price: 3000 })) });
  await api('POST', `/api/lots/calculate/${A}`, {});
  r = await api('POST', `/api/purchases/generate-all/${A}`, { startInvoiceNo: 500 });
  const purAll = (await api('GET', `/api/purchases?auction_id=${A}`)).d;
  const purRows = Array.isArray(purAll) ? purAll : (purAll && purAll.rows) || [];
  const myPur = purRows.find(x => x.trader_id === sDealer.id);
  check('fixture: a purchase invoice was raised for the dealer', !!myPur, purRows.length);

  if (myPur) {
    const linkD = (await api('GET', '/api/portal/admin/links')).d.rows
      .find(x => x.party_kind === 'seller' && x.party_id === sDealer.id);
    check('raising it enrolled them, like a bill does', !!linkD, linkD);

    const vD2 = await signIn(DEALER);
    const tokD2 = vD2.d && vD2.d.token;
    check('the dealer can sign in', vD2.s === 200 && !!tokD2, vD2.d);
    r = await portal('GET', `/api/portal/documents?party=seller:${sDealer.id}`, null, tokD2);
    const purDoc = r.d.documents.find(x => x.kind === 'purchase');
    check('…and sees their purchase invoice', !!purDoc, r.d.documents.map(x => x.kind));
    check('…labelled as one', purDoc && purDoc.label === 'Purchase Invoice', purDoc && purDoc.label);

    // The document prints total MINUS the 194Q deduction; the row must too.
    check('…priced at the Grand Total the document prints, not the subtotal',
          purDoc && Math.abs(purDoc.amount - (Number(myPur.total) - Number(myPur.tds || 0))) < 0.01,
          { row: purDoc && purDoc.amount, total: myPur.total, tds: myPur.tds });

    const pPdf = await raw(`/api/portal/documents/purchase/${purDoc.id}/pdf?token=${tokD2}`);
    check('…and it downloads as a real PDF',
          pPdf.s === 200 && pPdf.buf.slice(0, 4).toString() === '%PDF', pPdf.s);

    // Another dealer's invoice is still refused.
    const theirPur = purRows.find(x => x.trader_id !== sDealer.id);
    if (theirPur) {
      r = await portal('GET', `/api/portal/documents/purchase/${theirPur.id}/pdf`, null, tokD2);
      check("…while another dealer's is refused", r.s === 403, r.s);
    }
    // ── The same purchase, three ways ────────────────────────────────
    // The bill statement and the per-lot payment voucher are the SAME
    // purchase seen differently, so they add NO rows: the purchase row
    // advertises them as formats. Listing them separately would repeat the
    // dealer's money three times down the screen.
    check('…the purchase is still ONE row',
          r.d.documents.filter(x => x.id === purDoc.id).length === 1,
          r.d.documents.map(x => x.kind + ':' + x.id).join(','));
    check('…advertising three download formats',
          Array.isArray(purDoc.formats)
          && purDoc.formats.map(f => f.kind).join(',') === 'purchase,statement,voucher',
          JSON.stringify(purDoc.formats));
    for (const kind of ['statement', 'voucher']) {
      const g = await raw(`/api/portal/documents/${kind}/${purDoc.id}/pdf?token=${tokD2}`);
      check(`…the ${kind} downloads as a real PDF`,
            g.s === 200 && g.buf.slice(0, 4).toString() === '%PDF',
            { s: g.s, head: g.buf.slice(0, 50).toString() });
      // As owned as the invoice: no token, and no OTHER party's token.
      check(`…the ${kind} needs a token`,
            (await raw(`/api/portal/documents/${kind}/${purDoc.id}/pdf`)).s === 401);
      check(`…and is refused to another seller's handset`,
            (await raw(`/api/portal/documents/${kind}/${purDoc.id}/pdf?token=${tokC}`)).s === 403);
    }
    // The statement must be the OFFICE's document, not a portal lookalike:
    // same bytes as the Purchases screen prints for that row.
    const office = await fetch(B + '/api/purchases/bill-statement-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
      body: JSON.stringify({ ids: [myPur.id] }) });
    const officeBuf = Buffer.from(await office.arrayBuffer());
    const portalBuf = (await raw(`/api/portal/documents/statement/${purDoc.id}/pdf?token=${tokD2}`)).buf;
    // Not byte-equal — a PDF carries a creation timestamp — so compare the
    // size, which moves the moment the content does.
    check('…and the statement is the office\'s own document, not a lookalike',
          Math.abs(officeBuf.length - portalBuf.length) < 2048 && officeBuf.length > 1000,
          { office: officeBuf.length, portal: portalBuf.length });

    // ── A BUNDLE can carry the three shapes too ──────────────────────
    // The row chips offered all three for ONE document; a bundle could only
    // ever carry invoices, so picking a month and pressing Download gave no
    // way to ask for the statements. `?formats=` is how the chooser asks.
    const pagesOf = async (u) => {
      const g = await raw(u);
      if (g.s !== 200 || g.buf.slice(0, 4).toString() !== '%PDF') return -1;
      return (await PDFDocument.load(g.buf)).getPageCount();
    };
    const one = `/api/portal/documents/purchase/${purDoc.id}/pdf?token=${tokD2}`;
    const nInv = await pagesOf(one);
    const nStmt = await pagesOf(`/api/portal/documents/statement/${purDoc.id}/pdf?token=${tokD2}`);
    const nVou = await pagesOf(`/api/portal/documents/voucher/${purDoc.id}/pdf?token=${tokD2}`);
    const bundle = (f) => `/api/portal/documents/bulk?party=seller:${sDealer.id}`
      + `&ids=${purDoc.id}` + (f ? `&formats=${f}` : '') + `&token=${tokD2}`;

    check('a bundle with no format asked for is still invoices only',
          nInv > 0 && (await pagesOf(bundle(''))) === nInv,
          { invoice: nInv, bundle: await pagesOf(bundle('')) });
    const nAll = await pagesOf(bundle('purchase,statement,voucher'));
    check('…asking for all three puts all three in the file',
          nStmt > 0 && nVou > 0 && nAll === nInv + nStmt + nVou,
          { invoice: nInv, statement: nStmt, voucher: nVou, bundle: nAll });
    check('…and asking for one shape gives only that shape',
          (await pagesOf(bundle('statement'))) === nStmt,
          { want: nStmt, got: await pagesOf(bundle('statement')) });
    // Honoured in a fixed order, not in whatever order the query listed —
    // so two readers asking the same thing get the same file.
    check('…the order is the document\'s, not the query string\'s',
          (await pagesOf(bundle('voucher,purchase'))) === nInv + nVou,
          { got: await pagesOf(bundle('voucher,purchase')) });

    // A name nobody offers is DROPPED, and if that leaves nothing the
    // request is refused — never quietly answered with invoices.
    const junk = await raw(bundle('wishlist'));
    check('…an unknown format is refused, not silently replaced',
          junk.s === 400, { s: junk.s, body: junk.buf.slice(0, 120).toString() });
    check('…while an unknown one alongside a real one just drops',
          (await pagesOf(bundle('wishlist,statement'))) === nStmt);

    // Three files called NAME_1_documents.pdf are indistinguishable in a
    // downloads folder, so the filename says which shapes are inside.
    const cdAll = (await raw(bundle('purchase,statement,voucher'))).cd || '';
    check('…and the filename names the shapes it carries',
          /Invoices_Statements_Vouchers\.pdf/.test(cdAll), cdAll);
    const cdStmt = (await raw(bundle('statement'))).cd || '';
    check('…including when only one was asked for',
          /_Statements\.pdf/.test(cdStmt), cdStmt);

    // 'Who saw what' has to name the shape. One audit row per shape handed
    // over, the same as a single download writes.
    await raw(bundle('statement,voucher'));
    const audit = (await api('GET', '/api/portal/admin/downloads')).d.rows || [];
    const forDoc = audit.filter(x => Number(x.doc_id) === Number(purDoc.id));
    check('…and the audit names each shape, not just "the bundle"',
          forDoc.some(x => x.doc_kind === 'statement') && forDoc.some(x => x.doc_kind === 'voucher'),
          forDoc.slice(0, 6).map(x => x.doc_kind).join(','));

    // The format is not a side door: ownership is still checked against the
    // party's own set, exactly as it is without one. Unconditional, because
    // this fixture may hold only one dealer's purchases and an `if` around
    // it would pass by not running.
    const steal = await raw(`/api/portal/documents/bulk?party=seller:${sDealer.id}`
      + `&ids=${(theirPur && theirPur.id) || 999999}&formats=statement&token=${tokD2}`);
    check("…and a format cannot reach a purchase this party does not hold",
          steal.s === 403, { s: steal.s, other: !!theirPur });

    // A buyer must not reach the purchase kind either — checked in [E],
    // where a buyer token exists.
    dealerPurchaseId = purDoc.id;
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[D] One handset, two parties — the shared-phone decision');
  const vD = await signIn(SHARED);
  check('both sellers come back on one sign-in', vD.d.parties.length === 2,
        vD.d.parties && vD.d.parties.map(p => p.name));
  const tokD = vD.d.token;
  const [p1, p2] = vD.d.parties;
  const d1 = await portal('GET', `/api/portal/documents?party=seller:${p1.id}`, null, tokD);
  const d2 = await portal('GET', `/api/portal/documents?party=seller:${p2.id}`, null, tokD);
  check('each party lists its own documents', d1.s === 200 && d2.s === 200
        && d1.d.documents.length > 0 && d2.d.documents.length > 0);
  check('…and the two lists are different documents',
        d1.d.documents[0].id !== d2.d.documents[0].id,
        [d1.d.documents[0].id, d2.d.documents[0].id]);

  // The property that makes a shared handset survivable.
  const links = (await api('GET', `/api/portal/admin/links?q=${SHARED}`)).d.rows;
  check('the admin list says this number opens two parties',
        links.length === 2 && links.every(l => l.shares === 2), links.map(l => l.shares));
  const drop = links.find(l => l.party_id === p1.id);
  r = await api('POST', `/api/portal/admin/links/${drop.id}/revoke`);
  check('one link can be revoked', r.s === 200, r.d);
  r = await portal('GET', '/api/portal/me', null, tokD);
  check('…and it disappears on the NEXT REQUEST of the live session',
        r.s === 200 && r.d.parties.length === 1 && r.d.parties[0].id === p2.id, r.d);
  r = await portal('GET', `/api/portal/documents?party=seller:${p1.id}`, null, tokD);
  check('…the revoked party is immediately unreachable', r.s === 403, r.s);
  r = await portal('GET', `/api/portal/documents?party=seller:${p2.id}`, null, tokD);
  check('…while the other party on the same handset is untouched', r.s === 200, r.s);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[E] A buyer sees originals only — never a draft, never a stopped invoice');
  const vE = await signIn(BUYERP);
  check('the buyer signs in', vE.s === 200 && vE.d.parties[0].kind === 'buyer', vE.d);
  const tokE = vE.d.token, idE = vE.d.parties[0].id;
  r = await portal('GET', `/api/portal/documents?party=buyer:${idE}`, null, tokE);
  const inv = r.d.documents.find(d => d.kind === 'invoice');
  check('their tax invoice is listed', !!inv, r.d.documents);
  // An invoice spans many lots — up to 57 on live data — so the page shows a
  // count that reveals the list. The SERVER's job is to return them all.
  check('…and carries every lot number on it',
        inv && Array.isArray(inv.lots) && inv.lots.length >= 1, inv && inv.lots);
  const invLotRows = (await api('GET', `/api/lots/${A}`)).d
    .filter(l => String(l.invo || '') === String(inv.no)).map(l => String(l.lot_no));
  check('…matching the lots actually invoiced',
        inv && invLotRows.length && invLotRows.every(n => inv.lots.includes(n)),
        { row: inv && inv.lots, lots: invLotRows });
  check('…sorted numerically, not as text',
        inv && inv.lots.slice().sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join() === inv.lots.join(),
        inv && inv.lots);

  // A proforma raised over the remaining stock must never surface.
  await api('PUT', '/api/company-settings', { settings: { flag_proforma_invoice: 'true' } });
  const before = (await portal('GET', `/api/portal/documents?party=buyer:${idE}`, null, tokE)).d.documents.length;
  // docType, NOT is_proforma — the route reads req.body.docType (see
  // wantsProformaDoc). With the wrong key this quietly raises ORIGINALS,
  // and the check below passes only because there is nothing left to bill.
  r = await api('POST', `/api/invoices/generate-all/${A}`, { startInvoiceNo: 90, docType: 'proforma' });
  check('fixture: a proforma was actually raised', r.s === 200 && (r.d.generated || 0) > 0, r.d);
  const after = (await portal('GET', `/api/portal/documents?party=buyer:${idE}`, null, tokE)).d.documents;
  check('a proforma draft does not appear', after.length === before, { before, after: after.length });
  const allInv = (await api('GET', `/api/invoices?auction_id=${A}`)).d;
  const pro = (Array.isArray(allInv) ? allInv : allInv.rows || []).find(i => Number(i.is_proforma) === 1);
  if (pro) {
    r = await portal('GET', `/api/portal/documents/invoice/${pro.id}/pdf`, null, tokE);
    check('…and is refused even when asked for by id', r.s === 403, { s: r.s, d: r.d });
  } else {
    check('…and is refused even when asked for by id', true, 'no proforma raised; nothing to hide');
  }

  // A stopped invoice. Reached through bulk-set-buyer, which is the one path
  // that will set the flag on a lot that has already been billed.
  const invLots = (await api('GET', `/api/lots/${A}`)).d.filter(l => String(l.invo || '') === String(inv.no));
  await api('POST', '/api/lots/bulk-set-buyer', { ids: invLots.map(l => l.id), hold: true });
  r = await portal('GET', `/api/portal/documents?party=buyer:${idE}`, null, tokE);
  check('a stopped invoice drops off the list',
        !r.d.documents.some(d => d.kind === 'invoice' && d.id === inv.id), r.d.documents);
  r = await portal('GET', `/api/portal/documents/invoice/${inv.id}/pdf`, null, tokE);
  check('…and is withheld on a direct fetch', r.s === 403, { s: r.s, d: r.d });
  // A buyer has no business in the seller-side kinds.
  if (dealerPurchaseId) {
    r = await portal('GET', `/api/portal/documents/purchase/${dealerPurchaseId}/pdf`, null, tokE);
    check('a buyer cannot reach a purchase invoice', r.s === 403 || r.s === 404, r.s);
  }
  await api('POST', '/api/lots/bulk-set-buyer', { ids: invLots.map(l => l.id), hold: false });
  r = await portal('GET', `/api/portal/documents?party=buyer:${idE}`, null, tokE);
  check('…and comes back when the hold is released',
        r.d.documents.some(d => d.kind === 'invoice' && d.id === inv.id), r.d.documents);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[F] The login door itself');
  // An unknown number must be indistinguishable from a known one, or this
  // endpoint becomes a free directory of who trades here.
  const known   = await portal('POST', '/api/portal/otp/request', { phone: SOLO });
  const unknown = await portal('POST', '/api/portal/otp/request', { phone: '9790799999' });
  check('a known and an unknown number answer identically',
        JSON.stringify(known.d) === JSON.stringify(unknown.d), [known.d, unknown.d]);
  check('…and neither response names a delivery channel',
        !('channel' in (known.d || {})), known.d);
  check('the public config does not name one either',
        !('channel' in ((await portal('GET', '/api/portal/config')).d || {})));

  r = await portal('POST', '/api/portal/otp/verify', { phone: SOLO, code: '000000' });
  check('a wrong code is refused', r.s === 401, r.d);
  r = await portal('POST', '/api/portal/otp/verify', { phone: SOLO, code: codeFor(SOLO) });
  check('…and the real one still works afterwards', r.s === 200 && !!r.d.token, r.d);
  r = await portal('POST', '/api/portal/otp/verify', { phone: SOLO, code: codeFor(SOLO) });
  check('a consumed code cannot be replayed', r.s === 401, r.d);

  // ── The standard one-time-code rules ──
  // A code is single-use, time-boxed, and ONLY THE NEWEST ONE WORKS. That
  // last rule is the one that is easy to get wrong: verify picks the latest
  // unconsumed row, so without superseding on issue, spending a new code
  // promotes the previous one back to being the latest unconsumed and it
  // stays live for the rest of its ten minutes.
  const SUP = SHARED;
  await portal('POST', '/api/portal/otp/request', { phone: SUP });
  await new Promise(x => setTimeout(x, 120));
  const firstCode = codeFor(SUP);
  await portal('POST', '/api/portal/otp/request', { phone: SUP });
  await new Promise(x => setTimeout(x, 120));
  const secondCode = codeFor(SUP);
  check('a resend issues a different code', firstCode && secondCode && firstCode !== secondCode,
        { firstCode, secondCode });
  r = await portal('POST', '/api/portal/otp/verify', { phone: SUP, code: firstCode });
  check('…and the SUPERSEDED code no longer works', r.s === 401, { s: r.s, d: r.d });
  r = await portal('POST', '/api/portal/otp/verify', { phone: SUP, code: secondCode });
  check('…while the newest one does', r.s === 200 && !!r.d.token, r.d && r.d.error);

  // The response carries the lifetime the page counts down from.
  r = await portal('POST', '/api/portal/otp/request', { phone: BUYERP });
  check('the request tells the page how long the code lives',
        r.d && r.d.ttlSeconds === 600 && r.d.ttlMinutes === 10, r.d);
  check('…and when "send again" may be offered',
        r.d && typeof r.d.resendAfterSeconds === 'number' && r.d.resendAfterSeconds > 0, r.d);

  // The expiry is real and lives on the ROW, not only in the page's clock —
  // a countdown the server does not enforce is decoration.
  const otpRow = (await api('GET', `/api/portal/admin/otp-state?phone=${BUYERP}`)).d;
  const exp = otpRow && otpRow.otp && Date.parse((otpRow.otp.expires_at || '').replace(' ', 'T'));
  const made = otpRow && otpRow.otp && Date.parse((otpRow.otp.created_at || '').replace(' ', 'T'));
  const lifeMin = exp && made ? Math.round((exp - made) / 60000) : 0;
  check('the issued code carries a ten-minute expiry on the row',
        lifeMin === 10, { created_at: otpRow && otpRow.otp && otpRow.otp.created_at,
                          expires_at: otpRow && otpRow.otp && otpRow.otp.expires_at, lifeMin });
  check('…and it has not been consumed yet',
        otpRow && otpRow.otp && !otpRow.otp.consumed_at, otpRow && otpRow.otp);
  r = await portal('POST', '/api/portal/otp/verify', { phone: BUYERP, code: '000000' });
  check('a wrong code against a live row is refused', r.s === 401, r.s);
  const otpAfter = (await api('GET', `/api/portal/admin/otp-state?phone=${BUYERP}`)).d;
  check('…and the attempt is counted against that row',
        otpAfter && otpAfter.otp && Number(otpAfter.otp.attempts) === 1, otpAfter && otpAfter.otp);

  // Per-phone throttle: three codes per quarter hour.
  const burst = [];
  for (let i = 0; i < 5; i++) burst.push((await portal('POST', '/api/portal/otp/request', { phone: '9790788888' })).s);
  check('the OTP endpoint throttles a flood', burst.includes(429), burst);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[F2] Sign-in codes over WhatsApp');
  // The portal can deliver codes through the Cloud API, but ONLY through a
  // template Meta approved in the AUTHENTICATION category. This install has
  // no WhatsApp credentials in test, so what is pinned here is the refusal
  // behaviour — which is the part that matters: a missing or mis-categorised
  // template must fail loudly and must never fall back to writing a live
  // code into the server log.
  r = await api('POST', '/api/portal/admin/otp-test', { phone: WAP });
  check('a test code refuses to go out with no template configured',
        r.s === 200 && r.d.ok === false && /template|configured/i.test(r.d.error || ''),
        r.d);
  check('…and says plainly that nothing reached the customer',
        /Nothing reached the customer/.test((r.d && r.d.note) || ''), r.d && r.d.note);
  r = await api('POST', '/api/portal/admin/otp-test', { phone: '9790799999' });
  check('…and refuses outright for a number nobody is linked to', r.s === 404, r.s);

  // Switch the channel over with nothing behind it: the login must still
  // answer identically, and the code must NOT appear in the log.
  await api('PUT', '/api/company-settings', { settings: { portal_otp_channel: 'whatsapp' } });
  const logMark = srvLog.length;
  // A number whose throttle budget nothing else has touched — a 429 here
  // would look exactly like the WhatsApp path failing.
  r = await portal('POST', '/api/portal/otp/request', { phone: WAP });
  check('a login still answers normally when the channel is down', r.s === 200 && r.d.ok, r.d);
  await new Promise(x => setTimeout(x, 250));
  const emitted = srvLog.slice(logMark);
  check('…but no sign-in code is written to the log as a fallback',
        !/OTP for \d{10}: \d{6}/.test(emitted),
        (emitted.match(/OTP for .*/) || [''])[0]);
  check('…and the failure IS recorded, loudly',
        /NOT delivered/.test(emitted), emitted.slice(-200));
  const st = (await api('GET', `/api/portal/admin/otp-state?phone=${WAP}`)).d;
  check('…and the OTP row says the channel failed',
        st && st.otp && /failed/.test(st.otp.channel || ''), st && st.otp);
  await api('PUT', '/api/company-settings', { settings: { portal_otp_channel: 'log' } });

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[F3] Signing out really ends the session');
  // The PAGE clearing its number box is a browser concern, but the server
  // half has to hold too: the token must stop working the instant someone
  // signs out, or "sign out" on a shared handset means nothing.
  const vOut = await signIn(SOLO);
  check('signed in again', vOut.s === 200 && !!vOut.d.token, vOut.d);
  const tOut = vOut.d.token;
  check('…the session works', (await portal('GET', '/api/portal/me', null, tOut)).s === 200);
  r = await portal('POST', '/api/portal/logout', null, tOut);
  check('…sign out is accepted', r.s === 200, r.d);
  check('…and the token is dead immediately',
        (await portal('GET', '/api/portal/me', null, tOut)).s === 401);
  check('…including for a document it could fetch a second ago',
        (await raw(`/api/portal/documents/bill/${myBill.id}/pdf?token=${tOut}`)).s === 401);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n[G] The flag is a real kill switch, and downloads are logged');
  r = await api('GET', '/api/portal/admin/downloads');
  check('every download was recorded', r.s === 200 && r.d.rows.length >= 1, r.d && r.d.rows.length);
  check('…naming the party, not just the handset',
        r.d.rows.every(x => x.party_kind && x.party_id), r.d.rows[0]);

  await api('PUT', '/api/company-settings', { settings: { flag_customer_portal: 'false' } });
  r = await portal('GET', '/api/portal/me', null, tokC);
  check('turning the flag off cuts a LIVE session dead', r.s === 404, r.s);
  check('…and closes /my', (await raw('/my')).s === 404);
  check('…while the admin surface stays open', (await api('GET', '/api/portal/admin/links')).s === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR', e);
  console.error(srvLog.slice(-3000));
  cleanup();
  process.exit(1);
});
