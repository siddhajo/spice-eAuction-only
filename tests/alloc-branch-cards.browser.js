// Lot Allocations → Edit Allocations — ONE card per branch, not one per range.
//
// A branch's allocation is built up over several sessions, so a depot ends up
// holding a handful of ranges (021–025, 041–042, 044–045 …). Rendered a card
// each, the operator scrolled past a header, a counts line and a pair of
// buttons for every one of them just to see one depot's numbers — the Reassign
// tab next door groups by branch and is readable, which is what prompted this.
//
// Grouping changes what the two buttons on the card mean: they now cover the
// whole branch, because the card is the branch. A button that silently covered
// only one of its ranges would be lying about its scope.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-cards-'));
const PORT = 47376;
const B = `http://127.0.0.1:${PORT}`;

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

// Three ranges for ANAVILASAM (the shape from the screenshot) and one for a
// second depot, so "one card per branch" is visibly not "one card, full stop".
const STATS = [
  { branch: 'ANAVILASAM', used: 2, total: 9, ranges: [
    { start: '021', end: '025', lots: [
      { lot: '021', used: true, seller: 'GREEN ESTATE' }, { lot: '022', used: false },
      { lot: '023', used: false }, { lot: '024', used: false }, { lot: '025', used: false } ] },
    { start: '041', end: '042', lots: [ { lot: '041', used: false }, { lot: '042', used: false } ] },
    { start: '044', end: '045', lots: [ { lot: '044', used: true, seller: 'BLUE HILLS' }, { lot: '045', used: false } ] },
  ] },
  { branch: 'BODINAYAKANUR', used: 0, total: 2, ranges: [
    { start: '101', end: '102', lots: [ { lot: '101', used: false }, { lot: '102', used: false } ] },
  ] },
];

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

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
    cleanup(); process.exit(0);
  }
  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#alloc-edit-cards', { timeout: 15000 });

  const render = () => page.evaluate(st => {
    _raAllocStats = st;
    _allocMarked.clear();
    _allocHidden.clear();
    renderAllocEditCards(_raAllocStats);
  }, STATS);

  // A card is one direct child div of the host.
  const cards = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#alloc-edit-cards > div')).map(c => ({
      text: (c.textContent || '').replace(/\s+/g, ' ').trim(),
      lots: Array.from(c.querySelectorAll('span[data-lot]')).map(s => s.getAttribute('data-lot')),
      buttons: Array.from(c.querySelectorAll('button')).map(b => (b.textContent || '').trim()),
    })));

  console.log('[1] One card per branch, whatever its ranges');
  await render();
  let c = await cards();
  check('two cards for two branches, not four for four ranges', c.length === 2,
        JSON.stringify(c.map(x => x.text.slice(0, 40))));
  check('the first is ANAVILASAM', /^ANAVILASAM/.test(c[0].text), c[0].text.slice(0, 60));
  check('the second is BODINAYAKANUR', /^BODINAYAKANUR/.test(c[1].text), c[1].text.slice(0, 60));

  console.log('\n[2] Every one of the branch\'s lots is in that one card');
  check('all nine ANAVILASAM lots together',
        c[0].lots.join(',') === '021,022,023,024,025,041,042,044,045', JSON.stringify(c[0].lots));
  check('in lot order across the range boundaries', (() => {
    const n = c[0].lots.map(Number);
    return n.every((v, i) => i === 0 || n[i - 1] < v);
  })(), JSON.stringify(c[0].lots));
  check('the other branch keeps its own', c[1].lots.join(',') === '101,102', JSON.stringify(c[1].lots));

  console.log('\n[3] The header still names the ranges — that is a real question');
  check('all three are listed', /021–025, 041–042, 044–045/.test(c[0].text), c[0].text.slice(0, 90));
  check('and it says how many there are', /3 ranges/.test(c[0].text), c[0].text.slice(0, 90));
  check('a single-range branch says nothing about a count', !/1 ranges/.test(c[1].text), c[1].text.slice(0, 90));

  console.log('\n[4] The counts are the branch\'s, not one range\'s');
  check('2 used across the whole branch', /2 used/.test(c[0].text), c[0].text.slice(0, 140));
  check('7 free across the whole branch', /7 free/.test(c[0].text), c[0].text.slice(0, 140));

  console.log('\n[5] One pair of buttons per branch, covering the branch');
  check('just Hide + the two mark actions', c[0].buttons.length === 3, JSON.stringify(c[0].buttons));
  const marked = await page.evaluate(() => {
    _allocMarkAllFree('ANAVILASAM');
    return [..._allocMarked];
  });
  check('Mark all free marks every free lot in the branch, across ranges',
        marked.sort().join(',') === ['ANAVILASAM|022','ANAVILASAM|023','ANAVILASAM|024','ANAVILASAM|025',
                                     'ANAVILASAM|041','ANAVILASAM|042','ANAVILASAM|045'].sort().join(','),
        JSON.stringify(marked));
  check('and leaves the used ones alone',
        !marked.includes('ANAVILASAM|021') && !marked.includes('ANAVILASAM|044'), JSON.stringify(marked));
  check('the other branch is untouched', !marked.some(k => k.startsWith('BODINAYAKANUR')), JSON.stringify(marked));
  c = await cards();
  check('the card counts the marks', /7 marked/.test(c[0].text), c[0].text.slice(0, 160));
  check('and says what is left', /keeping 2/.test(c[0].text), c[0].text.slice(0, 160));

  console.log('\n[6] Clear marks clears the branch');
  const cleared = await page.evaluate(() => { _allocClearMarks('ANAVILASAM'); return [..._allocMarked]; });
  check('nothing marked in it any more', !cleared.some(k => k.startsWith('ANAVILASAM')), JSON.stringify(cleared));

  console.log('\n[7] Hide folds the whole branch away');
  await page.evaluate(() => _allocToggleHide('ANAVILASAM'));
  c = await cards();
  check('its chips are gone', c[0].lots.length === 0, JSON.stringify(c[0].lots));
  check('the header stays, so it can be brought back', /^ANAVILASAM/.test(c[0].text), c[0].text.slice(0, 40));
  check('the button now reads Show', c[0].buttons.includes('Show'), JSON.stringify(c[0].buttons));
  check('the other branch is unaffected', c[1].lots.length === 2, JSON.stringify(c[1].lots));
  await page.evaluate(() => _allocToggleHide('ANAVILASAM'));
  c = await cards();
  check('and Show brings all nine back', c[0].lots.length === 9, JSON.stringify(c[0].lots));

  console.log('\n[8] Clicking a chip still marks just that lot');
  const one = await page.evaluate(() => { _allocChipClick('ANAVILASAM', '023'); return [..._allocMarked]; });
  check('only the clicked lot', one.join(',') === 'ANAVILASAM|023', JSON.stringify(one));

  console.log('\n[9] No allocations at all still says so');
  await page.evaluate(() => { _raAllocStats = []; renderAllocEditCards(_raAllocStats); });
  check('the empty state renders',
        /No allocations yet/.test(await page.evaluate(() =>
          document.getElementById('alloc-edit-cards').textContent)));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(srvLog.slice(-2000));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); cleanup(); process.exit(1); });
