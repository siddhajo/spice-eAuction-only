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

// Template ids that must be drawn by the legacy PDFKit renderer rather than an
// HTML .hbs layout, when chosen explicitly at print time:
//   • 'pdfkit'  — the explicit "Classic (Legacy)" choice.
//   • 'classic' — there IS a classic.hbs HTML layout, but it renders noticeably
//     differently from the PDFKit "Classic". Since they can't be made to look
//     the same, picking "Classic" in the print dialog must always produce the
//     PDFKit output the operator expects. (Companies wanting the HTML look can
//     still select a distinctly-named layout such as 'modern'/'rns'.)
// Compared case-insensitively against the trimmed template choice.
const PDFKIT_TEMPLATE_IDS = new Set(['pdfkit', 'classic']);

function isPdfkitTemplate(tplChoice) {
  return PDFKIT_TEMPLATE_IDS.has(String(tplChoice == null ? '' : tplChoice).toLowerCase().trim());
}

module.exports = { useHtmlEngine, isPdfkitTemplate, PDFKIT_TEMPLATE_IDS };
