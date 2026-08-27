// Letterhead-layout UDFs on the ISP sales voucher.
//
// The TallyPrime add-on in tally-addon/SpiceLetterheadInvoice.tdl prints two
// values that Tally itself has no field for — the auction number and the
// buyer's Spices Board licence. They travel on the imported voucher as UDFs,
// and the two halves have to agree exactly or Tally drops the value with no
// error at all:
//
//   • the UDF NAME here must match the [System: UDF] declaration in the TDL
//   • the voucher UDFs must sit OUTSIDE every *.LIST, so Tally binds them to
//     the voucher rather than to an inventory entry
//
// A blank value must emit NO tag: an empty UDF prints as a stray label with a
// dangling colon in the layout, which is worse than the line being absent.
//
// Lot no and bag count are deliberately NOT UDFs. They are native per-entry
// fields (<BASICPACKAGEMARKS> / <BASICNUMPACKAGES>) — the customer's own
// BagLot.txt add-on sums $BasicNumPackages across InventoryEntries in
// production, which proves they bind per inventory entry. The assertions below
// pin that they stay native, because moving them to UDFs would silently break
// every voucher already sitting in Tally.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { generSalesIspXML, buildSalesIspRows } = require(path.join(ROOT, 'tally-xml'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

const CFG = { tally_state_code: '33', tally_detailed: true };

const ROW = {
  ano: '14', date: '2026-08-19', sale: 'L', invo: '9',
  partyName: 'AAA TRADERS', partyGstin: '33AAAAA0000A1Z5',
  address: '12 Main Road', place: 'BODINAYAKANUR', pin: '625513',
  sbl: 'SBL/TN/1234',
  lots: [
    { lot: '201', bag: 5, qty: 100, rate: 4000, amount: 400000 },
    { lot: '202', bag: 3, qty: 60,  rate: 4100, amount: 246000 },
  ],
  amounttot: 646000, gunnyAmt: 1320, gunnyBags: 8,
  cgst: 16165, sgst: 16165, igst: 0,
  total: 679650, totalRounded: 679650,
};

const xml = generSalesIspXML([ROW], CFG);

// ── UDF names must match the TDL declarations ────────────────────────────
check('SpiceAuctionNo UDF carries row.ano',
  /<UDF:SPICEAUCTIONNO DESC="`SpiceAuctionNo`">14<\/UDF:SPICEAUCTIONNO>/.test(xml));

check('SpiceBuyerSBL UDF carries row.sbl',
  /<UDF:SPICEBUYERSBL DESC="`SpiceBuyerSBL`">SBL\/TN\/1234<\/UDF:SPICEBUYERSBL>/.test(xml));

// ── Lot / bags stay NATIVE, not UDFs ─────────────────────────────────────
// Vouchers already in Tally carry these tags. If they were ever moved to UDFs,
// every historical invoice would print with blank Lot/Bags cells until it was
// re-imported — and nothing would report an error.
const invBlocks = xml.match(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/g) || [];

check('lot no rides in BASICPACKAGEMARKS, one per lot',
  invBlocks.filter(b => /<BASICPACKAGEMARKS>20[12]<\/BASICPACKAGEMARKS>/.test(b)).length === 2,
  invBlocks.length + ' inventory blocks');

check('bag count rides in BASICNUMPACKAGES',
  invBlocks.some(b => b.includes('<BASICNUMPACKAGES>5</BASICNUMPACKAGES>')) &&
  invBlocks.some(b => b.includes('<BASICNUMPACKAGES>3</BASICNUMPACKAGES>')));

check('no per-line lot/bag UDF is emitted',
  !xml.includes('SPICELOTNO') && !xml.includes('SPICEBAGS'));

// ── Binding: voucher UDFs must attach to the voucher, not an entry ───────
let stripped = xml;
for (const b of invBlocks) stripped = stripped.replace(b, '');
check('voucher UDFs live outside every *.LIST',
  stripped.includes('SPICEAUCTIONNO') && stripped.includes('SPICEBUYERSBL'));

check('voucher UDFs sit before </VOUCHER>',
  xml.indexOf('SPICEAUCTIONNO') < xml.indexOf('</VOUCHER>'));

