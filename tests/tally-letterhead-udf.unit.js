// Letterhead-layout UDFs on the ISP sales voucher.
//
// The TallyPrime add-on in tally-addon/SpiceLetterheadInvoice.tdl prints four
// values that Tally itself has no field for. They travel on the imported
// voucher as UDFs, and the two halves have to agree exactly or Tally drops the
// value with no error at all:
//
//   • the UDF NAME here must match the [System: UDF] declaration in the TDL
//   • the per-line UDFs must sit INSIDE <ALLINVENTORYENTRIES.LIST> (Tally binds
//     them to the inventory entry), the voucher UDFs OUTSIDE every *.LIST
//     (bound to the voucher)
//
// A blank value must emit NO tag: an empty UDF prints as a stray label with a
// dangling colon in the layout, which is worse than the line being absent.
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

check('SpiceLotNo UDF emitted once per lot',
  (xml.match(/<UDF:SPICELOTNO DESC="`SpiceLotNo`">/g) || []).length === 2,
  'got ' + (xml.match(/<UDF:SPICELOTNO DESC="`SpiceLotNo`">/g) || []).length);

check('SpiceLotNo values are the lot numbers',
  /<UDF:SPICELOTNO DESC="`SpiceLotNo`">201</.test(xml) &&
  /<UDF:SPICELOTNO DESC="`SpiceLotNo`">202</.test(xml));

check('SpiceBags UDF is numeric and per-lot',
  /<UDF:SPICEBAGS DESC="`SpiceBags`">5</.test(xml) &&
  /<UDF:SPICEBAGS DESC="`SpiceBags`">3</.test(xml));

// ── Binding: which object each UDF attaches to ───────────────────────────
// The per-line UDFs must fall between an <ALLINVENTORYENTRIES.LIST> open tag
// and its close. The voucher UDFs must fall outside every such block.
const invBlocks = xml.match(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/g) || [];
check('lot UDFs live inside inventory entries',
  invBlocks.filter(b => b.includes('SPICELOTNO')).length === 2,
  invBlocks.length + ' inventory blocks, ' + invBlocks.filter(b => b.includes('SPICELOTNO')).length + ' with a lot UDF');

let stripped = xml;
for (const b of invBlocks) stripped = stripped.replace(b, '');
check('voucher UDFs live outside every *.LIST',
  stripped.includes('SPICEAUCTIONNO') && stripped.includes('SPICEBUYERSBL') &&
  !stripped.includes('SPICELOTNO'));

check('voucher UDFs sit before </VOUCHER>',
  xml.indexOf('SPICEAUCTIONNO') < xml.indexOf('</VOUCHER>'));

// ── Blank values emit nothing ────────────────────────────────────────────
const bare = generSalesIspXML([{ ...ROW, sbl: '', ano: '' }], CFG);
check('blank sbl emits no SpiceBuyerSBL tag', !bare.includes('SPICEBUYERSBL'));
check('blank ano emits no SpiceAuctionNo tag', !bare.includes('SPICEAUCTIONNO'));

const noLot = generSalesIspXML([{ ...ROW, lots: [{ lot: '', bag: 0, qty: 10, rate: 100, amount: 1000 }] }], CFG);
check('blank lot no emits no SpiceLotNo tag', !noLot.includes('SPICELOTNO'));
check('zero bags still emits SpiceBags (0 is a real count, not a blank)',
  /<UDF:SPICEBAGS DESC="`SpiceBags`">0</.test(noLot));

// ── Aggregate mode carries no per-line UDFs ──────────────────────────────
// With tally_detailed off there is one inventory line covering every lot, so
// there is no single lot number to print. The layout falls back to a blank
// Lot cell rather than an arbitrary one.
const agg = generSalesIspXML([ROW], { ...CFG, tally_detailed: false });
check('aggregate mode emits no SpiceLotNo', !agg.includes('SPICELOTNO'));
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
