// Price Entry — two things about working a trade in batches, in a real browser.
//
// [A] The "Select lots" box empties itself once its batch is done. The operator
//     types a handful of lot numbers, sets a buyer on them, and moves on to the
//     next handful — with the old numbers still sitting in the box, the next
//     batch is typed after someone else's list and "Select & bring to front"
//     re-pulls lots that were already dealt with.
//
// [B] The buyer-is-the-seller banner. A lot sold back to its own seller is
//     nearly always a mis-keyed buyer code, and it is invisible in a 300-row
//     grid: both columns look ordinary on their own. Two ways it is caught —
//     the same GSTIN (hard evidence) or the same name (worth a look) — matching
//     the lot modal's own warning so one lot cannot be flagged on one screen
//     and clean on the other. Clicking the banner narrows the grid to them,
//     which has to override the hide-completed rule: these lots are priced with
//     a buyer set, which is exactly the state that rule hides.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-batch-'));
const PORT = 47375;
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

const GSTIN_A = '33AAAAA0000A1Z5';    // the seller who also "bought"
const GSTIN_B = '33BBBBB1111B1Z5';    // an ordinary buyer

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  const auc = await api('POST', '/api/auctions', { ano: '51', date: '2026-09-09', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  // Two buyer records. SELFCO is the interesting one: a DIFFERENT trading name
  // on the SAME registration as the seller of lot 002 — which is the case only
  // the GSTIN rule can catch, since nothing about the two names looks alike.
  // (buyer_gstin is resolved server-side by joining buyers.buyer to lots.buyer,
  // so the lot's buyer NAME is what decides which GSTIN it carries.)
  await api('POST', '/api/buyers', { code: 'SELF', buyer: 'SELFCO', buyer1: 'SELFCO LTD', gstin: GSTIN_A, sale: 'L' });
  await api('POST', '/api/buyers', { code: 'OTHR', buyer: 'K TRADERS', buyer1: 'K TRADERS LLP', gstin: GSTIN_B, sale: 'L' });

  // Four lots:
  //   1 clean, 2 buyer GSTIN == seller CR, 3 buyer NAME == seller name,
  //   4 clean and still unpriced (so the grid has something ordinary in it).
  const lots = [
    { lot_no: '001', name: 'GREEN ESTATE', cr: GSTIN_A },
    { lot_no: '002', name: 'GREEN ESTATE', cr: GSTIN_A },
    { lot_no: '003', name: 'BLUE HILLS',   cr: '' },
    { lot_no: '004', name: 'RED SLOPE',    cr: '' },
  ];
  const id = {};
  for (const l of lots) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no: l.lot_no, name: l.name, cr: l.cr, qty: 100,
      grade: '2', bags: 10, branch: 'ANAVILASAM',
    });
    id[l.lot_no] = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
  }
  // 001 sold to a stranger. 002 sold to SELFCO — a different NAME on the
  // seller's own GSTIN, so only the GSTIN rule sees it. 003 sold to a buyer
  // whose name IS the seller's, with no GSTIN anywhere, so only the name rule
  // sees it. One lot for each rule, neither catchable by the other.
  await api('PUT', `/api/lots/${id['001']}`, { price: 100, amount: 10000, code: 'OTHR', buyer: 'K TRADERS', buyer1: 'K TRADERS LLP' });
  await api('PUT', `/api/lots/${id['002']}`, { price: 100, amount: 10000, code: 'SELF', buyer: 'SELFCO', buyer1: 'SELFCO LTD' });
  await api('PUT', `/api/lots/${id['003']}`, { price: 100, amount: 10000, code: 'OTHR', buyer: 'BLUE HILLS', buyer1: 'BLUE HILLS' });

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
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('priceentry'); });
  // loadPriceEntry fills the trade dropdown asynchronously; setting a value the
  // <select> does not hold yet silently leaves it blank, so wait for the option.
  await page.evaluate(() => loadPriceEntry());
  await page.waitForFunction(a => {
    const sel = document.getElementById('pe-auction');
    return sel && Array.from(sel.options).some(o => o.value === String(a));
  }, { timeout: 15000 }, aid);
  await page.evaluate(a => {
    const sel = document.getElementById('pe-auction');
    sel.value = String(a);
    loadPriceEntryGrid();
  }, aid);
  await page.waitForFunction(() => _pe && _pe.lots && _pe.lots.length === 4, { timeout: 10000 });

  const gridLots = () => page.evaluate(() => (_pe.view || []).map(l => l.lot_no));
  const banner = () => page.evaluate(() => {
    const el = document.getElementById('pe-sameparty-banner');
    return { shown: el.style.display !== 'none', text: (el.textContent || '').replace(/\s+/g, ' ').trim() };
  });

  // ══ [B] The banner ═══════════════════════════════════════════════
  console.log('[1] The banner counts the lots sold back to their own seller');
  let bn = await banner();
  check('it is shown', bn.shown === true, JSON.stringify(bn));
  check('and counts two of the four lots', /\b2 lots\b/.test(bn.text), bn.text);
  check('naming the GSTIN one as the harder evidence', /1 by GSTIN/.test(bn.text), bn.text);
  check('and the name one alongside it', /1 by name/.test(bn.text), bn.text);

  console.log('\n[2] It picks out the right lots, by either rule');
  const kinds = await page.evaluate(() => Object.fromEntries(
    _pe.lots.map(l => [l.lot_no, _peSamePartyKind(l)])));
  check('001 (stranger buyer) is clean', kinds['001'] === '', JSON.stringify(kinds));
  check('002 is caught by GSTIN', kinds['002'] === 'gstin', JSON.stringify(kinds));
  check('003 is caught by name', kinds['003'] === 'name', JSON.stringify(kinds));
  check('004 (no buyer yet) is clean', kinds['004'] === '', JSON.stringify(kinds));

  console.log('\n[3] Clicking it shows exactly those lots');
  // Completed rows are hidden by default, and both of these ARE complete —
  // so without the override this click would show an empty grid.
  const beforeClick = await gridLots();
  check('they are hidden to begin with (priced + buyer = complete)',
        !beforeClick.includes('002') && !beforeClick.includes('003'), JSON.stringify(beforeClick));
  await page.evaluate(() => peToggleSamePartyOnly());
  const during = await gridLots();
  check('the grid now holds just the two', during.length === 2, JSON.stringify(during));
  check('002 and 003, nothing else', during.includes('002') && during.includes('003'), JSON.stringify(during));
  bn = await banner();
  check('the banner offers the way back', /Show all lots/.test(bn.text), bn.text);

  console.log('\n[4] Clicking again restores the normal view');
  await page.evaluate(() => peToggleSamePartyOnly());
  const after = await gridLots();
  check('back to the default view', JSON.stringify(after) === JSON.stringify(beforeClick),
        JSON.stringify([after, beforeClick]));
  check('and the banner invites the filter again',
        /Show them/.test((await banner()).text), (await banner()).text);

  console.log('\n[5] Clear filters lifts it too — it is a filter by any reading');
  await page.evaluate(() => { peToggleSamePartyOnly(); peClearFilters(); });
  check('the narrowed view is gone', (await page.evaluate(() => _pe.sameOnly)) === false);

  // ══ [A] The quick-select box ═════════════════════════════════════
  console.log('\n[6] Setting a buyer empties the "Select lots" box');
  const typed = await page.evaluate(() => {
    const inp = document.getElementById('pe-lotno-input');
    inp.value = '4';
    peToggleLotNoClear();
    return { value: inp.value, clearShown: document.getElementById('pe-lotno-clear').style.display !== 'none' };
  });
  check('the numbers are typed in', typed.value === '4', JSON.stringify(typed.value));
  check('and its ✕ is showing', typed.clearShown === true);
  await page.evaluate(() => peSelectByLotNos());
  await page.waitForFunction(() => _pe.sel.size === 1, { timeout: 8000 });
  check('the lot is ticked', (await page.evaluate(() => _pe.sel.size)) === 1);

  await page.evaluate(() => openPeSetBuyerModal());
  await page.waitForFunction(() => document.getElementById('bulk-setbuyer-modal').classList.contains('show'),
    { timeout: 8000 });
  await page.evaluate(() => {
    // Pick the buyer the way the modal's own autocomplete would.
    _bsbSelected = _lotBuyerCache.find(b => b.code === 'OTHR');
    document.getElementById('bsb-code').value = 'OTHR';
  });
  await page.evaluate(() => applyBulkSetBuyer());
  await page.waitForFunction(() => !document.getElementById('bulk-setbuyer-modal').classList.contains('show'),
    { timeout: 10000 });
  await page.waitForFunction(() => _pe.sel.size === 0, { timeout: 10000 });

  const afterApply = await page.evaluate(() => ({
    value: document.getElementById('pe-lotno-input').value,
    clearShown: document.getElementById('pe-lotno-clear').style.display !== 'none',
    buyer: (_pe.lots.find(l => l.lot_no === '004') || {}).buyer,
  }));
  check('the buyer really was applied', afterApply.buyer === 'K TRADERS', JSON.stringify(afterApply.buyer));
  check('the box is empty, ready for the next batch', afterApply.value === '', JSON.stringify(afterApply.value));
  check('and its ✕ is hidden again', afterApply.clearShown === false, JSON.stringify(afterApply.clearShown));

  console.log('\n[7] Clearing a buyer code finishes a batch the same way');
  await page.evaluate(() => {
    document.getElementById('pe-lotno-input').value = '1';
    peToggleLotNoClear();
    _pe.sel = new Set([_pe.lots.find(l => l.lot_no === '001').id]);
  });
  await page.evaluate(() => peClearBuyerCode());
  await page.waitForFunction(() => document.getElementById('pe-lotno-input').value === '', { timeout: 10000 });
  check('the box empties after Clear Buyer Code too',
        (await page.evaluate(() => document.getElementById('pe-lotno-input').value)) === '');

  console.log('\n[8] The ✕ button still hands focus back; the automatic clear does not');
  // Asserted by counting focus() calls rather than reading document.activeElement:
  // focus does not actually land in this headless page (a direct inp.focus()
  // leaves activeElement unchanged), so activeElement would test the harness.
  // The behaviour that matters is which path ASKS for focus — the ✕ is pressed
  // mid-typing and should keep the cursor, while the clear that follows a saved
  // batch must not yank the page back to a box nobody is looking at.
  const focusCalls = await page.evaluate(() => {
    const inp = document.getElementById('pe-lotno-input');
    let n = 0;
    const real = inp.focus.bind(inp);
    inp.focus = () => { n++; real(); };
    inp.value = '7';
    peClearLotNoInput();                        // the ✕ button's call
    const afterX = { value: inp.value, calls: n };
    inp.value = '8';
    peClearLotNoInput({ keepFocus: false });    // the automatic call
    const afterAuto = { value: inp.value, calls: n };
    delete inp.focus;
    return { afterX, afterAuto };
  });
  check('the ✕ clears the box', focusCalls.afterX.value === '', JSON.stringify(focusCalls.afterX));
  check('…and asks for focus back', focusCalls.afterX.calls === 1, JSON.stringify(focusCalls.afterX));
  check('the automatic clear also empties it', focusCalls.afterAuto.value === '', JSON.stringify(focusCalls.afterAuto));
  check('…without stealing focus', focusCalls.afterAuto.calls === 1, JSON.stringify(focusCalls.afterAuto));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(srvLog.slice(-2000));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); cleanup(); process.exit(1); });
