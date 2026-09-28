// Dummy Seller Details — the Lots-tab surface, driven in a real browser.
//
// The server side is covered by lot-dummy-details.http.js and the printing
// side by lot-dummy-details.unit.js. What neither can see is whether an
// operator can actually reach the feature: the button only exists when the
// flag is ON *and* a lot is ticked (two independent gates that have to agree),
// and the modal's blank-means-unchanged contract lives in the client, not the
// endpoint — it is the client that decides which keys to send.
//
//   [gate]     the button stays hidden with the flag OFF, ticked lots or not
//   [appears]  flag ON + a ticked lot surfaces it, with a live count
//   [apply]    typing two of four fields writes exactly those two
//   [prefill]  re-opening shows what is set; a mixed selection says "mixed"
//   [badge]    a masked lot is marked in the table, so it is visible at a glance
//   [clear]    Clear All removes all four
//   [picker]   Dummy Name searches the sellers master, and choosing a hit
//              copies that seller's phone, CR and grade in one go — all four
//              boxes or none, never a stitched-together half-identity
//   [cascade]  emptying Dummy Name empties the other three with it, and the
//              ✕ in the box does the same — a phone and a GSTIN left under
//              no name would still print on the portal CSV
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lot-dummy-ui-'));
const PORT = 47394;
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
  const lr = await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const ld = await lr.json();
  TOKEN = ld && (ld.token || ld.accessToken);
  if (!TOKEN) { console.error('login failed', ld, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  const auc = await api('POST', '/api/auctions', { ano: '63', date: '2026-09-17', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const lotIds = [];
  for (const lot_no of ['001', '002']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'REAL SELLER ' + lot_no, qty: 100, grade: '2', bags: 10, branch: 'ANAVILASAM',
    });
    lotIds.push(r.d.id || (r.d.lot && r.d.lot.id));
  }
  check('two lots created', lotIds.every(Boolean), JSON.stringify(lotIds));

  // Two sellers for the Dummy Name picker: a planter (CR → Grade 1) and a
  // dealer (GSTIN → Grade 2), so the derived grade is actually discriminating
  // rather than always answering '1'. The third has NO phone and NO CR, which
  // is the case that proves a pick clears stale boxes instead of leaving the
  // previous seller's number behind.
  const SELLERS = [
    { name: 'KUMARASAMY ESTATE', cr: 'CR.7001', tel: '9440000001', ppla: 'BODI' },
    { name: 'KUMAR SPICES LLP',  cr: 'GSTIN.33AAMCM4500C1Z2', tel: '9440000002', ppla: 'THENI' },
    { name: 'KUMARAN BARE',      cr: '', tel: '', ppla: 'VANDAN' },
  ];
  for (const sl of SELLERS) await api('POST', '/api/traders', sl);

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
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#lot-dummy-modal', { timeout: 15000 });

  // Open the Lots tab on our trade and tick both lots.
  async function openLotsAndTick(ids) {
    await page.evaluate(async (aid, ids) => {
      go('lots');
      // loadLotAuctions() fires and forgets; await the fill itself so the
      // trade is actually in the <select> before we pick it.
      await fillAucSelect('lot-auction');
      const sel = document.getElementById('lot-auction');
      if (sel) { sel.value = String(aid); }
      await loadLots();
      // .lot-select-cb is the class BulkActions.getCheckboxes('lot') looks
      // for, and the row wires BulkActions._sync to onclick — so click,
      // don't just set .checked, or the toolbar never learns about it.
      document.querySelectorAll('#lots-list .lot-select-cb').forEach(cb => {
        if (ids.includes(Number(cb.value)) && !cb.checked) cb.click();
      });
    }, aid, ids);
    await new Promise(r => setTimeout(r, 400));
  }
  const btnShown = () => page.evaluate(() => {
    const el = document.getElementById('lot-bulk-dummy');
    if (!el) return 'missing';
    return getComputedStyle(el).display === 'none' ? 'hidden' : 'shown';
  });

  console.log('[gate] with the flag OFF the button never appears');
  await openLotsAndTick(lotIds);
  check('both lots are ticked', (await page.evaluate(() => BulkActions.getTickedIds('lot').length)) === 2);
  check('the button is hidden even so', (await btnShown()) === 'hidden', await btnShown());

  console.log('[appears] flag ON + a ticked lot surfaces it');
  await api('PUT', '/api/company-settings', { settings: { flag_lot_dummy_details: 'true' } });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#lot-dummy-modal', { timeout: 15000 });
  check('untick → still hidden', (await page.evaluate(async (aid) => {
    go('lots');
    await fillAucSelect('lot-auction');
    const sel = document.getElementById('lot-auction'); if (sel) sel.value = String(aid);
    await loadLots();
    return getComputedStyle(document.getElementById('lot-bulk-dummy')).display === 'none';
  }, aid)) === true);
  await openLotsAndTick(lotIds);
  check('tick → shown', (await btnShown()) === 'shown', await btnShown());
  check('…with a live count of 2',
        (await page.evaluate(() => document.querySelector('#lot-bulk-dummy [data-bulk-count]').textContent)).includes('2'));

  console.log('[apply] only the fields typed into are sent');
  // Watch the request body, since "which keys the client sends" IS the contract.
  let sent = null;
  page.on('request', req => {
    if (req.url().includes('/api/lots/dummy-details/bulk') && req.method() === 'POST') {
      try { sent = JSON.parse(req.postData() || '{}'); } catch (_) {}
    }
  });
  await page.evaluate(() => openLotDummyDetailsModal());
  await new Promise(r => setTimeout(r, 500));
  check('the modal is open on 2 lots',
        (await page.evaluate(() => document.getElementById('ldd-count').textContent)) === '2');
  await page.evaluate(() => {
    document.getElementById('ldd-name').value = 'DUMMY CO';
    document.getElementById('ldd-cr').value   = 'CR.9999';
    applyLotDummyDetails();
  });
  await new Promise(r => setTimeout(r, 900));
  check('name and CR were sent', sent && sent.dummy_name === 'DUMMY CO' && sent.dummy_cr === 'CR.9999',
        JSON.stringify(sent));
  check('phone and grade were NOT sent at all — blank means unchanged',
        sent && !('dummy_tel' in sent) && !('dummy_grade' in sent), JSON.stringify(sent));
  const after = await api('GET', `/api/lots/${aid}`);
  const row1 = after.d.find(l => Number(l.id) === lotIds[0]);
  check('the lot now carries the dummy name', String(row1.dummy_name) === 'DUMMY CO', row1.dummy_name);
  check('…and its REAL name is untouched', String(row1.name) === 'REAL SELLER 001', row1.name);

  console.log('[badge] the table marks a masked lot');
  await page.evaluate(() => loadLots());
  await new Promise(r => setTimeout(r, 500));
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll('#lots-list span')].filter(s => s.textContent.includes('DUMMY')).length);
  check('both rows show a DUMMY badge', badges === 2, String(badges));

  console.log('[prefill] re-opening shows what is already set');
  await openLotsAndTick(lotIds);
  await page.evaluate(() => openLotDummyDetailsModal());
  await new Promise(r => setTimeout(r, 900));
  let boxes = await page.evaluate(() => ({
    name: document.getElementById('ldd-name').value,
    cr:   document.getElementById('ldd-cr').value,
    tel:  document.getElementById('ldd-tel').value,
  }));
  check('the shared name is prefilled', boxes.name === 'DUMMY CO', JSON.stringify(boxes));
  check('an unset field stays blank',   boxes.tel === '',          JSON.stringify(boxes));
  await page.evaluate(() => hideModal('lot-dummy-modal'));

  // Give the two lots DIFFERENT names, then re-open on both.
  await api('POST', '/api/lots/dummy-details/bulk', { ids: [lotIds[1]], dummy_name: 'OTHER CO' });
  await openLotsAndTick(lotIds);
  await page.evaluate(() => openLotDummyDetailsModal());
  await new Promise(r => setTimeout(r, 900));
  boxes = await page.evaluate(() => ({
    name: document.getElementById('ldd-name').value,
    ph:   document.getElementById('ldd-name').placeholder,
  }));
  check('a mixed selection leaves the box blank', boxes.name === '', JSON.stringify(boxes));
  check('…and says so in the placeholder', /mixed/i.test(boxes.ph), boxes.ph);

  console.log('[clear] Clear All wipes all four');
  page.once('dialog', d => d.accept());
  await page.evaluate(() => clearLotDummyDetails());
  await new Promise(r => setTimeout(r, 900));
  const cleared = (await api('GET', `/api/lots/${aid}`)).d;
  check('no lot has any dummy field left',
        cleared.every(l => !String(l.dummy_name || '') && !String(l.dummy_tel || '')
                        && !String(l.dummy_cr || '') && !String(l.dummy_grade || '')),
        JSON.stringify(cleared.map(l => [l.lot_no, l.dummy_name, l.dummy_cr])));

  console.log('[picker] Dummy Name searches sellers and copies the whole identity');
  await openLotsAndTick(lotIds);
  await page.evaluate(() => openLotDummyDetailsModal());
  await new Promise(r => setTimeout(r, 900));
  // Type into the box the way a person does, so the debounce and the
  // oninput wiring are both exercised.
  await page.focus('#ldd-name');
  await page.evaluate(() => { document.getElementById('ldd-name').value = ''; });
  await page.type('#ldd-name', 'KUMAR', { delay: 30 });
  await new Promise(r => setTimeout(r, 900));
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll('#ldd-name-dd .ldd-row')].map(r => r.querySelector('div').textContent));
  check('the dropdown lists matching sellers', hits.length === 3, JSON.stringify(hits));
  check('…a single letter does NOT search', await page.evaluate(async () => {
    const el = document.getElementById('ldd-name');
    el.value = 'K'; el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('ldd-name-dd').style.display === 'none';
  }));

  // Re-open the list and pick the DEALER, whose grade must derive to 2.
  await page.evaluate(() => { const el = document.getElementById('ldd-name'); el.value = ''; });
  await page.type('#ldd-name', 'KUMAR SPICES', { delay: 30 });
  await new Promise(r => setTimeout(r, 900));
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#ldd-name-dd .ldd-row')];
    const row = rows.find(r => r.textContent.includes('KUMAR SPICES LLP'));
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  let boxes4 = await page.evaluate(() => ({
    name: document.getElementById('ldd-name').value,
    tel:  document.getElementById('ldd-tel').value,
    cr:   document.getElementById('ldd-cr').value,
    grade: document.getElementById('ldd-grade').value,
    dd:   document.getElementById('ldd-name-dd').style.display,
    src:  document.getElementById('ldd-source').style.display,
  }));
  check('picking fills the name', boxes4.name === 'KUMAR SPICES LLP', JSON.stringify(boxes4));
  check('…the phone',             boxes4.tel === '9440000002',        JSON.stringify(boxes4));
  check('…the CR',                boxes4.cr === 'GSTIN.33AAMCM4500C1Z2', JSON.stringify(boxes4));
  check('…and a GSTIN seller derives Grade 2', boxes4.grade === '2',  JSON.stringify(boxes4));
  check('the dropdown closes on pick',  boxes4.dd === 'none',         JSON.stringify(boxes4));
  check('…and the source line appears', boxes4.src !== 'none',        JSON.stringify(boxes4));

  console.log('[picker] a CR seller derives Grade 1, and a pick clears what the new seller lacks');
  await page.evaluate(() => { const el = document.getElementById('ldd-name'); el.value = ''; });
  await page.type('#ldd-name', 'KUMARASAMY', { delay: 30 });
  await new Promise(r => setTimeout(r, 900));
  await page.evaluate(() => {
    document.querySelectorAll('#ldd-name-dd .ldd-row')[0]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  boxes4 = await page.evaluate(() => ({
    cr: document.getElementById('ldd-cr').value,
    grade: document.getElementById('ldd-grade').value,
  }));
  check('a CR seller derives Grade 1', boxes4.grade === '1' && boxes4.cr === 'CR.7001', JSON.stringify(boxes4));

  // The seller with nothing on file — the boxes must EMPTY, not keep the
  // previous seller's phone and CR.
  await page.evaluate(() => { const el = document.getElementById('ldd-name'); el.value = ''; });
  await page.type('#ldd-name', 'KUMARAN BARE', { delay: 30 });
  await new Promise(r => setTimeout(r, 900));
  await page.evaluate(() => {
    document.querySelectorAll('#ldd-name-dd .ldd-row')[0]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  boxes4 = await page.evaluate(() => ({
    name: document.getElementById('ldd-name').value,
    tel:  document.getElementById('ldd-tel').value,
    cr:   document.getElementById('ldd-cr').value,
    src:  document.getElementById('ldd-source').textContent,
  }));
  check('the name is the new seller', boxes4.name === 'KUMARAN BARE', JSON.stringify(boxes4));
  check('…and the previous seller\'s phone is GONE, not left behind',
        boxes4.tel === '' && boxes4.cr === '', JSON.stringify(boxes4));
  check('…and the source line says what was missing', /no phone or CR/i.test(boxes4.src), boxes4.src);

  console.log('[cascade] the name governs the other three');
  // Start from a full identity, picked from the master.
  await page.evaluate(() => { const el = document.getElementById('ldd-name'); el.value = ''; });
  await page.type('#ldd-name', 'KUMAR SPICES', { delay: 30 });
  await new Promise(r => setTimeout(r, 900));
  await page.evaluate(() => {
    document.querySelectorAll('#ldd-name-dd .ldd-row')[0]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  const all4 = () => page.evaluate(() => ({
    name: document.getElementById('ldd-name').value,
    tel:  document.getElementById('ldd-tel').value,
    cr:   document.getElementById('ldd-cr').value,
    grade: document.getElementById('ldd-grade').value,
    x:    getComputedStyle(document.getElementById('ldd-name-clear')).display,
  }));
  let st = await all4();
  check('all four are filled to begin with', st.name && st.tel && st.cr && st.grade, JSON.stringify(st));
  check('the ✕ is showing', st.x !== 'none', JSON.stringify(st));

  // Empty the name the way a person does — select all, delete.
  await page.focus('#ldd-name');
  await page.evaluate(() => document.getElementById('ldd-name').select());
  await page.keyboard.press('Backspace');
  await new Promise(r => setTimeout(r, 400));
  st = await all4();
  check('emptying the name empties the phone', st.tel === '', JSON.stringify(st));
  check('…the CR',                             st.cr === '',  JSON.stringify(st));
  check('…and the grade',                      st.grade === '', JSON.stringify(st));
  check('the ✕ hides when there is nothing to clear', st.x === 'none', JSON.stringify(st));

  console.log('[cascade] retyping a name does NOT wipe the identity it belongs to');
  // Select-all-and-retype replaces in one input event, never passing through
  // empty — so an edit must keep the fields, unlike a delete.
  await page.evaluate(() => {
    const el = document.getElementById('ldd-name');
    el.value = 'KUMARASAMY'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 900));
  await page.evaluate(() => {
    document.querySelectorAll('#ldd-name-dd .ldd-row')[0]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => {
    // One event, old value fully replaced — the shape a paste or a
    // select-all-then-type produces.
    const el = document.getElementById('ldd-name');
    el.value = 'RENAMED BY HAND'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 500));
  st = await all4();
  check('the retyped name stands', st.name === 'RENAMED BY HAND', JSON.stringify(st));
  check('…and the phone it was copied with survives', st.tel === '9440000001', JSON.stringify(st));

  console.log('[cascade] the ✕ clears the whole identity');
  st = await all4();
  check('the ✕ is showing again', st.x !== 'none', JSON.stringify(st));
  await page.click('#ldd-name-clear');
  await new Promise(r => setTimeout(r, 300));
  st = await all4();
  check('every box is empty', !st.name && !st.tel && !st.cr && !st.grade, JSON.stringify(st));
  check('…and the ✕ is gone', st.x === 'none', JSON.stringify(st));
  check('…and with nothing to send, Apply says so rather than writing a blank',
        await page.evaluate(async () => {
          let toasted = '';
          const orig = window.toast;
          window.toast = (m) => { toasted = String(m); };
          await applyLotDummyDetails();
          window.toast = orig;
          return /at least one|Clear All/i.test(toasted);
        }));

  console.log('[picker] a name nobody holds is still accepted');
  await page.evaluate(() => {
    const el = document.getElementById('ldd-name');
    el.value = 'ZZZ INVENTED NAME';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 800));
  check('a hand-typed name drops the "copied from" line',
        (await page.evaluate(() => document.getElementById('ldd-source').style.display)) === 'none');
  sent = null;
  await page.evaluate(() => applyLotDummyDetails());
  await new Promise(r => setTimeout(r, 900));
  check('…and applies as typed', sent && sent.dummy_name === 'ZZZ INVENTED NAME', JSON.stringify(sent));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); });
