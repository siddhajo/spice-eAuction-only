// Lot Entry — while EDITING a lot, its number is picked from the grid, never
// typed. Desktop console and mobile PWA, in a headless Chrome.
//
// Typing a number over a saved lot is a blind edit: the box says nothing about
// whether that number is free or already carries someone else's lot, and the
// operator finds out only when the save is refused (or worse, is not). The
// chip grid answers both before the click, so in edit mode the box becomes a
// read-out of the grid.
//
// Two things this must NOT break:
//   • CREATE mode stays typeable. A branch with no allocation has no chips at
//     all, and a locked box there would make lot entry impossible.
//   • Picking a chip while editing must KEEP the weights on screen. They belong
//     to the lot being renumbered; the create-mode path deliberately clears
//     them, and running that here would empty the very lot being moved.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'le-lotno-'));
const PORT = 47374;
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

  // ══ DESKTOP ══════════════════════════════════════════════════════
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('lotentry'); });
  await page.waitForSelector('#le-lotno', { timeout: 15000 });

  const lotNoState = () => page.evaluate(() => {
    const i = document.getElementById('le-lotno');
    return { readOnly: i.readOnly, value: i.value, title: i.title };
  });

  console.log('[1] Create mode — the box is typeable');
  let st = await lotNoState();
  check('not read-only before any edit starts', st.readOnly === false, JSON.stringify(st));

  console.log('\n[2] Editing a lot locks it and says how to change it');
  // Drive the real edit path: leEditLot reads the lot out of _le.recentLots.
  await page.evaluate(() => {
    _le.recentLots = [{ id: 4242, lot_no: '007', grade: '2', bags: 10, litre: 500, qty: 123.456,
                        sample_wt: 0, name: 'ANNAMALAI', trader_id: null, created_at: null }];
    _le.editEnabled = true;
    window._userRole = 'admin';
    leEditLot(4242);
  });
  st = await lotNoState();
  check('read-only while editing', st.readOnly === true, JSON.stringify(st));
  check('holds the lot\'s current number', st.value === '007', JSON.stringify(st.value));
  check('and says to pick from the grid', /pick a free lot/i.test(st.title || ''), JSON.stringify(st.title));
  check('the edit banner names the lot',
        (await page.evaluate(() => document.getElementById('le-edit-lotno').textContent)) === '007');

  console.log('\n[3] Picking a chip moves the lot and KEEPS its weights');
  const moved = await page.evaluate(() => {
    lePickLot('012');
    return {
      lot:   document.getElementById('le-lotno').value,
      bags:  document.getElementById('le-bags').value,
      qty:   document.getElementById('le-qty').value,
      banner: document.getElementById('le-edit-lotno').textContent,
      stillLocked: document.getElementById('le-lotno').readOnly,
    };
  });
  check('the number moves to the picked chip', moved.lot === '012', JSON.stringify(moved.lot));
  check('bags survive the move', moved.bags === '10', JSON.stringify(moved.bags));
  check('weight survives the move', String(moved.qty).startsWith('123.4'), JSON.stringify(moved.qty));
  check('the banner shows where it is going', moved.banner === '007 → 012', JSON.stringify(moved.banner));
  check('the box stays locked after the pick', moved.stillLocked === true);

  console.log('\n[4] Leaving edit mode hands the box back');
  await page.evaluate(() => leExitEditMode());
  st = await lotNoState();
  check('typeable again', st.readOnly === false, JSON.stringify(st));
  check('and cleared for the next lot', st.value === '', JSON.stringify(st.value));
  check('with no leftover "pick a lot" hint', !st.title, JSON.stringify(st.title));

  console.log('\n[5] Create mode still clears the weights when the lot changes');
  // The confirm is auto-accepted by the dialog handler above.
  const created = await page.evaluate(() => {
    document.getElementById('le-lotno').value = '020';
    document.getElementById('le-bags').value = '9';
    document.getElementById('le-qty').value = '55';
    lePickLot('021');
    return {
      lot:  document.getElementById('le-lotno').value,
      bags: document.getElementById('le-bags').value,
      qty:  document.getElementById('le-qty').value,
    };
  });
  check('the number changes', created.lot === '021', JSON.stringify(created.lot));
  check('and the weights are cleared, as before', created.bags === '' && created.qty === '',
        JSON.stringify(created));

  // ══ MOBILE ═══════════════════════════════════════════════════════
  console.log('\n[6] Mobile Edit Lot — locked, with a Change button');
  const mob = await browser.newPage();
  mob.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await mob.waitForSelector('#ed-lotno', { timeout: 15000 });

  const mobState = () => mob.evaluate(() => {
    const i = document.getElementById('ed-lotno');
    const btn = document.getElementById('ed-lotno-change');
    return {
      readOnly: i.readOnly,
      value: i.value,
      btnShown: !!btn && btn.style.display !== 'none',
      pickerShown: document.getElementById('ed-lot-picker').style.display !== 'none',
      heading: document.getElementById('ed-lotno-display').textContent,
    };
  });

  const seedAlloc = (ranges) => mob.evaluate(r => {
    br = 'ANAVILASAM';
    allocStats = r ? [{ branch: 'ANAVILASAM', ranges: r }] : [];
  }, ranges);

  await seedAlloc([{ start: '001', end: '005', lots: [
    { lot: '001', used: true }, { lot: '002', used: false }, { lot: '003', used: true },
    { lot: '004', used: false }, { lot: '005', used: false },
  ] }]);
  await mob.evaluate(() => openEdit(11, '001', 'ANNAMALAI', '2', 10, 500, 123.456, null, null));
  let ms = await mobState();
  check('the lot number is read-only', ms.readOnly === true, JSON.stringify(ms));
  check('a Change button is offered', ms.btnShown === true, JSON.stringify(ms.btnShown));
  check('the picker starts closed', ms.pickerShown === false, JSON.stringify(ms.pickerShown));

  console.log('\n[7] The picker offers the free lots, plus this lot\'s own');
  const chips = await mob.evaluate(() => {
    edToggleLotPicker();
    return {
      open: document.getElementById('ed-lot-picker').style.display !== 'none',
      lots: Array.from(document.querySelectorAll('#ed-lot-picker-grid .lot-chip'))
              .map(c => c.getAttribute('data-lot')),
      help: document.getElementById('ed-lot-picker-help').textContent,
    };
  });
  check('Change opens it', chips.open === true);
  check('free lots are offered', ['002', '004', '005'].every(l => chips.lots.includes(l)), JSON.stringify(chips.lots));
  check('this lot\'s own number is shown so the move has a "from"',
        chips.lots.includes('001'), JSON.stringify(chips.lots));
  check("someone else's booked lot is not offered", !chips.lots.includes('003'), JSON.stringify(chips.lots));

  console.log('\n[8] Picking one moves the lot');
  const mp = await mob.evaluate(() => {
    edPickLot('004');
    return {
      value: document.getElementById('ed-lotno').value,
      heading: document.getElementById('ed-lotno-display').textContent,
      qty: document.getElementById('ed-qty').value,
    };
  });
  check('the box takes the picked number', mp.value === '004', JSON.stringify(mp.value));
  check('the heading shows old → new', mp.heading === '001 → 004', JSON.stringify(mp.heading));
  check('the weight is untouched', String(mp.qty).startsWith('123.4'), JSON.stringify(mp.qty));

  console.log('\n[9] A branch with NO allocation leaves the box typeable');
  // Nothing to pick from — locking here would strand the operator with no way
  // to correct a number at all.
  await seedAlloc(null);
  await mob.evaluate(() => openEdit(12, '077', 'ANNAMALAI', '2', 5, 500, 10, null, null));
  ms = await mobState();
  check('typeable', ms.readOnly === false, JSON.stringify(ms));
  check('and no Change button, since there is nothing to change to',
        ms.btnShown === false, JSON.stringify(ms.btnShown));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(srvLog.slice(-2000));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); cleanup(); process.exit(1); });
