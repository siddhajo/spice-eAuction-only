// Two master-data features, both driven over the real API.
//
// [1] CONSIGNEE SBL + PAN. The ship-to party on a buyer is often a different
//     legal entity from the buyer, so it carries its own statutory ids. They
//     round-trip through the buyer master and print in the sales invoice's
//     "Details of the Consignee (Shipped To)" block — never falling back to
//     the buyer's own PAN/SBL, which would put one party's identifiers under
//     another party's name.
//
// [2] "WHO IS MISSING WHAT". Sellers and Buyers accept ?missing=<key> and
//     return per-key counts with every page, so the office can see how many
//     masters have no bank account / PAN / GSTIN and work through exactly
//     those rows. The counts must come from the whole searched set, not the
//     page — the bug this guards against is a count that silently means
//     "…of the 50 rows on screen".
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'consignee-'));
const PORT = 47373;
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
async function text(url) {
  const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: r.status, body: await r.text() };
}
const rowsOf = (d) => Array.isArray(d) ? d : ((d && d.rows) || []);

// The parties table is one heading row (two labels) followed by one data row
// holding the Billed-To and Shipped-To cells. Splitting the page on the
// "Details of the Consignee" heading puts BOTH cells on the same side of the
// split, so the two blocks have to be separated structurally: walk the data
// row and return its TOP-LEVEL <td>s, ignoring the nested key/value tables
// each cell contains.
function partyCells(html) {
  // Depth-aware on BOTH levels: a lazy /<table class="parties">(.*?)<\/table>/
  // stops at the first NESTED </table> — the key/value table inside the first
  // cell — silently truncating the block before the identifiers we're checking.
  const open = html.search(/<table class="parties">/);
  if (open < 0) return [];
  let td = 0, end = -1;
  const tRe = /<(\/?)table\b[^>]*>/gi;
  tRe.lastIndex = open;
  let t;
  while ((t = tRe.exec(html))) {
    td += t[1] ? -1 : 1;
    if (td === 0) { end = t.index; break; }
  }
  if (end < 0) return [];
  const tbl = [null, html.slice(open, end)];
  // Scan the WHOLE table, not a <tr>-split of it: each cell embeds a nested
  // key/value <table> whose own <tr>s would shred a row-wise split. Depth
  // tracking skips those, leaving four top-level cells — two heading labels
  // then the two party blocks, which are the last two.
  const body = tbl[1];
  const cells = [];
  let depth = 0, start = -1;
  const tagRe = /<(\/?)td\b[^>]*>/gi;
  let mm;
  while ((mm = tagRe.exec(body))) {
    if (!mm[1]) {                       // <td>
      if (depth === 0) start = mm.index + mm[0].length;
      depth++;
    } else {                            // </td>
      depth--;
      if (depth === 0 && start >= 0) { cells.push(body.slice(start, mm.index)); start = -1; }
    }
  }
  return cells.slice(-2);          // [Billed-To, Shipped-To]
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const done = c => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(c);
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  // ──────────────────────────────────────────────────────────
  console.log('[1] Consignee SBL + PAN');

  const CONS = {
    buyer: 'CON1', buyer1: 'CONSIGNEE TEST BUYER', pan: 'AAAAA1111A', sbl: 'BUYERSBL',
    gstin: '33AAAAA1111A1Z5', add1: '1 BUYER STREET', pla: 'BODINAYAKANUR', pin: '625513',
    state: 'TAMIL NADU', st_code: '33', tel: '9876543210', sale: 'L',
    cbuyer1: 'SHIP TO WAREHOUSE', cadd1: '9 GODOWN ROAD', cpla: 'MUNNAR', cpin: '685612',
    cstate: 'KERALA', cst_code: '32', cgstin: '32BBBBB2222B1Z3',
    csbl: 'CONSBL99', cpan: 'BBBBB2222B',
  };
  const created = await api('POST', '/api/buyers', CONS);
  check('buyer with consignee SBL + PAN saves', created.status < 300, JSON.stringify(created.d));

  let list = await api('GET', '/api/buyers?search=CON1');
  let saved = rowsOf(list.d).find(b => b.buyer === 'CON1') || {};
  check('csbl round-trips', saved.csbl === 'CONSBL99', `got ${JSON.stringify(saved.csbl)}`);
  check('cpan round-trips', saved.cpan === 'BBBBB2222B', `got ${JSON.stringify(saved.cpan)}`);
  check('consignee ids are NOT the buyer\'s own', saved.csbl !== saved.sbl && saved.cpan !== saved.pan);

  // Uppercase rule: the consignee ids are statutory identifiers and follow the
  // same party-case rule as every other one (party-case.js BUYER_UPPER).
  const lowered = await api('PUT', `/api/buyers/${saved.id}`, Object.assign({}, CONS, { csbl: 'lower9', cpan: 'ccccc3333c' }));
  check('edit saves', lowered.status < 300, JSON.stringify(lowered.d));
  list = await api('GET', '/api/buyers?search=CON1');
  saved = rowsOf(list.d).find(b => b.buyer === 'CON1') || {};
  check('csbl is upper-cased on write', saved.csbl === 'LOWER9', `got ${JSON.stringify(saved.csbl)}`);
  check('cpan is upper-cased on write', saved.cpan === 'CCCCC3333C', `got ${JSON.stringify(saved.cpan)}`);

  // Put them back for the invoice assertions.
  await api('PUT', `/api/buyers/${saved.id}`, CONS);

  // ── The printed invoice ──
  // The LETTERHEAD template is the one carrying the "Details of the Consignee
  // (Shipped To)" heading with PAN/SBL columns (classic and modern print only
  // GSTIN, for both parties alike — so there is nothing to wire there).
  // ?template= pins it so the test doesn't ride on the install's default.
  const TPL = '&template=letterhead';

  const auc = await api('POST', '/api/auctions', { ano: '90', date: '2026-09-13', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const lr = await api('POST', '/api/lots', { auction_id: aid, lot_no: '1', name: 'SELLER ONE', qty: 100 });
  const lid = lr.d.id || (lr.d.lot && lr.d.lot.id);
  await api('PUT', `/api/lots/${lid}`, { buyer: 'CON1', buyer1: 'CONSIGNEE TEST BUYER', price: 1000, amount: 100000, bags: 5, sale: 'L' });

  const prev = await text(`/api/invoices/preview.html?auctionId=${aid}&buyer=CON1&sale=L${TPL}`);
  check('invoice preview renders', prev.status === 200 && /Consignee/i.test(prev.body),
    `${prev.status} ${prev.body.slice(0, 300)}`);
  const cells = partyCells(prev.body);
  check('the parties table has a Billed-To and a Shipped-To cell', cells.length === 2, `got ${cells.length}`);
  const [billHalf, shipHalf] = [cells[0] || '', cells[1] || ''];
  check('consignee PAN prints in the Shipped-To block', shipHalf.includes('BBBBB2222B'), shipHalf);
  check('consignee SBL prints in the Shipped-To block', shipHalf.includes('CONSBL99'), shipHalf);
  check('the Shipped-To block carries the consignee\'s name, not the buyer\'s',
    shipHalf.includes('SHIP TO WAREHOUSE'), shipHalf);
  // The whole point: one party's statutory ids must never print under the
  // other party's name.
  check('the consignee block does NOT carry the buyer\'s own SBL', !shipHalf.includes('BUYERSBL'), shipHalf);
  check('the consignee block does NOT carry the buyer\'s own PAN', !shipHalf.includes('AAAAA1111A'), shipHalf);
  check('billed-to still shows the buyer\'s own PAN + SBL',
    billHalf.includes('AAAAA1111A') && billHalf.includes('BUYERSBL'), billHalf);
  check('billed-to is NOT contaminated by the consignee ids',
    !billHalf.includes('BBBBB2222B') && !billHalf.includes('CONSBL99'), billHalf);

  // A buyer with NO consignee mirrors bill-to, so blank consignee ids must not
  // blank the printed identifiers.
  await api('POST', '/api/buyers', {
    buyer: 'NOCON', buyer1: 'NO CONSIGNEE BUYER', pan: 'DDDDD4444D', sbl: 'OWNSBL',
    gstin: '33DDDDD4444D1Z9', add1: '2 MAIN ROAD', pla: 'THENI', pin: '625531',
    state: 'TAMIL NADU', st_code: '33', sale: 'L',
  });
  const lr2 = await api('POST', '/api/lots', { auction_id: aid, lot_no: '2', name: 'SELLER TWO', qty: 100 });
  const lid2 = lr2.d.id || (lr2.d.lot && lr2.d.lot.id);
  await api('PUT', `/api/lots/${lid2}`, { buyer: 'NOCON', buyer1: 'NO CONSIGNEE BUYER', price: 1000, amount: 100000, bags: 5, sale: 'L' });
  const prev2 = await text(`/api/invoices/preview.html?auctionId=${aid}&buyer=NOCON&sale=L${TPL}`);
  const shipHalf2 = partyCells(prev2.body)[1] || '';
  check('no consignee on file → Shipped-To mirrors the buyer, ids and all',
    shipHalf2.includes('DDDDD4444D') && shipHalf2.includes('OWNSBL'), shipHalf2);

  // ──────────────────────────────────────────────────────────
  console.log('\n[2] Missing-details filter — Sellers');

  // 4 sellers, each incomplete in a different way; one complete.
  const mk = (t) => api('POST', '/api/traders', t);
  await mk({ name: 'COMPLETE SELLER', cr: '33AAAAA0000A1Z1', pan: 'AAAAA0000A', tel: '9000000001',
             padd: '1 ST', ppla: 'THENI', pin: '625531', aadhar: '111122223333',
             banks: [{ bank_name: 'SBI', ifsc: 'SBIN0000001', acctnum: '111111111', holder_name: 'COMPLETE SELLER' }] });
  await mk({ name: 'NO BANK SELLER', cr: '33BBBBB0000B1Z1', pan: 'BBBBB0000B', tel: '9000000002',
             padd: '2 ST', ppla: 'THENI', pin: '625531', aadhar: '222233334444' });
  await mk({ name: 'NO PAN SELLER', cr: '33CCCCC0000C1Z1', pan: '', tel: '9000000003',
             padd: '3 ST', ppla: 'THENI', pin: '625531', aadhar: '333344445555',
             banks: [{ bank_name: 'SBI', ifsc: 'SBIN0000001', acctnum: '333333333', holder_name: 'NO PAN SELLER' }] });
  await mk({ name: 'NO PHONE SELLER', cr: '33DDDDD0000D1Z1', pan: 'DDDDD0000D', tel: '',
             padd: '4 ST', ppla: 'THENI', pin: '625531', aadhar: '444455556666',
             banks: [{ bank_name: 'SBI', ifsc: 'SBIN0000001', acctnum: '444444444', holder_name: 'NO PHONE SELLER' }] });

  const all = await api('GET', '/api/traders?page=1&pageSize=50');
  const m = all.d && all.d.missing;
  check('the page carries a missing-count object', !!m, JSON.stringify(all.d && Object.keys(all.d || {})));
  check('counts every seller, not just the page', m && m.total === 4, JSON.stringify(m));
  check('no-bank count is right', m && m.bank === 1, JSON.stringify(m));
  check('no-PAN count is right', m && m.pan === 1, JSON.stringify(m));
  check('no-phone count is right', m && m.phone === 1, JSON.stringify(m));
  check('"any" counts a row once, not once per gap', m && m.any === 3, JSON.stringify(m));

  const noBank = await api('GET', '/api/traders?page=1&pageSize=50&missing=bank');
  check('?missing=bank narrows to the one seller', rowsOf(noBank.d).length === 1 && noBank.d.total === 1,
    JSON.stringify(rowsOf(noBank.d).map(r => r.name)));
  check('and it is the right one', (rowsOf(noBank.d)[0] || {}).name === 'NO BANK SELLER');
  check('the counts stay whole-table while filtered — the chips must not collapse',
    noBank.d.missing && noBank.d.missing.total === 4 && noBank.d.missing.pan === 1,
    JSON.stringify(noBank.d.missing));

  const anyMiss = await api('GET', '/api/traders?page=1&pageSize=50&missing=any');
  check('?missing=any returns every incomplete seller', anyMiss.d.total === 3,
    JSON.stringify(rowsOf(anyMiss.d).map(r => r.name)));
  check('the complete seller is excluded',
    !rowsOf(anyMiss.d).some(r => r.name === 'COMPLETE SELLER'));

  // A bank ROW with no account number is still unpayable.
  const nb = rowsOf(noBank.d)[0];
  await api('PUT', `/api/traders/${nb.id}`, Object.assign({}, nb, {
    banks: [{ bank_name: 'SBI', ifsc: 'SBIN0000001', acctnum: '', holder_name: 'NO BANK SELLER' }] }));
  const stillNoBank = await api('GET', '/api/traders?page=1&pageSize=50&missing=bank');
  check('a bank row with a blank account number still counts as missing',
    stillNoBank.d.total === 1, JSON.stringify(rowsOf(stillNoBank.d).map(r => r.name)));

  // Search + filter compose.
  const combo = await api('GET', '/api/traders?page=1&pageSize=50&search=SELLER&missing=pan');
  check('search AND missing compose', combo.d.total === 1 && rowsOf(combo.d)[0].name === 'NO PAN SELLER',
    JSON.stringify(rowsOf(combo.d).map(r => r.name)));
  const comboNone = await api('GET', '/api/traders?page=1&pageSize=50&search=COMPLETE&missing=pan');
  check('a search that matches only complete rows yields none', comboNone.d.total === 0);
  check('counts follow the SEARCH, not the whole table, when a search is active',
    comboNone.d.missing && comboNone.d.missing.total === 1 && comboNone.d.missing.any === 0,
    JSON.stringify(comboNone.d.missing));

  // Junk / unknown keys must not error or silently return nothing.
  const junk = await api('GET', '/api/traders?page=1&pageSize=50&missing=notafield');
  check('an unknown missing key falls back to the full list', junk.status === 200 && junk.d.total === 4,
    `${junk.status} ${JSON.stringify(junk.d && junk.d.total)}`);

  console.log('\n[3] Missing-details filter — Buyers');
  const bAll = await api('GET', '/api/buyers?page=1&pageSize=50');
  const bm = bAll.d && bAll.d.missing;
  check('buyers carry a missing-count object', !!bm, JSON.stringify(bm));
  check('buyers total is right', bm && bm.total === 2, JSON.stringify(bm));
  // NOCON has no tel; CON1 has one.
  check('buyer no-phone count is right', bm && bm.phone === 1, JSON.stringify(bm));
  const bNoPhone = await api('GET', '/api/buyers?page=1&pageSize=50&missing=phone');
  check('?missing=phone narrows buyers', bNoPhone.d.total === 1 && rowsOf(bNoPhone.d)[0].buyer === 'NOCON',
    JSON.stringify(rowsOf(bNoPhone.d).map(r => r.buyer)));
  check('every buyer has an SBL here, so that chip would not render',
    bm && bm.sbl === 0, JSON.stringify(bm));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); done(1); });
