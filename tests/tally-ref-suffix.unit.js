// Configurable voucher-reference series tails (tally_*_ref_suffix).
//
// The token after the season — the "URD" in "1748/26-27/URD", the "SE" on a
// dealer debit note — used to be a string literal in tally-xml.js. Each is now
// a setting. Two things need pinning:
//
//   1. DEFAULTS REPRODUCE TODAY'S OUTPUT EXACTLY. These values land inside Tally
//      bill references; a shift on upgrade would orphan every reference already
//      aged under the old spelling. The URD purchase voucher carries NO tail by
//      default; the debit notes keep URD (planter) / SE (dealer).
//   2. The URD voucher's <VOUCHERNUMBER>, its <REFERENCE> and the commission
//      "Agst Ref" bill NAME all spell the ref the SAME way. If they drift,
//      Tally ages the Agst Ref as a brand-new bill instead of matching it.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { generURDPurchaseXML, generDebitNoteXML } = require(path.join(ROOT, 'tally-xml'));
const { DEFAULTS } = require(path.join(ROOT, 'company-config'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// A URD row with lots, so the commission Agst Ref is actually emitted:
// urdRefAmt = partyAmt − Σ lot payables must be non-zero, which it is as soon
// as a lot carries commission.
const URD_ROW = {
  date: '2026-08-19', ano: '14', invo: '1748', name: 'MURUGANANDAM K',
  qtytot: 100, amounttot: 400000, bilamttot: 400000, total: 400000,
  refundtot: 0, comhandtot: 4000,
  lots: [{ lot: '201', qty: 100, amount: 400000, refund: 0, com: 4000, sertax: 0,
           cgst: 0, sgst: 0, igst: 0 }],
};
const DN_ROW = (planter) => ({
  date: '2026-08-19', ano: '14', note_no: '111', name: 'AAA TRADERS',
  gstin: planter ? '' : '33AAAAA0000A1Z5', planter: planter ? 1 : 0,
  refundtot: 1000, cgsttot: 90, sgsttot: 90, igsttot: 0, total: 1180,
  lots: [],
});

const SEASON = { season_short: '26-27', tally_season: '2026-27' };
const vchNo   = xml => (xml.match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/) || [])[1];
const ref     = xml => (xml.match(/<REFERENCE>([^<]*)<\/REFERENCE>/) || [])[1];
const agstRef = xml => {
  const m = xml.match(/<BILLALLOCATIONS\.LIST>\s*<NAME>([^<]*)<\/NAME>\s*<BILLTYPE>Agst Ref<\/BILLTYPE>/);
  return m ? m[1] : null;
};

// ── 1. Defaults ────────────────────────────────────────────────────────
console.log('[1] Shipped defaults reproduce the existing output');
const dflt = Object.fromEntries(DEFAULTS.map(d => [d.key, d.value]));
check('tally_urd_purchase_ref_suffix ships BLANK (URD voucher grows no tail)',
      dflt.tally_urd_purchase_ref_suffix === '',
      JSON.stringify(dflt.tally_urd_purchase_ref_suffix));
check('tally_dn_planter_ref_suffix ships "URD"',
      dflt.tally_dn_planter_ref_suffix === 'URD', JSON.stringify(dflt.tally_dn_planter_ref_suffix));
check('tally_dn_dealer_ref_suffix ships "SE"',
      dflt.tally_dn_dealer_ref_suffix === 'SE', JSON.stringify(dflt.tally_dn_dealer_ref_suffix));

const urdDefault = generURDPurchaseXML([URD_ROW], { ...dflt, ...SEASON });
check('URD voucher number stops at the season — "1748/26-27"',
      vchNo(urdDefault) === '1748/26-27', JSON.stringify(vchNo(urdDefault)));
check('and so does the commission Agst Ref bill name',
      agstRef(urdDefault) === '1748/26-27', JSON.stringify(agstRef(urdDefault)));

const dnPlanter = generDebitNoteXML([DN_ROW(true)],  { ...dflt, ...SEASON });
const dnDealer  = generDebitNoteXML([DN_ROW(false)], { ...dflt, ...SEASON });
check('planter DN keeps its historical /URD tail',
      vchNo(dnPlanter) === '111/26-27/URD', JSON.stringify(vchNo(dnPlanter)));
check('dealer DN keeps its historical /SE tail',
      vchNo(dnDealer) === '111/26-27/SE', JSON.stringify(vchNo(dnDealer)));

// A cfg with the keys absent entirely (an install whose settings row predates
// this change) must behave identically to the shipped defaults.
console.log('\n[2] Absent keys fall back to the same values');
const urdAbsent = generURDPurchaseXML([URD_ROW], { ...SEASON });
check('no setting at all → URD voucher unchanged',
      vchNo(urdAbsent) === '1748/26-27', JSON.stringify(vchNo(urdAbsent)));
check('no setting at all → planter DN still /URD',
      vchNo(generDebitNoteXML([DN_ROW(true)], { ...SEASON })) === '111/26-27/URD');
check('no setting at all → dealer DN still /SE',
      vchNo(generDebitNoteXML([DN_ROW(false)], { ...SEASON })) === '111/26-27/SE');

// ── 3. Setting a tail ──────────────────────────────────────────────────
console.log('\n[3] Setting the URD purchase tail');
const urdOn = generURDPurchaseXML([URD_ROW],
  { ...dflt, ...SEASON, tally_urd_purchase_ref_suffix: 'URD' });
check('voucher number gains the tail', vchNo(urdOn) === '1748/26-27/URD',
      JSON.stringify(vchNo(urdOn)));
check('<REFERENCE> carries the same string', ref(urdOn) === vchNo(urdOn),
      `${JSON.stringify(ref(urdOn))} vs ${JSON.stringify(vchNo(urdOn))}`);
check('the Agst Ref bill name matches the voucher — Tally can age against it',
      agstRef(urdOn) === vchNo(urdOn),
      `${JSON.stringify(agstRef(urdOn))} vs ${JSON.stringify(vchNo(urdOn))}`);

console.log('\n[4] Separator handling — operators type a bare token');
const tail = (v) => vchNo(generURDPurchaseXML([URD_ROW],
  { ...dflt, ...SEASON, tally_urd_purchase_ref_suffix: v }));
check('"URD" → "/URD" (the slash is supplied)', tail('URD') === '1748/26-27/URD', tail('URD'));
check('"/URD" is passed through, not doubled to "//URD"',
      tail('/URD') === '1748/26-27/URD', tail('/URD'));
check('"-URD" keeps the operator\'s own separator',
      tail('-URD') === '1748/26-27-URD', tail('-URD'));
check('whitespace-only reads as blank', tail('   ') === '1748/26-27', tail('   '));
check('an arbitrary token works — nothing is special-cased about "URD"',
      tail('AGRI') === '1748/26-27/AGRI', tail('AGRI'));

console.log('\n[5] Blanking a debit-note tail');
const dnNoTail = generDebitNoteXML([DN_ROW(true)],
  { ...dflt, ...SEASON, tally_dn_planter_ref_suffix: '' });
check('planter DN tail can be removed', vchNo(dnNoTail) === '111/26-27',
      JSON.stringify(vchNo(dnNoTail)));
check('and the dealer tail is independent of it',
      vchNo(generDebitNoteXML([DN_ROW(false)],
        { ...dflt, ...SEASON, tally_dn_planter_ref_suffix: '' })) === '111/26-27/SE');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
