// COMPANY-LOGO WATERMARK on every PDF the app prints.
//
// The invoice family (sales invoice, purchase invoice, bill of supply,
// commission bill, debit note) plus every report, register, statement and
// slip — drawn by TWO different renderers, so the only way this holds is if
// both are checked together. A watermark on the PDFKit documents and not the
// HTML ones would be worse than none: nobody could tell which one was the odd
// one out. tests/pdf-watermark.http.js walks the real download routes; this
// file is the mechanics.
//
//   [module]   the toggle (default ON, legacy alias), a missing logo, and the
//              injection rule
//   [density]  pdf_watermark_density turns the mark up for a pale logo, in
//              BOTH engines, clamped at both ends
//   [pdfkit]   each PDFKit generator draws the mark ONCE per page, on top of
//              its own pages and every page a batch adds
//   [state]    it stamps the page being LEFT (from addPage) and the last one
//              (from end), never at attach time — "stamp last, not first" is
//              what puts the mark over the opaque zebra fills instead of
//              under them — and it leaves the graphics state and the text
//              cursor as it found them, because the page is still being drawn
//   [html]     every HTML renderer injects it, exactly once per DOCUMENT —
//              the commission bill concatenates N bills into one document and
//              N stacked copies of a 7% layer is not a 7% layer
//   [render]   through real Chromium: the fixed layer repeats on every page of
//              a multi-page print, which is the whole reason it is fixed
//   [off]      flag off ⇒ not a single extra draw, on either engine
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { PDFDocument, PDFName } = require(path.join(ROOT, 'node_modules', 'pdf-lib'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

// How many times does each page DRAW an image? Counting image XObjects would
// not do: both renderers embed ONE copy of the logo and reference it from the
// header AND the watermark, so the resource count is 1 either way. The draws
// are the `<name> Do` operators in the content stream — resolved through the
// page's XObject table so it works for both engines, which name their
// resources differently (PDFKit /I0, Chromium /x5), and through one level of
// Form XObject, which is how Chromium wraps a printed page.
const escRe = (str) => str.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
function streamText(s) {
  let raw;
  try { raw = Buffer.from(s.getContents ? s.getContents() : s.contents); } catch (_) { return ''; }
  try { return zlib.inflateSync(raw).toString('latin1'); } catch (_) { return raw.toString('latin1'); }
}
function countDraws(ctx, resources, text, depth) {
  const xo = resources && resources.lookup ? resources.lookup(PDFName.of('XObject')) : null;
  if (!xo || !xo.entries) return 0;
  let n = 0;
  for (const [name, ref] of xo.entries()) {
    const key = name.asString ? name.asString() : String(name);
    const uses = (text.match(new RegExp(escRe(key) + '\\s+Do', 'g')) || []).length;
    if (!uses) continue;
    const obj = ctx.lookup(ref);
    const dict = obj && obj.dict ? obj.dict : obj;
    const sub = dict && dict.get ? dict.get(PDFName.of('Subtype')) : null;
    const st = sub ? (sub.asString ? sub.asString() : String(sub)) : '';
    if (st === '/Image') n += uses;
    else if (st === '/Form' && depth < 4) {
      n += uses * countDraws(ctx, ctx.lookup(dict.get(PDFName.of('Resources'))), streamText(obj), depth + 1);
    }
  }
  return n;
}
async function imageDrawsPerPage(buf) {
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  return pdf.getPages().map((p) => {
    const ctx = p.node.context;
    const c = p.node.Contents();
    const streams = !c ? [] : (c.asArray ? c.asArray().map((r) => ctx.lookup(r)) : [c]);
    return countDraws(ctx, p.node.Resources(), streams.map(streamText).join('\n'), 0);
  });
}

const CFG = { logo: 'ispl', company_name: 'INDIAN SPICES PVT LTD', business_state: 'TAMIL NADU',
              gstin: '33AAACI0000A1Z5' };
const OFF = { ...CFG, flag_pdf_watermark: 'false' };

const salesInv = {
  buyer: { name: 'SPICE TRADERS PVT LTD', address: 'DOOR 5, MARKET ROAD', place: 'kumily',
           pin: '685509', state: 'kerala', st_code: '32', gstin: '32AABCS1234K1Z5' },
  lineItems: [{ lot: '7', qty: 10, price: 100, amount: 1000 }],
  summary: { totalQty: 10, grandTotal: 1000, taxableValue: 1000 },
};
const purchInv = {
  seller: { name: 'ASP SPICES', state: 'TAMIL NADU', st_code: '33', gstin: '33AAACA1111A1Z9' },
  buyer: { name: 'INDIAN SPICES PVT LTD', state: 'tamil nadu', st_code: '33' },
  lineItems: [{ lot: '7', qty: 10, price: 100, amount: 1000, puramt: 1000 }],
  summary: { totalQty: 10, totalPuramt: 1000, grandTotal: 1000 },
};
const agriBill = {
  seller: { name: 'ANNAMALAI M', place: 'bodinayakanur', state: 'tamil nadu', st_code: '33' },
  lineItems: [{ lot: '7', qty: 10, price: 100, amount: 1000 }],
  summary: { totalQty: 10, grandTotal: 1000 },
};
const commBill = {
  seller: { name: 'ANNAMALAI M' }, buyer: { name: 'SPICE TRADERS PVT LTD' },
  lineItems: [{ lot: '7', qty: 10, price: 100, amount: 1000 }],
  summary: { totalQty: 10, grandTotal: 1000 },
};
const dnTrader = { name: 'DEALER SPICES LLP', ppla: 'bodinayakanur', pstate: 'tamil nadu',
                   pst_code: '33', cr: '33AABCD5555D1Z1', aadhar: 'SBL/77' };
const dnDb = { get: () => dnTrader, all: () => [] };
const debitNote = { name: dnTrader.name, ano: '12', date: '2026-09-01', no: 5, cgst: 1, sgst: 1, igst: 0, total: 100 };

(async () => {
  // ── The module itself ──────────────────────────────────────────────
  console.log('[module] the toggle, the logo file, and where the markup lands');
  const wm = require(path.join(ROOT, 'pdf', 'watermark'));
  check('ON when the setting has never been touched', wm.watermarkOn({}) === true);
  check('…and when it is explicitly true', wm.watermarkOn({ flag_pdf_watermark: 'true' }) === true);
  check('OFF on false', wm.watermarkOn({ flag_pdf_watermark: 'false' }) === false);
  // One switch governs every PDF; the pre-widening key still works for an
  // install that set it while the feature was invoice-only.
  check('the legacy invoice-only key is still honoured',
        wm.watermarkOn({ flag_invoice_watermark: 'false' }) === false);
  check('…and the canonical key wins when both are set',
        wm.watermarkOn({ flag_pdf_watermark: 'true', flag_invoice_watermark: 'false' }) === true);
  // Report renderers hold a db, not a cfg — both must answer the same.
  const fakeDb = { get: () => ({ value: 'false' }), all: () => [{ key: 'flag_pdf_watermark', value: 'false' }] };
  check('it accepts a db handle as well as a cfg', typeof wm.watermarkOn(fakeDb) === 'boolean');
  check('a logo on disk resolves to a file', !!wm.watermarkFile(CFG), wm.watermarkFile(CFG));
  check('…and the flag beats the file', wm.watermarkFile(OFF) === '');
  // It must be the SAME file the header prints, fallbacks and all — a
  // watermark showing a different brand from the letterhead above it is worse
  // than no watermark. An unknown code lands on the house logo, exactly as
  // logoDataUri() does for the header.
  const { resolveLogoFile } = require(path.join(ROOT, 'pdf', 'logo-data-uri'));
  check('it stamps the same file the header resolves',
        wm.watermarkFile(CFG) === resolveLogoFile('ispl'), wm.watermarkFile(CFG));
  check('an unknown logo code falls back with the header, not to nothing',
        wm.watermarkFile({ logo: 'nobody-has-this-code' }) === resolveLogoFile('nobody-has-this-code'));
  // Nothing on disk at all ⇒ nothing to stamp, and no error either.
  check('a document is printable with no logo file at all',
        wm.withWatermark('<html><body>x</body></html>', { logo: 'zz', flag_invoice_watermark: 'true' }) !== null);
  const html = wm.withWatermark('<html><body><p>hi</p></body></html>', CFG);
  check('the layer is injected inside the body', /<div class="doc-watermark".*<\/body>/s.test(html), html.slice(-120));
  check('…carrying the logo as a data: URI', /<img src="data:image\/\w+;base64,/.test(html));
  // The layer drawn ON TOP is the lighter of the two — see the constants.
  check('…at the faint over-content opacity',
        new RegExp(`opacity:${wm.OPACITY_OVER}[;}]`).test(html), String(wm.OPACITY_OVER));
  check('…which is lighter than the one drawn behind', wm.OPACITY_OVER < wm.OPACITY,
        `${wm.OPACITY_OVER} / ${wm.OPACITY}`);
  check('a second pass does not stack a second copy',
        (wm.withWatermark(html, CFG).match(/class="doc-watermark"/g) || []).length === 1);
  check('a document with no </body> still gets it',
        wm.withWatermark('<p>bare</p>', CFG).includes('doc-watermark'));
  check('flag off leaves the html byte-identical',
        wm.withWatermark('<html><body>x</body></html>', OFF) === '<html><body>x</body></html>');

  console.log('[density] the operator can turn the mark up');
  // The complaint this exists for: a pale logo that does not read on paper.
  const dens = (v) => wm.watermarkOpacity({ pdf_watermark_density: v });
  check('unset ⇒ the tuned default', dens(undefined) === wm.OPACITY && dens('') === wm.OPACITY);
  check('a percentage is taken literally', Math.abs(dens('20') - 0.20) < 1e-9, String(dens('20')));
  check('junk falls back rather than printing nothing', dens('abc') === wm.OPACITY);
  check('clamped at the bottom — 0 is not "off", the flag is',
        Math.abs(dens('0') - wm.DENSITY_MIN / 100) < 1e-9, String(dens('0')));
  check('…and at the top, before it fights the text',
        Math.abs(dens('500') - wm.DENSITY_MAX / 100) < 1e-9, String(dens('500')));
  // Both engines move together, keeping the behind/on-top ratio that makes
  // them look alike — turning it up must not make the HTML documents heavier
  // than the PDFKit ones.
  check('the over-content layer scales with it',
        Math.abs(wm.watermarkOpacityOver({ pdf_watermark_density: '20' }) - 0.20 * wm.OVER_RATIO) < 1e-9);
  check('…and stays the lighter of the two',
        wm.watermarkOpacityOver({ pdf_watermark_density: '20' }) < dens('20'));
  const denseHtml = wm.withWatermark('<html><body>x</body></html>', { ...CFG, pdf_watermark_density: '25' });
  check('the injected CSS carries the raised value',
        /opacity:0\.17\d*/.test(denseHtml), (denseHtml.match(/opacity:[0-9.]+/) || [])[0]);
  // The real PDF: PDFKit writes the opacity as an ExtGState /ca entry.
  const caOf = async (density) => {
    const buf = await inv0.generateSalesInvoicePDF(
      salesInv, { ...CFG, pdf_watermark_density: density }, 'L', '1', '01/09/2026');
    return (buf.toString('latin1').match(/\/ca ([0-9.]+)/g) || []).join(' ');
  };
  const inv0 = require(path.join(ROOT, 'invoice-pdf'));
  // PDFKit stamps ON TOP of the content now, same as the HTML layer, so it
  // carries the OVER figure — that is what makes the two engines look alike.
  const caNum = (d) => Math.round(d / 100 * wm.OVER_RATIO * 1e6) / 1e6;
  check('a printed invoice carries the default density',
        (await caOf('7')).includes('/ca ' + caNum(7)), await caOf('7'));
  check('…and the raised one when it is set',
        (await caOf('25')).includes('/ca ' + caNum(25)), await caOf('25'));
  check('…which is the same figure the HTML layer uses',
        Math.abs(caNum(25) - wm.watermarkOpacityOver({ pdf_watermark_density: '25' })) < 1e-6);

  // ── PDFKit engine ──────────────────────────────────────────────────
  console.log('[pdfkit] every generator draws it, once per page');
  const inv = require(path.join(ROOT, 'invoice-pdf'));
  const docs = [
    ['sales invoice',   (c) => inv.generateSalesInvoicePDF(salesInv, c, 'L', '1', '01/09/2026')],
    ['purchase invoice',(c) => inv.generatePurchaseInvoicePDF(purchInv, c, '1')],
    ['bill of supply',  (c) => inv.generateAgriBillPDF(agriBill, c, '1')],
    ['commission bill', (c) => inv.generateCommissionBoSPDF(commBill, c, '1')],
  ];
  for (const [label, gen] of docs) {
    const withWm = await imageDrawsPerPage(await gen(CFG));
    const without = await imageDrawsPerPage(await gen(OFF));
    check(`${label}: one more image draw per page than without`,
          withWm.length === without.length && withWm.every((n, i) => n === without[i] + 1),
          `${JSON.stringify(withWm)} vs ${JSON.stringify(without)}`);
  }

  console.log('[pdfkit] a batch stamps every page it adds, and only once');
  const batch = await imageDrawsPerPage(await inv.generateSalesInvoicesBatchPDF(
    [1, 2, 3].map((n) => ({ invoiceData: salesInv, saleType: 'L', invoiceNo: String(n), invoiceDate: '01/09/2026' })), CFG));
  const batchOff = await imageDrawsPerPage(await inv.generateSalesInvoicesBatchPDF(
    [1, 2, 3].map((n) => ({ invoiceData: salesInv, saleType: 'L', invoiceNo: String(n), invoiceDate: '01/09/2026' })), OFF));
  check('three pages', batch.length === 3, JSON.stringify(batch));
  check('each page gains exactly one draw — not two by the second invoice',
        batch.every((n, i) => n === batchOff[i] + 1), `${JSON.stringify(batch)} vs ${JSON.stringify(batchOff)}`);

  console.log('[state] it stamps the page being left, and puts it back as it found it');
  // A stub doc: the point is WHEN attach() draws and what it touches, which a
  // real PDFDocument hides inside its own state.
  //
  // The contract is "stamp last, not first". Nothing is drawn at attach time;
  // each page is stamped on the way OUT — from addPage(), which is every
  // page-break path PDFKit has, and from end() for the final page that no
  // addPage follows. Drawing first is what made the mark invisible under the
  // opaque zebra fills on the table exports.
  const calls = [];
  let addPageCalls = 0, ended = 0;
  const stub = {
    page: { width: 595.28, height: 841.89 }, x: 111, y: 222,
    save() { calls.push('save'); }, restore() { calls.push('restore'); },
    opacity(v) { calls.push('opacity:' + v); },
    image(f, x, y, o) { calls.push({ image: f, x, y, o }); },
    addPage() { addPageCalls++; return this; },
    end() { ended++; return this; },
    on() {},
  };
  const drawn = () => calls.filter((c) => c && c.image);
  wm.attachPdfkitWatermark(stub, CFG);
  check('nothing is drawn at attach time — the page has no content yet', drawn().length === 0,
        JSON.stringify(calls.length));

  // Leaving page 1 stamps page 1.
  stub.addPage();
  check('leaving a page stamps it', drawn().length === 1, String(drawn().length));
  check('…and PDFKit still gets its addPage', addPageCalls === 1, String(addPageCalls));
  check('…saved and restored around the draw',
        calls[0] === 'save' && calls[calls.length - 1] === 'restore',
        JSON.stringify(calls.filter((c) => typeof c === 'string')));
  check('…at the on-top opacity', calls.includes('opacity:' + wm.OPACITY_OVER),
        JSON.stringify(calls.filter((c) => typeof c === 'string')));
  const first = drawn();
  check('…centred on the page',
        Math.abs(first[0].x + first[0].o.fit[0] / 2 - stub.page.width / 2) < 0.01
        && Math.abs(first[0].y + first[0].o.fit[1] / 2 - stub.page.height / 2) < 0.01,
        JSON.stringify({ x: first[0].x, y: first[0].y, fit: first[0].o.fit }));
  check('the text cursor is exactly where it was', stub.x === 111 && stub.y === 222, `${stub.x},${stub.y}`);

  stub.addPage();
  check('one stamp per page left behind', drawn().length === 2, String(drawn().length));

  // The last page is nobody's "previous page" — end() is what catches it.
  stub.end();
  check('end() stamps the final page', drawn().length === 3, String(drawn().length));
  check('…and PDFKit still gets its end', ended === 1, String(ended));
  stub.end();
  check('a second end() does not stamp it twice', drawn().length === 3, String(drawn().length));

  // Batch re-entry: the same doc passes through attach once per document.
  wm.attachPdfkitWatermark(stub, CFG);
  stub.addPage();
  check('attaching again is a no-op — the wrappers are not stacked',
        drawn().length === 4, String(drawn().length));

  // ── HTML engine ────────────────────────────────────────────────────
  // Swap htmlToPdf for a spy BEFORE the renderers are required, so each one
  // binds to the spy. What reaches the print engine IS the contract here.
  console.log('[html] every renderer injects it, exactly once per document');
  const h2p = require(path.join(ROOT, 'pdf', 'htmlToPdf'));
  const seen = [];
  h2p.htmlToPdf = async (html) => { seen.push(String(html)); return Buffer.from('%PDF-1.4\n'); };
  const { generateSalesInvoiceHtmlPDF } = require(path.join(ROOT, 'pdf', 'render-html-invoice'));
  const { generatePurchaseInvoiceHtmlPDF } = require(path.join(ROOT, 'pdf', 'render-purchase-html'));
  const { generateAgriBillHtmlPDF } = require(path.join(ROOT, 'pdf', 'render-agri-html'));
  const { generateCommissionBoSHtmlPDF } = require(path.join(ROOT, 'pdf', 'render-commission-html'));
  const { generateDebitNoteHtmlPDF } = require(path.join(ROOT, 'pdf', 'render-debit-note-html'));
  const renders = [
    ['sales invoice',    () => generateSalesInvoiceHtmlPDF(salesInv, CFG, 'L', '1', '01/09/2026')],
    ['purchase invoice', () => generatePurchaseInvoiceHtmlPDF(purchInv, CFG, '1')],
    ['bill of supply',   () => generateAgriBillHtmlPDF(agriBill, CFG, '1')],
    ['debit note',       () => generateDebitNoteHtmlPDF(debitNote, dnDb, CFG)],
  ];
  for (const [label, run] of renders) {
    seen.length = 0;
    await run();
    check(`${label}: the html carries one watermark layer`,
          seen.length >= 1 && seen.every((h) => (h.match(/class="doc-watermark"/g) || []).length === 1),
          `${seen.length} render(s): ${seen.map((h) => (h.match(/class="doc-watermark"/g) || []).length).join(',')}`);
  }
  seen.length = 0;
  await generateCommissionBoSHtmlPDF(
    [1, 2, 3].map((n) => ({ billData: commBill, billNo: String(n) })), CFG);
  check('commission bill: THREE bills, still ONE layer for the document',
        seen.length === 1 && (seen[0].match(/class="doc-watermark"/g) || []).length === 1,
        String((seen[0] || '').match(/class="doc-watermark"/g) || []).length);
  seen.length = 0;
  await generateSalesInvoiceHtmlPDF(salesInv, OFF, 'L', '1', '01/09/2026');
  check('flag off: no layer at all', seen.every((h) => !h.includes('doc-watermark')));
  delete require.cache[require.resolve(path.join(ROOT, 'pdf', 'htmlToPdf'))];

  // ── Real Chromium ──────────────────────────────────────────────────
  // The reason the layer is `position: fixed` is that Chromium repeats fixed
  // elements on every printed page. That behaviour is the feature, so it is
  // checked against the real engine rather than assumed.
  console.log('[render] Chromium repeats the fixed layer on every page');
  const { htmlToPdf } = require(path.join(ROOT, 'pdf', 'htmlToPdf'));
  const long = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + '<div style="height:1400px">one</div><div style="height:1400px">two</div><div>three</div>'
    + '</body></html>';
  let plain;
  try {
    plain = await htmlToPdf(long);
  } catch (e) {
    console.log('  skip no Chromium available — print checks not run: ' + e.message.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const marked = await htmlToPdf(wm.withWatermark(long, CFG));
  const before = await imageDrawsPerPage(plain);
  const after = await imageDrawsPerPage(marked);
  check('the plain print has no images at all', before.every((n) => n === 0), JSON.stringify(before));
  check('all three pages carry the mark — exactly one each',
        after.length === 3 && after.every((n) => n === 1), JSON.stringify(after));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
