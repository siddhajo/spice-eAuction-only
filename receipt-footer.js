// receipt-footer.js — the "we have a portal" line printed on a lot receipt.
//
// A seller's receipt is the one piece of paper they always get, so it is the
// natural place to tell them their bills are downloadable. Three renderers
// print that footer and they do NOT share a config shape:
//
//   mobile-bridge.js  getReceiptConfig() → { portalUrl, companyEmail, ... }
//   server.js         /api/receipt/:lotId → getSettingsFlat(db), raw keys
//
// Taking the mobile shape only is exactly how the desktop slip ended up
// printing nothing, so this reads either one.
//
// Both sources are deliberately silent when the portal is switched off or
// the public address is blank: a receipt pointing at a shut door is worse
// than no line at all.

function _bool(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

// Normalise either config shape to { url, email }. `url` comes back blank
// unless the portal flag is on AND an address is configured.
function portalFooterParts(cfg) {
  const c = cfg || {};

  // Mobile shape: getReceiptConfig has already applied the flag, so a
  // non-empty portalUrl is permission to print.
  let url = String(c.portalUrl == null ? '' : c.portalUrl).trim();

  // Raw-settings shape: apply the flag here.
  if (!url && ('portal_public_url' in c || 'flag_customer_portal' in c)) {
    if (_bool(c.flag_customer_portal)) {
      url = String(c.portal_public_url == null ? '' : c.portal_public_url).trim();
    }
  }

  const email = String(
    (c.companyEmail != null && c.companyEmail !== '' ? c.companyEmail : '') ||
    c.kl_email || c.tn_email || ''
  ).trim();

  return { url, email };
}

// The address as printed: the scheme is noise on a 32-character thermal
// line and nobody types it, and a trailing slash goes the same way.
function portalFooterUrlText(cfg) {
  const { url } = portalFooterParts(cfg);
  return url ? url.replace(/^https?:\/\//i, '').replace(/\/+$/, '') : '';
}

// The stacked form, for the narrow receipts (PDF slip + ESC/POS thermal).
// Returns [] when there is nothing worth printing.
function receiptFooterLines(cfg) {
  const out = [];
  const url = portalFooterUrlText(cfg);
  if (url) {
    out.push('Your bills online:');
    out.push(url);
  }
  const { email } = portalFooterParts(cfg);
  if (email) out.push(email);
  return out;
}

module.exports = { portalFooterParts, portalFooterUrlText, receiptFooterLines };
