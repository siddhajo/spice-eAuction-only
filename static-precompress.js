/**
 * static-precompress.js — serve the big static assets pre-compressed.
 *
 * Why this exists instead of just using the `compression` middleware:
 *
 * public/index.html is a single 2.59 MB file (74% of it inline <script>).
 * The HTML is deliberately sent `no-store` — see the cache middleware in
 * server.js, which exists because ngrok/proxy caching served operators a
 * stale UI — so there is no browser cache to fall back on and the full
 * payload goes out on EVERY page load.
 *
 * Compressing it is clearly right: 2.59 MB -> 585 KB (4.5x). But doing it
 * per-request with the generic middleware costs ~71 ms of gzip at its default
 * level, and that CPU lands on the one event loop this process has. sql.js
 * queries and PDF generation are already synchronous — perf-monitor.js exists
 * precisely because one blocking request stalls every other in-flight one,
 * and it warns at 200 ms. Paying 71 ms per homepage load, over and over, to
 * recompute the identical bytes of a file that only changes on deploy is the
 * wrong trade.
 *
 * So compress each file ONCE and cache the result in memory:
 *   - per-request CPU drops to zero (just write a cached Buffer)
 *   - we can afford stronger settings than a per-request budget allows
 *   - the event loop is never blocked by compression
 *
 * The warm-up itself uses the ASYNC zlib calls on purpose: those run on
 * libuv's threadpool, not the event loop, so building the cache at boot
 * doesn't block request handling either. Until an encoding is ready, requests
 * simply fall through to the normal static handler — the cache is an
 * optimization, never a correctness requirement.
 *
 * Measured on index.html (2.59 MB):
 *   brotli q9  -> 585 KB (4.54x) in 140 ms   <- chosen
 *   brotli q11 -> 537 KB (4.95x) in 4190 ms  <- 30x the cost for 8% less
 *   gzip   l9  -> 724 KB (3.67x) in 110 ms   <- fallback for old clients
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Only text-ish assets. Images/PDFs are already compressed — re-deflating
// them burns CPU for nothing.
const COMPRESSIBLE = /\.(html|js|css|json|svg|map|txt|xml)$/i;
// Below this, the encoding header costs more than the saving.
const MIN_BYTES = 1024;

const GZIP_OPTS = { level: 9 };
const BROTLI_OPTS = (size) => ({
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
  },
});

/**
 * cache: urlPath -> { mtimeMs, size, br?: Buffer, gzip?: Buffer }
 * Keyed by the URL path ('/index.html'), which is what we match requests on.
 */
const cache = new Map();

function listFiles(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, root, out);
    else if (COMPRESSIBLE.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Compress one file into the cache. Async (threadpool) so boot-time warming
 * never blocks the event loop.
 */
function warmFile(absPath, root) {
  let st;
  try {
    st = fs.statSync(absPath);
  } catch {
    return;
  }
  if (st.size < MIN_BYTES) return;

  const urlPath = '/' + path.relative(root, absPath).split(path.sep).join('/');
  const existing = cache.get(urlPath);
  // Already cached at this exact version — nothing to do.
  if (existing && existing.mtimeMs === st.mtimeMs && existing.br && existing.gzip) return;

  let raw;
  try {
    raw = fs.readFileSync(absPath);
  } catch {
    return;
  }

  // Seed the entry so a concurrent request sees the current mtime and
  // correctly falls through until the buffers land.
  const entry = { mtimeMs: st.mtimeMs, size: st.size };
  cache.set(urlPath, entry);

  zlib.brotliCompress(raw, BROTLI_OPTS(raw.length), (err, buf) => {
    if (!err && buf) entry.br = buf;
  });
  zlib.gzip(raw, GZIP_OPTS, (err, buf) => {
    if (!err && buf) entry.gzip = buf;
  });
}

/** Warm every compressible file under `root`. Safe to call more than once. */
function warm(root) {
  const files = listFiles(root, root, []);
  for (const f of files) warmFile(f, root);
  return files.length;
}

/**
 * Pick the best encoding the client accepts. Deliberately simple: we only
 * ever offer br and gzip, and we ignore q-values — a client that lists an
 * encoding at q=0 is rare enough, and the cost of getting it wrong is a
 * fallthrough to uncompressed, not a broken response.
 */
function pickEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (!accept) return null;
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

/**
 * Express middleware. Mount BEFORE express.static and before the generic
 * `compression` middleware so the heavy static assets are served from cache
 * and never hit the per-request compressor.
 *
 * `root` is the directory being served (public/). Anything not in the cache
 * — a miss, a stale mtime, an encoding the client won't take — calls next()
 * and is handled exactly as before.
 */
function middleware(root) {
  return function precompressed(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // '/' is served as index.html by express.static; match that here too.
    let urlPath = req.path === '/' ? '/index.html' : req.path;
    if (!COMPRESSIBLE.test(urlPath)) return next();

    const entry = cache.get(urlPath);
    if (!entry) return next();

    const enc = pickEncoding(req);
    if (!enc) return next();
    const body = entry[enc];
    if (!body) return next(); // still warming

    // Re-check mtime so an edited file is never served from a stale cache.
    // In dev the file changes under us; in production this is a cheap stat.
    const abs = path.join(root, urlPath);
    try {
      if (fs.statSync(abs).mtimeMs !== entry.mtimeMs) {
        warmFile(abs, root); // rebuild in the background
        return next();       // serve this request from disk, uncompressed
      }
    } catch {
      return next();
    }

    // Content-Type from the extension. Charset matters for the HTML/JS/CSS
    // the app actually ships.
    const ext = path.extname(urlPath).toLowerCase();
    const TYPES = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.map': 'application/json; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.xml': 'application/xml; charset=utf-8',
    };
    if (TYPES[ext]) res.setHeader('Content-Type', TYPES[ext]);

    res.setHeader('Content-Encoding', enc);
    res.setHeader('Content-Length', body.length);
    // Caches and proxies must key on the encoding, or a gzip body can be
    // handed to a client that asked for identity.
    res.setHeader('Vary', 'Accept-Encoding');

    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  };
}

/** Diagnostics for /api/_perf. */
function stats() {
  return [...cache.entries()].map(([p, e]) => ({
    path: p,
    raw: e.size,
    br: e.br ? e.br.length : null,
    gzip: e.gzip ? e.gzip.length : null,
    ratio: e.br ? +(e.size / e.br).toFixed(2) : null,
  }));
}

module.exports = { middleware, warm, stats };
