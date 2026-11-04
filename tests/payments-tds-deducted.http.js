// TDS (194Q) comes OFF the payable — on both Payments screens and in the
// bank file.
//
// TDS on purchase is withheld by US and remitted to the government, so it is
// not money the seller receives. The Purchases screen has always shown
// Payable = Total − TDS; the two Payments screens showed TDS as a figure and
// paid the gross, so the three disagreed about what a dealer is owed.
//
// What this pins is AGREEMENT, because the failure mode is a screen that
// promises one number and a bank file that pays another:
//
//   [seller]  classic seller-wise Payments: Payable = Net − Advance − TDS
//   [lot]     lot-wise Payments: each lot's payable carries its own TDS share
//   [shares]  the shares sum EXACTLY to the invoice's TDS — no paisa invented
//             or lost by the pro-rata split
//   [bank]    the bank file pays the same net, whole-seller and lot-picked
//   [partial] a part-paid seller withholds only the picked lots' share
//   [urd]     an agriculturist has no TDS and is untouched
//   [off]     with flag_tds_purchase off nothing changes at all
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-tds-'));
const PORT = 47476;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= (eps == null ? 0.02 : eps);

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function bankSheet(aid, body) {
  const r = await fetch(B + `/api/exports/bank_payment/${aid}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ format: 'xlsx' }, body || {})),
  });
  if (!r.ok) return { status: r.status, rows: [], head: [] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0];
  let head = null; const rows = [];
  ws.eachRow((row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (c) => {
      const v = c.value;
      cells.push(v == null ? '' : (typeof v === 'object' && v.result !== undefined ? v.result : v));
    });
    if (!head) { head = cells.map(v => String(v).trim().toUpperCase()); return; }
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = cells[i]; });
    rows.push(o);
  });
  return { status: r.status, rows, head };
}
// Which column holds the money depends on the configured bank format, and the
// seller's name can land in any of several text columns (beneficiary, holder,
// remarks, particulars). So find the amount column by name and identify the
// row by scanning ALL its cells — the test should not encode one bank's
// column layout.
const amtOf = (rows, head, who) => {
  const amtCol = head.find(h => /^AMOUNT$|AMOUNT/i.test(h));
  return rows
    .filter(r => !who || Object.values(r).some(v => new RegExp(who, 'i').test(String(v == null ? '' : v))))
    .reduce((s, r) => s + (Number(r[amtCol]) || 0), 0);
};

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

// A dealer with three UNEQUAL lots, so the pro-rata TDS split has a remainder
// to place, and a planter who must stay untouched.
const DEALER = 'AAA TRADERS', PLANTER = 'MURUGANANDAM K';
const LOTS = [
  { lot_no: '1', who: DEALER,  amount: 300000 },
  { lot_no: '2', who: DEALER,  amount: 250000 },
  { lot_no: '3', who: DEALER,  amount: 133333 },
  { lot_no: '4', who: PLANTER, amount: 200000 },
];

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  // TDS on at 1%. The threshold is ₹1, NOT 0: calculateTDS reads it as
  // `Number(cfg.tds_threshold) || 5000000`, so a zero falls back to the ₹50
  // lakh default and nothing would be withheld at all on a fixture this size.
  await api('PUT', '/api/company-settings', {
    settings: {
      flag_lotwise_payments: 'true', br1: 'ANAVILASAM',
      flag_tds_purchase: 'true', tds_purchase_rate: '1', tds_threshold: '1',
      gst_goods: '5', gunny_rate: '0', season_start: '2026-04-01',
      business_state: 'TAMILNADU', tn_gstin: '33AAHCE4551A1Z9',
    },
  });
  const auc = await api('POST', '/api/auctions', { ano: '71', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  const acct = (n, h) => [{ acctnum: n, ifsc: 'HDFC0001234', bank_name: 'HDFC',
    holder_name: h, account_type: 'Savings', is_default: 1 }];
  const mk = async (name, cr, an) => {
    const t = await api('POST', '/api/traders',
      { name, cr, padd: 'ADDR', ppla: 'PLACE', pan: 'AAHCE4551A', banks: acct(an, name) });
    const id = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
    if (!id) { console.error('trader failed', name, t.status, t.d); cleanup(); process.exit(1); }
    return id;
  };
  const dealerId  = await mk(DEALER,  'GSTIN.33AAHCE4551A1Z8', '1000011111');
  const planterId = await mk(PLANTER, '',                      '1000022222');

  const lotIdOf = {};
  for (const L of LOTS) {
    const isD = L.who === DEALER;
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no: L.lot_no, name: L.who, cr: isD ? 'GSTIN.33AAHCE4551A1Z8' : '',
      qty: 100, bags: 10, grade: isD ? '2' : '1', crop: 'CARDAMOM', branch: 'ANAVILASAM',
      trader_id: isD ? dealerId : planterId,
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    if (!id) { console.error('lot failed', L.lot_no, r.status, r.d); cleanup(); process.exit(1); }
    await api('PUT', `/api/lots/${id}`, {
      price: Math.round(L.amount / 100), amount: L.amount, puramt: L.amount, balance: L.amount,
    });
    lotIdOf[L.lot_no] = id;
  }

  // The TDS only exists once the purchase invoices are raised — that is where
  // it is computed and stored.
  const gen = await api('POST', `/api/purchases/generate-all/${aid}`, { startInvoiceNo: 1 });
  check('purchase invoices generated (that is where TDS is stamped)',
    gen.status === 200, JSON.stringify(gen.d).slice(0, 200));

  const summary = async () => (await api('GET', `/api/payments/${aid}`)).d || [];
  const lotRows = async (qs) => ((await api('GET', `/api/payments/lots/${aid}?${qs || 'link=all'}`)).d || {}).lots || [];

  let sellerTds = 0;
  console.log('[seller] classic seller-wise Payments deducts it');
  {
    const rows = await summary();
    const d = rows.find(r => new RegExp(DEALER, 'i').test(r.name));
    check('the dealer is listed', !!d, JSON.stringify(rows.map(r => r.name)));
    sellerTds = Number(d.tds) || 0;
    check('TDS is non-zero — the fixture actually withheld something', sellerTds > 0, String(sellerTds));
    const net = Number(d.net_amount) || 0;
    const adv = (Number(d.advance) || 0) + (Number(d.lot_advance) || 0);
    check('Payable = Net − Advance − TDS',
      near(Number(d.total_payable), net - adv - sellerTds),
      `net ${net} − adv ${adv} − tds ${sellerTds} = ${net - adv - sellerTds}, got ${d.total_payable}`);
    check('…which is strictly less than the net', Number(d.total_payable) < net);
  }

  console.log('[urd] the agriculturist is untouched');
  {
    const rows = await summary();
    const p = rows.find(r => new RegExp(PLANTER, 'i').test(r.name));
    check('planter TDS is 0', (Number(p.tds) || 0) === 0, String(p.tds));
    check('planter Payable still equals its net',
      near(Number(p.total_payable), Number(p.net_amount)),
      `${p.total_payable} vs ${p.net_amount}`);
  }

  console.log('[lot] the lot-wise screen carries a per-lot share');
  let dealerLots = [];
  {
    const lots = await lotRows();
    dealerLots = lots.filter(l => new RegExp(DEALER, 'i').test(l.name));
    check('three dealer lots listed', dealerLots.length === 3, String(dealerLots.length));
    check('every dealer lot carries a tds field', dealerLots.every(l => l.tds != null),
      JSON.stringify(dealerLots.map(l => [l.lot_no, l.tds])));
    check('each lot\'s payable is its gross less its own TDS (no advances here)',
      dealerLots.every(l => near(Number(l.payable), (Number(l.payable_gross) || 0) - (Number(l.tds) || 0))),
      JSON.stringify(dealerLots.map(l => [l.lot_no, l.payable_gross, l.tds, l.payable])));
    const planterLot = lots.find(l => new RegExp(PLANTER, 'i').test(l.name));
    check('the planter\'s lot has 0 TDS and an untouched payable',
      (Number(planterLot.tds) || 0) === 0 && near(planterLot.payable, planterLot.payable_gross),
      JSON.stringify([planterLot.tds, planterLot.payable, planterLot.payable_gross]));
  }

  console.log('[shares] the shares sum to the invoice exactly');
  {
    const sum = dealerLots.reduce((s, l) => s + (Number(l.tds) || 0), 0);
    check('Σ per-lot TDS == the seller\'s TDS, to the paisa',
      near(sum, sellerTds, 0.005), `Σ ${sum} vs seller ${sellerTds}`);
    check('…and the pro-rata split gave every lot a share',
      dealerLots.every(l => (Number(l.tds) || 0) > 0),
      JSON.stringify(dealerLots.map(l => [l.lot_no, l.tds])));
    // The seller-wise (RD) view sums these lots, so its Payable must equal the
    // classic screen's for the same seller.
    const grouped = dealerLots.reduce((s, l) => s + (Number(l.payable) || 0), 0);
    const rows = await summary();
    const d = rows.find(r => new RegExp(DEALER, 'i').test(r.name));
    check('the folded RD row would total the same Payable as the classic screen',
      near(grouped, Number(d.total_payable)), `lots ${grouped} vs classic ${d.total_payable}`);
  }

  console.log('[bank] the bank file pays that same net');
  {
    const whole = await bankSheet(aid, {});
    check('the whole-trade file exports', whole.status === 200 && whole.rows.length > 0,
      whole.status + ' rows ' + whole.rows.length);
    const rows = await summary();
    const d = rows.find(r => new RegExp(DEALER, 'i').test(r.name));
    const p = rows.find(r => new RegExp(PLANTER, 'i').test(r.name));
    check('the dealer\'s bank line equals its on-screen Payable',
      near(amtOf(whole.rows, whole.head, DEALER), Number(d.total_payable), 1.01),
      `file ${amtOf(whole.rows, whole.head, DEALER)} vs screen ${d.total_payable}`);
    check('the planter\'s bank line is unchanged',
      near(amtOf(whole.rows, whole.head, PLANTER), Number(p.total_payable), 1.01),
      `file ${amtOf(whole.rows, whole.head, PLANTER)} vs screen ${p.total_payable}`);

    // Lot-picked, every lot: the lot-wise screen's own export shape.
    const picked = await bankSheet(aid, {
      names: [DEALER], lots: { [DEALER]: ['1', '2', '3'] }, orderBy: 'lot',
    });
    check('a lot-picked export of ALL the dealer\'s lots pays the same',
      near(amtOf(picked.rows, picked.head, DEALER), Number(d.total_payable), 1.01),
      `picked ${amtOf(picked.rows, picked.head, DEALER)} vs screen ${d.total_payable}`);
  }

  console.log('[partial] a part payment withholds only the picked lots\' share');
  {
    const two = await bankSheet(aid, {
      names: [DEALER], lots: { [DEALER]: ['1', '2'] }, orderBy: 'lot',
    });
    const want = dealerLots
      .filter(l => ['1', '2'].includes(String(l.lot_no).trim()))
      .reduce((s, l) => s + (Number(l.payable) || 0), 0);
    check('two of three lots pay those two lots\' net',
      near(amtOf(two.rows, two.head, DEALER), want, 1.01),
      `file ${amtOf(two.rows, two.head, DEALER)} vs lots ${want}`);
    check('…which is less than the whole seller\'s payable',
      amtOf(two.rows, two.head, DEALER) > 0
      && amtOf(two.rows, two.head, DEALER) < Number((await summary()).find(r => new RegExp(DEALER, 'i').test(r.name)).total_payable) + 1);
  }

  console.log('[off] with the flag off, nothing is withheld anywhere');
  {
    // A SECOND trade raised with flag_tds_purchase off from the start, rather
    // than re-raising the first one's invoices — that is the state an install
    // that never enabled 194Q is actually in, and it proves the deduction is
    // inert there without needing a bulk-delete endpoint.
    await api('PUT', '/api/company-settings', { settings: { flag_tds_purchase: 'false' } });
    const a2r = await api('POST', '/api/auctions', { ano: '72', date: '2026-10-21', state: 'TAMIL NADU' });
    const aid2 = a2r.d && (a2r.d.id || (a2r.d.auction && a2r.d.auction.id));
    for (const L of LOTS) {
      const isD = L.who === DEALER;
      const r = await api('POST', '/api/lots', {
        auction_id: aid2, lot_no: L.lot_no, name: L.who, cr: isD ? 'GSTIN.33AAHCE4551A1Z8' : '',
        qty: 100, bags: 10, grade: isD ? '2' : '1', crop: 'CARDAMOM', branch: 'ANAVILASAM',
        trader_id: isD ? dealerId : planterId,
      });
      const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
      await api('PUT', `/api/lots/${id}`, {
        price: Math.round(L.amount / 100), amount: L.amount, puramt: L.amount, balance: L.amount,
      });
    }
    const g2 = await api('POST', `/api/purchases/generate-all/${aid2}`, { startInvoiceNo: 100 });
    check('the flag-off trade raised its purchase invoices', g2.status === 200,
      JSON.stringify(g2.d).slice(0, 160));
    const rows2 = (await api('GET', `/api/payments/${aid2}`)).d || [];
    const d2 = rows2.find(r => new RegExp(DEALER, 'i').test(r.name));
    check('seller TDS is 0', (Number(d2.tds) || 0) === 0, String(d2.tds));
    check('Payable is the full net',
      near(Number(d2.total_payable), Number(d2.net_amount)),
      `${d2.total_payable} vs ${d2.net_amount}`);
    const lots2 = ((await api('GET', `/api/payments/lots/${aid2}?link=all`)).d || {}).lots || [];
    check('every lot\'s TDS is 0', lots2.length > 0 && lots2.every(l => (Number(l.tds) || 0) === 0),
      JSON.stringify(lots2.map(l => [l.lot_no, l.tds])));
    check('and every lot pays its full gross',
      lots2.every(l => near(l.payable, l.payable_gross)),
      JSON.stringify(lots2.map(l => [l.lot_no, l.payable, l.payable_gross])));
    const bank2 = await bankSheet(aid2, {});
    check('the bank file pays the full net too',
      near(amtOf(bank2.rows, bank2.head, DEALER), Number(d2.total_payable), 1.01),
      `file ${amtOf(bank2.rows, bank2.head, DEALER)} vs screen ${d2.total_payable}`);
  }

  console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} ok, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
