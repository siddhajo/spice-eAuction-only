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
//
// The optional second argument opens up Chromium's PRINT HEADER/FOOTER, the one
// place a running "Page 2 of 3" can come from: page content can't know which
// page it lands on, and Chromium implements neither `@page` margin boxes nor
// `counter(page)` outside them. Templates are plain HTML drawn into the page
// margins, with <span class="pageNumber"> / <span class="totalPages"> filled in
// per page. See htmlToPdf() below for the option shape.

let _electron = null;
try { _electron = require('electron'); } catch (_) { /* not in Electron */ }

const PT_PER_INCH = 72;
const PX_PER_PT = 96 / 72;   // CSS px per pt — Puppeteer margins are px/in/cm

// Normalize the caller's print options ONCE, so both backends are driven from
// the same values and can't drift apart. Returns null when there's nothing to
// apply (the common case), which keeps the default render byte-identical.
// NOTE on margins: a template's own `@page { margin: … }` WINS over the values
// passed here — Chromium treats CSS page margins as the authority, whatever
// `preferCSSPageSize` says. So a caller that wants room for a header/footer has
// to declare the same margin in its stylesheet; these values are sent too so
// the two can't silently disagree, and so a template with no @page margin rule
// still gets the space it asked for.
function normalizePrint(opts) {
  const o = opts || {};
  const header = o.header ? String(o.header) : '';
  const footer = o.footer ? String(o.footer) : '';
  const top = Number(o.marginTop) || 0;
  const bottom = Number(o.marginBottom) || 0;
  const ranges = o.pageRanges ? String(o.pageRanges) : '';
  if (!header && !footer && !top && !bottom && !ranges) return null;
  // Chromium drops a header/footer template that has no margin to live in.
  return { header, footer, top, bottom, ranges, wantsHF: !!(header || footer) };
}

const PRINT_OPTS_ELECTRON = {
  printBackground: true,
  pageSize: 'A4',
  margins: { marginType: 'none' },
  preferCSSPageSize: true,
};

// Electron's printToPDF takes margins in INCHES; pageRanges/header/footer
// mirror the CDP names.
function electronOpts(print) {
  if (!print) return PRINT_OPTS_ELECTRON;
  const out = {
    ...PRINT_OPTS_ELECTRON,
    margins: {
      marginType: 'custom',
      top: print.top / PT_PER_INCH,
      bottom: print.bottom / PT_PER_INCH,
      left: 0,
      right: 0,
    },
  };
  if (print.wantsHF) {
    out.displayHeaderFooter = true;
    // An empty string makes Chromium fall back to its DEFAULT template (date /
    // title / url), so a blank header must be sent as empty markup instead.
    out.headerTemplate = print.header || '<span></span>';
    out.footerTemplate = print.footer || '<span></span>';
  }
  if (print.ranges) out.pageRanges = print.ranges;
  return out;
}

function puppeteerOpts(print) {
  const base = { format: 'A4', printBackground: true, preferCSSPageSize: true };
  if (!print) return base;
  const px = (pt) => `${pt * PX_PER_PT}px`;
  const out = {
    ...base,
    margin: { top: px(print.top), bottom: px(print.bottom), left: '0px', right: '0px' },
  };
  if (print.wantsHF) {
    out.displayHeaderFooter = true;
    out.headerTemplate = print.header || '<span></span>';
    out.footerTemplate = print.footer || '<span></span>';
  }
  if (print.ranges) out.pageRanges = print.ranges;
  return out;
}

// ── Backend 1: Electron main process ──────────────────────────────────────
async function renderViaElectron(html, print) {
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
    return await win.webContents.printToPDF(electronOpts(print));
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

async function renderOnce(pptr, html, print) {
  const browser = await getBrowser(pptr);
  if (!browser) return null;
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf(puppeteerOpts(print));
  } finally {
    try { await page.close(); } catch (_) { /* browser already gone */ }
  }
}

async function renderViaPuppeteer(html, print) {
  const pptr = getPuppeteer();
  if (!pptr) return null;
  try {
    return await renderOnce(pptr, html, print);
  } catch (e) {
    if (!isDeadBrowserError(e)) throw e;
    // The cached Chromium had died. Relaunch once and try again, so an OOM on
    // one batch doesn't break every print until the server restarts.
    _pptrBrowserPromise = null;
    return await renderOnce(pptr, html, print);
  }
}

/**
 * htmlToPdf(html, opts) → Promise<Buffer>
 * @param {string} html  A COMPLETE html document (<!doctype html>…</html>).
 * @param {object} [opts]  Print-engine extras. Omit for the plain full-bleed
 *   render every document used before this existed.
 *   @param {string} [opts.header]  HTML drawn into the TOP page margin of every
 *     page. `<span class="pageNumber">` and `<span class="totalPages">` are
 *     substituted per page. Needs opts.marginTop to have room to draw in.
 *   @param {string} [opts.footer]  Same, into the bottom margin.
 *   @param {number} [opts.marginTop]     Top page margin, in pt.
 *   @param {number} [opts.marginBottom]  Bottom page margin, in pt.
 *   @param {string} [opts.pageRanges]  e.g. '3' or '1-2'. Only those pages are
 *     emitted, and each KEEPS its number in the whole document — which is what
 *     lets a caller re-render just the last page with a different footer.
 */
async function htmlToPdf(html, opts) {
  const print = normalizePrint(opts);
  // Prefer Electron when we're actually inside it.
  if (_electron && _electron.app) {
    const out = await renderViaElectron(html, print);
    if (out) return Buffer.from(out);
  }
  const viaPptr = await renderViaPuppeteer(html, print);
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
