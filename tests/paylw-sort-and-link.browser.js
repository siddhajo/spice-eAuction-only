// Payments — Lot-wise: column sorting + the Bank-account (linked/unlinked/all)
// filter, driven through the REAL screen in a headless Chrome.
//
// The screen hand-renders its table (no DataTable), so the only honest way to
// check "clicking Seller sorts by seller" is to click it and read the rows
// back. Boots a server on a throwaway data dir, seeds a trade whose lot
// numbers, sellers and branches each sort differently, then drives the UI.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-ui-'));
const PORT = 47331;
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

  await api('PUT', '/api/company-settings', { settings: { flag_lotwise_payments: 'true' } });

  const auc = await api('POST', '/api/auctions', { ano: '21', date: '2026-08-18', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  // Lot numbers, sellers and branches deliberately disagree with each other,
  // and "2 vs 10" appears in the lot numbers so a text sort would be visible.
  //   lot order   : 2, 9, 10, 21
  //   seller order: ANNAMALAI, BALAN, CHELLAM, DURAI
  //   branch order: ANAVILASAM, MARYKULAM, NIRAPPELKADA, (blank)
  const seed = [
    // lot, seller,      branch,          qty, price
    ['10', 'ANNAMALAI',  'NIRAPPELKADA',  100, 3000],
    ['2',  'DURAI',      'MARYKULAM',     150, 3000],
    ['21', 'BALAN',      '',              120, 3000],
    ['9',  'CHELLAM',    'ANAVILASAM',    110, 3000],
  ];
  const traderIds = {};
  for (const [lot_no, name, branch, qty, price] of seed) {
    // A seller master WITH a bank account makes its lots "linked". BALAN is
    // created with no account at all — the unlinked case. Accounts are created
    // through the trader's own `banks` array (see syncTraderBanks in server.js).
    if (!traderIds[name]) {
      const banks = name === 'BALAN' ? [] : [{
        acctnum: '10000' + (Object.keys(traderIds).length + 1), ifsc: 'HDFC0001234',
        bank_name: 'HDFC', holder_name: name, account_type: 'Savings', is_default: 1,
      }];
      const t = await api('POST', '/api/traders', { name, cr: '', padd: 'ADDR', ppla: 'PLACE', banks });
      traderIds[name] = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
      if (!traderIds[name]) { console.error('trader create failed', t.status, t.d); cleanup(); process.exit(1); }
    }
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, cr: '', qty, grade: '2', bags: 10,
      crop: 'CARDAMOM', branch, trader_id: traderIds[name],
    });
    const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    if (!lotId) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    await api('PUT', `/api/lots/${lotId}`, { price, amount: qty * price });
  }
  await api('POST', `/api/lots/calculate/${aid}`, {});

  // ── Drive the real screen ────────────────────────────────────────────
  // Same browser the PDF renderer uses; htmlToPdf keeps its resolver private,
  // so look in the same places it does.
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
  // Seed the session the way the login screen does (localStorage key 't'),
  // then reload into the app.
  await page.evaluate(t => { localStorage.setItem('t', t); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });

  // Open Payments and run an empty search over the trade.
  await page.evaluate(aid => {
    if (typeof showTab === 'function') showTab('payments');
    const sel = document.getElementById('paylw-auction');
    if (sel) sel.value = String(aid);
  }, aid);
  await page.evaluate(() => loadPayLotwise && loadPayLotwise());
  await page.evaluate(aid => {
    const sel = document.getElementById('paylw-auction');
    if (sel) { sel.value = String(aid); payLwOnAuctionChange(); }
  }, aid);

  const search = async (link) => {
    await page.evaluate(l => {
      const sel = document.getElementById('paylw-link');
      if (sel) sel.value = l;
    }, link);
    await page.evaluate(() => payLwSearch());
    await page.waitForFunction(() => {
      const b = document.getElementById('paylw-body');
      return b && (b.querySelector('table') || /No lots matched|No unlinked/.test(b.textContent));
    }, { timeout: 8000 });
  };
  const colOf = (idx) => page.evaluate(i => Array.from(
    document.querySelectorAll('#paylw-body tbody tr')).map(tr => (tr.children[i]?.textContent || '').trim()), idx);
  const sellers  = () => colOf(1);
  const lotsCol  = () => colOf(2);
  const branches = () => colOf(4);
  const clickHeader = async (label) => {
    await page.evaluate(l => {
      const th = Array.from(document.querySelectorAll('#paylw-body thead th'))
        .find(x => x.textContent.trim().replace(/[▲▼]/g, '').trim() === l);
      if (th) th.click();
    }, label);
  };

  console.log('[1] Bank account filter — linked / unlinked / all');
  await search('linked');
  let ls = await lotsCol();
  check('linked lists the 3 lots that have an account', ls.length === 3, JSON.stringify(ls));
  check('and BALAN (no account) is not among them',
        !(await sellers()).includes('BALAN'), JSON.stringify(await sellers()));

  await search('unlinked');
  check('unlinked lists only BALAN', JSON.stringify(await sellers()) === JSON.stringify(['BALAN']),
        JSON.stringify(await sellers()));

  await search('all');
  ls = await lotsCol();
  check('all lists every payable lot (4)', ls.length === 4, JSON.stringify(ls));
  check('all includes both the linked and the unlinked seller',
        (await sellers()).includes('BALAN') && (await sellers()).includes('DURAI'),
        JSON.stringify(await sellers()));
  const summaryTxt = await page.evaluate(() => document.getElementById('paylw-summary').textContent);
  check('the summary flags the unpayable ones inside "All"',
        /no bank account/.test(summaryTxt), JSON.stringify(summaryTxt.slice(0, 200)));
  // In "All" the unpayable lots are listed but NOT pre-ticked, so a
  // search-then-export doesn't trip the "no bank account" confirm.
  const tickState = await page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body tbody tr')).map(tr => ({
      seller: (tr.children[1]?.textContent || '').trim(),
      ticked: !!tr.querySelector('.paylw-cb')?.checked,
    })));
  check('"All" pre-ticks the 3 payable lots only',
        tickState.filter(r => r.ticked).length === 3, JSON.stringify(tickState));
  check('and leaves the unlinked seller unticked',
        tickState.find(r => r.seller === 'BALAN')?.ticked === false, JSON.stringify(tickState));

  console.log('\n[2] Sorting — Lot');
  check('default order is lot number ascending, numerically (2, 9, 10, 21)',
        JSON.stringify(await lotsCol()) === JSON.stringify(['2', '9', '10', '21']),
        JSON.stringify(await lotsCol()));
  await clickHeader('Lot');
  check('click 1 → ascending (unchanged here)',
        JSON.stringify(await lotsCol()) === JSON.stringify(['2', '9', '10', '21']),
        JSON.stringify(await lotsCol()));
  await clickHeader('Lot');
  check('click 2 → descending (21, 10, 9, 2)',
        JSON.stringify(await lotsCol()) === JSON.stringify(['21', '10', '9', '2']),
        JSON.stringify(await lotsCol()));
  await clickHeader('Lot');
  check('click 3 → back to the server order',
        JSON.stringify(await lotsCol()) === JSON.stringify(['2', '9', '10', '21']),
        JSON.stringify(await lotsCol()));

  console.log('\n[3] Sorting — Seller');
  await clickHeader('Seller');
  check('ascending by seller', JSON.stringify(await sellers())
        === JSON.stringify(['ANNAMALAI', 'BALAN', 'CHELLAM', 'DURAI']), JSON.stringify(await sellers()));
  check('…and the lots follow their seller, not lot order',
        JSON.stringify(await lotsCol()) === JSON.stringify(['10', '21', '9', '2']),
        JSON.stringify(await lotsCol()));
  await clickHeader('Seller');
  check('descending by seller', JSON.stringify(await sellers())
        === JSON.stringify(['DURAI', 'CHELLAM', 'BALAN', 'ANNAMALAI']), JSON.stringify(await sellers()));

  console.log('\n[4] Sorting — Branch (blanks last, both ways)');
  await clickHeader('Seller');            // reset to server order
  await clickHeader('Branch');
  check('ascending by branch, blank last', JSON.stringify(await branches())
        === JSON.stringify(['ANAVILASAM', 'MARYKULAM', 'NIRAPPELKADA', '']), JSON.stringify(await branches()));
  await clickHeader('Branch');
  check('descending by branch, blank STILL last', JSON.stringify(await branches())
        === JSON.stringify(['NIRAPPELKADA', 'MARYKULAM', 'ANAVILASAM', '']), JSON.stringify(await branches()));

  console.log('\n[5] Sorting is display-only');
  // The same lots stay ticked across every sort — selection is held by lot id,
  // not by row position. (3 of 4 here: "All" leaves the unlinked one unticked.)
  const tickedNow = await page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body tbody tr'))
    .filter(tr => tr.querySelector('.paylw-cb')?.checked)
    .map(tr => (tr.children[1]?.textContent || '').trim()).sort());
  const tickedBefore = tickState.filter(r => r.ticked).map(r => r.seller).sort();
  check('the same lots are still ticked after sorting',
        JSON.stringify(tickedNow) === JSON.stringify(tickedBefore),
        `before ${JSON.stringify(tickedBefore)} · after ${JSON.stringify(tickedNow)}`);
  check('the arrow shows on the sorted column only',
        (await page.evaluate(() => Array.from(document.querySelectorAll('#paylw-body thead th'))
          .filter(th => /[▲▼]/.test(th.textContent)).length)) === 1);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.slice(-1500));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); });
