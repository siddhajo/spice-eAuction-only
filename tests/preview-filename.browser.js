// A PREVIEWED DOCUMENT SAVES UNDER ITS REAL NAME — THE CLIENT HALF.
//
// preview-links.http.js pins the SERVER: ask any PDF route for
// `?previewlink=1` and it parks the bytes and answers with
// `/p/<id>/<Real Name>.pdf`. That is useless unless the page actually asks.
//
// It mostly did not. Preview and Print fetched the PDF with the auth header,
// wrapped it in a Blob and opened the object URL — and a blob URL is
// `blob:https://host/<uuid>`, with no path and no headers, so Chrome's PDF
// viewer offered "9a1281db-2001-4c06-9474-8cf409c0cc22" in Save As. Three
// helpers carried almost every document viewer in the app between them, so
// the fix is in three places and this test drives those three places.
//
//   [helpers]  fetchPdfWithOverlay / fetchAndPrint / _openPdfInTab each ask
//              for a link and open a NAMED url — never a blob
//   [name]     the name in that url is, character for character, the name
//              the direct download gives. This is the whole bug: the two
//              must not be allowed to drift apart again
//   [fallback] an endpoint that answers with bytes anyway still shows the
//              document rather than failing in front of the operator
//   [source]   no Preview/Print path is left opening a blob in a tab. A
//              behavioural test can only drive the screens it builds a
//              fixture for; this catches the fourth helper somebody adds.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prevname-'));
const PORT = 3000 + Math.floor(Math.random() * 1500) + 400;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' },
                                   TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
