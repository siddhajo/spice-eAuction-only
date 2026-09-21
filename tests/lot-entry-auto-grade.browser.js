// Lot Entry — the grade a seller auto-fills, on the desktop console and the
// mobile PWA, in a headless Chrome.
//
// The rule (2026-09-21): a seller whose CR field holds a GSTIN is GRADE 2,
// whether or not the SBL (Aadhar) field is filled. Anything else is Grade 1.
// This is the GSTIN-only rule the purchase invoice, bill of supply and
// debit-note eligibility already run on; grading on GSTIN+SBL instead left a
// dealer with a blank SBL stamped Grade 1, so they drew an RD purchase invoice
// while the dealer debit note skipped them — 18 purchases, 16 debit notes.
//
// Pinned here:
//   [D] desktop: GSTIN + SBL → 2, GSTIN + blank SBL → 2, no GSTIN → 1
//   [M] mobile: the same three, through pickTrader
//   [T] mobile's last-lot template REFINES the grade but cannot contradict it:
//       "1A" may land over a computed "1", a stale "2" may NOT land over a
//       computed "1". That override is what made the same seller default
//       differently on two phones — it echoed whatever they were first given.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'le-grade-'));
const PORT = 47375;
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

// The three sellers the rule has to tell apart. WITHSBL and NOSBL differ ONLY
// in the SBL field — under the old GSTIN+SBL rule they graded differently.
const SELLERS = [
  { key: 'withSbl', name: 'WITHSBL DEALER', cr: 'GSTIN.32AAHCE4551A1Z8', aadhar: 'ML/REG/10001/2021', want: '2' },
  { key: 'noSbl',   name: 'NOSBL DEALER',   cr: 'GSTIN.32AADTC2421J1Z7', aadhar: '',                  want: '2' },
  { key: 'planter', name: 'PLAIN PLANTER',  cr: 'CR.4455/19',            aadhar: '',                  want: '1' },
];

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  for (const s of SELLERS) {
    const r = await api('POST', '/api/traders', {
      name: s.name, cr: s.cr, aadhar: s.aadhar, pan: 'AAHCE4551A', tel: '9000010001' });
    s.id = r.d && (r.d.id || (r.d.trader && r.d.trader.id));
    if (!s.id) { console.error('trader create failed', s.name, r.status, r.d); cleanup(); process.exit(1); }
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

  // ══ DESKTOP ══════════════════════════════════════════════════════
  console.log('[D] desktop lot entry');
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('lotentry'); });
  await page.waitForSelector('#le-grade', { timeout: 15000 });

  for (const s of SELLERS) {
    const got = await page.evaluate((seller) => {
      lePickSeller(seller);
      return document.getElementById('le-grade').value;
    }, { id: s.id, name: s.name, cr: s.cr, aadhar: s.aadhar });
    check(`${s.name} → Grade ${s.want}`, got === s.want, 'got ' + got);
  }

  // ══ MOBILE ═══════════════════════════════════════════════════════
  console.log('\n[M] mobile lot entry');
  const mob = await browser.newPage();
  mob.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await mob.evaluate(tok => { localStorage.setItem('sa_token', tok); }, TOKEN);
  await mob.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await mob.waitForSelector('#le-grade', { timeout: 15000 });

  // pickTrader fires fetchSellerTemplate, which resolves AFTER it returns and
  // used to clobber the grade. Read the box only once that has settled, so the
  // assertion covers the value the operator actually ends up looking at.
  const mobPick = async (s, lastLotGrade) => {
    await mob.evaluate((seller, last) => {
      // Stand in for GET /api/traders/:id/last-lot so the seller's history is
      // part of the fixture rather than something to seed through lot saves.
      if (!window.__realFetch) window.__realFetch = window.fetch;
      window.fetch = function (u, o) {
        if (String(u).indexOf('/last-lot') >= 0) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({
            lastLot: last ? { grade: last } : null, banks: [] }) });
        }
        return window.__realFetch.call(window, u, o);
      };
      window.__tplDone = false;
      Promise.resolve(pickTrader(seller)).then(() => {});
      // fetchSellerTemplate is fire-and-forget inside pickTrader; one more turn
      // of the microtask queue plus a tick is enough for the stubbed fetch.
      setTimeout(() => { window.__tplDone = true; }, 50);
    }, { id: s.id, name: s.name, cr: s.cr, aadhar: s.aadhar }, lastLotGrade || null);
    await mob.waitForFunction(() => window.__tplDone === true, { timeout: 5000 });
    return mob.evaluate(() => document.getElementById('le-grade').value);
  };

  for (const s of SELLERS) {
    const got = await mobPick(s, null);
    check(`${s.name} → Grade ${s.want}`, got === s.want, 'got ' + got);
  }

  console.log('\n[T] the last-lot template refines but cannot contradict');
  const refined = await mobPick(SELLERS[2], '1A');
  check('a planter\'s previous "1A" is recalled over the computed "1"',
        refined === '1A', 'got ' + refined);
  const refined2 = await mobPick(SELLERS[0], '2A');
  check('a dealer\'s previous "2A" is recalled over the computed "2"',
        refined2 === '2A', 'got ' + refined2);

  const stale = await mobPick(SELLERS[2], '2');
  check('a planter\'s stale "2" does NOT override the computed "1"',
        stale === '1', 'got ' + stale);
  const stale2 = await mobPick(SELLERS[1], '1');
  check('a GSTIN dealer\'s stale "1" does NOT override the computed "2"',
        stale2 === '2', 'got ' + stale2);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
