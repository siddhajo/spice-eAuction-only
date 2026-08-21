// Planter Debit Note — Tally XML: BILLALLOCATIONS.LIST.NAME must use the
// Bill-of-Supply affixes (bill_of_supply_prefix/suffix), for PLANTER debit
// notes only. Dealer DNs keep their own voucher number, and neither the
// planter VOUCHERNUMBER nor REFERENCE change (only the bill-reference NAME).
//
// Pure-function test: generDebitNoteXML(rows, cfg) needs no DB.
const path = require('path');
const { generDebitNoteXML } = require(path.join(__dirname, '..', 'tally-xml.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// Split the envelope into individual <VOUCHER …>…</VOUCHER> blocks.
function vouchers(xml) {
  const out = [];
  const re = /<VOUCHER\b[\s\S]*?<\/VOUCHER>/g;
  let m; while ((m = re.exec(xml))) out.push(m[0]);
  return out;
}
const field = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
};
// The bill-reference NAME lives inside BILLALLOCATIONS.LIST.
const billAllocName = (block) => {
  const m = block.match(/<BILLALLOCATIONS\.LIST>\s*<NAME>([\s\S]*?)<\/NAME>/);
  return m ? m[1] : null;
};

// Live-matching config: BoS prefix set, DN-planter affixes set (so the two
// series are visibly different).
const cfg = {
  bill_of_supply_prefix: 'SIP/', bill_of_supply_suffix: '',
  debit_note_planter_prefix: 'SIS/', debit_note_planter_suffix: '/26-27',
  season_short: '26-27', tally_state_code: '33', tally_home_state: 'Tamil Nadu',
};

const base = { ano: '14', date: '2026-08-10', amount: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 };
const planterRow = { ...base, planter: true,  voucherNum: '5', note_no: '5', name: 'RAMU PLANTER', gstin: '' };
const dealerRow  = { ...base, planter: false, voucherNum: '7', note_no: '7', name: 'DEALER X', gstin: '33ABCDE1234F1Z5' };

const xml = generDebitNoteXML([planterRow, dealerRow], cfg);
const vs = vouchers(xml);
const planterV = vs.find(v => /RAMU PLANTER/.test(v));
const dealerV  = vs.find(v => /DEALER X/.test(v));

console.log('[1] Planter DN — BILLALLOCATIONS NAME uses the Bill-of-Supply prefix');
check('two vouchers emitted', vs.length === 2, `got ${vs.length}`);
check('planter + dealer vouchers found', !!planterV && !!dealerV);
check('planter BILLALLOCATIONS NAME = "SIP/5" (BoS prefix on the number)',
      billAllocName(planterV) === 'SIP/5', `got ${JSON.stringify(billAllocName(planterV))}`);

console.log('\n[2] Planter VOUCHERNUMBER / REFERENCE are NOT changed');
check('planter VOUCHERNUMBER keeps the DN format ("SIS/5/26-27")',
      field(planterV, 'VOUCHERNUMBER') === 'SIS/5/26-27', `got ${JSON.stringify(field(planterV, 'VOUCHERNUMBER'))}`);
check('planter REFERENCE keeps the DN format ("SIS/5/26-27")',
      field(planterV, 'REFERENCE') === 'SIS/5/26-27', `got ${JSON.stringify(field(planterV, 'REFERENCE'))}`);
check('BILLALLOCATIONS NAME differs from the voucher number',
      billAllocName(planterV) !== field(planterV, 'VOUCHERNUMBER'));

console.log('\n[3] Dealer DN — NAME unchanged (no BoS prefix)');
check('dealer BILLALLOCATIONS NAME does NOT get the BoS prefix',
      !String(billAllocName(dealerV)).startsWith('SIP/'), `got ${JSON.stringify(billAllocName(dealerV))}`);
check('dealer BILLALLOCATIONS NAME equals its own voucher number',
      billAllocName(dealerV) === field(dealerV, 'VOUCHERNUMBER'),
      `name=${JSON.stringify(billAllocName(dealerV))} vch=${JSON.stringify(field(dealerV, 'VOUCHERNUMBER'))}`);

// Blank-prefix guard: with no BoS affixes, the planter NAME degrades to the
// bare number (documented behaviour) — worth pinning so it's a conscious choice.
console.log('\n[4] With no BoS prefix configured, planter NAME is the bare number');
const xml2 = generDebitNoteXML([planterRow], { ...cfg, bill_of_supply_prefix: '', bill_of_supply_suffix: '' });
const pv2 = vouchers(xml2)[0];
check('planter BILLALLOCATIONS NAME = bare "5" when BoS affixes are blank',
      billAllocName(pv2) === '5', `got ${JSON.stringify(billAllocName(pv2))}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
