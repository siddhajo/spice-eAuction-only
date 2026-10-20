// Two UI changes, in a headless Chrome.
//
//  1. QUICK ACTIONS on the Dashboard is now a setting. The card duplicates
//     screens the sidebar already lists, and the bar above it carried a
//     SECOND auction picker next to the one in the topbar — so the switch
//     takes both, and with the card gone the top row must not leave a
//     320px hole where it used to sit.
//     Default ON, like the other two dashboard widget flags: no install
//     loses the card on upgrade.
//
//  2. SEPARATE PDFs sits beside every Print Selected. Same ticked rows, same
//     layout question; the difference is a .zip of one PDF per party instead
//     of one merged document.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sep-'));
const PORT = 47395;
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
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', flag_debit_note: 'true', flag_debit_note_planter: 'true', flag_bos_purchase_bill: 'true' } });
  await api('POST', '/api/auctions', { ano: '20', date: '2026-10-17', crop_type: 'ISP' });

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
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => go('dash'));
  await page.waitForFunction(() => !!document.querySelector('#tc-dash .greeting'), { timeout: 15000 });

  console.log('[1] Default ON — nothing lost on upgrade');
  const on = await page.evaluate(() => ({
    attr: document.body.getAttribute('data-feat-dash-quick-actions'),
    card: !!document.querySelector('#tc-dash .qa-grid'),
    pickers: document.querySelectorAll('#tc-dash select').length,
  }));
  check('the flag reads as on', on.attr === '1', JSON.stringify(on));
  check('the Quick Actions card is there', on.card === true, JSON.stringify(on));
  check('…and so is the dashboard auction picker', on.pickers >= 1, JSON.stringify(on));

  console.log('\n[2] Switched off — the card AND the second picker go');
  await api('PUT', '/api/company-settings', { settings: { flag_dash_quick_actions: 'false' } });
  const off = await page.evaluate(async () => {
    await applyFeatureFlags();
    await loadStats();
    await new Promise(r => setTimeout(r, 400));
    const row = document.querySelector('#tc-dash .dash-snap-row');
    return {
      attr: document.body.getAttribute('data-feat-dash-quick-actions'),
      card: !!document.querySelector('#tc-dash .qa-grid'),
      pickers: document.querySelectorAll('#tc-dash select').length,
      rowDisplay: row ? getComputedStyle(row).display : '(absent)',
      greeting: !!document.querySelector('#tc-dash .greeting'),
    };
  });
  check('the flag reads as off', off.attr === '0', JSON.stringify(off));
  check('the Quick Actions card is gone', off.card === false, JSON.stringify(off));
  check('the second auction picker goes with it', off.pickers === 0, JSON.stringify(off));
  check('and the empty top row collapses rather than leaving a hole',
        off.rowDisplay === 'none', off.rowDisplay);
  check('the rest of the dashboard still renders', off.greeting === true, JSON.stringify(off));

  console.log('\n[3] With the snapshot open, it takes the freed width');
  const snap = await page.evaluate(async () => {
    localStorage.setItem('dashSnapVisible', '1');
    await loadStats();
    await new Promise(r => setTimeout(r, 400));
    const row = document.querySelector('#tc-dash .dash-snap-row');
    return {
      cls: row ? row.className : '',
      cols: row ? getComputedStyle(row).gridTemplateColumns : '',
      card: !!document.querySelector('#tc-dash .qa-grid'),
    };
  });
  check('the row is marked as having no Quick Actions', /qa-hidden/.test(snap.cls), snap.cls);
  check('…and becomes a single column, not 1fr + 320px',
        snap.cols.split(' ').length === 1, snap.cols);
  check('the card is still absent', snap.card === false, JSON.stringify(snap));
  await page.evaluate(() => { localStorage.removeItem('dashSnapVisible'); });

  console.log('\n[4] Separate PDFs sits beside every Print Selected');
  const btns = await page.evaluate(() => {
    const find = (fn) => {
      const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('onclick') || '').includes(fn));
      return !!b;
    };
    return {
      inv: find('saveSeparateInvoices'), pur: find('saveSeparatePurchases'),
      bill: find('saveSeparateBills'),   dn: find('saveSeparateDebitNotes()'),
      dnp: find('saveSeparateDebitNotesPlanter'),
      fns: ['saveSeparateInvoices','saveSeparatePurchases','saveSeparateBills',
            'saveSeparateDebitNotes','saveSeparateDebitNotesPlanter',
            'downloadSeparatePdfs'].filter(n => typeof window[n] === 'function' || eval(`typeof ${n}`) === 'function'),
    };
  });
  check('Sales Invoices has one', btns.inv === true);
  check('Purchases has one', btns.pur === true);
  check('Bills of Supply has one', btns.bill === true);
  check('Debit Notes has one', btns.dn === true);
  check('Debit Notes — Planter has one', btns.dnp === true);
  check('and every handler exists', btns.fns.length === 6, JSON.stringify(btns.fns));

  console.log('\n[5] URD Purchase follows the document that screen issues');
  // flag_bos_purchase_bill shows exactly one print button there — Bill of
  // Supply or Commission Bill — and Separate PDFs must ask the server for the
  // same one. Driven through the real predicate rather than a copy of it.
  const bosRouting = await page.evaluate(async () => {
    const seen = [];
    const realDl = window.downloadSeparatePdfs;
    // Stub the download so nothing renders — the question is which KIND it asks for.
    downloadSeparatePdfs = (kind) => { seen.push(kind); };
    const realPick = window.pickTemplate, realPickC = window.pickCommissionTemplate,
          realPickN = window.pickCommissionInvoiceNo;
    pickTemplate = async () => '';
    pickCommissionTemplate = async () => '';
    pickCommissionInvoiceNo = async () => 'original';
    const host = document.getElementById('bills-list');
    host.innerHTML = '<tr><td><input type="checkbox" class="bill-select-cb" value="1" checked></td></tr>';
    document.body.setAttribute('data-feat-bos-purchase-bill', '1');   // Bill of Supply mode
    await saveSeparateBills();
    document.body.setAttribute('data-feat-bos-purchase-bill', '0');   // Commission Bill mode
    await saveSeparateBills();
    host.innerHTML = '';
    downloadSeparatePdfs = realDl; pickTemplate = realPick;
    pickCommissionTemplate = realPickC; pickCommissionInvoiceNo = realPickN;
    return seen;
  });
  check('with the Bill of Supply button showing, it asks for bills',
        bosRouting[0] === 'bills', JSON.stringify(bosRouting));
  check('with the Commission Bill button showing, it asks for the commission format',
        bosRouting[1] === 'bills_commission', JSON.stringify(bosRouting));

  console.log('\n[6] The Debit Notes button appears and disappears with its sibling');
  const dnToggle = await page.evaluate(() => {
    const printBtn = document.getElementById('dn-bulk-print');
    const sepBtn   = document.getElementById('dn-bulk-sep');
    if (!printBtn || !sepBtn) return { missing: true };
    const before = { print: printBtn.style.display, sep: sepBtn.style.display };
    // The real path: the list's own sync decides, from the ticked count.
    const host = document.getElementById('debit-list');
    host.innerHTML = '<tr><td><input type="checkbox" class="dn-select-cb" value="1" checked></td></tr>';
    updateDnBulkButtons();
    const after = { print: printBtn.style.display, sep: sepBtn.style.display };
    host.innerHTML = '';
    updateDnBulkButtons();
    const cleared = { print: printBtn.style.display, sep: sepBtn.style.display };
    return { before, after, cleared };
  });
  check('both are hidden with nothing ticked',
        !dnToggle.missing && dnToggle.before.sep === 'none' && dnToggle.before.print === 'none',
        JSON.stringify(dnToggle));
  check('both appear once a row is ticked',
        dnToggle.after.sep !== 'none' && dnToggle.after.print !== 'none', JSON.stringify(dnToggle.after));
  check('and both go again when the selection is cleared',
        dnToggle.cleared.sep === 'none' && dnToggle.cleared.print === 'none', JSON.stringify(dnToggle.cleared));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
