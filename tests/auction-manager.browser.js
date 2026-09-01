// AUCTION MANAGER — the screen, driven in a real headless Chrome.
//
// tests/auction-manager.http.js proves the gate and the arithmetic. This
// proves the screen built on top of them behaves:
//
//   [A] the sidebar entry follows flag_auction_manager, and the Auction
//       Desk's separate role gate is unaffected either way
//   [B] the header and the eight-cell stat band paint from the API
//   [C] the filter box narrows the table, and Clear restores it
//   [D] the sub-tabs split sellers into planters vs traders by GSTIN
//   [E] the trade selection is the shared one — the topbar moves the screen
//
// Writes a full-page screenshot to /tmp for eyeballing against the design.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ui-'));
const PORT = 47366;
const B = `http://127.0.0.1:${PORT}`;
const SHOT = process.env.AM_SHOT || path.join(os.tmpdir(), 'auction-manager.png');

// How many tiles the Auction Downloads screen should paint, per section.
// Counted out of AMR_SECTIONS rather than hard-coded: the list grows whenever
// a report gains a tile, and the literals here silently went stale — 35 total
// and 13/15/6/1 per section while the screen actually rendered 39 as 15/17/6/1
// — so the wait below timed out instead of checking anything. What these
// assertions are really for is that the SCREEN renders every tile the manifest
// declares, in the agreed four sections; that is what this compares.
function amrSectionCounts() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const start = html.indexOf('const AMR_SECTIONS = [');
  if (start < 0) throw new Error('AMR_SECTIONS not found in index.html');
  const body = html.slice(start, html.indexOf('\n];', start) + 3);
  const heads = [...body.matchAll(/\{\s*title:\s*'([^']+)',\s*items:\s*\[/g)];
  return heads.map((h, i) => {
    const text = body.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : body.length);
    return [...text.matchAll(/^\s*\{\s*label:\s*'/gm)].length;
  });
}
const AMR_SECTION_COUNTS = amrSectionCounts();
const AMR_TILES = AMR_SECTION_COUNTS.reduce((s, n) => s + n, 0);

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
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  // The Tally/debit-note flags gate four of the Auction Downloads tiles;
  // switch them on so the default assertions cover the fully-enabled screen.
  // [F] toggles one back off to prove the gating still bites.
  await api('PUT', '/api/company-settings', { settings: {
    flag_auction_manager: 'true', flag_debit_note: 'true',
    flag_debit_note_planter: 'true', flag_merchants: 'true',
  }});

  // A buyer in the master, so the Billing Address column has a place to
  // resolve ("<trade name> - <place>") rather than falling back to the name.
  await api('POST', '/api/buyers', {
    buyer: 'THAMARASSERIYIL SPICES POINT', buyer1: 'THAMARASSERIYIL SPICES POINT',
    code: 'B1', pla: 'POTHINKANDAM', state: 'KERALA', st_code: '32',
  });
  await api('POST', '/api/buyers', {
    buyer: 'ANKIT SPICES', buyer1: 'ANKIT SPICES',
    code: 'B2', pla: 'BODINAYAKANUR', state: 'TAMIL NADU', st_code: '33',
  });

  // Two trades so [E] has something to switch to.
  const mk = async (ano, date) => (await api('POST', '/api/auctions', { ano, date, crop_type: 'VST' })).d.id;
  const AID = await mk('13', '2026-08-08');
  const AID2 = await mk('14', '2026-08-15');

  await api('POST', `/api/auctions/${AID}/allocations`, {
    allocations: [{ branch: 'MAIN', start_lot: '1', end_lot: '20' }],
  });
  const seed = [
    { lot_no: '1',  name: 'ELAICHIROYAL PRIVATE LIMITED', cr: 'GSTIN.32AAHCE4551A1Z8', qty: 292.6, bags: 6, price: 3756, code: 'B1', buyer: 'THAMARASSERIYIL SPICES POINT' },
    { lot_no: '10', name: 'JISS JOSEPH',                  cr: 'CR.',                   qty: 54.3,  bags: 1, price: 2561, code: 'B2', buyer: 'ANKIT SPICES' },
    { lot_no: '11', name: 'BINOY MATHEW',                 cr: 'CR.',                   qty: 282.5, bags: 6, price: 2921, code: 'B2', buyer: 'ANKIT SPICES' },
    { lot_no: '12', name: 'BINOY MATHEW',                 cr: 'CR.',                   qty: 273.6, bags: 6, price: 2906, code: 'B2', buyer: 'ANKIT SPICES' },
    { lot_no: '14', name: 'ABUBAKKAR SIDDIQ M',           cr: 'CR.',                   qty: 31.3,  bags: 1, price: 2322, code: 'WD', buyer: '' },
    { lot_no: '15', name: 'JAINULABDEEN A',               cr: 'CR.27771/2000',         qty: 137.4, bags: 3, price: 2575, code: 'B2', buyer: 'ANKIT SPICES' },
  ];
  for (const s of seed) {
    const r = await api('POST', '/api/lots', {
      auction_id: AID, lot_no: s.lot_no, branch: 'MAIN', name: s.name, cr: s.cr, bags: s.bags, qty: s.qty,
    });
    if (r.status !== 200 || !r.d || !r.d.lot) { console.log('seed failed ' + JSON.stringify(r.d)); cleanup(); process.exit(1); }
    await api('PUT', `/api/lots/${r.d.lot.id}`, {
      price: s.price, amount: +(s.qty * s.price).toFixed(2), code: s.code,
      buyer: s.buyer, buyer1: s.buyer, invo: s.code === 'WD' ? '' : '1',
    });
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
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  await page.waitForFunction(() => document.body.hasAttribute('data-feat-whatsapp') && !!window._currentTab, { timeout: 20000 });

  // ── [A] Sidebar gate ─────────────────────────────────────────────
  console.log('[A] sidebar gate');
  const shown = await page.evaluate(() => {
    const b = document.querySelector('.side-item[data-tab="auctionmgr"]');
    return b ? getComputedStyle(b).display !== 'none' : null;
  });
  check('entry visible with flag ON', shown === true, 'got ' + shown);

  await api('PUT', '/api/company-settings', { settings: { flag_auction_manager: 'false' } });
  await page.evaluate(() => applyFeatureFlags());
  await page.waitForFunction(() => document.body.getAttribute('data-feat-auction-manager') === '0', { timeout: 10000 });
  const hidden = await page.evaluate(() => {
    const b = document.querySelector('.side-item[data-tab="auctionmgr"]');
    return b ? getComputedStyle(b).display === 'none' : null;
  });
  check('entry hidden with flag OFF', hidden === true, 'got ' + hidden);
  const deskStill = await page.evaluate(() => {
    const b = document.querySelector('.side-item[data-tab="hub"]');
    return b ? getComputedStyle(b).display !== 'none' : null;
  });
  check('Auction Desk unaffected by this flag', deskStill === true, 'got ' + deskStill);

  await api('PUT', '/api/company-settings', { settings: { flag_auction_manager: 'true' } });
  await page.evaluate(() => applyFeatureFlags());
  await page.waitForFunction(() => document.body.getAttribute('data-feat-auction-manager') === '1', { timeout: 10000 });

  // ── [B] Header + stat band ───────────────────────────────────────
  console.log('[B] header and stat band');
  await page.evaluate(() => go('auctionmgr'));
  await page.waitForFunction(() => document.querySelectorAll('#am-stats .am-stat').length === 8, { timeout: 15000 });
  // The screen may have landed on either trade; drive it to #13 explicitly.
  await page.evaluate((id) => {
    const s = document.getElementById('am-auction');
    s.value = String(id); s.dispatchEvent(new Event('change'));
  }, AID);
  await page.waitForFunction(() => /Auction 13/.test(document.getElementById('am-ano')?.textContent || ''), { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#am-body table.am-tbl tbody tr').length === 6, { timeout: 15000 });

  const band = await page.evaluate(() => ({
    ano:   document.getElementById('am-ano').textContent.trim(),
    date:  document.getElementById('am-date').textContent.trim(),
    value: document.getElementById('am-value').textContent.trim(),
    cells: Array.from(document.querySelectorAll('#am-stats .am-stat')).map(c => c.textContent.trim()),
  }));
  check('auction heading', band.ano === 'Auction 13', band.ano);
  check('date line rendered', /^Date: \S+/.test(band.date), band.date);
  //   292.6*3756 = 1,099,005.60   282.5*2921 =   825,182.50
  //    54.3*2561 =   139,062.30   273.6*2906 =   795,081.60
  //   137.4*2575 =   353,805.00   ────────────────────────────
  // The WD lot (31.3 @ 2322) is excluded → 3,212,137.00
  check('total value formatted in lakh-grouped rupees',
        band.value === '₹ 32,12,137.00', band.value);
  check('eight stat cells', band.cells.length === 8, JSON.stringify(band.cells));
  check('allocated lots from ranges (1-20 → 20)', band.cells[0] === 'Allocated Lots: 20', band.cells[0]);
  check('sold lots excludes the WD lot', band.cells[1] === 'Sold Lots: 5', band.cells[1]);
  check('booked lots', band.cells[2] === 'Booked Lots: 6', band.cells[2]);
  check('sold weight to 3dp', band.cells[3] === 'Sold Weight: 1040.400', band.cells[3]);
  check('planters counted', band.cells[4] === 'Total planters: 5', band.cells[4]);
  check('buyers counted', band.cells[5] === 'Total Buyers: 2', band.cells[5]);
  check('NA lots', band.cells[6] === 'NA Lots: 0', band.cells[6]);
  check('WD lots', band.cells[7] === 'WD Lots: 1', band.cells[7]);

  // Billing Address resolves the buyer's place from the master.
  const firstRow = await page.evaluate(() => {
    const tr = document.querySelector('#am-body table.am-tbl tbody tr');
    return Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
  });
  check('lots sort numerically (1 before 10)', firstRow[1] === '1', JSON.stringify(firstRow));
  check('quantity to 3dp', firstRow[4] === '292.600', firstRow[4]);
  check('billing address = buyer - place',
        firstRow[9] === 'THAMARASSERIYIL SPICES POINT - POTHINKANDAM', firstRow[9]);

  // ── [C] Filter ───────────────────────────────────────────────────
  console.log('[C] filter');
  await page.type('#am-filter', 'BINOY');
  await page.waitForFunction(() => document.querySelectorAll('#am-body table.am-tbl tbody tr').length === 2, { timeout: 10000 });
  check('filter narrows to the matching planter', true);
  await page.evaluate(() => amClearFilter());
  await page.waitForFunction(() => document.querySelectorAll('#am-body table.am-tbl tbody tr').length === 6, { timeout: 10000 });
  check('clear restores every row', true);

  // ── [D] Sub-tabs ─────────────────────────────────────────────────
  console.log('[D] sub-tabs');
  // The name cell also carries the seller's data-hygiene badges (No PAN,
  // No bank, …) — strip those chips so these assertions read the NAME.
  const NAMES = `Array.from(document.querySelectorAll('#am-body table.am-tbl tbody tr td:first-child')).map(td => {
    const c = td.cloneNode(true);
    c.querySelectorAll('.dl-issue').forEach(n => n.remove());
    return c.textContent.trim();
  })`;
  await page.evaluate(() => amSubTab('traders'));
  const traders = await page.evaluate(NAMES);
  check('Traders holds only the GSTIN seller',
        traders.length === 1 && traders[0] === 'ELAICHIROYAL PRIVATE LIMITED', JSON.stringify(traders));

  await page.evaluate(() => amSubTab('planters'));
  const planters = await page.evaluate(NAMES);
  check('Planters holds the four non-GSTIN sellers, BINOY rolled into one row',
        planters.length === 4 && !planters.includes('ELAICHIROYAL PRIVATE LIMITED'), JSON.stringify(planters));
  check('CR number starting with digits is NOT treated as a GSTIN',
        planters.includes('JAINULABDEEN A'), JSON.stringify(planters));

  await page.evaluate(() => amSubTab('lots'));

  // ── [F] Action row + the Reports screen ──────────────────────────
  console.log('[F] action row and Reports screen');
  const acts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#tc-auctionmgr .am-acts .am-act span')).map(s => s.textContent.trim()));
  check('four actions, no Config and no Send SMS',
        JSON.stringify(acts) === JSON.stringify(['Reports', 'Sales Invoices', 'Purchase Invoices', 'Payments']),
        JSON.stringify(acts));
  check('amSendSms is gone entirely',
        await page.evaluate(() => typeof window.amSendSms === 'undefined'));

  // Reports opens its own screen, carrying the manager's trade.
  await page.evaluate(() => document.querySelector('#tc-auctionmgr .am-acts .am-act').click());
  await page.waitForFunction(() => window._currentTab === 'amreports', { timeout: 10000 });
  const amrHead = await page.evaluate(() => ({
    title: document.querySelector('#tc-amreports .amr-title')?.textContent.trim(),
    sub:   document.querySelector('#tc-amreports .amr-sub')?.textContent.replace(/\s+/g, ' ').trim(),
  }));
  check('Reports screen is titled Auction Downloads', amrHead.title === 'Auction Downloads', String(amrHead.title));
  check('…and shows the same trade', /Auction 13/.test(amrHead.sub || ''), String(amrHead.sub));
  check('Reports screen is a separate .tc panel, not a sub-view',
        await page.evaluate(() => document.getElementById('tc-amreports')?.classList.contains('active') === true
                               && document.getElementById('tc-auctionmgr')?.classList.contains('active') === false));

  // Sections and tiles match the supplied layout.
  const dl = await page.evaluate(() => ({
    secs:  Array.from(document.querySelectorAll('#tc-amreports .amr-sec')).map(s => s.textContent.trim()),
    counts: Array.from(document.querySelectorAll('#tc-amreports .amr-grid')).map(g => g.children.length),
    ready: document.querySelectorAll('#tc-amreports .amr-tile:not(.is-todo)').length,
    todo:  document.querySelectorAll('#tc-amreports .amr-tile.is-todo').length,
    icons: document.querySelectorAll('#tc-amreports .amr-tile .amr-ico svg').length,
    tiles: document.querySelectorAll('#tc-amreports .amr-tile').length,
    firstLabel: document.querySelector('#tc-amreports .amr-lbl')?.textContent.trim(),
  }));
  check('four sections in order',
        JSON.stringify(dl.secs) === JSON.stringify(['CSV Downloads', 'PDF Downloads', 'XML Downloads', 'JSON Downloads']),
        JSON.stringify(dl.secs));
  check(`every section renders its whole manifest (${AMR_SECTION_COUNTS.join(' / ')})`,
        JSON.stringify(dl.counts) === JSON.stringify(AMR_SECTION_COUNTS),
        `screen ${JSON.stringify(dl.counts)} vs manifest ${JSON.stringify(AMR_SECTION_COUNTS)}`);
  check('every tile carries the file icon', dl.icons === dl.tiles, `${dl.icons} icons on ${dl.tiles} tiles`);
  // A floor, not an exact count: placeholders get wired as the customer
  // supplies reference files, and an exact number would fail on every one of
  // those. What must hold is that the grid stays complete (nothing silently
  // dropped) and that wiring only ever moves tiles from todo to ready.
  check('every tile is either wired or explicitly not-yet-wired',
        dl.ready + dl.todo === dl.tiles, `${dl.ready} + ${dl.todo} ≠ ${dl.tiles}`);
  check('at least 25 tiles are wired', dl.ready >= 25, `${dl.ready} ready / ${dl.todo} todo`);
  check('first tile is Crop Receipts CSV', dl.firstLabel === 'Crop Receipts CSV', String(dl.firstLabel));
  // A not-yet-wired tile must be inert, not a dead link that appears to work.
  check('not-yet-wired tiles are disabled',
        await page.evaluate(() => document.querySelector('#tc-amreports .amr-tile.is-todo')?.disabled === true));

  // A flagged-off document keeps its place in the grid and says why, rather
  // than vanishing and leaving a hole in the agreed layout.
  await api('PUT', '/api/company-settings', { settings: { flag_merchants: 'false' } });
  await page.evaluate(() => applyFeatureFlags().then(() => loadAmReports()));
  await page.waitForFunction(() => document.querySelectorAll('#tc-amreports .amr-tile.is-todo').length === 14,
    { timeout: 10000 }).catch(() => {});
  const merch = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#tc-amreports .amr-tile'))
      .find(el => el.querySelector('.amr-lbl')?.textContent.trim() === 'Merchant XML');
    return t ? { todo: t.classList.contains('is-todo'), hint: t.querySelector('.amr-hint')?.textContent.trim() } : null;
  });
  check('a flagged-off tile stays in place and explains itself',
        merch && merch.todo === true && merch.hint === 'Turned off in Settings', JSON.stringify(merch));
  await api('PUT', '/api/company-settings', { settings: { flag_merchants: 'true' } });
  await page.evaluate(() => applyFeatureFlags().then(() => loadAmReports()));

  // …and back.
  await page.evaluate(() => document.querySelector('#tc-amreports .amr-close button').click());
  await page.waitForFunction(() => window._currentTab === 'auctionmgr', { timeout: 10000 });
  check('back returns to the Auction Manager with the trade intact',
        await page.evaluate(() => /Auction 13/.test(document.getElementById('am-ano')?.textContent || '')));

  // The Reports screen rides the same flag as the manager.
  const amrGated = await page.evaluate(() =>
    document.getElementById('tc-amreports')?.classList.contains('feat-auction-manager'));
  check('Reports screen carries the same flag gate', amrGated === true);

  // ── [G] Theme ────────────────────────────────────────────────────
  // The palette must derive from --spice-saffron, so switching theme moves
  // the screen. Compare the stat band's tint before and after.
  console.log('[G] theme follows the app');
  const bandOf = () => page.evaluate(() =>
    getComputedStyle(document.querySelector('#tc-auctionmgr .am-stat.am-dark')).backgroundColor);
  const before = await bandOf();
  await page.evaluate(() => document.body.setAttribute('data-theme', 'coral'));
  const after = await bandOf();
  check('stat band re-tints with the app theme', before !== after, `${before} → ${after}`);
  const subtab = await page.evaluate(() => {
    document.body.setAttribute('data-theme', 'coral');
    return getComputedStyle(document.querySelector('#tc-auctionmgr .am-subtab.active')).borderBottomColor;
  });
  const saffron = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('--spice-saffron').trim());
  check('active sub-tab underline is the theme primary, not a fixed green',
        !!saffron && subtab !== 'rgb(46, 125, 50)', `underline ${subtab}, --spice-saffron ${saffron}`);
  await page.evaluate(() => document.body.removeAttribute('data-theme'));

  // ── [E] Shared trade selection ───────────────────────────────────
  console.log('[E] shared trade selection');
  await page.evaluate((id) => setSharedAucId(String(id), 'topbar'), AID2);
  let moved = true;
  try {
    await page.waitForFunction(() => /Auction 14/.test(document.getElementById('am-ano')?.textContent || ''), { timeout: 15000 });
  } catch (_) { moved = false; }
  check('topbar pick repaints the screen', moved,
        'header still ' + await page.evaluate(() => document.getElementById('am-ano').textContent));

  // Back to #13 for the screenshot.
  await page.evaluate((id) => setSharedAucId(String(id), 'topbar'), AID);
  await page.waitForFunction(() => document.querySelectorAll('#am-body table.am-tbl tbody tr').length === 6, { timeout: 15000 });
  await page.screenshot({ path: SHOT, fullPage: true });
  console.log('\n  screenshot → ' + SHOT);
  // …and one of the downloads screen.
  await page.evaluate(() => go('amreports'));
  await page.waitForFunction(
    (n) => document.querySelectorAll('#tc-amreports .amr-tile').length === n,
    { timeout: 10000 }, AMR_TILES);
  check('the downloads screen paints every tile in the manifest', true, '');
  // .tc.active runs a 250ms fadeIn; screenshotting inside it captures a
  // washed-out page. Wait for the animation to actually finish.
  await page.evaluate(() => Promise.all(
    document.getElementById('tc-amreports').getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
  const SHOT2 = SHOT.replace(/\.png$/, '-downloads.png');
  await page.screenshot({ path: SHOT2, fullPage: true });
  console.log('  screenshot → ' + SHOT2);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-3000)); cleanup(); process.exit(1); });
