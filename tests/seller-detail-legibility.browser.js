// Seller identity line (PHONE / PAN / GSTIN / PLACE) — legibility guard.
//
// This is the line an operator reads before committing a lot to a seller:
// pick the wrong row and the lot is booked against the wrong person. It
// used to render at 11px with its labels in the --text3 token, which is
// 2.6-2.9:1 against the card background — under the 4.5:1 WCAG AA minimum
// for text this size, and the reason PHONE/PAN read as washed out.
//
// The checks below measure the REAL rendered element rather than asserting
// on the CSS source, so a token change elsewhere that quietly darkens or
// lightens these labels is caught too. Desktop and mobile are twins
// (leFmtSellerDetail / fmtSellerDetail) and are both covered.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerdetail-'));
const PORT = 47359;
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

// WCAG relative luminance + contrast, computed from the browser's own
// resolved rgb() values so themes and tokens are followed exactly.
const CONTRAST_FN = `
  function _lum(rgb){
    const c = rgb.map(v => { v = v/255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
    return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
  }
  function _parse(s){ const m = String(s).match(/\\d+(\\.\\d+)?/g) || []; return [ +m[0]||0, +m[1]||0, +m[2]||0 ]; }
  // Walk up for the first non-transparent background — the label sits on a
  // tinted band inside the row, not directly on the page.
  function _bgOf(el){
    let e = el;
    while (e) {
      const b = getComputedStyle(e).backgroundColor;
      const m = String(b).match(/\\d+(\\.\\d+)?/g);
      if (m && (m.length < 4 || parseFloat(m[3]) > 0) && b !== 'transparent') return _parse(b);
      e = e.parentElement;
    }
    return [255,255,255];
  }
  function contrastOf(el){
    const fg = _parse(getComputedStyle(el).color);
    const bg = _bgOf(el);
    const a = _lum(fg), b = _lum(bg);
    const hi = Math.max(a,b), lo = Math.min(a,b);
    return (hi + 0.05) / (lo + 0.05);
  }
`;

