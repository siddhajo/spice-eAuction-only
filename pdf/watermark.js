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
// WHERE IT SITS: ON TOP of the content, in BOTH engines.
//   • HTML   — a `position: fixed` layer (Chromium repeats fixed elements on
//     every printed page). Behind is not available: the templates paint their
//     own white page background, which would hide it completely.
//   • PDFKit — stamped at the END of each page's content. PDFKit streams, so
//     there is no natural "after everything" moment; we make one by stamping
//     the page that is being LEFT, from a wrapper on addPage(), plus the last
//     page from a wrapper on end(). Every page-break path goes through
//     addPage() — including PDFKit's own text-overflow break, via
//     continueOnNewPage() — so no page is missed.
//
// It used to be drawn FIRST on each PDFKit page, i.e. underneath. That read
// fine on an invoice over white, but it is invisible on the striped table
// exports: the zebra row fill, the header band and the subtotal band are
// OPAQUE rectangles, so every shaded row painted the mark out and the logo
// survived only in the gaps. Stamping last is what fixes that — the mark is
// now over the stripes, not under them, and the density setting it is drawn
// at is the one the operator chose (see below).

const fs = require('fs');
const { resolveLogoFile } = require('./logo-data-uri');

// How strongly the mark prints. Faint enough that a tax invoice stays legible
// and photocopies clean, strong enough to survive a print.
//
// Two values for ONE look: OPACITY is the density as configured, and
// OPACITY_OVER is what a mark drawn OVER the content has to be set to to LOOK
// like that density — ink sitting on top of text reads heavier than the same
// ink underneath it. Checked side by side at A4 against a full-colour logo.
// Both engines stamp on top (see the note above), so both use the OVER value;
// the plain one is what the setting means and what the ratio is applied to.
// The ratio is what matters, not the numbers: when the operator turns the
// density up, BOTH engines move together.
const OPACITY = 0.07;                            // the configured density
const OVER_RATIO = 0.05 / 0.07;                  // a mark ON TOP reads ~30% heavier
const OPACITY_OVER = OPACITY * OVER_RATIO;
// `pdf_watermark_density` is that 0.07 as a percentage, so an operator whose
// logo is too pale to read can simply turn it up. Clamped: under 1% nothing
// prints at all (and "off" is flag_pdf_watermark's job), over 60% it stops
// being a watermark and starts competing with the text it sits behind.
const DENSITY_MIN = 1, DENSITY_MAX = 60;
function watermarkOpacity(source) {
  const raw = _cfg(source).pdf_watermark_density;
  const n = raw === undefined || raw === null || String(raw).trim() === ''
    ? NaN : Number(raw);
  if (!Number.isFinite(n)) return OPACITY;        // unset or junk ⇒ the default
  return Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, n)) / 100;
}
// The same figure for the layer that sits ON TOP of the content.
function watermarkOpacityOver(source) {
  return watermarkOpacity(source) * OVER_RATIO;
}
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
  const opacity = Math.round(watermarkOpacityOver(source) * 10000) / 10000;
  return (
    '<style>' +
    '.doc-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
    `z-index:2147483000;opacity:${opacity};pointer-events:none;` +
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
function drawPdfkitWatermark(doc, file, opacity) {
  if (!doc || !doc.page || !file) return;
  const cx = doc.x, cy = doc.y;
  try {
    const w = doc.page.width, h = doc.page.height;
    const size = Math.min(w, h) * SIZE_PCT;
    doc.save();
    doc.opacity(opacity == null ? OPACITY : opacity);
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

// Stamp this document and every page it grows later. Call it any time after
// the PDFDocument is created — nothing is drawn at attach time, so unlike the
// old behind-the-content version it does not have to run before the first
// line of content. `source` is a flat cfg or a db handle — whichever the
// caller already has.
//
// Idempotent per document: the batch generators hand the same doc to each
// invoice's generator in turn, and each of those calls this — the guard is
// what stops the second invoice wrapping addPage()/end() a second time (which
// would double the opacity on every page from then on).
function attachPdfkitWatermark(doc, source) {
  return attachPdfkitWatermarkPath(doc, watermarkFile(source), watermarkOpacityOver(source));
}

// Same thing for a renderer that holds an ALREADY-RESOLVED file and no cfg or
// db — the shared table/slip renderers are handed a `companyHeader`, nothing
// more, and getCompanyHeader() resolves `watermarkPath` AND `watermarkOpacity`
// for exactly this (both blank/undefined when the toggle is off, so the
// decision still lives in one place). An absent `opacity` falls back to the
// built-in over-draw density rather than to the raw one, because this draws
// on top like everything else here.
function attachPdfkitWatermarkPath(doc, file, opacity) {
  if (!doc || doc._watermarkAttached) return doc;
  doc._watermarkAttached = true;     // set even with no file: nothing to retry
  if (!file) return doc;
  const op = opacity == null ? OPACITY_OVER : opacity;

  // Stamp the page we are LEAVING, so the mark lands over content already
  // drawn on it. Patched on the INSTANCE, so nothing else in the process is
  // affected, and `apply` keeps PDFKit's own `return this` chaining intact.
  const addPage = doc.addPage;
  doc.addPage = function (...args) {
    drawPdfkitWatermark(this, file, op);
    return addPage.apply(this, args);
  };

  // …and the final page, which no addPage() ever follows. doc.end() is called
  // exactly once by every renderer here, but the guard makes a second call
  // harmless rather than a second stamp.
  const end = doc.end;
  doc.end = function (...args) {
    if (!this._watermarkFinalPage) {
      this._watermarkFinalPage = true;
      drawPdfkitWatermark(this, file, op);
    }
    return end.apply(this, args);
  };
  return doc;
}

// Test/hot-reload aid — drop the embedded-image cache.
function clearCache() { _uriCache.clear(); }

module.exports = {
  watermarkOn, watermarkFile, watermarkHtml, withWatermark,
  attachPdfkitWatermark, attachPdfkitWatermarkPath, drawPdfkitWatermark, clearCache,
  watermarkOpacity, watermarkOpacityOver,
  OPACITY, OPACITY_OVER, OVER_RATIO, DENSITY_MIN, DENSITY_MAX, SIZE_PCT,
};
