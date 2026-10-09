// ── Bounded-concurrency helper for the BULK print routes ─────────────────
//
// Every bulk HTML download — sales invoices, purchase invoices, agri bills,
// debit notes — renders ONE document per Chromium page and merges the results.
// That is the right shape (each document is laid out by the single renderer
// that is verified for it), but the loop that drove it was strictly serial, so
// the operator paid the full per-document cost once per row:
//
//     measured warm, one A4 document with an inline logo:  ~1.1 s
//     a 326-row trade, serially:                           ~6 minutes
//
// Almost all of that is wall-clock the CPU spends waiting: a render is mostly
// Chromium parsing, laying out and encoding in ITS process, while node sits on
// the await doing nothing. Running a few at once in the SAME browser fills
// that gap — ~3-4× on a multi-core box, and the saving is largest exactly
// where it hurts, on a whole trade's worth of documents.
//
// Why a small fixed limit and not "all of them": each in-flight render is a
// live Chromium tab holding its own copy of the document (inline logo and all)
// plus the PDF it is building. Unbounded, a 326-row batch would open 326 tabs
// at once and the container would OOM-kill the browser — which is the failure
// the commission-bill chunking exists to avoid (see render-commission-html.js),
// reached by the other road. Four is deliberately conservative: enough to hide
// the wait, few enough that peak memory stays near what the serial loop used.
//
// ORDER IS PART OF THE CONTRACT. The documents are merged into one PDF in list
// order — invoice numbers run in sequence and an operator flipping through a
// 300-page batch expects them to — so results are written back by INDEX, never
// in completion order.

// Overridable for a box with more (or less) headroom; 1 restores the old
// strictly-serial behaviour.
const RENDER_CONCURRENCY = (() => {
  const n = Number(process.env.PDF_RENDER_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
})();

/**
 * mapRenders(items, fn) → Promise<Array>
 * Runs `fn(item, index)` over every item with at most RENDER_CONCURRENCY in
 * flight, and resolves to the results IN INPUT ORDER.
 *
 * A rejection propagates, exactly as the serial `for` loop's would: the batch
 * fails and the route reports it, rather than quietly shipping a PDF that is
 * missing a document. Renders already in flight are left to settle (they hold
 * no state beyond their own page, which closes itself in htmlToPdf).
 */
async function mapRenders(items, fn) {
  const list = items || [];
  const out = new Array(list.length);
  if (list.length <= 1) {
    if (list.length) out[0] = await fn(list[0], 0);
    return out;
  }
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  const lanes = Math.min(RENDER_CONCURRENCY, list.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return out;
}

module.exports = { mapRenders, RENDER_CONCURRENCY };
