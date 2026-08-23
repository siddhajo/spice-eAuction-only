// Two list-screen UX changes, verified in a real headless Chrome:
//
//   [A] Sales Invoice — the ⬆ Raise Original control sits INLINE beside the
//       buyer name on proforma rows, and is no longer duplicated inside the
//       row's ⋯ actions menu.
//   [B] Pagination — picking "500 / page" renders every row at once, so the
//       "Load N more" button disappears on every DataTable screen. At any
//       smaller page size the button is back after 100 rows.
//   [C] Table search — the box also understands a lot spec ("3-5") and a
//       phone number typed with punctuation.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'list-ux-'));
const PORT = 47361;
const B = `http://127.0.0.1:${PORT}`;

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
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }

  // The bootstrap `admin` session stays alive over the API for fixtures, and
  // single_session would refuse a second `admin` sign-in from the browser.
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });

  // 140 sellers (> the 100-row DataTable chunk) so the Load-more button has
  // something to appear for. Distinct phone numbers; one has punctuation.
  for (let i = 1; i <= 140; i++) {
    await api('POST', '/api/traders', { name: 'SELLER ' + String(i).padStart(3, '0'), tel: '90000' + String(10000 + i) });
  }
  await api('POST', '/api/traders', { name: 'PUNCT SELLER', tel: '+91 98765 43210' });

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
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

  // ── [A] Raise Original renders beside the name ─────────────────
  console.log('[A] Sales Invoice — ⬆ Raise Original sits next to the buyer name');
  // Drive the invoices column config directly: generating a real proforma
  // needs a priced trade, a buyer master and the proforma flag — none of
  // which this assertion is about. Mounting the same config with a synthetic
  // proforma row exercises the exact render path the screen uses.
  // The invoices column set lives inside loadInvoices(), so drive that — with
  // the one /api/invoices response stubbed to a synthetic proforma row. That
  // exercises the real render path without needing a priced trade, a buyer
  // master and a generated draft, none of which this assertion is about.
  await page.evaluate(() => go('invoices'));
  await new Promise(r => setTimeout(r, 600));
  // Stubbed at window.fetch, not at the app's `j()` helper — `j` is a
  // module-scope const, so it can't be swapped from outside.
  const readInvoiceRow = (row) => page.evaluate(async (r) => {
    const realFetch = window.fetch;
    window.fetch = (url, opts) => /\/api\/invoices\?/.test(String(url))
      ? Promise.resolve(new Response(JSON.stringify({ rows: [r], total: 1, page: 1, pageSize: 50 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : realFetch(url, opts);
    try { await loadInvoices(); } finally { window.fetch = realFetch; }
    const tb = document.getElementById('invoices-list');
    const tds = [...(tb?.querySelector('tr')?.children || [])];
    const head = [...(tb?.closest('table')?.querySelectorAll('thead th') || [])].map(t => t.textContent.trim());
    const nameIdx = head.findIndex(h => h.startsWith('Trade Name'));
    const actIdx  = head.findIndex(h => h.startsWith('Actions'));
    return {
      nameHTML: nameIdx >= 0 ? tds[nameIdx]?.innerHTML || '' : '',
      actHTML:  actIdx  >= 0 ? tds[actIdx]?.innerHTML  || '' : '',
      nameText: nameIdx >= 0 ? tds[nameIdx]?.textContent || '' : '',
    };
  }, row);
  const cells = await readInvoiceRow({ id: 7, is_proforma: 1, raised_invo: '', buyer: 'JP', buyer1: 'JP TRADERS',
                                       sale: 'L', invo: '9', ano: '11', date: '2026-08-12', qty: 1, amount: 1, tot: 1 });
  const RAISE = /raiseOriginal\(/;
  check('the Trade Name cell carries the raiseOriginal button', RAISE.test(cells.nameHTML), cells.nameHTML.slice(0, 300));
  check('the buyer name is still in that cell', /JP TRADERS/.test(cells.nameText), cells.nameText);
  check('the ⋯ actions menu no longer duplicates it', !RAISE.test(cells.actHTML), cells.actHTML.slice(0, 300));
  check('the ⋯ menu still has the other proforma actions',
        /viewInvoicePDF\(/.test(cells.actHTML) && /revertInvoice\(/.test(cells.actHTML), cells.actHTML.slice(0, 300));

  // An already-raised draft shows the disabled ⬆ in the same place.
  const raised = await readInvoiceRow({ id: 8, is_proforma: 1, raised_invo: '123', buyer: 'JP', buyer1: 'JP TRADERS',
                                        sale: 'L', invo: '9', ano: '11', date: '2026-08-12', qty: 1, amount: 1, tot: 1 });
  check('a raised draft shows the disabled ⬆ in the name cell, not a live one',
        /disabled/.test(raised.nameHTML) && !RAISE.test(raised.nameHTML), raised.nameHTML.slice(0, 300));

  // A live ORIGINAL invoice must not grow the button.
  const orig = await readInvoiceRow({ id: 9, is_proforma: 0, buyer: 'JP', buyer1: 'JP TRADERS',
                                      sale: 'L', invo: '10', ano: '11', date: '2026-08-12', qty: 1, amount: 1, tot: 1 });
  check('an original invoice row shows no ⬆ beside the name',
        !/icon-btn/.test(orig.nameHTML) && /JP TRADERS/.test(orig.nameText), orig.nameHTML.slice(0, 200));

  // ── [B] 500 / page renders everything ──────────────────────────
  console.log('\n[B] Pagination — "500 / page" loads every row, no Load-more');
  await page.evaluate(() => go('traders'));
  await page.waitForFunction(() => (document.getElementById('traders-list')?.querySelectorAll('tr').length || 0) > 5, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 800));

  const readTable = () => page.evaluate(() => {
    const wrap = document.getElementById('traders-list')?.closest('.dt-wrap');
    return {
      rows: document.getElementById('traders-list')?.querySelectorAll('tr').length || 0,
      loadMore: !!wrap?.querySelector('.dt-loadmore'),
      loadMoreText: wrap?.querySelector('.dt-loadmore')?.textContent || '',
    };
  });

  await page.evaluate(() => setGlobalPageSize(200));
  await page.waitForFunction(() => (document.getElementById('traders-list')?.querySelectorAll('tr').length || 0) > 5, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 1200));
  const at200 = await readTable();
  check('at 200 / page the table still chunks at 100 rows', at200.rows === 100, JSON.stringify(at200));
  check('…and the Load-more button is shown', at200.loadMore, JSON.stringify(at200));

  await page.evaluate(() => setGlobalPageSize(500));
  await page.waitForFunction(() => (document.getElementById('traders-list')?.querySelectorAll('tr').length || 0) > 100, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 1200));
  const at500 = await readTable();
  check('at 500 / page every fetched row renders (141 sellers)', at500.rows === 141, JSON.stringify(at500));
  check('…and the Load-more button is gone', !at500.loadMore, JSON.stringify(at500));

  // ── [C] Smart search in the table box ──────────────────────────
  console.log('\n[C] Table search — phone number and lot spec');
  const searchRows = (q) => page.evaluate(async (query) => {
    DataTable._search('traders-list', query);
    return document.getElementById('traders-list')?.querySelectorAll('tr').length || 0;
  }, q);
  const punct = await page.evaluate(() => {
    DataTable._search('traders-list', '9876543210');
    return [...document.getElementById('traders-list').querySelectorAll('tr')].map(r => r.textContent);
  });
  check('a plain 10-digit number finds the seller stored as "+91 98765 43210"',
        punct.length === 1 && /PUNCT SELLER/.test(punct[0]), JSON.stringify(punct).slice(0, 200));

  const spaced = await page.evaluate(() => {
    DataTable._search('traders-list', '+91 98765 43210');
    return [...document.getElementById('traders-list').querySelectorAll('tr')].map(r => r.textContent);
  });
  check('…and so does the same number typed with +91 and spaces',
        spaced.length === 1 && /PUNCT SELLER/.test(spaced[0]), JSON.stringify(spaced).slice(0, 200));

  const word = await searchRows('PUNCT');
  check('plain keyword search still works', word === 1, String(word));
  await page.evaluate(() => DataTable._clear('traders-list'));

  // Lot specs need a table with a lot column — mount one directly rather
  // than staging a whole priced trade.
  const lotHits = await page.evaluate((queries) => {
    const host = document.createElement('table');
    host.innerHTML = '<tbody id="__lotprobe"></tbody>';
    document.body.appendChild(host);
    const data = ['005', '010', '011', '012', '020', 'A7'].map(lot_no => ({ lot_no, name: 'RAMU' }));
    const cfg = { columns: [{ key: 'lot_no', label: 'Lot', sort: 'text' }, { key: 'name', label: 'Seller', sort: 'text' }] };
    const out = {};
    for (const q of queries) {
      DataTable.mount('__lotprobe', data, cfg);
      DataTable._search('__lotprobe', q);
      // An empty result renders DataTable's single "No rows" placeholder,
      // which has one colspan cell — drop it so `[]` means "no matches".
      out[q] = [...document.getElementById('__lotprobe').querySelectorAll('tr')]
        .filter(r => r.children.length > 1)
        .map(r => r.children[0]?.textContent.trim()).filter(Boolean);
    }
    return out;
  }, ['10', '5,20', '10-12', '10-11, 5', 'RAMU-X']);
  check('"10" matches the lot stored as "010"',
        JSON.stringify(lotHits['10']) === JSON.stringify(['010']), JSON.stringify(lotHits['10']));
  check('"5,20" matches 005 + 020',
        JSON.stringify(lotHits['5,20']) === JSON.stringify(['005', '020']), JSON.stringify(lotHits['5,20']));
  check('range "10-12" matches 010,011,012',
        JSON.stringify(lotHits['10-12']) === JSON.stringify(['010', '011', '012']), JSON.stringify(lotHits['10-12']));
  check('mixed "10-11, 5" matches 005,010,011',
        JSON.stringify(lotHits['10-11, 5']) === JSON.stringify(['005', '010', '011']), JSON.stringify(lotHits['10-11, 5']));
  check('"RAMU-X" is NOT reinterpreted as a range (no rows)',
        lotHits['RAMU-X'].length === 0, JSON.stringify(lotHits['RAMU-X']));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
