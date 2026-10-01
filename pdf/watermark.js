// ── Company-logo watermark on every PDF the app prints ───────────────────
//
// One rule, two engines, every document. The invoice family — sales invoice,
// purchase invoice, bill of supply, commission bill, debit note — plus every
// report, register, statement and slip that leaves here as a PDF carries the
// company logo faint and centred. Keeping both implementations in this one
// file is the point: a watermark that appears on some documents and not
// others is worse than none, because nobody can tell which one is the odd
// one out.
//
// The logo file is resolved by the SHARED resolver (logo-data-uri.js), so the
// watermark is the same image the header prints — including its fallbacks for
// odd extensions and casings. No logo on disk ⇒ no watermark, silently: a
// missing brand file must never fail a print.
//
// ── The toggle ───────────────────────────────────────────────────────────
// `flag_pdf_watermark` (default ON) governs ALL of it — one switch, because
// the value of the mark is that it is everywhere. `flag_invoice_watermark`
// is still read as a legacy alias for installs that set it before the scope
// widened past invoices. The flag is read per render, so flipping it takes
// effect on the next download with no restart.
//
// Deliberately NOT stamped: the thermal lot receipts (mobile-bridge) and the
// half-page crop receipt. Those are till-roll slips, not documents anyone
// files, and a centred mark on a 58mm receipt is just wasted ink.
//
// WHERE IT SITS, per engine, and why they differ:
//   • PDFKit — drawn at the TOP of each page, before any content, so it is
//     BEHIND the text. That is the only cheap option: PDFKit streams pages,
//     so there is no "after everything" moment to draw over.
//   • HTML   — a `position: fixed` layer ON TOP (Chromium repeats fixed
//     elements on every printed page). Behind is not available: the templates
//     paint their own white page background, which would hide it completely.
// At this opacity the difference is not visible — the text reads through
// either way — but a reader of this file should not have to wonder.

const fs = require('fs');
const { resolveLogoFile } = require('./logo-data-uri');

// Faint enough that a tax invoice stays legible and photocopies clean, strong
// enough to survive a print. Two values for ONE look: a mark drawn UNDER the
// content (PDFKit) reads lighter than the same mark drawn OVER it (HTML —
// see the note above for why each engine stacks the way it does), so the
// upper one is dialled back to land at the same visual weight. Checked
// side by side at A4 against a full-colour logo; keep them in that ratio if
// you retune.
const OPACITY = 0.07;        // PDFKit — behind the content
const OPACITY_OVER = 0.05;   // HTML    — on top of it
// Fraction of the SHORTER page edge the logo is fitted into. Centred, so the
// mark reads as a background rather than as content.
const SIZE_PCT = 0.55;

// Callers hand in whatever they already hold: the invoice generators carry a
// flat cfg, the report renderers carry a live db. Threading the other one
// through thirty call sites would be noise, so this resolves either.
function _cfg(source) {
  if (!source) return {};
  if (typeof source.get === 'function' && typeof source.all === 'function') {
    try { return require('../company-config').getSettingsFlat(source) || {}; }
    catch (_) { return {}; }          // settings unreadable ⇒ defaults
  }
  return source;
}

