// Lot PAYABLE is rounded to the nearest whole rupee.
//
//   Payable = round( Amount + Refund − Commission − Handling − (CGST+SGST+IGST) )
//
// The seller is settled in whole rupees, and lots.balance is the figure every
// downstream consumer pays out on (Payments screen, bank file, DBF, Tally,
// PDFs). Rounding once here keeps them all on the same number. `payableExact`
// carries the unrounded figure for anything that needs to show the paise.
const { calculateLot } = require('../calculations');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// A registered (CR-tagged) seller so commission GST is in play — that is what
// puts paise on the payable in the first place.
const CFG = {
  sb_refund: 2.85, commission: 1, hpc: 0, gst_service: 18,
  business_state: 'KERALA', kl_gstin: '32ABFFR1926E1ZK',
};
const lotOf = (qty, price) => ({
  qty, price, amount: Math.round(qty * price * 100) / 100,
  cr: 'CR.32AYVPP6191Q3Z8', immediate_payment: 0,
});

console.log('[1] Payable is a whole number');
const cases = [
  [220, 3092], [71.7, 3178], [100.5, 2777], [13.25, 3001], [7.05, 999],
];
for (const [qty, price] of cases) {
  const c = calculateLot(lotOf(qty, price), CFG);
  check(`qty ${qty} × ₹${price} → payable ${c.payable} has no paise`,
        Number.isInteger(c.payable), `got ${c.payable}`);
  check(`  …and balance mirrors it`, c.balance === c.payable,
        `balance ${c.balance} vs payable ${c.payable}`);
  check(`  …and it is the nearest rupee to the exact figure (${c.payableExact})`,
        Math.abs(c.payable - c.payableExact) <= 0.5,
        `exact ${c.payableExact} → ${c.payable}`);
}

console.log('\n[2] Rounding is half-up, and never off by more than the paise');
// Sweep a rupee's worth of amounts one paisa at a time so every fractional
// payable is exercised. An unregistered seller keeps service GST out of it;
// note calculateLot floors the commission rate at 1%, so the exact payable is
// amount − 1% and cannot be steered by config alone — hence the sweep.
const plainCfg = { sb_refund: 0, hpc: 0, gst_service: 0 };
const plain = (amount) => calculateLot({ qty: 1, price: amount, amount, cr: '' }, plainCfg);
let sweepOk = true, halves = 0, halvesUp = 0, worst = 0;
for (let paise = 12400; paise <= 12500; paise++) {   // ₹124.00 … ₹125.00
  const k = plain(paise / 100);
  if (k.payable !== Math.round(k.payableExact)) sweepOk = false;
  worst = Math.max(worst, Math.abs(k.payable - k.payableExact));
  if (Math.abs(k.payableExact % 1) === 0.5) { halves++; if (k.payable > k.payableExact) halvesUp++; }
}
check('every paisa step rounds to the nearest rupee', sweepOk);
check('and never moves the figure by more than 50 paise', worst <= 0.5, `worst ${worst}`);
check(halves ? `exact halves round UP (${halvesUp}/${halves})` : 'no exact half landed in the sweep',
      halves === 0 || halvesUp === halves, `${halvesUp}/${halves} rounded up`);
// A payable that is already whole must not move.
const wholeCase = plain(100);           // 100 − 1% = 99.00 exactly
check('a payable that is already whole is unchanged',
      wholeCase.payable === wholeCase.payableExact, `${wholeCase.payableExact} → ${wholeCase.payable}`);

console.log('\n[3] payableExact keeps the paise');
const ex = calculateLot(lotOf(220, 3092), CFG);
check('payableExact keeps its paise (this lot works out to …124.24)',
      !Number.isInteger(ex.payableExact) && ex.payableExact !== ex.payable,
      `payableExact ${ex.payableExact}, payable ${ex.payable}`);
check('and is still a clean 2-decimal figure',
      Math.round(ex.payableExact * 100) / 100 === ex.payableExact, `${ex.payableExact}`);
check('payable is what the components add up to, rounded',
      ex.payable === Math.round(ex.amount + ex.refund - ex.com - ex.sertax - ex.cgst - ex.sgst - ex.igst),
      `payable ${ex.payable}, components → ${ex.amount + ex.refund - ex.com - ex.sertax - ex.cgst - ex.sgst - ex.igst}`);

console.log('\n[4] Whole-rupee lots sum to a whole-rupee seller total');
// The Payments screen and the bank file both total Σ lots.balance.
const seller = [[220, 3092], [150, 3050], [71.7, 3178]].map(([q, p]) => calculateLot(lotOf(q, p), CFG));
const total = seller.reduce((s, c) => s + c.balance, 0);
check(`Σ balance (${total}) is a whole number`, Number.isInteger(total), `got ${total}`);

console.log('\n[5] Nothing else in the lot silently became an integer');
const c = calculateLot(lotOf(220, 3092), CFG);
check('commission still carries paise', !Number.isInteger(c.com) || c.com === Math.round(c.com * 100) / 100,
      `com ${c.com}`);
check('GST is still 2-decimal', c.cgst === Math.round(c.cgst * 100) / 100, `cgst ${c.cgst}`);
check('amount is untouched', c.puramt === c.amount, `puramt ${c.puramt} vs amount ${c.amount}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
