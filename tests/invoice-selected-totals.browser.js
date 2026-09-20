// Sales Invoices — a SELECTED subtotal row in the table footer.
//
// Ticking invoice rows adds a second, green footer row above the amber
// grand-total row that sums only the ticked ones, so the user can total an
// arbitrary set (one buyer, one lorry, the batch about to be printed)
// without filtering the list down to it first.
//
// Verified in a real headless Chrome because the whole feature is layout +
// live DOM: two sticky footer rows that must not pin on top of each other,
// and a subtotal that has to track every tick.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-seltot-'));
const PORT = 47372;
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

// Three invoices with numbers that can't be confused for one another when
// they turn up in a sum: 1000 / 200 / 30.
const ROWS = [
  { id: 1, buyer: 'AA', buyer1: 'ALPHA TRADERS', sale: 'L', invo: '101', ano: '11', date: '2026-08-12', bag: 1, qty: 10, amount: 900,  cgst: 25, sgst: 25, igst: 0, tot: 1000 },
  { id: 2, buyer: 'BB', buyer1: 'BETA SPICES',   sale: 'I', invo: '102', ano: '11', date: '2026-08-12', bag: 2, qty: 20, amount: 180,  cgst: 0,  sgst: 0,  igst: 10, tot: 200 },
  { id: 3, buyer: 'CC', buyer1: 'GAMMA EXPORTS', sale: 'E', invo: '103', ano: '11', date: '2026-08-12', bag: 3, qty: 30, amount: 28,   cgst: 1,  sgst: 1,  igst: 0,  tot: 30 },
];

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  // single_session would refuse a second `admin` sign-in from the browser.
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });

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
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
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

  // Load the Sales Invoices screen with the three rows above, stubbing the
  // one /api/invoices response. `j()` is a module-scope const so it can't be
  // swapped from outside — window.fetch is the seam.
  // Navigate AFTER the post-login boot settles — it restores the last tab on
  // its own and would otherwise route us straight back off this screen. The
  // geometry assertions below are only meaningful on a visible panel, so this
  // waits for the panel to actually be active rather than just calling go().
  await new Promise(r => setTimeout(r, 1500));
  await page.evaluate(() => { document.querySelectorAll('.toast,.banner-dismiss,#dismiss-banner').forEach(e => e.remove()); });
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => go('invoices'));
    await new Promise(r => setTimeout(r, 300));
    const on = await page.evaluate(() => !!document.getElementById('tc-invoices')?.classList.contains('active'));
    if (on) break;
  }
  check('the Sales Invoices screen is actually on screen',
        await page.evaluate(() => !!document.getElementById('tc-invoices')?.classList.contains('active')));
  await page.evaluate(async (rows) => {
    const realFetch = window.fetch;
    window.fetch = (url, opts) => /\/api\/invoices\?/.test(String(url))
      ? Promise.resolve(new Response(JSON.stringify({ rows, total: rows.length, page: 1, pageSize: 50 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : realFetch(url, opts);
    try { await loadInvoices(); } finally { window.fetch = realFetch; }
  }, ROWS);

  // Read both footer rows by column HEADER, so the assertions survive a
  // column being added, moved or hidden by a flag.
  const readFoot = () => page.evaluate(() => {
    const table = document.getElementById('invoices-list')?.closest('table');
    if (!table) return null;
    const head = [...table.querySelectorAll('thead th')].map(t => t.textContent.trim());
    const num = (s) => { const v = String(s || '').replace(/[^0-9.-]/g, ''); return v === '' ? null : Number(v); };
    const cellsOf = (tr) => {
      if (!tr) return null;
      const tds = [...tr.children];
      const byHead = {};
      head.forEach((h, i) => { byHead[h] = (tds[i]?.textContent || '').trim(); });
      return byHead;
    };
    const selRow = table.querySelector('tfoot .dt-foot-sel');
    const allRow = table.querySelector('tfoot .dt-foot-all');
    return {
      selHidden: !selRow || selRow.hidden,
      sel: cellsOf(selRow),
      all: cellsOf(allRow),
      selTotal: num(cellsOf(selRow)?.['Total']),
      allTotal: num(cellsOf(allRow)?.['Total']),
      selQty:   num(cellsOf(selRow)?.['Qty']),
      selAmount:num(cellsOf(selRow)?.['Amount']),
      selSaleCount: (cellsOf(selRow)?.['Sale'] || '').trim(),
      selHTML: selRow ? selRow.innerHTML : '',
      // Both footer rows are sticky; the selected row has to be lifted clear
      // of the grand-total row or they pin on top of one another.
      selBottom: selRow && !selRow.hidden ? (selRow.cells[0]?.style.bottom || '') : '',
      allHeight: allRow ? allRow.offsetHeight : 0,
      // Sanity: does the selected row overlap the grand-total row on screen?
      overlaps: (() => {
        if (!selRow || selRow.hidden || !allRow) return false;
        const a = selRow.getBoundingClientRect(), b = allRow.getBoundingClientRect();
        return a.bottom > b.top + 1;
      })(),
    };
  });

  const tick = (ids) => page.evaluate((ids) => {
    document.querySelectorAll('#invoices-list .inv-select-cb').forEach(cb => {
      const want = ids.includes(Number(cb.value));
      if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }, ids);

  console.log('[1] Nothing ticked — the subtotal row stays out of the way');
  let f = await readFoot();
  check('the table rendered with a grand-total row', !!f && f.allTotal === 1230, JSON.stringify(f && f.all));
  check('the selected-rows row is hidden', !!f && f.selHidden, JSON.stringify(f && f.sel));

  console.log('[2] Tick two rows — the subtotal counts only those');
  await tick([1, 2]);
  f = await readFoot();
  check('the selected row is now visible', !f.selHidden);
  check('Total sums the ticked rows only (1000 + 200)', f.selTotal === 1200, 'got ' + f.selTotal);
  check('Qty sums the ticked rows only (10 + 20)',      f.selQty === 30,     'got ' + f.selQty);
  check('Amount sums the ticked rows only (900 + 180)', f.selAmount === 1080, 'got ' + f.selAmount);
  check('the count column shows 2',                     f.selSaleCount === '2', 'got ' + JSON.stringify(f.selSaleCount));
  check('the row is labelled so it cannot be read as the grand total',
        /dt-sel-tag/.test(f.selHTML) && /SELECTED/.test(f.selHTML), f.selHTML.slice(0, 200));
  check('the grand total still totals ALL rows (1230)', f.allTotal === 1230, 'got ' + f.allTotal);

  console.log('[3] The two sticky footer rows do not pin on top of each other');
  // Guard the two geometry assertions: on a hidden panel every height is 0
  // and both would pass without proving anything.
  check('the footer rows have real height (the table is laid out)', f.allHeight > 0, 'allHeight=' + f.allHeight);
  check('the selected row is lifted by the grand-total row height',
        f.allHeight > 0 && f.selBottom === f.allHeight + 'px', `bottom=${f.selBottom} allHeight=${f.allHeight}`);
  check('and they do not overlap on screen', !f.overlaps);

  console.log('[4] Changing the selection re-totals it');
  await tick([3]);
  f = await readFoot();
  check('ticking a different row alone gives that row (30)', f.selTotal === 30, 'got ' + f.selTotal);
  check('the count follows too', f.selSaleCount === '1', 'got ' + JSON.stringify(f.selSaleCount));

  console.log('[5] Select-all and clear-all');
  await page.evaluate(() => { const m = document.getElementById('inv-select-all'); m.checked = true; toggleAllInvoices(true); });
  f = await readFoot();
  check('select-all makes the subtotal equal the grand total', f.selTotal === f.allTotal && f.selTotal === 1230,
        `sel=${f.selTotal} all=${f.allTotal}`);
  await page.evaluate(() => { const m = document.getElementById('inv-select-all'); m.checked = false; toggleAllInvoices(false); });
  f = await readFoot();
  check('clearing every tick hides the row again', f.selHidden);

  console.log('[6] Other DataTable screens are untouched');
  await page.evaluate(() => go('traders'));
  // Wait for the screen's own DataTable render rather than a fixed delay —
  // the footer only exists once it has mounted.
  await page.waitForFunction(
    () => !!document.getElementById('traders-list')?.closest('table')?.querySelector('tfoot tr'),
    { timeout: 15000 },
  ).catch(() => {});
  const sellersFoot = await page.evaluate(() => {
    const t = document.getElementById('traders-list')?.closest('table');
    return { mounted: !!t, sel: t ? !!t.querySelector('tfoot .dt-foot-sel') : null, all: t ? !!t.querySelector('tfoot .dt-foot-all') : null };
  });
  check('a table that did not opt in has no selected-rows row',
        !sellersFoot.mounted || sellersFoot.sel === false, JSON.stringify(sellersFoot));
  check('…but still has its grand-total row',
        !sellersFoot.mounted || sellersFoot.all === true, JSON.stringify(sellersFoot));

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
