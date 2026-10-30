// Four things an operator asked for, all about reaching what is on screen —
// plus the delivery challan, which is a new document.
//
//  1. PRE-INVOICE's filter bar is PINNED. The screen is a bar that chooses an
//     invoice and a preview of that invoice that can run several pages; the
//     bar scrolled away, so changing buyer meant scrolling back to the top of
//     a long document. It now sticks under the top bar AND the tab strip,
//     both MEASURED (--stick-top) because both re-flow with window width and
//     the text-size control.
//
//  2. SALES INVOICES — Actions renders right after Dist (km). It was the last
//     of 20 columns: the operator came to the row to USE it and had to scroll
//     the grid sideways to find the buttons.
//
//  3. LOTS — "Crop Receipt" is now "CropRept" (it is a narrow column), and
//     Actions moved out of the far right to sit beside it. Same reason.
//
//     2 and 3 go through ONE helper (reorderColumn) that lifts a column out
//     of an assembled array and drops it after a named one, so the column
//     DEFINITIONS stay next to the data they describe.
//
//  4. DELIVERY CHALLAN — a gate pass printed over the lots ticked in Lot
//     Entry's recent-entries panel. The serial comes out of an install-wide
//     book: previewed when the form opens, CLAIMED only on print, so
//     cancelling never burns a number.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gridch-'));
const PORT = 47412;
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

  // A trade with priced, sold lots and one invoice, so both grids have real
  // rows — a header order read off an empty table proves nothing.
  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', trade_name: 'RNS SPICES', business_state: 'TAMIL NADU',
    tn_address1: 'REGISTERED STREET', tn_place: 'BODI', tn_pin: '625513',
    gst_goods: '5', commission: '1',
    chalan_veh_no: 'TN 55 AB 1234', chalan_rate: '310', chalan_address: 'GODOWN 2, GATE ROAD',
  } });
  await api('POST', '/api/auctions', { ano: '20', date: '2026-10-17', crop_type: 'ISP' });
  await api('POST', '/api/auctions/1/allocations',
    { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  await api('POST', '/api/buyers', { buyer: 'B1', buyer1: 'MURUGAN TRADERS', pla: 'CUMBUM',
    gstin: '33ALCPU9807E1Z0', add1: 'MAIN ST' });
  const seller = (await api('POST', '/api/traders',
    { name: 'RAVI PLANTER', tel: '9790744441', ppla: 'BODIMETTU' })).d.trader;
  for (const lot of ['001', '002']) {
    await api('POST', '/api/lots', { auction_id: 1, lot_no: lot, trader_id: seller.id, branch: 'BODI',
      grade: '1', bags: 10, litre: '300', qty: 400, sample_wt: 2.95, gross_wt: 402.95, crpt: 'CR' + lot });
  }
  const lots = (await api('GET', '/api/lots/1')).d || [];
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3152 })) });
  await api('POST', '/api/lots/bulk-set-buyer', { ids: lots.map(l => l.id),
    code: 'B1', buyer: 'B1', buyer1: 'MURUGAN TRADERS', sale: 'L' });
  await api('POST', '/api/lots/calculate/1', {});
  await api('POST', '/api/invoices/generate/1', { saleType: 'L', buyerCode: 'B1', invoiceNo: '1' });

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
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof reorderColumn === 'function', { timeout: 15000 });

  console.log('[1] The Pre-Invoice filter bar is pinned, under BOTH bars');
  await page.evaluate(() => go('preinvoice'));
  await new Promise(r => setTimeout(r, 600));
  const sticky = await page.evaluate(() => {
    const bar = document.querySelector('#tc-preinvoice .filterbar-sticky');
    if (!bar) return { found: false };
    const cs = getComputedStyle(bar);
    const root = getComputedStyle(document.documentElement);
    const px = (v) => parseFloat(String(v || '').replace('px', '')) || 0;
    const topbar = document.querySelector('.topbar');
    const strip = document.getElementById('tabstrip');
    return {
      found: true,
      position: cs.position,
      top: px(cs.top),
      stickTop: px(root.getPropertyValue('--stick-top')),
      topbarH: topbar ? Math.round(topbar.getBoundingClientRect().height) : 0,
      stripH: strip ? Math.round(strip.getBoundingClientRect().height) : 0,
      bg: cs.backgroundColor,
      zIndex: cs.zIndex,
    };
  });
  check('the bar is there and sticky', sticky.found && sticky.position === 'sticky', JSON.stringify(sticky));
  check('it is MEASURED, not a constant — top equals --stick-top',
        sticky.top > 0 && Math.abs(sticky.top - sticky.stickTop) < 1, JSON.stringify(sticky));
  check('…and that measurement is the top bar plus the tab strip',
        Math.abs(sticky.stickTop - (sticky.topbarH + sticky.stripH)) <= 1, JSON.stringify(sticky));
  check('it is opaque, so rows do not show through as they scroll under it',
        sticky.bg !== 'rgba(0, 0, 0, 0)' && sticky.bg !== 'transparent', sticky.bg);
  // Under the tab strip's 20 — the strip must cover the bar, not the reverse.
  check('it layers below the tab strip', Number(sticky.zIndex) > 0 && Number(sticky.zIndex) < 20, sticky.zIndex);

  // It has to STAY on screen once the page is scrolled — the whole point.
  const afterScroll = await page.evaluate(async () => {
    const bar = document.querySelector('#tc-preinvoice .filterbar-sticky');
    const before = bar.getBoundingClientRect().top;
    window.scrollTo(0, 400);
    await new Promise(r => setTimeout(r, 120));
    const after = bar.getBoundingClientRect().top;
    window.scrollTo(0, 0);
    return { before: Math.round(before), after: Math.round(after),
             scrolled: document.documentElement.scrollHeight > window.innerHeight };
  });
  check('scrolling the page does not take the bar with it',
        !afterScroll.scrolled || afterScroll.after >= 0, JSON.stringify(afterScroll));

  console.log('\n[2] The reorder helper — one implementation, two grids');
  const helper = await page.evaluate(() => {
    const cols = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: '_actions' }];
    const moved = reorderColumn(cols, '_actions', 'a');
    return {
      moved: moved.map(c => c.key),
      untouched: cols.map(c => c.key),
      missingKey: reorderColumn(cols, 'nope', 'a').map(c => c.key),
      missingAnchor: reorderColumn(cols, '_actions', 'nope').map(c => c.key),
    };
  });
  check('it moves the column after the named one',
        helper.moved.join(',') === 'a,_actions,b,c', JSON.stringify(helper.moved));
  check('it does not mutate the array it was given',
        helper.untouched.join(',') === 'a,b,c,_actions', JSON.stringify(helper.untouched));
  // A conditionally-assembled array can be missing either end; a reorder must
  // never be the thing that empties a table.
  check('an absent column is a no-op, not an error',
        helper.missingKey.join(',') === 'a,b,c,_actions', JSON.stringify(helper.missingKey));
  check('an absent anchor leaves the order alone',
        helper.missingAnchor.join(',') === 'a,b,c,_actions', JSON.stringify(helper.missingAnchor));

  console.log('\n[3] Sales Invoices — Actions sits next to Dist (km)');
  await page.evaluate(() => go('invoices'));
  // DataTable rewrites the THEAD of the table that holds the tbody it mounts
  // on, so the live header is read through the tbody's own table.
  const headOf = (id) => {
    const tb = document.getElementById(id);
    const tbl = tb && tb.closest('table');
    return tbl ? [...tbl.querySelectorAll('thead th')].map(t => t.textContent.trim()) : [];
  };
  await page.evaluate(`window.headOf = ${headOf.toString()}`);
  await page.waitForFunction(() => headOf('invoices-list').length > 5 &&
    document.querySelectorAll('#invoices-list tr').length > 0, { timeout: 15000 });
  const inv = await page.evaluate(() => {
    const hdr = headOf('invoices-list');
    const d = hdr.findIndex(h => /^Dist/.test(h));
    return { hdr, d, next: hdr[d + 1], last: hdr[hdr.length - 1], rows: document.querySelectorAll('#invoices-list tr').length };
  });
  check('the grid has rows to act on', inv.rows > 0, JSON.stringify(inv.rows));
  check('Dist (km) is in the header', inv.d > 0, JSON.stringify(inv.hdr));
  check('Actions follows it immediately', inv.next === 'Actions', JSON.stringify(inv.hdr));
  check('…and is no longer the last column', inv.last !== 'Actions', inv.last);

  console.log('\n[4] Lots — CropRept, with Actions beside it');
  await page.evaluate(() => go('lots'));
  await page.waitForFunction(() => headOf('lots-list').length > 5 &&
    document.querySelectorAll('#lots-list tr').length > 0, { timeout: 15000 });
  const lotHdr = await page.evaluate(() => {
    const hdr = headOf('lots-list');
    const c = hdr.indexOf('CropRept');
    return { hdr, c, next: hdr[c + 1], last: hdr[hdr.length - 1],
             rows: document.querySelectorAll('#lots-list tr').length };
  });
  check('the grid has rows', lotHdr.rows > 0, String(lotHdr.rows));
  check('the column is headed CropRept', lotHdr.c > 0, JSON.stringify(lotHdr.hdr));
  check('…not "Crop Receipt"', !lotHdr.hdr.includes('Crop Receipt'), JSON.stringify(lotHdr.hdr));
  check('Actions follows it immediately', lotHdr.next === 'Actions', JSON.stringify(lotHdr.hdr));
  check('…and has left the far right', lotHdr.last !== 'Actions', lotHdr.last);

  console.log('\n[5] Delivery Challan — the button, and its gate');
  await page.evaluate(() => go('lotentry'));
  await new Promise(r => setTimeout(r, 900));
  const gate = await page.evaluate(() => ({
    attr: document.body.getAttribute('data-feat-delivery-chalan'),
    btn: !!document.getElementById('le-chalan-btn'),
    openFn: typeof leOpenChalan === 'function',
    buildFn: typeof leBuildChalanHtml === 'function',
  }));
  check('the flag is ON by default', gate.attr === '1', JSON.stringify(gate));
  check('the button exists', gate.btn === true, JSON.stringify(gate));
  check('and both handlers are defined', gate.openFn && gate.buildFn, JSON.stringify(gate));
  const offGate = await page.evaluate(async () => {
    await fetch('/api/company-settings', { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('t') },
      body: JSON.stringify({ settings: { flag_delivery_chalan: 'false' } }) });
    await applyFeatureFlags();
    const b = document.getElementById('le-chalan-btn');
    b.style.display = 'inline-flex';                       // as a selection would
    return { attr: document.body.getAttribute('data-feat-delivery-chalan'),
             shown: getComputedStyle(b).display };
  });
  check('switched off, the flag reads off', offGate.attr === '0', JSON.stringify(offGate));
  check('…and the button collapses even when the selection would show it',
        offGate.shown === 'none', offGate.shown);
  await page.evaluate(async () => {
    await fetch('/api/company-settings', { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('t') },
      body: JSON.stringify({ settings: { flag_delivery_chalan: 'true' } }) });
    await applyFeatureFlags();
  });

  console.log('\n[6] The form pre-fills from settings, and the serial is a PREVIEW');
  const form = await page.evaluate(async () => {
    // Stand in for a selection: the panel's own lots, ticked.
    const lots = (await (await fetch('/api/lots/1', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('t') } })).json());
    _le.recentLots = lots;
    _le.selectedForPrint = new Set(lots.map(l => l.id));
    leUpdatePrintToolbar();
    const btnShown = getComputedStyle(document.getElementById('le-chalan-btn')).display;
    await leOpenChalan();
    const v = (id) => document.getElementById(id).value;
    return {
      btnShown,
      badge: document.getElementById('le-chalan-count').textContent,
      open: document.getElementById('le-chalan-modal').classList.contains('show')
            || getComputedStyle(document.getElementById('le-chalan-modal')).display !== 'none',
      no: v('le-chalan-no'), veh: v('le-chalan-veh'), rate: v('le-chalan-rate'),
      bags: v('le-chalan-bags'), addr: v('le-chalan-address'), to: v('le-chalan-to'),
      date: v('le-chalan-date'),
      summary: document.getElementById('le-chalan-summary').textContent,
    };
  });
  // The toolbar is a flex row, so the browser blockifies the button's
  // inline-flex to 'flex' — what matters is that it is not 'none'.
  check('a selection shows the button', form.btnShown !== 'none', form.btnShown);
  check('…badged with the count', form.badge === '2', form.badge);
  check('the modal opens', form.open === true, JSON.stringify(form.open));
  check('the serial pre-fills from the book', form.no === '1', form.no);
  check('the vehicle pre-fills from its setting', form.veh === 'TN 55 AB 1234', form.veh);
  check('the rate pre-fills from its setting', String(form.rate) === '310', form.rate);
  check('the address pre-fills from its setting', form.addr === 'GODOWN 2, GATE ROAD', form.addr);
  check('bags default to the total on the ticked lots', String(form.bags) === '20', form.bags);
  check('one seller is named outright', form.to === 'RAVI PLANTER', form.to);
  check('the date defaults to today', form.date === new Date().toISOString().slice(0, 10), form.date);
  check('the summary counts what is going', /2 lots/.test(form.summary) && /20 bags/.test(form.summary), form.summary);

  // Cancelling must not burn a number out of a paper book.
  const afterCancel = await page.evaluate(async () => {
    hideModal('le-chalan-modal');
    const r = await (await fetch('/api/delivery-chalan/next-no',
      { headers: { Authorization: 'Bearer ' + localStorage.getItem('t') } })).json();
    return r;
  });
  check('cancelling the form leaves the counter where it was', String(afterCancel.serial) === '1',
        JSON.stringify(afterCancel));

  console.log('\n[7] What the challan prints');
  const doc = await page.evaluate(async () => {
    const lots = _le.recentLots;
    const html = leBuildChalanHtml({
      lots, cfg: await j('/api/company-settings/flat'),
      auction: { ano: '20', date: '2026-10-17' },
      chalanNo: 'DC/7', date: '2026-10-17', veh: 'TN 55 AB 1234',
      rate: 310, bags: 18, consignee: 'RAVI PLANTER', address: 'GODOWN 2, GATE ROAD',
    });
    return html;
  });
  check('it is titled a delivery chalan', /DELIVERY CHALAN|Delivery Chalan/i.test(doc), doc.slice(0, 200));
  check('it says outright it is not a tax invoice', /Not a tax invoice/i.test(doc));
  check('the company name heads it', /RNS SPICES/.test(doc));
  check('the typed address replaces the registered one',
        /GODOWN 2, GATE ROAD/.test(doc) && !/REGISTERED STREET/.test(doc));
  check('the serial, date and vehicle are on it',
        /DC\/7/.test(doc) && /TN 55 AB 1234/.test(doc));
  check('every ticked lot is listed', /001/.test(doc) && /002/.test(doc));
  // Indian grouping, like every other money figure the app prints.
  check('the rate and the value are computed per lot',
        /310\.00/.test(doc) && /1,24,000\.00/.test(doc), 'qty 400 x 310 = 1,24,000.00');
  check('…and the total adds the lots up', /2,48,000\.00/.test(doc), 'two lots = 2,48,000.00');
  // The typed bag count is the one the gate counts; the booked total is still
  // shown so a part load is visible rather than silently different.
  check('the typed bag count is what totals', />18</.test(doc), 'expected the typed 18');
  check('…and a part load says so', /18 of 20 booked/.test(doc), doc.slice(-900));

  console.log('\n[8] Printing claims the serial — once');
  const claimed = await page.evaluate(async () => {
    const tok = localStorage.getItem('t');
    const post = async () => (await (await fetch('/api/delivery-chalan/claim-no',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: '{}' })).json());
    const a = await post(), b = await post();
    const peek = await (await fetch('/api/delivery-chalan/next-no',
      { headers: { Authorization: 'Bearer ' + tok } })).json();
    return { a, b, peek };
  });
  check('a claim hands out the current serial', String(claimed.a.serial) === '1', JSON.stringify(claimed.a));
  check('the next claim is a DIFFERENT number', String(claimed.b.serial) === '2', JSON.stringify(claimed.b));
  check('…and the book has moved on', String(claimed.peek.serial) === '3', JSON.stringify(claimed.peek));
  // The prefix is part of the printed number, not of the counter.
  const prefixed = await page.evaluate(async () => {
    const tok = localStorage.getItem('t');
    await fetch('/api/company-settings', { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ settings: { chalan_prefix: 'DC/' } }) });
    return await (await fetch('/api/delivery-chalan/next-no',
      { headers: { Authorization: 'Bearer ' + tok } })).json();
  });
  check('the prefix is applied to the printed number', prefixed.no === 'DC/3', JSON.stringify(prefixed));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-15).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
