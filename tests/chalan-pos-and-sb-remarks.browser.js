// Delivery Challan: Place of Supply follows the receiver, and the Spices
// Board legs carry their own Remarks.
//
// Both are facts about WHERE the consignment is going, and both used to be
// install-wide constants:
//   • Place of Supply was seeded once from `chalan_place_of_supply`, so a
//     challan to the Board in Kerala and one to a Tamil Nadu depot printed
//     the same line — and turning the pair round, which swaps who receives,
//     did not change it at all. Under GST the place of supply is the
//     consignee's, so it is re-derived from the receiver every time.
//   • Remarks printed on EVERY cardamom challan. `chalan_remarks` declares
//     the auction samples riding along, which is true of exactly two
//     consignments — the main depot sending samples to the Board, and the
//     Board sending them back. On a depot-to-depot load it was a false
//     statement on a GST document. So it now prints on those two legs only
//     and the Remarks row is absent everywhere else.
//
//   [pos]      Place of Supply is the receiver's state, per branch
//   [swap]     turning the pair round re-points it at the new receiver
//   [typed]    an operator's own wording is never overwritten
//   [to-sb]    main depot → Board prints the configured remark
//   [from-sb]  turned round, the Board → main depot prints it too
//   [plain]    an ordinary depot-to-depot challan prints NO remark at all
//   [mainonly] with no main depot set there is no main-depot↔Board leg to
//              assert, so the row stays blank on the Board challan too
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chalan-pos-'));
const PORT = 47556;
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

