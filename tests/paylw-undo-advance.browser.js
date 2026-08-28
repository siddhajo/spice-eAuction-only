// Payments — Lot-wise: undoing an ADVANCE, and the advance bank file.
//
// Driven through the real screen in a headless Chrome, because all three
// pieces are hand-rendered and conditional:
//
//   [row]    "↩ Undo advance" appears on a row that carries one, and on no
//            other row — including a settled one, whose advance the server
//            refuses to clear
//   [bulk]   the toolbar "↩ Undo advance (n)" counts the TICKED lots that
//            carry an advance, and clears exactly those
//   [export] the dialog's "📤 Export advance" counts SAVED advances and
//            refuses to ship an amount that has only been typed
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-undoadv-'));
const PORT = 47385;
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

  const auc = await api('POST', '/api/auctions', { ano: '31', date: '2026-08-28', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  const t = await api('POST', '/api/traders', {
    name: 'ANNAMALAI', cr: '', padd: 'ADDR', ppla: 'PLACE',
    banks: [{ acctnum: '1000012345', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'ANNAMALAI', is_default: 1 }],
  });
  const traderId = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
  const lotIds = {};
  for (const lot_no of ['1', '2', '3', '4']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'ANNAMALAI', cr: '', qty: 100, grade: '2', bags: 10,
      crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: traderId,
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    lotIds[lot_no] = id;
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800 });
  }
  // Lots 1-3 carry an advance; lot 4 does not. Lot 3 is then settled, so its
  // advance is locked until the paid stamp is undone.
  await api('POST', `/api/payments/lots/${aid}/advance`, { items: [
    { lotId: lotIds['1'], advance: 5000 },
    { lotId: lotIds['2'], advance: 1200 },
    { lotId: lotIds['3'], advance: 300 },
  ]});
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [lotIds['3']] });

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
  // Every confirm() here is the "really move this money?" gate; alert() is how
  // the export refuses. Record what was said so the refusals can be asserted.
  const dialogs = [];
  page.on('dialog', d => { dialogs.push({ type: d.type(), msg: d.message() }); d.accept().catch(() => {}); });
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
      return b && (b.querySelector('table') || /No lots matched|No unlinked/.test(b.textContent));
    }, { timeout: 8000 });
  };
  // Column 6 is Advance, column 2 the lot number.
  const rowsNow = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body tbody tr')).map(tr => ({
      lot:      (tr.children[2]?.textContent || '').trim(),
      advance:  (tr.children[6]?.textContent || '').trim(),
      paid:     tr.classList.contains('paylw-row-paid'),
      undoAdv:  Array.from(tr.querySelectorAll('button'))
                  .some(b => /Undo advance/i.test(b.textContent || '')),
    })));
  const toolbarBtn = () => page.evaluate(() => {
    const b = document.getElementById('paylw-undoadv-btn');
    return b ? { shown: b.style.display !== 'none', text: b.textContent.trim(), disabled: b.disabled } : null;
  });
  const tickLots = (lots) => page.evaluate(want => {
    document.querySelectorAll('#paylw-body tbody tr').forEach(tr => {
      const lot = (tr.children[2]?.textContent || '').trim();
      const cb = tr.querySelector('.paylw-cb');
      if (!cb) return;
      const wanted = want.includes(lot);
      if (cb.checked !== wanted) { cb.checked = wanted; payLwTick(Number(cb.dataset.id), wanted); }
    });
  }, lots);

  console.log('[row] the per-row Undo advance button');
  await search();
  let rows = await rowsNow();
  check('4 lots listed', rows.length === 4, JSON.stringify(rows));
  const byLot = Object.fromEntries(rows.map(r => [r.lot, r]));
  check('a lot with an advance offers Undo advance', byLot['1'].undoAdv && byLot['2'].undoAdv,
        JSON.stringify(rows));
  check('a lot with no advance does not', !byLot['4'].undoAdv, JSON.stringify(byLot['4']));
  check('a settled lot does not either — the server would refuse it',
        byLot['3'].paid && !byLot['3'].undoAdv, JSON.stringify(byLot['3']));

  console.log('\n[bulk] the toolbar button counts ticked advances');
  let tb = await toolbarBtn();
  check('it is shown, since the results carry advances', tb && tb.shown, JSON.stringify(tb));
  // A fresh search ticks every payable lot, so it opens armed with both
  // advances — lot 3's is excluded because the row is settled.
  check('a fresh search arms it with both unsettled advances',
        tb && !tb.disabled && /\(2\)/.test(tb.text), JSON.stringify(tb));
  await tickLots([]);
  tb = await toolbarBtn();
  check('unticking everything disables it', tb && tb.disabled && !/\(/.test(tb.text), JSON.stringify(tb));
  await tickLots(['1', '4']);
  tb = await toolbarBtn();
  check('ticking one advanced lot and one plain lot counts ONE',
        tb && /\(1\)/.test(tb.text) && !tb.disabled, JSON.stringify(tb));
  await tickLots(['1', '2', '4']);
  tb = await toolbarBtn();
  check('ticking both advanced lots counts TWO', tb && /\(2\)/.test(tb.text), JSON.stringify(tb));

  console.log('\n[bulk] it clears exactly the ticked advances');
  await page.evaluate(() => payLwUndoAdvanceSelected());
  await page.waitForFunction(() => {
    const tr = Array.from(document.querySelectorAll('#paylw-body tbody tr'))
      .find(r => (r.children[2]?.textContent || '').trim() === '1');
    return tr && (tr.children[6]?.textContent || '').trim() === '—';
  }, { timeout: 10000 });
  rows = await rowsNow();
  const after = Object.fromEntries(rows.map(r => [r.lot, r]));
  check('lots 1 and 2 lost their advance',
        after['1'].advance === '—' && after['2'].advance === '—', JSON.stringify(rows));
  check('the settled lot 3 kept its 300', /300/.test(after['3'].advance), JSON.stringify(after['3']));
  check('lot 4 is untouched', after['4'].advance === '—', JSON.stringify(after['4']));
  const confirmed = dialogs.filter(d => d.type === 'confirm');
  check('the confirm named the money and where it goes back to',
        confirmed.some(d => /6,?200/.test(d.msg) && /Payable goes back up/i.test(d.msg)),
        JSON.stringify(confirmed.map(d => d.msg)));

  console.log('\n[bulk] the button hides once no advance is left');
  // Only the settled lot's advance remains, and the bulk action never covers
  // settled rows — so the toolbar has nothing to offer.
  tb = await toolbarBtn();
  check('hidden when the only advance left is on a paid lot', tb && !tb.shown, JSON.stringify(tb));

  console.log('\n[row] clicking one row\'s Undo advance clears that lot only');
  await api('POST', `/api/payments/lots/${aid}/advance`, { items: [{ lotId: lotIds['4'], advance: 750 }] });
  await search();
  rows = await rowsNow();
  check('lot 4 now carries 750 and offers the button',
        /750/.test(rows.find(r => r.lot === '4').advance) && rows.find(r => r.lot === '4').undoAdv,
        JSON.stringify(rows.find(r => r.lot === '4')));
  await page.evaluate(() => {
    const tr = Array.from(document.querySelectorAll('#paylw-body tbody tr'))
      .find(r => (r.children[2]?.textContent || '').trim() === '4');
    const btn = Array.from(tr.querySelectorAll('button')).find(b => /Undo advance/i.test(b.textContent || ''));
    btn.click();
  });
  await page.waitForFunction(() => {
    const tr = Array.from(document.querySelectorAll('#paylw-body tbody tr'))
      .find(r => (r.children[2]?.textContent || '').trim() === '4');
    return tr && (tr.children[6]?.textContent || '').trim() === '—';
  }, { timeout: 10000 });
  rows = await rowsNow();
  const post = Object.fromEntries(rows.map(r => [r.lot, r]));
  check('lot 4 lost its advance', post['4'].advance === '—', JSON.stringify(post['4']));
  check('…and its Payable is back to the full 9,800',
        /9,800/.test(await page.evaluate(() => {
          const tr = Array.from(document.querySelectorAll('#paylw-body tbody tr'))
            .find(r => (r.children[2]?.textContent || '').trim() === '4');
          return (tr.children[7]?.textContent || '').trim();
        })), 'payable cell');
  check('the settled lot 3 still keeps its own', /300/.test(post['3'].advance), JSON.stringify(post['3']));

  console.log('\n[export] the dialog\'s Export advance button');
  await page.evaluate(() => payLwOpenAdvance());
  await page.waitForFunction(
    () => document.getElementById('paylw-adv-modal')?.classList.contains('show')
          && document.querySelectorAll('#paylw-adv-body tbody tr').length > 0,
    { timeout: 8000 });
  const xbtn = () => page.evaluate(() => {
    const b = document.getElementById('paylw-adv-export');
    return b ? { text: b.textContent.trim(), disabled: b.disabled, title: b.title } : null;
  });
  let xb = await xbtn();
  check('disabled while no ticked lot carries a saved advance',
        xb && xb.disabled && /press Pay first/i.test(xb.title), JSON.stringify(xb));

  // Type an amount without saving — the export must refuse it by name.
  await page.evaluate(() => {
    const tr = Array.from(document.querySelectorAll('#paylw-adv-body tbody tr'))
      .find(r => (r.children[2]?.textContent || '').trim() === '1');
    const amt = tr && tr.querySelector('.paylw-adv-amt');
    if (amt) { amt.value = '2500'; payLwAdvSync(); }
  });
  const before = dialogs.length;
  await page.evaluate(() => payLwExportAdvance());
  await page.waitForFunction(n => window.__d === undefined && true && n >= 0, {}, before);
  await new Promise(r => setTimeout(r, 400));
  const said = dialogs.slice(before);
  check('a typed-but-unsaved amount is refused, naming the lot',
        said.some(d => d.type === 'alert' && /not been saved/i.test(d.msg) && /\b1\b/.test(d.msg)),
        JSON.stringify(said.map(d => d.msg)));

  // Save it. The dialog deliberately STAYS OPEN — recording the advance and
  // sending it to the bank are two halves of one job — and redraws against the
  // reloaded lots, which disarms Pay and lights up Export.
  await page.evaluate(() => payLwSaveAdvance());
  await page.waitForFunction(
    () => document.getElementById('paylw-adv-modal')?.classList.contains('show')
          && document.getElementById('paylw-adv-save')?.disabled
          && !document.getElementById('paylw-adv-export')?.disabled,
    { timeout: 10000 });
  check('the dialog stays open after Pay, with Export now armed', true);
  await page.evaluate(() => {
    document.querySelectorAll('#paylw-adv-body tbody tr').forEach(tr => {
      const cb = tr.querySelector('.paylw-adv-cb');
      if (cb) cb.checked = (tr.children[2]?.textContent || '').trim() === '1';
    });
    payLwAdvSync();
  });
  xb = await xbtn();
  check('once saved, it offers to export that one lot',
        xb && !xb.disabled && /\(1\)/.test(xb.text), JSON.stringify(xb));

  console.log('\n[export] it downloads the bank file');
  // The click path ends in a browser download, so assert the request the page
  // makes rather than the file: same body the payable export sends, aimed at
  // the advance endpoint.
  const posted = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (/bank_payment_advance/.test(req.url()) && req.method() === 'POST') {
      posted.push({ url: req.url(), body: req.postData() });
    }
    req.continue().catch(() => {});
  });
  await page.evaluate(() => payLwExportAdvance());
  await page.waitForFunction(() => true);
  await new Promise(r => setTimeout(r, 1200));
  check('it posts to the advance export endpoint', posted.length === 1, JSON.stringify(posted));
  if (posted.length) {
    let body = {}; try { body = JSON.parse(posted[0].body || '{}'); } catch (_) {}
    check('…carrying the seller and the picked lot',
          Array.isArray(body.names) && body.names[0] === 'ANNAMALAI'
          && body.lots && Array.isArray(body.lots.ANNAMALAI) && body.lots.ANNAMALAI.join() === '1',
          JSON.stringify(body));
    check('…in lot order, as xlsx', body.format === 'xlsx' && body.orderBy === 'lot', JSON.stringify(body));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
