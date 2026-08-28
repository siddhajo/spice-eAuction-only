// Payments — Lot-wise: the "Pay Advance" dialog, driven through the REAL
// screen in a headless Chrome.
//
// The dialog is hand-rendered and its amount boxes are live inputs, so the
// only honest check of "tick these, apply an amount, press Pay" is to do it
// and read the results table back afterwards. Also covers the two rules that
// protect money: only TICKED rows are saved, and only rows whose amount
// actually CHANGED are sent — a pre-ticked row nobody touched must not have
// its existing advance wiped by an empty box.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-adv-ui-'));
const PORT = 47343;
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

  const auc = await api('POST', '/api/auctions', { ano: '31', date: '2026-08-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  // Three lots, one seller with a default account. Priced so each lot's
  // Payable is a round, easily-asserted number.
  const t = await api('POST', '/api/traders', {
    name: 'ANNAMALAI', cr: '', padd: 'ADDR', ppla: 'PLACE',
    banks: [{ acctnum: '1000012345', ifsc: 'HDFC0001234', bank_name: 'HDFC', holder_name: 'ANNAMALAI', account_type: 'Savings', is_default: 1 }],
  });
  const traderId = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
  if (!traderId) { console.error('trader create failed', t.status, t.d); cleanup(); process.exit(1); }
  const lotIds = {};
  for (const lot_no of ['1', '2', '3']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'ANNAMALAI', cr: '', qty: 100, grade: '2', bags: 10,
      crop: 'CARDAMOM', branch: 'ANAVILASAM', trader_id: traderId,
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    if (!id) { console.error('lot create failed', r.status, r.d); cleanup(); process.exit(1); }
    lotIds[lot_no] = id;
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800 });
  }

  // ── Drive the real screen ────────────────────────────────────────────
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
  // Every confirm() in this flow is the "really move this money?" gate.
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
  // Results table, by column: 0 ☑ · 1 Seller · 2 Lot · 3 Qty · 4 Branch ·
  // 5 Bank · 6 Advance · 7 Payable.
  const resultRows = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body tbody tr')).map(tr => ({
      lot:      (tr.children[2]?.textContent || '').trim(),
      advance:  (tr.children[6]?.textContent || '').trim(),
      payable:  (tr.children[7]?.textContent || '').trim().replace(/\s+/g, ' '),
      badge:    (tr.querySelector('.paylw-adv-badge')?.textContent || '').trim(),
    })));
  const openAdv = async () => {
    await page.evaluate(() => payLwOpenAdvance());
    await page.waitForFunction(
      () => document.getElementById('paylw-adv-modal')?.classList.contains('show')
            && document.querySelectorAll('#paylw-adv-body tbody tr').length > 0,
      { timeout: 8000 });
  };
  // Modal rows carry data-lot, so ticks can be aimed by lot NUMBER rather than
  // by position — the dialog follows the screen's sort order.
  const advRowMeta = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-adv-body tbody tr')).map(tr => ({
      id:     Number(tr.getAttribute('data-lot')),
      lot:    (tr.children[2]?.textContent || '').trim(),
      ticked: !!tr.querySelector('.paylw-adv-cb')?.checked,
      amount: String(tr.querySelector('.paylw-adv-amt')?.value || ''),
    })));
  const setTicks = (lots) => page.evaluate(want => {
    document.querySelectorAll('#paylw-adv-body tbody tr').forEach(tr => {
      const lot = (tr.children[2]?.textContent || '').trim();
      const cb = tr.querySelector('.paylw-adv-cb');
      if (cb) cb.checked = want.includes(lot);
    });
    payLwAdvSync();
  }, lots);
  // After Pay the dialog deliberately STAYS OPEN: Export advance lives inside
  // it, and closing here forced the operator to reopen Pay Advance and re-tick
  // the same lots just to reach that button. The save has fully landed once the
  // dialog has been redrawn against the reloaded lots, which shows up as Pay
  // disarming itself — there is nothing unsaved left for it to send.
  const savedAndStillOpen = () => page.waitForFunction(
    () => document.getElementById('paylw-adv-modal')?.classList.contains('show')
          && document.querySelector('#paylw-body tbody tr')
          && document.getElementById('paylw-adv-save')?.disabled,
    { timeout: 10000 });

  console.log('[1] The dialog opens on the search results');
  await search();
  let rows = await resultRows();
  check('3 lots listed, none with an advance', rows.length === 3 && rows.every(r => r.advance === '—'),
        JSON.stringify(rows));
  check('the Advance column exists in the header',
        (await page.evaluate(() => Array.from(document.querySelectorAll('#paylw-body thead th'))
          .map(th => th.textContent.replace(/[▲▼]/g, '').trim()))).includes('Advance'));

  await openAdv();
  let meta = await advRowMeta();
  check('one dialog row per listed lot', meta.length === 3, JSON.stringify(meta));
  check('all pre-ticked when nothing was ticked behind it (fresh search ticks all)',
        meta.every(r => r.ticked), JSON.stringify(meta));
  check('Pay is disabled until something changes',
        await page.evaluate(() => document.getElementById('paylw-adv-save').disabled));

  console.log('\n[2] Apply an amount to the ticked lots and pay');
  await setTicks(['1', '2']);
  meta = await advRowMeta();
  check('only lots 1 and 2 are ticked now',
        meta.filter(r => r.ticked).map(r => r.lot).join(',') === '1,2', JSON.stringify(meta));
  await page.evaluate(() => { document.getElementById('paylw-adv-bulk').value = '5000'; });
  await page.evaluate(() => payLwAdvApplyBulk());
  meta = await advRowMeta();
  check('the amount landed on the ticked rows only',
        meta.find(r => r.lot === '1').amount === '5000'
        && meta.find(r => r.lot === '2').amount === '5000'
        && meta.find(r => r.lot === '3').amount === '',
        JSON.stringify(meta));
  const totalTxt = await page.evaluate(() => document.getElementById('paylw-adv-total').textContent);
  check('the running total reads 10,000', /10,000/.test(totalTxt), JSON.stringify(totalTxt));
  check('Pay is armed and counts the changes',
        await page.evaluate(() => {
          const b = document.getElementById('paylw-adv-save');
          return !b.disabled && /\(2\)/.test(b.textContent);
        }));

  await page.evaluate(() => payLwSaveAdvance());
  await savedAndStillOpen();
  rows = await resultRows();
  const byLot = Object.fromEntries(rows.map(r => [r.lot, r]));
  check('lots 1 and 2 show the advance in its own column',
        byLot['1'].advance === '5,000.00' && byLot['2'].advance === '5,000.00', JSON.stringify(rows));
  // The gross sits in its own <div> under the figure, so textContent runs the
  // two together — assert on the parts, not on the concatenation.
  check('their Payable is net, with the gross shown underneath',
        /^4,800\.00/.test(byLot['1'].payable) && /of ₹9,800\.00/.test(byLot['1'].payable),
        JSON.stringify(byLot['1'].payable));
  check('lot 3 is untouched', byLot['3'].advance === '—' && byLot['3'].payable === '9,800.00',
        JSON.stringify(byLot['3']));
  check('paid lots get an amber badge naming the amount and date',
        /Advance ₹5,000\.00 on \d/.test(byLot['1'].badge), JSON.stringify(byLot['1'].badge));
  check('the badge is NOT the green paid stamp — the row stays selectable',
        await page.evaluate(() => {
          const tr = Array.from(document.querySelectorAll('#paylw-body tbody tr'))
            .find(x => (x.children[2]?.textContent || '').trim() === '1');
          return !!tr && !tr.classList.contains('paylw-row-paid') && !tr.querySelector('input[disabled]');
        }));
  const summary = await page.evaluate(() => document.getElementById('paylw-summary').textContent);
  check('the summary totals the advance and flags Payable as net',
        /Advance paid ₹10,000\.00/.test(summary) && /net of advance/.test(summary),
        JSON.stringify(summary.slice(0, 260)));

  // ── The dialog survives the save so the advance can be exported ──────
  // Recording the advance and sending it to the bank are two halves of one
  // job. The dialog used to close on Pay, which meant reopening Pay Advance
  // and re-ticking the same lots purely to reach Export advance.
  console.log('\n[2b] Pay leaves the dialog open, ready to export');
  check('the dialog is still open', await page.evaluate(
    () => document.getElementById('paylw-adv-modal').classList.contains('show')));
  meta = await advRowMeta();
  check('the ticks survive the reload — still lots 1 and 2, not all three',
        meta.filter(r => r.ticked).map(r => r.lot).join(',') === '1,2', JSON.stringify(meta));
  check('the boxes now hold the SAVED figures (redrawn from the reload)',
        meta.find(r => r.lot === '1').amount === '5000'
        && meta.find(r => r.lot === '2').amount === '5000'
        && meta.find(r => r.lot === '3').amount === '', JSON.stringify(meta));
  // The rows are re-pointed at the reloaded lot objects, so nothing reads as
  // unsaved any more. A stale advRows would leave Pay armed for a save
  // already made.
  check('Pay has disarmed itself — nothing is unsaved',
        await page.evaluate(() => {
          const b = document.getElementById('paylw-adv-save');
          return b.disabled && b.textContent.trim() === 'Pay';
        }));
  check('Export advance is live and counts the 2 saved lots',
        await page.evaluate(() => {
          const b = document.getElementById('paylw-adv-export');
          return !b.disabled && /\(2\)/.test(b.textContent);
        }), await page.evaluate(() => document.getElementById('paylw-adv-export').textContent));
  check('the dismiss button now reads Close, not Cancel',
        await page.evaluate(() => document.getElementById('paylw-adv-cancel').textContent.trim()) === 'Close');
  // The whole point: Export advance works straight off the open dialog, with
  // no reopen and no re-ticking in between.
  const xdl = await page.evaluate(async () => {
    const r = await fetch(B + `/api/exports/bank_payment_advance/${_payLwState.aid}`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + T, 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: ['ANNAMALAI'], lots: { ANNAMALAI: ['1', '2'] }, format: 'xlsx', orderBy: 'lot' }),
    });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength };
  });
  check('the advance bank file the open dialog would post is served', xdl.status === 200 && xdl.len > 0,
        JSON.stringify(xdl));

  console.log('\n[3] An untouched pre-ticked row does NOT lose its advance');
  // Re-open and immediately press Pay on lot 3 only. Lots 1 and 2 keep their
  // 5000 even though the dialog re-opened with their boxes pre-filled.
  await openAdv();
  meta = await advRowMeta();
  check('the dialog pre-fills the advances already on file',
        meta.find(r => r.lot === '1').amount === '5000', JSON.stringify(meta));
  await setTicks(['3']);
  await page.evaluate(() => {
    const tr = Array.from(document.querySelectorAll('#paylw-adv-body tbody tr'))
      .find(x => (x.children[2]?.textContent || '').trim() === '3');
    const el = tr.querySelector('.paylw-adv-amt');
    el.value = '800'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => payLwSaveAdvance());
  await savedAndStillOpen();
  rows = await resultRows();
  const b2 = Object.fromEntries(rows.map(r => [r.lot, r]));
  check('lot 3 now carries 800', b2['3'].advance === '800.00', JSON.stringify(b2['3']));
  check('lots 1 and 2 keep their 5,000 (unticked rows were never sent)',
        b2['1'].advance === '5,000.00' && b2['2'].advance === '5,000.00', JSON.stringify(rows));

  console.log('\n[4] An amount above the lot Payable blocks the save');
  await openAdv();
  await setTicks(['1']);
  await page.evaluate(() => {
    const tr = Array.from(document.querySelectorAll('#paylw-adv-body tbody tr'))
      .find(x => (x.children[2]?.textContent || '').trim() === '1');
    const el = tr.querySelector('.paylw-adv-amt');
    el.value = '99999'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('the box is flagged over-limit',
        await page.evaluate(() => {
          const tr = Array.from(document.querySelectorAll('#paylw-adv-body tbody tr'))
            .find(x => (x.children[2]?.textContent || '').trim() === '1');
          return tr.querySelector('.paylw-adv-amt').classList.contains('over');
        }));
  check('Pay is disabled', await page.evaluate(() => document.getElementById('paylw-adv-save').disabled));
  check('and the footer says why',
        /exceeds? its Payable/i.test(await page.evaluate(() => document.getElementById('paylw-adv-total').textContent)));
  // "Apply to ticked" caps at the row's own Payable rather than sending a
  // doomed batch.
  await page.evaluate(() => { document.getElementById('paylw-adv-bulk').value = '99999'; });
  await page.evaluate(() => payLwAdvApplyBulk());
  check('bulk apply caps the amount at the lot Payable',
        (await advRowMeta()).find(r => r.lot === '1').amount === '9800',
        JSON.stringify(await advRowMeta()));

  console.log('\n[5] Clearing an advance');
  await setTicks(['1']);
  await page.evaluate(() => payLwAdvClearAmounts());
  check('the footer warns that an existing advance will be removed',
        /will be removed/.test(await page.evaluate(() => document.getElementById('paylw-adv-total').textContent)));
  await page.evaluate(() => payLwSaveAdvance());
  await savedAndStillOpen();
  rows = await resultRows();
  const b3 = Object.fromEntries(rows.map(r => [r.lot, r]));
  check('lot 1 is back to its full Payable with no badge',
        b3['1'].advance === '—' && b3['1'].payable === '9,800.00' && b3['1'].badge === '',
        JSON.stringify(b3['1']));
  check('the other lots are unaffected',
        b3['2'].advance === '5,000.00' && b3['3'].advance === '800.00', JSON.stringify(rows));

  console.log('\n[6] A paid-out lot is kept out of the dialog');
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [lotIds['3']] });
  await search();
  await openAdv();
  meta = await advRowMeta();
  check('the paid lot is not offered', !meta.some(r => r.lot === '3'), JSON.stringify(meta));
  check('the two payable lots still are', meta.length === 2, JSON.stringify(meta));
  await page.evaluate(() => hideModal('paylw-adv-modal'));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(srvLog.slice(-2500));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2500)); cleanup(); process.exit(1); });
