// ── Invoice PDF template registry (per-customer layouts) ─────────────────
//
// SAME idea as bank-formats.js, but for PDF documents instead of bank XLSX
// files. The invoice DATA is identical across customers (built by
// calculations.js: buildSalesInvoice / buildPurchaseInvoice / buildAgriBill).
// A "template" is PRESENTATION ONLY — an HTML/CSS layout that renders that
// data. Supporting a new customer's invoice format = adding one .hbs file and
// (optionally) one registry line — never a code fork.
//
// The active template per document type is chosen by a company setting:
//     sales_invoice_template     (default 'classic')
//     purchase_invoice_template  (default 'classic')
//     agri_bill_template         (default 'classic')
//     commission_bill_template   (default 'classic')
// Each is a normal `category:'invoice'` select in company-config.js, so it
// surfaces on cfg exactly like cfg.bank_format does today. Unknown/blank →
// falls back to the document type's default, so existing installs are unchanged.
//
// Templates live in  templates/<docType>/<key>.hbs  and are COMPILED ONCE and
// cached. Each .hbs is a COMPLETE, self-contained HTML document (its own
// <style>), so a customer's layout + CSS travel together in one editable file.

const fs = require('fs');
const path = require('path');
const { registerHelpers } = require('./hbs-helpers');

const Handlebars = registerHelpers();
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// Per-document-type default template id. Used when the cfg setting is blank or
// points at a template file that doesn't exist on this install.
const DEFAULTS = {
  'sales-invoice': 'classic',
  'purchase-invoice': 'classic',
  'agri-bill': 'classic',
  'commission-bill': 'classic',
};

// Maps a document type to the cfg setting key that selects its template.
const SETTING_KEY = {
  'sales-invoice': 'sales_invoice_template',
  'purchase-invoice': 'purchase_invoice_template',
  'agri-bill': 'agri_bill_template',
  'commission-bill': 'commission_bill_template',
};

const _cache = new Map(); // "docType/key" → compiled Handlebars template

function _templatePath(docType, key) {
  return path.join(TEMPLATES_DIR, docType, `${key}.hbs`);
}

// Compile + cache a single template file. Returns null if it doesn't exist.
function _load(docType, key) {
  const cacheKey = `${docType}/${key}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  const file = _templatePath(docType, key);
  if (!fs.existsSync(file)) { _cache.set(cacheKey, null); return null; }
  const compiled = Handlebars.compile(fs.readFileSync(file, 'utf8'), { noEscape: false });
  _cache.set(cacheKey, compiled);
  return compiled;
}

/**
 * Resolve the compiled template for a document type, honoring the cfg setting
 * with a safe fallback to the document type's default.
 * @param {string} docType  one of DEFAULTS keys
 * @param {object} cfg       flat company settings (cfg[SETTING_KEY[docType]])
 * @returns {{ id, render(view) }}
 */
function getInvoiceTemplate(docType, cfg) {
  const def = DEFAULTS[docType];
  if (!def) throw new Error(`Unknown invoice docType: ${docType}`);
  const requested = String((cfg && cfg[SETTING_KEY[docType]]) || '').trim() || def;
  const tpl = _load(docType, requested) || _load(docType, def);
  if (!tpl) {
    throw new Error(`No template file found for ${docType} (tried "${requested}" and default "${def}") ` +
      `under ${path.join(TEMPLATES_DIR, docType)}`);
  }
  return {
    id: _load(docType, requested) ? requested : def,
    render: (view) => tpl(view),
  };
}

// Test/hot-reload aid — drop the compiled cache so edited .hbs files re-load.
function clearCache() { _cache.clear(); }

module.exports = { getInvoiceTemplate, clearCache, DEFAULTS, SETTING_KEY };
