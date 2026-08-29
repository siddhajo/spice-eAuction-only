// Dashboard ↔ trade selection, in a real headless Chrome.
//
//   [A] Changing the topbar's global trade selector repaints the dashboard's
//       "Current Auction" hero for that trade. It used to sit on whatever it
//       last showed (or on the cumulative view) and quietly disagree with
//       every other screen.
//   [B] Clicking "Auction #N" in the hero opens that trade in the Auction
//       Manager, with the manager already showing trade N.
//   [C] Picking a trade in the hero's own selector pushes it back out to the
//       topbar, so the two never disagree in the other direction either.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-follow-'));
const PORT = 47366;
const B = `http://127.0.0.1:${PORT}`;
const SHOT = process.env.SHOT_DIR || TMP;

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
const cleanup = keep => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  if (!keep) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  // The hero's trade number only links when the Auction Manager is switched on.
  await api('PUT', '/api/company-settings', { settings: { flag_auction_manager: 'true' } });

  // Two trades with different lot counts, so "which trade is the hero showing?"
  // is answerable from the numbers on screen, not just the heading.
  const trades = {};
  for (const [ano, date, lots] of [['41', '2026-08-05', 2], ['42', '2026-08-19', 5]]) {
    const a = await api('POST', '/api/auctions', { ano, date, state: 'TAMIL NADU' });
    const aid = a.d.id || (a.d.auction && a.d.auction.id);
    trades[ano] = aid;
    for (let i = 1; i <= lots; i++) {
      const r = await api('POST', '/api/lots', { auction_id: aid, lot_no: String(i), name: `PLANTER ${i}`, qty: 100, grade: '1', bags: 4 });
      const id = r.d.id || (r.d.lot && r.d.lot.id);
      await api('PUT', `/api/lots/${id}`, { price: 1000, amount: 100000, bags: 4 });
    }
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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 2 });
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
  // The topbar trade selector is filled by an async fetch after sign-in.
  // Driving it before its options exist silently sets an empty value.
  await page.waitForFunction(() => (document.getElementById('topbar-trade')?.options.length || 0) >= 2,
    { timeout: 20000 });

  // The dashboard's "Current Auction" panel (#dash-current-auction), the
  // depot-summary widget the operator actually reads.
  const hero = () => page.evaluate(() => {
    const el = document.getElementById('dash-current-auction');
    const pick = document.querySelector('#tc-dash select[onchange^="dashPickAuction"]');
    if (!el) return null;
    const stat = label => {
      const row = [...el.querySelectorAll('div')].find(d => d.children.length === 2 && d.firstElementChild?.textContent.trim() === label);
      return row ? row.lastElementChild.textContent.trim() : '';
    };
    return {
      heading: el.querySelector('h2')?.textContent.trim() || '',
      number:  el.querySelector('#ca-body > div')?.textContent.trim() || '',
      linked:  !!el.querySelector('.ca-ano-link'),
      lots:    stat('Booked Lots'),
      rows:    el.querySelectorAll('tbody tr').length,
      picker:  pick ? pick.value : '',
    };
  });
  const setTopbar = (aid) => page.evaluate((v) => {
    const sel = document.getElementById('topbar-trade');
    sel.value = String(v);
    sel.dispatchEvent(new Event('change'));
  }, aid);

  const waitForTrade = ano => page.waitForFunction((n) => {
    const el = document.getElementById('dash-current-auction');
    return !!el && new RegExp('Auction No ' + n + '\\b').test(el.textContent || '');
  }, { timeout: 15000 }, ano).catch(() => {});

  await page.evaluate(() => go('dash'));
  await page.waitForFunction(() => {
    const el = document.getElementById('dash-current-auction');
    return !!el && /Auction No/.test(el.textContent || '');
  }, { timeout: 20000 });

  console.log('[A] The Current Auction panel follows the global trade selector');
  const first = await hero();
  check('the dashboard opens showing a trade, not an empty panel',
        /Current Auction/i.test(first.heading) && /Auction No/.test(first.number), JSON.stringify(first));

  await setTopbar(trades['41']);
  await waitForTrade(41);
  const at41 = await hero();
  check('picking trade 41 in the topbar moves the panel to 41',
        /Auction No 41\b/.test(at41.number), JSON.stringify(at41));
  check('and the panel\'s figures are 41\'s (2 booked lots)', at41.lots === '2', JSON.stringify(at41));
  check('the dashboard\'s own picker agrees', String(at41.picker) === String(trades['41']), JSON.stringify(at41));

  await setTopbar(trades['42']);
  await waitForTrade(42);
  const at42 = await hero();
  check('switching to trade 42 moves it again', /Auction No 42\b/.test(at42.number), JSON.stringify(at42));
  check('and the figures follow (5 booked lots)', at42.lots === '5', JSON.stringify(at42));

  console.log('\n[B] The trade number opens the Auction Manager on that trade');
  check('the trade number is a link', at42.linked, JSON.stringify(at42));
  // Go back to 41 first, so landing on 42 in the manager can only have come
  // from the click and not from what was already selected.
  await setTopbar(trades['41']);
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate((id) => dashOpenAuctionManager(id), trades['42']);
  await page.waitForFunction(() => window._currentTab === 'auctionmgr', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => {
    const sel = document.getElementById('am-auction');
    return sel && sel.options.length > 0 && sel.value;
  }, { timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 900));
  const am = await page.evaluate(() => ({
    tab:  window._currentTab,
    sel:  document.getElementById('am-auction')?.value || '',
    ano:  document.getElementById('am-ano')?.textContent.trim() || '',
    rows: document.querySelectorAll('#tc-auctionmgr tbody tr').length,
  }));
  check('the Auction Manager is now the open tab', am.tab === 'auctionmgr', JSON.stringify(am));
  check('it is showing the trade that was clicked',
        String(am.sel) === String(trades['42']), JSON.stringify(am));
  check('its heading names that trade', /42/.test(am.ano), JSON.stringify(am));
  check('and it listed that trade\'s lots (5)', am.rows === 5, JSON.stringify(am));
  check('the topbar followed too',
        String(await page.evaluate(() => document.getElementById('topbar-trade').value)) === String(trades['42']));

  console.log('\n[C] The dashboard\'s own picker pushes back out');
  await page.evaluate(() => go('dash'));
  await new Promise(r => setTimeout(r, 700));
  await page.evaluate((id) => dashPickAuction(String(id)), trades['41']);
  await waitForTrade(41);
  const backOut = await page.evaluate(() => ({
    topbar: document.getElementById('topbar-trade').value,
    number: document.getElementById('dash-current-auction')?.textContent.trim().slice(0, 200) || '',
  }));
  check('picking 41 on the dashboard moves the topbar to 41',
        String(backOut.topbar) === String(trades['41']), JSON.stringify(backOut).slice(0, 200));
  check('the panel shows 41', /Auction No 41\b/.test(backOut.number), JSON.stringify(backOut).slice(0, 200));

  // "All Auctions" is a dashboard-only view — it must NOT clear the app-wide
  // trade, or every other screen would lose its selection.
  await page.evaluate(() => dashPickAuction('all'));
  await new Promise(r => setTimeout(r, 900));
  const allMode = await page.evaluate(() => ({
    topbar: document.getElementById('topbar-trade').value,
    toggle: document.querySelector('.dash-snap-toggle-btn')?.textContent.trim() || '',
  }));
  check('choosing "All Auctions" switches the dashboard to the cumulative view',
        /All Auctions/i.test(allMode.toggle), JSON.stringify(allMode));
  check('…and leaves the app-wide trade alone',
        String(allMode.topbar) === String(trades['41']), JSON.stringify(allMode));

  const shot = path.join(SHOT, 'dashboard-current-auction.png');
  await page.evaluate((id) => dashPickAuction(String(id)), trades['42']);
  await waitForTrade(42);
  const box = await page.evaluate(() => {
    const el = document.getElementById('dash-current-auction');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(r.width + 16, window.innerWidth), height: Math.min(r.height + 16, window.innerHeight) };
  });
  if (box && box.height > 20) await page.screenshot({ path: shot, clip: box });
  console.log('\nscreenshot: ' + shot);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(srvLog.slice(-1500));
  cleanup(!!process.env.SHOT_DIR);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