// The name a DIRECT download offers, read off Content-Disposition.
async function directName(url, body) {
  const r = await fetch(B + url, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + TOKEN },
                           body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '');
  return m ? m[1] : '';
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
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
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  TOKEN = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  if (!TOKEN) { console.error('login failed\n' + srvLog.slice(-1500)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await api('PUT', '/api/company-settings', { settings: { gunny_rate: '150', br1: 'BODI' } });

  const A = (await api('POST', '/api/auctions',
    { ano: '24', date: '2026-11-10', crop_type: 'ISP', state: 'TAMIL NADU' })).d.id;
  await api('POST', `/api/auctions/${A}/allocations`,
    { allocations: [{ branch: 'BODI', from_no: 1, to_no: 40 }] });
  const sel = (await api('POST', '/api/traders',
    { name: 'GANESHBABU', tel: '9790744444', place: 'CUMBUM' })).d;
  const sid = sel.id || sel.trader_id;
  await api('POST', '/api/lots', { auction_id: A, lot_no: '016', trader_id: sid,
    name: 'GANESHBABU', branch: 'BODI', bags: 1, qty: 33.9, gross_wt: 34.9 });
  const lots = (await api('GET', `/api/lots/${A}`)).d;
  const lotId = (Array.isArray(lots) ? lots : [])[0].id;

  // The receipt is a plain res.send(buffer) route that does NOT call
  // sendPdfDocument — so it also proves the app-wide interceptor from the
  // page's side, not just the four routes wired by hand.
  const RECEIPT = `/api/receipt/${lotId}`;
  const wantName = await directName(RECEIPT);
  check('fixture: the receipt renders and is named by the server',
    /^Receipt.*\.pdf$/.test(wantName), { name: wantName });

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1500, height: 920 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  await page.waitForFunction(() => typeof fetchPdfWithOverlay === 'function'
    && typeof fetchAndPrint === 'function' && typeof _openPdfInTab === 'function', { timeout: 20000 });

  // Record what the page asks for and what it opens, without ever letting a
  // real tab open. window.open returns a stub with addEventListener so the
  // print variants don't throw.
  await page.evaluate(() => {
    window.__opened = [];
    window.__fetched = [];
    window.open = (href) => {
      window.__opened.push(String(href));
      return { addEventListener() {}, focus() {}, print() {}, closed: false };
    };
    const realFetch = window.fetch;
    window.fetch = function (u, init) {
      try { window.__fetched.push(String(typeof u === 'string' ? u : (u && u.url) || '')); } catch (_) {}
      return realFetch.apply(this, arguments);
    };
  });
  const drive = async (fn) => {
    await page.evaluate(() => { window.__opened = []; window.__fetched = []; });
    // fn arrives as source text, so it must be CALLED — page.evaluate on a
    // bare arrow just builds the function and returns it, which is how the
    // first version of this test passed while driving nothing at all.
    await page.evaluate(`(${fn})()`);
    // The helpers open the tab after their overlay comes down.
    await page.waitForFunction(() => window.__opened.length > 0, { timeout: 20000 })
      .catch(() => {});
    return page.evaluate(() => ({ opened: window.__opened.slice(), fetched: window.__fetched.slice() }));
  };

  // One place for the three assertions each helper must satisfy.
  const expectNamedLink = (label, got, want) => {
    const href = got.opened[0] || '';
    const asked = got.fetched.find(u => /previewlink=1/.test(u)) || '';
    check(`${label}: asks the endpoint for a preview LINK`, !!asked,
          { fetched: got.fetched });
    check(`${label}: opens a /p/ url, never a blob:`,
          /\/p\/[0-9a-f]{32}\//.test(href) && href.indexOf('blob:') !== 0,
          { opened: got.opened });
    const last = decodeURIComponent(String(href).split('/').pop() || '');
    check(`${label}: and that url ends in the document's REAL name`,
          !!want && last === want, { opened: last, want });
  };

  // ── [helpers] ────────────────────────────────────────────────────
  // These three carry the document viewers across the app: the transaction
  // menu's invoices, bills, debit notes and vouchers go through the first
  // two (21 call sites between them), the exports and lorry reports through
  // the third. Driving the helper is what covers all of them.
  console.log('\n[helpers] every viewer opens a named url, not a blob');

  expectNamedLink('fetchPdfWithOverlay',
    await drive(`() => fetchPdfWithOverlay('Building…', '${RECEIPT}', 'Fallback.pdf')`), wantName);

  expectNamedLink('fetchAndPrint',
    await drive(`() => fetchAndPrint('${RECEIPT}', 'Fallback.pdf')`), wantName);

  expectNamedLink('_openPdfInTab',
    await drive(`() => _openPdfInTab(B + '${RECEIPT}')`), wantName);

  // A POST-bodied preview — the pre-invoice and the report widgets use this
  // shape, and it used to be a separate hand-rolled fetch in each screen.
  const rptSpec = { title: 'Lot Register', columns: [{ header: 'Lot', key: 'lot' }],
                    rows: [{ lot: '016' }], inline: 1 };
  const rptGot = await drive(`() => _openPdfInTab(B + '/api/report-pdf', { postBody: ${JSON.stringify(rptSpec)} })`);
  expectNamedLink('_openPdfInTab (POST body)', rptGot,
    await directName('/api/report-pdf', rptSpec));

  // ── [name] the two names must never drift ────────────────────────
  console.log('\n[name] the preview name is the download name');
  const dlName = await page.evaluate(async (u, t) => {
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + t } });
    const m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '');
    return m ? m[1] : '';
  }, B + RECEIPT, TOKEN);
  const prevGot = await drive(`() => _openPdfInTab(B + '${RECEIPT}')`);
  const prevName = decodeURIComponent(String(prevGot.opened[0] || '').split('/').pop() || '');
  check('the page sees the same name on both paths', !!dlName && dlName === prevName,
        { download: dlName, preview: prevName });
  check('…and it is the server-side name, not one the page invented',
        prevName === wantName, { page: prevName, server: wantName });

  // ── [fallback] bytes instead of a link still shows the document ──
  console.log('\n[fallback] an endpoint answering with bytes still works');
  const fb = await page.evaluate(async (recv) => {
    // Pretend the endpoint never learned about preview links: hand back a
    // PDF body. The viewer must still open something rather than toast.
    const realFetch = window.fetch;
    window.__opened = [];
    window.fetch = async () => new Response(new Blob([new Uint8Array([37, 80, 68, 70, 45])],
      { type: 'application/pdf' }), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    try { await _openPdfInTab(B + recv); } finally { window.fetch = realFetch; }
    return window.__opened.slice();
  }, RECEIPT);
  check('it falls back to a blob tab rather than failing',
        fb.length === 1 && fb[0].indexOf('blob:') === 0, { opened: fb });

  // ── [source] nothing is left opening a blob in a tab ─────────────
  // The behavioural checks above can only reach screens this fixture builds.
  // This catches a NEW Preview button wired the old way — which is how the
  // bug got in, twice.
  console.log('\n[source] no viewer is left opening a blob in a tab');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const lines = src.split('\n');
  const offenders = [];
  lines.forEach((ln, i) => {
    if (!/createObjectURL/.test(ln)) return;
    const ctx = lines.slice(Math.max(0, i - 6), i + 10).join('\n');
    const opensTab = /window\.open\(|\.src\s*=\s*[`'"]?\$?\{?url|location\.(href|assign)/.test(ctx);
    const downloads = /\.download\s*=/.test(ctx);
    // triggerBrowserPrint is the deliberate last resort: it is handed BYTES
    // that were already fetched, so there is no url for it to name. Every
    // caller now goes through a preview link first and only lands here when
    // the server answered with bytes.
    const inFallback = /async function triggerBrowserPrint/.test(ctx)
      || /falls back to a blob tab/.test(ctx)
      || /_openPdfInTab\(/.test(ctx);
    if (opensTab && !downloads && !inFallback) offenders.push((i + 1) + ': ' + ln.trim().slice(0, 90));
  });
  check('every blob a tab could receive is an explicit fallback',
        offenders.length === 0, { offenders });

  const stillBlobby = [
    'printDebitNote', 'printDebitNotePlanter', 'piPreviewPdf', 'printTradeSummary',
  ].filter(fn => {
    const m = new RegExp('function ' + fn + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]{0,1400}?)\\n\\}', 'm').exec(src);
    const body = m ? m[1] : '';
    // Each must now reach a preview link; none may build its own blob tab.
    return !/_openPdfInTab|_pdfPreviewHref/.test(body);
  });
  check('the per-screen viewers all route through a preview link',
        stillBlobby.length === 0, { notConverted: stillBlobby });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nCRASHED:', e && e.stack || e);
  console.error('\n--- server log ---\n' + srvLog.slice(-2500));
  cleanup();
  process.exit(1);
});
