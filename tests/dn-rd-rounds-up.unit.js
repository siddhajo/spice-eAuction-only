// The DEALER (RD Service) debit note ROUNDS UP in Tally, like the planter one.
//
// A debit note is the house's own service charge — commission, handling and
// GST billed back to the party — so the fee charged must never come out below
// the fee earned. The planter (URD) note has always worked that way:
// planterDebitNoteTotal() ceils, ignoring flag_round. The dealer note rounded
// to the NEAREST rupee, so roughly half of them lost up to 99 paise. Five of
// the eight most recent notes on the live install rounded down.
//
// THE TRAP THIS TEST EXISTS FOR: ceiling `row.total` fixes nothing. By the
// time the row reaches the XML builder, debitNoteTotal() has already rounded
// it to the nearest rupee under flag_round — 12674.15 arrives as 12674, and
// Math.ceil(12674) is 12674. The paise that decide the direction survive only
// in the COMPONENTS, so that is what has to be ceiled. A test written against
// a row whose total still carries paise would pass either way and prove
// nothing; every row below therefore carries a whole-rupee stored total, the
// way the database actually holds them.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { generDebitNoteXML, buildDebitNoteIrpJson } = require(path.join(ROOT, 'tally-xml'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

const CFG = {
  tally_round_enabled: true, tally_state_code: '33',
  tally_dn_gst_rate: 18, season_short: '26-27',
  trade_name: 'HOUSE', kl_gstin: '33AAAAA0000A1Z5',
};
const HOME_GSTIN = '33BBBBB0000B1Z5';   // same state code ⇒ intra ⇒ CGST+SGST

// Note 215 off the live install: 10740.81 + 966.67 + 966.67 = 12674.15, which
// was STORED as 12674 (nearest) and must be BILLED as 12675.
const DEALER_DOWN = {
  ano: '20', date: '2026-10-07', name: 'DEALER A', partyGstin: HOME_GSTIN,
  refundtot: 10740.81, cgsttot: 966.67, sgsttot: 966.67, igsttot: 0,
  total: 12674, voucherNum: '215',
};
// Note 213: 9576.95 + 861.93 + 861.93 = 11300.81 — already rounded UP to
// 11301, so the new rule must leave it exactly where it was.
const DEALER_UP = {
  ano: '20', date: '2026-10-07', name: 'DEALER B', partyGstin: HOME_GSTIN,
  refundtot: 9576.95, cgsttot: 861.93, sgsttot: 861.93, igsttot: 0,
  total: 11301, voucherNum: '213',
};
// Exact rupees: nothing to round, and the Round Off line must stay away.
const DEALER_EXACT = {
  ano: '20', date: '2026-10-07', name: 'DEALER C', partyGstin: HOME_GSTIN,
  refundtot: 10000, cgsttot: 900, sgsttot: 900, igsttot: 0,
  total: 11800, voucherNum: '216',
};
// The planter note already ceils at source — ceiling its components has to
// land on the same rupee, or this change moved a document it had no business
// touching.
const PLANTER = {
  ano: '20', date: '2026-10-07', name: 'PLANTER D', planter: true,
  refundtot: 1000.40, cgsttot: 90.04, sgsttot: 90.04, igsttot: 0,
  total: 1181, voucherNum: '9',
};

// The party ledger's AMOUNT is the voucher's grand total, carried negative.
function partyTotal(xml, ledgerName) {
  const re = new RegExp(
    '<LEDGERNAME>' + ledgerName + '[^<]*</LEDGERNAME>[\\s\\S]*?<ISPARTYLEDGER>Yes</ISPARTYLEDGER>\\s*<AMOUNT>(-?[0-9.]+)</AMOUNT>');
  const m = re.exec(xml);
  return m ? -Number(m[1]) : null;
}
function roundOffOf(xml, ledgerName) {
  const vch = xml.split('<VOUCHER ').find(v => v.includes('<LEDGERNAME>' + ledgerName)) || '';
  const m = /<LEDGERNAME>[^<]*ROUND[^<]*<\/LEDGERNAME>[\s\S]*?<AMOUNT>(-?[0-9.]+)<\/AMOUNT>/i.exec(vch);
  return m ? Number(m[1]) : 0;
}

console.log('[voucher] the dealer note rounds up');
{
  const xml = generDebitNoteXML([DEALER_DOWN, DEALER_UP, DEALER_EXACT, PLANTER], CFG, { companyName: 'X' });

  check('a note whose paise would round DOWN is billed at the next rupee',
    partyTotal(xml, 'DEALER A') === 12675,
    `got ${partyTotal(xml, 'DEALER A')}, want 12675 (components 12674.15, stored 12674)`);
  check('...and the Round Off ledger carries the 0.85 it added',
    Math.abs(roundOffOf(xml, 'DEALER A') - 0.85) < 0.005, String(roundOffOf(xml, 'DEALER A')));

  check('a note that already rounded up is left alone',
    partyTotal(xml, 'DEALER B') === 11301, String(partyTotal(xml, 'DEALER B')));

  check('a note in exact rupees does not climb a rupee',
    partyTotal(xml, 'DEALER C') === 11800, String(partyTotal(xml, 'DEALER C')));
  check('...and raises no Round Off line at all',
    roundOffOf(xml, 'DEALER C') === 0, String(roundOffOf(xml, 'DEALER C')));

  check('the planter note is unmoved — it already ceiled at source',
    partyTotal(xml, 'PLANTER D') === 1181, String(partyTotal(xml, 'PLANTER D')));
}

// Turning Tally rounding off still means OFF. The ceil is a direction, not a
// new reason to round.
console.log('\n[switch] tally_round_enabled still governs whether it rounds');
{
  const xml = generDebitNoteXML([DEALER_DOWN], { ...CFG, tally_round_enabled: false }, { companyName: 'X' });
  check('rounding off ⇒ the stored total goes out untouched',
    partyTotal(xml, 'DEALER A') === 12674, String(partyTotal(xml, 'DEALER A')));
}

// The e-invoice and the voucher describe ONE document. If the IRP keeps
// anchoring to the stored total while the voucher ceils, the registered
// e-invoice sits a rupee under the books.
console.log('\n[e-invoice] the IRP JSON agrees with the voucher');
{
  const xml = generDebitNoteXML([DEALER_DOWN], CFG, { companyName: 'X' });
  const [doc] = buildDebitNoteIrpJson([DEALER_DOWN], CFG, { companyName: 'X' });
  check('an e-invoice was built for the dealer note', !!doc);
  if (doc) {
    check('TotInvVal is the ceiled total, matching the voucher',
      doc.ValDtls.TotInvVal === partyTotal(xml, 'DEALER A') && doc.ValDtls.TotInvVal === 12675,
      `IRP ${doc.ValDtls.TotInvVal} vs voucher ${partyTotal(xml, 'DEALER A')}`);
    check('RndOffAmt is the paise it added, never negative',
      doc.ValDtls.RndOffAmt >= 0 && doc.ValDtls.RndOffAmt < 1
      && Math.abs(doc.ValDtls.RndOffAmt - 0.85) < 0.005,
      String(doc.ValDtls.RndOffAmt));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
