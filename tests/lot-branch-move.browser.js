// Move Depot, driven through the real LOT ENTRY screen.
//
// It lives on Lot Entry's toolbar beside Change Seller — both answer the same
// "this row was entered wrong" question, and the operator is already looking
// at the lots they just typed. It takes its selection from
// `_le.selectedForPrint`, the same ticks Print Selected and Change Seller use.
//
// The server side is covered by lot-branch-move.http.js. What only a browser
// answers is whether an operator can actually reach it: the button appears
// with a selection, the depot list is populated, the PREVIEW says what will
// move before anything is written, and the warning about already-invoiced
// lots is shown rather than discovered afterwards.
//
//   [button]   appears only with lots ticked
//   [depots]   the picker offers the install's configured depots
//   [preview]  names the source depots and the lot numbers, writing nothing
//   [warn]     invoiced lots are called out before the move
//   [apply]    the move runs and the table comes back on the new depot
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lbr-ui-'));
const PORT = 47517;
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
function cleanup() {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const A = 'ANAVILASAM', Bd = 'BODINAYAKANUR', C = 'CUMBUM';

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: { br1: A, br2: Bd, br3: C } });
  const auc = await api('POST', '/api/auctions', { ano: '111', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  await api('POST', `/api/auctions/${aid}/allocations`, {
    allocations: [{ branch: A, start_lot: '001', end_lot: '010' }],
  });
  const lotIds = [];
  for (const lot_no of ['001', '002', '003']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'SELLER ' + lot_no, cr: '', qty: 100, bags: 10,
      grade: '1', crop: 'CARDAMOM', branch: A,
    });
    lotIds.push(r.d && (r.d.id || (r.d.lot && r.d.lot.id)));
  }
  // Give lot 001 an invoice number so the "already invoiced" warning has
  // something real to report.
  await api('PUT', `/api/lots/${lotIds[0]}`, { invo: '77' });

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
  if (!chrome) {
    console.log('  skip no Chrome available — UI checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    cleanup(); process.exit(0);
  }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  // Lot Entry: pick the trade, then let its recent-entries panel load. That
  // panel's ticks ARE the selection the Move Depot button reads.
  // go() is what actually opens a tab and kicks off its loaders —
  // showTab alone leaves the trade dropdown unpopulated here.
  await page.evaluate(() => go('lotentry'));
  await page.waitForFunction(
    () => document.querySelectorAll('#le-auction option').length > 0, { timeout: 12000 });
  await page.evaluate(a => {
    const sel = document.getElementById('le-auction');
    if (sel) { sel.value = String(a); leOnAuctionChange(); }
  }, aid);
  await page.waitForFunction(
    () => (typeof _le !== 'undefined' && _le && Array.isArray(_le.recentLots) && _le.recentLots.length > 0),
    { timeout: 12000 });

  const btnVisible = () => page.evaluate(() => {
    const b = document.getElementById('le-change-branch-btn');
    return b ? getComputedStyle(b).display !== 'none' : null;
  });

  console.log('[button] appears only with a selection');
  {
    check('the Move Depot button exists', (await btnVisible()) !== null);
    check('…and is hidden with nothing ticked', (await btnVisible()) === false,
      String(await btnVisible()));
    // Tick through the screen's own handler, so the toolbar syncs the way it
    // does for a real click.
    const ticked = await page.evaluate((ids) => {
      ids.forEach(id => leToggleLotSelected(id, true));
      return _le.selectedForPrint.size;
    }, lotIds);
    check('three lots ticked on screen', ticked === 3, String(ticked));
    check('…and the button is now shown', (await btnVisible()) === true, String(await btnVisible()));
    check('…with the count on its badge',
      await page.evaluate(() => document.getElementById('le-change-branch-count').textContent === '3'),
      await page.evaluate(() => document.getElementById('le-change-branch-count').textContent));
    check('it sits beside Change Seller on the Lot Entry toolbar',
      await page.evaluate(() => {
        const a = document.getElementById('le-change-seller-btn');
        const b = document.getElementById('le-change-branch-btn');
        return !!(a && b && a.parentElement === b.parentElement);
      }));
    check('and it is NOT on the Lots screen any more',
      await page.evaluate(() => !document.getElementById('lot-bulk-branch')));
  }

  console.log('[depots] the picker offers the configured depots');
  {
    await page.evaluate(() => openLotBranchModal());
    await page.waitForFunction(
      () => document.getElementById('lot-branch-modal')?.classList.contains('show')
            && document.querySelectorAll('#lbr-branch option').length > 1,
      { timeout: 8000 });
    const opts = await page.evaluate(() => Array.from(
      document.querySelectorAll('#lbr-branch option')).map(o => o.value).filter(Boolean));
    check('all three depots are offered',
      [A, Bd, C].every(b => opts.includes(b)), opts.join(', '));
    check('the heading counts the selection',
      await page.evaluate(() => document.getElementById('lbr-count').textContent === '3'),
      await page.evaluate(() => document.getElementById('lbr-count').textContent));
    check('moving the allocations is ON by default',
      await page.evaluate(() => document.getElementById('lbr-alloc').checked));
  }

  console.log('[preview] it says what will move, writing nothing');
  {
    const before = await api('GET', `/api/auctions/${aid}/allocations`);
    await page.evaluate((b) => {
      document.getElementById('lbr-branch').value = b;
      lotBranchPreview();
    }, C);
    await page.waitForFunction(
      () => /will move to/.test(document.getElementById('lbr-preview').textContent),
      { timeout: 8000 });
    const txt = await page.evaluate(() => document.getElementById('lbr-preview').textContent);
    check('it counts the movable lots', /3\s*lot\(s\) will move/.test(txt), txt.slice(0, 160));
    check('…names the source depot', new RegExp(A).test(txt), txt.slice(0, 200));
    check('…and shows the lot numbers', /001-003/.test(txt), txt.slice(0, 220));
    const after = await api('GET', `/api/auctions/${aid}/allocations`);
    check('the preview wrote NOTHING',
      JSON.stringify(before.d) === JSON.stringify(after.d));
  }

  console.log('[warn] invoiced lots are called out first');
  {
    const txt = await page.evaluate(() => document.getElementById('lbr-preview').textContent);
    check('the invoiced lot is flagged before the move',
      /already carry an invoice number/i.test(txt), txt.slice(0, 400));
  }

  console.log('[apply] the move runs and the lots come back on the new depot');
  {
    await page.evaluate(() => lotBranchApply());
    await page.waitForFunction(
      () => !document.getElementById('lot-branch-modal')?.classList.contains('show'),
      { timeout: 10000 });
    const lots = ((await api('GET', `/api/lots?auction_id=${aid}&limit=1000`)).d || {}).lots || [];
    check('all three lots are on the new depot',
      lots.length === 3 && lots.every(l => String(l.branch).toUpperCase() === C),
      JSON.stringify(lots.map(l => [l.lot_no, l.branch])));
    check('the selection was cleared, so the button hides again',
      (await btnVisible()) === false, String(await btnVisible()));
    const al = ((await api('GET', `/api/auctions/${aid}/allocations`)).d || {}).allocations || [];
    const dest = al.filter(a => String(a.branch).toUpperCase() === C)
      .map(a => `${a.start_lot}-${a.end_lot}`);
    check('their numbers moved with them, as one range',
      dest.includes('001-003'), JSON.stringify(al.map(a => [a.branch, a.start_lot, a.end_lot])));
    const src = al.filter(a => String(a.branch).toUpperCase() === A)
      .map(a => `${a.start_lot}-${a.end_lot}`);
    check('the source keeps the rest', src.includes('004-010'), JSON.stringify(src));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
