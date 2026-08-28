// Payments — Lot-wise: the results table scrolls in its own box, with the
// column header pinned.
//
// A trade runs to hundreds of lots. Before this the table grew the page
// itself, so working down the list pushed the toolbar — select-all, the export
// button, the running total — off the top of the screen, and the column names
// with it. The table now scrolls inside a fixed-height box and the header band
// sticks to its top.
//
// Layout, so it has to be MEASURED in a real browser with the panel actually
// visible: an element inside a hidden tab reports every dimension as 0.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-scroll-'));
const PORT = 47353;
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
  const tr = await api('POST', '/api/traders', {
    name: 'ANNAMALAI', cr: '', padd: 'ADDR', ppla: 'PLACE',
    banks: [{ acctnum: '10001', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'ANNAMALAI', is_default: 1 }],
  });
  const tid = tr.d && (tr.d.id || (tr.d.trader && tr.d.trader.id));
  if (!tid) { console.error('trader create failed', tr.status, tr.d); cleanup(); process.exit(1); }
  // Enough lots to overflow any sane viewport.
  const LOTS = 40;
  for (let i = 1; i <= LOTS; i++) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no: String(i).padStart(3, '0'), name: 'ANNAMALAI', cr: '',
      qty: 100, grade: '2', bags: 10, crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: tid,
    });
    const lid = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    if (!lid) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    await api('PUT', `/api/lots/${lid}`, { price: 3000, amount: 300000 });
  }
  await api('POST', `/api/lots/calculate/${aid}`, {});

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
    console.log('  skip no Chrome available — layout checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    cleanup(); process.exit(0);
  }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => { localStorage.setItem('t', t); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });

  // go() is the app's tab switcher. It matters here in a way it doesn't for the
  // other paylw tests: those read DOM/JS state, which works while the panel is
  // hidden, but a hidden element measures 0 in every dimension.
  await page.evaluate(a => {
    if (typeof go === 'function') go('payments');
    const s = document.getElementById('paylw-auction');
    if (s) s.value = String(a);
  }, aid);
  await page.evaluate(() => loadPayLotwise && loadPayLotwise());
  await page.evaluate(a => {
    const s = document.getElementById('paylw-auction');
    if (s) { s.value = String(a); payLwOnAuctionChange(); }
  }, aid);
  await page.evaluate(() => payLwSearch());
  await page.waitForFunction(() => document.querySelector('#paylw-body table'), { timeout: 8000 });

  console.log('\n[1] The panel is actually on screen (else every measurement is 0)');
  const visible = await page.evaluate(() => !!document.querySelector('.paylw-scroll')?.offsetParent);
  check('the results box is laid out', visible);

  console.log('\n[2] The table scrolls inside its own box');
  const m = await page.evaluate(() => {
    const sc = document.querySelector('.paylw-scroll');
    return {
      rows: document.querySelectorAll('#paylw-body tbody tr').length,
      clientH: sc.clientHeight, scrollH: sc.scrollHeight,
      overflowY: getComputedStyle(sc).overflowY,
      pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  check(`all ${LOTS} rows are rendered`, m.rows === LOTS, String(m.rows));
  check('the box is height-capped', m.clientH > 0 && m.clientH < m.scrollH,
        `client=${m.clientH} scroll=${m.scrollH}`);
  check('and scrolls', m.overflowY === 'auto', m.overflowY);
  check('the box is shorter than the viewport', m.clientH < 900, String(m.clientH));

  console.log('\n[3] The header stays pinned while the rows move');
  const stuck = await page.evaluate(() => {
    const sc = document.querySelector('.paylw-scroll');
    sc.scrollTop = sc.scrollHeight;      // all the way down
    const th = document.querySelector('.paylw-table thead th');
    const a = th.getBoundingClientRect(), b = sc.getBoundingClientRect();
    return {
      scrolled: Math.round(sc.scrollTop), pos: getComputedStyle(th).position,
      delta: Math.round(a.top - b.top),
      opaque: getComputedStyle(th).backgroundColor,
    };
  });
  check('it really scrolled', stuck.scrolled > 100, String(stuck.scrolled));
  check('the header is sticky', stuck.pos === 'sticky', stuck.pos);
  check('and sits at the top of the box, not scrolled away',
        Math.abs(stuck.delta) < 3, `delta=${stuck.delta}`);
  // Chrome reports a wide-gamut token here (`color(srgb …)`), not `rgb(…)` —
  // what matters is only that it is not see-through.
  check('the header is opaque, so rows pass behind it',
        !/transparent/.test(stuck.opaque) && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(stuck.opaque),
        stuck.opaque);

  console.log('\n[4] The toolbar stays reachable while scrolled to the bottom');
  const tools = await page.evaluate(() => {
    const r = id => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    return { exportTop: r('paylw-export-btn'), clearTop: r('paylw-clearsel-btn'), vh: window.innerHeight };
  });
  check('the Export button is still on screen',
        tools.exportTop !== null && tools.exportTop > 0 && tools.exportTop < tools.vh,
        JSON.stringify(tools));
  check('so is Clear selection',
        tools.clearTop !== null && tools.clearTop > 0 && tools.clearTop < tools.vh,
        JSON.stringify(tools));

  console.log('\n[5] A short result set gets no needless scrollbar');
  await page.evaluate(() => {
    const el = document.getElementById('paylw-lots');
    if (el) el.value = '001-003';
  });
  await page.evaluate(() => payLwSearch());
  await page.waitForFunction(() => document.querySelectorAll('#paylw-body tbody tr').length === 3, { timeout: 8000 });
  const small = await page.evaluate(() => {
    const sc = document.querySelector('.paylw-scroll');
    return { clientH: sc.clientHeight, scrollH: sc.scrollHeight };
  });
  check('the box shrinks to the content', small.scrollH <= small.clientH + 2,
        `client=${small.clientH} scroll=${small.scrollH}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); });
