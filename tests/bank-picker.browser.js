// Lot Entry bank picker — desktop console AND mobile PWA.
//
// Picking a seller must ALWAYS leave the picker on "Select your bank":
// never pre-armed with the seller's default account, never reading "No bank
// account". A silently inherited default is how a lot gets paid into the
// wrong account; the operator has to choose deliberately.
//
// Saving without choosing stores bank_id NULL, which routes to the seller's
// default at payment time — so nothing about existing payouts changes.
// Editing a lot that WAS saved with an account still shows that account.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bankpicker-'));
const PORT = 47365;
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
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await api('POST', '/api/users', { username: 'mobadmin', password: 'pw1234', role: 'operator' });
  await api('PUT', '/api/company-settings', { settings: { br1: 'BODINAYAKANUR', br2: 'CUMBUM' } });
  const auc = await api('POST', '/api/auctions', { ano: '41', date: '2026-08-22', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // A seller with TWO accounts, the SECOND flagged default — so a stale
  // "auto-pick the default" would be unmistakable in the assertions.
  const t = await api('POST', '/api/traders', { name: 'RAMASAMY K', tel: '9876543210', cr: 'CR/2211' });
  const tid = t.d.id || (t.d.trader && t.d.trader.id);
  const b1 = await api('POST', `/api/traders/${tid}/banks`, { bank_name: 'SBI', acctnum: '111111111111', ifsc: 'SBIN0001234', account_type: 'Savings' });
  const b2 = await api('POST', `/api/traders/${tid}/banks`, { bank_name: 'HDFC', acctnum: '222222222222', ifsc: 'HDFC0004321', account_type: 'Current' });
  const b1id = b1.d.id || (b1.d.bank && b1.d.bank.id);
  const b2id = b2.d.id || (b2.d.bank && b2.d.bank.id);
  await api('PUT', `/api/traders/${tid}/bank-default/${b2id}`);

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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });

  // ══ DESKTOP ═════════════════════════════════════════════════════
  console.log('[A] Desktop Lot Entry — picker opens unselected');
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  await page.evaluate(() => go('lotentry'));
  await new Promise(r => setTimeout(r, 900));

  const deskPick = await page.evaluate(async (traderId) => {
    const t = await j('/api/traders?page=1&pageSize=50&search=RAMASAMY')
      .then(d => (d.rows || d).find(x => x.id === traderId));
    lePickSeller(t);
    const sel = document.getElementById('le-bank-select');
    return {
      rowShown: document.getElementById('le-bank-row').style.display !== 'none',
      value: sel.value,
      firstOption: sel.options[0]?.textContent || '',
      optionCount: sel.options.length,
      selectedBankId: _le.selectedBankId,
      info: document.getElementById('le-bank-info').textContent,
    };
  }, tid);
  check('the bank row is visible for the selected seller', deskPick.rowShown, JSON.stringify(deskPick));
  check('the first option reads "Select your bank"', deskPick.firstOption === 'Select your bank', JSON.stringify(deskPick.firstOption));
  check('nothing is pre-selected (empty value)', deskPick.value === '', JSON.stringify(deskPick.value));
  check('_le.selectedBankId is null despite a flagged default', deskPick.selectedBankId === null, JSON.stringify(deskPick.selectedBankId));
  check('both accounts are listed under the placeholder', deskPick.optionCount === 3, String(deskPick.optionCount));
  check('no branch/IFSC line is shown while unselected', deskPick.info === '', JSON.stringify(deskPick.info));

  console.log('\n[B] Desktop — saving without picking stores no bank on the lot');
  const deskSaved = await page.evaluate(async (auctionId) => {
    document.getElementById('le-auction').value = String(auctionId);
    const br = document.getElementById('le-branch');
    br.value = [...br.options].map(o => o.value).find(v => v && v !== 'ALL') || '';
    document.getElementById('le-lotno').value = '901';
    document.getElementById('le-bags').value = '5';
    document.getElementById('le-litre').value = '0';
    document.getElementById('le-qty').value = '100';
    await leSaveLot();
    return document.getElementById('le-err')?.textContent || '';
  }, aid).catch(e => 'ERR ' + e.message);
  const lot901 = (await api('GET', `/api/lots/${aid}`)).d.find(l => String(l.lot_no).replace(/^0+/, '') === '901');
  check('the lot saved', !!lot901, JSON.stringify(deskSaved));
  check('…with bank_id NULL (payment falls back to the seller default)',
        lot901 && lot901.bank_id == null, lot901 && JSON.stringify(lot901.bank_id));

  console.log('\n[C] Desktop — an explicit pick is still stored on the lot');
  await page.evaluate((bankId) => {
    const sel = document.getElementById('le-bank-select');
    sel.value = String(bankId);
    sel.onchange();
    const br = document.getElementById('le-branch');
    br.value = [...br.options].map(o => o.value).find(v => v && v !== 'ALL') || '';
    document.getElementById('le-lotno').value = '902';
    document.getElementById('le-bags').value = '4';
    document.getElementById('le-litre').value = '0';
    document.getElementById('le-qty').value = '80';
    return leSaveLot();
  }, b1id);
  await new Promise(r => setTimeout(r, 600));
  const lot902 = (await api('GET', `/api/lots/${aid}`)).d.find(l => String(l.lot_no).replace(/^0+/, '') === '902');
  check('the chosen (non-default) account is stamped on the lot',
        lot902 && lot902.bank_id === b1id, lot902 && JSON.stringify(lot902.bank_id));

  // ══ MOBILE ══════════════════════════════════════════════════════
  // Mobile DEPARTS from the desktop rule on purpose: it opens on the seller's
  // default so a second lot for the same seller inherits the account chosen on
  // the first (picking one promotes it). The risk a blank picker guards against
  // is answered by tinting the pre-selection green instead. A seller with no
  // default still opens on the placeholder. See renderBankList in app.html.
  console.log('\n[D] Mobile Lot Entry — picker opens on the seller default');
  const mob = await browser.newPage();
  mob.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await mob.waitForSelector('#le-bank-select', { timeout: 15000 });
  const mobPick = await mob.evaluate(async (banks) => {
    sellerBanks = banks;
    renderBankList();
    const sel = document.getElementById('le-bank-select');
    const tinted = sel.style.borderColor !== '';
    // …and the same seller with NO default must still open blank.
    const withDefault = { value: sel.value, tinted,
      info: document.getElementById('le-bank-info').textContent };
    sellerBanks = banks.map(function (b) { return Object.assign({}, b, { is_default: 0 }); });
    renderBankList();
    const sel2 = document.getElementById('le-bank-select');
    return {
      value: withDefault.value,
      tinted: withDefault.tinted,
      firstOption: sel.options[0]?.textContent || '',
      optionCount: sel.options.length,
      info: withDefault.info,
      noDefaultValue: sel2.value,
      noDefaultTinted: sel2.style.borderColor !== '',
      noDefaultInfo: document.getElementById('le-bank-info').textContent,
    };
  }, [
    { id: b1id, bank_name: 'SBI',  acctnum: '111111111111', ifsc: 'SBIN0001234', account_type: 'Savings', is_default: 0 },
    { id: b2id, bank_name: 'HDFC', acctnum: '222222222222', ifsc: 'HDFC0004321', account_type: 'Current', is_default: 1 },
  ]);
  check('mobile first option reads "Select your bank"', mobPick.firstOption === 'Select your bank', JSON.stringify(mobPick.firstOption));
  check('mobile opens on the seller\'s flagged default', String(mobPick.value) === String(b2id), JSON.stringify(mobPick.value));
  check('…tinted, so the pre-selection is never silent', mobPick.tinted === true, JSON.stringify(mobPick.tinted));
  check('…and its branch/IFSC line is shown with it',
        /IFSC: HDFC0004321/.test(mobPick.info || ''), JSON.stringify(mobPick.info));
  check('mobile lists both accounts under the placeholder', mobPick.optionCount === 3, String(mobPick.optionCount));
  check('a seller with no default still opens on the placeholder',
        mobPick.noDefaultValue === '', JSON.stringify(mobPick.noDefaultValue));
  check('…untinted, and with no branch/IFSC line',
        mobPick.noDefaultTinted === false && mobPick.noDefaultInfo === '',
        JSON.stringify([mobPick.noDefaultTinted, mobPick.noDefaultInfo]));

  console.log('\n[E] Mobile edit-lot — keeps the lot\'s own account, inherits none');
  const mobEdit = await mob.evaluate(async (args) => {
    const [banks, savedBankId] = args;
    editBanks = banks;
    const out = {};
    editLotBankId = savedBankId;               // lot WAS saved with an account
    renderEditBankList();
    out.withBank = document.getElementById('ed-bank-select').value;
    editLotBankId = null;                      // lot saved with none
    renderEditBankList();
    const sel = document.getElementById('ed-bank-select');
    out.withoutBank = sel.value;
    out.firstOption = sel.options[0]?.textContent || '';
    return out;
  }, [[
    { id: b1id, bank_name: 'SBI',  acctnum: '111111111111', ifsc: 'SBIN0001234', account_type: 'Savings', is_default: 0 },
    { id: b2id, bank_name: 'HDFC', acctnum: '222222222222', ifsc: 'HDFC0004321', account_type: 'Current', is_default: 1 },
  ], b1id]);
  check('a lot saved with an account re-opens on that account',
        String(mobEdit.withBank) === String(b1id), JSON.stringify(mobEdit.withBank));
  check('a lot saved without one stays on the placeholder (no default inherited)',
        mobEdit.withoutBank === '', JSON.stringify(mobEdit.withoutBank));
  check('mobile edit placeholder reads "Select your bank"',
        mobEdit.firstOption === 'Select your bank', JSON.stringify(mobEdit.firstOption));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
