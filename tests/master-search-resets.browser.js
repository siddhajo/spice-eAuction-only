// Sellers / Buyers — the search box must not outlive the screen.
//
// Opening either master ALWAYS reloads the full list: the tab loaders in go()
// call searchTraders('') / searchBuyers('') with no query at all. The box,
// though, is plain DOM and kept whatever was typed into it — so leaving
// Sellers with "KUMAR" in the box and coming back showed the box still
// reading KUMAR above a table of every seller on file. The control and the
// rows underneath it disagreed, and the box was the one lying.
//
// What these checks pin:
//   • coming back to either master shows an EMPTY box
//   • …and the full list, so box and rows agree
//   • the Incomplete-masters dropdown beside it is NOT reset — that one keeps
//     its value and its filtering, so it already agrees with the list, and
//     clearing it would throw away a filter the operator deliberately set
//   • both boxes carry the ids the rest of the page reads them by
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'master-search-'));
const PORT = 47366;
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

  // Two sellers and two buyers whose names share no substring, so a search
  // that narrows to one cannot be confused with a list that never narrowed.
  await api('POST', '/api/traders', { name: 'KUMAR ESTATE', tel: '9000000001', cr: 'CR.1' });
  await api('POST', '/api/traders', { name: 'ZEPHYR PLANTATIONS', tel: '9000000002', cr: 'CR.2' });
  await api('POST', '/api/buyers', { buyer: 'KM', buyer1: 'KUMAR TRADERS', tel: '9000000003' });
  await api('POST', '/api/buyers', { buyer: 'ZF', buyer1: 'ZEPHYR EXPORTS', tel: '9000000004' });

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
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1600, height: 950 });
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
  await new Promise(r => setTimeout(r, 1200));

  const open = async (tab) => {
    await page.evaluate((t) => go(t), tab);
    await new Promise(r => setTimeout(r, 900));
  };
  // The search box is typed into the way an operator does — through the very
  // handler the markup wires to oninput, so the debounce and the reload are
  // part of what is being tested rather than bypassed.
  const type = async (id, fn, q) => {
    await page.evaluate((id, fn, q) => {
      document.getElementById(id).value = q;
      window[fn](q);
    }, id, fn, q);
    await new Promise(r => setTimeout(r, 900));
  };
  const state = (id, bodyId) => page.evaluate((id, bodyId) => ({
    box: (document.getElementById(id) || {}).value,
    rows: document.querySelectorAll('#' + bodyId + ' tr').length,
  }), id, bodyId);

  console.log('[ids] both boxes are addressable');
  const ids = await page.evaluate(() => ({
    traders: !!document.getElementById('traders-search'),
    buyers: !!document.getElementById('buyers-search'),
  }));
  // setGlobalPageSize() reads both by id; without them it silently reloaded
  // the list with an empty query instead of the operator's.
  check('the sellers box has id="traders-search"', ids.traders, JSON.stringify(ids));
  check('the buyers box has id="buyers-search"', ids.buyers, JSON.stringify(ids));

  console.log('[sellers] a search survives nothing');
  await open('traders');
  const sAll = await state('traders-search', 'traders-list');
  check('the full seller list is shown on arrival', sAll.rows === 2, JSON.stringify(sAll));
  await type('traders-search', 'searchTradersDebounced', 'KUMAR');
  const sNarrow = await state('traders-search', 'traders-list');
  check('searching narrows it to the one match', sNarrow.rows === 1 && sNarrow.box === 'KUMAR', JSON.stringify(sNarrow));

  await open('dash');
  await open('traders');
  const sBack = await state('traders-search', 'traders-list');
  check('coming back shows an EMPTY box', sBack.box === '', JSON.stringify(sBack));
  check('…and the full list, so the two agree', sBack.rows === 2, JSON.stringify(sBack));

  console.log('[buyers] the same, on the other master');
  await open('buyers');
  await type('buyers-search', 'searchBuyersDebounced', 'KUMAR');
  const bNarrow = await state('buyers-search', 'buyers-list');
  check('searching narrows the buyer list', bNarrow.rows === 1 && bNarrow.box === 'KUMAR', JSON.stringify(bNarrow));
  await open('traders');
  await open('buyers');
  const bBack = await state('buyers-search', 'buyers-list');
  check('coming back shows an EMPTY box', bBack.box === '', JSON.stringify(bBack));
  check('…and the full list', bBack.rows === 2, JSON.stringify(bBack));

  console.log('[sellers] re-clicking the screen you are already on also resets');
  await type('traders-search', 'searchTradersDebounced', 'KUMAR');
  await open('traders');
  const sRe = await state('traders-search', 'traders-list');
  // The loader runs on every go(), so the list resets whether or not the tab
  // changed. The box has to follow it, or the same disagreement reappears.
  check('the box clears', sRe.box === '', JSON.stringify(sRe));
  check('…alongside the list it describes', sRe.rows === 2, JSON.stringify(sRe));

  console.log('[filter] the Incomplete dropdown is deliberately NOT reset');
  // It keeps its value AND its filtering across a visit, so control and rows
  // already agree. Clearing it would throw away a filter deliberately set.
  await page.evaluate(() => setMissingFilter('seller', 'gstin'));
  await new Promise(r => setTimeout(r, 900));
  const fNarrow = await page.evaluate(() => ({
    sel: document.getElementById('trader-missing').value,
    rows: document.querySelectorAll('#traders-list tr').length,
  }));
  check('the filter narrows the list', fNarrow.sel === 'gstin', JSON.stringify(fNarrow));
  await open('dash');
  await open('traders');
  const fBack = await page.evaluate(() => ({
    sel: document.getElementById('trader-missing').value,
    rows: document.querySelectorAll('#traders-list tr').length,
    box: document.getElementById('traders-search').value,
  }));
  check('the dropdown keeps the operator’s choice', fBack.sel === 'gstin', JSON.stringify(fBack));
  check('…and the rows still honour it', fBack.rows === fNarrow.rows, JSON.stringify({ fBack, fNarrow }));
  check('…while the search box is still cleared', fBack.box === '', JSON.stringify(fBack));

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
