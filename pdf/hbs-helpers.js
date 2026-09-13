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

  // Quantity with 3 decimals (no grouping): {{qty li.qty}} → "12.345"
  Handlebars.registerHelper('qty', (v) => Number(v || 0).toFixed(3));

  // Indian-grouped money / qty matching the PDFKit fmtRup / fmtQty exactly
  // (toLocaleString en-IN). Used by purchase invoice, bill of supply, commission.
  Handlebars.registerHelper('rup', (v) =>
    Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  Handlebars.registerHelper('qtyg', (v) =>
    Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));

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

  // Repeat a block N times — used to pad blank filler rows so the totals/footer
  // land near the bottom of the page (matches the PDFKit empty-row padding).
  Handlebars.registerHelper('times', function (n, options) {
    let out = '';
    const count = Math.max(0, Number(n) || 0);
    for (let i = 0; i < count; i++) out += options.fn(i);
    return out;
  });

  // Equality + comparison for {{#if (eq a b)}} style conditionals.
  // ── Party box ───────────────────────────────────────────────
  // {{{partyBox seller.block prefix="Sri/M/s. "}}} renders one "who" box in
  // the shared format (see party-block.js) — name, street and town-PIN each
  // on their own line, the state paired with its state code, then every
  // remaining detail two per row:
  //
  //     Sri/M/s. SABIRA BURVIN
  //     3,NONDIMAGAN STREET
  //     CUMBUM-625516
  //     KERALA                 CODE: 32
  //     Ph: 9443447332         A/C: 0603053000000871
  //
  // Every invoice that names a seller or a buyer calls this, so the boxes
  // cannot drift apart layout by layout again. A fixed two-column table
  // keeps the right-hand values aligned down the box; each template styles
  // `.pb` / `.pb-nm` to match its own type.
  Handlebars.registerHelper('partyBox', function (blk, options) {
    if (!blk) return '';
    const esc = Handlebars.escapeExpression;
    const opts = (options && options.hash) || {};
    const wide = t => `<tr><td colspan="2">${esc(t)}</td></tr>`;
    let h = '<table class="pb"><tbody>';
    h += `<tr><td colspan="2" class="pb-nm">${esc((opts.prefix || '') + (blk.name || ''))}</td></tr>`;
    if (blk.address) h += wide(blk.address);
    if (blk.place) h += wide(blk.place);
    const pair = (l, r) => `<tr><td>${l}</td><td class="pb-r">${r}</td></tr>`;
    const kv = c => c ? `${esc(c.k)}: <span class="pb-v">${esc(c.v)}</span>` : '';
    if (blk.state) h += pair(esc(blk.state), 'CODE: <span class="pb-v">' + esc(blk.stCode || '') + '</span>');
    for (const r of (blk.rows || [])) h += pair(kv(r.a), kv(r.b));
    return new Handlebars.SafeString(h + '</tbody></table>');
  });

  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('gt', (a, b) => Number(a) > Number(b));
  Handlebars.registerHelper('and', (a, b) => !!a && !!b);
  Handlebars.registerHelper('or', (a, b) => !!a || !!b);

  return Handlebars;
}

module.exports = { registerHelpers, formatINR, Handlebars };
