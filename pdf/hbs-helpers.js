// ── Handlebars helpers for invoice templates ─────────────────────────────
//
// Registered ONCE against the shared Handlebars instance used by
// invoice-templates.js. Templates call these instead of re-implementing
// formatting, so every customer template formats money/qty/dates identically.
//
// Reuses the app's existing formatters where they exist:
//   - amountToWords        (amount-words.js)      → INR words
//   - formatDateForDisplay (report-formatters.js) → operator's date_format
//
// formatINR mirrors invoice-pdf.js's private formatINR (Indian lakh grouping,
// e.g. "4,25,356.80") — kept in sync so HTML and PDFKit outputs match to the
// paisa.

const Handlebars = require('handlebars');
const { amountToWords } = require('../amount-words');
const { formatDateForDisplay } = require('../report-formatters');

// Indian lakh-style grouping — identical algorithm to invoice-pdf.js formatINR.
function formatINR(n, decimals = 2) {
  const num = Number(n || 0);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  const parts = abs.toFixed(decimals).split('.');
  let intPart = parts[0];
  const dec = parts[1] || '';
  let formatted;
  if (intPart.length <= 3) {
    formatted = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    formatted = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return sign + formatted + (dec ? '.' + dec : '');
}

let _registered = false;
function registerHelpers() {
  if (_registered) return Handlebars;
  _registered = true;

  // Money in Indian grouping: {{inr summary.grandTotal}}
  Handlebars.registerHelper('inr', (v) => formatINR(v, 2));

  // Quantity with 3 decimals + unit: {{qty li.qty}} → "12.345"
  Handlebars.registerHelper('qty', (v) => Number(v || 0).toFixed(3));

  // Fixed-decimals passthrough: {{fixed rate 2}}
  Handlebars.registerHelper('fixed', (v, d) => Number(v || 0).toFixed(typeof d === 'number' ? d : 2));

  // Amount in words (INR … Only handled in template): {{words summary.grandTotal}}
  Handlebars.registerHelper('words', (v) => amountToWords(Number(v || 0)));

  // Date honoring the operator's configured format: {{date invoiceDate cfg.date_format}}
  Handlebars.registerHelper('date', (val, fmt) =>
    formatDateForDisplay(val, (typeof fmt === 'string' && fmt) || 'dd/mm/yyyy'));

  // Short date used in the metadata grid (dd-Mon-yy): {{shortDate invoiceDate}}
  Handlebars.registerHelper('shortDate', (val) => {
    const d = val ? new Date(val) : new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const mon = d.toLocaleDateString('en-US', { month: 'short' });
    const yr = String(d.getFullYear()).slice(-2);
    return `${day}-${mon}-${yr}`;
  });

  // Arithmetic for template-side sums (e.g. CGST+SGST total): {{inr (add a b)}}
  Handlebars.registerHelper('add', (a, b) => Number(a || 0) + Number(b || 0));

  // Equality + comparison for {{#if (eq a b)}} style conditionals.
  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('gt', (a, b) => Number(a) > Number(b));
  Handlebars.registerHelper('and', (a, b) => !!a && !!b);
  Handlebars.registerHelper('or', (a, b) => !!a || !!b);

  return Handlebars;
}

module.exports = { registerHelpers, formatINR, Handlebars };