// ── The TDL half of the contract ─────────────────────────────────────────
// The UDF names and the native field names must both match what the layout
// reads. A rename on one side alone fails silently in Tally.
const tdl = require('fs').readFileSync(
  path.join(ROOT, 'tally-addon', 'SpiceLetterheadInvoice.tdl'), 'utf8');

check('TDL declares SpiceAuctionNo and SpiceBuyerSBL',
  /SpiceAuctionNo\s*:\s*String/.test(tdl) && /SpiceBuyerSBL\s*:\s*String/.test(tdl));

check('TDL declares no lot/bag UDF',
  !/SpiceLotNo\s*:\s*String/.test(tdl) && !/SpiceBags\s*:\s*Number/.test(tdl));

check('TDL reads the native lot/bag fields',
  tdl.includes('$BasicPackageMarks') && tdl.includes('$BasicNumPackages'));

// Every charge money-field must be guarded by @@SpiceIsChargeLedger. A hidden
// line can still accumulate into Total:, and unguarded these would feed the
// PARTY ledger's amount — the whole invoice value — into the column totals.
// The guard must be PRESENT in the expression; it need not lead it. The tax
// columns now nest it inside an all-zero-column test, which is why this checks
// for the guard anywhere in the Set as rather than at the start.
for (const f of ['CValue', 'CTaxable', 'CCGST', 'CSGST', 'CIGST', 'CTotal']) {
  const blk = tdl.slice(tdl.indexOf(`[Field: SpiceFld${f}]`));
  const setAs = (blk.match(/Set as\s*:.*/) || [''])[0];
  check(`SpiceFld${f} is guarded against non-charge ledgers`,
    setAs.includes('@@SpiceIsChargeLedger'), setAs.trim());
  check(`SpiceFld${f} has balanced parentheses`,
    (setAs.match(/\(/g) || []).length === (setAs.match(/\)/g) || []).length, setAs.trim());
}

// The party ledger must be excluded from charge line items by name.
check('charge filter excludes the party ledger',
  /SpiceIsChargeLedger[\s\S]{0,120}\$LedgerName != \$PartyLedgerName/.test(tdl));

// ── TDL syntax lint ──────────────────────────────────────────────────────
// TDL has no offline compiler, so every syntax slip costs a trip to the Tally
// machine to discover. These two rules each cost one such round trip; they are
// pinned here so a re-edit can never reintroduce them silently.
//
// RULE 1 — no attribute may share a line with its [Definition] header.
//   `[Style: X] : Font : "Arial" : Height : 13`  → T0051 (several attributes)
//   `[Line: X]  : Field : Y`                     → T0051 (even just one)
// Both must be written with the attribute on its own indented line.
const tdlLines = tdl.split(/\r?\n/);
const compact = [];
tdlLines.forEach((ln, i) => {
  if (/^\s*;;/.test(ln)) return;              // comments are free-form
  if (/^\[[^\]]*\]\s*:/.test(ln)) compact.push((i + 1) + ': ' + ln.trim());
});
check('no compact [Definition] : attr : value forms remain',
  compact.length === 0,
  compact.join('\n         '));