// One assertion set, run against whichever page/selector is passed in.
async function assertLegible(page, label, sel) {
  const m = await page.evaluate(`(() => {
    ${CONTRAST_FN}
    const sd = document.querySelector(${JSON.stringify(sel)});
    if (!sd) return { found:false };
    const lbl = sd.querySelector('span');
    const val = sd.querySelector('b');
    return {
      found: true,
      fontSize: parseFloat(getComputedStyle(sd).fontSize),
      labelContrast: lbl ? contrastOf(lbl) : null,
      labelWeight: lbl ? getComputedStyle(lbl).fontWeight : null,
      labelText: lbl ? lbl.textContent : null,
      valueContrast: val ? contrastOf(val) : null,
      valueText: val ? val.textContent : null,
    };
  })()`);

  check(`${label}: found the seller detail line`, m.found, sel);
  if (!m.found) return;
  check(`${label}: renders at 12px or larger`, m.fontSize >= 12, `${m.fontSize}px`);
  check(`${label}: "${m.labelText}" label meets 4.5:1 contrast`,
        m.labelContrast >= 4.5, `${(m.labelContrast || 0).toFixed(2)}:1`);
  check(`${label}: "${m.valueText}" value meets 4.5:1 contrast`,
        m.valueContrast >= 4.5, `${(m.valueContrast || 0).toFixed(2)}:1`);
  // The label must stay visually subordinate to the value it introduces,
  // or the line reads as a wall of equal-weight text.
  check(`${label}: value is at least as prominent as its label`,
        m.valueContrast >= m.labelContrast - 0.01,
        `label ${(m.labelContrast||0).toFixed(2)} vs value ${(m.valueContrast||0).toFixed(2)}`);
}

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, boot.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: { br1: 'CUMBUM' } });
  const auc = await api('POST', '/api/auctions', { ano: '12', date: '2026-08-22', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  await api('POST', `/api/auctions/${aid}/allocations`,
    { allocations: [{ branch: 'CUMBUM', start_lot: '1', end_lot: '40' }] });
  await api('POST', '/api/traders', {
    name: 'ABSAL SPICES', cr: '33ALCPU9807E1ZQ', pan: 'ALCPU9807E',
    tel: '9488818786', ppla: 'CUMBUM', pin: '625516', padd: 'MAIN ROAD',
  });
  // Separate accounts: single_session refuses to share one across pages.
  await api('POST', '/api/users', { username: 'deskop', password: 'pw1234', role: 'admin' });
  await api('POST', '/api/users', { username: 'fldop', password: 'pw1234', role: 'operator', branch: 'CUMBUM' });

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

  // ══ MOBILE ═════════════════════════════════════════════════════════
  console.log('[A] Mobile — Lot Entry seller search');
  const m = await browser.newPage();
  m.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.goto(B + '/mobile', { waitUntil: 'domcontentloaded' });
  await m.evaluate(() => localStorage.clear());
  await m.goto(B + '/mobile', { waitUntil: 'domcontentloaded' });
  await m.waitForSelector('#l-user', { timeout: 15000 });
  await m.evaluate(() => {
    document.getElementById('l-user').value = 'fldop';
    document.getElementById('l-pass').value = 'pw1234';
    doLogin();
  });
  await m.waitForFunction(() => document.getElementById('s-session')?.classList.contains('active'), { timeout: 20000 });
  await m.evaluate(() => { document.getElementById('ss-trade').selectedIndex = 1; startSession(); });
  await m.waitForFunction(() => document.getElementById('s-lots')?.classList.contains('active'), { timeout: 20000 });
  await m.evaluate(() => { document.getElementById('le-name').value = 'ABSAL'; searchTrader('ABSAL'); });
  await m.waitForFunction(() => document.querySelector('#le-res .sd'), { timeout: 20000 });
  await new Promise(r => setTimeout(r, 500));
  await assertLegible(m, 'mobile light', '#le-res .sd');

  // Dark mode uses a different token pair and has to clear the bar too.
  await m.evaluate(() => toggleDarkMode());
  await new Promise(r => setTimeout(r, 400));
  await assertLegible(m, 'mobile dark', '#le-res .sd');
  await m.evaluate(() => toggleDarkMode());

  // The "+ MORE" chip is a tap target, not decoration.
  const tog = await m.evaluate(() => {
    const t = document.querySelector('#le-res .sd-tog');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { fs: parseFloat(getComputedStyle(t).fontSize), h: r.height, w: r.width };
  });
  check('mobile: "+ MORE" chip is at least 10px', tog && tog.fs >= 10, JSON.stringify(tog));

  // ══ DESKTOP ════════════════════════════════════════════════════════
  console.log('\n[B] Desktop — Lot Entry seller search');
  const d = await browser.newPage();
  d.on('pageerror', e => { fail++; console.log('  FAIL desktop page error: ' + e.message); });
  await d.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await d.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await d.evaluate(() => localStorage.clear());
  await d.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await d.waitForSelector('#inp-u', { timeout: 15000 });
  await d.evaluate(() => {
    document.getElementById('inp-u').value = 'deskop';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await d.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  await d.evaluate(() => go('lotentry'));
  await new Promise(r => setTimeout(r, 1500));
  await d.evaluate(() => {
    const i = document.getElementById('le-seller-search');
    if (i) { i.value = 'ABSAL'; }
    leSearchSeller('ABSAL');
  });
  await d.waitForFunction(() => document.querySelector('#le-seller-results .le-seller-result'), { timeout: 20000 });
  await new Promise(r => setTimeout(r, 500));
  await assertLegible(d, 'desktop light', '#le-seller-results .le-seller-result > div:nth-child(2)');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('test crashed:', e, '\n', srvLog.slice(-3000));
  cleanup();
  process.exit(1);
});
