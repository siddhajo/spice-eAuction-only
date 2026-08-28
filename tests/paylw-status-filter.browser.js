// Lot-wise Payments — the Payment status control, driven through the real
// screen in a headless Chrome.
//
//   [labels]  the options carry live counts once a search has run, and go
//             back to plain text when the results are cleared
//   [filter]  picking one re-searches and shows only that bucket
//   [tell]    a filtered list SAYS it is filtered, and an empty one says the
//             filter is why — a narrowed list that looks like the whole trade
//             is how "my lots have disappeared" happens
//   [clear]   ✕ Clear resets it, so no filter is left armed behind a screen
//             that looks clean
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-status-ui-'));
const PORT = 47389;
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
  if (!TOKEN) { console.error('login failed', login.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('PUT', '/api/company-settings', { settings: { flag_lotwise_payments: 'true' } });

  const auc = await api('POST', '/api/auctions', { ano: '31', date: '2026-08-28', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  const t = await api('POST', '/api/traders', {
    name: 'ANNAMALAI', cr: '', padd: 'ADDR', ppla: 'PLACE',
    banks: [{ acctnum: '1000012345', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'ANNAMALAI', is_default: 1 }],
  });
  const traderId = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
  // 1 paid · 2 advance · 3 and 4 untouched.
  const lotIds = {};
  for (const lot_no of ['1', '2', '3', '4']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'ANNAMALAI', cr: '', qty: 100, grade: '2', bags: 10,
      crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: traderId,
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    lotIds[lot_no] = id;
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800, code: 'B1', sale: 'L' });
  }
  await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: lotIds['2'], advance: 1200 }] });
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [lotIds['1']] });

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
  await page.evaluate(a => {
    if (typeof showTab === 'function') showTab('payments');
    const sel = document.getElementById('paylw-auction');
    if (sel) sel.value = String(a);
  }, aid);
  await page.evaluate(() => loadPayLotwise && loadPayLotwise());
  await page.evaluate(a => {
    const sel = document.getElementById('paylw-auction');
    if (sel) { sel.value = String(a); payLwOnAuctionChange(); }
  }, aid);

  const options = () => page.evaluate(() => {
    const s = document.getElementById('paylw-status');
    return s ? { value: s.value, labels: Array.from(s.options).map(o => o.textContent.trim()) } : null;
  });
  const shownLots = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body tbody tr'))
    .map(tr => (tr.children[2]?.textContent || '').trim()).join(','));
  const summaryText = () => page.evaluate(() =>
    (document.getElementById('paylw-summary')?.textContent || '').replace(/\s+/g, ' ').trim());
  const bodyText = () => page.evaluate(() =>
    (document.getElementById('paylw-body')?.textContent || '').replace(/\s+/g, ' ').trim());
  const setStatus = async (v) => {
    await page.evaluate(val => {
      const s = document.getElementById('paylw-status');
      s.value = val;
      s.dispatchEvent(new Event('change'));
    }, v);
    await page.waitForFunction(() => {
      const b = document.getElementById('paylw-body');
      return b && !/Searching…/.test(b.textContent);
    }, { timeout: 8000 });
  };
  const search = async () => {
    await page.evaluate(() => { const s = document.getElementById('paylw-link'); if (s) s.value = 'all'; });
    await page.evaluate(() => payLwSearch());
    await page.waitForFunction(() => {
      const b = document.getElementById('paylw-body');
      return b && (b.querySelector('table') || /No lot|No lots matched|No unlinked/.test(b.textContent));
    }, { timeout: 8000 });
  };

  console.log('[labels] before any search');
  let o = await options();
  check('the control exists, defaulting to Any status', o && o.value === 'all', JSON.stringify(o));
  check('its options are the three states plus Any',
        o && o.labels.join('|') === 'Any status|Unpaid|Advance paid|Paid', JSON.stringify(o));

  console.log('\n[labels] after a search they carry live counts');
  await search();
  o = await options();
  check('Any status counts every matching lot', o.labels[0] === 'Any status (4)', JSON.stringify(o.labels));
  check('Unpaid (2) · Advance paid (1) · Paid (1)',
        o.labels.slice(1).join(' · ') === 'Unpaid (2) · Advance paid (1) · Paid (1)', JSON.stringify(o.labels));

  console.log('\n[filter] picking one narrows the table');
  await setStatus('paid');
  check('paid shows only lot 1', (await shownLots()) === '1', await shownLots());
  await setStatus('advance');
  check('advance paid shows only lot 2', (await shownLots()) === '2', await shownLots());
  await setStatus('unpaid');
  check('unpaid shows lots 3 and 4', (await shownLots()) === '3,4', await shownLots());

  console.log('\n[labels] the counts stay whole-match while filtered');
  o = await options();
  check('they still read 2/1/1 with unpaid selected',
        o.labels.slice(1).join(' · ') === 'Unpaid (2) · Advance paid (1) · Paid (1)', JSON.stringify(o.labels));
  check('…and the selected option is the one that was picked', o.value === 'unpaid', o.value);

  console.log('\n[tell] a filtered list says so');
  let s = await summaryText();
  check('the summary names the filter and what it hides',
        /Showing only lots not paid at all/i.test(s) && /2 other matching lots are hidden/i.test(s), s);
  await setStatus('paid');
  s = await summaryText();
  check('and says PAID when that is the filter', /Showing only lots PAID/.test(s), s);

  console.log('\n[tell] an empty result blames the filter, not the search');
  // Undo the only paid lot: "paid" now matches nothing.
  await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [lotIds['1']] });
  await setStatus('paid');
  const empty = await bodyText();
  check('the empty state names the status filter as the reason',
        /No lot in this search is paid/i.test(empty) && /Any status/.test(empty), empty.slice(0, 200));

  console.log('\n[explain] a lot asked for by number and hidden says why');
  await page.evaluate(() => { document.getElementById('paylw-lots').value = '2'; });
  await setStatus('paid');
  const explained = await bodyText();
  check('it points at the Payment status filter',
        /Hidden by the Payment status filter/i.test(explained), explained.slice(0, 260));
  check('…and says the lot is part-paid by an advance',
        /part-paid by an ADVANCE/i.test(explained), explained.slice(0, 260));

  console.log('\n[clear] ✕ Clear resets the filter too');
  await page.evaluate(() => payLwClear());
  o = await options();
  check('it goes back to Any status', o.value === 'all', JSON.stringify(o));
  check('…with plain labels, since there are no results to count',
        o.labels.join('|') === 'Any status|Unpaid|Advance paid|Paid', JSON.stringify(o.labels));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