// The one existing setting. It prints on the two Spices Board legs and
// nowhere else.
const REMARK = 'Auction Sample Not for Sales, Only for Auction Purpose';

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', {
    settings: {
      flag_delivery_chalan: 'true',
      br1: 'ANAVILASAM', br1_addr: 'DEPOT ROAD, ANAVILASAM',
      business_state: 'TAMILNADU', tn_gstin: '33AAHCE4551A1Z9',
      // The receiver an ordinary branch challan goes to.
      chalan_receiver_name: 'KOCHI WAREHOUSE', chalan_receiver_state: 'KERALA',
      chalan_receiver_code: '32', chalan_receiver_gstin: '32AAHCE4551A1Z8',
      chalan_receiver_address: 'MG ROAD, KOCHI',
      // The install-wide fallback, which must now be overridden by the
      // receiver wherever one has a state.
      chalan_place_of_supply: 'FALLBACK PLACE',
      spices_board_addr_tn: 'BOARD ROAD, BODI', spices_board_gstin_tn: '33SPICE0000B1Z5',
      chalan_remarks: REMARK,
      chalan_next_no: '500',
    },
  });
  const auc = await api('POST', '/api/auctions', {
    ano: '141', date: '2026-10-20', state: 'TAMIL NADU', main_branch: 'ANAVILASAM' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  for (const lot_no of ['001', '002']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'SELLER ' + lot_no, cr: '', qty: 100, bags: 10,
      grade: '1', crop: 'CARDAMOM', branch: 'ANAVILASAM',
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    await api('PUT', `/api/lots/${id}`, { price: 2000, amount: 200000 });
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
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => go('lotentry'));
  await page.waitForFunction(
    () => document.querySelectorAll('#le-auction option').length > 0, { timeout: 12000 });
  await page.evaluate(a => {
    const sel = document.getElementById('le-auction');
    if (sel) { sel.value = String(a); leOnAuctionChange(); }
  }, aid);
  await page.waitForFunction(
    () => (typeof _le !== 'undefined' && _le && Array.isArray(_le.recentLots) && _le.recentLots.length > 0),
    { timeout: 12000 });

  // Open the challan dialog and point it at a branch (or the Board).
  const openChalan = async () => {
    await page.evaluate(() => leOpenChalan());
    await page.waitForFunction(
      () => document.getElementById('le-chalan-modal')?.classList.contains('show')
            && document.querySelectorAll('#le-chalan-branch option').length > 0,
      { timeout: 10000 });
  };
  const pickBranch = async (v) => page.evaluate((val) => {
    const sel = document.getElementById('le-chalan-branch');
    // '__SB_TN__' is the Spices Board pseudo-branch.
    sel.value = val === 'SB' ? LE_SB_TN : val;
    leChalanBranchChanged();
  }, v);
  const pos = () => page.evaluate(() => document.getElementById('le-chalan-pos').value);
  // Render the challan exactly as it prints, and read it back.
  const printed = () => page.evaluate(() => {
    const o = {
      lots: _le_chalan.lots, cfg: _le_chalan.cfg || {},
      // leConfirmChalan passes this, and the Spices Board remark reads the
      // trade's main depot off it — a harness that left it out would report
      // "no Board remark" for the wrong reason.
      auction: _le_chalan.auction || {},
      chalanNo: 'X', date: '2026-10-20', time: '10:00',
      veh: 'TN66H1234', mode: 'By Road',
      placeOfSupply: document.getElementById('le-chalan-pos').value,
      goods: 'cardamom', rate: 10, bags: '10', words: '',
      ...leChalanPartyBlocks(_le_chalan.cfg || {}, document.getElementById('le-chalan-branch').value, _le_chalan.swapped),
    };
    return leBuildChalanHtml(o);
  });

  await openChalan();

  console.log('[pos] Place of Supply is the receiver\'s state');
  {
    await pickBranch('ANAVILASAM');
    check('a branch challan takes the configured receiver\'s state',
      (await pos()) === 'KERALA', await pos());
    check('…not the install-wide fallback', (await pos()) !== 'FALLBACK PLACE', await pos());
    await pickBranch('SB');
    check('a Spices Board (TN) challan says TAMIL NADU',
      (await pos()) === 'TAMIL NADU', await pos());
    const html = await printed();
    check('…and that is what prints on the form',
      /Place of Supply[^<]*<\/span><span>:\s*TAMIL NADU/.test(html.replace(/\s+/g, ' ')),
      (html.match(/Place of Supply.{0,80}/) || [''])[0]);
  }

  console.log('[swap] turning the pair round re-points it');
  {
    // Board → us: the receiver is now this firm, in Tamil Nadu. Pick a
    // receiver state that differs so the assertion means something.
    await pickBranch('ANAVILASAM');
    check('pointing out, the receiver is in Kerala', (await pos()) === 'KERALA', await pos());
    await page.evaluate(() => leChalanToggleSwap());
    check('turned round, the receiver is this firm — Tamil Nadu',
      (await pos()) === 'TAMIL NADU', await pos());
    await page.evaluate(() => leChalanToggleSwap());
    check('and back again', (await pos()) === 'KERALA', await pos());
  }

  console.log('[typed] the operator\'s own wording is kept');
  {
    await page.evaluate(() => { document.getElementById('le-chalan-pos').value = 'HAND TYPED PLACE'; });
    await pickBranch('SB');
    check('a typed place survives a branch change',
      (await pos()) === 'HAND TYPED PLACE', await pos());
    // Clearing it hands control back to the receiver.
    await page.evaluate(() => { document.getElementById('le-chalan-pos').value = ''; });
    await pickBranch('ANAVILASAM');
    check('clearing it lets the receiver drive again', (await pos()) === 'KERALA', await pos());
  }

  console.log('[to-sb] main depot → Board prints the configured remark');
  {
    await pickBranch('SB');
    const html = await printed();
    check('the configured remark prints', html.includes(REMARK), 'remark missing on the Board leg');
    check('…under a Remarks heading', /Remarks/i.test(html), 'no Remarks row at all');
  }

  console.log('[from-sb] turned round, it prints too');
  {
    await page.evaluate(() => leChalanToggleSwap());
    const html = await printed();
    check('the Board → main depot leg carries it as well',
      html.includes(REMARK), 'remark missing on the return leg');
    await page.evaluate(() => leChalanToggleSwap());
  }

  console.log('[plain] a depot-to-depot challan prints NO remark');
  {
    await pickBranch('ANAVILASAM');
    const html = await printed();
    check('the remark does NOT print on an ordinary branch challan',
      !html.includes(REMARK),
      'the auction-sample line printed on a load carrying no samples');
    check('…and no empty Remarks row is left behind',
      !/>\s*Remarks\s*</i.test(html), 'an empty Remarks row was rendered');
  }

  console.log('[mainonly] no main depot ⇒ no Board remark');
  {
    // Strip the trade's main depot and reopen. The Board is still the
    // counterparty, but our end can no longer be named as the main branch,
    // so the rule's precondition fails and the per-goods line stands.
    await api('PUT', `/api/auctions/${aid}`, { main_branch: '' });
    await page.evaluate(() => hideModal('le-chalan-modal'));
    await openChalan();
    await pickBranch('SB');
    const html = await printed();
    check('the remark does NOT print without a main depot',
      !html.includes(REMARK), 'remark printed with no main depot set');
    await page.evaluate(() => leChalanToggleSwap());
    const back = await printed();
    check('…nor on the return leg',
      !back.includes(REMARK), 'remark printed on the return leg with no main depot set');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
