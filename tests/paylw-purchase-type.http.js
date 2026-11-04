// Payments — lot-wise: the RD / URD purchase-type split (?ptype).
//
// RD and URD sellers are not paid the same way. A registered dealer is
// invoiced and settled lot by lot; an agriculturist is covered by one Bill of
// Supply and paid as a party. The screen now lets the operator ask for one or
// the other, and the URD view folds the table one row per seller.
//
// The SERVER's job is only the filter — and the thing that must never drift is
// WHICH predicate splits the two. It has to be the GSTIN-on-`cr` rule that
// gates the purchase-invoice and bill-of-supply eligible-lot queries
// (calculations.hasValidGstinSql), not the GSTIN+SBL dealerSql rule the
// Dashboard and Lot Entry use. If this screen and those documents disagree, a
// seller gets a Bill of Supply and appears in the RD payment run, or vice
// versa. That is what the [rule] section pins.
//
//   [valid]  the param is validated, and defaults to the old behaviour
//   [split]  rd and urd partition the trade; both together equal 'all'
//   [rule]   the split agrees with the purchase / bill generators' own view
//   [badge]  every row carries is_rd, whatever ptype asked for
//   [why]    a lot excluded by the filter says so, naming its own side
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-ptype-'));
const PORT = 47468;
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

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

