// RD (registered-dealer) purchase Tally voucher: the per-lot payable "New Ref"
// must REUSE the whole-rupee payable calculateLot() already rounded and stored
// (lots.balance), not re-derive it at 2 decimals. The SE back-charge
// (seAmt = grossGoods − Σ payables) absorbs the delta, so the bill allocations
// still sum EXACTLY to the party AMOUNT. Mirrors the URD purchase test.
// Pure-function test: generRDPurchaseXML(rows, cfg) needs no DB.
const path = require('path');
const { generRDPurchaseXML } = require(path.join(__dirname, '..', 'tally-xml.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

const cfg = {
  tally_purchase_detailed: 'true', tally_round_enabled: 'true',
  tally_state_code: '33', season_code: '2026-27', gst_goods: '5',
  flag_tds_purchase: 'false',
};

// Local dealer (GSTIN state 33 = intra). Goods = 1000, goods GST 50 (25+25),
// commission 875.30 → exact lot payable 124.70, which calculateLot rounds to
// the whole rupee 125 and stores in lots.balance. Old voucher printed 124.70.
function row(balance) {
  return {
    date: '2026-08-10', ano: '14', voucherNum: '799', name: 'DEALER X',
    gstin: '33ABCDE1234F1Z5', address: 'ADDR', place: 'PLACE', pin: '',
    amounttot: 1000, qtytot: 10, rate: 100, refundtot: 0,
    cgst: 25, sgst: 25, igst: 0,          // goods GST (purchases header)
    lots: [{
      lot: '201', bag: 5, qty: 10, rate: 100, amount: 1000, bilamt: 1000,
      refund: 0, com: 875.30, sertax: 0, cgst: 0, sgst: 0, igst: 0,   // service GST 0
      balance,   // stored rounded payable (null → legacy fallback path)
    }],
  };
}

function billAllocs(xml) {
  const out = [];
  const re = /<BILLALLOCATIONS\.LIST>\s*<NAME>([\s\S]*?)<\/NAME>[\s\S]*?<AMOUNT>([\s\S]*?)<\/AMOUNT>/g;
  let m; while ((m = re.exec(xml))) out.push({ name: m[1], amount: Number(m[2]) });
  return out;
}
function partyAmount(xml) {
  const m = xml.match(/<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>[\s\S]*?<AMOUNT>([\s\S]*?)<\/AMOUNT>/)
        || xml.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<AMOUNT>([\s\S]*?)<\/AMOUNT>/);
  return m ? Math.abs(Number(m[1])) : null;
}

// ── [1] Reuses the stored whole-rupee balance ──
console.log('[1] Per-lot "New Ref" payable reuses lots.balance (whole rupee)');
const xml = generRDPurchaseXML([row(125)], cfg);
const allocs = billAllocs(xml);
const lotAlloc = allocs.find(a => a.name.includes('/201/'));   // NAME = "14/201/2026-27"
check('a per-lot New Ref for lot 201 is present', !!lotAlloc, JSON.stringify(allocs));
check('its amount is the ROUNDED payable 125 (not the 2-decimal 124.70)',
      lotAlloc && lotAlloc.amount === 125, lotAlloc && `got ${lotAlloc.amount}`);
check('the old 2-decimal 124.70 does NOT appear as a lot payable',
      !allocs.some(a => a.amount === 124.7), JSON.stringify(allocs.map(a => a.amount)));

// ── [2] Voucher still balances: allocations sum to the party AMOUNT ──
console.log('\n[2] Bill allocations still sum to the party AMOUNT');
const pAmt = partyAmount(xml);
const allocSum = Math.round(allocs.reduce((s, a) => s + a.amount, 0) * 100) / 100;
check('party AMOUNT is goods + goods-GST rounded (1050)', pAmt === 1050, `got ${pAmt}`);
check('Σ bill allocations === party AMOUNT (SE back-charge absorbs the delta)',
      allocSum === pAmt, `Σallocs ${allocSum} vs party ${pAmt}`);

// ── [3] Legacy fallback (no stored balance) rounds the SAME way ──
console.log('\n[3] Fallback (balance missing) rounds to the same whole rupee');
const xml2 = generRDPurchaseXML([row(null)], cfg);
const alloc2 = billAllocs(xml2).find(a => a.name.includes('/201/'));
check('fallback still yields the whole-rupee 125 (r2→r0, matching calculateLot)',
      alloc2 && alloc2.amount === 125, alloc2 && `got ${alloc2.amount}`);

// ── [4] seAmt is rounded to a whole rupee, and the voucher still balances ──
// Goods carry paise here (amount 1000.30), so the exact SE back-charge has
// paise; after rounding it must be whole, with the remainder absorbed by the
// GST ref so the allocations still sum to the party AMOUNT.
console.log('\n[4] seAmt rounds to a whole rupee (remainder folds into the GST ref)');
const rowPaise = {
  date: '2026-08-10', ano: '14', voucherNum: '800', name: 'DEALER Y',
  gstin: '33ABCDE1234F1Z5', address: 'A', place: 'P', pin: '',
  amounttot: 1000.30, qtytot: 10, rate: 100.03, refundtot: 0,
  cgst: 25.01, sgst: 25.01, igst: 0,                 // goods GST 50.02
  lots: [{ lot: '301', bag: 5, qty: 10, rate: 100.03, amount: 1000.30, bilamt: 1000.30,
           refund: 0, com: 100, sertax: 0, cgst: 0, sgst: 0, igst: 0, balance: 900 }],
};
const xml4 = generRDPurchaseXML([rowPaise], cfg);
const a4 = billAllocs(xml4);
const se = a4.find(x => /\/SE$/.test(x.name));
check('SE bill ref is present', !!se, JSON.stringify(a4));
check('seAmt is a whole rupee (100, not the exact 100.30)',
      se && se.amount === 100 && Number.isInteger(se.amount), se && `got ${se.amount}`);
const p4 = partyAmount(xml4);
const sum4 = Math.round(a4.reduce((s, x) => s + x.amount, 0) * 100) / 100;
check('party AMOUNT = 1050 (round of 1000.30 + 50.02)', p4 === 1050, `got ${p4}`);
check('allocations STILL sum to the party AMOUNT after rounding seAmt',
      sum4 === p4, `Σallocs ${sum4} vs party ${p4}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
