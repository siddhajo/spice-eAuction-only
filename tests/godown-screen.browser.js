// The Godown screen — stock in store, advances against it, releases into a
// trade. Headless Chrome, driving the real screen.
//
// The screen exists because those three are one job: the person looking at
// what a planter has in store is the one paying an advance on it and booking
// part of it into Friday's auction. What this pins down:
//
//   • it is REACHABLE — a .side-item alone leaves a screen off the nav strip,
//     so the NAV_GROUPS entry is asserted, not assumed;
//   • every figure on a row is the BALANCE, with received and moved beside it;
//   • the advance modal writes through the same money path as Payments;
//   • the move modal proposes the proportional advance share, lets the
//     operator overrule it, and refuses to release more than is in store.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'godown-scr-'));
const PORT = 47391;
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
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', flag_godown: 'true', flag_lotwise_payments: 'true', sample_weight: '0.5',
  }});
  await api('POST', '/api/auctions', { ano: '1', date: '2026-10-12', crop_type: 'ISP' });
  await api('POST', '/api/auctions/1/allocations', { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  await api('POST', '/api/auctions', { ano: '2', date: '2026-10-19', crop_type: 'ISP' });
  await api('POST', '/api/auctions/2/allocations', { allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '020' }] });
  await api('POST', '/api/traders', { name: 'RAVI PLANTER', tel: '9790744444', ppla: 'BODIMETTU' });
  await api('POST', '/api/traders/1/banks', { bank_name: 'SBI', acctnum: '123456789012', ifsc: 'SBIN0001234', holder_name: 'RAVI PLANTER', is_default: 1 });
  await api('POST', '/api/lots', { auction_id: 1, trader_id: 1, branch: 'BODI', grade: '1',
    bags: 18, litre: '300', qty: 180.5, sample_wt: 0, gross_wt: 180.5, godown: 1 });

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
  await page.setViewport({ width: 1500, height: 1000 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });

  console.log('[1] The screen is reachable from the nav, not just present');
  const nav = await page.evaluate(() => {
    const src = document.querySelector('#nav-src .side-item[data-tab="godown"]');
    // #nav-src is hidden, so a test that only asserts on it passes even when
    // the screen never reaches the strip — the NAV_GROUPS entry is the thing.
    const inModel = NAV_GROUPS.some(g => (g.items || []).some(i => i.tab === 'godown'));
    return { src: !!src, srcShown: !!src && getComputedStyle(src).display !== 'none', inModel };
  });
  check('it has a nav source entry', nav.src === true);
  check('…which is visible with the feature on', nav.srcShown === true);
  check('…and an entry in the NAV_GROUPS model', nav.inModel === true);

  await page.evaluate(() => go('godown'));
  await page.waitForFunction(() => document.getElementById('tc-godown')?.classList.contains('active'), { timeout: 15000 });
  await page.waitForFunction(() => typeof _gd !== 'undefined' && _gd.rows && _gd.rows.length > 0, { timeout: 15000 });

  console.log('\n[2] A row reads as a balance, with its history beside it');
  const row = await page.evaluate(() => {
    const r = _gd.rows[0];
    return { lot: r.lot_no, qty: r.qty, bags: r.bags, recv: r.received_qty, moved: r.moved_qty,
             adv: r.advance, text: document.getElementById('gd-list').innerText };
  });
  check('the godown entry is listed', row.lot === 'G001', JSON.stringify(row));
  check('balance and received agree before anything moves',
        row.qty === 180.5 && row.recv === 180.5 && row.moved === 0, JSON.stringify(row));
  check('the table names the three figures', /RECD WT/.test(row.text) && /MOVED WT/.test(row.text) && /BALANCE/.test(row.text),
        row.text.slice(0, 120));

  console.log('\n[3] Paying an advance from this screen');
  await page.evaluate(() => gdOpenAdvance(_gd.rows[0].id));
  await page.waitForFunction(() => document.getElementById('gd-adv-modal').classList.contains('show'), { timeout: 10000 });
  const advModal = await page.evaluate(() => ({
    who: document.getElementById('gd-adv-who').innerText,
    banks: [...document.getElementById('gd-adv-bank').options].length,
  }));
  check('the modal names the seller and what is in store', /RAVI PLANTER/.test(advModal.who) && /180\.500/.test(advModal.who), advModal.who);
  check('…and offers the seller\'s own accounts', advModal.banks >= 2, String(advModal.banks));
  await page.evaluate(() => { document.getElementById('gd-adv-amount').value = '50000'; });
  await page.evaluate(() => gdSaveAdvance());
  await page.waitForFunction(() => !document.getElementById('gd-adv-modal').classList.contains('show'), { timeout: 10000 });
  let advOk = true;
  try { await page.waitForFunction(() => (_gd.rows[0] || {}).advance === 50000, { timeout: 10000 }); }
  catch (_) { advOk = false; }
  check('the advance is recorded and reflected on the row', advOk,
        'advance: ' + JSON.stringify(await page.evaluate(() => _gd.rows[0] && _gd.rows[0].advance)));

  console.log('\n[4] The move modal proposes the proportional share');
  await page.evaluate(() => gdOpenMove(_gd.rows[0].id));
  await page.waitForFunction(() => document.getElementById('gd-move-modal').classList.contains('show'), { timeout: 10000 });
  await new Promise(r => setTimeout(r, 800));   // the lot-number suggestion is a fetch
  const opened = await page.evaluate(() => ({
    lotno: document.getElementById('gd-move-lotno').value,
    branch: document.getElementById('gd-move-branch').value,
    bags: document.getElementById('gd-move-bags').value,
    qty: document.getElementById('gd-move-qty').value,
    recover: document.getElementById('gd-move-recover').value,
    trades: [...document.getElementById('gd-move-auction').options].length,
  }));
  check('it opens on the whole balance', String(opened.qty) === '180.5' && String(opened.bags) === '18', JSON.stringify(opened));
  check('with a free lot number suggested', /^\d+$/.test(opened.lotno), JSON.stringify(opened.lotno));
  check('the depot defaults to where the stock is', opened.branch === 'BODI', opened.branch);
  check('and every trade is offered as a destination', opened.trades === 2, String(opened.trades));

  const share = await page.evaluate(() => {
    document.getElementById('gd-move-bags').value = '10';
    document.getElementById('gd-move-qty').value = '100';
    gdMoveOnQtyInput();
    return { recover: document.getElementById('gd-move-recover').value,
             left: document.getElementById('gd-move-left').innerText };
  });
  // 50,000 × 100/180.5 = 27,700.83
  check('releasing 100 of 180.5 kg proposes its share of the advance',
        Math.abs(Number(share.recover) - 27700.83) < 0.02, share.recover);
  check('…and says what will be left in store', /80\.500/.test(share.left), share.left);

  const over = await page.evaluate(() => {
    document.getElementById('gd-move-qty').value = '999';
    gdMoveOnQtyInput();
    const t = document.getElementById('gd-move-left').innerText;
    document.getElementById('gd-move-qty').value = '100';
    gdMoveOnQtyInput();
    return t;
  });
  check('asking for more than is in store is called out before saving', /More than is in store/.test(over), over);

  console.log('\n[5] Moving releases the stock and keeps the books straight');
  await page.evaluate(() => {
    // Into the OTHER trade — stock stored in one trade routinely sells in a later one.
    const sel = document.getElementById('gd-move-auction');
    const other = [...sel.options].find(o => /#2/.test(o.text));
    if (other) sel.value = other.value;
  });
  await page.evaluate(() => gdMoveSuggestLot());
  await new Promise(r => setTimeout(r, 700));
  await page.evaluate(() => gdDoMove());
  let moveOk = true;
  try { await page.waitForFunction(() => !document.getElementById('gd-move-modal').classList.contains('show'), { timeout: 15000 }); }
  catch (_) { moveOk = false; }
  check('the move completes', moveOk,
        await page.evaluate(() => document.getElementById('gd-move-err').innerText));
  await new Promise(r => setTimeout(r, 1200));
  const after = await page.evaluate(() => {
    const r = _gd.rows[0] || {};
    return { qty: r.qty, bags: r.bags, recv: r.received_qty, moved: r.moved_qty, adv: r.advance,
             moves: r.move_count };
  });
  check('the balance drops by what was released', after.qty === 80.5 && after.bags === 8, JSON.stringify(after));
  check('received still reports what was handed in', after.recv === 180.5, JSON.stringify(after));
  check('the move is counted', after.moved === 100 && after.moves === 1, JSON.stringify(after));
  check('and the advance left behind is the rest of it',
        Math.abs(after.adv - 22299.17) < 0.02, String(after.adv));

  // Every total has to land under the figure it totals. The footer is a
  // SEPARATE grid from the header, so a stray cell shifts the whole row and
  // the received total reads as moved — which is exactly what happened when
  // the Trade column was removed and its spacer was left behind.
  const foot = await page.evaluate(() => {
    const grids = [...document.querySelectorAll('#gd-list > div > div')];
    const head = grids[0], tot = grids[grids.length - 1];
    const txt = (el) => [...el.children].map(c => c.textContent.trim());
    const h = txt(head), f = txt(tot);
    const at = (label) => {
      const i = h.findIndex(x => new RegExp(label, 'i').test(x));
      return i < 0 ? null : f[i];
    };
    return { cells: f.length, heads: h.length,
             recd: at('Recd'), moved: at('Moved'), bal: at('Balance') };
  });
  check('the totals row has one cell per column', foot.cells === foot.heads, JSON.stringify(foot));
  check('the Recd Wt total is under Recd Wt', /180\.500/.test(foot.recd || ''), JSON.stringify(foot));
  check('…and the Moved Wt total is under Moved Wt', /100\.000/.test(foot.moved || ''), JSON.stringify(foot));
  check('…and the Balance total under Balance', /80\.500/.test(foot.bal || ''), JSON.stringify(foot));

  console.log('\n[6] An emptied entry leaves the in-store list');
  await page.evaluate(() => gdOpenMove(_gd.rows[0].id));
  await page.waitForFunction(() => document.getElementById('gd-move-modal').classList.contains('show'), { timeout: 10000 });
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => { gdMoveAll(); });
  await page.evaluate(() => gdDoMove());
  await new Promise(r => setTimeout(r, 2000));
  const emptied = await page.evaluate(() => ({
    rows: _gd.rows.length,
    body: document.getElementById('gd-list').innerText.slice(0, 120),
  }));
  check('the emptied entry is gone from the default view', emptied.rows === 0, JSON.stringify(emptied));
  const closedView = await page.evaluate(async () => {
    document.getElementById('gd-show-closed').checked = true;
    await loadGodown();
    const r = _gd.rows[0] || {};
    return { rows: _gd.rows.length, lot: r.lot_no, qty: r.qty, closed: r.closed,
             text: document.getElementById('gd-list').innerText };
  });
  check('…but "Show emptied entries" finds it', closedView.rows === 1 && closedView.lot === 'G001', JSON.stringify(closedView.rows));
  check('…badged as emptied, at zero', closedView.qty === 0 && closedView.closed === true && /EMPTIED/.test(closedView.text),
        JSON.stringify({ qty: closedView.qty, closed: closedView.closed }));

  console.log('\n[7] Deleting selected entries');
  // Back to a populated screen: two entries, one of them already emptied.
  await api('POST', '/api/lots', { auction_id: 1, trader_id: 1, branch: 'BODI', grade: '1',
    bags: 5, litre: '300', qty: 50, sample_wt: 0, gross_wt: 50, godown: 1 });
  await page.evaluate(async () => { document.getElementById('gd-show-closed').checked = true; await loadGodown(); });
  await page.waitForFunction(() => _gd.rows.length === 2, { timeout: 10000 });
  const selState0 = await page.evaluate(() => ({
    btn: document.getElementById('gd-del-btn').textContent.trim(),
    disabled: document.getElementById('gd-del-btn').disabled,
    boxes: document.querySelectorAll('#gd-list .gd-cb').length,
  }));
  check('every row offers a checkbox', selState0.boxes === 2, JSON.stringify(selState0));
  check('and Delete is dead until something is ticked', selState0.disabled === true, JSON.stringify(selState0));

  const selState1 = await page.evaluate(() => {
    gdToggle(_gd.rows[0].id, true);
    return { btn: document.getElementById('gd-del-btn').textContent.trim(),
             disabled: document.getElementById('gd-del-btn').disabled };
  });
  check('ticking one arms it and counts it', /\(1\)/.test(selState1.btn) && selState1.disabled === false,
        JSON.stringify(selState1));
  const selAll = await page.evaluate(() => {
    gdToggleAll(true);
    return { btn: document.getElementById('gd-del-btn').textContent.trim(),
             master: document.getElementById('gd-tick-all').checked };
  });
  check('select-all takes every listed row', /\(2\)/.test(selAll.btn) && selAll.master === true, JSON.stringify(selAll));

  // A search that hides a ticked row must not leave it armed — the count would
  // then name rows the operator cannot see.
  const pruned = await page.evaluate(() => {
    document.getElementById('gd-search').value = 'ZZZ-no-such-seller';
    gdRender();
    return { btn: document.getElementById('gd-del-btn').textContent.trim(), sel: _gd.selected.size };
  });
  check('hiding rows with the search disarms them', pruned.sel === 0 && !/\(/.test(pruned.btn),
        JSON.stringify(pruned));
  await page.evaluate(() => { document.getElementById('gd-search').value = ''; gdRender(); });

  // The confirm is the gate; accept it and check what actually happened.
  page.on('dialog', d => d.accept().catch(() => {}));
  const afterDel = await page.evaluate(async () => {
    const victim = _gd.rows.find(r => !r.closed) || _gd.rows[0];
    const id = victim.id, lot = victim.lot_no;
    _gd.selected = new Set([id]);
    await gdDeleteSelected();
    return { gone: !_gd.rows.some(r => r.id === id), left: _gd.rows.length, lot };
  });
  check('the ticked entry is deleted', afterDel.gone === true, JSON.stringify(afterDel));
  check('…and the others are left alone', afterDel.left === 1, JSON.stringify(afterDel));

  console.log('\n[8] Flag OFF takes the screen away');
  await api('PUT', '/api/company-settings', { settings: { flag_godown: 'false' } });
  const off = await page.evaluate(async () => {
    await applyFeatureFlags();
    const src = document.querySelector('#nav-src .side-item[data-tab="godown"]');
    return { srcShown: !!src && getComputedStyle(src).display !== 'none' };
  });
  check('the nav entry disappears with the feature', off.srcShown === false, JSON.stringify(off));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
