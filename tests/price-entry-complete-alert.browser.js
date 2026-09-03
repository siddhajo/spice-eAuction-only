// PRICE ENTRY — the "already complete" prompt names what each lot HOLDS.
//
// Quick-select (🎯 Select lots) warns when some of the typed lots are already
// priced with a buyer, and asks whether to pull them in for editing. It used
// to list bare lot numbers, which is not something anyone can answer from —
// so each lot now shows its price and its buyer. WD / NA count as complete
// but carry neither, so they say what they are instead of reading as
// "0.00 · no buyer".
//
// It is an in-app modal, not a native confirm(): a browser dialog cannot be
// styled, and its plain black text was hard to pick out (2026-09-03 feedback).
// The prompt wears the app's amber warning colours and renders the lots as a
// table.
//
// Driven through the real screen, because the whole point is what an operator
// is shown.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pealert-'));
const PORT = 47376;
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

async function api(method, url, body, token) {
  const r = await fetch(B + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const srv = spawn('node', [path.join(ROOT, 'server.js')], { cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }), stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
let browser;
const cleanup = async () => { try { if (browser) await browser.close(); } catch (_) {} try { srv.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };
function findChrome(){ for (const p of [process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean)) { try { if (fs.existsSync(p)) return p; } catch(_){} } return null; }

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const ADMIN = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' }, ADMIN);
  const AID = (await api('POST', '/api/auctions', { ano: '41', date: '2026-09-03', crop_type: 'VST' }, ADMIN)).d.id;
  await api('POST', '/api/buyers', { buyer: 'ANKIT SPICES', buyer1: 'ANKIT SPICES', code: 'B2', pla: 'BODI', state: 'TAMIL NADU', st_code: '33', gstin: '33AAHCE4551A1Z8' }, ADMIN);
  await api('POST', '/api/buyers', { buyer: 'ELAICHIROYAL PRIVATE LIMITED', buyer1: 'ELAICHIROYAL PRIVATE LIMITED-KL', code: 'ERPL', pla: 'KUMILY', state: 'KERALA', st_code: '32', gstin: '32AAHCE4551A1Z8' }, ADMIN);
  const seed = [
    { lot_no: '001', price: 3756,   code: 'B2',   b1: 'ANKIT SPICES' },
    { lot_no: '002', price: 2561.5, code: 'ERPL', b1: 'ELAICHIROYAL PRIVATE LIMITED-KL' },
    { lot_no: '003', price: 0,      code: 'WD',   b1: '' },
    { lot_no: '004', price: 0,      code: '',     b1: '' },   // still to price
  ];
  for (const s of seed) {
    const r = await api('POST', '/api/lots', { auction_id: AID, lot_no: s.lot_no, name: 'PLANTER ' + s.lot_no, cr: 'CR.', bags: 6, qty: 100, grade: '1', crop: 'CARDAMOM' }, ADMIN);
    if (s.code) await api('PUT', `/api/lots/${r.d.lot.id}`, { price: s.price, amount: 100 * s.price, code: s.code, buyer: s.b1 || s.code, buyer1: s.b1, sale: 'L' }, ADMIN);
  }

  const chromePath = findChrome();
  if (!chromePath) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); await cleanup(); process.exit(0); }
  browser = await pptr.launch({ executablePath: chromePath, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.goto(B, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => { document.getElementById('inp-u').value='uiadmin'; document.getElementById('inp-p').value='pw1234'; login(); });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block' && !!window._currentTab, { timeout: 20000 });

  // Call the loader directly — go('priceentry') is gated on the topbar trade
  // reaching stage 2, which is about navigation, not what we're capturing.
  await page.evaluate(() => loadPriceEntry());
  await page.waitForFunction(() => document.querySelectorAll('#pe-auction option').length > 0, { timeout: 15000 });
  await page.evaluate((aid) => { document.getElementById('pe-auction').value = String(aid); loadPriceEntryGrid(); }, AID);
  // `_pe` is a top-level `let`, so it is script-scope, not window.
  await page.waitForFunction(() => (typeof _pe !== 'undefined' && _pe.lots || []).length > 0, { timeout: 15000 });

  // Open the prompt for a mix: two priced lots, one withdrawn, one still to
  // price. Nothing is awaited on the caller's promise here — the modal is
  // inspected while it is up, then answered.
  await page.evaluate(() => {
    document.getElementById('pe-lotno-input').value = '1,2,3,4';
    peSelectByLotNos();
  });
  await page.waitForFunction(() => document.getElementById('pe-complete-modal')?.classList.contains('show'), { timeout: 10000 });

  const seen = await page.evaluate(() => {
    const wrap = document.getElementById('pe-complete-modal');
    const banner = wrap.querySelector('div[style*="FEF3C7"]');
    const cs = banner ? getComputedStyle(banner) : null;
    const rows = Array.from(wrap.querySelectorAll('#pe-complete-list tbody tr'))
      .map(tr => Array.from(tr.children).map(td => td.textContent.replace(/\s+/g, ' ').trim()));
    return {
      title: (document.getElementById('pe-complete-title').textContent || '').trim(),
      bannerBg: cs ? cs.backgroundColor : null,
      titleColor: cs ? getComputedStyle(document.getElementById('pe-complete-title')).color : null,
      headers: Array.from(wrap.querySelectorAll('#pe-complete-list thead th')).map(th => th.textContent.trim()),
      rows,
      buttons: Array.from(wrap.querySelectorAll('.actions button')).map(b => b.textContent.trim()),
    };
  });

  check('the prompt names how many lots are already priced',
        /^3 of the lots you typed are already priced$/.test(seen.title), seen.title);
  // The whole point of replacing confirm(): the warning is no longer black on
  // grey. Amber banner (#FEF3C7) with dark amber text (#7C2D12).
  check('the warning is on the amber banner, not plain black on grey',
        seen.bannerBg === 'rgb(254, 243, 199)', String(seen.bannerBg));
  check('…and its heading is the dark amber, not #000',
        seen.titleColor === 'rgb(124, 45, 18)', String(seen.titleColor));
  check('the lots are a table of Lot / Price / Buyer',
        JSON.stringify(seen.headers) === JSON.stringify(['Lot', 'Price', 'Buyer']), JSON.stringify(seen.headers));

  const flat = JSON.stringify(seen.rows);
  check('a priced lot shows its price', /"001","3,756\.00 \/kg"/.test(flat), flat);
  check('…and its buyer, code then trade name', /B2 · ANKIT SPICES/.test(flat), flat);
  check('paise are kept', /2,561\.50 \/kg/.test(flat), flat);
  check('the second lot names its own buyer', /ERPL · ELAICHIROYAL PRIVATE LIMITED-KL/.test(flat), flat);
  // Withdrawn is complete but carries neither price nor buyer.
  check('a withdrawn lot says so instead of showing 0.00',
        /"003","Withdrawn"/.test(flat), flat);
  check('…and does not render a zero price', !/"003","0\.00/.test(flat), flat);
  check('an unpriced lot is not listed as complete', !/"004"/.test(flat), flat);
  check('both answers are offered as buttons',
        seen.buttons.includes('Skip them') && seen.buttons.includes('Include them for editing'),
        JSON.stringify(seen.buttons));

  // Skip must leave the completed lots out of the selection.
  const after = await page.evaluate(async () => {
    _peCompleteAnswer(false);
    await new Promise(r => setTimeout(r, 50));
    return { open: document.getElementById('pe-complete-modal').classList.contains('show'), sel: _pe.sel.size };
  });
  check('answering Skip closes the prompt', after.open === false);
  check('…and selects only the lot that still needs pricing', after.sel === 1, String(after.sel));

  // Closing with the ✕ must ANSWER (as Skip), not strand the caller — the
  // click handler is awaited by peSelectByLotNos.
  const viaX = await page.evaluate(async () => {
    _pe.sel.clear();
    document.getElementById('pe-lotno-input').value = '1,2,3,4';
    const p = peSelectByLotNos();
    await new Promise(r => setTimeout(r, 80));
    document.querySelector('#pe-complete-modal .modal-x').click();
    // Resolves only if the ✕ answered the promise.
    await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 2000))]);
    return { open: document.getElementById('pe-complete-modal').classList.contains('show'), sel: _pe.sel.size };
  }).catch(e => ({ err: String(e.message || e) }));
  check('closing with ✕ answers the prompt rather than hanging', !viaX.err, String(viaX.err));
  check('…and counts as Skip', viaX.sel === 1, JSON.stringify(viaX));

  // A long list is capped, with the remainder named.
  const capped = await page.evaluate(async () => {
    const many = Array.from({ length: 140 }, (_, i) => ({
      id: 10000 + i, lot_no: String(i + 1).padStart(3, '0'),
      price: 3000 + i, code: 'B2', buyer: 'ANKIT SPICES', buyer1: 'ANKIT SPICES',
    }));
    const saved = _pe.lots;
    _pe.lots = many;
    document.getElementById('pe-lotno-input').value = '1-140';
    peSelectByLotNos();
    await new Promise(r => setTimeout(r, 120));
    const body = document.getElementById('pe-complete-list');
    const out = {
      rows: body.querySelectorAll('tbody tr').length,
      tail: (body.textContent.match(/…and \d+ more/) || [''])[0],
      scrolls: getComputedStyle(body).overflowY,
    };
    _peCompleteAnswer(false);
    _pe.lots = saved;
    return out;
  });
  check('a long list is capped rather than rendering every row',
        capped.rows <= 101, `${capped.rows} rows`);
  check('…and says how many were not shown', /…and 40 more/.test(capped.tail), capped.tail);
  check('…in a panel that scrolls', capped.scrolls === 'auto', capped.scrolls);

  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-2000)); await cleanup(); process.exit(1); });
