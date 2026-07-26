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
  const global = String(process.env.INVOICE_ENGINE || '').toLowerCase();
  if (global === 'html') return true;
  if (global === 'pdfkit') return false;
  const perDoc = String(
    process.env[key.toUpperCase()] || (cfg && cfg[key]) || 'pdfkit'
  ).toLowerCase();
  return perDoc === 'html';
}

module.exports = { useHtmlEngine };
