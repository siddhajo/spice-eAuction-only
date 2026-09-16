// Lot allocation grids — 15 chips to a row, on BOTH panels.
//
// Edit Allocations and Reassign Lots both draw one chip per lot number. They
// used to be flex-wrap grids, so how many chips landed on a row depended on
// the window width and on how wide the widest chip happened to be — a branch
// of 3-digit lots wrapped at a different count from a branch of 2-digit ones,
// and the columns never lined up between branches.
//
// A FIXED 15 per row is what makes a number findable: the same column holds
// the same last digit for every branch, so the eye counts rows instead of
// scanning. This checks both grids lay out 15 across, that a short branch
// still aligns to those columns, and that no chip is pushed to a row of its
// own by a leftover min-width.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-chips-'));
const PORT = 47392;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

let TOKEN = '';
const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', b => { srvLog += b.toString(); });
srv.stderr.on('data', b => { srvLog += b.toString(); });
let browser = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

// Two branches: one with 38 lots (so it spans 3 rows: 15 + 15 + 8) and one
// with 7 (a single short row that must still sit on the same columns).
const STATS = [
  { branch: 'ANAVILASAM', used: 2, total: 38, ranges: [{ start: '001', end: '038', lots:
      Array.from({ length: 38 }, (_, i) => ({
        lot: String(i + 1).padStart(3, '0'),
        used: i < 2, carried: false,
        state: i < 2 ? 'booked' : 'free',
        seller: i < 2 ? 'ANNAMALAI' : '',
      })) }] },
  { branch: 'BODI', used: 0, total: 7, ranges: [{ start: '101', end: '107', lots:
      Array.from({ length: 7 }, (_, i) => ({
        lot: String(101 + i), used: false, carried: false, state: 'free', seller: '',
      })) }] },
];

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const ld = await lr.json();
  TOKEN = ld && (ld.token || ld.accessToken);
  if (!TOKEN) { console.error('login failed', ld, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  let chrome = null;
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const p of candidates) {
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
    cleanup(); process.exit(fail ? 1 : 0);
  }
  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#alloc-modal', { timeout: 15000 });

  // Rows, per branch card, derived from where the chips actually land.
  const rowsOf = (sel) => page.evaluate((s) => {
    const out = [];
    document.querySelectorAll(s).forEach(grid => {
      const byTop = new Map();
      grid.querySelectorAll('[data-lot]').forEach(el => {
        const t = Math.round(el.getBoundingClientRect().top);
        if (!byTop.has(t)) byTop.set(t, []);
        byTop.get(t).push(el.getAttribute('data-lot'));
      });
      out.push([...byTop.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]));
    });
    return out;
  }, sel);

  console.log('[1] Edit Allocations — 15 to a row');
  await page.evaluate((stats) => {
    showModal('alloc-modal');
    switchAllocTab('edit');
    _raAllocStats = stats;
    _allocMarked.clear();
    renderAllocEditCards(stats);
  }, STATS);
  let rows = await rowsOf('#alloc-edit-cards > div > div[style*="grid"]');
  check('both branch cards rendered', rows.length === 2, JSON.stringify(rows.length));
  const big = rows[0], small = rows[1];
  check('38 lots make rows of 15, 15 and 8',
        big.map(r => r.length).join(',') === '15,15,8', big.map(r => r.length).join(','));
  check('the first row is 001–015', big[0][0] === '001' && big[0][14] === '015',
        JSON.stringify([big[0][0], big[0][14]]));
  check('the second starts at 016', big[1][0] === '016', big[1][0]);
  check('no chip is orphaned onto a row of its own',
        big.every((r, i) => r.length === 15 || i === big.length - 1), JSON.stringify(big.map(r => r.length)));
  check('a 7-lot branch stays on one row', small.length === 1 && small[0].length === 7,
        JSON.stringify(small.map(r => r.length)));

  console.log('\n[2] Short branches line up with the long ones, column for column');
  const cols = await page.evaluate(() => {
    const lefts = (lot) => {
      const el = document.querySelector(`#alloc-edit-cards [data-lot="${lot}"]`);
      return el ? Math.round(el.getBoundingClientRect().left - el.closest('[style*="grid"]').getBoundingClientRect().left) : null;
    };
    const chip = document.querySelector('#alloc-edit-cards [data-lot="003"]');
    const r = chip.getBoundingClientRect();
    return { a1: lefts('001'), a16: lefts('016'), b1: lefts('101'), a3: lefts('003'), b3: lefts('103'),
             // Measured here, not in [4]: only one panel is on screen at a
             // time, and a hidden element measures 0 wide.
             chipW: Math.round(r.width), chipH: Math.round(r.height),
             chipFits: chip.scrollWidth <= chip.clientWidth + 1,
             clickable: !!chip.getAttribute('onclick') };
  });
  check('column 1 is the same x on every row', cols.a1 === cols.a16, JSON.stringify(cols));
  check('…and in the next branch down', cols.a1 === cols.b1, JSON.stringify(cols));
  check('column 3 too', cols.a3 === cols.b3, JSON.stringify(cols));

  console.log('\n[3] Reassign Lots — the same 15');
  await page.evaluate((stats) => {
    switchAllocTab('reassign');
    _raAllocStats = stats;
    _raSelected = new Set();
    renderReassignTiles();
  }, STATS);
  rows = await rowsOf('#ra-tile-grid > div > div[style*="grid"]');
  check('both branches rendered', rows.length === 2, String(rows.length));
  check('38 tiles make rows of 15, 15 and 8',
        rows[0].map(r => r.length).join(',') === '15,15,8', rows[0].map(r => r.length).join(','));
  check('the row breaks fall on the same numbers as the Edit panel',
        rows[0][1][0] === '016' && rows[0][2][0] === '031',
        JSON.stringify([rows[0][1][0], rows[0][2][0]]));
  check('a 7-lot branch stays on one row', rows[1].length === 1 && rows[1][0].length === 7,
        JSON.stringify(rows[1].map(r => r.length)));

  console.log('\n[4] The chips are still readable and still clickable');
  const tileGeo = await page.evaluate(() => {
    const tile = document.querySelector('#ra-tile-grid [data-lot="003"]');
    const r = tile.getBoundingClientRect();
    return { tileW: Math.round(r.width), tileFits: tile.scrollWidth <= tile.clientWidth + 1 };
  });
  check('a chip is wide enough for a 3-digit lot', cols.chipW >= 34, JSON.stringify(cols));
  check('its number is not clipped', cols.chipFits === true, JSON.stringify(cols));
  check('a reassign tile is too', tileGeo.tileW >= 34 && tileGeo.tileFits === true, JSON.stringify(tileGeo));
  check('free chips still take a click', cols.clickable === true);

  console.log('\n[5] Clicking a chip still marks it — the grid swap kept the wiring');
  const marked = await page.evaluate(() => {
    switchAllocTab('edit');
    _allocChipClick('ANAVILASAM', '003');
    return { size: _allocMarked.size,
             stillGrid: getComputedStyle(document.querySelector('#alloc-edit-cards [data-lot="003"]')
               .closest('[style*="grid"]')).display };
  });
  check('the click registered', marked.size === 1, String(marked.size));
  check('and the grid survived the re-render', marked.stillGrid === 'grid', marked.stillGrid);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
