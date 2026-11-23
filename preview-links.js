// preview-links.js — short-lived, unguessable URLs for previewing a document
// in a browser tab under its REAL filename.
//
// THE PROBLEM. Every "Preview" button used to fetch the PDF with an
// Authorization header, wrap the bytes in a Blob and open the object URL.
// That works, but a blob URL is `blob:https://host/<uuid>` — it carries no
// headers and no path — so Chrome's PDF viewer has nothing to name the file
// after and offers "9a1281db-2001-4c06-9474-8cf409c0cc22" in the Save
// dialog. The server had already sent the right name in Content-Disposition;
// the blob threw it away.
//
// THE FIX. The authenticated fetch asks for a LINK instead of the bytes
// (`?previewlink=1`). The rendered PDF is parked here under a random id and
// the tab navigates to `/p/<id>/<Real Name>.pdf`, a normal HTTP URL whose
// last path segment IS the filename and which carries a proper
// Content-Disposition. Save now offers the same name the direct export does.
//
// WHY NOT just put the session token in the URL — the pattern three older
// routes use? Because a session token in a URL is a credential written into
// browser history and into the host's access log for every preview. An id
// here is 128 bits of randomness that is good for one document and expires
// in two minutes, so a leaked log line is worth nothing by the time anyone
// reads it.
//
// NOT single-use: a PDF viewer may re-request the document, or ask for byte
// ranges, so the id stays valid until it expires rather than burning on the
// first GET.

const crypto = require('crypto');

const TTL_MS    = 2 * 60 * 1000;      // long enough to open a tab, no longer
const MAX_BYTES = 48 * 1024 * 1024;   // total parked bytes; oldest evicted first

// Insertion-ordered, which is what makes the oldest-first eviction below a
// plain iteration rather than a sort.
const store = new Map();
let parked = 0;

function sweep(now) {
  now = now || Date.now();
  for (const [id, e] of store) {
    if (e.expires <= now) { parked -= e.buf.length; store.delete(id); }
  }
}

// Strip anything that could break out of the quoted filename in a
// Content-Disposition header, or climb a directory in the URL path.
function safeName(name, fallback) {
  const cleaned = String(name == null ? '' : name)
    .replace(/[\r\n"\\/]+/g, ' ')
    .replace(/[^\w .()\[\]@&+-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned || fallback || 'document.pdf';
}

// Park a rendered document and return its id.
function stash(buf, filename, contentType) {
  sweep();
  const name = safeName(filename);
  // Evict oldest until the newcomer fits. A single document larger than the
  // whole budget is refused rather than emptying the store for nothing.
  if (buf.length > MAX_BYTES) return null;
  while (parked + buf.length > MAX_BYTES && store.size) {
    const [id, e] = store.entries().next().value;
    parked -= e.buf.length;
    store.delete(id);
  }
  const id = crypto.randomBytes(16).toString('hex');
  store.set(id, {
    buf,
    filename: name,
    contentType: contentType || 'application/pdf',
    expires: Date.now() + TTL_MS,
  });
  parked += buf.length;
  return id;
}

// Look a document up. Returns null when the id is unknown or has expired —
// the caller must not distinguish the two cases to a client.
function take(id) {
  sweep();
  return store.get(String(id || '')) || null;
}

function stats() { return { count: store.size, bytes: parked }; }

// Housekeeping even when nothing is being previewed, so an idle server does
// not hold a document's bytes for longer than its TTL. unref() so this timer
// never keeps the process alive on its own.
const timer = setInterval(() => sweep(), 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { stash, take, stats, safeName, TTL_MS, MAX_BYTES };
