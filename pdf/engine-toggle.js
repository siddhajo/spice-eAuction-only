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
  // layout name like 'letterhead' accidentally put in an *_ENGINE variable) is IGNORED
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
//     still select a distinctly-named layout such as 'modern'/'letterhead'.)
// Compared case-insensitively against the trimmed template choice.
const PDFKIT_TEMPLATE_IDS = new Set(['pdfkit', 'classic']);

function isPdfkitTemplate(tplChoice) {
  return PDFKIT_TEMPLATE_IDS.has(String(tplChoice == null ? '' : tplChoice).toLowerCase().trim());
}

// Single source of truth for "should this download render via the HTML engine?"
// Resolution order (first that applies wins):
//   1. env INVOICE_ENGINE — the GLOBAL kill-switch. When ops set it to
//                    'pdfkit' (or 'html') it forces every document to that
//                    engine regardless of per-module layout — the emergency
//                    lever if HTML/Chromium rendering breaks on the server.
//   2. tplChoice   — an explicit per-print layout choice (query/body `template`).
//                    classic/pdfkit ⇒ PDFKit; any other id ⇒ HTML.
//   3. cfg[templateKey] — the module's SAVED default layout (e.g. cfg
//                    .sales_invoice_template). This is what makes the Layout
//                    dropdown the single control: picking 'modern' as the
//                    default renders HTML even though the legacy *_engine
//                    setting is still 'pdfkit'. 'classic' ⇒ PDFKit.
//   4. useHtmlEngine(cfg, engineKey) — legacy fallback: per-doc <DOC>_ENGINE
//                    env / cfg *_engine value, then 'pdfkit'. Keeps old installs
//                    that only set an *_engine value working.
// Returns a boolean (true ⇒ HTML). `engineKey`/`templateKey` are the cfg keys
// for the module, e.g. 'sales_invoice_engine' / 'sales_invoice_template'.
function resolveWantHtml(cfg, { engineKey, templateKey, tplChoice } = {}) {
  // Global env kill-switch wins over everything (back-compat + emergency).
  const g = String(process.env.INVOICE_ENGINE || '').toLowerCase().trim();
  if (g === 'html' || g === 'pdfkit') return g === 'html';
  const choice = String(tplChoice == null ? '' : tplChoice).trim();
  if (choice) return !isPdfkitTemplate(choice);
  const saved = String((cfg && templateKey && cfg[templateKey]) || '').trim();
  if (saved) return !isPdfkitTemplate(saved);
  return useHtmlEngine(cfg, engineKey);
}

module.exports = { useHtmlEngine, isPdfkitTemplate, resolveWantHtml, PDFKIT_TEMPLATE_IDS };
