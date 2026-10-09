// BULK PRINTS RUN A FEW AT A TIME — AND COME OUT IN ORDER.
//
// The bulk HTML routes (sales invoice, purchase invoice, agri bill, debit
// note) render one document per Chromium page and merge. Serially that is
// ~1.1 s × every row — six minutes for a 326-row trade, nearly all of it node
// sitting on an await while Chromium works. pdf/render-pool.js runs a few at
// once; this file is the two things that MUST NOT change when it does.
//
//   [order]   the merge order is the LIST order — invoice numbers run in
//             sequence through a 300-page batch, whatever finishes first —
//             and a failed render still fails the whole batch rather than
//             quietly shipping a PDF with a document missing
//   [browser] one burst of concurrent renders launches ONE browser. The cache
//             slot in htmlToPdf.js is claimed synchronously; when it wasn't,
//             concurrent callers each launched their own Chromium and every
//             one but the last was orphaned — a live browser nobody could
//             close, which is how a dev box ends up with 90 of them
//   [same]    the concurrent output is byte-identical to the serial output,
//             page for page, so this is a speed change and nothing else
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { PDFDocument } = require(path.join(ROOT, 'node_modules', 'pdf-lib'));
const { mapRenders } = require(path.join(ROOT, 'pdf', 'render-pool'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

const CFG = {
  logo: 'ispl', name: 'RNS SPICES', short_name: 'RNS SPICES',
  purchase_invoice_template: 'classic', hsn_cardamom: '09083120', date_format: 'dd/mm/yyyy',
};
function invoices(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ invoiceNo: 'PI/' + i, invoiceData: {
      date: '08/10/2026', auction: { ano: 19, date: '08/10/2026' },
      seller: { name: 'DEALER ' + i, address: 'Market Yard', place: 'KUMILY', pin: '685509', state: 'KERALA', st_code: '32', gstin: '32ABCDE1234F1Z5' },
      buyer: { name: 'RNS SPICES', address: 'Main Road', place: 'BODI', pin: '625513', state: 'TAMIL NADU', st_code: '33' },
      lineItems: [{ lot: i, qty: 55.5, bags: 2, rate: 2150.25, amount: 119338.88 }],
      taxable: 119338.88, cgst: 2983.47, sgst: 2983.47, igst: 0, total: 125305.82 } });
  }
  return out;
}

// A page's drawing commands, decompressed — the thing that must not change.
async function pageHashes(buf) {
  const doc = await PDFDocument.load(buf);
  return doc.getPages().map((p) => {
    const parts = [];
    const push = (st) => {
      let b = st.getContents ? st.getContents() : st.contents;
      try { b = zlib.inflateSync(Buffer.from(b)); } catch (_) { b = Buffer.from(b); }
      parts.push(b);
    };
    const c = p.node.Contents();
    if (c && c.asArray) c.asArray().forEach((r) => push(p.node.context.lookup(r)));
    else if (c) push(c);
    return crypto.createHash('sha1').update(Buffer.concat(parts)).digest('hex').slice(0, 12);
  });
}

// Render the same batch at a given concurrency, from a clean module cache so
// the pool re-reads the env var.
function batchAt(concurrency, n) {
  process.env.PDF_RENDER_CONCURRENCY = String(concurrency);
  for (const k of Object.keys(require.cache)) {
    if (/pdf[\\/](render-|htmlToPdf)/.test(k)) delete require.cache[k];
  }
  const { generatePurchaseInvoicesHtmlBatchPDF } = require(path.join(ROOT, 'pdf', 'render-purchase-html'));
  return generatePurchaseInvoicesHtmlBatchPDF(invoices(n), CFG);
}

(async () => {
  console.log('\n[order] results come back in list order, never completion order');
  // Deliberately inverted: the LAST item finishes first.
  const delays = [60, 50, 40, 30, 20, 10, 5, 1];
  const done = [];
  const got = await mapRenders(delays, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    done.push(i);
    return 'doc' + i;
  });
  check('every item is in its own slot', got.join(',') === delays.map((_, i) => 'doc' + i).join(','), got.join(','));
  check('…even though they finished out of order', done.join(',') !== delays.map((_, i) => i).join(','), done.join(','));
  check('an empty batch is an empty result', (await mapRenders([], async () => 1)).length === 0);
  let threw = '';
  try { await mapRenders([1, 2, 3], async (v) => { if (v === 2) throw new Error('render died'); return v; }); }
  catch (e) { threw = e.message; }
  check('one failed render fails the batch', threw === 'render died', threw || '(no throw)');

  console.log('\n[browser] a burst of concurrent renders shares ONE browser');
  const { htmlToPdf } = require(path.join(ROOT, 'pdf', 'htmlToPdf'));
  const doc = '<!doctype html><html><body><style>@page{size:A4;margin:0}</style><p>hi</p></body></html>';
  const children = () => {
    try { return execSync(`pgrep -P ${process.pid} || true`).toString().trim().split('\n').filter(Boolean).length; }
    catch (_) { return -1; }
  };
  try {
    await Promise.all(Array.from({ length: 6 }, () => htmlToPdf(doc)));
  } catch (e) {
    console.log('  skip no Chromium available — print checks not run: ' + e.message.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const after = children();
  check('6 simultaneous renders from cold ⇒ 1 browser, not 6',
        after === 1 || after === -1, after + ' child process(es)');

  console.log('\n[same] concurrent output is the serial output');
  const N = 8;
  const serial = await pageHashes(await batchAt(1, N));
  const concurrent = await pageHashes(await batchAt(4, N));
  check(`${N} invoices ⇒ ${N} pages, both ways`, serial.length === N && concurrent.length === N,
        `${serial.length} vs ${concurrent.length}`);
  check('the pages are all different from each other (so order is observable)',
        new Set(serial).size === N);
  check('page for page, byte-identical to the serial render',
        serial.every((h, i) => h === concurrent[i]),
        'serial ' + serial.join(' ') + '\n         conc   ' + concurrent.join(' '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
