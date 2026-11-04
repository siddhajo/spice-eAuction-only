// The Delivery Challan Register, reached the way an operator reaches it.
//
// This exists because the first cut shipped the data layer, the export route
// and a document-catalog entry — and the register still was not THERE. The
// Registers screen is a hardcoded <select id="reg-type">, not a view of the
// catalog, so a catalog entry alone surfaces the export in the Downloads
// tiles and nowhere else. A test that only asserted the endpoint would have
// passed the whole time.
//
//   [option]  the register is offered on the Registers screen
//   [filters] picking it shows the right controls (dates, no auction/party)
//   [preview] the on-screen table lists the challans
//   [gate]    with flag_delivery_chalan off the option disappears
//   [pdf]     the PDF button says why there is no PDF instead of erroring
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-reg-ui-'));
const PORT = 47486;
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
function cleanup() {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', {
    settings: { flag_delivery_chalan: 'true', chalan_next_no: '195', chalan_prefix: 'RNS-', br1: 'ANAVILASAM' },
  });
  const auc = await api('POST', '/api/auctions', { ano: '91', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  // Two challans in the book, so the preview has something to show.
  for (const [no, date, veh, who] of [
    ['RNS-195', '2026-10-20', 'TN66H1234', 'KOCHI WAREHOUSE'],
    ['RNS-196', '2026-10-21', 'TN66H5678', 'MADURAI DEPOT'],
  ]) {
    await api('POST', '/api/delivery-chalan/record', {
      chalanNo: no, serial: Number(no.replace(/\D/g, '')), auctionId: aid,
      date, time: '10:30', branch: 'ANAVILASAM', veh, mode: 'By Lorry', receiver: who,
      lots: [{ lot_no: '3' }, { lot_no: '12' }], bags: 20, qty: 200, value: 400000,
    });
  }

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
  if (!chrome) {
    console.log('  skip no Chrome available — UI checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    cleanup(); process.exit(0);
  }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  const toasts = [];
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  // Capture toasts so the PDF refusal can be read back.
  await page.evaluate(() => {
    window.__toasts = [];
    const orig = window.toast;
    window.toast = (m) => { window.__toasts.push(String(m)); try { orig(m); } catch (_) {} };
  });
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('registers'); });

  const opts = () => page.evaluate(() => {
    const s = document.getElementById('reg-type');
    if (!s) return null;
    return Array.from(s.options).map(o => ({
      value: o.value, label: o.textContent.trim(),
      visible: getComputedStyle(o).display !== 'none',
    }));
  });

  console.log('[option] the register is offered on the Registers screen');
  {
    const list = await opts();
    check('the Register Type select exists', !!list, String(list));
    const dc = list && list.find(o => o.value === 'delivery_chalan');
    check('Delivery Challan Register is one of its options', !!dc,
      list && list.map(o => o.value).join(', '));
    check('…labelled for an operator', dc && /Delivery Challan Register/i.test(dc.label),
      dc && dc.label);
    check('…and visible with the feature on', dc && dc.visible, dc && String(dc.visible));
  }

  console.log('[filters] picking it shows the right controls');
  {
    await page.evaluate(() => {
      document.getElementById('reg-type').value = 'delivery_chalan';
      onRegTypeChange();
    });
    const vis = await page.evaluate(() => {
      const d = (id) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display !== 'none' : null;
      };
      return { auction: d('reg-auction-wrap'), party: d('reg-party-wrap'),
               sale: d('reg-sale-wrap'), branch: d('reg-branch-wrap'),
               auctionVal: (document.getElementById('reg-auction') || {}).value };
    });
    check('no auction picker — the book runs across trades', vis.auction === false, String(vis.auction));
    check('a trade left selected by another register is cleared',
      !vis.auctionVal, String(vis.auctionVal));
    check('no party picker', vis.party === false, String(vis.party));
    check('no sale-type filter', vis.sale === false, String(vis.sale));
    check('no depot filter', vis.branch === false, String(vis.branch));
  }

  console.log('[preview] the table lists the challans');
  {
    await page.evaluate(() => loadRegister());
    // #reg-body IS the <tbody> and #reg-head the <thead> — they are siblings
    // inside #reg-table, not nested tables.
    await page.waitForFunction(
      () => document.querySelectorAll('#reg-body tr').length > 0,
      { timeout: 8000 });
    const seen = await page.evaluate(() => {
      // DataTable rebuilds the whole table and writes its own
      // <thead class="dt-head"> — the static #reg-head placeholder is only
      // what sits there before the first mount.
      const heads = Array.from(document.querySelectorAll('#reg-table thead th'))
        .map(th => th.textContent.trim());
      const rows = Array.from(document.querySelectorAll('#reg-body tr'))
        .map(tr => Array.from(tr.children).map(td => td.textContent.trim()));
      return { heads, rows };
    });
    check('the challan columns are shown, not a money register\'s',
      ['Challan No', 'Vehicle', 'Receiver', 'Lots', 'Bags'].every(h => seen.heads.includes(h)),
      seen.heads.join(' | '));
    const flat = JSON.stringify(seen.rows);
    check('both challans are listed', /RNS-195/.test(flat) && /RNS-196/.test(flat), flat.slice(0, 300));
    check('…with the lorry and the receiver',
      /TN66H1234/.test(flat) && /KOCHI WAREHOUSE/.test(flat), flat.slice(0, 300));
    check('…and the lots as printed', /3,12/.test(flat), flat.slice(0, 300));
  }

  console.log('[pdf] the PDF button explains itself instead of failing');
  {
    await page.evaluate(() => { window.__toasts = []; });
    await page.evaluate(() => exportRegister('pdf'));
    const msgs = await page.evaluate(() => window.__toasts.slice());
    check('asking for PDF says it is XLSX only',
      msgs.some(m => /XLSX only/i.test(m)), JSON.stringify(msgs));
  }

  console.log('[gate] the feature flag hides the option');
  {
    await api('PUT', '/api/company-settings', { settings: { flag_delivery_chalan: 'false' } });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => { if (typeof showTab === 'function') showTab('registers'); });
    const list = await opts();
    const dc = list && list.find(o => o.value === 'delivery_chalan');
    check('the option is still in the markup but hidden', !!dc && dc.visible === false,
      dc ? String(dc.visible) : 'option missing');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