// RULE 2 — attribute placement (T0014 "Incorrect attribute X for definition Y").
// Each entry is an attribute that is valid SOMEWHERE but not on the listed
// definition type. Both of these cost a failed load:
//   Border on a Form  — belongs on Part / Line / Field
//   Height on a Field — belongs on Style / Form; a Field uses `Lines`
const MISPLACED = [
  { def: 'Form',  attr: 'Border', hint: 'use Border on a Part/Line/Field' },
  { def: 'Field', attr: 'Height', hint: 'a Field sizes vertically with Lines' },
];
for (const { def, attr, hint } of MISPLACED) {
  const bad = [];
  let cur = null;
  tdlLines.forEach((ln, i) => {
    const m = ln.match(/^\[#?([A-Za-z]+):\s*([^\]]+)\]/);
    if (m) { cur = { type: m[1], name: m[2].trim() }; return; }
    if (/^\s*;;/.test(ln)) return;
    if (cur && cur.type === def && new RegExp(`^\\s+${attr}\\s*:`).test(ln)) {
      bad.push(`${i + 1}: ${def} ${cur.name} — ${hint}`);
    }
  });
  check(`no ${attr} attribute on a ${def}`, bad.length === 0, bad.join('\n         '));
}

// RULE 3 — a line named in `Repeat` must also appear in that part's `Lines`,
// and a Part may carry only ONE `Repeat` (two do not stack). Breaking either
// raises the runtime error "Could not find the Repeated Line!".
const partBlocks = tdl.match(/^\[#?Part:[\s\S]*?(?=^\[|\Z)/gm) || [];
const repeatProblems = [];
for (const b of partBlocks) {
  const name = (b.match(/^\[#?Part:\s*([^\]]+)\]/) || [])[1];
  const repeats = [...b.matchAll(/^\s*Repeat\s*:\s*([^:\n]+?)\s*:\s*(\S+)/gm)];
  if (!repeats.length) continue;
  if (repeats.length > 1) {
    repeatProblems.push(`${name}: ${repeats.length} Repeat attributes (only one per Part)`);
  }
  const declared = [...b.matchAll(/^\s*Lines?\s*:\s*(.+)$/gm)]
    .flatMap(m => m[1].split(',').map(s => s.trim()));
  for (const [, line] of repeats) {
    if (!declared.includes(line)) {
      repeatProblems.push(`${name}: repeats "${line}" but it is not in Lines`);
    }
  }
}
check('every repeated line is declared in its part\'s Lines, one Repeat per Part',
  repeatProblems.length === 0,
  repeatProblems.join('\n         '));

// RULE 4 — a continued line must NOT begin with a colon. TDL continues a line
// with a trailing `+`; a leading `:` on the next line is read as part of the
// expression and fails at runtime with "Cannot understand. Bad formula!".
const colonCont = [];
tdlLines.forEach((ln, i) => {
  if (/^\s*;;/.test(ln)) return;
  if (/^\s+:/.test(ln)) colonCont.push((i + 1) + ': ' + ln.trim());
});
check('no continuation line begins with a colon',
  colonCont.length === 0, colonCont.join('\n         '));

// RULE 5 — every Line and Field referenced anywhere must actually be defined.
// A dangling reference (e.g. a line left in a Lines list after its definition
// was removed) is only discovered when Tally renders that part.
const defined = new Set(
  [...tdl.matchAll(/^\[#?(Line|Field|Part):\s*([^\]]+)\]/gm)].map(m => m[2].trim())
);
const referenced = new Map();
for (const m of tdl.matchAll(/^\s*(?:Lines?|Fields?|Right Fields?|Parts?|Use|Field|Part)\s*:\s*(.+)$/gm)) {
  for (const raw of m[1].split(',')) {
    const n = raw.trim();
    // skip numeric (Lines : 3), quoted literals, and expressions
    if (!n || /^[0-9]/.test(n) || /["#$@%()+]/.test(n)) continue;
    // Tally built-ins referenced by name rather than defined here.
    if (['Info Field', 'Simple Field', 'Name Field', 'Default'].includes(n)) continue;
    if (!referenced.has(n)) referenced.set(n, true);
  }
}
const dangling = [...referenced.keys()].filter(n => !defined.has(n));
check('no dangling Line/Field/Part references',
  dangling.length === 0, dangling.join(', '));

// RULE 5b — the mirror image: a Part or Line that is DEFINED but never
// referenced renders nothing at all, silently. Same failure class as the
// commodity band, but from the other direction — easy to create by adding a
// new section and forgetting to put it in the Form's Parts list.
const orphans = [];
for (const m of tdl.matchAll(/^\[(Part|Line):\s*([^\]]+)\]/gm)) {
  const name = m[2].trim();
  if (!referenced.has(name)) orphans.push(`${m[1]}: ${name}`);
}
check('no Part or Line is defined but never referenced',
  orphans.length === 0, orphans.join(', '));

// RULE 6 — anything declared in [System: Formula] must be referenced with @@,
// never ##. `##` is variable syntax; used on a formula it silently yields an
// empty value. This one shipped a rendered invoice with no company letterhead,
// no tax columns, no totals and no amount-in-words — 84 bad references, all
// failing quietly. Nothing errors, the values just vanish.
const formulaNames = new Set();
for (const blk of tdl.match(/^\[System: Formula\][\s\S]*?(?=^\[|\Z)/gm) || []) {
  for (const m of blk.matchAll(/^\s{2,}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)) formulaNames.add(m[1]);
}
check('[System: Formula] block actually parsed', formulaNames.size > 20,
  'found ' + formulaNames.size);

const hashRefs = [...new Set([...tdl.matchAll(/##([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]))]
  .filter(n => formulaNames.has(n));
check('no [System: Formula] value is referenced with ## instead of @@',
  hashRefs.length === 0, hashRefs.join(', '));

// RULE 7 — a Part takes `Lines`, plural. The singular `Line :` is ignored, so
// the part renders as nothing (this silently dropped the commodity band).
const singularLine = (tdl.match(/^\[#?Part:[\s\S]*?(?=^\[|\Z)/gm) || [])
  .filter(b => /^\s+Line\s*:/m.test(b))
  .map(b => (b.match(/^\[#?Part:\s*([^\]]+)\]/) || [])[1]);
check('no Part uses singular "Line :"',
  singularLine.length === 0, singularLine.join(', '));

// RULE 8 — chained $$ calls need parentheses. `$$String:$$Number:$X` parses the
// second function as an argument to the first and yields blank. This blanked
// the entire Bags column while the plain Lot No field beside it worked.
// $$Abs:$$CollAmtTotal:… is the one accepted form: $$Abs takes a single value
// argument, so the inner call is unambiguous.
const chained = [];
tdlLines.forEach((ln, i) => {
  if (/^\s*;;/.test(ln)) return;
  const m = ln.match(/\$\$([A-Za-z]+):\$\$([A-Za-z]+):/);
  if (m && m[1] !== 'Abs') chained.push((i + 1) + ': ' + ln.trim());
});
check('no unparenthesised chained $$ calls', chained.length === 0,
  chained.join('\n         '));

// RULE 9 — `Total :` on a Part does not carry across parts, and cannot be read
// from inside a [System: Formula] at all. Totals must come from collection
// aggregates. This printed every total, the grand total and amount-in-words
// blank on a page that otherwise rendered fine.
const codeOnly = tdlLines.filter(l => !/^\s*;;/.test(l)).join('\n');
check('no Part declares a Total: list', !/^\s*Total\s*:/m.test(codeOnly));
check('no $$Total: reference remains in code', !codeOnly.includes('$$Total:'));

// The Sample row is a display-only deduction derived from the CARDAMOM lots
// only. Summing raw InventoryEntries would fold in the Gunny line's 200/Nos
// rate and overstate the sample — a wrong figure on a tax document, and one
// that would look plausible.
check('sample qty and amount derive from the cardamom-only collection',
  /SpiceLotCount\s*:\s*\$\$CollNumTotal:SpiceCardLots:/.test(tdl) &&
  /SpiceSampleAmt\s*:\s*\$\$CollNumTotal:SpiceCardLots:/.test(tdl));
check('sample never feeds the taxable total',
  !/SpiceTotTaxable[\s\S]{0,120}SpiceSample/.test(tdl));
check('cardamom collection filters on the stock item',
  /SpiceIsCardLot\s*:\s*\$StockItemName\s*=\s*@@SpiceItemCard/.test(tdl));

// The bands the .hbs tints must carry a print background — and it must sit on
// the PART. `Print BG` directly on a Part is the only form the working
// reference uses ([#Part: EXPINV Column] Print BG:Black); the Line-level
// `Local : Field : Default : Print BG` form was tried first and never
// rendered. Band lines that live inside a larger part therefore get a part of
// their own, which is why SpiceLHPartyHeadPart / SpiceLHItemHeadPart exist.
for (const part of ['SpiceLHTitle', 'SpiceLHPartyHeadPart',
                    'SpiceLHCommodity', 'SpiceLHItemHeadPart']) {
  const blk = tdl.slice(tdl.indexOf(`[Part: ${part}]`));
  const end = blk.indexOf('\n[', 1);
  // Literal colour token, not a formula: the reference always writes
  // `Print BG:Black`, and a formula returning the quoted string "Light Green"
  // is not the same thing.
  check(`${part} is tinted at part level`,
    /^\s*Print BG\s*:\s*[A-Za-z]/m.test(blk.slice(0, end > 0 ? end : 600)));
}

// And no Line-level tint may creep back in (comments excluded).
check('no Line-level Print BG remains',
  !tdlLines.some(l => !/^\s*;;/.test(l) && /Local\s*:\s*Field\s*:\s*Default\s*:\s*Print BG/.test(l)));

// The QR part's inner field MUST stay empty — the image is drawn by the Part,
// and putting content in that field is what stopped the QR rendering.
const qrFld = tdl.slice(tdl.indexOf('[Field: SpiceFldQrEmpty]'));
check('QR inner field is empty',
  /Set as\s*:\s*""/.test(qrFld.slice(0, 400)));

// Totals must still cover goods AND charges — the two live in separate
// collections, and dropping either prints an invoice whose columns do not add
// up to its own grand total.
check('taxable total sums goods and charges collections',
  /SpiceGoodsAmt\s*:[\s\S]{0,80}InventoryEntries/.test(tdl) &&
  /SpiceChargeAmt\s*:[\s\S]{0,80}SpiceChargeLedgers/.test(tdl) &&
  /SpiceTotTaxable\s*:\s*@@SpiceGoodsAmt\s*\+\s*@@SpiceChargeAmt/.test(tdl));

// Every collection referenced by a Repeat or an aggregate must be defined,
// unless it is one of Tally's built-ins.
const BUILTIN_COLL = new Set(['InventoryEntries', 'LedgerEntries', 'Voucher']);
const definedColl = new Set(
  [...tdl.matchAll(/^\[Collection:\s*([^\]]+)\]/gm)].map(m => m[1].trim()));
const usedColl = new Set([
  ...[...tdl.matchAll(/^\s*Repeat\s*:[^:]+:\s*(\S+)/gm)].map(m => m[1].trim()),
  ...[...tdl.matchAll(/\$\$Coll(?:Amt|Num)Total:([A-Za-z][A-Za-z0-9_]*):/g)].map(m => m[1].trim()),
]);
const missingColl = [...usedColl].filter(c => !definedColl.has(c) && !BUILTIN_COLL.has(c));
check('every referenced collection is defined', missingColl.length === 0,
  missingColl.join(', '));

// ── Blank values emit nothing ────────────────────────────────────────────
const bare = generSalesIspXML([{ ...ROW, sbl: '', ano: '' }], CFG);
check('blank sbl emits no SpiceBuyerSBL tag', !bare.includes('SPICEBUYERSBL'));
check('blank ano emits no SpiceAuctionNo tag', !bare.includes('SPICEAUCTIONNO'));

// ── Aggregate mode ───────────────────────────────────────────────────────
// With tally_detailed off there is one inventory line covering every lot, so
// there is no single lot number to print and the Lot cell renders blank.
const agg = generSalesIspXML([ROW], { ...CFG, tally_detailed: false });
check('aggregate mode emits no per-lot marks', !agg.includes('<BASICPACKAGEMARKS>201<'));
check('aggregate mode still emits voucher UDFs', agg.includes('SPICEAUCTIONNO'));

// ── The builder must actually select the buyer SBL ───────────────────────
// A UDF that is always blank in production is worse than no UDF: the layout
// silently prints an empty SBL. Pin that buildSalesIspRows reads the column.
const src = require('fs').readFileSync(path.join(ROOT, 'tally-xml.js'), 'utf8');
const builder = src.slice(src.indexOf('function buildSalesIspRows'));
check('buildSalesIspRows selects buyers.sbl', /b\.sbl\s+FROM buyers/.test(builder));
check('buildSalesIspRows maps it onto row.sbl', /sbl:\s*r\.buyer_sbl/.test(builder));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
