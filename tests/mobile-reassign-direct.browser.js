// Mobile Reassign Lots — type the numbers, and (optionally) move them yourself.
//
// Two changes to the phone's Reassign screen:
//
//   [text] The lots are TYPED — "10,11,23,45,50-100" — not hunted down in a
//     scrolling tile strip with a thumb. Zero-padding is optional, booked
//     lots in a typed run are stepped over and counted rather than failing
//     the move, and tapping tiles writes the selection back into the box so
//     the two are one selection seen two ways.
//
//   [mode] Whether the operator may move lots AT ALL is now an install
//     setting (flag_mobile_reassign_direct). OFF (default) is the old
//     request-an-admin flow, reason box and "My requests" list included.
//     ON turns the screen into a direct move: both of those go away and the
//     button stops promising an admin will look at it. The server enforces
//     the same switch — see reassign-direct-and-main-depot.http.js.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-ra-'));
const PORT = 47441;
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
    headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
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

// ANAVILASAM 001–020 with 001, 002 and 005 already entered; BODINAYAKANUR
// 101–106 untouched. Shaped exactly like /api/auctions/:id/allocation-stats.
const ALLOC = [
  { branch: 'ANAVILASAM', used: 3, total: 20, ranges: [{ start: '001', end: '020',
      lots: Array.from({ length: 20 }, (_, i) => {
        const n = i + 1;
        const used = n === 1 || n === 2 || n === 5;
        return { lot: String(n).padStart(3, '0'), used, state: used ? 'booked' : 'free', seller: used ? 'ANNAMALAI' : '' };
      }) }] },
  { branch: 'BODINAYAKANUR', used: 0, total: 6, ranges: [{ start: '101', end: '106',
      lots: Array.from({ length: 6 }, (_, i) => ({ lot: String(101 + i), used: false, state: 'free', seller: '' })) }] },
];

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('PUT', '/api/company-settings', { settings: { br1: 'ANAVILASAM', br2: 'BODINAYAKANUR' } });

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
  await page.setViewport({ width: 420, height: 900, isMobile: true });
  await page.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('sa_token', tok); }, TOKEN);
  await page.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#reassign-modal', { timeout: 15000 });

  // Put the screen in the state a live session leaves it: an auction, a
  // branch, the allocation stats loaded, and the branch pickers filled.
  const seed = (direct) => page.evaluate((alloc, direct) => {
    aid = 1; br = 'ANAVILASAM';
    allocStats = alloc;
    window._allBranches = ['ANAVILASAM', 'BODINAYAKANUR'];
    cfgReassignDirect = direct;
    document.getElementById('ra-from').innerHTML = raBranchOptions('ra-from', 'ANAVILASAM');
    document.getElementById('ra-to').innerHTML = raBranchOptions('ra-to', 'BODINAYAKANUR');
    document.getElementById('ra-from').value = 'ANAVILASAM';
    document.getElementById('ra-to').value = 'BODINAYAKANUR';
    document.getElementById('ra-lots').value = '';
    _raPick.clear();
    applyReassignMode();
    renderRaTiles();
  }, ALLOC, direct);

  console.log('[1] Only the free lots are offered');
  await seed(false);
  const tiles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ra-tiles [data-lot]')).map(e => e.getAttribute('data-lot')));
  check('the three entered lots are not on the strip',
        !['001', '002', '005'].some(l => tiles.includes(l)), JSON.stringify(tiles));
  check('the other seventeen are', tiles.length === 17, String(tiles.length));

  console.log('\n[2] Typing the lots');
  const typed = await page.evaluate(() => {
    const box = document.getElementById('ra-lots');
    box.value = '1,2,3,15-18';
    raSyncFromText();
    return {
      picked: Array.from(_raPick).sort(),
      note: (document.getElementById('ra-lots-note').textContent || '').replace(/\s+/g, ' '),
    };
  });
  check('the booked 001 and 002 are skipped, the rest selected',
        typed.picked.join(',') === '003,015,016,017,018', JSON.stringify(typed.picked));
  check('"3" finds "003" — padding is not the operator\'s problem', typed.picked.includes('003'));
  check('the note says how many were stepped over', /2 already used/.test(typed.note), typed.note);

  const missing = await page.evaluate(() => {
    const box = document.getElementById('ra-lots');
    box.value = '3,900';
    raSyncFromText();
    return { n: _raPick.size, note: (document.getElementById('ra-lots-note').textContent || '').replace(/\s+/g, ' ') };
  });
  check('a number this branch does not hold is named, not silently dropped',
        missing.n === 1 && /1 not in ANAVILASAM/.test(missing.note), missing.note);

  console.log('\n[3] Tapping tiles writes the selection back as text');
  const mirrored = await page.evaluate(() => {
    document.getElementById('ra-lots').value = '';
    raSyncFromText();
    const tile = (lot) => document.querySelector(`#ra-tiles [data-lot="${lot}"]`);
    raPickClick(tile('016'));
    raPickClick(tile('017'));
    raPickClick(tile('020'));
    return document.getElementById('ra-lots').value;
  });
  check('it reads back in the same syntax it accepts', mirrored === '016-017, 020', mirrored);

  console.log('\n[4] Request mode (the default) asks an admin');
  await seed(false);
  const req = await page.evaluate(() => ({
    button: (document.getElementById('ra-submit').textContent || '').trim(),
    reason: document.getElementById('ra-reason-wrap').style.display,
    requests: document.getElementById('ra-requests-wrap').style.display,
    blurb: (document.getElementById('ra-mode-note').textContent || '').trim(),
  }));
  check('the button says so', /Send request to admin/.test(req.button), req.button);
  check('the reason box is there — it is part of asking', req.reason !== 'none', req.reason);
  check('and so is the "My requests" list', req.requests !== 'none', req.requests);
  check('the blurb names the admin', /admin/i.test(req.blurb), req.blurb);

  console.log('\n[5] Direct mode moves the lots itself');
  await seed(true);
  const dir = await page.evaluate(() => ({
    button: (document.getElementById('ra-submit').textContent || '').trim(),
    reason: document.getElementById('ra-reason-wrap').style.display,
    requests: document.getElementById('ra-requests-wrap').style.display,
    blurb: (document.getElementById('ra-mode-note').textContent || '').trim(),
  }));
  check('the button stops promising an approval', /Move lots now/.test(dir.button), dir.button);
  check('the reason box is gone — nobody is being asked', dir.reason === 'none', dir.reason);
  check('the requests list goes with it', dir.requests === 'none', dir.requests);
  check('and the blurb says it happens straight away',
        /straight away/i.test(dir.blurb) && !/admin/i.test(dir.blurb), dir.blurb);

  console.log('\n[6] The switch reaches an open phone without a reinstall');
  const flipped = await page.evaluate(() => {
    cfgReassignDirect = false; applyReassignMode();
    const before = (document.getElementById('ra-submit').textContent || '').trim();
    cfgReassignDirect = true; applyReassignMode();
    return { before, after: (document.getElementById('ra-submit').textContent || '').trim() };
  });
  check('flipping it repaints the screen in place',
        /Send request/.test(flipped.before) && /Move lots now/.test(flipped.after), JSON.stringify(flipped));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
