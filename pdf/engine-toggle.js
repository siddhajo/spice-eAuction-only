// ── Renderer engine toggle ───────────────────────────────────────────────
//
// Decides whether a given document download route serves the new HTML-template
// PDF or the legacy PDFKit layout. Resolution order (first match wins):
//
//   1. env INVOICE_ENGINE = 'html' | 'pdfkit'  → global override for ALL docs
//      (easiest on Railway: one variable flips everything)
//   2. env <KEY-UPPERCASED>       e.g. SALES_INVOICE_ENGINE=html   → per-doc
//   3. cfg[<key>]                 e.g. cfg.sales_invoice_engine     → per-doc setting
//   4. default 'pdfkit'           → unchanged behavior
//
// `key` is the settings key, e.g. 'sales_invoice_engine',
// 'purchase_invoice_engine', 'agri_bill_engine', 'commission_bill_engine'.
function useHtmlEngine(cfg, key) {
  // Only 'html' / 'pdfkit' are valid engine values. Any other value (e.g. a
  // layout name like 'rns' accidentally put in an *_ENGINE variable) is IGNORED
  // rather than treated as "not html" — so a typo can't silently disable it;
  // resolution just falls through to the next source.
  const norm = (v) => {
    const s = String(v == null ? '' : v).toLowerCase().trim();
    return (s === 'html' || s === 'pdfkit') ? s : '';
  };
  const global = norm(process.env.INVOICE_ENGINE);
  if (global) return global === 'html';
  const envDoc = norm(process.env[key.toUpperCase()]);
  if (envDoc) return envDoc === 'html';
  const setting = norm(cfg && cfg[key]);
  if (setting) return setting === 'html';
  return false; // default: pdfkit
}

module.exports = { useHtmlEngine };
