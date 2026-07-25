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

// ── Backend 2: Puppeteer (plain Node / dev) ───────────────────────────────
let _pptrBrowserPromise = null;
function getPuppeteer() {
  try { return require('puppeteer'); } catch (_) {}
  try { return require('puppeteer-core'); } catch (_) {}
  return null;
}
async function renderViaPuppeteer(html) {
  const pptr = getPuppeteer();
  if (!pptr) return null;
  if (!_pptrBrowserPromise) {
    const launchOpts = { headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] };
    // puppeteer-core has no bundled Chromium — needs an explicit binary.
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    _pptrBrowserPromise = pptr.launch(launchOpts);
  }
  const browser = await _pptrBrowserPromise;
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
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
