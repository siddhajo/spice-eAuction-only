// ONE "Add Seller" FORM, not three.
//
// A seller registered from the auction hall is the same record as one
// registered from the Sellers tab — so it is entered on the same form. Lot
// Entry used to carry its own nine-field quick add, which meant a seller
// created mid-auction arrived with no SBL, no TAN, no date of birth, no User
// ID and no bank account, and somebody had to notice and finish the record
// from another screen later. The mobile PWA, which cannot share the DOM, has
// to capture the same fields.
//
//   [gone]     the bespoke Lot Entry dialog no longer exists
//   [opens]    "+ Add new seller" opens the SELLERS modal, prefilled from
//              whatever was typed in the seller search (digits ⇒ phone)
//   [fields]   that modal carries the full set — SBL, TAN, DOB, User ID,
//              bank accounts, Fetch from GST
//   [save]     saving registers the seller AND drops them into the lot form
//   [cancel]   cancelling does not leave the hand-back armed for the next
//              unrelated Add Seller on the Sellers tab
//   [mobile]   the PWA's Add Seller captures the same field set
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'one-seller-'));
const PORT = 47441;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
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

// What a seller record is, as the Sellers screen defines it. Both forms are
// measured against this one list — that IS the requirement.
const DESKTOP_IDS = {
  name: 't-name', cr: 't-cr', pan: 't-pan', tan: 't-tan', tel: 't-tel',
  aadhar: 't-aadhar', padd: 't-padd', ppla: 't-ppla', pin: 't-pin',
  pstate: 't-pstate', pst_code: 't-pstcode', dob: 't-dob', user_id: 't-userid',
};
const MOBILE_IDS = {
  name: 'ns-name', cr: 'ns-cr', pan: 'ns-pan', tan: 'ns-tan', tel: 'ns-tel',
  aadhar: 'ns-aadhar', padd: 'ns-padd', ppla: 'ns-ppla', pin: 'ns-pin',
  pstate: 'ns-pstate', pst_code: 'ns-pst', dob: 'ns-dob', user_id: 'ns-userid',
};

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }
  const auc = await api('POST', '/api/auctions', { ano: '71', date: '2026-09-30', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

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

  // ══ DESKTOP ══════════════════════════════════════════════════════
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('lotentry'); });
  await page.waitForSelector('#le-seller-search', { timeout: 15000 });

  console.log('[gone] the second dialog is gone');
  check('no bespoke Lot Entry seller modal in the DOM',
        await page.evaluate(() => !document.getElementById('le-newseller-modal')));
  check('…and none of its fields either',
        await page.evaluate(() => !document.getElementById('le-ns-name') && !document.getElementById('le-ns-tel')));

  console.log('[opens] Lot Entry opens the Sellers modal, prefilled');
  const opened = await page.evaluate(() => {
    leOpenNewSellerModal('RAMASAMY ESTATE');
    const m = document.getElementById('trader-modal');
    return {
      modal: !!m && getComputedStyle(m).display !== 'none',
      title: document.getElementById('trader-modal-title')?.textContent.trim(),
      name: document.getElementById('t-name')?.value,
      cr: document.getElementById('t-cr')?.value,
      armed: window._leSellerReturn === true,
    };
  });
  check('the Sellers modal is what opens', opened.modal, JSON.stringify(opened));
  check('…headed Add Seller', /add seller/i.test(opened.title || ''), opened.title);
  check('…with the typed name carried over, upper-cased',
        opened.name === 'RAMASAMY ESTATE', opened.name);
  check('…and the CR. prefix the Sellers tab starts on', opened.cr === 'CR.', opened.cr);
  check('…armed to hand the seller back to the lot form', opened.armed, JSON.stringify(opened));

  console.log('[fields] it carries the whole seller record');
  const fields = await page.evaluate((ids) => {
    const out = {};
    for (const [k, id] of Object.entries(ids)) out[k] = !!document.getElementById(id);
    out.banks = !!document.getElementById('t-banks-container');
    out.gstFetch = [...document.querySelectorAll('#trader-modal button')]
      .some(b => /fetch from gst/i.test(b.textContent));
    return out;
  }, DESKTOP_IDS);
  for (const k of Object.keys(DESKTOP_IDS)) check(`field: ${k}`, fields[k], JSON.stringify(fields));
  check('bank accounts section', fields.banks, JSON.stringify(fields));
  check('Fetch from GST', fields.gstFetch, JSON.stringify(fields));

  console.log('[opens] a digits-only search lands in the phone box, not the name');
  const byPhone = await page.evaluate(() => {
    closeTraderModal();
    leOpenNewSellerModal('9876501234');
    return { name: document.getElementById('t-name')?.value, tel: document.getElementById('t-tel')?.value };
  });
  check('phone prefilled', byPhone.tel === '9876501234', JSON.stringify(byPhone));
  check('…and the name left empty', !byPhone.name, JSON.stringify(byPhone));

  console.log('[cancel] cancelling disarms the hand-back');
  check('the flag is cleared on close',
        await page.evaluate(() => { closeTraderModal(); return window._leSellerReturn === false; }));

  console.log('[save] the saved seller lands in the lot form');
  const saved = await page.evaluate(async (aid) => {
    // Lot Entry needs its trade picked before the seller can be selected.
    const sel = document.getElementById('le-auction');
    if (sel) { sel.value = String(aid); if (typeof leOnAuctionChange === 'function') leOnAuctionChange(); }
    leOpenNewSellerModal('GOPAL NAIR');
    document.getElementById('t-tel').value = '9445566778';
    document.getElementById('t-aadhar').value = 'ML/REG/22222/2021';
    document.getElementById('t-tan').value = 'BLRA12345C';
    document.getElementById('t-userid').value = 'GN-1';
    await saveTrader();
    await new Promise(r => setTimeout(r, 800));
    return {
      modalShut: getComputedStyle(document.getElementById('trader-modal')).display === 'none',
      lotSeller: (document.getElementById('le-seller-name')?.textContent || '').trim(),
      cardShown: getComputedStyle(document.getElementById('le-seller-card')).display !== 'none',
      disarmed: window._leSellerReturn === false,
    };
  }, aid);
  check('the modal closes on save', saved.modalShut, JSON.stringify(saved));
  check('…and the new seller is selected into the lot form',
        saved.cardShown && /GOPAL NAIR/i.test(saved.lotSeller), JSON.stringify(saved));
  check('…and the hand-back is disarmed again', saved.disarmed, JSON.stringify(saved));
  // The whole point: the hall-created seller is COMPLETE.
  const rows = (await api('GET', '/api/traders?search=GOPAL')).d;
  const made = (Array.isArray(rows) ? rows : (rows && rows.rows) || []).find(t => /GOPAL NAIR/i.test(t.name || ''));
  check('the record carries the SBL the quick add used to drop',
        made && String(made.aadhar) === 'ML/REG/22222/2021', JSON.stringify(made && made.aadhar));
  check('…the TAN', made && String(made.tan).toUpperCase() === 'BLRA12345C', JSON.stringify(made && made.tan));
  check('…and the User ID', made && String(made.user_id) === 'GN-1', JSON.stringify(made && made.user_id));

  // ══ MOBILE ═══════════════════════════════════════════════════════
  // A different app on a different DOM — so what is checked is that it asks
  // for the same things, not that it looks the same.
  console.log('[mobile] the PWA asks for the same fields');
  const m = await browser.newPage();
  m.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await m.setViewport({ width: 390, height: 844, isMobile: true });
  await m.goto(B + '/mobile', { waitUntil: 'domcontentloaded' });
  await m.evaluate(tok => { try { localStorage.setItem('t', tok); } catch(_) {} }, TOKEN);
  await m.goto(B + '/mobile', { waitUntil: 'networkidle2' });
  const mob = await m.evaluate((ids) => {
    const out = {};
    for (const [k, id] of Object.entries(ids)) out[k] = !!document.getElementById(id);
    out.banks = !!document.getElementById('ns-bank-rows');
    return out;
  }, MOBILE_IDS);
  for (const k of Object.keys(MOBILE_IDS)) check(`mobile field: ${k}`, mob[k], JSON.stringify(mob));
  check('mobile bank accounts section', mob.banks, JSON.stringify(mob));
  // …and that the two forms agree field for field.
  const missing = Object.keys(DESKTOP_IDS).filter(k => !mob[k]);
  check('every Sellers-screen field has a mobile counterpart', missing.length === 0,
        'missing: ' + missing.join(', '));
  // The new ones must actually be SENT, not just rendered.
  const sends = await m.evaluate(() => {
    const src = (typeof saveNewSeller === 'function') ? saveNewSeller.toString() : '';
    return { aadhar: /aadhar\s*:/.test(src), tan: /tan\s*:/.test(src) };
  });
  check('mobile posts the SBL', sends.aadhar, JSON.stringify(sends));
  check('…and the TAN', sends.tan, JSON.stringify(sends));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); });
