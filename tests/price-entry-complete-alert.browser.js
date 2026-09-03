// PRICE ENTRY — the "already complete" prompt names what each lot HOLDS.
//
// Quick-select (🎯 Select lots) warns when some of the typed lots are already
// priced with a buyer, and asks whether to pull them in for editing. It used
// to list bare lot numbers, which is not something anyone can answer from —
// so each lot now shows its price and its buyer. WD / NA count as complete
// but carry neither, so they say what they are instead of reading as
// "0.00 · no buyer".
//
// Driven through the real screen and the real confirm(), because the whole
// point is the text an operator is shown.
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

  // Capture what confirm() is actually asked, then answer Cancel.
  const msg = await page.evaluate(async () => {
    let captured = null;
    const real = window.confirm;
    window.confirm = (m) => { captured = m; return false; };
    document.getElementById('pe-lotno-input').value = '1,2,3,4';
    await peSelectByLotNos();
    window.confirm = real;
    return captured;
  });
  check('the prompt is shown for the completed lots only', !!msg && /3 of the lots you typed/.test(msg), String(msg));
  // Lot 001 — priced, with a buyer code and trade name.
  check('a priced lot shows its price', /001\s+3,756\.00 \/kg/.test(msg || ''), String(msg));
  check('…and its buyer, code then trade name', /B2 · ANKIT SPICES/.test(msg || ''), String(msg));
  // Lot 002 — a price with paise, and a long trade name.
  check('paise are kept', /2,561\.50 \/kg/.test(msg || ''), String(msg));
  check('the second lot names its own buyer', /ERPL · ELAICHIROYAL PRIVATE LIMITED-KL/.test(msg || ''), String(msg));
  // Lot 003 — withdrawn: complete, but no price or buyer to report.
  check('a withdrawn lot says so instead of showing 0.00', /003\s+withdrawn/.test(msg || ''), String(msg));
  check('…and does not render a zero price', !/003\s+0\.00/.test(msg || ''), String(msg));
  // Lot 004 is still unpriced, so it is not in the prompt at all.
  check('an unpriced lot is not listed as complete', !/\n004/.test(msg || ''), String(msg));
  check('the question and its two answers survive', /Include them for editing too\?/.test(msg || '')
        && /OK = include them/.test(msg || ''), String(msg));

  // A long range must not produce a dialog taller than the screen.
  const capped = await page.evaluate(async () => {
    let captured = null;
    const real = window.confirm;
    window.confirm = (m) => { captured = m; return false; };
    // Pretend every lot in the trade is complete, then ask for a wide range.
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: 10000 + i, lot_no: String(i + 1).padStart(3, '0'),
      price: 3000 + i, code: 'B2', buyer: 'ANKIT SPICES', buyer1: 'ANKIT SPICES',
    }));
    const saved = _pe.lots;
    _pe.lots = many;
    document.getElementById('pe-lotno-input').value = '1-40';
    await peSelectByLotNos();
    _pe.lots = saved;
    window.confirm = real;
    return captured;
  });
  // Lot lines only. The header ("40 of the lots you typed…") also starts with
  // a digit, so match on the padding that follows a lot number instead.
  const lines = String(capped || '').split('\n').filter(l => /^\d+\s{2,}/.test(l));
  check('a long list is capped rather than running off the dialog', lines.length <= 12,
        `${lines.length} lot lines`);
  check('…and says how many were not shown', /…and 28 more/.test(capped || ''), String(capped).slice(0, 300));

  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-2000)); await cleanup(); process.exit(1); });
