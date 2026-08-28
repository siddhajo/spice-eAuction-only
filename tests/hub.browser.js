// AUCTION DESK — the hub screen, driven in a real headless Chrome.
//
// tests/catalog.http.js proves the manifest and the API. This proves the
// screen actually built from them behaves:
//
//   [A] it is where a session lands, and the preference to land on the old
//       Dashboard instead is honoured
//   [B] tiles are painted from the catalog — grouped, counted, and with
//       locked ones VISIBLE and carrying their reason, which is the whole
//       reason the hub beats the sidebar for finding documents
//   [C] the filter box searches across groups and opens what it finds
//   [D] the auction selector is the shared one — picking an auction here
//       moves the topbar, and Open → carries it to the target screen
//   [E] a download actually downloads
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ui-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dl-'));
const PORT = 47365;
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
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(DL, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  // single_session would refuse a second `admin` sign-in from the browser,
  // so the UI drives a separate account while fixtures go over the API.
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });

  // Two trades, so the shared-selector check has something to switch to.
  // Trade 9 gets priced lots (stage 3); trade 8 stays empty (stage 1).
  const mk = async (ano) => (await api('POST', '/api/auctions', { ano, date: '2026-08-12', state: 'TAMIL NADU' })).d;
  const a9 = await mk('9'); const aid9 = a9.id || (a9.auction && a9.auction.id);
  await mk('8');
  for (const [lot_no, name, qty, price] of [
    ['201', 'RAMU PLANTER',  100, 400],
    ['202', 'SELVI PLANTER', 300, 400],
  ]) {
    const r = await api('POST', '/api/lots', { auction_id: aid9, lot_no, name, qty, grade: '1',
      bags: 8, crop: 'CARDAMOM', branch: lot_no === '201' ? 'BODINAYAKANUR' : 'VANDANMEDU',
      tel: lot_no === '201' ? '+91 98765 43210' : '9000011111' });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    await api('PUT', `/api/lots/${id}`, { price, amount: qty * price });
  }
  // Sellers in the MASTER (not just names on lots) so the register's party
  // picker has something to offer.
  for (const [name, tel] of [['RAMU PLANTER', '+91 98765 43210'],
                             ['SELVI PLANTER', '9000011111'],
                             ['THOMAS KURIAN', '9000022222']]) {
    await api('POST', '/api/traders', { name, tel });
  }

  // …plus enough filler to span more than one page at the smallest size.
  for (let i = 1; i <= 30; i++) {
    await api('POST', '/api/lots', { auction_id: aid9, lot_no: String(300 + i),
      name: 'FILLER ' + i, qty: 10, grade: '1', bags: 1, crop: 'CARDAMOM',
      branch: i % 2 ? 'BODINAYAKANUR' : 'VANDANMEDU' });
  }

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) {
    try {
      const mod = require('@sparticuz/chromium');
      const chromium = mod && mod.default ? mod.default : mod;
      const ep = await chromium.executablePath();
      if (ep) chrome = { executablePath: ep, args: (chromium.args || ['--no-sandbox']) };
    } catch (_) {}
  }
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  // login() reveals #app several awaits BEFORE it navigates to the landing
  // tab (settings and feature flags load in between), so waiting on the app
  // being visible would read _currentTab mid-flight. applyFeatureFlags()
  // stamps data-feat-whatsapp on <body> and go() runs synchronously after
  // it, so that attribute is the signal that the landing tab is settled.
  const signIn = async () => {
    await page.evaluate(() => {
      document.getElementById('inp-u').value = 'uiadmin';
      document.getElementById('inp-p').value = 'pw1234';
      login();
    });
    await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
    await page.waitForFunction(() => document.body.hasAttribute('data-feat-whatsapp')
                                     && !!window._currentTab, { timeout: 20000 });
  };
  await signIn();

  // ── [A] Landing ──────────────────────────────────────────────────
  console.log('[A] landing screen');
  check('a session lands on the Auction Desk',
        await page.evaluate(() => window._currentTab === 'hub'),
        await page.evaluate(() => window._currentTab));
  check('the Auction Desk panel is the visible one',
        await page.evaluate(() => document.getElementById('tc-hub').classList.contains('active')));
  check('its sidebar item is the active one',
        await page.evaluate(() => document.querySelector('.side-item[data-tab="hub"]')?.classList.contains('active')));

  // ── [L] Lots view ────────────────────────────────────────────────
  // Picking an auction lands on its lots, not on the document grid.
  console.log('\n[L] lots view');
  await page.waitForFunction(() => document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length > 0,
                             { timeout: 20000 });
  const lotsView = await page.evaluate(() => ({
    onLots:  document.getElementById('hub-view-lots').style.display !== 'none',
    docsOff: document.getElementById('hub-view-docs').style.display === 'none',
    rows:    document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length,
    first:   document.querySelector('#hub-lot-rows td')?.textContent.trim(),
    count:   document.getElementById('hub-lot-count').textContent,
    kpis:    document.querySelectorAll('#hub-kpi .stat').length,
  }));
  check('the auction opens on its lots', lotsView.onLots && lotsView.docsOff);
  check('the first page of lots is listed', lotsView.rows > 0 && lotsView.rows <= 50,
        `${lotsView.rows} rows`);
  check('in ascending lot order', lotsView.first === '201', lotsView.first);
  check('with the whole-auction count in the header',
        /32 lots · 2 sold/.test(lotsView.count), lotsView.count);
  // The KPI strip rides on the catalog fetch, which is a separate request
  // from the lots one — it lands a moment after the rows.
  await page.waitForFunction(() => document.querySelectorAll('#hub-kpi .stat').length === 5,
                             { timeout: 20000 }).catch(() => {});
  check('and the KPI strip is populated on this view too',
        await page.evaluate(() => document.querySelectorAll('#hub-kpi .stat').length) === 5);

  // Search runs server-side; give the debounce and the round trip time.
  await page.evaluate(() => {
    document.getElementById('hub-lot-search').value = 'SELVI';
    hubLotSearchDebounced();
  });
  await new Promise(r => setTimeout(r, 1200));
  const searched = await page.evaluate(() => ({
    rows: document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length,
    who:  document.querySelectorAll('#hub-lot-rows td')[1]?.textContent.trim(),
  }));
  check('searching narrows the lot list', searched.rows === 1 && /SELVI/.test(searched.who || ''),
        JSON.stringify(searched));
  // …and the figures follow the filter, rather than still describing the
  // whole auction while the table shows one lot.
  const narrowed = await page.evaluate(() => ({
    kpiLots: document.querySelector('#hub-kpi .stat .n')?.textContent.trim(),
    totals: document.querySelector('#hub-lot-foot tr.is-all td')?.textContent.trim(),
  }));
  check('the KPI cards narrow with the filter', narrowed.kpiLots === '1',
        JSON.stringify(narrowed));
  check('and so does the totals row', /1 lots?/.test(narrowed.totals || ''),
        JSON.stringify(narrowed));
  check('and a clear button appears', await page.evaluate(
        () => document.getElementById('hub-lot-clear').style.display !== 'none'));
  await page.evaluate(() => hubLotSearchClear());
  await new Promise(r => setTimeout(r, 1200));
  check('clearing it restores every lot and hides itself',
        await page.evaluate(() => window._hubLots.length === 32
          && document.getElementById('hub-lot-clear').style.display === 'none'));

  // One button beside the filters jumps to the Documents tab.
  const jump = await page.evaluate(() => {
    const b = document.querySelector('.hub-docs-jump');
    if (!b) return { found: false };
    b.click();
    const onDocs = document.getElementById('hub-view-docs').style.display !== 'none';
    hubSetView('lots');
    return { found: true, onDocs };
  });
  check('a Documents button beside the filters jumps to that tab',
        jump.found && jump.onDocs, JSON.stringify(jump));

  // The lot table scrolls inside its own box rather than growing the page.
  const scroll = await page.evaluate(() => {
    const el = document.querySelector('.hub-lot-scroll');
    return { has: !!el, capped: el && el.clientHeight < el.scrollHeight,
             sticky: el && getComputedStyle(el.querySelector('th')).position === 'sticky' };
  });
  check('the lot table scrolls in a fixed box', scroll.has && scroll.capped, JSON.stringify(scroll));

  // Totals under the table, and a KPI strip that describes what is on
  // screen rather than the whole auction.
  const totals = await page.evaluate(() => {
    const foot = document.getElementById('hub-lot-foot');
    const all = foot.querySelector('tr.is-all');
    const cells = Array.from(all.querySelectorAll('td')).map(td => td.textContent.trim());
    return { rows: foot.querySelectorAll('tr').length, cells,
             lots: window._hubLots.length,
             qty: window._hubLots.reduce((a, l) => a + (Number(l.qty) || 0), 0) };
  });
  check('the lots table carries a totals row',
        totals.rows >= 1 && /32 lots/.test(totals.cells[0] || ''), JSON.stringify(totals.cells));
  // The per-page subtotal only appears when a page IS part of the set —
  // with everything on one page a second row would say the same thing twice.
  const paged = await page.evaluate(() => {
    setGlobalPageSize(20);
    const foot = document.getElementById('hub-lot-foot');
    const out = { paged: foot.querySelectorAll('tr').length,
                  pageLabel: foot.querySelector('tr.is-page td')?.textContent.trim() };
    setGlobalPageSize(50);
    out.whole = foot.querySelectorAll('tr').length;
    return out;
  });
  check('a per-page subtotal appears once the set spans pages',
        paged.paged === 2 && /This page — 20 lots/.test(paged.pageLabel || ''),
        JSON.stringify(paged));
  check('and disappears when everything fits one page', paged.whole === 1,
        `${paged.whole} rows`);
  check('the total quantity matches the loaded lots',
        totals.cells[2] === totals.qty.toLocaleString('en-IN', { minimumFractionDigits: 3 }),
        `${totals.cells[2]} vs ${totals.qty}`);
  check('with its header pinned', scroll.sticky);

  // Row click → drawer with the lot's detail, and an Edit that hands off to
  // the app's existing modal rather than a second editor.
  const drawer = await page.evaluate(() => {
    document.querySelector('#hub-lot-rows tr[data-lot-id]').click();
    const dr = document.getElementById('hub-lot-drawer');
    return {
      open:   dr.style.display !== 'none',
      scrim:  document.getElementById('hub-lot-scrim').style.display !== 'none',
      title:  dr.querySelector('div')?.textContent.trim(),
      fields: dr.querySelectorAll('.hub-dl dt').length,
      text:   dr.textContent,
      marked: !!document.querySelector('#hub-lot-rows tr.is-open'),
    };
  });
  check('clicking a lot opens the detail drawer', drawer.open && drawer.scrim);
  check('headed with the lot number', /Lot 201/.test(drawer.title || ''), drawer.title);
  check('showing the full field set', drawer.fields >= 20, `${drawer.fields} fields`);
  check('including seller, sale and computed figures',
        /RAMU PLANTER/.test(drawer.text) && /Commission/.test(drawer.text) && /Payable/.test(drawer.text));
  check('and the row is marked as open', drawer.marked);

  const edit = await page.evaluate(() => {
    hubLotEdit();
    return {
      drawerClosed: document.getElementById('hub-lot-drawer').style.display === 'none',
      modalOpen: getComputedStyle(document.getElementById('lot-modal')).display !== 'none',
      lotNo: document.getElementById('lot-modal-title')?.textContent,
      qty: document.getElementById('l-qty')?.value,
    };
  });
  check('Edit hands off to the existing lot-edit modal',
        edit.modalOpen && /Edit Lot #201/.test(edit.lotNo || ''), JSON.stringify(edit));
  check('pre-filled with that lot', String(edit.qty) === '100', edit.qty);
  // The drawer must NOT close: dismissing the modal should put you back on
  // the lot you were reading, not on an empty list you have to find it in
  // again. The modal stacks above the drawer (z-index 50 vs 40).
  check('and the drawer stays open behind it', !edit.drawerClosed, JSON.stringify(edit));
  const stacked = await page.evaluate(() => {
    const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
    return z(document.getElementById('lot-modal')) > z(document.getElementById('hub-lot-drawer'));
  });
  check('with the modal stacked above it', stacked);
  await page.evaluate(() => hideModal('lot-modal'));
  check('closing the modal leaves you on the same lot',
        await page.evaluate(() => document.getElementById('hub-lot-drawer').style.display !== 'none'
          && /Lot 201/.test(document.getElementById('hub-lot-drawer').textContent)));
  await page.evaluate(() => hubLotClose());

  // The drawer's second editor: Price Entry, filtered to this lot.
  const pe = await page.evaluate(async () => {
    document.querySelector('#hub-lot-rows tr[data-lot-id]').click();
    await hubLotPriceEntry();
    return {
      tab: window._currentTab,
      filter: document.getElementById('pe-filter-lot')?.value,
      rows: document.querySelectorAll('#pe-grid tbody tr').length,
    };
  });
  check('Price Entry → opens that screen filtered to the lot',
        pe.tab === 'priceentry' && pe.filter === '201', JSON.stringify(pe));
  await page.evaluate(() => { peSetFilter('lot', ''); go('hub'); });
  await page.waitForFunction(() => document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length > 0,
                             { timeout: 20000 });
  // Returning to the hub refetches the lots, so the first render can be
  // replaced moments after the wait resolves. Let it settle before clicking.
  await new Promise(r => setTimeout(r, 700));

  // Escape closes the drawer.
  await page.evaluate(() => document.querySelector('#hub-lot-rows tr[data-lot-id]')?.click());
  await page.keyboard.press('Escape');
  check('Escape closes the drawer',
        await page.evaluate(() => document.getElementById('hub-lot-drawer').style.display === 'none'));

  // ── Switch to Documents ──────────────────────────────────────────
  await page.evaluate(() => hubSetView('docs'));
  await page.waitForFunction(() => document.querySelectorAll('#hub-groups .hub-w').length > 0, { timeout: 20000 });
  check('the Documents tab shows the widget grid',
        await page.evaluate(() => document.getElementById('hub-view-docs').style.display !== 'none'
          && document.getElementById('hub-view-lots').style.display === 'none'));

  // ── [B] Widgets, then drill into one ─────────────────────────────
  // The documents live one level down: a grid of group widgets that fits a
  // screen, and one group's rows at a time. Nine stacked accordions did
  // not fit, which is what made the page long before anything was opened.
  console.log('\n[B] widget grid and drill-down');
  const shape = await page.evaluate(() => ({
    widgets: document.querySelectorAll('#hub-groups .hub-w').length,
    apiGroups: (window._hubCat?.groups || []).length,
    apiTiles: (window._hubCat?.groups || []).reduce((n, g) => n + g.items.length, 0),
    tilesAtTop: document.querySelectorAll('#hub-groups .hub-tile').length,
    kpis: document.querySelectorAll('#hub-kpi .stat').length,
    firstName: document.querySelector('.hub-w .hub-w-name')?.textContent.trim(),
    firstCount: document.querySelector('.hub-w .hub-w-n')?.textContent.trim(),
  }));
  check('one widget per group', shape.widgets === shape.apiGroups && shape.widgets >= 8,
        `${shape.widgets} widgets vs ${shape.apiGroups} groups`);
  check('and no document rows until one is opened', shape.tilesAtTop === 0,
        `${shape.tilesAtTop} rows`);
  check('each widget says how much of it is ready', /\d+ of \d+ ready/.test(shape.firstCount || ''),
        shape.firstCount);
  check('the KPI strip is populated', shape.kpis === 5, `${shape.kpis} cards`);
  // Combined cards: each carries its own breakdown rather than the figure
  // alone — Lots/Sold/Withdrawn by bags-qty-amount, Value by min-max-avg.
  const meta = await page.evaluate(() => Array.from(document.querySelectorAll('#hub-kpi .stat'))
    .map(st => ({ label: st.querySelector('.l').textContent.trim(),
                  rows: st.querySelectorAll('.hub-meta .lbl').length })));
  check('every KPI card shows its breakdown',
        meta.length === 5 && meta.every(m => m.rows >= 2), JSON.stringify(meta));
  check('with Value broken down by min / max / avg',
        /Min ₹/.test(await page.evaluate(() =>
          document.querySelector('#hub-kpi .stat.t-rose .hub-meta')?.textContent || '')));
  check('KPI reads the lot count from the auction',
        await page.evaluate(() => (document.querySelector('#hub-kpi .stat .n')?.textContent || '').trim() === '32'),
        await page.evaluate(() => document.querySelector('#hub-kpi .stat .n')?.textContent));

  // Three levels: groups → subgroups → documents. Statutory has two
  // subgroups, so opening it shows those rather than jumping to cards.
  const drill = await page.evaluate(() => {
    document.querySelector('.hub-w[data-g="statutory"]').click();
    return {
      rows: document.querySelectorAll('#hub-groups .hub-tile').length,
      subs: document.querySelectorAll('#hub-groups .hub-w-sub').length,
      names: Array.from(document.querySelectorAll('.hub-w-sub .hub-w-name')).map(x => x.textContent.trim()),
      name: document.querySelector('.hub-open-name')?.textContent.trim(),
      back: !!Array.from(document.querySelectorAll('.hub-open-head .hub-btn'))
                   .find(b => /All documents/.test(b.textContent)),
    };
  });
  check('clicking a group widget opens its subgroups',
        drill.subs === 2 && drill.rows === 0, JSON.stringify(drill));
  // Regression: the filter pass hid any container whose tiles all matched
  // out — and a subgroup-widget view has no tiles at all, so it blanked
  // the entire screen.
  check('and the subgroup widgets are actually visible',
        await page.evaluate(() => {
          const w = document.querySelector('.hub-w-sub');
          const box = document.querySelector('.hub-open');
          return !!w && w.offsetParent !== null && getComputedStyle(box).display !== 'none';
        }));
  check('named for the subgroups',
        drill.names.includes('Spices Board') && drill.names.includes('Tax'),
        drill.names.join(', '));
  check('headed with the group name and a way back',
        /Statutory/.test(drill.name || '') && drill.back, JSON.stringify(drill));

  const drill2 = await page.evaluate(() => {
    document.querySelector('.hub-w-sub[data-sub="Spices Board"]').click();
    return {
      rows: document.querySelectorAll('#hub-groups .hub-tile').length,
      subs: document.querySelectorAll('.hub-w-sub').length,
      name: document.querySelector('.hub-open-name')?.textContent.trim(),
      backToGroup: !!Array.from(document.querySelectorAll('.hub-open-head .hub-btn'))
                          .find(b => /Statutory/.test(b.textContent)),
      apiCount: (window._hubCat.groups.find(g => g.id === 'statutory') || { items: [] })
                  .items.filter(i => i.sub === 'Spices Board').length,
    };
  });
  check('clicking a subgroup opens its documents',
        drill2.rows === drill2.apiCount && drill2.subs === 0, JSON.stringify(drill2));
  check('with a crumb back to the group',
        /Spices Board/.test(drill2.name || '') && drill2.backToGroup, JSON.stringify(drill2));
  check('and that crumb returns to the subgroups',
        await page.evaluate(() => { hubCloseSub();
          return document.querySelectorAll('.hub-w-sub').length === 2; }));

  // A group with only ONE subgroup must not cost an extra click.
  const single = await page.evaluate(() => {
    hubOpenGroup('logistics');
    return { subs: document.querySelectorAll('.hub-w-sub').length,
             rows: document.querySelectorAll('.hub-tile').length };
  });
  check('a single-subgroup group goes straight to its documents',
        single.subs === 0 && single.rows === 3, JSON.stringify(single));
  await page.evaluate(() => { hubOpenGroup('statutory'); hubOpenSub('Spices Board'); });

  // The cards scroll in place and the group header stays put above them.
  // Safe here in a way it was not for the old accordion: only ONE group is
  // open, so this is the page's only scroll rather than a nested one.
  const cardScroll = await page.evaluate(() => {
    hubOpenGroup('reports'); hubOpenSub('Trade & value');
    const b = document.querySelector('.hub-open-body');
    const h = document.querySelector('.hub-open-head');
    return { box: !!b, scrolls: b && getComputedStyle(b).overflowY === 'auto',
             headerOutside: !!h && !!b && !b.contains(h),
             // A subgroup often fits without overflowing — which is the
             // point. What matters is that a cap EXISTS, so a big group
             // scrolls instead of growing the page.
             capped: b && getComputedStyle(b).maxHeight !== 'none' };
  });
  check('the cards scroll in their own box', cardScroll.box && cardScroll.scrolls,
        JSON.stringify(cardScroll));
  check('with the group header outside it', cardScroll.headerOutside);
  check('and the box caps its height', cardScroll.capped, JSON.stringify(cardScroll));
  await page.evaluate(() => { hubOpenGroup('statutory'); hubOpenSub('Spices Board'); });

  // Locked rows must be VISIBLE and self-explaining — the point of the hub.
  const lock = await page.evaluate(() => {
    // Buyers Statement sits under Statutory → Spices Board and is stage-
    // locked until a transaction document exists.
    hubOpenGroup('statutory'); hubOpenSub('Spices Board');
    const t = document.querySelector('.hub-tile.is-locked');
    return { any: !!t, shown: !!(t && t.offsetParent !== null),
             reason: t?.querySelector('.hub-lock')?.textContent || '' };
  });
  check('stage-locked rows are rendered, not hidden', lock.any && lock.shown, JSON.stringify(lock));
  check('a locked row states its reason', lock.reason.trim().length > 8, lock.reason);
  check('nothing flagged off is rendered',
        await page.evaluate(() => !document.querySelector('[data-hub-id="debit_notes"]')));

  // Search reaches every document without opening a widget first.
  const searchAll = await page.evaluate(() => {
    hubCloseGroup();
    const inp = document.getElementById('hub-filter');
    inp.value = 'lot'; hubComboInput(); hubApplyFilter();
    return { rows: document.querySelectorAll('#hub-groups .hub-tile').length,
             widgets: document.querySelectorAll('.hub-w').length };
  });
  check('searching cuts straight past the grid to the matches',
        searchAll.rows > 0 && searchAll.widgets === 0, JSON.stringify(searchAll));
  await page.evaluate(() => { hubComboClear(); hubOpenGroup('preauction'); });

  // Preview/Print are icon-only, so they are identified by aria-label. The
  // action row must also fit on ONE line — spelled out it wrapped and made
  // every tile in the grid taller.
  const acts = await page.evaluate(() => {
    hubOpenGroup('preauction'); hubOpenSub('Lot lists');
    const t = document.querySelector('[data-hub-id="lot_slip"]');
    const btns = Array.from(t?.querySelectorAll('.hub-btn') || []);
    const rows = new Set(btns.map(b => b.getBoundingClientRect().top));
    return {
      labels: btns.map(b => b.textContent.trim() || b.getAttribute('aria-label')),
      rows: rows.size,
    };
  });
  check('an available document offers its formats plus Preview/Print',
        ['XLSX', 'PDF', 'Preview', 'Print'].every(l => acts.labels.includes(l)),
        acts.labels.join(', '));
  // Cards, not rows: the actions may take two lines, but no more — beyond
  // that the card is taller than its neighbours for no reason.
  check('and its actions take at most two lines', acts.rows <= 2, `${acts.rows} lines`);
  // Regression: a greedy CSS cleanup removed the .hub-tile base rule and
  // the cards silently lost their shell — no test noticed. Pin the shape.
  const shell = await page.evaluate(() => {
    const t = document.querySelector('.hub-tile');
    const cs = getComputedStyle(t);
    const bar = getComputedStyle(t, '::before');
    return { radius: parseFloat(cs.borderRadius), pad: parseFloat(cs.paddingLeft),
             border: cs.borderTopWidth, bg: cs.backgroundImage,
             barH: bar.height, barBg: bar.backgroundImage };
  });
  check('a document card carries its card shell',
        shell.radius >= 12 && shell.pad >= 12 && parseFloat(shell.border) >= 1,
        JSON.stringify(shell));

  // The card head adopted the Auction Downloads screen's arrangement —
  // file glyph, then name over formats. The point of the change was that
  // NOTHING was given up for it, so assert the head and the actions
  // together: a future "simplification" that drops the format buttons or
  // the bundle tick to match that screen more literally must fail here.
  const head = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('.hub-tile'));
    const t = tiles[0];
    return {
      tiles: tiles.length,
      glyphs: tiles.filter(x => x.querySelector('.hub-file-ico svg')).length,
      fmtLines: tiles.filter(x => x.querySelector('.hub-tile-fmt')).length,
      // The old colour-coded chip is gone; its information moved into the
      // second line, which names EVERY format rather than just the first.
      oldChips: document.querySelectorAll('.hub-tile .hub-fmt').length,
      fmtText: t.querySelector('.hub-tile-fmt')?.textContent.trim(),
      label: t.querySelector('.hub-tile-l')?.textContent.trim(),
      // Glyph sits before the text, as on the reference.
      glyphFirst: t.querySelector('.hub-tile-main')?.firstElementChild?.classList.contains('hub-file-ico'),
      // …and everything this screen adds is still on the card.
      withActions: tiles.filter(x => x.querySelector('.hub-acts .hub-btn')).length,
      withPicks:   tiles.filter(x => x.querySelector('.hub-cb')).length,
    };
  });
  check('every card leads with the file glyph', head.tiles > 0 && head.glyphs === head.tiles,
        `${head.glyphs}/${head.tiles}`);
  check('the glyph comes before the name', head.glyphFirst === true);
  check('every card names its formats on a second line',
        head.fmtLines === head.tiles, `${head.fmtLines}/${head.tiles}`);
  check('the old colour-coded format chip is gone', head.oldChips === 0, `${head.oldChips} left`);
  check('the format line lists formats, not one', /^[A-Z]{3,4}( · [A-Z]{3,4})*$/.test(head.fmtText || ''),
        String(head.fmtText));
  check('cards kept their download actions', head.withActions > 0, `${head.withActions} of ${head.tiles}`);
  check('cards kept the bundle checkbox', head.withPicks > 0, `${head.withPicks} of ${head.tiles}`);

  // A locked card greys its glyph, the way a not-yet-available tile does on
  // the Auction Downloads screen — same signal, same place.
  const lockedGlyph = await page.evaluate(() => {
    const t = document.querySelector('.hub-tile.is-locked');
    if (!t) return 'none';
    const a = document.querySelector('.hub-tile:not(.is-locked) .hub-file-ico');
    const b = t.querySelector('.hub-file-ico');
    return a && b ? (getComputedStyle(a).backgroundColor !== getComputedStyle(b).backgroundColor) : 'none';
  });
  if (lockedGlyph !== 'none') check('a locked card greys its glyph', lockedGlyph === true);
  check('tinted, with a gradient bar across the top',
        parseFloat(shell.barH) >= 3 && /gradient/.test(shell.barBg)
          && /gradient/.test(shell.bg), JSON.stringify(shell));

  // The widgets and KPI figures are the Insights gradient card: saturated
  // ground, white text, translucent icon chip.
  const grad = await page.evaluate(() => {
    hubCloseGroup();
    const w = document.querySelector('.hub-w');
    const k = document.querySelector('#hub-kpi .stat');
    const g = (el) => { const cs = getComputedStyle(el);
      return { bg: cs.backgroundImage, colour: cs.color, shadow: cs.boxShadow,
               ico: !!el.querySelector('.hub-ico') }; };
    return { w: g(w), k: g(k) };
  });
  // Regression: the widget's parts are <span>s. Without an explicit
  // display they flowed inline and the name, count and hint ran together
  // as one sentence. And a KPI value must never be cut off by its card.
  const legible = await page.evaluate(() => {
    const w = document.querySelector('.hub-w');
    const name = w.querySelector('.hub-w-name').getBoundingClientRect();
    const n = w.querySelector('.hub-w-n').getBoundingClientRect();
    const cut = Array.from(document.querySelectorAll('#hub-kpi .stat')).filter(st => {
      const v = st.querySelector('.n');
      // Cut off OR broken onto a second line — "4,950.000" wrapping to
      // "4,950.00 / 0" reads as a different number entirely.
      const oneLine = v.getClientRects().length <= 1;
      return v.scrollWidth > v.clientWidth + 1 || !oneLine;
    }).map(st => st.querySelector('.l').textContent.trim());
    return { stacked: n.top >= name.bottom - 1, cut };
  });
  check('a widget stacks its name above its count', legible.stacked, JSON.stringify(legible));
  check('and every KPI value fits on one line, uncut', legible.cut.length === 0,
        legible.cut.join(', '));

  for (const [what, v] of [['widget', grad.w], ['KPI figure', grad.k]]) {
    check(`a ${what} is a gradient card`, /gradient/.test(v.bg), v.bg.slice(0, 60));
    check(`with white text and an icon chip`,
          /255, 255, 255/.test(v.colour) && v.ico, JSON.stringify(v).slice(0, 120));
    check(`and a coloured glow`, v.shadow !== 'none', v.shadow.slice(0, 60));
  }
  // Regression: the icon buttons were styled white-on-white for a build,
  // because the colour rule counted BUTTONS while only icon buttons got
  // the white text. Every action must contrast with its own background.
  const contrast = await page.evaluate(() => {
    const rgb = (v) => (v.match(/\d+/g) || []).map(Number);
    const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b);
    return Array.from(document.querySelectorAll('.hub-tile .hub-btn')).map(b => {
      const cs = getComputedStyle(b);
      const fg = rgb(cs.color), bg = rgb(cs.backgroundColor);
      const solid = bg.length >= 3 && !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor);
      return { label: b.textContent.trim() || b.getAttribute('aria-label'),
               d: solid ? Math.abs(lum(fg) - lum(bg)) : 999 };
    }).filter(x => x.d < 60);
  });
  check('no action is styled invisibly against its own background',
        contrast.length === 0, JSON.stringify(contrast));
  // Every action on a card belongs to that card's colour family — a
  // violet card with a red badge and two green buttons read as three
  // unrelated things stapled together.
  const family = await page.evaluate(() => {
    // Auction Documents is the group that exposed this — a violet card
    // carrying a red badge and two green buttons.
    hubOpenGroup('documents'); hubOpenSub('Purchase side');
    const t = document.querySelector('.hub-tile');
    if (!t) return [{ label: 'no card on screen' }];
    const to = getComputedStyle(t).getPropertyValue('--to').trim();
    const from = getComputedStyle(t).getPropertyValue('--from').trim();
    const hex = (h) => { const m = h.replace('#','');
      return [0,2,4].map(i => parseInt(m.slice(i,i+2),16)); };
    const rgb = (v) => (v.match(/\d+/g) || []).map(Number);
    const near = (a, b) => a.length === 3 && b.length === 3
      && a.every((x, i) => Math.abs(x - b[i]) <= 24);
    const fam = [hex(to), hex(from)];
    return Array.from(t.querySelectorAll('.hub-btn')).map(b => {
      const bg = rgb(getComputedStyle(b).backgroundColor);
      return { label: b.textContent.trim() || b.getAttribute('aria-label'),
               ok: fam.some(f => near(bg, f))
                   || getComputedStyle(b).color.includes(rgb(to).join(', ')) };
    }).filter(x => !x.ok);
  });
  check('every action takes its card\'s colour family',
        family.length === 0, JSON.stringify(family));
  await page.evaluate(() => { hubOpenGroup('preauction'); hubOpenSub('Lot lists'); });

  // ── [C] Find a document ──────────────────────────────────────────
  console.log('\n[C] find a document');
  const total = await page.evaluate(() => (window._hubCat?.groups || [])
    .reduce((n, g) => n + g.items.length, 0));

  const filtered = await page.evaluate(() => {
    hubCloseGroup();
    const inp = document.getElementById('hub-filter');
    inp.value = 'tally'; hubComboInput(); hubApplyFilter();
    return Array.from(document.querySelectorAll('.hub-tile'))
      .filter(t => t.style.display !== 'none').length;
  });
  check('typing narrows to the matches', filtered > 0 && filtered < total,
        `${filtered} of ${total}`);
  await page.evaluate(() => hubComboClear());
  check('clearing it returns to the widget grid',
        await page.evaluate(() => document.querySelectorAll('.hub-w').length >= 8
          && document.querySelectorAll('.hub-tile').length === 0));

  // The dropdown lists every document regardless of what is on screen —
  // it reads the catalog, not the DOM.
  const combo = await page.evaluate(() => {
    hubComboOpen();
    const box = document.getElementById('hub-combo-list');
    return {
      open: box.style.display !== 'none',
      opts: box.querySelectorAll('.hub-combo-opt').length,
      groups: box.querySelectorAll('.hub-combo-grp').length,
      locked: box.querySelectorAll('.hub-combo-opt.is-locked').length,
    };
  });
  check('the dropdown lists every document', combo.open && combo.opts === total,
        `${combo.opts} options vs ${total} documents`);
  check('grouped, and locked ones still listed', combo.groups >= 8 && combo.locked > 0,
        `${combo.groups} groups, ${combo.locked} locked`);
  const typed = await page.evaluate(() => {
    const inp = document.getElementById('hub-filter');
    inp.value = 'form'; hubComboInput();
    return document.querySelectorAll('#hub-combo-list .hub-combo-opt').length;
  });
  check('typing narrows the dropdown', typed > 0 && typed < combo.opts, String(typed));
  const combopick = await page.evaluate(() => {
    hubComboPick('form_d');
    const vis = Array.from(document.querySelectorAll('.hub-tile')).filter(t => t.style.display !== 'none');
    return { count: vis.length, id: vis[0]?.dataset.hubId,
             value: document.getElementById('hub-filter').value,
             closed: document.getElementById('hub-combo-list').style.display === 'none' };
  });
  check('picking a document shows only that one',
        combopick.count === 1 && combopick.id === 'form_d', JSON.stringify(combopick));
  check('its name lands in the box and the list closes',
        /FORM-D/.test(combopick.value) && combopick.closed, JSON.stringify(combopick));
  await page.evaluate(() => hubComboClear());
  check('clearing the pick returns to the grid',
        await page.evaluate(() => document.querySelectorAll('.hub-w').length >= 8));

  // ── [G] Group the documents by file type ─────────────────────────
  console.log('\n[G] grouping by file type');
  const byFmt = await page.evaluate(() => {
    hubSetGrouping('format');
    const ws = Array.from(document.querySelectorAll('.hub-w'));
    return { widgets: ws.map(w => w.dataset.g),
             names: ws.map(w => w.querySelector('.hub-w-name')?.textContent.trim()) };
  });
  check('the widgets regroup by file type',
        byFmt.widgets.includes('fmt-pdf') && byFmt.widgets.includes('fmt-xlsx')
          && byFmt.widgets.includes('fmt-xml'), byFmt.widgets.join(', '));
  check('named for the format', byFmt.names.includes('PDF'), byFmt.names.join(', '));
  check('no DBF widget', !byFmt.widgets.includes('fmt-dbf'), byFmt.widgets.join(', '));

  const pdfGroup = await page.evaluate(() => {
    hubOpenGroup('fmt-pdf');
    const btns = Array.from(document.querySelectorAll('.hub-tile'))
      .find(t => t.dataset.hubId === 'form_d')
      ?.querySelectorAll('.hub-btn');
    return {
      rows: document.querySelectorAll('.hub-tile').length,
      formDbtns: Array.from(btns || []).map(b => b.textContent.trim() || b.getAttribute('aria-label')),
      formDeverywhere: document.querySelectorAll('[data-hub-id="form_d"]').length,
    };
  });
  check('a format group lists its documents', pdfGroup.rows > 5, String(pdfGroup.rows));
  // Under a format heading the chip names the format, so the button says
  // "Download" — and the other format's button must not be there.
  check('and each offers only that format',
        pdfGroup.formDbtns.includes('Download') && !pdfGroup.formDbtns.includes('XLSX'),
        pdfGroup.formDbtns.join(', '));
  // Ticking under a format heading captures THAT format for the bundle.
  const fmtSel = await page.evaluate(() => {
    const cb = document.querySelector('.hub-tile .hub-cb');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    return { id: cb.dataset.id, fmt: window._hubSel.get(cb.dataset.id) };
  });
  check('ticking there captures that format', fmtSel.fmt === 'pdf', JSON.stringify(fmtSel));
  // …and the tick survives the re-render that drilling around causes.
  const stuck = await page.evaluate((id) => {
    hubCloseGroup(); hubOpenGroup('fmt-pdf');
    return document.querySelector(`.hub-tile[data-hub-id="${id}"] .hub-cb`)?.checked;
  }, fmtSel.id);
  check('and survives navigating away and back', stuck === true, String(stuck));
  await page.evaluate(() => { hubClearSel(); hubSetGrouping('purpose'); hubCloseGroup(); });
  check('switching back restores the purpose widgets',
        await page.evaluate(() => !!document.querySelector('.hub-w[data-g="preauction"]')));

  // ── [H] Sub-grouping and per-document filters ────────────────────
  console.log('\n[H] subgroups + filters');
  const subs = await page.evaluate(() => {
    hubOpenGroup('tally');
    return Array.from(document.querySelectorAll('.hub-w-sub .hub-w-name'))
      .map(x => x.textContent.trim());
  });
  check('a group splits into subgroup widgets',
        subs.includes('Ledger masters') && subs.includes('Vouchers'), subs.join(', '));

  // The filter panel is offered only where the endpoint reads filters.
  const fBtn = await page.evaluate(() => {
    hubOpenGroup('statutory'); hubOpenSub('Spices Board');
    const onFiltered = !!document.querySelector('[data-hub-id="form_d"] .hub-f-btn');
    hubOpenGroup('reports'); hubOpenSub('Trade & value');
    const onPlain = !!document.querySelector('[data-hub-id="trade_report"] .hub-f-btn');
    hubOpenGroup('statutory'); hubOpenSub('Spices Board');
    return { onFiltered, onPlain };
  });
  check('tiles that accept filters show a filter button', fBtn.onFiltered);
  check('tiles that do not, do not', !fBtn.onPlain);

  const fPanel = await page.evaluate(async () => {
    await hubFilterOpen('form_d');
    const pop = document.getElementById('hub-f-body');
    return { open: document.getElementById('hub-filter-modal').classList.contains('show'),
             keys: Array.from(pop.querySelectorAll('[data-fk]')).map(e => e.dataset.fk) };
  });
  check('the panel offers exactly the declared filters',
        fPanel.open && fPanel.keys.join() === 'branch,sellerId,buyerCode', JSON.stringify(fPanel));

  // The Individual registers' `party` filter matches an exact name
  // server-side, so it must be picked from the master rather than typed.
  const partyPick = await page.evaluate(async () => {
    hubFilterClose();
    hubOpenGroup('books'); hubOpenSub('Individual registers');
    await hubFilterOpen('register_pooler');
    const body = document.getElementById('hub-f-body');
    const wrap = body.querySelector('.hub-f-pick');
    const opts = wrap ? JSON.parse(wrap.dataset.opts || '[]') : [];
    const out = { isText: !!body.querySelector('input[type=text][data-fk="party"]'),
                  isPick: !!wrap, count: opts.length, first: opts[0]?.t };
    if (wrap) {
      const q = wrap.querySelector('.hub-f-q');
      q.value = 'RAMU'; hubPickFilter(q);
      out.hits = wrap.querySelectorAll('.hub-f-opt').length;
    }
    hubFilterClose();
    return out;
  });
  check('the register party field is a picker, not a text box',
        partyPick.isPick && !partyPick.isText, JSON.stringify(partyPick));
  check('populated from the seller master', partyPick.count > 0,
        `${partyPick.count} sellers, first ${partyPick.first}`);
  check('and searchable', partyPick.hits > 0 && partyPick.hits <= partyPick.count,
        `${partyPick.hits} of ${partyPick.count}`);
  await page.evaluate(async () => {
    hubOpenGroup('statutory'); hubOpenSub('Spices Board');
    await hubFilterOpen('form_d');
  });

  // Regression: a picked branch chip vanished. --acc was set on the old
  // popover element and the modal conversion dropped it, so the chip's
  // `background:var(--acc)` resolved to nothing while `color:#fff` still
  // applied. Assert the accent is defined AND that a picked chip contrasts.
  const chipVis = await page.evaluate(() => {
    const modal = document.getElementById('hub-filter-modal');
    const acc = getComputedStyle(modal).getPropertyValue('--acc').trim();
    const chip = modal.querySelector('.hub-f-c');
    if (!chip) return { acc, none: true };
    chip.click();
    const cs = getComputedStyle(chip);
    const rgb = (v) => (v.match(/\d+/g) || []).map(Number);
    const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b);
    const fg = rgb(cs.color), bg = rgb(cs.backgroundColor);
    const transparent = /rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor);
    chip.click();
    return { acc, transparent, delta: Math.abs(lum(fg) - lum(bg)),
             bg: cs.backgroundColor, fg: cs.color };
  });
  check('the filter dialog has a defined accent', !!chipVis.acc, JSON.stringify(chipVis));
  check('and a picked chip is actually visible',
        !chipVis.transparent && chipVis.delta > 60, JSON.stringify(chipVis));

  // It is a real .modal-bg dialog now, not a floating popover. That
  // removed the placing / clipping / scroll-tracking / dismissal code that
  // produced the flicker, the overlap and the self-closing bug — so those
  // regressions are checked here as "it is a modal" instead.
  const geom = await page.evaluate(() => {
    const bg = document.getElementById('hub-filter-modal');
    const box = bg.querySelector('.modal');
    const r = box.getBoundingClientRect();
    return {
      shown: bg.classList.contains('show'),
      fixed: getComputedStyle(bg).position === 'fixed',
      width: Math.round(r.width),
      inView: r.top >= 0 && r.bottom <= window.innerHeight + 1,
      onTop: (() => {
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + 12);
        return !!el && (el === box || box.contains(el));
      })(),
    };
  });
  check('the filter opens as a real modal', geom.shown && geom.fixed, JSON.stringify(geom));
  check('roomy enough to work in', geom.width >= 480, `${geom.width}px`);
  check('fully in view and unobstructed', geom.inView && geom.onTop, JSON.stringify(geom));

  // Party fields are type-to-search, not a 193-entry <select>. Run against
  // `payment`, whose seller filter matches on NAME — form_d's sellerId
  // filters on trader_id, which these fixture lots have no master link to.
  await page.evaluate(() => { hubFilterClose(); });
  const picker = await page.evaluate(async () => {
    await hubFilterOpen('payment');
    const wrap = document.querySelector('#hub-f-body .hub-f-pick');
    if (!wrap) return { found: false };
    const q = wrap.querySelector('.hub-f-q');
    const total = JSON.parse(wrap.dataset.opts || '[]').length;
    q.value = 'SELVI'; hubPickFilter(q);
    const hits = wrap.querySelectorAll('.hub-f-opt');
    return {
      found: true, total, isSelect: !!wrap.querySelector('select'),
      multi: wrap.classList.contains('is-multi'),
      shown: hits.length, first: hits[0]?.textContent.trim(),
    };
  });
  check('the seller field is a search box, not a dropdown',
        picker.found && !picker.isSelect && picker.total > 0, JSON.stringify(picker));
  check('typing narrows the candidates',
        picker.shown > 0 && picker.shown < picker.total && /SELVI/.test(picker.first || ''),
        JSON.stringify(picker));

  // Names repeat; the phone number is often what the office has to hand.
  // Digits are compared digits-only, so punctuation on either side is
  // irrelevant — "98765 43210" finds a seller stored as "+91 98765 43210".
  const byPhone = await page.evaluate(() => {
    const wrap = document.querySelector('#hub-f-body .hub-f-pick');
    const q = wrap.querySelector('.hub-f-q');
    q.value = '9876543210'; hubPickFilter(q);
    const hits = Array.from(wrap.querySelectorAll('.hub-f-opt'));
    q.value = '98765-43210'; hubPickFilter(q);
    const punct = wrap.querySelectorAll('.hub-f-opt').length;
    return { hits: hits.length, first: hits[0]?.dataset.t,
             tel: hits[0]?.querySelector('.hub-f-tel')?.textContent, punct };
  });
  check('a seller can be found by phone number',
        byPhone.hits === 1 && /RAMU/.test(byPhone.first || ''), JSON.stringify(byPhone));
  check('and the number is shown on the option',
        /98765/.test(byPhone.tel || ''), byPhone.tel);
  check('punctuation in the typed number is ignored', byPhone.punct === 1, String(byPhone.punct));
  await page.evaluate(() => {
    const q = document.querySelector('#hub-f-body .hub-f-q');
    q.value = 'SELVI'; hubPickFilter(q);
  });

  // Multi field: picking accumulates tokens and keeps the list open, so a
  // run of sellers can be ticked in one pass.
  const tokens = await page.evaluate(() => {
    const wrap = document.querySelector('#hub-f-body .hub-f-pick');
    wrap.querySelector('.hub-f-opt').click();
    const afterFirst = wrap.querySelectorAll('.hub-f-tok').length;
    const stillOpen = wrap.querySelector('.hub-f-opts').style.display !== 'none';
    const q = wrap.querySelector('.hub-f-q');
    q.value = 'RAMU'; hubPickFilter(q);
    wrap.querySelector('.hub-f-opt')?.click();
    const val = wrap.querySelector('[data-fk]').value;
    wrap.querySelector('.hub-f-tok button').click();      // remove the first
    const afterRemove = wrap.querySelector('[data-fk]').value;
    // Half-typed text must never leak into the value — only a real pick
    // writes to [data-fk]. Checked here rather than in a second evaluate:
    // the panel is anchored to its tile and may close between calls.
    wrap.querySelectorAll('.hub-f-tok button').forEach(b => b.click());
    wrap.querySelector('.hub-f-q').value = 'RAM';         // typed, not chosen
    const halfTyped = wrap.querySelector('[data-fk]').value;
    return { multi: wrap.classList.contains('is-multi'), afterFirst, stillOpen,
             val, afterRemove, halfTyped };
  });
  check('the seller field takes several values', tokens.multi, JSON.stringify(tokens));
  check('picking adds a token and leaves the list open',
        tokens.afterFirst === 1 && tokens.stillOpen, JSON.stringify(tokens));
  check('picking again adds a second, comma-joined',
        (tokens.val || '').split(',').filter(Boolean).length === 2, tokens.val);
  check('removing one drops it from the value',
        (tokens.afterRemove || '').split(',').filter(Boolean).length === 1, tokens.afterRemove);

  check('typing without choosing sets no value', tokens.halfTyped === '', tokens.halfTyped);
  await page.evaluate(async () => { hubFilterClose(); await hubFilterOpen('form_d'); });

  // Regression: the panel used to close itself, because opening it scrolled
  // its tile into view and the dismiss-on-scroll handler caught that.
  // A modal is anchored to nothing, so scrolling the page behind it can
  // neither move it nor close it.
  const survived = await page.evaluate(async () => {
    const before = document.querySelector('#hub-filter-modal .modal').getBoundingClientRect().top;
    window.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 150));
    const box = document.querySelector('#hub-filter-modal .modal');
    return { open: document.getElementById('hub-filter-modal').classList.contains('show'),
             moved: box ? Math.abs(box.getBoundingClientRect().top - before) : -1 };
  });
  check('scrolling behind it neither closes nor moves it',
        survived.open && survived.moved === 0, JSON.stringify(survived));

  const applied = await page.evaluate(() => {
    const pop = document.getElementById('hub-f-body');
    // Branch is a multi field here, so tick two chips.
    const chips = pop.querySelectorAll('.hub-f-c');
    chips[0]?.click(); chips[1]?.click();
    hubFilterApply('form_d');
    const tile = document.querySelector('[data-hub-id="form_d"]');
    return {
      closed: !document.getElementById('hub-filter-modal').classList.contains('show'),
      chip: tile.querySelector('.hub-f-chip')?.textContent.trim(),
      badge: tile.querySelector('.hub-f-n')?.textContent,
      url: hubHref(_hubItem('form_d'), 'pdf'),
      chipCount: chips.length,
    };
  });
  check('applying a filter closes the panel and marks the tile',
        applied.closed && /Branch/.test(applied.chip || '') && applied.badge === '1',
        JSON.stringify(applied));
  // Two branches chosen → the chip counts rather than listing, and the URL
  // carries both, comma-joined, which is what the endpoint parses.
  check('several values show as a count', /2 selected/.test(applied.chip || ''), applied.chip);
  check('and reach the URL comma-joined',
        /[?&]branch=[^&]+%2C/.test(applied.url || ''), applied.url);
  const reset = await page.evaluate(() => {
    hubFilterReset('form_d');
    return { chip: !!document.querySelector('[data-hub-id="form_d"] .hub-f-chip'),
             url: hubHref(_hubItem('form_d'), 'pdf') };
  });
  check('reset clears the chip and the URL',
        !reset.chip && !/branch/.test(reset.url), JSON.stringify(reset));

  // ── [D] Shared trade context ─────────────────────────────────────
  console.log('\n[D] shared trade context');
  const synced = await page.evaluate(async () => {
    const sel = document.getElementById('hub-auction');
    const other = Array.from(sel.options).find(o => o.value !== sel.value);
    sel.value = other.value; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    return { hub: sel.value, shared: getSharedAucId(), topbar: document.getElementById('topbar-trade')?.value };
  });
  check('picking a trade on the hub updates the shared context',
        synced.hub === synced.shared, JSON.stringify(synced));
  check('and moves the topbar selector with it',
        !synced.topbar || synced.topbar === synced.hub, JSON.stringify(synced));

  // Switching to the empty auction must re-gate the documents. Counted
  // from the catalog rather than the DOM: with drill-down only one group
  // is rendered at a time.
  const emptied = await page.evaluate(() => (window._hubCat?.groups || [])
    .reduce((n, g) => n + g.items.filter(i => !i.available).length, 0));
  check('switching to an empty auction locks more documents', emptied > 0,
        `${emptied} locked`);

  // Back to the priced trade, then follow a deep link.
  await page.evaluate(async (id) => {
    const sel = document.getElementById('hub-auction');
    sel.value = String(id); sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
  }, aid9);
  const deep = await page.evaluate(async () => {
    hubOpenGroup('documents'); hubOpenSub('Purchase side');
    document.querySelector('[data-hub-id="bills"] .hub-btn:last-child').click();
    await new Promise(r => setTimeout(r, 700));
    return { tab: window._currentTab, billAuction: document.getElementById('bill-auction')?.value, shared: getSharedAucId() };
  });
  check('Open → navigates to the owning screen', deep.tab === 'bills', deep.tab);

  // Deep-linking out used to be one-way. A pill now offers the way home.
  const back = await page.evaluate(() => {
    const p = document.getElementById('hub-return');
    return { shown: !!p && p.style.display !== 'none', text: p?.textContent.trim() };
  });
  check('and a way back to the Auction Desk appears',
        back.shown && /Back to Auction Desk/.test(back.text || ''), JSON.stringify(back));
  const wentBack = await page.evaluate(() => {
    document.getElementById('hub-return').click();
    return { tab: window._currentTab,
             pill: document.getElementById('hub-return')?.style.display };
  });
  check('clicking it returns to the desk', wentBack.tab === 'hub', JSON.stringify(wentBack));
  check('and the pill retires once you are home', wentBack.pill === 'none', wentBack.pill);
  // It must not linger on screens you navigated to yourself.
  const elsewhere = await page.evaluate(() => {
    hubOpen('bills');                       // arms the pill
    go('traders');                          // …then wander off on your own
    return document.getElementById('hub-return')?.style.display;
  });
  check('and does not follow you elsewhere', elsewhere === 'none', elsewhere);
  await page.evaluate(() => go('hub'));
  await page.waitForFunction(() => document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length > 0,
                             { timeout: 20000 });
  await page.evaluate(() => hubSetView('docs'));
  await page.waitForFunction(() => document.querySelectorAll('#hub-groups .hub-tile').length > 0,
                             { timeout: 20000 });
  check('and that screen is already pointed at the same trade',
        deep.billAuction === deep.shared, JSON.stringify(deep));

  // ── [E] A download really downloads ──────────────────────────────
  console.log('\n[E] download');
  await page.evaluate(() => go('hub'));
  await page.waitForFunction(() => document.querySelectorAll('#hub-groups .hub-tile').length > 0, { timeout: 20000 });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await page.evaluate(() => hubDownload('lot_slip', 'xlsx'));
  let got = '';
  for (let i = 0; i < 40; i++) {
    const f = fs.readdirSync(DL).filter(n => !n.endsWith('.crdownload'));
    if (f.length) { got = f[0]; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  check('clicking a format button downloads a file', !!got, `files: ${fs.readdirSync(DL).join(', ')}`);
  check('the file is non-empty',
        got && fs.statSync(path.join(DL, got)).size > 0, got && String(fs.statSync(path.join(DL, got)).size));

  // ── [F] Bundle ───────────────────────────────────────────────────
  console.log('\n[F] ZIP bundle');
  check('the selection bar is hidden until something is ticked',
        await page.evaluate(() => document.getElementById('hub-selbar').style.display === 'none'));
  check('generated documents are not selectable',
        await page.evaluate(() => { hubOpenGroup('documents'); hubOpenSub('Purchase side');
          return !document.querySelector('[data-hub-id="bills"] .hub-cb'); }));

  const sel = await page.evaluate(() => {
    hubOpenGroup('preauction'); hubOpenSub('Lot lists');
    for (const id of ['lot_slip', 'lot_name']) {
      const cb = document.querySelector(`[data-hub-id="${id}"] .hub-cb`);
      cb.checked = true; cb.dispatchEvent(new Event('change'));
    }
    return {
      shown: document.getElementById('hub-selbar').style.display !== 'none',
      count: document.getElementById('hub-selcount').textContent,
    };
  });
  check('ticking tiles reveals the selection bar', sel.shown);
  check('and it counts them', /2 documents selected/.test(sel.count), sel.count);

  // Pick-all acts on what is on screen — one subgroup, not the whole group.
  // Expected count is DERIVED from the tiles rendered, not hardcoded: the
  // subgroup grows whenever a document is added to the catalog, and a fixed
  // number turns that into a false failure. What must hold is the contract —
  // every selectable tile on screen ends up selected, and nothing else does.
  const picked = await page.evaluate(() => {
    const selectable = document.querySelectorAll('#hub-groups .hub-tile .hub-cb').length;
    hubSelectGroup('preauction');
    return { selectable, size: window._hubSel.size };
  });
  check('"Pick all" selects every ready document on screen',
        picked.selectable > 0 && picked.size === picked.selectable,
        `${picked.size} selected of ${picked.selectable} selectable`);
  // Auction Documents is fully "ready" but nothing in it is bundleable, so
  // offering a Pick-all there would be a button that does nothing.
  check('no Pick-all where nothing is selectable',
        await page.evaluate(() => { hubOpenGroup('documents'); hubOpenSub('Sales side');
          const ok = !/Pick all/.test(document.querySelector('.hub-open-head')?.textContent || '');
          hubOpenGroup('preauction'); hubOpenSub('Lot lists'); return ok; }));

  await page.evaluate(() => hubClearSel());
  check('Clear empties the selection and hides the bar',
        await page.evaluate(() => window._hubSel.size === 0
          && document.getElementById('hub-selbar').style.display === 'none'));

  // Build a real ZIP through the job + poll flow.
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });
  await page.evaluate(() => {
    // dealer_list is a Party list, so tick across two subgroups to prove a
    // selection survives moving between them.
    hubOpenGroup('preauction'); hubOpenSub('Lot lists');
    for (const id of ['lot_slip', 'lot_name']) {
      const cb = document.querySelector(`[data-hub-id="${id}"] .hub-cb`);
      cb.checked = true; cb.dispatchEvent(new Event('change'));
    }
    hubOpenSub('Party lists');
    for (const id of ['dealer_list']) {
      const cb = document.querySelector(`[data-hub-id="${id}"] .hub-cb`);
      cb.checked = true; cb.dispatchEvent(new Event('change'));
    }
    hubBundle();
  });
  let zip = '';
  for (let i = 0; i < 120; i++) {
    const f = fs.readdirSync(DL).filter(n => n.endsWith('.zip'));
    if (f.length) { zip = f[0]; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  check('the bundle downloads as a ZIP', !!zip, `files: ${fs.readdirSync(DL).join(', ')}`);
  check('named after the auction', /Auction_\w+_Documents\.zip/.test(zip), zip);
  const zbuf = zip ? fs.readFileSync(path.join(DL, zip)) : Buffer.alloc(0);
  check('holding all three documents',
        zbuf.slice(0, 2).toString() === 'PK'
          && ['LotSlip', 'LotName', 'DealerList'].every(n => zbuf.toString('latin1').includes(n)),
        `${zbuf.length} bytes`);
  check('and the selection clears once it lands',
        await page.evaluate(() => window._hubSel.size === 0));

  // ── [T] Tally party / document-number pickers ────────────────────
  // A Tally filter matches the BUILT voucher rows, not a master — so the
  // picker's options come from the export itself and only exist once the
  // documents have been generated. Generated here, at the end, so every
  // check above still runs against the ungenerated fixture.
  console.log('\n[T] Tally pickers');
  await api('POST', `/api/bills/generate-all/${aid9}`, { startBillNo: 1 });
  // Sales vouchers need buyers on the lots — and their party is the BUYER,
  // not the planter, which is the whole reason that field needed its own
  // accessor server-side.
  {
    const lots = (await api('GET', `/api/lots/${aid9}`)).d || [];
    const priced = lots.filter(l => Number(l.price) > 0).slice(0, 2);
    for (const [i, l] of priced.entries()) {
      const b = i === 0 ? 'ARJUN TRADERS' : 'KUMAR EXPORTS';
      await api('PUT', `/api/lots/${l.id}`, { buyer: b, buyer1: b, invoice_group: 0 });
    }
    await api('POST', `/api/invoices/generate-all/${aid9}`, { startInvoiceNo: 1 });
  }
  await page.evaluate(() => hubRefresh());
  await page.waitForFunction(() => !!window._hubCat, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 600));

  const tallyPick = await page.evaluate(async () => {
    hubOpenGroup('tally'); hubOpenSub('Vouchers');
    await hubFilterOpen('tally_urd_purchase');
    const body = document.getElementById('hub-f-body');
    const read = (fk) => {
      const hidden = body.querySelector(`[data-fk="${fk}"]`);
      const wrap = hidden ? hidden.closest('.hub-f-pick') : null;
      return {
        isText: !!body.querySelector(`input[type=text][data-fk="${fk}"]`),
        isPick: !!wrap,
        multi: !!(wrap && wrap.classList.contains('is-multi')),
        opts: wrap ? JSON.parse(wrap.dataset.opts || '[]') : [],
      };
    };
    const party = read('party'), invoice = read('invoice');
    // Type into the party box and count what survives the search.
    let hits = 0;
    const hidden = body.querySelector('[data-fk="party"]');
    const wrap = hidden && hidden.closest('.hub-f-pick');
    if (wrap) {
      const q = wrap.querySelector('.hub-f-q');
      q.value = 'RAMU'; hubPickFilter(q);
      hits = wrap.querySelectorAll('.hub-f-opt').length;
    }
    const labels = Array.from(body.querySelectorAll('.hub-f-row > span'))
      .map(s => s.firstChild.textContent.trim());
    hubFilterClose();
    return { party, invoice, hits, labels };
  });
  check('the Tally party field is a picker, not a text box',
        tallyPick.party.isPick && !tallyPick.party.isText, JSON.stringify(tallyPick.party).slice(0, 200));
  check('offering the parties in this export',
        tallyPick.party.opts.length > 0, `${tallyPick.party.opts.length} parties`);
  check('and searchable',
        tallyPick.hits > 0 && tallyPick.hits <= tallyPick.party.opts.length,
        `${tallyPick.hits} of ${tallyPick.party.opts.length}`);
  check('the invoice field is a picker too',
        tallyPick.invoice.isPick && !tallyPick.invoice.isText, JSON.stringify(tallyPick.invoice).slice(0, 200));
  check('offering real document numbers',
        tallyPick.invoice.opts.length > 0, JSON.stringify(tallyPick.invoice.opts.slice(0, 4)));
  check('both stay multi-select', tallyPick.party.multi && tallyPick.invoice.multi);
  check('and the number field is named for what it covers',
        tallyPick.labels.includes('Invoice / Note no'), tallyPick.labels.join(' | '));

  // Sales Vouchers separately: its party is the buyer, held on a different
  // row field, so it is the one that silently fell back to a text box.
  const salesPick = await page.evaluate(async () => {
    hubFilterClose();
    hubOpenGroup('tally'); hubOpenSub('Vouchers');
    await hubFilterOpen('tally_sales_isp');
    const body = document.getElementById('hub-f-body');
    const hidden = body.querySelector('[data-fk="party"]');
    const wrap = hidden && hidden.closest('.hub-f-pick');
    const out = {
      isText: !!body.querySelector('input[type=text][data-fk="party"]'),
      isPick: !!wrap,
      opts: wrap ? JSON.parse(wrap.dataset.opts || '[]') : [],
      keys: Array.from(body.querySelectorAll('[data-fk]')).map(e => e.dataset.fk),
    };
    hubFilterClose();
    return out;
  });
  check('the Sales Vouchers party field is a picker, not a text box',
        salesPick.isPick && !salesPick.isText, JSON.stringify(salesPick).slice(0, 240));
  check('offering the buyers it actually invoices',
        salesPick.opts.length > 0 && salesPick.opts.some(o => /ARJUN|KUMAR/.test(o.t)),
        JSON.stringify(salesPick.opts.map(o => o.t)));
  check('alongside sale type and invoice',
        salesPick.keys.join() === 'sale,party,invoice', salesPick.keys.join());

  // The options are gathered AFTER the sale filter runs, so changing the
  // sale type has to rebuild them — otherwise the list offers parties the
  // export just dropped, and picking one downloads nothing.
  const saleRefresh = await page.evaluate(async () => {
    hubOpenGroup('tally'); hubOpenSub('Vouchers');
    await hubFilterOpen('tally_sales_isp');
    const body = document.getElementById('hub-f-body');
    const before = (body.querySelector('[data-fk="party"]') || {}).dataset ? 1 : 0;
    // Tick a sale-type chip; the dialog must re-open with fresh lists.
    const chip = body.querySelector('.hub-f-c');
    const had = !!chip;
    if (chip) { chip.click(); await new Promise(r => setTimeout(r, 700)); }
    const after = document.getElementById('hub-f-body');
    const saleVal = (after.querySelector('[data-fk="sale"]') || {}).value;
    const partyVal = (after.querySelector('[data-fk="party"]') || {}).value;
    const open = document.getElementById('hub-filter-modal').classList.contains('show');
    hubFilterClose();
    return { before, had, saleVal, partyVal, open };
  });
  check('picking a sale type keeps the dialog open', saleRefresh.open, JSON.stringify(saleRefresh));
  check('and carries the sale choice forward',
        !saleRefresh.had || !!saleRefresh.saleVal, JSON.stringify(saleRefresh));
  check('while dropping party picks made against the old list',
        !saleRefresh.partyVal, JSON.stringify(saleRefresh));

  // ── [P] Plain mode, and who may open the desk at all ─────────────
  console.log('\n[P] plain mode + access');
  const plain = await page.evaluate(() => {
    const grab = () => {
      const w = document.querySelector('.hub-w');
      const cs = getComputedStyle(w);
      return { bg: cs.backgroundImage, colour: cs.color,
               border: cs.borderTopWidth,
               bar: getComputedStyle(w, '::before').backgroundImage };
    };
    hubCloseGroup();
    const before = grab();
    hubTogglePlain();
    const after = grab();
    const label = document.getElementById('hub-plain-label').textContent.trim();
    return { before, after, label, attr: document.body.getAttribute('data-hub-plain') };
  });
  check('plain mode drops the gradients',
        /gradient/.test(plain.before.bg) && !/gradient/.test(plain.after.bg),
        JSON.stringify(plain).slice(0, 200));
  check('and gives the cards a border and dark text instead of white on colour',
        parseFloat(plain.after.border) >= 1 && !/255, 255, 255/.test(plain.after.colour),
        JSON.stringify(plain.after));
  check('the toggle offers the way back', plain.label === 'Colour' && plain.attr === '1',
        JSON.stringify(plain));

  // Every action must still be legible against its own background — the
  // whole point of plain mode is that it reads well, not that it is grey.
  const plainContrast = await page.evaluate(() => {
    hubOpenGroup('preauction'); hubOpenSub('Lot lists');
    const rgb = (v) => (v.match(/\d+/g) || []).map(Number);
    const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b);
    return Array.from(document.querySelectorAll('.hub-tile .hub-btn')).map(b => {
      const cs = getComputedStyle(b);
      const fg = rgb(cs.color), bg = rgb(cs.backgroundColor);
      const solid = !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor);
      return { label: b.textContent.trim() || b.getAttribute('aria-label'),
               d: solid ? Math.abs(lum(fg) - lum(bg)) : 999 };
    }).filter(x => x.d < 60);
  });
  check('and nothing goes invisible in plain mode',
        plainContrast.length === 0, JSON.stringify(plainContrast));

  // Plain mode's greys are TINTED with the live theme primary, so its
  // contrast is no longer a single fixed pair — a light primary (sunshine,
  // ocean) mixed into the ink lifts its luminance. Re-run the same check on
  // every theme rather than trusting the default one to speak for all 13.
  const themeContrast = await page.evaluate(() => {
    const rgb = (v) => (v.match(/\d+/g) || []).map(Number);
    const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b);
    const bad = [];
    const themes = (typeof _THEMES !== 'undefined' && _THEMES.length)
      ? _THEMES
      : ['emerald','coral','violet','sunshine','electric','ocean','tech','minimal','trust','rose','indigo','teal','slate'];
    const was = document.body.getAttribute('data-theme') || 'emerald';
    for (const t of themes) {
      document.body.setAttribute('data-theme', t);
      for (const b of document.querySelectorAll('.hub-tile .hub-btn')) {
        const cs = getComputedStyle(b);
        if (/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor)) continue;
        const d = Math.abs(lum(rgb(cs.color)) - lum(rgb(cs.backgroundColor)));
        if (d < 60) bad.push({ theme: t, label: (b.textContent || '').trim().slice(0, 20), d: Math.round(d) });
      }
      // The one place plain mode deliberately shows the most theme: the KPI
      // card's accent bar. It must still read as a rule against the card.
      const w = document.querySelector('.hub-w');
      if (w) {
        const bar = rgb(getComputedStyle(w, '::before').backgroundColor);
        const card = rgb(getComputedStyle(w).backgroundColor);
        if (bar.length === 3 && card.length === 3 && Math.abs(lum(bar) - lum(card)) < 40) {
          bad.push({ theme: t, label: 'kpi accent bar', d: Math.round(Math.abs(lum(bar) - lum(card))) });
        }
      }
    }
    document.body.setAttribute('data-theme', was);
    return bad;
  });
  check('plain mode stays legible on EVERY theme, not just the default',
        themeContrast.length === 0, JSON.stringify(themeContrast).slice(0, 400));

  // The tint has to actually track the theme — a palette that ignored
  // --spice-saffron would pass the contrast check above while still looking
  // foreign next to a coral or violet rail.
  const tintTracks = await page.evaluate(() => {
    const read = () => getComputedStyle(document.body).getPropertyValue('--hub-p-ink').trim();
    const was = document.body.getAttribute('data-theme') || 'emerald';
    document.body.setAttribute('data-theme', 'emerald'); const a = read();
    document.body.setAttribute('data-theme', 'coral');   const b = read();
    document.body.setAttribute('data-theme', 'violet');  const c = read();
    document.body.setAttribute('data-theme', was);
    return { a, b, c };
  });
  check('the plain greys re-tint when the theme changes',
        tintTracks.a && tintTracks.a !== tintTracks.b && tintTracks.b !== tintTracks.c,
        JSON.stringify(tintTracks));

  const restored = await page.evaluate(() => {
    hubTogglePlain();
    return { attr: document.body.getAttribute('data-hub-plain'),
             bg: getComputedStyle(document.querySelector('.hub-tile')).backgroundImage };
  });
  check('toggling back restores the colour scheme',
        restored.attr === '0' && /gradient/.test(restored.bg), JSON.stringify(restored));

  // Access: the desk is for managers and admins. A viewer must not reach
  // it — the sidebar item hidden is not the same as the screen unreachable.
  const denied = await page.evaluate(() => {
    const realPerms = window._userPerms;
    window._userPerms = new Set(['view', 'export']);   // a viewer
    applyPermissionAttributes();
    const sidebar = document.querySelector('.side-item[data-tab="hub"]');
    const hidden = getComputedStyle(sidebar).display === 'none';
    go('hub');
    const landedOn = window._currentTab;
    const landing = _landingTab();
    window._userPerms = realPerms;                     // put it back
    applyPermissionAttributes();
    return { hidden, landedOn, landing };
  });
  check('a viewer does not see the Auction Desk in the sidebar', denied.hidden,
        JSON.stringify(denied));
  check('and cannot open it even by calling go()', denied.landedOn === 'dash',
        JSON.stringify(denied));
  check('nor land on it at sign-in', denied.landing === 'dash', JSON.stringify(denied));
  await page.evaluate(() => go('hub'));
  await page.waitForFunction(() => document.querySelectorAll('.hub-w').length > 0
    || document.querySelectorAll('#hub-lot-rows tr').length > 0, { timeout: 20000 });

  // ── [A2] The home-screen preference ──────────────────────────────
  // Checked on BOTH paths into the app, because each calls _landingTab()
  // separately: restoring a saved token on page load, and a fresh sign-in.
  console.log('\n[A2] home-screen preference');
  await page.evaluate(() => hubSetHome('dash'));

  // Path 1 — reload with the token still in localStorage (session restore).
  // A fresh document also resets _currentTab, so waiting on it is sound
  // here in a way it is not after an in-page logout.
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block'
                                   && !!window._currentTab, { timeout: 20000 });
  check('a restored session honours Dashboard as home',
        await page.evaluate(() => window._currentTab) === 'dash',
        await page.evaluate(() => window._currentTab));

  // Path 2 — sign out and back in.
  await page.evaluate(() => { window._currentTab = null; logout(); });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await signIn();
  check('a fresh sign-in honours it too',
        await page.evaluate(() => window._currentTab) === 'dash',
        await page.evaluate(() => window._currentTab));

  check('the Auction Desk is still reachable from the sidebar',
        await page.evaluate(() => { go('hub'); return window._currentTab === 'hub'; }));

  // And switching back restores the default.
  await page.evaluate(() => hubSetHome('hub'));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block'
                                   && !!window._currentTab, { timeout: 20000 });
  check('switching the preference back lands on the Auction Desk again',
        await page.evaluate(() => window._currentTab) === 'hub',
        await page.evaluate(() => window._currentTab));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-3000)); cleanup(); process.exit(1); });
