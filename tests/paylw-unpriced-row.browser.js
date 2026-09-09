// Payments — Lot-wise: a lot that has been ENTERED but not priced yet, driven
// through the real screen in a headless Chrome.
//
// The advance goes to the seller right after lot entry, so these rows have to
// be on the screen — but they carry no payable, so everything that MOVES the
// payable has to stay locked on them: the export checkbox, select-all, mark
// paid. Only Pay Advance is live, and there the amount box has no ceiling to
// exceed because there is no payable to measure it against. Once the price
// lands under the advance, the excess has to show up as something to recover.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-unpriced-ui-'));
const PORT = 47362;
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

  const auc = await api('POST', '/api/auctions', { ano: '41', date: '2026-09-09', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  const t = await api('POST', '/api/traders', {
    name: 'ANNAMALAI', cr: '', padd: 'ADDR', ppla: 'PLACE',
    banks: [{ acctnum: '1000012345', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'ANNAMALAI', account_type: 'Savings', is_default: 1 }],
  });
  const traderId = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
  const lotIds = {};
  for (const lot_no of ['1', '2']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'ANNAMALAI', cr: '', qty: 100, grade: '2', bags: 10,
      crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: traderId,
    });
    lotIds[lot_no] = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
  }
  // Lot 1 stays as entered — no code, no price. Lot 2 is priced and payable.
  await api('PUT', `/api/lots/${lotIds['2']}`, { price: 100, amount: 10000, balance: 9800 });

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
  page.on('dialog', d => d.accept().catch(() => {}));
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
  // Columns: 0 ☑ · 1 Seller · 2 Lot · 3 Qty · 4 Branch · 5 Bank · 6 Advance · 7 Payable.
  const resultRows = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body tbody tr')).map(tr => ({
      lot:       (tr.children[2]?.textContent || '').trim(),
      advance:   (tr.children[6]?.textContent || '').trim(),
      payable:   (tr.children[7]?.textContent || '').trim().replace(/\s+/g, ' '),
      cbLocked:  !!tr.querySelector('td input[type=checkbox]')?.disabled,
      unpriced:  !!tr.querySelector('.paylw-unpriced-badge'),
      advBadge:  !!tr.querySelector('.paylw-adv-badge'),
      overBadge: (tr.querySelector('.paylw-over-badge')?.textContent || '').trim(),
    })));

  console.log('[1] The unpriced lot is on the screen, but locked out of the export');
  await search();
  let rows = await resultRows();
  const r1 = rows.find(r => r.lot === '1'), r2 = rows.find(r => r.lot === '2');
  check('both lots are listed', rows.length === 2 && r1 && r2, JSON.stringify(rows));
  check('the unpriced lot carries the ⏳ badge', r1.unpriced, JSON.stringify(r1));
  check('the priced lot does not', !r2.unpriced, JSON.stringify(r2));
  check('its Payable says "awaiting price", not 0.00', /awaiting price/i.test(r1.payable), JSON.stringify(r1.payable));
  check('its checkbox is disabled', r1.cbLocked, JSON.stringify(r1.cbLocked));
  check("the priced lot's checkbox is live", !r2.cbLocked, JSON.stringify(r2.cbLocked));
  check('the summary explains the lot with no price',
        /no price yet/i.test(await page.evaluate(() => document.getElementById('paylw-summary')?.textContent || '')),
        await page.evaluate(() => (document.getElementById('paylw-summary')?.textContent || '').slice(0, 400)));

  console.log('\n[2] Select-all takes only what can actually be paid');
  await page.evaluate(() => payLwTickAll(true));
  check('one lot selected, not two',
        (await page.evaluate(() => _payLwState.selected.size)) === 1,
        JSON.stringify(await page.evaluate(() => [..._payLwState.selected])));
  check('the export button counts one',
        /\(1\)/.test(await page.evaluate(() => document.getElementById('paylw-export-btn')?.textContent || '')),
        await page.evaluate(() => document.getElementById('paylw-export-btn')?.textContent));
  check('the selection line calls it 1 of 1 payable',
        /1 of 1 payable/.test(await page.evaluate(() => document.getElementById('paylw-selinfo')?.textContent || '')),
        await page.evaluate(() => document.getElementById('paylw-selinfo')?.textContent));
  await page.evaluate(() => payLwTickAll(false));

  console.log('\n[3] Pay Advance is live, and its amount box has no ceiling');
  check('the Pay Advance button is enabled',
        !(await page.evaluate(() => document.getElementById('paylw-adv-btn')?.disabled)));
  await page.evaluate(() => payLwOpenAdvance());
  await page.waitForFunction(
    () => document.getElementById('paylw-adv-modal')?.classList.contains('show')
          && document.querySelectorAll('#paylw-adv-body tbody tr').length > 0,
    { timeout: 8000 });
  const advRows = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-adv-body tbody tr')).map(tr => ({
      lot:     (tr.children[2]?.textContent || '').trim(),
      payable: (tr.children[3]?.textContent || '').trim(),
      max:     tr.querySelector('.paylw-adv-amt')?.getAttribute('max'),
    })));
  let m = await advRows();
  const m1 = m.find(r => r.lot === '1'), m2 = m.find(r => r.lot === '2');
  check('the unpriced lot is offered in the dialog', !!m1, JSON.stringify(m));
  check('its Payable column says "not priced yet"', /not priced yet/i.test(m1.payable), JSON.stringify(m1.payable));
  check('its amount box carries no max', m1.max === null, JSON.stringify(m1.max));
  check("the priced lot's box is still capped at its payable", m2.max === '9800', JSON.stringify(m2.max));

  console.log('\n[4] A large advance on the unpriced lot is accepted, not flagged over');
  await page.evaluate(() => {
    document.querySelectorAll('#paylw-adv-body tbody tr').forEach(tr => {
      const lot = (tr.children[2]?.textContent || '').trim();
      const cb = tr.querySelector('.paylw-adv-cb');
      if (cb) cb.checked = (lot === '1');
      if (lot === '1') tr.querySelector('.paylw-adv-amt').value = '25000';
    });
    payLwAdvSync();
  });
  check('the box is not marked over-payable',
        !(await page.evaluate(() => document.querySelector('#paylw-adv-body tbody tr .paylw-adv-amt')?.classList.contains('over'))));
  check('the Pay button is armed',
        !(await page.evaluate(() => document.getElementById('paylw-adv-save')?.disabled)),
        await page.evaluate(() => document.getElementById('paylw-adv-total')?.textContent));
  await page.evaluate(() => payLwSaveAdvance());
  await page.waitForFunction(
    () => document.getElementById('paylw-adv-save')?.disabled
          && document.querySelector('#paylw-body tbody tr'),
    { timeout: 10000 });
  await page.evaluate(() => hideModal('paylw-adv-modal'));
  rows = await resultRows();
  const a1 = rows.find(r => r.lot === '1');
  check('the row now shows the 25,000 advance', /25,?000/.test(a1.advance), JSON.stringify(a1.advance));
  check('it keeps the advance badge', a1.advBadge, JSON.stringify(a1));
  check('its Payable still says awaiting price', /awaiting price/i.test(a1.payable), JSON.stringify(a1.payable));
  check('it is still locked out of the export', a1.cbLocked);
  check('nothing is called over-advanced while there is no price', !a1.overBadge, JSON.stringify(a1.overBadge));

  console.log('\n[5] The price lands UNDER the advance — the excess is on the row');
  await api('PUT', `/api/lots/${lotIds['1']}`, { price: 100, amount: 10000, balance: 9800 });
  await search();
  rows = await resultRows();
  const o1 = rows.find(r => r.lot === '1');
  check('the ⏳ badge is gone', !o1.unpriced, JSON.stringify(o1));
  check('the row is selectable now', !o1.cbLocked, JSON.stringify(o1.cbLocked));
  check('and it reports the 15,200 over-advance', /15,?200/.test(o1.overBadge), JSON.stringify(o1.overBadge));
  check('the summary names the money to recover',
        /over-advanced/i.test(await page.evaluate(() => document.getElementById('paylw-summary')?.textContent || '')),
        await page.evaluate(() => (document.getElementById('paylw-summary')?.textContent || '').slice(0, 400)));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(srvLog.slice(-2000));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); cleanup(); process.exit(1); });
