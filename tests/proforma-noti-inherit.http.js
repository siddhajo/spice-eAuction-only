// PROFORMA → ORIGINAL: the dropped TRANSPORT & INSURANCE carries across.
//
// A proforma is what the buyer was QUOTED. When the operator ticks "No
// Transport & Insurance" on the draft, the tax invoice raised for the same
// lots must not put those charges back — the buyer would be billed for
// charges they never agreed to, and the original would disagree with the
// draft it shipped.
//
// POST /:id/raise-original always did this (it reads pf.no_ti). The two
// GENERATE endpoints did NOT: they take noTI from the Generate modal, which
// defaults to unticked, so generating the original over a draft's lots
// silently re-added transport & insurance. Both are covered here, plus the
// previews the operator checks before pressing Generate.
//
// The rule is ONE-WAY on purpose: the draft's "no T&I" wins, but a draft that
// carried the charges never forces them onto an original the operator chose to
// drop them from. [D] pins that direction down.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-noti-'));
const PORT = 47419;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); }
                             else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

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
const rowsOf = d => (d && (d.rows || d)) || [];

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', b => log += b); srv.stderr.on('data', b => log += b);
const done = c => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(c);
};

// The invoice row as the app stores it: pava_hc is transport, ins is
// insurance. "Charged" means at least one of them is non-zero.
const charged = r => (Number(r.pava_hc) || 0) > 0 || (Number(r.ins) || 0) > 0;
const money   = r => `T=${Number(r.pava_hc) || 0} I=${Number(r.ins) || 0} noTI=${r.no_ti} tot=${r.tot}`;

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, log.slice(-2000)); done(1); }

  // Non-zero transport + insurance rates, or the whole test is vacuous: with
  // both at 0 an invoice looks identical whether the flag is set or not.
  //
  // The LOCAL keys matter as much as the inter-state ones: this fixture bills
  // sale type L, and calculations.js picks local_transport / local_insurance
  // for a local invoice (falling through to transport / insurance only when
  // the local key is blank, not when it is a real 0).
  await api('PUT', '/api/company-settings', { settings: {
    flag_proforma_invoice: 'true', flag_local_ti: 'true',
    transport: '5', insurance: '3', local_transport: '5', local_insurance: '3',
  } });
  const cfg = (await api('GET', '/api/company-settings/flat')).d || {};
  check('local transport + insurance rates are non-zero',
        Number(cfg.local_transport) > 0 && Number(cfg.local_insurance) > 0,
        `local_transport=${cfg.local_transport} local_insurance=${cfg.local_insurance}`);

  const auc = await api('POST', '/api/auctions', { ano: '31', date: '2026-09-10', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  async function lot(lot_no, buyer) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'SELLER ' + lot_no, qty: 100 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`,
      { buyer, buyer1: buyer, code: buyer, price: 100, amount: 10000, bags: 5, qty: 100, sale: 'L' });
    return id;
  }
  for (const b of ['AAA', 'BBB', 'CCC', 'DDD']) await lot(String(['AAA','BBB','CCC','DDD'].indexOf(b) + 1), b);

  const invOf = async (buyer, wantProforma) => rowsOf(
    (await api('GET', `/api/invoices?auction_id=${aid}&docType=${wantProforma ? 'proforma' : 'original'}`)).d)
    .find(r => r.buyer === buyer);

  // ══ [A] the control: a draft that KEPT the charges ════════════
  console.log('\n[A] a draft that kept transport & insurance');
  await api('POST', `/api/invoices/generate/${aid}`,
    { buyerCode: 'AAA', invoiceNo: '1', saleType: 'L', docType: 'proforma', noTI: false });
  const draftA = await invOf('AAA', true);
  check('the draft carries transport & insurance', draftA && charged(draftA), draftA && money(draftA));

  // ══ [B] a draft that DROPPED them, then Generate ═══════════════
  console.log('\n[B] a draft that dropped them → Generate raises the original');
  await api('POST', `/api/invoices/generate/${aid}`,
    { buyerCode: 'BBB', invoiceNo: '2', saleType: 'L', docType: 'proforma', noTI: true });
  const draftB = await invOf('BBB', true);
  check('the draft has neither charge', draftB && !charged(draftB), draftB && money(draftB));

  // What the operator sees BEFORE generating must already say zero, or the
  // preview and the document it previews disagree.
  const pv = await api('POST', `/api/invoices/preview/${aid}`,
    { buyerCode: 'BBB', saleType: 'L', type: 'sales', noTI: false, docType: 'original' });
  const ps = pv.d && pv.d.invoice && pv.d.invoice.summary;
  check('the Generate preview already shows no transport & insurance',
        ps && !Number(ps.transportCost) && !Number(ps.insuranceCost),
        JSON.stringify(ps && { t: ps.transportCost, i: ps.insuranceCost }));

  // The modal's checkbox is UNTICKED here — this is exactly the case that
  // used to re-add the charges.
  const genB = await api('POST', `/api/invoices/generate/${aid}`,
    { buyerCode: 'BBB', invoiceNo: '20', saleType: 'L', docType: 'original', noTI: false });
  check('the original generated', genB.status < 300, JSON.stringify(genB.d && genB.d.error));
  const origB = await invOf('BBB', false);
  check('the original inherits the draft\'s dropped charges',
        origB && !charged(origB), origB && money(origB));
  check('…and is stamped no_ti=1, so a reprint or Tally voucher agrees',
        origB && Number(origB.no_ti) === 1, origB && money(origB));
  check('the draft is marked raised by it',
        (await invOf('BBB', true)) && String((await invOf('BBB', true)).raised_invo) === '20',
        JSON.stringify((await invOf('BBB', true)) || {}));

  // ══ [C] the same over the BATCH generate ══════════════════════
  console.log('\n[C] Generate All over a mix of drafts');
  await api('POST', `/api/invoices/generate/${aid}`,
    { buyerCode: 'CCC', invoiceNo: '3', saleType: 'L', docType: 'proforma', noTI: true });
  const genAll = await api('POST', `/api/invoices/generate-all/${aid}`,
    { startInvoiceNo: '30', saleType: 'L', docType: 'original', noTI: false });
  check('generate-all ran', genAll.status < 300, JSON.stringify(genAll.d && genAll.d.error));
  const origA = await invOf('AAA', false);
  const origC = await invOf('CCC', false);
  const origD = await invOf('DDD', false);
  check('CCC — draft dropped them, so the original has neither',
        origC && !charged(origC), origC && money(origC));
  check('AAA — draft KEPT them, so the original still charges them',
        origA && charged(origA), origA && money(origA));
  check('DDD — no draft at all, so nothing changes for it',
        origD && charged(origD), origD && money(origD));

  // ══ [D] one-way: the draft can only ever REMOVE the charges ═══
  console.log('\n[D] the inheritance only ever removes charges, never adds them');
  await api('POST', `/api/invoices/${origA.id}/revert`, {});
  const genA2 = await api('POST', `/api/invoices/generate/${aid}`,
    { buyerCode: 'AAA', invoiceNo: '40', saleType: 'L', docType: 'original', noTI: true });
  check('re-generated AAA with the modal\'s No T&I ticked', genA2.status < 300,
        JSON.stringify(genA2.d && genA2.d.error));
  const origA2 = await invOf('AAA', false);
  check('an operator ticking No T&I still wins over a draft that charged them',
        origA2 && !charged(origA2) && Number(origA2.no_ti) === 1, origA2 && money(origA2));

  // ══ [E] the dedicated Raise Original path is untouched ════════
  console.log('\n[E] the ⬆ Raise Original button still behaves');
  await lot('9', 'EEE');
  await api('POST', `/api/invoices/generate/${aid}`,
    { buyerCode: 'EEE', invoiceNo: '9', saleType: 'L', docType: 'proforma', noTI: true });
  const draftE = await invOf('EEE', true);
  const raise = await api('POST', `/api/invoices/${draftE.id}/raise-original`, { saleType: 'L' });
  check('raise-original succeeded', raise.status < 300, JSON.stringify(raise.d && raise.d.error));
  const origE = await invOf('EEE', false);
  check('the raised original carries no transport & insurance',
        origE && !charged(origE) && Number(origE.no_ti) === 1, origE && money(origE));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); done(1); });
