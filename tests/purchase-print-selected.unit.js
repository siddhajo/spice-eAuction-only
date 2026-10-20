// RD Purchase → Print Selected.
//
// Two things this guards, both reported from a live print run:
//
//  [pages]  Every selected purchase invoice must start on its OWN sheet.
//           The HTML engine renders up to 25 invoices in ONE Chromium pass
//           by concatenating template fragments, so the only thing standing
//           between "one invoice per page" and one long continuous scroll is
//           a page-break rule inside each template. A template added without
//           it would run its invoices together and nothing else would notice.
//
//  [date]   The supply line printed "Dated: NaN-Invalid Date-aN" on every
//           purchase invoice. {{shortDate}} was calling new Date(val) on a
//           dd/mm/yyyy display string — JS reads that as MONTH/day/year, so
//           "19/08/2026" is month 19 and an Invalid Date, whose pieces
//           stringify to NaN / "Invalid Date" / "aN".
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); }
};

console.log('[pages] every concatenated invoice starts on a fresh sheet');
// The batch renderer joins fragments into one document, so the break has to
// live in the template. Assert it for EVERY purchase layout — the bug this
// replaces was a whole trade's invoices running together on screen.
const dir = path.join(ROOT, 'templates', 'purchase-invoice');
const tpls = fs.readdirSync(dir).filter(f => f.endsWith('.hbs'));
check('there are purchase templates to check', tpls.length > 0, String(tpls.length));
for (const f of tpls) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  // The rule is a sibling selector, so it only fires when the fragments are
  // adjacent siblings — which means the root element must carry the class.
  const hasRule = /\.pi-page\s*\+\s*\.pi-page\s*\{[^}]*page-break-before:\s*always/.test(src);
  const rootIsPiPage = /^<div class="pi-page">/m.test(src);
  check(`${f}: breaks before each later invoice`, hasRule, 'missing .pi-page + .pi-page rule');
  check(`${f}: its root element is the .pi-page the rule targets`, rootIsPiPage,
        'the rule cannot match if the fragment root is some other element');
}

console.log('\n[date] the supply line prints a real date');
// Re-register the helpers and read shortDate back off Handlebars, so this
// tests the SHIPPED helper rather than a copy of it.
const Handlebars = require('handlebars');
require(path.join(ROOT, 'pdf', 'hbs-helpers')).registerHelpers
  ? require(path.join(ROOT, 'pdf', 'hbs-helpers')).registerHelpers()
  : require(path.join(ROOT, 'pdf', 'invoice-templates'));   // whichever wires them
const shortDate = Handlebars.helpers.shortDate;
check('the shortDate helper is registered', typeof shortDate === 'function');

if (typeof shortDate === 'function') {
  // dd/mm/yyyy is what actually reaches the template — purchase invoiceDate
  // is already a display string by the time the view is built.
  check('dd/mm/yyyy renders, and as the right day',
        shortDate('19/08/2026') === '19-Aug-26', shortDate('19/08/2026'));
  check('…a day past the 12th proves it is not read as month/day',
        shortDate('17/10/2026') === '17-Oct-26', shortDate('17/10/2026'));
  check('ISO still works', shortDate('2026-08-19') === '19-Aug-26', shortDate('2026-08-19'));
  check('an ISO timestamp works', shortDate('2026-08-19 14:05:00') === '19-Aug-26',
        shortDate('2026-08-19 14:05:00'));
  check('dd-mm-yyyy works', shortDate('19-08-2026') === '19-Aug-26', shortDate('19-08-2026'));
  check('a Date object works', shortDate(new Date(2026, 7, 19)) === '19-Aug-26',
        String(shortDate(new Date(2026, 7, 19))));
  // The actual reported symptom, stated as its own assertion.
  for (const v of ['19/08/2026', '17/10/2026', '2026-08-19', '19-08-2026', new Date()]) {
    check(`no NaN / Invalid Date for ${v instanceof Date ? 'a Date object' : v}`,
          !/NaN|Invalid/.test(String(shortDate(v))), String(shortDate(v)));
  }
  // Unparseable input shows the operator the real value rather than three
  // kinds of NaN — and is never silently truncated.
  check('unparseable input falls through verbatim', shortDate('nonsense') === 'nonsense',
        String(shortDate('nonsense')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
