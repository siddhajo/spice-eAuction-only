// Payments — Lot-wise: bulk "↩ Undo selected" for already-paid lots, driven
// through the REAL screen in a headless Chrome.
//
// Paid lots are locked out of the export selection, so undoing them needs its
// own selection: paid rows carry a second checkbox feeding _payLwState
// .selectedPaid, and the toolbar button clears the paid stamp on all of them
// in one call. The invariant that matters is that the two selections never
// mix — a paid lot must not be able to reach an export, and the header
// "select all" must not arm an undo.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-undo-'));
const PORT = 47341;
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

  const auc = await api('POST', '/api/auctions', { ano: '21', date: '2026-08-18', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  // Four lots across two sellers, all with accounts so all are payable.
  const seed = [
    ['010', 'ANNAMALAI', 100, 3000],
    ['020', 'ANNAMALAI', 150, 3000],
    ['030', 'BALAN',     120, 3000],
    ['040', 'BALAN',     110, 3000],
  ];
  const traderIds = {}, lotIds = {};
  for (const [lot_no, name, qty, price] of seed) {
    if (!traderIds[name]) {
      const t = await api('POST', '/api/traders', {
        name, cr: '', padd: 'ADDR', ppla: 'PLACE',
        banks: [{ acctnum: '10000' + (Object.keys(traderIds).length + 1), ifsc: 'HDFC0001234',
                  bank_name: 'HDFC', holder_name: name, account_type: 'Savings', is_default: 1 }],
      });
      traderIds[name] = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
      if (!traderIds[name]) { console.error('trader create failed', t.status, t.d); cleanup(); process.exit(1); }
    }
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, cr: '', qty, grade: '2', bags: 10,
      crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: traderIds[name],
    });
    const lotId = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    if (!lotId) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    lotIds[lot_no] = lotId;
    await api('PUT', `/api/lots/${lotId}`, { price, amount: qty * price });
  }
  await api('POST', `/api/lots/calculate/${aid}`, {});

  // Three of the four are already paid — the state after an export that has to
  // be redone. 040 stays unpaid so the two selections can be told apart.
  const mk = await api('POST', `/api/payments/lots/${aid}/mark-paid`,
    { lotIds: [lotIds['010'], lotIds['020'], lotIds['030']] });
  check('fixture: three lots marked paid', mk.d && mk.d.marked === 3, JSON.stringify(mk.d));

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
  // The undo confirm() must be answered; default to accepting, flipped per test.
  let acceptDialogs = true;
  page.on('dialog', async d => { try { acceptDialogs ? await d.accept() : await d.dismiss(); } catch (_) {} });

  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => { localStorage.setItem('t', t); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });

  await page.evaluate(aid => {
    if (typeof showTab === 'function') showTab('payments');
    const sel = document.getElementById('paylw-auction');
    if (sel) sel.value = String(aid);
  }, aid);
  await page.evaluate(() => loadPayLotwise && loadPayLotwise());
  await page.evaluate(aid => {
    const sel = document.getElementById('paylw-auction');
    if (sel) { sel.value = String(aid); payLwOnAuctionChange(); }
  }, aid);

  const search = async (link) => {
    await page.evaluate(l => { const s = document.getElementById('paylw-link'); if (s) s.value = l; }, link);
    await page.evaluate(() => payLwSearch());
    await page.waitForFunction(() => {
      const b = document.getElementById('paylw-body');
      return b && (b.querySelector('table') || /No lots matched|No unlinked/.test(b.textContent));
    }, { timeout: 8000 });
  };
  const undoBtn = () => page.evaluate(() => {
    const b = document.getElementById('paylw-undosel-btn');
    return b ? { shown: b.style.display !== 'none', disabled: !!b.disabled, text: b.textContent.trim() } : null;
  });
  const state = () => page.evaluate(() => ({
    selected: [..._payLwState.selected].length,
    selectedPaid: [..._payLwState.selectedPaid].length,
  }));
  const paidBoxes = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#paylw-body .paylw-cb-paid')).map(cb => cb.dataset.id));
  const tickPaid = (lotNo) => page.evaluate(n => {
    const tr = Array.from(document.querySelectorAll('#paylw-body tbody tr'))
      .find(r => (r.children[2]?.textContent || '').trim() === n);
    const cb = tr && tr.querySelector('.paylw-cb-paid');
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    return !!cb;
  }, lotNo);

  console.log('\n[1] Paid rows are tickable for an admin; unpaid rows are not affected');
  await search('all');
  const boxes = await paidBoxes();
  check('a checkbox on each of the three paid rows', boxes.length === 3, JSON.stringify(boxes));
  const st0 = await state();
  check('the export selection holds only the one unpaid lot', st0.selected === 1, JSON.stringify(st0));
  check('no undo ticks are pre-armed', st0.selectedPaid === 0, JSON.stringify(st0));

  console.log('\n[2] The button appears only when there is something to undo');
  let b0 = await undoBtn();
  check('button is rendered and visible (paid lots are listed)', b0 && b0.shown, JSON.stringify(b0));
  check('but disabled until a paid lot is ticked', b0 && b0.disabled, JSON.stringify(b0));

  console.log('\n[3] Ticking paid rows arms the button without touching the export set');
  check('lot 010 ticked', await tickPaid('010'));
  check('lot 020 ticked', await tickPaid('020'));
  const st1 = await state();
  check('two undo ticks held', st1.selectedPaid === 2, JSON.stringify(st1));
  check('the export selection is unchanged', st1.selected === 1, JSON.stringify(st1));
  const b1 = await undoBtn();
  check('button enabled and counting', b1 && !b1.disabled && /\(2\)/.test(b1.text), JSON.stringify(b1));

  console.log('\n[4] "Select all" governs the export only — it never arms an undo');
  await page.evaluate(() => payLwTickAll(true));
  const st2 = await state();
  check('every unpaid lot selected', st2.selected === 1, JSON.stringify(st2));
  check('undo ticks untouched by the header box', st2.selectedPaid === 2, JSON.stringify(st2));

  console.log('\n[5] Cancelling the confirm changes nothing');
  acceptDialogs = false;
  await page.evaluate(() => payLwUndoSelected());
  await new Promise(r => setTimeout(r, 400));
  const stillPaid = await api('GET', `/api/payments/lots/${aid}?link=all`);
  const paidCount = (stillPaid.d.lots || []).filter(l => l.paid_at).length;
  check('all three lots are still paid', paidCount === 3, `paid=${paidCount}`);
  acceptDialogs = true;

  console.log('\n[6] Confirming undoes exactly the ticked lots');
  await page.evaluate(() => payLwUndoSelected());
  await page.waitForFunction(() => document.querySelectorAll('#paylw-body .paylw-cb-paid').length === 1,
    { timeout: 8000 }).catch(() => {});
  const after = await api('GET', `/api/payments/lots/${aid}?link=all`);
  const paidNow = (after.d.lots || []).filter(l => l.paid_at).map(l => l.lot_no).sort();
  check('only lot 030 is still paid', paidNow.join() === '030', JSON.stringify(paidNow));
  const st3 = await state();
  check('undo ticks cleared after the run', st3.selectedPaid === 0, JSON.stringify(st3));

  console.log('\n[7] The undone lots are payable again');
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#paylw-body tbody tr'))
    .map(tr => ({ lot: (tr.children[2]?.textContent || '').trim(), paid: tr.className.includes('paylw-row-paid') })));
  const undone = rows.filter(r => ['010', '020'].includes(r.lot));
  check('their rows no longer render as paid', undone.length === 2 && undone.every(r => !r.paid),
        JSON.stringify(rows));
  check('and they carry a live export checkbox again',
        await page.evaluate(() => Array.from(document.querySelectorAll('#paylw-body tbody tr'))
          .filter(tr => ['010', '020'].includes((tr.children[2]?.textContent || '').trim()))
          .every(tr => !!tr.querySelector('.paylw-cb'))));

  console.log('\n[8] Clear selection wipes undo ticks too');
  check('lot 030 ticked', await tickPaid('030'));
  check('armed', (await state()).selectedPaid === 1);
  await page.evaluate(() => payLwClearSelection());
  const st4 = await state();
  check('both selections cleared', st4.selected === 0 && st4.selectedPaid === 0, JSON.stringify(st4));
  const b4 = await undoBtn();
  check('button disabled again', b4 && b4.disabled, JSON.stringify(b4));

  console.log('\n[9] "Tick all paid" is the paid column\'s select-all');
  // Without it, undoing a big export means clicking every paid row by hand —
  // the header box can't help, it owns the export selection.
  await search('all');
  const tickAllBtn = () => page.evaluate(() => {
    const b = document.getElementById('paylw-tickallpaid-btn');
    return b ? { shown: b.style.display !== 'none', text: b.textContent.trim() } : null;
  });
  let tb0 = await tickAllBtn();
  // Only lot 030 is still paid here — [6] undid 010 and 020.
  check('button is shown and counts the paid lots',
        tb0 && tb0.shown && /1 paid/.test(tb0.text), JSON.stringify(tb0));
  const before = await state();
  await page.evaluate(() => payLwTickAllPaid());
  const afterTick = await state();
  check('every paid lot is now ticked', afterTick.selectedPaid === 1, JSON.stringify(afterTick));
  check('the export selection is unchanged by it',
        afterTick.selected === before.selected,
        `${before.selected} → ${afterTick.selected}`);
  check('it flips to untick', /Untick/.test((await tickAllBtn()).text), JSON.stringify(await tickAllBtn()));
  await page.evaluate(() => payLwTickAllPaid());
  check('pressing again clears them', (await state()).selectedPaid === 0, JSON.stringify(await state()));

  console.log('\n[10] Header box when every listed lot is already paid → select all for undo');
  // The original regression: it ticked, found no unpaid lot to select, and
  // un-ticked itself — clicking did nothing at all. In an all-paid result set
  // the only live boxes are the undo ones, so the header now ticks those:
  // "select all, then undo" works the way it reads.
  const mkAll = await api('POST', `/api/payments/lots/${aid}/mark-paid`,
    { lotIds: Object.values(lotIds) });
  check('fixture: the rest of the trade is paid too', mkAll.status === 200, JSON.stringify(mkAll.d));
  await search('all');
  const hdr = () => page.evaluate(() => {
    const a = document.getElementById('paylw-cb-all');
    return a ? { checked: a.checked, indet: a.indeterminate, disabled: a.disabled, title: a.title } : null;
  });
  const h0 = await hdr();
  check('nothing is selectable for export', (await state()).selected === 0, JSON.stringify(await state()));
  check('the header box is live, not inert', h0 && !h0.disabled, JSON.stringify(h0));
  check('and says it now picks paid lots', h0 && /paid lot/.test(h0.title), JSON.stringify(h0));
  await page.evaluate(() => { const a = document.getElementById('paylw-cb-all'); if (a) a.click(); });
  const h1 = await hdr();
  check('clicking it checks and stays checked', h1 && h1.checked && !h1.indet, JSON.stringify(h1));
  check('every paid lot is armed for undo', (await state()).selectedPaid === 4, JSON.stringify(await state()));
  check('it did NOT put anything into the export selection',
        (await state()).selected === 0, JSON.stringify(await state()));
  const b7 = await undoBtn();
  check('Undo selected is armed straight from the header box',
        b7 && !b7.disabled && /\(4\)/.test(b7.text), JSON.stringify(b7));
  await page.evaluate(() => { const a = document.getElementById('paylw-cb-all'); if (a) a.click(); });
  check('clicking again clears them', (await state()).selectedPaid === 0, JSON.stringify(await state()));

  console.log('\n[10b] …but in a MIXED result set it never arms an undo');
  // Undo one lot so the results hold both kinds of row again.
  await api('POST', `/api/payments/lots/${aid}/unmark-paid`, { lotIds: [lotIds['040']] });
  await search('all');
  const hMix = await hdr();
  check('header box is live', hMix && !hMix.disabled, JSON.stringify(hMix));
  check('and back to meaning the export selection',
        hMix && /payable/.test(hMix.title), JSON.stringify(hMix));
  await page.evaluate(() => payLwTickAll(true));
  const stMix = await state();
  check('it selects the payable lot', stMix.selected === 1, JSON.stringify(stMix));
  check('and arms no undo', stMix.selectedPaid === 0, JSON.stringify(stMix));
  // Put the fixture back to all-paid for the sections that follow.
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [lotIds['040']] });
  await search('all');

  console.log('\n[11] …and the paid select-all still works there');
  const tb1 = await tickAllBtn();
  check('it offers every paid lot', tb1 && tb1.shown && /4 paid/.test(tb1.text), JSON.stringify(tb1));
  await page.evaluate(() => payLwTickAllPaid());
  check('all four armed for undo', (await state()).selectedPaid === 4, JSON.stringify(await state()));
  const b6 = await undoBtn();
  check('undo button counts them', b6 && !b6.disabled && /\(4\)/.test(b6.text), JSON.stringify(b6));
  await page.evaluate(() => payLwClearSelection());

  console.log('\n[12] Non-admins get none of it');
  // The server gates unmark-paid with requireAdmin, so this is about not
  // offering an action that would be refused. Flip the role the renderer reads
  // and re-render — cheaper than a second account, and it is exactly the value
  // the row/button gates test.
  await page.evaluate(() => { window._userRole = 'operator'; _payLwRender(); });
  check('no tickable paid rows', (await paidBoxes()).length === 0);
  check('paid rows keep the disabled lock',
        await page.evaluate(() => Array.from(document.querySelectorAll('#paylw-body tbody tr'))
          .filter(tr => tr.className.includes('paylw-row-paid'))
          .every(tr => !!tr.querySelector('input[type=checkbox][disabled]'))));
  const b5 = await undoBtn();
  check('the Undo selected button is hidden', b5 && !b5.shown, JSON.stringify(b5));
  check('the Tick all paid button is hidden too',
        await page.evaluate(() => document.getElementById('paylw-tickallpaid-btn').style.display === 'none'));
  // No undo to offer, nothing payable either — the header box falls back to
  // being disabled-and-explained rather than secretly meaning something.
  const hNon = await hdr();
  check('the header box is inert and says why', hNon && hNon.disabled && /already paid/.test(hNon.title),
        JSON.stringify(hNon));
  await page.evaluate(() => { window._userRole = 'admin'; _payLwRender(); });

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); });
