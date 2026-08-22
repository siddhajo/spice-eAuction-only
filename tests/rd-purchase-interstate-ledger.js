// RD purchase voucher: the cardamom purchase accounting ledger switches on the
// party GSTIN's state. A LOCAL dealer (state = company state) posts to the base
// ledger `tally_purchase_dealer`; an INTERSTATE dealer posts to the new
// `tally_purchase_dealer_interstate`. A blank interstate value falls back to
// the base ledger. Pure-function test: generRDPurchaseXML(rows, cfg) needs no DB.
const path = require('path');
const { generRDPurchaseXML } = require(path.join(__dirname, '..', 'tally-xml.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

const BASE  = 'AUCTION CARDAMOM PURCHASE DEALER';
const INTER = 'AUCTION CARDAMOM PURCHASE DEALER  INTERSTATE';   // double space on purpose

// Home/company state code 32 (Kerala). A 32… GSTIN is intra; anything else inter.
const cfg = {
  tally_purchase_detailed: 'true', tally_round_enabled: 'true',
  tally_state_code: '32', season_code: '2026-27', gst_goods: '5',
  flag_tds_purchase: 'false',
  tally_purchase_dealer: BASE,
  tally_purchase_dealer_interstate: INTER,
};

function row(gstin) {
  return {
    date: '2026-08-10', ano: '14', voucherNum: '799', name: 'DEALER X',
    gstin, address: 'ADDR', place: 'PLACE', pin: '',
    amounttot: 1000, qtytot: 10, rate: 100, refundtot: 0,
    cgst: 25, sgst: 25, igst: 0,
    lots: [{ lot: '201', bag: 5, qty: 10, rate: 100, amount: 1000, bilamt: 1000,
             refund: 0, com: 0, sertax: 0, cgst: 0, sgst: 0, igst: 0, balance: 950 }],
  };
}
// Ledger names surface as <HSNLEDGERSOURCE> / <LEDGERNAME> inside the inventory
// block — count the ledger occurrences to know which one the voucher used.
const has = (xml, ledger) => xml.split(`<LEDGERNAME>${ledger}</LEDGERNAME>`).length - 1;

console.log('[1] Local dealer (32… GSTIN) → BASE ledger');
let xml = generRDPurchaseXML([row('32ABCDE1234F1Z5')], cfg);
check('base ledger present', has(xml, BASE) >= 1, `base×${has(xml, BASE)}`);
check('interstate ledger absent', has(xml, INTER) === 0, `inter×${has(xml, INTER)}`);

console.log('\n[2] Interstate dealer (33… GSTIN) → INTERSTATE ledger');
xml = generRDPurchaseXML([row('33ABCDE1234F1Z5')], cfg);
check('interstate ledger present', has(xml, INTER) >= 1, `inter×${has(xml, INTER)}`);
check('bare base ledger NOT posted for the interstate party',
      has(xml, BASE) === 0, `base×${has(xml, BASE)}`);

console.log('\n[3] Blank interstate config falls back to the base ledger');
const cfgNoInter = Object.assign({}, cfg, { tally_purchase_dealer_interstate: '' });
xml = generRDPurchaseXML([row('33ABCDE1234F1Z5')], cfgNoInter);
check('interstate party posts to BASE when interstate key is blank',
      has(xml, BASE) >= 1, `base×${has(xml, BASE)}`);

console.log('\n[4] Nature still branches independently (unchanged behaviour)');
xml = generRDPurchaseXML([row('33ABCDE1234F1Z5')], cfg);
check('interstate party keeps "Interstate Purchase - Taxable" nature',
      xml.includes('Interstate Purchase - Taxable'), 'nature missing');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
