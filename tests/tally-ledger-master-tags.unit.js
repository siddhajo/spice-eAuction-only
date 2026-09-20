// LEDGER master tags — the party ledger XML we import into Tally has to carry
// everything Tally's own master export carries, or the party lands in Tally
// with an empty GSTIN field / no phone number and dad re-types it by hand.
//
// Reference: a Tally-exported LEDGER master (ELAICHIROYAL PRIVATE LIMITED (D),
// RNS SPICES AUCTION 2025-26). We deliberately do NOT reproduce its OLD* tags
// (OLDMAILINGNAME.LIST, OLDADDRESS.LIST, OLDLEDSTATENAME, OLDCOUNTRYNAME,
// OLDAUDITENTRYIDS.LIST) or RESERVEDNAME — those are export-side history that
// Tally ignores on import, and feeding OLDAUDITENTRYIDS back in confuses the
// audit trail.
const path = require('path');
const { generLedgerXML } = require(path.join(__dirname, '..', 'tally-xml.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
const has = (xml, tag) => xml.includes(tag);
// Tag order matters to Tally on some builds — compare positions.
const at = (xml, tag) => xml.indexOf(tag);

const RD = {
  kind: 'party', partyKind: 'rd',
  name: 'ELAICHIROYAL PRIVATE LIMITED (D)', parent: 'DEALERS',
  gstin: '32AAHCE4551A1Z8', pan: 'AAHCE4551A',
  address: '140,141,', place: 'NIRAPPELKADA', pin: '685551', state: 'Kerala',
  mobile: '9447728371', applicableFrom: '20230401',
};
const URD = {
  kind: 'party', partyKind: 'urd',
  name: 'SOME PLANTER-[ABCDE1234F]', parent: 'Planters',
  gstin: '', pan: 'ABCDE1234F',
  address: 'Estate Rd', place: 'BODI', pin: '625513', state: '',
  mobile: '9876543210', applicableFrom: '20250401',
};

console.log('[1] RD party carries every tag the reference master has');
const rd = generLedgerXML([RD], {}, { companyName: 'X' }).replace(/\r/g, '');
for (const tag of [
  '<CURRENCYNAME>₹</CURRENCYNAME>',
  '<PRIORSTATENAME>Kerala</PRIORSTATENAME>',
  '<INCOMETAXNUMBER>AAHCE4551A</INCOMETAXNUMBER>',
  '<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>',
  '<VATDEALERTYPE>Regular</VATDEALERTYPE>',
  '<PARENT>DEALERS</PARENT>',
  '<COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>',
  '<LEDGERMOBILE>9447728371</LEDGERMOBILE>',
  '<LEDGERCOUNTRYISDCODE>+91</LEDGERCOUNTRYISDCODE>',
  '<PARTYGSTIN>32AAHCE4551A1Z8</PARTYGSTIN>',
  '<ISBILLWISEON>Yes</ISBILLWISEON>',
  '<ASORIGINAL>Yes</ASORIGINAL>',
  '<ISCHEQUEPRINTINGENABLED>Yes</ISCHEQUEPRINTINGENABLED>',
  '<NAME.LIST TYPE="String">',
  '<LANGUAGEID> 1033</LANGUAGEID>',
  '<STATE>Kerala</STATE>',
  '<PLACEOFSUPPLY>Kerala</PLACEOFSUPPLY>',
  '<GSTIN>32AAHCE4551A1Z8</GSTIN>',
  '<ADDRESS.LIST TYPE="String">',
  '<PINCODE>685551</PINCODE>',
  '<COUNTRY>India</COUNTRY>',
  '<NAME>Primary Mobile No.</NAME>',
  '<PHONENUMBER>9447728371</PHONENUMBER>',
  '<COUNTRYISDCODE>+91</COUNTRYISDCODE>',
  '<ISDEFAULTWHATSAPPNUM>Yes</ISDEFAULTWHATSAPPNUM>',
]) check(tag, has(rd, tag));

console.log('[2] Tag order matches the reference');
const order = ['<CURRENCYNAME>', '<PRIORSTATENAME>', '<INCOMETAXNUMBER>',
  '<GSTREGISTRATIONTYPE>', '<VATDEALERTYPE>', '<PARENT>', '<COUNTRYOFRESIDENCE>',
  '<LEDGERMOBILE>', '<LEDGERCOUNTRYISDCODE>', '<PARTYGSTIN>', '<ISBILLWISEON>',
  '<LANGUAGENAME.LIST>', '<LEDGSTREGDETAILS.LIST>', '<LEDMAILINGDETAILS.LIST>',
  '<CONTACTDETAILS.LIST>'];
let ordered = true, badPair = '';
for (let i = 1; i < order.length; i++) {
  if (at(rd, order[i - 1]) >= at(rd, order[i])) { ordered = false; badPair = order[i - 1] + ' before ' + order[i]; break; }
}
check('every tag sits where the reference puts it', ordered, badPair);

console.log('[3] Export-only history tags stay out');
for (const tag of ['RESERVEDNAME', 'OLDMAILINGNAME', 'OLDADDRESS',
                   'OLDLEDSTATENAME', 'OLDCOUNTRYNAME', 'OLDAUDITENTRYIDS'])
  check('no <' + tag + '>', !has(rd, tag));

console.log('[4] URD party: unregistered, so no GSTIN tags');
const urd = generLedgerXML([URD], {}, { companyName: 'X' }).replace(/\r/g, '');
// Two different spellings, and each belongs where the reference puts it:
// the flat ledger-level tag says "Unregistered", the dated history inside
// LEDGSTREGDETAILS.LIST says "Unregistered/Consumer".
check('ledger-level GSTREGISTRATIONTYPE = Unregistered',
  has(urd, '<GSTREGISTRATIONTYPE>Unregistered</GSTREGISTRATIONTYPE>'));
check('LEDGSTREGDETAILS GSTREGISTRATIONTYPE = Unregistered/Consumer',
  has(urd, '<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>'));
// PAN is the same value that builds the "-[PAN]" ledger-name suffix, so if we
// know it well enough to name the ledger with it we write it into the ledger.
check('INCOMETAXNUMBER carries the planter PAN',
  has(urd, '<INCOMETAXNUMBER>ABCDE1234F</INCOMETAXNUMBER>'));
check('PRIORSTATENAME stays empty (no previous registration)',
  has(urd, '<PRIORSTATENAME></PRIORSTATENAME>'));
check('no PARTYGSTIN on an agriculturist', !has(urd, '<PARTYGSTIN>'));
check('still gets the phone tags', has(urd, '<LEDGERMOBILE>9876543210</LEDGERMOBILE>')
  && has(urd, '<PHONENUMBER>9876543210</PHONENUMBER>'));

console.log('[5] Phone numbers are normalised to a bare 10-digit national number');
const phoneOf = (v) => {
  const x = generLedgerXML([{ ...RD, mobile: v }], {}, {}).replace(/\r/g, '');
  const m = x.match(/<LEDGERMOBILE>(.*?)<\/LEDGERMOBILE>/);
  return m ? m[1] : null;
};
check('"+91 94477-28371" → 9447728371', phoneOf('+91 94477-28371') === '9447728371');
check('"0 98765 43210" → 9876543210',   phoneOf('0 98765 43210')   === '9876543210');
check('"9447728371" unchanged',          phoneOf('9447728371')      === '9447728371');
// A junk / part-typed number must not reach Tally — a wrong number on a party
// ledger is worse than no number, and an empty tag would blank one already on file.
check('a 6-digit fragment emits no tag at all', phoneOf('123456') === null);
check('a blank phone emits no tag at all',      phoneOf('') === null);
check('and no orphan CONTACTDETAILS.LIST either',
  !generLedgerXML([{ ...RD, mobile: '' }], {}, {}).includes('<CONTACTDETAILS.LIST>'));

console.log('[6] Master (non-party) ledgers stay lean');
const tax = generLedgerXML([{ kind: 'tax', name: 'CGST 2.5%', parent: 'Duties & Taxes',
  dutyHead: 'CGST', rateOfTax: 2.5 }], {}, {}).replace(/\r/g, '');
for (const tag of ['<PARTYGSTIN>', '<LEDGERMOBILE>', '<CONTACTDETAILS.LIST>',
                   '<GSTREGISTRATIONTYPE>', '<ISBILLWISEON>'])
  check('tax ledger has no ' + tag, !has(tax, tag));

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
