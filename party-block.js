// ── Party block — one shape for every "who" box on a bill ─────────────────
// The Bill of Supply and the Commission Bill both carry two party boxes
// (SELLER [BILLED FOR] and the buyer / consignee side), and each one is
// printed by two different renderers — the legacy PDFKit layout in
// invoice-pdf.js and the HTML templates under templates/. Four places, one
// agreed format:
//
//     NAME
//     3,NONDIMAGAN STREET
//     CUMBUM-625516
//     KERALA                 CODE: 32
//     CR: 32ABCDE1234F1Z5    PAN: ABCDE1234F
//     Ph: 9443447332         A/C: 0603053000000871
//
// One thing per line down the address: the name, the street, then the town
// with its PIN, then the STATE paired with its state code. None of those
// three ever share a line — that sharing is what this format exists to fix.
// Every remaining detail follows TWO PER ROW in a fixed order, so PAN sits in
// the same place on a planter's bill as on a dealer's.
//
// The order below is the print order. It is deliberate: the registration a
// document is raised against comes first, then identity, then reach.
const FIELDS = [
  { label: 'INV',    keys: ['invo'] },
  { label: 'GSTIN',  keys: ['gstin'] },
  { label: 'CR',     keys: ['cr', 'crno'] },
  { label: 'PAN',    keys: ['pan'] },
  { label: 'SBL',    keys: ['sbl'] },
  { label: 'AADHAR', keys: ['aadhar'] },
  // No PIN row — the PIN belongs to the postal address line above.
  // 'Ph' rather than 'PH' — it is an abbreviation, not an acronym like the
  // rest, and that is how the bill has always printed it.
  { label: 'Ph',     keys: ['phone', 'tel'] },
  { label: 'A/C',    keys: ['account', 'acctnum'] },
];

const pick = (p, keys) => {
  for (const k of keys) {
    const v = p && p[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

/**
 * Build the printable block for one party.
 *
 * @param {object} party  seller / purchaser / consignee, as the bill builders
 *                        shape it (address|addr, place, state, st_code|stCode,
 *                        cr|crno, pan, gstin, sbl, aadhar, pin, phone|tel,
 *                        account|acctnum, invo).
 * @param {object} [opts] { omit: ['Ph','A/C'] } drops those rows — used by the
 *                        commission bill, where the seller's phone and bank
 *                        account print only behind flag_commission_bank.
 */
function partyBlock(party, opts) {
  const p = party || {};
  const omit = new Set(((opts && opts.omit) || []).map(s => String(s).toUpperCase()));
  const up = s => String(s || '').trim().toUpperCase();

  const name    = String(p.name || '').trim();
  // The street stands alone, then the town carrying its PIN
  // ("CUMBUM-625516"), then the state. A trailing comma on the stored street
  // is trimmed — with the town on the next line it would dangle.
  const address = pick(p, ['address', 'addr']).replace(/[,\s]+$/, '');
  const town    = up(pick(p, ['place', 'pla']));
  const pin     = pick(p, ['pin']);
  const place   = town ? (pin ? town + '-' + pin : town) : pin;
  const state   = up(pick(p, ['state']));
  const stCode  = pick(p, ['st_code', 'stCode']);

  const rest = [];
  for (const f of FIELDS) {
    if (omit.has(f.label.toUpperCase())) continue;   // 'Ph' / 'PH' both drop it
    let v = pick(p, f.keys);
    if (!v) continue;
    // A registration is one thing or the other: a dealer's GSTIN or a
    // planter's CR code. A stale CR left on a GSTIN-bearing seller would
    // otherwise print both and read as two registrations.
    if (f.label === 'CR') {
      if (pick(p, ['gstin'])) continue;
      v = v.replace(/^\s*CR[.\s]+/i, '').trim();   // stored Kerala CRs carry the label
      // A seller whose CR was saved as the bare label "CR." has no
      // registration on file — print nothing, not an empty "CR:".
      if (!v) continue;
    }
    rest.push({ k: f.label, v, text: f.label + ': ' + v });
  }

  // Two per row, left cell first. A lone trailing detail keeps the right
  // cell empty rather than being centred or stretched.
  const rows = [];
  for (let i = 0; i < rest.length; i += 2) rows.push({ a: rest[i], b: rest[i + 1] || null });

  return {
    // The four lines that lead every party box, in print order. `place` is
    // the town with its PIN; `town` and `pin` are kept apart for a caller
    // that needs them so.
    name, address, place, state, stCode,
    town, pin,
    codeText: stCode ? 'CODE: ' + stCode : '',
    rest, rows,
    // Flat string form, for a renderer that draws plain lines. The pair is
    // joined with a wide gap so it still reads as two columns in monospace-ish
    // PDF text; renderers that can place cells should use `rows` instead.
    lines: [
      name,
      address,
      place,
      state ? state + (stCode ? '    CODE: ' + stCode : '') : '',
      ...rows.map(r => r.a.text + (r.b ? '    ' + r.b.text : '')),
    ].filter(Boolean),
  };
}

module.exports = { partyBlock };
