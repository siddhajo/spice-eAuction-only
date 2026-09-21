// ── PDF merge helper ─────────────────────────────────────────────────────
// Merges an array of single-document PDF Buffers into one multi-page Buffer.
// Used by the bulk/batch HTML routes: each invoice is rendered independently
// by its verified single renderer, then the resulting PDFs are concatenated.
// Pure JS (pdf-lib) — no native deps, works in the Railway container.

const { PDFDocument } = require('pdf-lib');

async function mergePdfs(buffers) {
  const valid = (buffers || []).filter((b) => b && b.length);
  if (valid.length === 0) throw new Error('mergePdfs: nothing to merge');
  if (valid.length === 1) return valid[0];
  const out = await PDFDocument.create();
  for (const buf of valid) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}

// How many pages a rendered PDF came out to. Used by the sales-invoice renderer
// to tell a one-page invoice (print it as-is) from one that spilled over and
// needs page numbers and a "continued" note.
async function pdfPageCount(buf) {
  if (!buf || !buf.length) return 0;
  const doc = await PDFDocument.load(buf);
  return doc.getPageCount();
}

// All pages of `buf` EXCEPT the last, as a new PDF Buffer. The last page of a
// multi-page document is re-rendered on its own (without the "continued on next
// page" footer) and appended to this — see generateSalesInvoiceHtmlPDF.
// Returns null when there is nothing left after dropping the last page.
async function dropLastPage(buf) {
  const src = await PDFDocument.load(buf);
  const keep = src.getPageIndices().slice(0, -1);
  if (!keep.length) return null;
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, keep);
  for (const pg of pages) out.addPage(pg);
  return Buffer.from(await out.save());
}

module.exports = { mergePdfs, pdfPageCount, dropLastPage };