function watermarkOn(source) {
  const cfg = _cfg(source);
  // The canonical key first, then the pre-widening name, then the default.
  for (const key of ['flag_pdf_watermark', 'flag_invoice_watermark']) {
    const v = cfg[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean') return v;
    return String(v).toLowerCase() === 'true';
  }
  return true;                        // default ON
}

// Absolute path of the logo to stamp, or '' when the feature is off or no
// logo file exists. Blank logo code falls back to 'ispl', matching
// logoDataUri() — the two must pick the SAME file or the header and the
// watermark would show different brands.
function watermarkFile(source) {
  const cfg = _cfg(source);
  if (!watermarkOn(cfg)) return '';
  const code = String(cfg.logo || '').trim() || 'ispl';
  try { return resolveLogoFile(code) || ''; } catch (_) { return ''; }
}

// ── HTML engine ──────────────────────────────────────────────────────────
const _uriCache = new Map();
function _dataUri(file) {
  if (_uriCache.has(file)) return _uriCache.get(file);
  let uri = '';
  try {
    const f = file.toLowerCase();
    const mime = f.endsWith('.jpg') || f.endsWith('.jpeg') ? 'image/jpeg'
      : f.endsWith('.webp') ? 'image/webp'
      : f.endsWith('.gif') ? 'image/gif' : 'image/png';
    uri = 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
  } catch (_) { uri = ''; }
  _uriCache.set(file, uri);
  return uri;
}

// The markup + CSS injected into a rendered template. `position: fixed` is
// what makes Chromium repeat it on every page of the print; `pointer-events`
// and the print-colour-adjust hint keep it out of the way of everything else.
// The image is embedded as a data: URI because the renderer loads the page
// from setContent / a data: URL, where file:// requests are blocked.
function watermarkHtml(source) {
  const file = watermarkFile(source);
  if (!file) return '';
  const uri = _dataUri(file);
  if (!uri) return '';
  return (
    '<style>' +
    '.doc-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
    `z-index:2147483000;opacity:${OPACITY_OVER};pointer-events:none;` +
    'display:flex;align-items:center;justify-content:center;' +
    `width:${Math.round(SIZE_PCT * 100)}%;max-width:${Math.round(SIZE_PCT * 100)}vw;` +
    '-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.doc-watermark img{width:100%;height:auto;object-fit:contain}' +
    '</style>' +
    `<div class="doc-watermark" aria-hidden="true"><img src="${uri}" alt=""></div>`
  );
}

// Inject the watermark into a rendered document, once, as late in the body as
// possible. Called on the FINAL html of a document — never per template render
// — because the commission bill concatenates N rendered pages into one
// document and N stacked copies of a 7% layer is a 40% one.
function withWatermark(html, source) {
  const block = watermarkHtml(source);
  if (!block) return html;
  const s = String(html == null ? '' : html);
  if (s.includes('class="doc-watermark"')) return s;   // already stamped
  const i = s.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? s + block : s.slice(0, i) + block + s.slice(i);
}

// ── PDFKit engine ────────────────────────────────────────────────────────
// Draw the mark on the CURRENT page. Everything it touches is restored:
// save()/restore() covers the graphics state (opacity, colours), and the text
// cursor is put back by hand because PDFKit does not include doc.x / doc.y in
// the graphics stack — leaving it moved would shift the first thing the
// invoice draws afterwards.
function drawPdfkitWatermark(doc, file) {
  if (!doc || !doc.page || !file) return;
  const cx = doc.x, cy = doc.y;
  try {
    const w = doc.page.width, h = doc.page.height;
    const size = Math.min(w, h) * SIZE_PCT;
    doc.save();
    doc.opacity(OPACITY);
    doc.image(file, (w - size) / 2, (h - size) / 2, {
      fit: [size, size], align: 'center', valign: 'center',
    });
  } catch (_) {
    // A corrupt or unsupported image must not take the invoice down with it.
  } finally {
    try { doc.restore(); } catch (_) {}
    doc.x = cx; doc.y = cy;
  }
}

// Stamp this document and every page it grows later. Call it immediately after
// the PDFDocument is created and BEFORE anything is drawn, so page 1 gets the
// mark underneath its content like every other page. `source` is a flat cfg
// or a db handle — whichever the caller already has.
//
// Idempotent per document: the batch generators hand the same doc to each
// invoice's generator in turn, and each of those calls this — the guard is
// what stops the second invoice adding a second 'pageAdded' listener (which
// would double the opacity on every page after it).
function attachPdfkitWatermark(doc, source) {
  return attachPdfkitWatermarkPath(doc, watermarkFile(source));
}

// Same thing for a renderer that holds an ALREADY-RESOLVED file and no cfg or
// db — the shared table/slip renderers are handed a `companyHeader`, nothing
// more, and getCompanyHeader() resolves `watermarkPath` for exactly this
// (blank when the toggle is off, so the decision still lives in one place).
function attachPdfkitWatermarkPath(doc, file) {
  if (!doc || doc._watermarkAttached) return doc;
  doc._watermarkAttached = true;     // set even with no file: nothing to retry
  if (!file) return doc;
  drawPdfkitWatermark(doc, file);                        // page 1, already open
  doc.on('pageAdded', () => drawPdfkitWatermark(doc, file));
  return doc;
}

// Test/hot-reload aid — drop the embedded-image cache.
function clearCache() { _uriCache.clear(); }

module.exports = {
  watermarkOn, watermarkFile, watermarkHtml, withWatermark,
  attachPdfkitWatermark, attachPdfkitWatermarkPath, drawPdfkitWatermark, clearCache,
  OPACITY, OPACITY_OVER, SIZE_PCT,
};
