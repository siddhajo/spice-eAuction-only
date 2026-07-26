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

module.exports = { mergePdfs };
