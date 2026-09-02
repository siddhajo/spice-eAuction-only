// SALES INVOICE — the Sale Type pickers on the two Generate modals.
//
// The blank "All sale types" sentinel was removed from both selects on
// 2026-09-02. Removing an <option> is a one-line edit with a trap behind it:
// openGenAllModal() used to reset #ga-sale to '', and assigning a value that
// matches no option leaves a <select> at selectedIndex -1 — it renders EMPTY
// while still submitting a blank saleType, which the backend reads as "every
// buyer, on each one's own default". The field would lie about what the run
// is about to do.
//
//   [gone]    neither picker offers a blank-valued option any more.
//   [default] each opens on a REAL selection (selectedIndex >= 0, non-blank),
//             which is the assertion that actually catches the -1 trap.
//   [filter]  the Generate Invoice picker still filters the buyer list by the
//             selected type — the reason the field exists.
//   [submit]  Generate for All sends a concrete saleType, never ''.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gisale-'));
const PORT = 47371;
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
  if (!TOKEN) { console.log('login failed ' + boot.status + '\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });

  // Two buyers on DIFFERENT sale types, so the [filter] assertion can tell a
  // working filter from a picker that simply lists everyone. The interstate
  // buyer carries a non-33 GSTIN so deriveSaleType() reads it as 'I'.
  const AID = (await api('POST', '/api/auctions', { ano: '13', date: '2026-08-08', crop_type: 'VST' })).d.id;
  await api('POST', '/api/buyers', { buyer: 'LOCAL TRADER', buyer1: 'LOCAL TRADER', code: 'B1',
                                     pla: 'BODINAYAKANUR', state: 'TAMIL NADU', st_code: '33',
                                     gstin: '33AAHCE4551A1Z8', sale: 'L' });
  await api('POST', '/api/buyers', { buyer: 'INTER TRADER', buyer1: 'INTER TRADER', code: 'B2',
                                     pla: 'KOCHI', state: 'KERALA', st_code: '32',
                                     gstin: '32AAHCE4551A1Z8', sale: 'I' });
  let n = 0;
  for (const code of ['B1', 'B2']) {
    n++;
    const r = await api('POST', '/api/lots', { auction_id: AID, lot_no: String(n), name: 'PLANTER ' + n,
                                               cr: 'CR.', bags: 1, qty: 100, grade: '1', crop: 'CARDAMOM' });
    await api('PUT', `/api/lots/${r.d.lot.id}`, {
      price: 3000, amount: 300000, code,
      buyer: code === 'B1' ? 'LOCAL TRADER' : 'INTER TRADER',
      buyer1: code === 'B1' ? 'LOCAL TRADER' : 'INTER TRADER',
      sale: code === 'B1' ? 'L' : 'I' });
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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  // A native alert()/confirm() suspends the page, and every page.evaluate()
  // after it hangs until the protocol timeout — which reads as a mysterious
  // ProtocolError rather than as the dialog it is. Dismiss them and record
  // what was said, so an unexpected one is visible instead of fatal.
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); try { await d.dismiss(); } catch (_) {} });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block'
                                   && !!window._currentTab, { timeout: 20000 });

  const optsOf = (id) => page.evaluate((i) => {
    const s = document.getElementById(i);
    if (!s) return null;
    return {
      values: [...s.options].map(o => o.value),
      labels: [...s.options].map(o => o.textContent.trim()),
      value: s.value,
      selectedIndex: s.selectedIndex,
    };
  }, id);

  console.log('\n[gone] neither picker offers a blank "all" option');
  for (const id of ['gi-sale', 'ga-sale']) {
    const o = await optsOf(id);
    check(`#${id} exists`, !!o);
    if (!o) continue;
    check(`#${id} has no blank-valued option`, !o.values.includes(''), JSON.stringify(o.values));
    check(`#${id} lists no "All sale types" label`,
          !o.labels.some(l => /all sale types/i.test(l)), JSON.stringify(o.labels));
    check(`#${id} still offers the concrete types`,
          ['L', 'I', 'E', 'W', 'N'].every(v => o.values.includes(v)), JSON.stringify(o.values));
  }

  console.log('\n[default] each modal opens on a real, concrete selection');
  // Generate Invoice.
  await page.evaluate((aid) => {
    go('invoices');
    const sel = document.getElementById('inv-auction');
    if (sel) { sel.value = String(aid); sel.dispatchEvent(new Event('change')); }
  }, AID);
  await page.evaluate(() => openGenInvModal());
  await new Promise(r => setTimeout(r, 1200));
  const gi = await optsOf('gi-sale');
  check('#gi-sale has a real selection (not selectedIndex -1)', gi.selectedIndex >= 0, JSON.stringify(gi));
  check('#gi-sale opens on a non-blank value', !!gi.value, JSON.stringify(gi));

  console.log('\n[filter] the Generate Invoice picker filters the buyer list');
  const buyersFor = async (v) => {
    await page.evaluate((val) => {
      const s = document.getElementById('gi-sale');
      s.value = val;
      s.dispatchEvent(new Event('change'));
    }, v);
    await new Promise(r => setTimeout(r, 1200));
    return page.evaluate(() =>
      [...document.querySelectorAll('#gi-buyer-list .gi-cb')].map(cb => (cb.dataset.sale || '').trim()));
  };
  const local = await buyersFor('L');
  const inter = await buyersFor('I');
  check('L shows only local buyers', local.length > 0 && local.every(s => s === 'L'),
        `L → ${JSON.stringify(local)}`);
  check('I shows only interstate buyers', inter.length > 0 && inter.every(s => s === 'I'),
        `I → ${JSON.stringify(inter)}`);
  check('the two types select different buyers', local.length !== inter.length || local[0] !== inter[0],
        `L=${JSON.stringify(local)} I=${JSON.stringify(inter)}`);

  console.log('\n[default] Generate for All opens on a real selection too');
  await page.evaluate(() => { hideModal('gen-inv-modal'); openGenAllModal('invoices'); });
  await new Promise(r => setTimeout(r, 1200));
  const ga = await optsOf('ga-sale');
  // This is the assertion the removal could have broken: openGenAllModal used
  // to write '' here, which no option carries any more.
  check('#ga-sale has a real selection (not selectedIndex -1)', ga.selectedIndex >= 0, JSON.stringify(ga));
  check('#ga-sale opens on a non-blank value', !!ga.value, JSON.stringify(ga));

  console.log('\n[submit] the batch run sends a concrete saleType');
  const sent = await page.evaluate(() => {
    // Intercept the generate-all POST and report its body instead of running it.
    const orig = window.fetch;
    let body = null;
    window.fetch = function (u, o) {
      if (String(u).includes('/api/invoices/generate-all/')) {
        try { body = JSON.parse(o.body); } catch (_) { body = { _unparsed: String(o.body) }; }
        window.fetch = orig;
        return Promise.resolve(new Response(JSON.stringify({ generated: 0, invoices: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return orig.apply(this, arguments);
    };
    document.getElementById('ga-start').value = '1';
    try { doGenerateAll(); } catch (_) {}
    return new Promise(res => setTimeout(() => { window.fetch = orig; res(body); }, 1500));
  });
  check('generate-all posted a body', !!sent, JSON.stringify(sent));
  if (sent) {
    check('saleType is present and non-blank', !!sent.saleType, JSON.stringify(sent));
    check('saleType is one of the concrete types', ['L', 'I', 'E', 'W', 'N'].includes(sent.saleType),
          JSON.stringify(sent.saleType));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + e.stack); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
