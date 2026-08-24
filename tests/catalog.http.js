// DOCUMENT CATALOG — manifest integrity + live gating.
//
// document-catalog.js describes 60-odd downloadable artefacts by pointing at
// routes it does not own. Nothing stops that manifest drifting from reality:
// rename a route, drop an export, retire a feature flag, and the catalog goes
// on advertising a tile that 404s. Two halves guard against that:
//
//   [static]  every `route` in the manifest is a route server.js actually
//             registers, every `flag` is a real setting, every entry is
//             internally coherent (unique id, real group, formats, builder).
//   [live]    the resolved endpoint gates the way the sidebar does — locked
//             by permission, then by "no trade", then by guided stage — and
//             a flagged-off document is absent rather than merely greyed.
//
// The static half is the one that pays for itself: it is the first check in
// this codebase that can prove no export has been orphaned.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
const PORT = 47331;
const B = `http://127.0.0.1:${PORT}`;

const { DOCUMENTS, GROUPS } = require(path.join(ROOT, 'document-catalog'));
const { DEFAULTS } = require(path.join(ROOT, 'company-config'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function setFlag(key, val) {
  const r = await api('PUT', '/api/company-settings', { settings: { [key]: String(val) } });
  if (r.status !== 200) throw new Error(`could not set ${key}: ${r.status} ${JSON.stringify(r.d)}`);
}
// Flatten the grouped response into one id → item map.
const flatten = (d) => {
  const out = {};
  for (const g of (d && d.groups) || []) for (const it of g.items) out[it.id] = it;
  return out;
};

// ══ STATIC HALF — manifest integrity, no server needed ══════════════
console.log('[static] manifest integrity');

// Every route pattern the manifest claims, harvested from server.js source.
// Static extraction rather than introspecting a booted Express router: it
// needs no DB, runs instantly, and fails with the offending string rather
// than a stack trace.
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const REGISTERED = new Set(
  [...SERVER_SRC.matchAll(/app\.(?:get|post|put|delete)\(\s*'([^']+)'/g)].map(m => m[1])
);
check('harvested a plausible number of routes from server.js', REGISTERED.size > 150,
      `found ${REGISTERED.size}`);

const missing = DOCUMENTS.filter(d => !REGISTERED.has(d.route));
check('every manifest route is registered in server.js', missing.length === 0,
      missing.map(d => `${d.id} → ${d.route}`).join('\n         '));

const bulkMissing = DOCUMENTS.filter(d => d.bulkRoute && !REGISTERED.has(d.bulkRoute));
check('every bulkRoute is registered in server.js', bulkMissing.length === 0,
      bulkMissing.map(d => `${d.id} → ${d.bulkRoute}`).join('\n         '));

const listMissing = DOCUMENTS.filter(d => d.listRoute && !REGISTERED.has(d.listRoute));
check('every listRoute is registered in server.js', listMissing.length === 0,
      listMissing.map(d => `${d.id} → ${d.listRoute}`).join('\n         '));

const halfBulk = DOCUMENTS.filter(d => !!d.bulkRoute !== !!d.listRoute);
check('bulkRoute and listRoute are declared together or not at all',
      halfBulk.length === 0,
      halfBulk.map(d => `${d.id} has only one of the pair`).join(', '));

const badListParam = DOCUMENTS.filter(d => d.listRoute
  && !['auction_id', 'ano'].includes(d.listParam));
check('every listParam is auction_id or ano', badListParam.length === 0,
      badListParam.map(d => `${d.id} → ${d.listParam}`).join(', '));

const SETTING_KEYS = new Set(DEFAULTS.map(d => d.key));
const badFlags = DOCUMENTS.filter(d => d.flag && !SETTING_KEYS.has(d.flag));
check('every flag is a real company setting', badFlags.length === 0,
      badFlags.map(d => `${d.id} → ${d.flag}`).join('\n         '));

const ids = DOCUMENTS.map(d => d.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
check('ids are unique', dupes.length === 0, dupes.join(', '));

const GROUP_IDS = new Set(GROUPS.map(g => g.id));
const orphanGroup = DOCUMENTS.filter(d => !GROUP_IDS.has(d.group));
check('every entry lands in a declared group', orphanGroup.length === 0,
      orphanGroup.map(d => `${d.id} → ${d.group}`).join('\n         '));

const noFormats = DOCUMENTS.filter(d => !Array.isArray(d.formats) || !d.formats.length);
check('every entry declares at least one format', noFormats.length === 0,
      noFormats.map(d => d.id).join(', '));

const badScope = DOCUMENTS.filter(d => !['trade', 'dateRange', 'master'].includes(d.scope));
check('every scope is one of trade/dateRange/master', badScope.length === 0,
      badScope.map(d => `${d.id} → ${d.scope}`).join(', '));

const badPerm = DOCUMENTS.filter(d => !['view', 'export'].includes(d.perm));
check('every perm is view or export', badPerm.length === 0,
      badPerm.map(d => `${d.id} → ${d.perm}`).join(', '));

// kind:'export' is downloaded straight from an href; kind:'document' is
// generated elsewhere and only needs a deep-link.
const noHref = DOCUMENTS.filter(d => d.kind === 'export' && typeof d.href !== 'function');
check('every export entry has an href builder', noHref.length === 0,
      noHref.map(d => d.id).join(', '));
const noLink = DOCUMENTS.filter(d => d.kind === 'document' && !d.deepLink);
check('every document entry has a deepLink', noLink.length === 0,
      noLink.map(d => d.id).join(', '));

// href() must actually produce the format it advertises, and must not leave
// an unsubstituted placeholder behind.
const badUrl = [];
for (const d of DOCUMENTS) {
  if (typeof d.href !== 'function') continue;
  for (const fmt of d.formats) {
    let u;
    try { u = d.href({ auctionId: 13, ano: '13', from: '2026-01-01', to: '2026-12-31' }, fmt); }
    catch (e) { badUrl.push(`${d.id}/${fmt} threw ${e.message}`); continue; }
    if (!u || !u.startsWith('/api/')) badUrl.push(`${d.id}/${fmt} → ${u}`);
    else if (/:[a-zA-Z]/.test(u))     badUrl.push(`${d.id}/${fmt} left a placeholder → ${u}`);
    else if (/undefined|\[object/.test(u)) badUrl.push(`${d.id}/${fmt} → ${u}`);
  }
}
check('every href builds a clean /api URL for each declared format', badUrl.length === 0,
      badUrl.join('\n         '));

// The manifest is the union of the five registries — so every key in each
// registry must be reachable through some entry's URL. This is the check
// that catches an export being added to a registry and never surfacing.
const urlsOf = (d) => ((typeof d.href === 'function')
  ? d.formats.map(f => { try { return d.href({ auctionId: 1, from: 'a', to: 'b' }, f); } catch (_) { return ''; } })
  : [d.route, d.bulkRoute].filter(Boolean)
).concat(d.alsoCovers || []);
const ALL_URLS = DOCUMENTS.flatMap(urlsOf).join('\n');
for (const [regName, regPath, prefix] of [
  ['EXPORT_TYPES',        'exports',              '/api/exports/'],
  ['DBF_EXPORTS',         'dbf-exports',          '/api/dbf-exports/'],
  ['SPICE_BOARD REPORTS', 'spice-board-reports',  '/api/spice-board-reports/'],
  ['LORRY REPORTS',       'lorry-reports',        '/api/lorry-reports/'],
]) {
  const mod = require(path.join(ROOT, regPath));
  const reg = mod.EXPORT_TYPES || mod.DBF_EXPORTS || mod.REPORTS;
  const orphans = Object.keys(reg).filter(k => !ALL_URLS.includes(prefix + k));
  check(`every ${regName} key is reachable from the catalog`, orphans.length === 0,
        `unreachable: ${orphans.join(', ')}`);
}
// TALLY_EXPORTS lives inline in server.js, so read its keys from source.
{
  const block = SERVER_SRC.match(/const TALLY_EXPORTS = \{([\s\S]*?)\n\};/);
  const keys = block ? [...block[1].matchAll(/^\s{2}([a-z_0-9]+):\s/gm)].map(m => m[1]) : [];
  const orphans = keys.filter(k => !ALL_URLS.includes('/api/tally/export/' + k));
  check('every TALLY_EXPORTS key is reachable from the catalog',
        keys.length >= 10 && orphans.length === 0,
        `found ${keys.length} keys; unreachable: ${orphans.join(', ')}`);
}

// ══ LIVE HALF — the resolved endpoint ═══════════════════════════════
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

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); }
  console.log('\n[live] resolved catalog');

  // ── No trade selected ────────────────────────────────────────────
  const bare = await api('GET', '/api/documents/catalog');
  check('catalog responds without a trade', bare.status === 200, JSON.stringify(bare.d).slice(0, 300));
  const bareItems = flatten(bare.d);
  check('master-scope documents are usable with no trade',
        bareItems.master_sellers && bareItems.master_sellers.available === true,
        JSON.stringify(bareItems.master_sellers));
  check('auction-scope documents are locked with a reason',
        bareItems.trade_report && bareItems.trade_report.lockedBy === 'trade'
          && !!bareItems.trade_report.lockReason,
        JSON.stringify(bareItems.trade_report));
  check('a locked tile carries no href', bareItems.trade_report && !bareItems.trade_report.href);

  // ── Stage 2: a trade with lots but no prices ─────────────────────
  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-12', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  if (!aid) { console.error('auction create failed', auc.status, auc.d); cleanup(); process.exit(1); }
  const mkLot = (lot_no, name, qty) => api('POST', '/api/lots',
    { auction_id: aid, lot_no, name, qty, grade: '1', bags: 8, crop: 'CARDAMOM' });
  const l1 = await mkLot('201', 'RAMU PLANTER', 100);
  await mkLot('202', 'SELVI PLANTER', 300);
  const lotId = l1.d && (l1.d.id || (l1.d.lot && l1.d.lot.id));

  let d = (await api('GET', `/api/documents/catalog?auctionId=${aid}`)).d;
  let items = flatten(d);
  check('stage is 2 with lots but no prices', d.stage === 2, `stage ${d.stage}`);
  check('KPI counts the allocated lots', d.kpi && d.kpi.allocatedLots === 2, JSON.stringify(d.kpi));
  check('KPI reports both lots withdrawn while unpriced',
        d.kpi && d.kpi.soldLots === 0 && d.kpi.withdrawnLots === 2, JSON.stringify(d.kpi));
  // Both lots were created with a seller NAME and no trader_id — a plain
  // COUNT(DISTINCT trader_id) would call that zero sellers.
  check('KPI counts sellers that have no master link yet',
        d.kpi && d.kpi.sellers === 2, JSON.stringify(d.kpi));
  check('KPI does not count an unset buyer as a buyer',
        d.kpi && d.kpi.buyers === 0, JSON.stringify(d.kpi));
  check('pre-auction exports are live at stage 2',
        items.lot_slip && items.lot_slip.available === true, JSON.stringify(items.lot_slip));
  check('pre-auction href carries the trade and format',
        items.lot_slip && items.lot_slip.href.xlsx === `/api/exports/lot_slip/${aid}?format=xlsx`,
        items.lot_slip && JSON.stringify(items.lot_slip.href));
  check('Export Center reports are stage-locked at stage 2',
        items.trade_report && items.trade_report.lockedBy === 'stage',
        JSON.stringify(items.trade_report));
  check('the stage lock explains itself',
        items.trade_report && /price/i.test(items.trade_report.lockReason || ''),
        items.trade_report && items.trade_report.lockReason);
  check('Tally XML is locked until a document exists',
        items.tally_sales_isp && items.tally_sales_isp.lockedBy === 'stage',
        JSON.stringify(items.tally_sales_isp));

  // ── Stage 3: price a lot ─────────────────────────────────────────
  await api('PUT', `/api/lots/${lotId}`, { price: 400, amount: 40000 });
  d = (await api('GET', `/api/documents/catalog?auctionId=${aid}`)).d;
  items = flatten(d);
  check('stage climbs to 3 once a lot is priced', d.stage === 3, `stage ${d.stage}`);
  check('Export Center unlocks at stage 3',
        items.trade_report && items.trade_report.available === true,
        JSON.stringify(items.trade_report));
  check('KPI picks up the sold lot and its value',
        d.kpi && d.kpi.soldLots === 1 && d.kpi.soldWeight === 100 && d.kpi.totalValue === 40000,
        JSON.stringify(d.kpi));
  check('Tally is still locked — no document generated yet',
        items.tally_sales_isp && items.tally_sales_isp.lockedBy === 'stage');
  check('document tiles report generation status',
        items.bills && items.bills.status && items.bills.status.generated === 0
          && items.bills.status.pending > 0,
        JSON.stringify(items.bills && items.bills.status));
  check('a document tile deep-links to the screen that generates it',
        items.bills && items.bills.deepLink === 'bills');
  check('a document tile carries the list URL its bulk PDF needs',
        items.bills && items.bills.listUrl === `/api/bills?auction_id=${aid}`,
        items.bills && items.bills.listUrl);
  // Planter debit notes are flagged off by default, so switch the feature on
  // to reach the tile at all. The point of the check is the list URL: this
  // is the one family keyed by `ano` rather than auction_id.
  await setFlag('flag_debit_note_planter', 'true');
  const dnp = flatten((await api('GET', `/api/documents/catalog?auctionId=${aid}`)).d)
    .debit_notes_planter;
  check('planter debit notes list by ano, not auction_id',
        dnp && dnp.listUrl === '/api/debit-notes-planter?ano=9',
        dnp && dnp.listUrl);
  check('payments offers no bulk button — its bulk needs the seller picker',
        items.payments && !items.payments.bulkRoute && items.payments.deepLink === 'payments',
        JSON.stringify(items.payments));

  // ── Flag gating: absent, not greyed ──────────────────────────────
  await setFlag('flag_debit_note', 'false');
  items = flatten((await api('GET', `/api/documents/catalog?auctionId=${aid}`)).d);
  check('a flagged-off document is absent entirely', !items.debit_notes,
        items.debit_notes && JSON.stringify(items.debit_notes));
  check('its Tally counterpart is absent too', !items.tally_debit_note);
  // The DBF group is hidden from the hub entirely, so its debit-note
  // module is absent whatever the flag says — worth pinning so a future
  // un-hide doesn't quietly re-expose a flagged-off document.
  check('the hidden DBF module never appears either way', !items.dbf_debit_notes);
  await setFlag('flag_debit_note', 'true');
  items = flatten((await api('GET', `/api/documents/catalog?auctionId=${aid}`)).d);
  check('flagging it back on restores both visible tiles',
        !!items.debit_notes && !!items.tally_debit_note && !items.dbf_debit_notes);

  // ── Stage 4: generate a document ─────────────────────────────────
  const gen = await api('POST', `/api/bills/generate-all/${aid}`, { startBillNo: 1 });
  if (gen.status < 300) {
    d = (await api('GET', `/api/documents/catalog?auctionId=${aid}`)).d;
    items = flatten(d);
    check('stage climbs to 4 once a document exists', d.stage === 4, `stage ${d.stage}`);
    check('Tally XML unlocks at stage 4',
          items.tally_sales_isp && items.tally_sales_isp.available === true,
          JSON.stringify(items.tally_sales_isp));
    check('Tally href points at the real export route',
          items.tally_sales_isp
            && items.tally_sales_isp.href.xml === `/api/tally/export/sales_isp/${aid}`,
          items.tally_sales_isp && JSON.stringify(items.tally_sales_isp.href));
    check('bills status now reports generated documents',
          items.bills && items.bills.status && items.bills.status.generated > 0,
          JSON.stringify(items.bills && items.bills.status));
  } else {
    check('bills generate-all succeeded (needed for the stage-4 checks)', false,
          `${gen.status} ${JSON.stringify(gen.d)}`);
  }

  // ── Date-range documents ask for what they lack ──────────────────
  items = flatten((await api('GET', `/api/documents/catalog?auctionId=${aid}`)).d);
  check('a date-range document without dates advertises what it needs',
        items.tds_return && Array.isArray(items.tds_return.needs)
          && items.tds_return.needs.includes('from') && items.tds_return.needs.includes('to'),
        JSON.stringify(items.tds_return));
  items = flatten((await api('GET',
    `/api/documents/catalog?auctionId=${aid}&from=2026-04-01&to=2027-03-31`)).d);
  check('supplying the dates makes it available',
        items.tds_return && items.tds_return.available === true
          && items.tds_return.href.xlsx.includes('from=2026-04-01'),
        JSON.stringify(items.tds_return));

  // ── The legacy alias stays callable but never renders ────────────
  check('hidden entries are not rendered as tiles', !items.tally_sales,
        JSON.stringify(items.tally_sales));

  // ── The four exports this test found dead, now fixed ─────────────
  // The href sweep below proves they no longer 500. This proves the one
  // the fixture carries data for actually produces a file: the trade has a
  // priced planter lot, which is exactly what Tally Purchase reports on.
  {
    const r = await fetch(B + items.tally_purchase.href.xlsx,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    check('Tally Purchase produces a real workbook (was: SQL syntax error)',
          r.status === 200 && buf.length > 2000 && buf.slice(0, 2).toString() === 'PK',
          `status ${r.status}, ${buf.length} bytes`);
  }
  // The ASP builders were `undefined` before the export fix, which 500d.
  // These two tiles are hidden (dual-company leftovers the Tally screen
  // never offered), so they are called by URL rather than looked up in the
  // catalog. With no sales invoices in this fixture the honest answer is a
  // 404 "no rows" — what matters is that the builder ran at all.
  for (const type of ['sales_asp', 'isp_purchase']) {
    const r = await fetch(B + `/api/tally/export/${type}/${aid}`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const body = await r.text();
    check(`tally ${type} reaches its builder (was: def.builder is not a function)`,
          r.status !== 500 && !/builder is not a function/.test(body),
          `status ${r.status} ${body.slice(0, 160)}`);
  }
  check('the dual-company ASP exports are not advertised as tiles',
        !items.tally_sales_asp && !items.tally_isp_purchase);

  // ── Tally's other two formats ────────────────────────────────────
  // Every Tally export also speaks JSON; two of them additionally speak
  // the GST portal's e-Invoice JSON. The hub advertised XML only until
  // this gap was spotted on a deployed build.
  // The route also answers ?format=json with raw rows; that is deliberately
  // not offered — it duplicates the XML for an audience nobody in the
  // office has. XML sends no format param at all.
  check('a plain Tally tile offers XML only',
        items.tally_ledger_sales.formats.join() === 'xml',
        items.tally_ledger_sales.formats.join());
  check('and XML carries no format param',
        items.tally_ledger_sales.href.xml === `/api/tally/export/ledger_sales/${aid}`,
        JSON.stringify(items.tally_ledger_sales.href));
  check('no tile anywhere still offers raw JSON',
        Object.values(items).every(i => !(i.formats || []).includes('json')),
        Object.values(items).filter(i => (i.formats || []).includes('json')).map(i => i.id).join(', '));
  check('operator-facing labels drop the ISP / Discount jargon',
        items.tally_sales_isp.label === 'Sales Vouchers'
          && items.tally_debit_note.label === 'Debit Notes',
        `${items.tally_sales_isp.label} | ${items.tally_debit_note.label}`);

  // ── Subgroups ────────────────────────────────────────────────────
  check('every visible document declares a subgroup',
        Object.values(items).every(i => !!i.sub),
        Object.values(items).filter(i => !i.sub).map(i => i.id).join(', '));
  {
    const tally = (d.groups.find(g => g.id === 'tally') || { items: [] }).items;
    const subs = [...new Set(tally.map(i => i.sub))];
    check('Tally splits into ledger masters and vouchers',
          subs.includes('Ledger masters') && subs.includes('Vouchers'), subs.join(', '));
  }

  // ── Per-document filters ─────────────────────────────────────────
  // The manifest must only claim filters the route actually reads.
  // A filter is only declared where the export FUNCTION applies it, not
  // merely where the route accepts it. exports.js reads extra.sellers in
  // four functions and never reads extra.branch or extra.saleType at all,
  // so a plain Export Center report offers no filters.
  check('a report whose export ignores filters offers none',
        !items.trade_report.filters, JSON.stringify(items.trade_report.filters));
  check('the four exports that DO read sellers offer it',
        ['bank_payment', 'bank_payment_before', 'payment', 'payment_party_wise']
          .every(id => (items[id].filters || []).includes('sellers')));
  check('Spice Board documents offer branch / seller / buyer',
        (items.form_d.filters || []).join() === 'branch,sellerId,buyerCode',
        JSON.stringify(items.form_d.filters));
  check('sale-type filtering is offered only where Tally accepts it',
        (items.tally_sales_isp.filters || []).includes('sale')
          && !(items.tally_rd_purchase.filters || []).includes('sale'),
        `sales=${items.tally_sales_isp.filters} rd=${items.tally_rd_purchase.filters}`);
  // …and the routes must accept them for real, not just in the manifest.
  // ── Filters that were asked for, and ones that were removed ──────
  check('the Spices Board CSV offers no filter',
        !items.eauction_csv.filters, JSON.stringify(items.eauction_csv.filters));
  // Merchants is gated by flag_merchants (off by default), so it is not in
  // the resolved catalog here — assert it from the manifest.
  check('nor does the consolidated Merchants journal',
        !DOCUMENTS.find(d => d.id === 'tally_merchants').filters);
  check('vouchers filter by party and invoice as well as sale type',
        ['sale', 'party', 'invoice'].every(k => (items.tally_sales_isp.filters || []).includes(k)),
        JSON.stringify(items.tally_sales_isp.filters));
  check('and the e-Invoice JSON rides the same invoice filter',
        items.tally_sales_isp.formats.includes('irp')
          && (items.tally_sales_isp.filters || []).includes('invoice'));
  check('party ledgers filter by party',
        (items.tally_ledger_sales.filters || []).includes('party')
          && (items.tally_ledger.filters || []).includes('party'));

  // Multi-value: which filters take a comma-joined list.
  check('Spice Board filters are all list-capable',
        (items.form_d.multi || []).join() === 'branch,sellerId,buyerCode',
        JSON.stringify(items.form_d.multi));
  check('so is the seller filter on payment exports',
        (items.payment.multi || []).includes('sellers'));
  check('and the Tally sale type', (items.tally_sales_isp.multi || []).includes('sale'));
  check('every multi entry is also a declared filter',
        Object.values(items).every(i => (i.multi || []).every(k => (i.filters || []).includes(k))));

  for (const [id, qs] of [
    ['form_d',  'branch=BODI'],
    ['form_d',  'sellerId=1,2,3'],
    ['form_c',  'buyerCode=AAA,BBB'],
    ['payment', 'sellers=RAMU%20PLANTER,SELVI%20PLANTER'],
  ]) {
    const url = items[id].href[items[id].formats[0]] + '&' + qs;
    const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    let body = ''; try { body = JSON.stringify(await r.json()); } catch (_) {}
    check(`${id} accepts ${qs.split('=')[0]} on the wire`,
          r.status < 500 && !/unknown|invalid/i.test(body), `${r.status} ${body.slice(0, 120)}`);
  }
  check('e-Invoice JSON is offered on exactly the two types that support it',
        items.tally_sales_isp.formats.includes('irp')
          && items.tally_debit_note.formats.includes('irp')
          && !items.tally_rd_purchase.formats.includes('irp')
          && !items.tally_ledger.formats.includes('irp'),
        `sales_isp=${items.tally_sales_isp.formats} rd=${items.tally_rd_purchase.formats}`);

  // ── Every advertised href actually resolves ──────────────────────
  // The static half proved the ROUTE exists; this proves the URL the catalog
  // BUILT is one the route accepts — the :type substituted correctly, no
  // required query param was dropped.
  //
  // A 404 alone does not mean the URL is wrong. Several exports answer 404
  // when the trade holds no rows of that kind ("No sales vouchers found for
  // auction 1") — which is a correct answer to a correct URL, and expected
  // here: the fixture only generates Bills of Supply, so there are no sales
  // invoices, RD purchases or debit notes to export. What WOULD indicate a
  // broken URL is the route rejecting the identifier or a missing parameter,
  // so only those bodies fail the check.
  // Exports known to be broken in the app, excluded so a pre-existing defect
  // doesn't mask a new one. The list is SELF-CLEANING: if an entry starts
  // working, the check below fails and tells you to delete it, so it can
  // only ever shrink.
  //
  // It started with four, all found by this check on its first run and all
  // pre-dating the catalog. All four are now fixed and removed:
  //   sales_taxes         `bags as bag` on a table whose column is `bag`
  //   tally_purchase      `padd as add` — ADD is a SQLite keyword
  //   tally_sales_asp     buildSalesAspRows defined but never exported
  //   tally_isp_purchase  same missing export
  const KNOWN_BROKEN = new Set([]);

  const REJECTED = /unknown|required|invalid|not a valid/i;
  const live = Object.values(items).filter(i => i.available && i.href);
  let bad = [], empty = 0, stillBroken = new Set();
  for (const it of live) {
    for (const [fmt, url] of Object.entries(it.href)) {
      const key = `${it.id}/${fmt}`;
      const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (r.status < 400) continue;
      let body = ''; try { body = JSON.stringify(await r.json()); } catch (_) {}
      if (r.status >= 500 || REJECTED.test(body)) {
        if (KNOWN_BROKEN.has(key)) stillBroken.add(key);
        else bad.push(`${key} → ${r.status} ${url}\n         ${body}`);
      } else empty++;   // legitimate "no rows of this kind in this trade"
    }
  }
  check(`all ${live.length} available hrefs are accepted by their route`
        + ` (${KNOWN_BROKEN.size} known-broken excluded)`, bad.length === 0,
        bad.join('\n         '));
  const fixed = [...KNOWN_BROKEN].filter(k => !stillBroken.has(k));
  check('the known-broken list is still accurate', fixed.length === 0,
        `these now work — delete them from KNOWN_BROKEN: ${fixed.join(', ')}`);
  console.log(`         (${empty} answered "no rows for this trade" — expected for this fixture)`);

  // ══ BUNDLE — tick N documents, get one ZIP ════════════════════════
  console.log('\n[bundle]');
  const poll = async (jobId) => {
    for (let i = 0; i < 200; i++) {
      const s = await api('GET', `/api/documents/bundle/${jobId}`);
      if (s.d && s.d.status !== 'running') return s.d;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  };

  {
    const items = [{ id: 'lot_slip', format: 'xlsx' }, { id: 'lot_name', format: 'xlsx' },
                   { id: 'dealer_list', format: 'xlsx' }];
    const started = await api('POST', '/api/documents/bundle', { auctionId: aid, items });
    check('bundle starts and reports its size',
          started.status === 200 && started.d.jobId && started.d.total === 3,
          JSON.stringify(started.d));
    const done = await poll(started.d.jobId);
    check('bundle finishes', done && done.status === 'done', JSON.stringify(done));
    check('every requested document made it in', done && done.files === 3 && done.done === 3,
          JSON.stringify(done));

    const r = await fetch(B + `/api/documents/bundle/${started.d.jobId}/file`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const buf = Buffer.from(await r.arrayBuffer());
    check('the ZIP downloads', r.status === 200 && buf.slice(0, 2).toString() === 'PK',
          `status ${r.status}, ${buf.length} bytes`);
    check('it is named after the trade',
          /Auction_9_Documents\.zip/.test(r.headers.get('content-disposition') || ''),
          r.headers.get('content-disposition'));
    // Central-directory entry names are readable without unzipping.
    const asText = buf.toString('latin1');
    check('it holds one entry per document',
          /LotSlip/i.test(asText) && /LotName/i.test(asText) && /DealerList/i.test(asText),
          asText.slice(0, 200).replace(/[^\x20-\x7e]/g, '.'));

    // A bundle is collected once — it is a temp artefact, not storage.
    const again = await fetch(B + `/api/documents/bundle/${started.d.jobId}/file`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    check('collecting it twice is refused', again.status === 404 || again.status === 410,
          `status ${again.status}`);
  }

  // A document with nothing to report must not sink the whole bundle.
  {
    const items = [{ id: 'lot_slip', format: 'xlsx' }, { id: 'tally_sales_isp', format: 'xml' }];
    const started = await api('POST', '/api/documents/bundle', { auctionId: aid, items });
    const done = await poll(started.d.jobId);
    check('one empty document does not sink the bundle',
          done && done.status === 'done' && done.files === 1 && done.skipped.length === 1,
          JSON.stringify(done));
    const r = await fetch(B + `/api/documents/bundle/${started.d.jobId}/file`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const asText = Buffer.from(await r.arrayBuffer()).toString('latin1');
    check('and the ZIP explains what was left out', /_skipped\.txt/.test(asText));
  }

  // Accepted is not applied. A sale-type list must produce a DIFFERENT
  // export from the unfiltered one, or the filter is decorative.
  {
    const grab = async (u) => {
      const r = await fetch(B + u, { headers: { Authorization: 'Bearer ' + TOKEN } });
      return { status: r.status, body: r.ok ? await r.text() : '' };
    };
    const base = `/api/tally/export/sales_isp/${aid}`;
    const all = await grab(base);
    const two = await grab(base + '?sale=L,I');
    const bad = await grab(base + '?sale=L,Z');
    check('a multi sale-type filter is accepted', two.status !== 400,
          `${two.status} ${two.body.slice(0, 100)}`);
    check('and an unknown one in the list is still rejected', bad.status === 400,
          String(bad.status));
    // Both may legitimately be 404 "no rows" on this fixture; what matters
    // is the filter reaching the builder rather than erroring.
    check('neither errors on the server', all.status !== 500 && two.status !== 500,
          `${all.status} / ${two.status}`);
  }

  // A party filter must APPLY, not merely be accepted: filtering to a
  // party that has no vouchers must differ from the unfiltered export.
  {
    const grab = async (u) => {
      const r = await fetch(B + u, { headers: { Authorization: 'Bearer ' + TOKEN } });
      return { status: r.status, len: r.ok ? (await r.text()).length : 0 };
    };
    const base = `/api/tally/export/urd_purchase/${aid}`;
    const all  = await grab(base);
    const none = await grab(base + '?party=NO%20SUCH%20SELLER');
    const doc  = await grab(base + '?invoice=NO-SUCH-DOC');
    check('a party filter reaches the builder', none.status !== 500, String(none.status));
    check('an invoice filter does too', doc.status !== 500, String(doc.status));
    // Only meaningful when the unfiltered export HAS rows — otherwise both
    // sides are the same "no rows" answer and prove nothing either way.
    if (all.status === 200) {
      check('and filtering to an absent party yields nothing',
            none.status !== 200 || none.len < all.len,
            `all=${all.status}/${all.len} none=${none.status}/${none.len}`);
    } else {
      console.log('         (unfiltered export has no rows here — party narrowing not comparable)');
    }
  }

  // ── Tally filter options ─────────────────────────────────────────
  // The desk's party / document-number pickers are only trustworthy if
  // every value they offer actually selects something. That means the
  // options must come from the SAME rows the export builds — so the test
  // is not "does it return a list" but "does each listed value survive
  // the filter it feeds".
  {
    console.log('\n[live] Tally filter options');
    const o = await api('GET', `/api/tally/filter-options/urd_purchase/${aid}`);
    check('a Tally export lists its own parties and document numbers',
          o.status === 200 && Array.isArray(o.d.parties) && Array.isArray(o.d.invoices),
          `${o.status} ${JSON.stringify(o.d).slice(0, 200)}`);
    check('the fixture put parties in it', (o.d.parties || []).length > 0,
          JSON.stringify(o.d.parties));
    check('and document numbers too', (o.d.invoices || []).length > 0,
          JSON.stringify(o.d.invoices));
    check('the lists are de-duplicated',
          new Set(o.d.parties || []).size === (o.d.parties || []).length
          && new Set(o.d.invoices || []).size === (o.d.invoices || []).length);

    // Every offered value must narrow the export to a non-empty result.
    const grab = async (u) => {
      const r = await fetch(B + u, { headers: { Authorization: 'Bearer ' + TOKEN } });
      return { status: r.status, body: r.ok ? await r.text() : '' };
    };
    const base = `/api/tally/export/urd_purchase/${aid}`;
    const p0 = (o.d.parties || [])[0];
    const i0 = (o.d.invoices || [])[0];
    if (p0) {
      const r = await grab(base + '?party=' + encodeURIComponent(p0));
      check(`an offered party ("${p0}") really selects rows`, r.status === 200, String(r.status));
    }
    if (i0) {
      const r = await grab(base + '?invoice=' + encodeURIComponent(i0));
      check(`an offered document no ("${i0}") really selects rows`, r.status === 200, String(r.status));
    }
    // And the whole list at once must be the same as no filter at all —
    // proof the options are exhaustive, not a sample.
    if ((o.d.parties || []).length) {
      const all  = await grab(base);
      const evry = await grab(base + '?party=' + encodeURIComponent(o.d.parties.join(',')));
      check('selecting every offered party equals the unfiltered export',
            all.status === 200 && evry.status === 200 && evry.body.length === all.body.length,
            `all=${all.status}/${all.body.length} every=${evry.status}/${evry.body.length}`);
    }

    // Ledgers have parties but no document numbers — the endpoint must
    // still answer rather than 400, so the picker degrades to a party-only
    // dialog instead of a free-text box.
    const led = await api('GET', `/api/tally/filter-options/ledger_urd_purchase/${aid}`);
    check('a ledger export answers too', led.status === 200, String(led.status));
    check('and offers parties', (led.d.parties || []).length > 0, JSON.stringify(led.d.parties));

    const bad = await api('GET', `/api/tally/filter-options/not_a_type/${aid}`);
    check('an unknown Tally type is refused', bad.status === 400, String(bad.status));

    // The catalog must name the type, or the client cannot ask at all.
    // Keyed on family, not on the id prefix: `tally_purchase` is a
    // spreadsheet under Reports and has no XML export type at all.
    const tallyTiles = Object.entries(items).filter(([, v]) => v.family === 'tally');
    const untyped = tallyTiles.filter(([, v]) => !(typeof v.tallyType === 'string' && v.tallyType))
      .map(([k]) => k);
    check('every Tally tile carries its export type',
          tallyTiles.length >= 8 && untyped.length === 0,
          `${tallyTiles.length} tiles; missing on: ${untyped.join(', ') || 'none'}`);
    check('and no non-Tally tile claims one',
          Object.entries(items).filter(([, v]) => v.family !== 'tally' && v.tallyType).length === 0);
  }

  // ── Pending counts ───────────────────────────────────────────────
  // Generation splits a buyer's lots by invoice_group, so a buyer with
  // three groups is three invoices to make — counting distinct buyers
  // reported that as one.
  {
    const rows = await api('GET', `/api/lots/${aid}`);
    const lot = (rows.d || [])[0];
    if (lot) {
      const before = (await api('GET', `/api/auctions/${aid}/generation-status`)).d.invoices.pending;
      await api('PUT', `/api/lots/${lot.id}`, { buyer: 'ONE BUYER', buyer1: 'ONE BUYER',
        amount: 1000, price: 10, invoice_group: 0 });
      const rows2 = (await api('GET', `/api/lots/${aid}`)).d || [];
      const other = rows2.find(r => r.id !== lot.id);
      if (other) {
        await api('PUT', `/api/lots/${other.id}`, { buyer: 'ONE BUYER', buyer1: 'ONE BUYER',
          amount: 1000, price: 10, invoice_group: 2 });
        const after = (await api('GET', `/api/auctions/${aid}/generation-status`)).d.invoices.pending;
        check('one buyer split across two invoice groups counts as two invoices',
              after >= 2, `before ${before}, after ${after}`);
      }
    }
  }

  // ── Sales Vouchers: the party is the BUYER ───────────────────────
  // Sales rows name that field `partyName`/`buyer`; every other builder
  // uses `name`. filterRowsByParty read `name` alone, so the party filter
  // on Sales Vouchers matched nothing and the picker had nothing to offer.
  // Runs after the pending-count block, which is what puts buyers on lots.
  {
    console.log('\n[live] Sales Vouchers party');
    const gen = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 1 });
    check('sales invoices generate (needed for these checks)',
          gen.status === 200 || gen.status === 201, `${gen.status} ${JSON.stringify(gen.d).slice(0, 200)}`);

    const o = await api('GET', `/api/tally/filter-options/sales_isp/${aid}`);
    check('Sales Vouchers offer their buyers as parties',
          o.status === 200 && (o.d.parties || []).length > 0,
          `${o.status} ${JSON.stringify(o.d).slice(0, 200)}`);
    check('and their invoice numbers', (o.d.invoices || []).length > 0,
          JSON.stringify(o.d.invoices));

    const grab = async (u) => {
      const r = await fetch(B + u, { headers: { Authorization: 'Bearer ' + TOKEN } });
      return { status: r.status, body: r.ok ? await r.text() : '' };
    };
    const base = `/api/tally/export/sales_isp/${aid}`;
    const all = await grab(base);
    const p0 = (o.d.parties || [])[0];
    if (p0 && all.status === 200) {
      const one = await grab(base + '?party=' + encodeURIComponent(p0));
      // The regression this guards: `name` is absent on sales rows, so the
      // old filter dropped EVERY row and the route answered 404.
      check(`filtering to an offered buyer ("${p0}") still returns the export`,
            one.status === 200, `${one.status} — party filter dropped every row`);
      const none = await grab(base + '?party=NO%20SUCH%20BUYER');
      check('while an absent buyer returns nothing',
            none.status !== 200 || none.body.length < all.body.length,
            `none=${none.status}/${none.body.length} all=${all.body.length}`);
      const evry = await grab(base + '?party=' + encodeURIComponent(o.d.parties.join(',')));
      check('and every offered buyer equals the unfiltered export',
            evry.status === 200 && evry.body.length === all.body.length,
            `every=${evry.status}/${evry.body.length} all=${all.body.length}`);
    } else {
      check('the sales export has rows to filter', false,
            `unfiltered export answered ${all.status}`);
    }

    // Same for the document number, which had the mirrored defect.
    const i0 = (o.d.invoices || [])[0];
    if (i0) {
      const r = await grab(base + '?invoice=' + encodeURIComponent(i0));
      check(`an offered invoice no ("${i0}") selects rows`, r.status === 200, String(r.status));
    }
  }

  // Filters travel with a bundled document, but only the ones its manifest
  // entry declares — the bundler must not become a way to bolt arbitrary
  // query params onto an export route.
  {
    const started = await api('POST', '/api/documents/bundle', { auctionId: aid, items: [
      { id: 'lot_slip', format: 'xlsx', filters: { branch: 'NOWHERE', evil: 'x' } },
    ]});
    check('a bundle accepts a filtered document', started.status === 200, JSON.stringify(started.d));
    const done = await poll(started.d.jobId);
    check('and still produces it', done && done.status !== 'error', JSON.stringify(done));
    await fetch(B + `/api/documents/bundle/${started.d.jobId}/file`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
  }

  // The security boundary: the server re-resolves the catalog and refuses
  // anything the caller could not have downloaded on screen.
  {
    const locked = await api('POST', '/api/documents/bundle',
      { auctionId: aid, items: [{ id: 'tds_return', format: 'xlsx' }] });   // needs from/to
    check('a document missing its inputs is refused', locked.status === 403,
          `${locked.status} ${JSON.stringify(locked.d)}`);
    const unknown = await api('POST', '/api/documents/bundle',
      { auctionId: aid, items: [{ id: 'not_a_document', format: 'pdf' }] });
    check('an unknown id is refused', unknown.status === 400, String(unknown.status));
    const empty = await api('POST', '/api/documents/bundle', { auctionId: aid, items: [] });
    check('an empty selection is refused', empty.status === 400, String(empty.status));
    const huge = await api('POST', '/api/documents/bundle',
      { auctionId: aid, items: Array.from({ length: 61 }, () => ({ id: 'lot_slip', format: 'xlsx' })) });
    check('an oversized selection is refused', huge.status === 400, String(huge.status));
    const gone = await api('GET', '/api/documents/bundle/b-nope');
    check('an unknown job id is a 404', gone.status === 404, String(gone.status));
  }

  // ── Role gate: the desk belongs to managers and admins ───────────
  // Every /api/documents/* route sits behind the auction_desk capability,
  // so a role without it cannot read the catalog, let alone bundle from it.
  {
    console.log('\n[live] role gate');
    const ADMIN = TOKEN;
    const mkUser = (username, role) =>
      api('POST', '/api/users', { username, password: 'passw0rd', role });
    const tokenFor = async (username) => {
      const saved = TOKEN; TOKEN = null;
      const r = await api('POST', '/api/login', { username, password: 'passw0rd' });
      TOKEN = saved;
      return r.d && (r.d.token || r.d.accessToken);
    };

    for (const role of ['viewer', 'operator', 'lot_entry']) {
      const made = await mkUser('desk_' + role, role);
      check(`a ${role} account can be created`, made.status === 200 || made.status === 201,
            `${made.status} ${JSON.stringify(made.d)}`);
      const tok = await tokenFor('desk_' + role);
      check(`the ${role} can sign in`, !!tok);
      TOKEN = tok;
      const cat = await api('GET', '/api/documents/catalog?auctionId=' + aid);
      check(`a ${role} cannot read the document catalog`, cat.status === 403,
            `${cat.status} ${JSON.stringify(cat.d).slice(0, 200)}`);
      const bun = await api('POST', '/api/documents/bundle',
        { auctionId: aid, items: [{ id: 'lot_slip', format: 'xlsx' }] });
      check(`nor bundle documents`, bun.status === 403, String(bun.status));
      TOKEN = ADMIN;
    }

    const mgr = await mkUser('desk_manager', 'manager');
    check('a manager account can be created', mgr.status === 200 || mgr.status === 201,
          `${mgr.status} ${JSON.stringify(mgr.d)}`);
    TOKEN = await tokenFor('desk_manager');
    const mcat = await api('GET', '/api/documents/catalog?auctionId=' + aid);
    check('but a manager reads the catalog fine', mcat.status === 200, String(mcat.status));
    check('and sees documents in it', flatten(mcat.d).lot_slip !== undefined);
    TOKEN = ADMIN;
    const acat = await api('GET', '/api/documents/catalog?auctionId=' + aid);
    check('and so does an admin', acat.status === 200, String(acat.status));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
