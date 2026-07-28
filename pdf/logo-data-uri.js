// ── Shared invoice-logo resolver ─────────────────────────────────────────
//
// Turns the company `logo` setting into a base64 data: URI the HTML invoice
// templates embed inline (CSP-safe — no external file request at print time).
//
// Previously each render-*.js kept its own copy that looked ONLY for
// `public/logo-<code>.png` — an exact, case-sensitive, PNG-only match. In
// practice that silently produced NO logo whenever the real file was a .jpg,
// had different casing (logo-RNS.png vs a code of "rns"), or simply hadn't
// been dropped in yet. Centralising here so every document type (sales,
// commission, agri) resolves the logo identically, and widening the match so
// a logo that IS present actually shows:
//   1. `logo-<code>.*`  — case-insensitive, any common image extension
//   2. `logo-default.*` / `logo.*` — a generic house logo, if the deployment
//      dropped one, so SOMETHING shows even when the coded file is missing
// It deliberately does NOT fall back to another customer's coded logo
// (e.g. logo-ispl.png) — showing the wrong brand is worse than showing none.
//
// Returns '' when nothing suitable exists; templates guard with
// `{{#if co.logoDataUri}}`.

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IMG_RE = /\.(png|jpg|jpeg|webp|gif)$/i;
const _cache = new Map();

function mimeFor(file) {
  const f = file.toLowerCase();
  if (f.endsWith('.jpg') || f.endsWith('.jpeg')) return 'image/jpeg';
  if (f.endsWith('.webp')) return 'image/webp';
  if (f.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

// Find the best on-disk logo file for `code`, or '' if none.
function resolveLogoFile(code) {
  let files;
  try { files = fs.readdirSync(PUBLIC_DIR); } catch (_) { return ''; }
  const images = files.filter((f) => IMG_RE.test(f));
  const wanted = ('logo-' + code).toLowerCase();
  // 1. Exact coded logo — case-insensitive, any image extension.
  let hit = images.find((f) => f.toLowerCase().replace(IMG_RE, '') === wanted);
  // 2. Generic house logo — explicit opt-in names only, so we never grab an
  //    unrelated image that happens to live in public/.
  if (!hit) hit = images.find((f) => /^(logo-default|logo)\.(png|jpg|jpeg|webp|gif)$/i.test(f));
  return hit ? path.join(PUBLIC_DIR, hit) : '';
}

// cfg.logo → data: URI (cached per code). Blank code falls back to 'ispl'
// to preserve the historical default for installs that never set a code.
function logoDataUri(cfg) {
  const code = String((cfg && cfg.logo) || '').trim() || 'ispl';
  if (_cache.has(code)) return _cache.get(code);
  let uri = '';
  try {
    const file = resolveLogoFile(code);
    if (file) uri = 'data:' + mimeFor(file) + ';base64,' + fs.readFileSync(file).toString('base64');
  } catch (_) { /* leave blank — template omits the <img> */ }
  _cache.set(code, uri);
  return uri;
}

// Test/hot-reload aid — drop the cache so a newly-added logo file is picked up
// without restarting the process.
function clearCache() { _cache.clear(); }

module.exports = { logoDataUri, resolveLogoFile, clearCache };
