// URD (agriculturist) purchase Tally voucher: the per-lot payable "New Ref"
// must REUSE the whole-rupee payable calculateLot() already rounded and stored
// (lots.balance), not re-derive it at 2 decimals — so the voucher agrees with
// the Lots table and the amount actually paid. The commission back-charge
// absorbs the delta, so the bill allocations still sum EXACTLY to the party
// AMOUNT. Pure-function test: generURDPurchaseXML(rows, cfg) needs no DB.
const path = require('path');
const { generURDPurchaseXML } = require(path.join(__dirname, '..', 'tally-xml.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

const cfg = {
  tally_purchase_detailed: 'true', tally_round_enabled: 'true',
  season_code: '2026-27', season_short: '26-27', gst_goods: '5',
};

// One lot. Gross goods = 1000; commission 875.30 → exact payable 124.70, which
// calculateLot rounds to the whole rupee 125 and stores in lots.balance.
// The OLD voucher printed 124.70; the fix must print 125.
function row(balance) {
  return {
    date: '2026-08-10', ano: '14', voucherNum: '799', name: 'RAMU PLANTER',
    address: 'ADDR', place: 'PLACE', pin: '',
    amounttot: 1000, qtytot: 10, refundtot: 0, comhandtot: 875.30,
    lots: [{
      lot: '201', bag: 5, qty: 10, rate: 100, amount: 1000, bilamt: 1000,
      refund: 0, com: 875.30, sertax: 0, cgst: 0, sgst: 0, igst: 0,
      balance,   // the stored rounded payable (null → legacy fallback path)
    }],
  };
}

// Pull every BILLALLOCATIONS {NAME, AMOUNT} from the (single) voucher.
function billAllocs(xml) {
  const out = [];
  const re = /<BILLALLOCATIONS\.LIST>\s*<NAME>([\s\S]*?)<\/NAME>[\s\S]*?<AMOUNT>([\s\S]*?)<\/AMOUNT>/g;
  let m; while ((m = re.exec(xml))) out.push({ name: m[1], amount: Number(m[2]) });
  return out;
}
// Party ledger AMOUNT (the first LEDGERENTRIES AMOUNT is the party debit).
function partyAmount(xml) {
  const m = xml.match(/<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>[\s\S]*?<AMOUNT>([\s\S]*?)<\/AMOUNT>/)
        || xml.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<AMOUNT>([\s\S]*?)<\/AMOUNT>/);
  return m ? Number(m[1]) : null;
}

// ── [1] Reuses the stored whole-rupee balance ──
console.log('[1] Per-lot "New Ref" payable reuses lots.balance (whole rupee)');
const xml = generURDPurchaseXML([row(125)], cfg);
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
check('party AMOUNT is the rounded gross goods (1000)', pAmt === 1000, `got ${pAmt}`);
check('Σ bill allocations === party AMOUNT (commission back-charge absorbs the delta)',
      allocSum === pAmt, `Σallocs ${allocSum} vs party ${pAmt}`);

// ── [3] Legacy fallback (no stored balance) rounds the SAME way ──
console.log('\n[3] Fallback (balance missing) rounds to the same whole rupee');
const xml2 = generURDPurchaseXML([row(null)], cfg);
const alloc2 = billAllocs(xml2).find(a => a.name.includes('/201/'));
check('fallback still yields the whole-rupee 125 (r2→r0, matching calculateLot)',
      alloc2 && alloc2.amount === 125, alloc2 && `got ${alloc2.amount}`);

// ── [4] Configurable "A" prefix on the per-lot bill reference NAME ──
console.log('\n[4] tally_purchase_bill_ref_prefix leads the per-lot bill ref');
const uNo = (billAllocs(generURDPurchaseXML([row(125)], cfg)).find(x => x.name.includes('/201/')) || {}).name;
check('default (blank) → "14/201/2026-27" (unchanged)', uNo === '14/201/2026-27', `got ${uNo}`);
const uA = (billAllocs(generURDPurchaseXML([row(125)], { ...cfg, tally_purchase_bill_ref_prefix: 'A' })).find(x => x.name.includes('/201/')) || {}).name;
check('prefix "A" → "A14/201/2026-27"', uA === 'A14/201/2026-27', `got ${uA}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
