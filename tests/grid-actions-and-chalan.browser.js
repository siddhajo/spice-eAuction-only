// Four things an operator asked for, all about reaching what is on screen —
// plus the delivery challan, which is a new document.
//
//  1. PRE-INVOICE's card HEADER is PINNED — heading and filter bar together,
//     not the controls alone, which reads as a detached strip. The screen is
//     a bar that chooses an invoice and a preview of that invoice that can
//     run several pages; the bar scrolled away, so changing buyer meant
//     scrolling back to the top of a long document. It now sticks under the
//     top bar AND the tab strip, both MEASURED (--stick-top) because both
//     re-flow with window width and the text-size control.
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
//  4. DELIVERY CHALLAN — "Form GST Delivery Challan", printed over the lots
//     ticked in Lot Entry's recent-entries panel and reproduced from the
//     customer's own stationery. The serial comes out of an install-wide
//     book: previewed when the form opens, CLAIMED only on print, so
//     cancelling never burns a number. The goods are TWO lines — the net
//     weight and the sample weight that travels with it — not one per lot,
//     because the form states what is MOVING, not which lots it came off.
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
    hsn_cardamom: '09083120', hsn_gunny: '63051040', gunny_rate: '165',
    // The challan's SAMPLES row is lots x (refund + trader sample), the same
    // two boxes the Commission Bill deducts — NOT the lots' own sample_wt.
    sb_refund: '0.400', sb_trader_sample: '0.100',
    chalan_gunny_remarks: 'Empty gunny returned to the collection centre',
    chalan_veh_no: 'TN 55 AB 1234', chalan_rate: '310',
    chalan_prefix: 'DC-', chalan_suffix: '/26-27',
    // The address block is the BRANCH's. chalan_address is only the fallback,
    // so it is deliberately set to something the test can tell apart.
    br1_head: 'CARDAMOM COLLECTION CENTRE', br1_addr: 'GATE ROAD\nBODI-625513',
    br2: 'CUMBUM', br2_head: 'CUMBUM CENTRE', br2_addr: 'MARKET ROAD\nCUMBUM-625516',
    chalan_address: 'FALLBACK ADDRESS LINE',
    chalan_transport_mode: 'By Road', chalan_place_of_supply: 'NIRAPPELKADA',
    chalan_receiver_name: 'RNS SPICES', chalan_receiver_state: 'KERALA',
    chalan_receiver_code: '32', chalan_receiver_gstin: '32ABFFR1926E1ZK',
    chalan_receiver_address: '14/623, RNS BUILDING\nPULIYANMALA ROAD,\nNIRAPPELKADA-685552',
    chalan_remarks: 'Auction Sample Not for Sales, Only for Auction Purpose',
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

  console.log('[1] The Pre-Invoice card header is pinned, under BOTH bars');
  await page.evaluate(() => go('preinvoice'));
  await new Promise(r => setTimeout(r, 600));
  const sticky = await page.evaluate(() => {
    const bar = document.querySelector('#tc-preinvoice .cardhead-sticky');
    if (!bar) return { found: false };
    const cs = getComputedStyle(bar);
    const card = bar.closest('.card');
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
      // What is INSIDE the pinned block — the title has to travel with the
      // controls, or a bare strip floats with nothing naming it.
      hasTitle: /Pre-Invoice/.test(bar.querySelector('h2') ? bar.querySelector('h2').textContent : ''),
      hasControls: !!bar.querySelector('#pi-auction') && !!bar.querySelector('#pi-buyer'),
      // It must span the card's inner width exactly — the negative margins
      // are the CARD's padding, so a wider inset would hang past its edge.
      overhangL: Math.round(bar.getBoundingClientRect().left - card.getBoundingClientRect().left),
      overhangR: Math.round(card.getBoundingClientRect().right - bar.getBoundingClientRect().right),
    };
  });
  check('the block is there and sticky', sticky.found && sticky.position === 'sticky', JSON.stringify(sticky));
  check('the heading is pinned WITH the controls, not left behind',
        sticky.hasTitle === true && sticky.hasControls === true, JSON.stringify(sticky));
  check('it spans the card exactly, hanging past neither edge',
        Math.abs(sticky.overhangL) <= 1 && Math.abs(sticky.overhangR) <= 1,
        JSON.stringify({ L: sticky.overhangL, R: sticky.overhangR }));
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
    const bar = document.querySelector('#tc-preinvoice .cardhead-sticky');
    const before = bar.getBoundingClientRect().top;
    window.scrollTo(0, 400);
    await new Promise(r => setTimeout(r, 120));
    const after = bar.getBoundingClientRect().top;
    window.scrollTo(0, 0);
    return { before: Math.round(before), after: Math.round(after),
             scrolled: document.documentElement.scrollHeight > window.innerHeight };
  });
  check('scrolling the page does not take the header with it',
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
      bags: v('le-chalan-bags'), sampleBags: v('le-chalan-sample-bags'),
      qty: v('le-chalan-qty'), sampleQty: v('le-chalan-sample-qty'),
      totals: document.getElementById('le-chalan-totals').textContent,
      head: v('le-chalan-head'), addr: v('le-chalan-address'),
      mode: v('le-chalan-mode'), pos: v('le-chalan-pos'),
      to: v('le-chalan-to'), raddr: v('le-chalan-raddr'),
      rstate: v('le-chalan-rstate'), rcode: v('le-chalan-rcode'), rgstin: v('le-chalan-rgstin'),
      date: v('le-chalan-date'), time: v('le-chalan-time'),
      summary: document.getElementById('le-chalan-summary').textContent,
    };
  });
  // The toolbar is a flex row, so the browser blockifies the button's
  // inline-flex to 'flex' — what matters is that it is not 'none'.
  check('a selection shows the button', form.btnShown !== 'none', form.btnShown);
  check('…badged with the count', form.badge === '2', form.badge);
  check('the modal opens', form.open === true, JSON.stringify(form.open));
  // Prefix and suffix WRAP the counter without being part of it, so the
  // financial-year tail can change in April without resetting the number.
  check('the serial pre-fills wrapped in its prefix and suffix', form.no === 'DC-1/26-27', form.no);
  check('the vehicle pre-fills from its setting', form.veh === 'TN 55 AB 1234', form.veh);
  check('the rate pre-fills from its setting', String(form.rate) === '310', form.rate);
  check('the transport mode and place of supply pre-fill',
        form.mode === 'By Road' && form.pos === 'NIRAPPELKADA', JSON.stringify(form));
  // The address is the BRANCH's own, not the install-wide fallback — a
  // consignment leaves a particular collection centre.
  check('the address block comes from the lots\' BRANCH',
        form.addr.split('\n').length === 2 && /GATE ROAD/.test(form.addr), form.addr);
  // The heading is what the place IS, and it is its own field — it has to be
  // able to change places with the receiver's NAME.
  check('…headed by what that branch is called',
        form.head === 'CARDAMOM COLLECTION CENTRE', form.head);
  check('…not the install-wide fallback', !/FALLBACK ADDRESS LINE/.test(form.addr), form.addr);
  check('bags default to the total on the ticked lots', String(form.bags) === '20', form.bags);
  // Nothing on a lot records how many SAMPLE bags go with the load — the
  // operator counts them onto the lorry — so it starts empty.
  check('sample bags start empty, for the operator to count', form.sampleBags === '', form.sampleBags);
  // Quantity is editable for the same reason Bags is — part of a load can go,
  // and the paper has to say what actually left the gate.
  check('qty defaults to the ticked lots\' net weight', form.qty === '800.000', form.qty);
  // 2 lots x (0.400 refund + 0.100 trader) = 1.000 — NOT the 5.900 the lots'
  // own sample_wt columns add up to. The challan moves the AUCTION sample, a
  // fixed draw per lot, which is what the bill prices.
  check('…and the sample qty to lots x (refund + trader sample)',
        form.sampleQty === '1.000', form.sampleQty);
  // The dialog shows the form's own Total row before it prints: two typed
  // quantities at a typed rate are easy to get wrong.
  check('the dialog shows the total quantity',
        /Total Qty/.test(form.totals) && /801\.000 kg/.test(form.totals), form.totals);
  check('…and the total value beside it',
        /Total Value/.test(form.totals) && /2,48,310\.00/.test(form.totals), form.totals);
  // The receiver is the DESTINATION, which repeats — it comes from settings,
  // not from the seller on the lots.
  check('the receiver block pre-fills from settings',
        form.to === 'RNS SPICES' && form.rstate === 'KERALA' && form.rcode === '32'
        && form.rgstin === '32ABFFR1926E1ZK' && /RNS BUILDING/.test(form.raddr),
        JSON.stringify({ to: form.to, rstate: form.rstate, rcode: form.rcode }));
  check('the date defaults to today', form.date === new Date().toISOString().slice(0, 10), form.date);
  check('…and the time of supply is filled too', /^\d{2}:\d{2}$/.test(form.time), form.time);
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

  console.log('\n[6s] The SAMPLES quantity is a per-lot draw, not the lots\' own weights');
  const smp = await page.evaluate(async () => {
    const cfg = await j('/api/company-settings/flat');
    const two = _le.recentLots;
    return {
      two:  leChalanSampleQty(two, cfg),
      one:  leChalanSampleQty([two[0]], cfg),
      none: leChalanSampleQty([], cfg),
      zeroed: leChalanSampleQty(two, { sb_refund: '0', sb_trader_sample: '0' }),
      // A float product like 3 x 0.45 lands on 1.3499999999999999.
      rounded: leChalanSampleQty([1, 2, 3], { sb_refund: '0.45', sb_trader_sample: '0' }),
      lotsOwnWeight: two.reduce((t, l) => t + (Number(l.sample_wt) || 0), 0),
    };
  });
  check('it is lots x (refund + trader sample)', smp.two === 1, JSON.stringify(smp));
  check('…so it scales with the number of lots', smp.one === 0.5 && smp.none === 0, JSON.stringify(smp));
  check('…and is NOT the lots\' own sample_wt', smp.lotsOwnWeight === 5.9 && smp.two !== smp.lotsOwnWeight,
        JSON.stringify(smp));
  check('both rates at 0 means no sample at all', smp.zeroed === 0, String(smp.zeroed));
  check('the product is rounded to the gram', smp.rounded === 1.35, String(smp.rounded));

  console.log('\n[6a] The totals follow what is typed');
  const live = await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); };
    const read = () => document.getElementById('le-chalan-totals').textContent;
    set('le-chalan-qty', '1000');
    const afterQty = read();
    set('le-chalan-rate', '500');
    const afterRate = read();
    // A deliberate 0 means "no samples on this trip" and must DROP the line,
    // not fall back to the lots' sample weight.
    set('le-chalan-sample-qty', '0');
    const afterZero = read();
    set('le-chalan-qty', '800'); set('le-chalan-sample-qty', '1'); set('le-chalan-rate', '310');
    return { afterQty, afterRate, afterZero, restored: read() };
  });
  check('typing a quantity re-totals it', /1,001\.000 kg/.test(live.afterQty), live.afterQty);
  check('typing a rate re-values it', /5,00,500\.00/.test(live.afterRate), live.afterRate);
  check('a sample qty of 0 drops the SAMPLES line', /1 line on the challan/.test(live.afterZero)
        && /1,000\.000 kg/.test(live.afterZero), live.afterZero);
  check('…and the figures come back when it is put back',
        /801\.000 kg/.test(live.restored) && /2 lines/.test(live.restored), live.restored);

  console.log('\n[6g] Gunny is different goods on the same form');
  // The same challan carries cardamom out and empty gunny back. Gunny is a
  // different HSN, counted in BAGS at a per-bag rate, with no sample line —
  // the user asked for the choice alongside the address swap, because the
  // return trip is the gunny trip.
  const gunny = await page.evaluate(async () => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v;
                             el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input')); };
    const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
    set('le-chalan-goods', 'gunny');
    const afterSwitch = {
      rateLbl: document.getElementById('le-chalan-rate-lbl').textContent,
      bagsLbl: document.getElementById('le-chalan-bags-lbl').textContent,
      rate: document.getElementById('le-chalan-rate').value,
      qtyShown: shown('#le-chalan-qty').valueOf(),
      sampleQtyShown: getComputedStyle(document.getElementById('le-chalan-sample-qty').closest('.fg')).display !== 'none',
      sampleBagsShown: getComputedStyle(document.getElementById('le-chalan-sample-bags').closest('.fg')).display !== 'none',
      qtyFieldShown: getComputedStyle(document.getElementById('le-chalan-qty').closest('.fg')).display !== 'none',
      totals: document.getElementById('le-chalan-totals').textContent,
    };
    set('le-chalan-bags', '194');
    const totals = document.getElementById('le-chalan-totals').textContent;
    const cfg = await j('/api/company-settings/flat');
    const lines = leChalanLines({ lots: _le.recentLots, cfg, goods: 'gunny', rate: 165, bags: '194' });
    const html = leBuildChalanHtml({
      lots: _le.recentLots, cfg, goods: 'gunny', chalanNo: 'DC-9/26-27',
      date: '2026-10-26', time: '20:20', veh: 'KL69B4797', mode: 'By Road',
      placeOfSupply: 'NIRAPPELKADA', rate: 165, bags: '194', sampleBags: '5',
      heading: 'RNS SPICES', address: 'RNS BUILDING',
      receiver: { name: 'CARDAMOM COLLECTION CENTRE', address: 'GATE ROAD' },
      words: 'Rupees Thirty Two Thousand Ten Only',
    });
    set('le-chalan-goods', 'cardamom');
    return { afterSwitch, totals, lines, html,
             backToCardamom: document.getElementById('le-chalan-rate-lbl').textContent };
  });
  check('the rate becomes a PER-BAG rate', gunny.afterSwitch.rateLbl === 'Rate (per bag)', gunny.afterSwitch.rateLbl);
  check('…seeded from Settings → Rates → gunny_rate, not a challan-only copy',
        gunny.afterSwitch.rate === '165', gunny.afterSwitch.rate);
  check('Bags becomes the quantity being sent', gunny.afterSwitch.bagsLbl === 'Bags being sent',
        gunny.afterSwitch.bagsLbl);
  // Hidden, not merely ignored — nothing invisible may still be feeding the
  // total.
  check('the kilo quantity goes', gunny.afterSwitch.qtyFieldShown === false, JSON.stringify(gunny.afterSwitch));
  check('…and both sample fields with it',
        gunny.afterSwitch.sampleQtyShown === false && gunny.afterSwitch.sampleBagsShown === false,
        JSON.stringify(gunny.afterSwitch));
  check('the dialog totals the BAGS, not kilos',
        /194 bags/.test(gunny.totals) && /32,010\.00/.test(gunny.totals), gunny.totals);
  check('one goods line, no SAMPLES row', gunny.lines.length === 1 && gunny.lines[0].desc === 'GUNNY',
        JSON.stringify(gunny.lines));
  check('…under the GUNNY HSN', gunny.lines[0].hsn === '63051040', JSON.stringify(gunny.lines[0]));
  check('…valued bags x per-bag rate', gunny.lines[0].value === 32010, String(gunny.lines[0].value));
  const gh = gunny.html;
  check('the printed form says GUNNY', /GUNNY/.test(gh) && !/CARDAMOM<\/td>/.test(gh));
  check('bags print as a whole count, not a weight', />194</.test(gh) && !/194\.000/.test(gh), 'expected 194');
  check('no SAMPLES row reaches the paper', !/SAMPLES/.test(gh));
  // "194+5" is a cardamom thing: a gunny load has no sample bags.
  check('the Bags line drops the sample suffix', /Bags : 194</.test(gh) && !/194\+5/.test(gh),
        'got: ' + JSON.stringify((gh.match(/Bags : [^<]*/) || [''])[0]));
  // Nothing explaining the CODE may travel with a document handed to a
  // printer and read by the tax office.
  check('no developer comments ship inside the printed form',
        !/<!--/.test(gh), (gh.match(/<!--[^]{0,60}/) || [''])[0]);
  // The cardamom remark declares auction samples; printing it on a gunny
  // challan would be a false statement on a GST document.
  check('the gunny challan carries its OWN remark',
        /Empty gunny returned/.test(gh) && !/Auction Sample Not for Sales/.test(gh), 'gunny remark');
  check('switching back restores the cardamom labels', gunny.backToCardamom === 'Rate (per kg)',
        gunny.backToCardamom);

  console.log('\n[6b] The address block follows the BRANCH');
  const branchAddr = await page.evaluate(async () => {
    const cfg = await j('/api/company-settings/flat');
    return {
      bodi:   leChalanBranchAddress(cfg, 'BODI'),
      cumbum: leChalanBranchAddress(cfg, 'CUMBUM'),
      bodiHead:   leChalanBranchBlock(cfg, 'BODI').heading,
      cumbumHead: leChalanBranchBlock(cfg, 'CUMBUM').heading,
      // A branch name typed into a lot and typed into Settings is the same
      // name twice, not one reference — so the match forgives case and spacing.
      sloppy: leChalanBranchAddress(cfg, '  bodi '),
      unknown: leChalanBranchAddress(cfg, 'NOWHERE'),
      blank:   leChalanBranchAddress(cfg, ''),
    };
  });
  check('each branch resolves to its OWN address',
        /GATE ROAD/.test(branchAddr.bodi) && /MARKET ROAD/.test(branchAddr.cumbum),
        JSON.stringify(branchAddr));
  check('…and to its own heading',
        branchAddr.bodiHead === 'CARDAMOM COLLECTION CENTRE' && branchAddr.cumbumHead === 'CUMBUM CENTRE',
        JSON.stringify(branchAddr));
  check('…matched case- and space-insensitively', branchAddr.sloppy === branchAddr.bodi, branchAddr.sloppy);
  check('a branch with no address of its own falls through to the fallback',
        branchAddr.unknown === '' && branchAddr.blank === '',
        JSON.stringify({ unknown: branchAddr.unknown, blank: branchAddr.blank }));

  console.log('\n[6c] The two address blocks can change places');
  // A consignment runs from the collection centre to the building one day and
  // back the next. Both blocks are already typed, so the operator exchanges
  // them rather than retyping both.
  const swapped = await page.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    const before = { head: v('le-chalan-head'), addr: v('le-chalan-address'),
                     to: v('le-chalan-to'), raddr: v('le-chalan-raddr'),
                     rstate: v('le-chalan-rstate'), rgstin: v('le-chalan-rgstin') };
    leChalanSwapAddresses();
    const after = { head: v('le-chalan-head'), addr: v('le-chalan-address'),
                    to: v('le-chalan-to'), raddr: v('le-chalan-raddr'),
                    rstate: v('le-chalan-rstate'), rgstin: v('le-chalan-rgstin') };
    leChalanSwapAddresses();   // and back
    const again = { head: v('le-chalan-head'), addr: v('le-chalan-address'),
                    to: v('le-chalan-to'), raddr: v('le-chalan-raddr') };
    return { before, after, again };
  });
  check('the heading changes places with the receiver\'s NAME',
        swapped.after.head === swapped.before.to && swapped.after.to === swapped.before.head,
        JSON.stringify({ head: swapped.after.head, to: swapped.after.to }));
  check('…and the two addresses with each other',
        swapped.after.addr === swapped.before.raddr && swapped.after.raddr === swapped.before.addr,
        JSON.stringify({ addr: swapped.after.addr, raddr: swapped.after.raddr }));
  // State/Code/GSTIN label the receiver BOX, not whichever address is in it —
  // moving them would quietly relabel the consignee's GST identity.
  check('the receiver\'s GST identity stays where it is',
        swapped.after.rstate === swapped.before.rstate && swapped.after.rgstin === swapped.before.rgstin,
        JSON.stringify({ rstate: swapped.after.rstate, rgstin: swapped.after.rgstin }));
  check('swapping twice puts everything back',
        JSON.stringify(swapped.again) === JSON.stringify({
          head: swapped.before.head, addr: swapped.before.addr,
          to: swapped.before.to, raddr: swapped.before.raddr }),
        JSON.stringify(swapped.again));

  console.log('\n[7] What the challan prints — the reference form, line for line');
  const doc = await page.evaluate(async () => {
    const cfg = await j('/api/company-settings/flat');
    const o = {
      lots: _le.recentLots, cfg,
      chalanNo: 'DC-7/26-27', date: '2026-10-26', time: '20:20', veh: 'KL69B4797',
      mode: 'By Road', placeOfSupply: 'NIRAPPELKADA', rate: 3000,
      bags: '194', sampleBags: '5',
      heading: leChalanBranchBlock(cfg, 'BODI').heading,
      address: leChalanBranchAddress(cfg, 'BODI'),
      receiver: { name: cfg.chalan_receiver_name, address: cfg.chalan_receiver_address,
                  state: cfg.chalan_receiver_state, code: cfg.chalan_receiver_code,
                  gstin: cfg.chalan_receiver_gstin },
    };
    const lines = leChalanLines(o);
    const total = lines.reduce((t, r) => t + r.value, 0);
    const w = await j('/api/amount-words?n=' + total.toFixed(2));
    o.words = w.words + ' Only';
    return { html: leBuildChalanHtml(o), lines, total, words: o.words };
  });
  const h = doc.html;
  check('it is headed "Form GST Delivery Challan"', /Form GST Delivery Challan/.test(h));
  check('the company name is the masthead', /RNS SPICES/.test(h));
  check('the branch heading leads the block, with its address under it',
        /CARDAMOM COLLECTION CENTRE<br>GATE ROAD<br>BODI-625513/.test(h), h.slice(0, 1400));
  check('the consignment box carries all four of its lines',
        /Mode of Transport/.test(h) && /By Road/.test(h) && /KL69B4797/.test(h)
        && /Date,Time of Supply/.test(h) && /Place of Supply/.test(h), 'consignment box');
  // The form's own date/time shape — stationery, not the install's date_format.
  check('date and time print as the form does', /26-10-2026; 08\.20 PM/.test(h), 'expected 26-10-2026; 08.20 PM');
  check('the serial is labelled as the challan book\'s', /Serial No\. of Challan/.test(h) && /DC-7\/26-27/.test(h));
  check('the Details of Receiver block is complete',
        /Details of Receiver/.test(h) && /RNS BUILDING/.test(h) && /KERALA/.test(h)
        && /32ABFFR1926E1ZK/.test(h), 'receiver block');

  // TWO goods lines, not one per lot: the form states what is MOVING.
  check('the goods are two lines, not one per lot', doc.lines.length === 2,
        JSON.stringify(doc.lines.map(l => l.desc)));
  check('…the net weight first', doc.lines[0].desc === 'CARDAMOM' && doc.lines[0].qty === 800,
        JSON.stringify(doc.lines[0]));
  check('…then the SAMPLES that travel with it', doc.lines[1].desc === 'SAMPLES' && doc.lines[1].qty === 1,
        JSON.stringify(doc.lines[1]));
  check('both carry the canonical HSN, not a challan-only copy of it',
        doc.lines.every(l => l.hsn === '09083120'), JSON.stringify(doc.lines.map(l => l.hsn)));
  check('the header is S.No / Description / HSN+Code / Qty / Rate / Value / Taxable Value',
        /S\.No\./.test(h) && /Description of<br>Goods/.test(h) && />HSN</.test(h)
        && />Code</.test(h) && />Qty</.test(h) && />Rate</.test(h) && />Taxable Value</.test(h), 'header');
  // Indian grouping and three decimals on weight, like the reference.
  check('weights print to three decimals', /800\.000/.test(h) && /1\.000/.test(h), 'qty format');
  check('values print in Indian grouping', /24,00,000\.00/.test(h), '800 x 3000 = 24,00,000.00');
  check('the total line adds both goods lines',
        doc.total === 2403000 && /24,03,000\.00/.test(h), String(doc.total));
  check('…and the qty total too', /801\.000/.test(h), '800 + 1');

  // The words come from the server's amountToWords — the same wording every
  // invoice on this install carries, not a second copy of the rules.
  check('the amount in words is the shared one',
        doc.words === 'Rupees Twenty Four Lakh Three Thousand Only', doc.words);
  check('…and is printed under the table', /Challan Total Value \(In Words\)/.test(h) && h.includes(doc.words));

  check('the Remarks box prints its configured line',
        /Auction Sample Not for Sales, Only for Auction Purpose/.test(h));
  // "194+5" — the goods bags, then the SAMPLE bags riding with them, which
  // the Remarks line declares are not for sale. Two inputs joined at print,
  // not one typed string, so each number can be corrected on its own.
  check('Bags prints the goods count and the sample count together',
        /Bags : 194\+5/.test(h), 'expected 194+5');
  check('it closes with the terms and the signatory',
        /Terms &amp; Condition/.test(h) && /For RNS SPICES/.test(h) && /Authorised Signatory/.test(h));
  // An install with no uploaded logo must print an empty box, not a broken
  // image glyph.
  check('a missing logo removes itself rather than breaking', /onerror="this\.style\.display='none'"/.test(h));

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
  check('…wrapped in prefix and suffix', claimed.a.no === 'DC-1/26-27', claimed.a.no);
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
  check('the prefix is applied to the printed number', prefixed.no === 'DC/3/26-27', JSON.stringify(prefixed));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-15).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
