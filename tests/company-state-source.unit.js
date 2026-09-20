// COMPANY STATE — it comes from `business_state`, always.
//
// The company's own state used to be resolved as
// `tn_state → business_state → state`. Two facts make that wrong:
//
//   • `tn_state` ships with a factory default of "Tamil Nadu"
//     (company-config.js), so it is NEVER empty, and therefore
//     `business_state` was never reached on any install.
//   • `tn_state` lives in the `address_tn` settings category, which the UI
//     HIDES whenever business_state is KERALA (_STATE_HIDE_CATS in
//     public/index.html).
//
// A Kerala company therefore printed "TAMIL NADU" in its own BILLED TO block
// — beside a state CODE of 32, which is Kerala — sourced from a field the
// operator could not open to correct. RNS Spices hit exactly this on the
// purchase invoice.
//
// Two resolvers must agree: report-formatters.js is the real one, and
// _company-identity-fallback.js is the safety-net mirror every consumer
// falls back to. A change to one without the other reintroduces the bug on
// whichever deploy happens to be running the stale file.
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

const real = require(path.join(ROOT, 'report-formatters')).getCompanyIdentity;
const fallback = require(path.join(ROOT, '_company-identity-fallback')).resolve();
const RESOLVERS = [['report-formatters', real], ['identity-fallback', fallback]];

// RNS Spices as configured: Kerala business, every tn_* blank EXCEPT the
// untouched "Tamil Nadu" default, Kerala GSTIN and state code.
const RNS = {
  trade_name: 'RNS SPICES', short_name: 'RNS SPICES',
  business_state: 'KERALA',
  tn_state: 'Tamil Nadu', kl_state: 'Kerala',
  tn_address1: '', tn_gstin: '', tn_place: '', tn_pin: '',
  kl_address1: 'Door No: 14/623,624,625, RNS BUILDING',
  kl_gstin: '32ABFFR1926E1ZK',
  tally_state_code: '32',
  pan: 'ABFFR1926E',
};

console.log('[A] a Kerala install reads KERALA, not the hidden tn_state default');
for (const [who, fn] of RESOLVERS) {
  const id = fn(RNS);
  check(`${who}: state is KERALA`, id.state === 'KERALA', id.state);
  check(`${who}: the code agrees with the name`, id.stateCode === '32', id.stateCode);
}

console.log('\n[B] a Tamil Nadu install is unaffected');
for (const [who, fn] of RESOLVERS) {
  check(`${who}: TAMIL NADU install still reads TAMIL NADU`,
    fn({ ...RNS, business_state: 'TAMIL NADU' }).state === 'TAMIL NADU');
}

console.log('\n[C] the fallbacks behind business_state still work');
for (const [who, fn] of RESOLVERS) {
  check(`${who}: blank business_state falls through to tn_state`,
    fn({ ...RNS, business_state: '' }).state === 'TAMIL NADU');
  check(`${who}: whitespace counts as blank`,
    fn({ ...RNS, business_state: '   ' }).state === 'TAMIL NADU');
  check(`${who}: with neither, the generic 'state' answers`,
    fn({ business_state: '', tn_state: '', state: 'karnataka' }).state === 'KARNATAKA');
  check(`${who}: nothing configured yields an empty string, not a guess`,
    fn({}).state === '');
}

console.log('\n[D] the two resolvers agree on every case');
const CASES = [
  RNS,
  { ...RNS, business_state: 'TAMIL NADU' },
  { ...RNS, business_state: '' },
  { business_state: 'KERALA' },
  {},
];
CASES.forEach((c, i) => {
  check(`case ${i + 1}: same state from both`, real(c).state === fallback(c).state,
    `${real(c).state} vs ${fallback(c).state}`);
});

console.log('\n[E] the purchase invoice BILLED TO block picks it up');
{
  // The expression enrichPurchaseForPDF uses (server.js) for our own company.
  const billedToState = (cfg) => real(cfg).state || cfg.tn_state || 'Tamil Nadu';
  check('RNS prints KERALA on its purchase invoice', billedToState(RNS) === 'KERALA', billedToState(RNS));
  check('a TN company still prints TAMIL NADU',
    billedToState({ ...RNS, business_state: 'TAMIL NADU' }) === 'TAMIL NADU');
}

console.log('\n[F] PLACE OF SUPPLY carries that same state');
{
  // On a purchase invoice the goods land with us, so the place of supply is
  // our own state. Both renderers build the row the same way; the old
  // `s_place`/`s_state` pair it used to read is not a real setting, so the
  // row printed empty everywhere.
  const { buildPurchaseInvoiceView } = require(path.join(ROOT, 'pdf', 'render-purchase-html'));
  const row = (cfg) => {
    const v = buildPurchaseInvoiceView({ seller: { name: 'A SELLER', place: 'CUMBUM' }, summary: {}, lineItems: [] }, cfg, '1');
    return (v.rightPairs.find(p => p[0] === 'PLACE OF SUPPLY') || [])[1];
  };
  check('a Kerala install reads KERALA with its code', row(RNS) === 'KERALA  [32]', row(RNS));
  const tn = { ...RNS, business_state: 'TAMIL NADU', tally_state_code: '33' };
  check('a TN install reads TAMIL NADU with its code', row(tn) === 'TAMIL NADU  [33]', row(tn));
  const noCode = { ...RNS, tally_state_code: '', gstin: '', kl_gstin: '', tn_gstin: '' };
  check('no code configured prints the state alone, no empty brackets',
    row(noCode) === 'KERALA', JSON.stringify(row(noCode)));
  check('nothing configured leaves the row blank, never "undefined"',
    row({}) === '', JSON.stringify(row({})));
  // The dead settings must not come back as the source of THIS row. (Other
  // documents still name s_place/s_state as a last-resort fallback behind a
  // resolved identity; that is not what this guards.)
  const fs = require('fs');
  const posLines = [
    ...fs.readFileSync(path.join(ROOT, 'pdf', 'render-purchase-html.js'), 'utf8').split('\n'),
    ...fs.readFileSync(path.join(ROOT, 'invoice-pdf.js'), 'utf8').split('\n'),
  ].filter(l => l.includes("'PLACE OF SUPPLY'"));
  check('both renderers still draw the row', posLines.length === 2, String(posLines.length));
  check('neither builds it from cfg.s_place / cfg.s_state',
    posLines.every(l => !/s_place|s_state/.test(l)), posLines.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