// Four sellers covering the rule's corners. `cr` is what decides it:
//   RD  — a full 15-char GSTIN, with or without the GSTIN prefix
//   URD — blank, a CR number, or a GSTIN-prefixed value that isn't one
// The SBL (aadhar) is deliberately set on only some of them: it must make no
// difference here, which is exactly what separates this rule from dealerSql.
const SELLERS = [
  { name: 'AAA TRADERS',    cr: 'GSTIN.33AAHCE4551A1Z8', aadhar: 'SBL/123', rd: true,  lots: ['1', '2'] },
  { name: 'BBB AGRO',       cr: '33AAHCE4551A1Z9',        aadhar: '',        rd: true,  lots: ['3'] },
  { name: 'MURUGANANDAM K', cr: '',                       aadhar: '',        rd: false, lots: ['4', '5', '6'] },
  { name: 'RAVI KUMAR',     cr: 'CR.4821',                aadhar: 'SBL/777', rd: false, lots: ['7', '8'] },
];

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', {
    settings: { flag_lotwise_payments: 'true', br1: 'ANAVILASAM', gunny_rate: '150', gst_goods: '5' },
  });
  const auc = await api('POST', '/api/auctions', { ano: '55', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  const lotOf = {};   // lot_no → { id, rd, name }
  for (const s of SELLERS) {
    const t = await api('POST', '/api/traders', { name: s.name, cr: s.cr, aadhar: s.aadhar, padd: 'ADDR', ppla: 'PLACE' });
    const traderId = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
    if (!traderId) { console.error('trader create failed', s.name, t.status, t.d); cleanup(); process.exit(1); }
    for (const lot_no of s.lots) {
      const r = await api('POST', '/api/lots', {
        auction_id: aid, lot_no, name: s.name, cr: s.cr, aadhar: s.aadhar, qty: 100, bags: 10,
        grade: s.rd ? '2' : '1', crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: traderId,
      });
      const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
      if (!id) { console.error('lot create failed', lot_no, r.status, r.d); cleanup(); process.exit(1); }
      await api('PUT', `/api/lots/${id}`, { price: 2000, amount: 200000, balance: 196000 });
      lotOf[lot_no] = { id, rd: s.rd, name: s.name };
    }
  }

  const search = (qs) => api('GET', `/api/payments/lots/${aid}?${qs}`);
  const nos = (d) => (d.lots || []).map(l => String(l.lot_no).trim()).sort();

  console.log('[valid] the parameter is validated and defaults to today\'s behaviour');
  {
    const bad = await search('ptype=dealer');
    check('an unknown ptype is rejected, naming the three it takes',
      bad.status === 400 && /all, rd, urd/.test((bad.d && bad.d.error) || ''),
      bad.status + ' :: ' + JSON.stringify(bad.d));
    const none = await search('link=all');
    const all = await search('link=all&ptype=all');
    check('omitting it lists the whole trade, exactly as before',
      none.status === 200 && all.status === 200 && nos(none.d).length === 8
      && JSON.stringify(nos(none.d)) === JSON.stringify(nos(all.d)),
      `${nos(none.d).length} lots :: ${nos(none.d).join(',')}`);
  }

  console.log('[split] rd and urd partition the trade');
  let rd, urd;
  {
    rd = await search('link=all&ptype=rd');
    urd = await search('link=all&ptype=urd');
    check('rd lists only the registered dealers\' lots',
      JSON.stringify(nos(rd.d)) === JSON.stringify(['1', '2', '3']), nos(rd.d).join(','));
    check('urd lists only the agriculturists\' lots',
      JSON.stringify(nos(urd.d)) === JSON.stringify(['4', '5', '6', '7', '8']), nos(urd.d).join(','));
    check('the two together are the whole trade, with no lot in both',
      nos(rd.d).length + nos(urd.d).length === 8
      && !nos(rd.d).some(n => nos(urd.d).includes(n)));
    check('a blank cr lands in URD', nos(urd.d).includes('4'));
    check('a CR-number cr lands in URD, SBL notwithstanding', nos(urd.d).includes('7'));
    check('a GSTIN with the GSTIN. prefix lands in RD', nos(rd.d).includes('1'));
    check('a bare 15-char GSTIN lands in RD with no SBL at all', nos(rd.d).includes('3'));
  }

  console.log('[rule] the split agrees with the documents these sellers are billed on');
  {
    // The purchase invoice and the bill of supply decide RD/URD from the same
    // `cr` rule. Their own eligible-lot endpoints are therefore the reference:
    // whatever they consider purchasable must be what ptype=rd lists, and the
    // bills' side must be what ptype=urd lists.
    const elig = async (p) => {
      const r = await api('GET', p);
      if (r.status !== 200) return null;
      const d = r.d || {};
      const arr = d.lots || d.sellers || d.eligible || [];
      return Array.isArray(arr) ? arr : null;
    };
    const pur = await elig(`/api/purchases/eligible-sellers/${aid}`);
    const bil = await elig(`/api/bills/eligible-sellers/${aid}`);
    if (pur && bil) {
      const nameOf = (x) => String((x && (x.name || x.seller || x)) || '').trim().toUpperCase();
      const purNames = new Set(pur.map(nameOf).filter(Boolean));
      const bilNames = new Set(bil.map(nameOf).filter(Boolean));
      const rdNames = new Set((rd.d.lots || []).map(l => String(l.name || '').trim().toUpperCase()));
      const urdNames = new Set((urd.d.lots || []).map(l => String(l.name || '').trim().toUpperCase()));
      check('every seller the PURCHASE invoices consider eligible is in ptype=rd',
        [...purNames].every(n => rdNames.has(n)),
        `purchase: ${[...purNames].join(' | ')}  vs  rd: ${[...rdNames].join(' | ')}`);
      check('every seller the BILLS of supply consider eligible is in ptype=urd',
        [...bilNames].every(n => urdNames.has(n)),
        `bills: ${[...bilNames].join(' | ')}  vs  urd: ${[...urdNames].join(' | ')}`);
      check('and neither set bleeds into the other',
        ![...purNames].some(n => urdNames.has(n)) && ![...bilNames].some(n => rdNames.has(n)));
    } else {
      // Endpoint names differ across builds; fall back to asserting the rule
      // directly rather than silently skipping it.
      const { hasValidGstin } = require(path.join(ROOT, 'calculations'));
      check('(fallback) the rule matches calculations.hasValidGstin for every seller',
        SELLERS.every(s => hasValidGstin(s.cr) === s.rd),
        SELLERS.map(s => `${s.name}=${hasValidGstin(s.cr)}/${s.rd}`).join(' '));
    }
  }

  console.log('[badge] every row says which side it is on');
  {
    const all = await search('link=all&ptype=all');
    const rows = all.d.lots || [];
    check('is_rd is present on every row', rows.every(l => l.is_rd === 0 || l.is_rd === 1),
      JSON.stringify(rows.map(l => [l.lot_no, l.is_rd])));
    check('…and it matches the fixture', rows.every(l => !!l.is_rd === !!lotOf[String(l.lot_no).trim()].rd),
      JSON.stringify(rows.map(l => [l.lot_no, l.is_rd])));
    check('a narrowed listing still carries it',
      (urd.d.lots || []).every(l => l.is_rd === 0));
  }

  console.log('[why] a lot the filter excluded explains itself');
  {
    // Lot 4 is a URD lot; asking for it under ptype=rd must say so rather
    // than blame the bank-account toggle.
    const r = await search('link=all&ptype=rd&lots=4');
    const m = (r.d.missing || []).find(x => String(x.lot) === '4');
    check('the excluded lot is reported missing', !!m, JSON.stringify(r.d.missing));
    check('…with reason ptype_filter, not link_filter',
      m && m.reason === 'ptype_filter', m && m.reason);
    check('…naming the side it is actually on', m && m.ptype === 'urd' && m.wanted === 'rd',
      m && JSON.stringify(m));
    // And the mirror case.
    const r2 = await search('link=all&ptype=urd&lots=1');
    const m2 = (r2.d.missing || []).find(x => String(x.lot) === '1');
    check('the mirror case reports rd', m2 && m2.reason === 'ptype_filter' && m2.ptype === 'rd',
      m2 && JSON.stringify(m2));
    // A lot that IS on the asked-for side must not be reported at all.
    const r3 = await search('link=all&ptype=rd&lots=1');
    check('a lot on the asked-for side is not reported missing',
      !(r3.d.missing || []).some(x => String(x.lot) === '1'), JSON.stringify(r3.d.missing));
  }

  console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} ok, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
