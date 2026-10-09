// Lot Allocations — type the lots, and show only the ones you can use.
//
// Two changes to the same modal, which is why they are tested together:
//
//  1. BOTH grids now open on the AVAILABLE lots only. A trade of 900 numbers
//     that is 80% sold used to render as a wall of dead chips with the spare
//     ones scattered through it, and finding them was the whole job. Every
//     other status is one click away on the status bar, and the per-branch
//     counts keep reporting the full picture so hiding never makes a depot
//     look emptier than it is.
//
//  2. Reassign takes the lots as TEXT — "10,11,23,12,24,45,50-100" — because
//     that is how the numbers arrive, read off a sheet. Mid-auction some of
//     a typed run will already have sold, so the booked ones are stepped over
//     and counted rather than failing the whole move (sending them bounced
//     the entire reassign server-side, which is what used to happen).
//
//     And the typed lots DO NOT have to share a branch (2026-10-07). FROM is
//     a filter defaulting to "Any branch": each lot leaves the depot that
//     holds it, the note breaks the count down per source depot, and a lot
//     already in the destination is dropped rather than sent nowhere. The
//     earlier "pick a FROM branch first" refusal made the operator do the
//     server's bookkeeping by hand.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-search-'));
const PORT = 47412;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
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

// ANAVILASAM 001–020 with a realistic spread of states; BODINAYAKANUR
// 101–106 entirely free, so a typed list can be made to straddle branches.
const LOT = (n, state) => ({
  lot: String(n).padStart(3, '0'),
  used: state !== 'free' && state !== 'reassigned',
  carried: state === 'carried',
  state,
  seller: state === 'free' || state === 'reassigned' ? '' : 'ANNAMALAI',
});
const A_STATES = {};
[1, 2].forEach(n => { A_STATES[n] = 'booked'; });
A_STATES[5] = 'reserved';
A_STATES[10] = 'carried';
A_STATES[12] = 'reassigned';
const STATS = [
  { branch: 'ANAVILASAM', used: 4, total: 20, ranges: [{ start: '001', end: '020',
      lots: Array.from({ length: 20 }, (_, i) => LOT(i + 1, A_STATES[i + 1] || 'free')) }] },
  { branch: 'BODINAYAKANUR', used: 0, total: 6, ranges: [{ start: '101', end: '106',
      lots: Array.from({ length: 6 }, (_, i) => LOT(101 + i, 'free')) }] },
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
  const TOKEN = ld && (ld.token || ld.accessToken);
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

  // Seed both panels from the fixture, in the state a fresh open leaves them.
  const seed = () => page.evaluate((stats) => {
    showModal('alloc-modal');
    _raAllocStats = stats;
    _raSelected = new Set();
    _allocMarked.clear();
    _allocHidden.clear();
    _allocFindSet = null;
    _allocShownStates.clear();
    const box = document.getElementById('ra-lots'); if (box) box.value = '';
    const find = document.getElementById('alloc-find'); if (find) find.value = '';
    // CUMBUM is a destination with no allocation of its own — the normal
    // shape when a depot is being filled for the first time.
    const opts = '<option value="">— Any branch —</option><option>ANAVILASAM</option>'
               + '<option>BODINAYAKANUR</option><option>CUMBUM</option>';
    document.getElementById('ra-from').innerHTML = opts;
    document.getElementById('ra-to').innerHTML = opts;
    switchAllocTab('edit');
    renderAllocEditCards(stats);
    switchAllocTab('reassign');
    renderReassignTiles();
  }, STATS);

  const editLots = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#alloc-edit-cards [data-lot]')).map(e => e.getAttribute('data-lot')));
  const tileLots = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#ra-tile-grid [data-lot]')).map(e => e.getAttribute('data-lot')));

  console.log('[1] Both grids open on the lots you can actually use');
  await seed();
  let el = await editLots(), tl = await tileLots();
  check('the four used ANAVILASAM lots are off the Edit grid',
        !['001', '002', '005', '010'].some(l => el.includes(l)), JSON.stringify(el));
  check('…and the free ones are all there',
        el.filter(l => l < '100').length === 16, String(el.filter(l => l < '100').length));
  check('a reassigned lot counts as available — it is free',
        el.includes('012'), JSON.stringify(el.slice(0, 20)));
  check('the Reassign tiles hide exactly the same four',
        tl.join(',') === el.join(','), JSON.stringify({ tiles: tl.length, chips: el.length }));

  console.log('\n[2] The counts still describe the whole depot, not the view');
  const header = await page.evaluate(() => {
    switchAllocTab('edit');
    return (document.querySelector('#alloc-edit-cards > div').textContent || '').replace(/\s+/g, ' ');
  });
  check('it still says 4 used', /4 used/.test(header), header.slice(0, 160));
  check('and says what it is holding back', /4 not shown/.test(header), header.slice(0, 160));

  console.log('\n[3] The status bar brings the rest back');
  await page.evaluate(() => allocToggleState('booked'));
  el = await editLots();
  check('booked lots appear', el.includes('001') && el.includes('002'), JSON.stringify(el.slice(0, 6)));
  check('but reserved and carried stay hidden',
        !el.includes('005') && !el.includes('010'), JSON.stringify(el.slice(0, 12)));
  await page.evaluate(() => allocShowAllStates(true));
  el = await editLots(); tl = await tileLots();
  check('Show all reveals every lot', el.filter(l => l < '100').length === 20, String(el.length));
  check('on the Reassign grid too', tl.filter(l => l < '100').length === 20, String(tl.length));
  await page.evaluate(() => allocShowAllStates(false));
  check('and Available only puts them away again',
        (await editLots()).filter(l => l < '100').length === 16);

  console.log('\n[4] Typing the lots to move');
  const typed = await page.evaluate(() => {
    switchAllocTab('reassign');
    document.getElementById('ra-from').value = '';          // "Any branch"
    document.getElementById('ra-to').value = 'BODINAYAKANUR';
    const box = document.getElementById('ra-lots');
    box.value = '1,2,3,12,15-18';
    raSyncSelectionFromText();
    return {
      selected: Array.from(_raSelected).sort(),
      from: document.getElementById('ra-from').value,
      note: (document.getElementById('ra-lots-note').textContent || '').replace(/\s+/g, ' '),
    };
  });
  check('the booked 001 and 002 are stepped over, not fatal',
        typed.selected.join(',') === '003,012,015,016,017,018', JSON.stringify(typed.selected));
  check('"3" finds "003" — padding is not the operator\'s problem',
        typed.selected.includes('003'));
  check('a range expands', ['015', '016', '017', '018'].every(l => typed.selected.includes(l)));
  check('the note says how many were skipped', /2 already used/.test(typed.note), typed.note);
  // FROM stays on "Any branch" — the box no longer retargets a control the
  // operator set, and it doesn't need to: the server takes each lot out of
  // whichever depot holds it.
  check('FROM is left alone — it is a filter, not an inference', typed.from === '', typed.from);
  check('the note names the depot they are coming out of',
        /from ANAVILASAM/.test(typed.note) && /BODINAYAKANUR/.test(typed.note), typed.note);

  console.log('\n[5] Numbers that are not allocated anywhere are called out');
  const missing = await page.evaluate(() => {
    document.getElementById('ra-from').value = '';
    const box = document.getElementById('ra-lots');
    box.value = '3,900,901';
    raSyncSelectionFromText();
    return { n: _raSelected.size, note: (document.getElementById('ra-lots-note').textContent || '').replace(/\s+/g, ' ') };
  });
  check('only the real one is selected', missing.n === 1, String(missing.n));
  check('the other two are named as unallocated', /2 not allocated/.test(missing.note), missing.note);

  console.log('\n[6] Lots from several branches move together');
  // Reversed on 2026-10-07 at the user's ask. This used to refuse and tell
  // the operator to pick a FROM branch — but a list of numbers read off a
  // sheet does not come from one depot, and splitting the move by hand was
  // the operator doing the server's bookkeeping. from_branch is optional
  // now: each lot leaves the depot that holds it.
  const span = await page.evaluate(() => {
    document.getElementById('ra-from').value = '';
    document.getElementById('ra-to').value = 'CUMBUM';
    const box = document.getElementById('ra-lots');
    box.value = '3,4,101,102';
    raSyncSelectionFromText();
    return { picked: Array.from(_raSelected).sort(),
             note: (document.getElementById('ra-lots-note').textContent || '').replace(/\s+/g, ' ') };
  });
  check('all four are selected, across both branches',
        span.picked.join(',') === '003,004,101,102', JSON.stringify(span.picked));
  check('and the note breaks the count down by source depot',
        /ANAVILASAM \(2\)/.test(span.note) && /BODINAYAKANUR \(2\)/.test(span.note), span.note);

  const narrowed = await page.evaluate(() => {
    document.getElementById('ra-from').value = 'BODINAYAKANUR';
    raOnFromBranchChange();
    return { picked: Array.from(_raSelected).sort(),
             note: (document.getElementById('ra-lots-note').textContent || '').replace(/\s+/g, ' ') };
  });
  check('picking a FROM branch still narrows the same text to it',
        narrowed.picked.join(',') === '101,102', JSON.stringify(narrowed.picked));
  check('…and says what it dropped', /2 outside BODINAYAKANUR/.test(narrowed.note), narrowed.note);

  console.log('\n[6b] A lot already in the destination has nowhere to go');
  const sameBr = await page.evaluate(() => {
    document.getElementById('ra-from').value = '';
    document.getElementById('ra-to').value = 'BODINAYAKANUR';
    const box = document.getElementById('ra-lots');
    box.value = '3,101,102';
    raSyncSelectionFromText();
    return { picked: Array.from(_raSelected).sort(),
             note: (document.getElementById('ra-lots-note').textContent || '').replace(/\s+/g, ' ') };
  });
  check('the two already in BODINAYAKANUR are dropped',
        sameBr.picked.join(',') === '003', JSON.stringify(sameBr.picked));
  check('and counted rather than silently vanishing',
        /2 already in BODINAYAKANUR/.test(sameBr.note), sameBr.note);

  console.log('\n[7] The box and the tiles are one selection, seen two ways');
  const mirrored = await page.evaluate(() => {
    document.getElementById('ra-from').value = '';
    document.getElementById('ra-to').value = 'CUMBUM';
    document.getElementById('ra-lots').value = '';
    raSyncSelectionFromText();
    const tile = (lot) => document.querySelector(`#ra-tile-grid [data-lot="${lot}"]`);
    raToggleTile(tile('016'));
    raToggleTile(tile('017'));
    raToggleTile(tile('020'));
    return document.getElementById('ra-lots').value;
  });
  check('clicking tiles writes them back as text', mirrored === '016-017, 020', mirrored);

  console.log('\n[8] The Edit panel find box narrows the chips');
  const found = await page.evaluate(() => {
    switchAllocTab('edit');
    document.getElementById('alloc-find').value = '3,15-17,101';
    allocApplyFind('3,15-17,101');
    return {
      lots: Array.from(document.querySelectorAll('#alloc-edit-cards [data-lot]')).map(e => e.getAttribute('data-lot')),
      note: (document.getElementById('alloc-find-note').textContent || '').replace(/\s+/g, ' '),
    };
  });
  check('only the typed lots are on screen',
        found.lots.join(',') === '003,015,016,017,101', JSON.stringify(found.lots));
  check('the note counts them', /5 found/.test(found.note), found.note);

  console.log('\n[9] "Mark all free" cannot reach a lot you cannot see');
  const marked = await page.evaluate(() => {
    _allocMarkAllFree('ANAVILASAM');
    return Array.from(_allocMarked).sort();
  });
  check('it marks the shown lots only',
        marked.join(',') === 'ANAVILASAM|003,ANAVILASAM|015,ANAVILASAM|016,ANAVILASAM|017',
        JSON.stringify(marked));
  const cleared = await page.evaluate(() => {
    document.getElementById('alloc-find').value = '';
    allocApplyFind('');
    return Array.from(document.querySelectorAll('#alloc-edit-cards [data-lot]')).length;
  });
  check('clearing the box brings the grid back', cleared === 22, String(cleared));

  console.log('\n[10] The commit button is reachable without scrolling');
  // A trade of 300 numbers makes both panels taller than the modal. The
  // button that actually does the work used to be at the bottom of all of
  // it, so every move ended with a scroll hunt for it; both panels now pin
  // their actions to the foot of the modal's own scrollport.
  const TALL = [{ branch: 'ANAVILASAM', used: 0, total: 300, ranges: [{ start: '001', end: '300',
    lots: Array.from({ length: 300 }, (_, i) => LOT(i + 1, 'free')) }] }];
  await page.setViewport({ width: 1280, height: 720 });
  const reach = await page.evaluate((stats) => {
    _raAllocStats = stats; _raSelected = new Set(); _allocShownStates.clear(); _allocFindSet = null;
    switchAllocTab('edit'); renderAllocEditCards(stats);
    switchAllocTab('reassign'); renderReassignTiles();
    const modal = document.querySelector('#alloc-modal .modal');
    modal.scrollTop = 0;                       // the state the modal OPENS in
    const seen = (sel, re) => {
      const btn = Array.from(document.querySelectorAll(sel + ' button')).find(b => re.test(b.textContent || ''));
      if (!btn) return { found: false };
      const m = modal.getBoundingClientRect(), b = btn.getBoundingClientRect();
      return { found: true, inView: b.bottom <= m.bottom + 1 && b.top >= m.top };
    };
    const ra = seen('#alloc-panel-reassign', /Reassign Selected/);
    switchAllocTab('edit');
    modal.scrollTop = 0;
    const ed = seen('#alloc-panel-edit', /Save Allocations/);
    return {
      scrollable: modal.scrollHeight > modal.clientHeight + 2,
      sticky: getComputedStyle(document.querySelector('#alloc-panel-reassign .alloc-foot')).position,
      ra, ed,
    };
  }, TALL);
  check('the panel really is taller than the modal', reach.scrollable === true, JSON.stringify(reach));
  check('the footer is pinned, not just placed last', reach.sticky === 'sticky', reach.sticky);
  check('Reassign Selected is on screen at scrollTop 0',
        reach.ra.found && reach.ra.inView === true, JSON.stringify(reach.ra));
  check('…and so is Save Allocations on the Edit tab',
        reach.ed.found && reach.ed.inView === true, JSON.stringify(reach.ed));
  await page.setViewport({ width: 1440, height: 1000 });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
