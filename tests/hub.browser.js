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
    const r = await api('POST', '/api/lots', { auction_id: aid9, lot_no, name, qty, grade: '1', bags: 8, crop: 'CARDAMOM' });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    await api('PUT', `/api/lots/${id}`, { price, amount: qty * price });
  }
  // …plus enough filler to span more than one page at the smallest size.
  for (let i = 1; i <= 30; i++) {
    await api('POST', '/api/lots', { auction_id: aid9, lot_no: String(300 + i),
      name: 'FILLER ' + i, qty: 10, grade: '1', bags: 1, crop: 'CARDAMOM' });
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
  await page.waitForFunction(() => document.querySelectorAll('#hub-kpi .stat').length === 8,
                             { timeout: 20000 }).catch(() => {});
  check('and the KPI strip is populated on this view too',
        await page.evaluate(() => document.querySelectorAll('#hub-kpi .stat').length) === 8);

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

  // Escape closes the drawer.
  await page.evaluate(() => document.querySelector('#hub-lot-rows tr[data-lot-id]').click());
  await page.keyboard.press('Escape');
  check('Escape closes the drawer',
        await page.evaluate(() => document.getElementById('hub-lot-drawer').style.display === 'none'));

  // ── Switch to Documents ──────────────────────────────────────────
  await page.evaluate(() => hubSetView('docs'));
  await page.waitForFunction(() => document.querySelectorAll('#hub-groups .hub-tile').length > 0, { timeout: 20000 });
  check('the Documents tab shows the document grid',
        await page.evaluate(() => document.getElementById('hub-view-docs').style.display !== 'none'
          && document.getElementById('hub-view-lots').style.display === 'none'));

  // ── [B] Tiles come from the catalog ──────────────────────────────
  console.log('\n[B] tiles painted from the catalog');
  const shape = await page.evaluate(() => ({
    tiles:   document.querySelectorAll('#hub-groups .hub-tile').length,
    groups:  document.querySelectorAll('#hub-groups .hub-sec').length,
    locked:  document.querySelectorAll('#hub-groups .hub-tile.is-locked').length,
    apiTiles: (window._hubCat?.groups || []).reduce((n, g) => n + g.items.length, 0),
    kpis:    document.querySelectorAll('#hub-kpi .stat').length,
  }));
  check('every catalog item became a tile',
        shape.tiles === shape.apiTiles && shape.tiles > 50,
        `${shape.tiles} tiles vs ${shape.apiTiles} from the API`);
  check('tiles are grouped', shape.groups >= 8, `${shape.groups} groups`);
  check('the KPI strip is populated', shape.kpis === 8, `${shape.kpis} figures`);
  check('KPI reads the lot count from the auction',
        await page.evaluate(() => (document.querySelector('#hub-kpi .stat .n')?.textContent || '').trim() === '32'),
        await page.evaluate(() => document.querySelector('#hub-kpi .stat .n')?.textContent));

  // Locked tiles must be VISIBLE and self-explaining — the point of the hub.
  check('stage-locked tiles are rendered, not hidden', shape.locked > 0, `${shape.locked} locked`);
  const lock = await page.evaluate(() => {
    const t = document.querySelector('.hub-tile.is-locked');
    return { shown: !!(t && t.offsetParent !== null), reason: t?.querySelector('.hub-lock')?.textContent || '' };
  });
  check('a locked tile is on screen', lock.shown);
  check('a locked tile states its reason', lock.reason.trim().length > 8, lock.reason);
  check('nothing flagged off is rendered',
        await page.evaluate(() => !document.querySelector('[data-hub-id="debit_notes"]')));

  // Preview/Print are icon-only, so they are identified by aria-label. The
  // action row must also fit on ONE line — spelled out it wrapped and made
  // every tile in the grid taller.
  const acts = await page.evaluate(() => {
    const t = document.querySelector('[data-hub-id="lot_slip"]');
    const btns = Array.from(t?.querySelectorAll('.hub-btn') || []);
    const rows = new Set(btns.map(b => b.getBoundingClientRect().top));
    return {
      labels: btns.map(b => b.textContent.trim() || b.getAttribute('aria-label')),
      rows: rows.size,
    };
  });
  check('an available tile offers its formats plus Preview/Print',
        ['XLSX', 'PDF', 'Preview', 'Print'].every(l => acts.labels.includes(l)),
        acts.labels.join(', '));
  check('and the action row fits on one line', acts.rows === 1, `${acts.rows} rows`);

  // ── [C] Filter ───────────────────────────────────────────────────
  console.log('\n[C] filter');
  await page.evaluate(() => { document.getElementById('hub-filter').value = 'tally'; hubApplyFilter(); });
  const filtered = await page.evaluate(() => ({
    visible: Array.from(document.querySelectorAll('.hub-tile')).filter(t => t.style.display !== 'none').length,
    emptyGroupsShown: Array.from(document.querySelectorAll('.hub-sec'))
      .filter(s => s.style.display !== 'none'
        && !Array.from(s.querySelectorAll('.hub-tile')).some(t => t.style.display !== 'none')).length,
    tallyOpen: !document.getElementById('hub-sec-tally')?.classList.contains('is-collapsed'),
  }));
  check('filtering narrows the tiles', filtered.visible > 0 && filtered.visible < shape.tiles,
        `${filtered.visible} of ${shape.tiles}`);
  check('groups with no match hide themselves', filtered.emptyGroupsShown === 0);
  check('a collapsed group opens to reveal its matches', filtered.tallyOpen);
  await page.evaluate(() => hubComboClear());
  check('clearing the filter restores every tile',
        await page.evaluate(() => Array.from(document.querySelectorAll('.hub-tile')).filter(t => t.style.display !== 'none').length) === shape.tiles);

  // The dropdown half: every document listed by name, grouped, and picking
  // one shows just that document.
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
  check('the dropdown lists every document', combo.open && combo.opts === shape.tiles,
        `${combo.opts} options vs ${shape.tiles} tiles`);
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
    return {
      count: vis.length, id: vis[0]?.dataset.hubId,
      value: document.getElementById('hub-filter').value,
      closed: document.getElementById('hub-combo-list').style.display === 'none',
      sectionOpen: !document.getElementById('hub-sec-statutory')?.classList.contains('is-collapsed'),
    };
  });
  check('picking a document shows only that one',
        combopick.count === 1 && combopick.id === 'form_d', JSON.stringify(combopick));
  check('its name lands in the box and the list closes',
        /FORM-D/.test(combopick.value) && combopick.closed, JSON.stringify(combopick));
  check('and its group is opened to reveal it', combopick.sectionOpen);
  await page.evaluate(() => hubComboClear());
  check('clearing the pick restores every tile',
        await page.evaluate(() => Array.from(document.querySelectorAll('.hub-tile')).filter(t => t.style.display !== 'none').length) === shape.tiles);

  // ── [G] Group the documents by file type ─────────────────────────
  console.log('\n[G] grouping by file type');
  const byFmt = await page.evaluate(() => {
    hubSetGrouping('format');
    const secs = Array.from(document.querySelectorAll('#hub-groups .hub-sec'));
    return {
      groups: secs.map(x => x.dataset.g),
      heads:  secs.map(x => x.querySelector('.hub-sec-name')?.textContent.trim()),
      pdfTiles: document.querySelectorAll('#hub-sec-fmt-pdf .hub-tile').length,
      // A tile under a format heading offers that ONE format.
      firstPdfBtns: Array.from(document.querySelectorAll('#hub-sec-fmt-pdf .hub-tile .hub-btn'))
        .slice(0, 3).map(b => b.textContent.trim() || b.getAttribute('aria-label')),
      // Form D exists as both PDF and XLSX, so it must appear under both.
      formDTwice: document.querySelectorAll('[data-hub-id="form_d"]').length,
    };
  });
  check('the documents regroup by file type',
        byFmt.groups.includes('fmt-pdf') && byFmt.groups.includes('fmt-xlsx')
          && byFmt.groups.includes('fmt-xml'), byFmt.groups.join(', '));
  check('headings are named for the format', byFmt.heads.includes('PDF'), byFmt.heads.join(', '));
  check('a two-format document appears under both', byFmt.formDTwice === 2, String(byFmt.formDTwice));
  check('and each tile offers only that heading\'s format',
        byFmt.firstPdfBtns[0] === 'PDF' && !byFmt.firstPdfBtns.includes('XLSX'),
        byFmt.firstPdfBtns.join(', '));
  // Ticking under a format heading must bundle THAT format.
  const fmtSel = await page.evaluate(() => {
    const cb = document.querySelector('#hub-sec-fmt-pdf .hub-tile .hub-cb');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    return { id: cb.dataset.id, fmt: window._hubSel.get(cb.dataset.id) };
  });
  check('ticking a tile there captures that format for the bundle',
        fmtSel.fmt === 'pdf', JSON.stringify(fmtSel));
  await page.evaluate(() => { hubClearSel(); hubSetGrouping('purpose'); });
  check('switching back restores the purpose groups',
        await page.evaluate(() => !!document.getElementById('hub-sec-preauction')));
  check('no DBF section in either grouping',
        await page.evaluate(() => {
          const none = () => !document.getElementById('hub-sec-dbf')
                           && !document.getElementById('hub-sec-fmt-dbf');
          if (!none()) return false;
          hubSetGrouping('format'); const ok = none(); hubSetGrouping('purpose');
          return ok;
        }));
  // Each group scrolls on its own so ten open groups stay navigable.
  check('each document group has its own scroll box',
        await page.evaluate(() => {
          const b = document.querySelector('.hub-sec-body');
          return b && getComputedStyle(b).overflowY === 'auto';
        }));

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

  // Switching to the empty trade must re-gate the tiles.
  const emptied = await page.evaluate(() => document.querySelectorAll('.hub-tile.is-locked').length);
  check('switching to an empty trade locks more tiles', emptied > shape.locked,
        `${emptied} locked vs ${shape.locked} on the priced trade`);

  // Back to the priced trade, then follow a deep link.
  await page.evaluate(async (id) => {
    const sel = document.getElementById('hub-auction');
    sel.value = String(id); sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
  }, aid9);
  const deep = await page.evaluate(async () => {
    document.querySelector('[data-hub-id="bills"] .hub-btn:last-child').click();
    await new Promise(r => setTimeout(r, 700));
    return { tab: window._currentTab, billAuction: document.getElementById('bill-auction')?.value, shared: getSharedAucId() };
  });
  check('Open → navigates to the owning screen', deep.tab === 'bills', deep.tab);
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
  check('generated-document tiles are not selectable',
        await page.evaluate(() => !document.querySelector('[data-hub-id="bills"] .hub-cb')));

  const sel = await page.evaluate(() => {
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

  const picked = await page.evaluate(() => {
    hubSelectGroup('preauction');
    return window._hubSel.size;
  });
  check('"Pick all" selects every ready tile in the group', picked === 7, String(picked));
  // Trade Documents is fully "ready" but nothing in it is bundleable, so
  // offering a Pick-all there would be a button that does nothing.
  check('no Pick-all on a group with nothing selectable',
        await page.evaluate(() =>
          !/Pick all/.test(document.querySelector('#hub-sec-documents .hub-sec-head')?.textContent || '')));

  await page.evaluate(() => hubClearSel());
  check('Clear empties the selection and hides the bar',
        await page.evaluate(() => window._hubSel.size === 0
          && document.getElementById('hub-selbar').style.display === 'none'));

  // Build a real ZIP through the job + poll flow.
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });
  await page.evaluate(() => {
    for (const id of ['lot_slip', 'lot_name', 'dealer_list']) {
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
