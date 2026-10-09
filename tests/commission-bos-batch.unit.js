// A WHOLE TRADE'S COMMISSION BILLS IN ONE DOWNLOAD.
//
// The Commission BoS batch is the biggest print the app makes: one A4 page per
// LOT, so a 450-lot auction is 300+ pages, each carrying its own inline logo
// (~150 KB of base64). Concatenated into a single HTML document that is tens
// of megabytes for Chromium to ship over CDP, parse and lay out — which is
// exactly what it used to do, and what failed in the field with a bare
// "Navigation timeout of 30000 ms exceeded". (Not a timeout that wanted
// raising: the single giant render still hadn't finished at three minutes.)
//
// So the batch renders in SLICES and merges them. The thing that has to hold
// is that slicing is invisible in the output:
//
//   [count]  every payload still gets exactly one page, across the boundary
//   [css]    each slice is its own document, so each needs its own copy of
//            the template's <style> — without it a slice prints at Chromium's
//            default Letter instead of the A4 the @page rule asks for, which
//            is why page SIZE is the assertion here
//   [logo]   the header logo and the watermark survive into every merged page
//
// Chromium-backed (via pdf/htmlToPdf.js); skips cleanly when no browser is
// available, like the other print tests.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { PDFDocument, PDFName } = require(path.join(ROOT, 'node_modules', 'pdf-lib'));
const { generateCommissionBoSHtmlPDF } = require(path.join(ROOT, 'pdf', 'render-commission-html'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

// Default slice size in render-commission-html.js. The interesting counts are
// the ones either side of it.
const SLICE = 25;

const CFG = {
  logo: 'ispl', name: 'RNS SPICES', short_name: 'RNS SPICES',
  commission_bill_engine: 'html', commission_bill_template: 'letterhead',
  commission_gst_rate: 9, sb_refund: 1, sb_trader_sample: 0.5,
  hsn_cardamom: '09083120', date_format: 'dd/mm/yyyy',
};

function payloads(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      billNo: 'BOS/' + i,
      billData: {
        crpt: String(1000 + i),
        auction: { ano: 19, date: '08/10/2026' },
        seller: { name: 'PLANTER ' + i, address: '12/3 Main Road', place: 'BODINAYAKANUR', pin: '625513', state: 'TAMIL NADU', st_code: '33', cr: 'CR' + i },
        purchaser: { name: 'BUYER ' + i, address: 'Market Yard', place: 'KUMILY', pin: '685509', state: 'KERALA', st_code: '32', gstin: '32ABCDE1234F1Z5' },
        lineItems: [{ lot: i, qty: 55.5, bags: 2, rate: 2150.25, cardamomCost: 119338.88, refundQty: 1, refundRate: 2150.25, refundAmount: 2150.25 }],
        commission: 6000.5, cgst: 540.05, sgst: 540.05, igst: 0, interState: false,
        gstRate: 9, nett: 114408.53,
      },
    });
  }
  return out;
}

const A4 = (p) => Math.round(p.getWidth()) === 595 && Math.round(p.getHeight()) === 842;
// Header logo + watermark = two image XObjects on a well-formed page.
function imageCount(page) {
  const xo = page.node.Resources() && page.node.Resources().get(PDFName.of('XObject'));
  return xo && xo.keys ? xo.keys().length : 0;
}

(async () => {
  console.log('\n[batch] slicing is invisible in the output');
  let one;
  try {
    one = await generateCommissionBoSHtmlPDF(payloads(1), CFG);
  } catch (e) {
    console.log('  skip no Chromium available — batch checks not run: ' + e.message.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  check('a single bill is one page', (await PDFDocument.load(one)).getPageCount() === 1);

  // One slice exactly, then one page MORE than a slice — the merge path.
  for (const n of [SLICE, SLICE + 1]) {
    const doc = await PDFDocument.load(await generateCommissionBoSHtmlPDF(payloads(n), CFG));
    const pages = doc.getPages();
    check(`${n} bills ⇒ ${n} pages`, pages.length === n, 'got ' + pages.length);
    check(`${n} bills: every page is A4 — each slice carries its own @page rule`,
          pages.every(A4), JSON.stringify([...new Set(pages.map((p) => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`))]));
    check(`${n} bills: every page keeps its logo and watermark`,
          pages.every((p) => imageCount(p) === 2), JSON.stringify(pages.map(imageCount)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
