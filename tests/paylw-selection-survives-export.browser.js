// Ticking ONE row and exporting must not re-arm the whole trade.
//
// The bug: payLwExportBank marks the exported lots paid and then re-pulls the
// list, and payLwSearch() ticks everything in a fresh result set. So while the
// browser's Save dialog was still open, the refresh ran behind it and the
// button came back reading "Export Bank Payment (53)" with every row ticked.
// The next press would have paid the whole trade.
//
// The rule being pinned: a post-action refresh may only SHRINK the selection.
// Ids that are gone, or that the action has just made unselectable, fall out;
// nothing is ever added. A fresh SEARCH still starts fully ticked — that is
// the behaviour the screen is built around and it must not change.
//
//   [fresh]   a search still ticks everything
//   [narrow]  the operator can untick down to one
//   [export]  exporting that one leaves the rest UNTICKED
//   [advance] the same holds for Pay Advance's refresh
//   [undo]    …and for Undo advance
//   [filter]  changing a filter is a SEARCH, so it re-ticks as before
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-sel-'));
const PORT = 47494;
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

  await api('PUT', '/api/company-settings', { settings: { flag_lotwise_payments: 'true', br1: 'ANAVILASAM' } });
  const auc = await api('POST', '/api/auctions', { ano: '95', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  // Five lots across two sellers, every one payable into a real account, so
  // the export has no "no bank account" confirm to stop on.
  const mk = async (name, an) => {
    const t = await api('POST', '/api/traders', {
      name, cr: '', padd: 'ADDR', ppla: 'PLACE',
      banks: [{ acctnum: an, ifsc: 'HDFC0001234', bank_name: 'HDFC',
                holder_name: name, account_type: 'Savings', is_default: 1 }],
    });
    return t.d && (t.d.id || (t.d.trader && t.d.trader.id));
  };
  const t1 = await mk('ANNAMALAI', '1000011111');
  const t2 = await mk('BOSE SPICES', '1000022222');
  for (const [lot_no, who, tid] of [
    ['1', 'ANNAMALAI', t1], ['2', 'ANNAMALAI', t1], ['3', 'ANNAMALAI', t1],
    ['4', 'BOSE SPICES', t2], ['5', 'BOSE SPICES', t2],
  ]) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: who, cr: '', qty: 100, bags: 10,
      grade: '1', crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: tid,
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    await api('PUT', `/api/lots/${id}`, { price: 2000, amount: 200000, balance: 196000 });
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
  page.on('dialog', d => d.accept().catch(() => {}));
  // The export ends in a download; let it land somewhere harmless.
  try {
    await page._client().send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP });
  } catch (_) {
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP });
    } catch (_) {}
  }
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

  const search = async () => {
    await page.evaluate(() => { const s = document.getElementById('paylw-link'); if (s) s.value = 'all'; });
    await page.evaluate(() => payLwSearch());
    await page.waitForFunction(() => {
      const b = document.getElementById('paylw-body');
      return b && (b.querySelector('table') || /No lots matched/.test(b.textContent));
    }, { timeout: 8000 });
  };
  const selCount = () => page.evaluate(() => _payLwState.selected.size);
  const lotCount = () => page.evaluate(() => _payLwState.lots.length);
  const exportLabel = () => page.evaluate(() => {
    const b = document.getElementById('paylw-export-btn');
    return b ? b.textContent.trim() : '';
  });

  console.log('[fresh] a search still starts fully ticked');
  await search();
  check('all five lots listed', (await lotCount()) === 5, String(await lotCount()));
  check('all five ticked', (await selCount()) === 5, String(await selCount()));
  check('the export button says 5', /\(5\)/.test(await exportLabel()), await exportLabel());

  console.log('[narrow] the operator unticks down to one');
  let keptId = null;
  {
    keptId = await page.evaluate(() => {
      const keep = _payLwState.lots[0].id;
      _payLwState.selected = new Set([keep]);
      _payLwRender();
      return keep;
    });
    check('exactly one ticked', (await selCount()) === 1, String(await selCount()));
    check('the button follows', /\(1\)/.test(await exportLabel()), await exportLabel());
  }

  console.log('[export] exporting that one must not re-arm the rest');
  {
    await page.evaluate(() => payLwExportBank());
    // The flow ends in mark-paid + a refresh; wait for the exported lot to
    // come back paid rather than racing it.
    await page.waitForFunction(
      (id) => (_payLwState.lots.find(l => l.id === id) || {}).paid_at,
      { timeout: 10000 }, keptId);
    const after = await selCount();
    const all = await lotCount();
    check('the exported lot is marked paid',
      await page.evaluate(id => !!(_payLwState.lots.find(l => l.id === id) || {}).paid_at, keptId));
    check('the OTHER four are NOT ticked — this is the bug', after === 0,
      `${after} of ${all} ticked after exporting one`);
    check('…and the button does not offer to pay the trade',
      !/\(4\)|\(5\)/.test(await exportLabel()), await exportLabel());
  }

  console.log('[advance] Pay Advance\'s refresh keeps the ticks too');
  {
    await search();                       // back to all ticked
    const two = await page.evaluate(() => {
      const ids = _payLwState.lots.filter(l => !l.paid_at).slice(0, 2).map(l => l.id);
      _payLwState.selected = new Set(ids);
      _payLwRender();
      return ids;
    });
    check('two ticked to begin with', (await selCount()) === 2, String(await selCount()));
    await page.evaluate(async (ids) => {
      await j(`/api/payments/lots/${_payLwState.aid}/advance`, {
        method: 'POST',
        body: JSON.stringify({ items: ids.map(id => ({ lotId: id, advance: 1000 })) }),
      });
      await payLwSearch({ keepSelection: true });
    }, two);
    check('still two ticked after the refresh', (await selCount()) === 2, String(await selCount()));
    check('…and they are the same two',
      await page.evaluate(ids => ids.every(i => _payLwState.selected.has(i)), two));
  }

  console.log('[undo] undoing an advance keeps them as well');
  {
    const before = await selCount();
    await page.evaluate(async () => {
      const l = _payLwState.lots.find(x => (Number(x.advance) || 0) > 0);
      if (!l) return;
      await j(`/api/payments/lots/${_payLwState.aid}/advance`, {
        method: 'POST', body: JSON.stringify({ items: [{ lotId: l.id, advance: 0 }] }),
      });
      await payLwSearch({ keepSelection: true });
    });
    check('the selection is unchanged', (await selCount()) === before,
      `${await selCount()} vs ${before}`);
  }

  console.log('[filter] changing a filter is a SEARCH, so it re-ticks');
  {
    await page.evaluate(() => {
      _payLwState.selected = new Set();
      _payLwRender();
    });
    check('nothing ticked first', (await selCount()) === 0);
    await page.evaluate(() => { document.getElementById('paylw-status').value = 'all'; });
    await page.evaluate(() => payLwSearch());
    await page.waitForFunction(() => !!document.querySelector('#paylw-body table'), { timeout: 8000 });
    const n = await selCount();
    check('a fresh search ticks the payable lots again', n > 0, String(n));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
