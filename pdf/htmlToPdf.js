// ── HTML → PDF renderer ──────────────────────────────────────────────────
//
// Converts a full HTML document string into a PDF Buffer — the same Buffer
// shape the existing PDFKit generators return, so callers/routes don't change.
//
// Two backends, tried in order. The FIRST one that is usable wins:
//
//   1. Electron  — when this process IS the Electron main process (the packaged
//      desktop build). Uses a hidden BrowserWindow + webContents.printToPDF().
//      Chromium is already bundled with Electron, so this adds NO new heavy
//      dependency. This is the intended PRODUCTION path.
//
//   2. Puppeteer — when running as plain `node server.js` outside Electron
//      (dev/test, or a headless deploy). Requires `puppeteer` (bundles its own
//      Chromium) or `puppeteer-core` (point PUPPETEER_EXECUTABLE_PATH at any
//      installed Chrome/Edge/Electron binary). Lets you test templates fast
//      with `npm start` before wiring the Electron IPC path.
//
// If neither backend is available it throws a clear, actionable error rather
// than silently producing a blank PDF.
//
// A4 @ 0 margin — the template owns its own page padding via CSS, exactly like
// the PDFKit layouts owned their 20pt margin.

let _electron = null;
try { _electron = require('electron'); } catch (_) { /* not in Electron */ }

const PRINT_OPTS_ELECTRON = {
  printBackground: true,
  pageSize: 'A4',
  margins: { marginType: 'none' },
  preferCSSPageSize: true,
};

// ── Backend 1: Electron main process ──────────────────────────────────────
async function renderViaElectron(html) {
  const { BrowserWindow, app } = _electron;
  if (!BrowserWindow || !app || typeof app.whenReady !== 'function') return null;
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, javascript: false },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Give web fonts / images a tick to settle before printing.
    return await win.webContents.printToPDF(PRINT_OPTS_ELECTRON);
  } finally {
    win.destroy();
  }
}

// ── Backend 2: Puppeteer (plain Node — dev laptop AND Railway) ─────────────
let _pptrBrowserPromise = null;
const fs = require('fs');

function getPuppeteer() {
  try { return require('puppeteer'); } catch (_) {}
  try { return require('puppeteer-core'); } catch (_) {}
  return null;
}

// Common local browser binaries — used for dev so `node server.js` on a
// laptop "just works" with no env var.
const LOCAL_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

// Resolve which Chromium to launch, in priority order:
//   1. PUPPETEER_EXECUTABLE_PATH   (explicit override — any env)
//   2. a local Chrome/Chromium/Edge (dev laptop)
//   3. @sparticuz/chromium         (serverless / container, e.g. Railway)
//   4. puppeteer's bundled Chromium (if full `puppeteer` is installed)
// Returns { executablePath, args, headless } or null.
async function resolveChromium() {
  const baseArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: baseArgs, headless: true };
  }
  for (const p of LOCAL_BROWSERS) {
    try { if (fs.existsSync(p)) return { executablePath: p, args: baseArgs, headless: true }; } catch (_) {}
  }
  // Container Chromium (Railway). v149 nests the API under `.default`.
  try {
    const mod = require('@sparticuz/chromium');
    const chromium = mod && mod.default ? mod.default : mod;
    const ep = await chromium.executablePath();
    if (ep) {
      return {
        executablePath: ep,
        args: (chromium.args && chromium.args.length ? chromium.args : baseArgs),
        headless: chromium.headless == null ? true : chromium.headless,
      };
    }
  } catch (_) { /* not installed / not this platform */ }
  // Bundled puppeteer as a last resort.
  try {
    const pptr = require('puppeteer');
    if (typeof pptr.executablePath === 'function') {
      return { executablePath: pptr.executablePath(), args: baseArgs, headless: true };
    }
  } catch (_) {}
  return null;
}

// The launched Chromium is cached and reused across requests (launching costs
// ~1s), but it is a separate OS process that can die under us: an out-of-memory
// kill on a big batch, a crash, a laptop sleep, or the operator quitting the
// browser. Caching the promise alone meant one death poisoned the cache for the
// lifetime of the server — every later print failed with Puppeteer's
// "Connection closed." until someone restarted the app. So: drop the cache on
// disconnect (and on a failed launch, which would otherwise cache a rejected
// promise), and let the caller retry with a freshly launched browser.
function forgetBrowser(p) {
  if (_pptrBrowserPromise === p || p === undefined) _pptrBrowserPromise = null;
}

async function getBrowser(pptr) {
  if (_pptrBrowserPromise) {
    try {
      const b = await _pptrBrowserPromise;
      if (b && b.connected) return b;
    } catch (_) { /* previous launch failed — fall through and relaunch */ }
    _pptrBrowserPromise = null;
  }
  const chrome = await resolveChromium();
  if (!chrome) return null; // no browser binary anywhere — let caller throw
  const p = pptr.launch({
    executablePath: chrome.executablePath,
    args: chrome.args,
    headless: chrome.headless,
  });
  _pptrBrowserPromise = p;
  let browser;
  try {
    browser = await p;
  } catch (e) {
    forgetBrowser(p);         // never keep a rejected launch in the cache
    throw e;
  }
  browser.once('disconnected', () => forgetBrowser(p));
  return browser;
}

// True for the errors that mean "the browser went away", as opposed to a real
// problem with the HTML. Only these are worth a relaunch-and-retry.
function isDeadBrowserError(e) {
  const m = String((e && e.message) || e || '');
  return /Connection closed|Target closed|Session closed|Protocol error|browser has disconnected|Navigating frame was detached/i.test(m);
}

async function renderOnce(pptr, html) {
  const browser = await getBrowser(pptr);
  if (!browser) return null;
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    try { await page.close(); } catch (_) { /* browser already gone */ }
  }
}

async function renderViaPuppeteer(html) {
  const pptr = getPuppeteer();
  if (!pptr) return null;
  try {
    return await renderOnce(pptr, html);
  } catch (e) {
    if (!isDeadBrowserError(e)) throw e;
    // The cached Chromium had died. Relaunch once and try again, so an OOM on
    // one batch doesn't break every print until the server restarts.
    _pptrBrowserPromise = null;
    return await renderOnce(pptr, html);
  }
}

/**
 * htmlToPdf(html) → Promise<Buffer>
 * @param {string} html  A COMPLETE html document (<!doctype html>…</html>).
 */
async function htmlToPdf(html) {
  // Prefer Electron when we're actually inside it.
  if (_electron && _electron.app) {
    const out = await renderViaElectron(html);
    if (out) return Buffer.from(out);
  }
  const viaPptr = await renderViaPuppeteer(html);
  if (viaPptr) return Buffer.from(viaPptr);

  throw new Error(
    'htmlToPdf: no rendering backend available.\n' +
    '  • In the packaged Electron app, run PDF generation in the main process ' +
    '(this module auto-detects Electron).\n' +
    '  • For `node server.js` dev/test, install a renderer:\n' +
    '        npm i puppeteer            # bundles Chromium, zero config\n' +
    '     or npm i puppeteer-core       # then set PUPPETEER_EXECUTABLE_PATH\n'
  );
}

module.exports = { htmlToPdf };
