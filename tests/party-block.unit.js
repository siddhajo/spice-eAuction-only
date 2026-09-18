// Party boxes on EVERY invoice — one format.
//
//     NAME
//     3,NONDIMAGAN STREET
//     CUMBUM-625516
//     KERALA                CODE: 32
//     CR: …                 PAN: …
//
// One thing per line down the address — name, street, town-PIN, then the
// STATE paired with its code. None of them share a line; the rest of the
// details follow two per row.
//
// Every document that names a seller or a buyer prints this box: the Bill of
// Supply, the Commission Bill, the Sales Invoice, the Purchase Invoice and
// the Debit Note, each across its PDFKit and HTML layouts. They are checked
// together, because a format that holds in one and not the others is the mess
// it replaced.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { partyBlock } = require(path.join(ROOT, 'party-block'));
const { drawPartyBox, partyBoxLayout, partyBoxLines } = require(path.join(ROOT, 'invoice-pdf'));
const { buildAgriBillView } = require(path.join(ROOT, 'pdf', 'render-agri-html'));
const { buildCommissionView } = require(path.join(ROOT, 'pdf', 'render-commission-html'));
const { buildSalesInvoiceView } = require(path.join(ROOT, 'pdf', 'render-html-invoice'));
const { buildPurchaseInvoiceView } = require(path.join(ROOT, 'pdf', 'render-purchase-html'));
const { buildDebitNoteView } = require(path.join(ROOT, 'pdf', 'render-debit-note-html'));
const { getInvoiceTemplate } = require(path.join(ROOT, 'pdf', 'invoice-templates'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

const PLANTER = {
  name: 'ANNAMALAI M', address: '12 MAIN ROAD, THENI', place: 'bodinayakanur',
  pin: '625513', state: 'tamil nadu', st_code: '33',
  cr: 'CR.33/2019', pan: 'ABCDE1234F', aadhar: '123456789012',
  phone: '9876543210', account: '11122233344',
};
const BUYER = {
  name: 'SPICE TRADERS PVT LTD', invo: '1748', address: 'DOOR 5, MARKET ROAD',
  place: 'kumily', pin: '685509', state: 'kerala', st_code: '32',
  sbl: 'SBL/99', gstin: '32AABCS1234K1Z5', pan: 'AABCS1234K',
};

console.log('[1] The block reads NAME / STREET / TOWN-PIN / STATE+CODE, then pairs');
const b = partyBlock(PLANTER);
check('name stands alone', b.name === 'ANNAMALAI M', b.name);
check('the street stands alone', b.address === '12 MAIN ROAD, THENI', b.address);
check('the town carries its PIN, on its own line', b.place === 'BODINAYAKANUR-625513', b.place);
check('the state is on neither of them',
      !/TAMIL NADU/.test(b.address) && !/TAMIL NADU/.test(b.place), b.address + ' | ' + b.place);
check('state stands alone, upper-cased', b.state === 'TAMIL NADU', b.state);
check('the code rides beside the state', b.codeText === 'CODE: 33', b.codeText);
// Labelled like every other detail in the box: bare, the state name read as
// one more line of the address rather than as the place of supply.
check('the state prints under its own label', b.stateText === 'STATE: TAMIL NADU', b.stateText);
check('the details come two per row',
      b.rows.every((r, i) => r.a && (r.b || i === b.rows.length - 1)),
      JSON.stringify(b.rows));
check('in the documented order (no PIN row — it rides with the town)',
      b.rest.map(r => r.k).join(',') === 'CR,PAN,AADHAR,Ph,A/C',
      b.rest.map(r => r.k).join(','));
check('the stored "CR." label is not doubled', b.rest[0].text === 'CR: 33/2019', b.rest[0].text);

console.log('\n[2] A registration is one thing or the other');
const dealer = partyBlock({ ...PLANTER, gstin: '33AAAAA0000A1Z5' });
check('a GSTIN-bearing seller shows GSTIN', dealer.rest.some(r => r.k === 'GSTIN'));
check('and not a stale CR alongside it', !dealer.rest.some(r => r.k === 'CR'),
      dealer.rest.map(r => r.k).join(','));

console.log('\n[3] Blanks are dropped, not printed as empty labels');
const bare = partyBlock({ name: 'X', state: 'TAMIL NADU', st_code: '33' });
check('no rows at all when there is nothing to pair', bare.rows.length === 0, JSON.stringify(bare.rows));
check('the state line still prints', bare.state === 'TAMIL NADU' && bare.codeText === 'CODE: 33');
check('an empty party does not throw', partyBlock(null).rest.length === 0);
const omitted = partyBlock(PLANTER, { omit: ['PH', 'A/C'] }).rest.map(r => r.k).join(',');
check('omit drops a field', omitted === 'CR,PAN,AADHAR', omitted);

check('a CR stored as the bare label "CR." is not printed as an empty row',
      partyBlock({ name: 'SABIRA BURVIN', cr: 'CR.' }).rest.length === 0,
      JSON.stringify(partyBlock({ name: 'SABIRA BURVIN', cr: 'CR.' }).rest));

console.log('\n[3b] A missing piece of the address leaves no stray punctuation');
check('no street — the town line still stands',
      partyBlock({ place: 'cumbum', pin: '625516' }).place === 'CUMBUM-625516',
      partyBlock({ place: 'cumbum', pin: '625516' }).place);
check('the stored trailing comma is trimmed off the street',
      partyBlock({ address: '3,NONDIMAGAN STREET,' }).address === '3,NONDIMAGAN STREET',
      partyBlock({ address: '3,NONDIMAGAN STREET,' }).address);
check('a PIN with no town still shows, without a dangling dash',
      partyBlock({ address: 'MAIN RD', pin: '625516' }).place === '625516',
      partyBlock({ address: 'MAIN RD', pin: '625516' }).place);

console.log('\n[4] An odd number of details leaves the last row half-empty, not stretched');
const odd = partyBlock({ name: 'X', cr: '1', pan: '2', aadhar: '3' });
check('three details make two rows', odd.rows.length === 2, String(odd.rows.length));
check('and the last has an empty right cell', odd.rows[1].b === null, JSON.stringify(odd.rows[1]));

// PDFKit path ------------------------------------------------------------
console.log('\n[5] PDFKit draws it in that order, two cells per paired row');
// A stand-in for the PDFKit doc that records what was drawn where. charW 3
// keeps every string inside the column, so nothing shrinks — the fitter has
// its own check below.
function fakeDoc(charW) {
  const calls = [];
  const d = {
    calls,
    font() { return d; },
    fontSize(s) { d._size = s; return d; },
    // Width scales with the point size, like the real thing — otherwise the
    // shrink-to-fit loop can never succeed and every box lands on the floor.
    widthOfString(t) { return String(t).length * (charW || 3) * ((d._size || 8) / 8); },
    text(t, x, y) { calls.push({ t: String(t), x, y, size: d._size }); return d; },
  };
  return d;
}
const buyerBlk = partyBlock(BUYER, { omit: ['PH', 'A/C'] });
const doc = fakeDoc(3);
const used = drawPartyBox(doc, buyerBlk, { x: 100, w: 260, top: 50, lineH: 10, prefix: 'M/s.' });
const drawn = doc.calls.map(c => c.t);
check('the name carries its prefix and nothing else',
      drawn[0] === 'M/s.SPICE TRADERS PVT LTD', drawn[0]);
check('then the street', drawn[1] === 'DOOR 5, MARKET ROAD', drawn[1]);
check('then the town with its PIN', drawn[2] === 'KUMILY-685509', drawn[2]);
check('then the state, labelled, on its own line', drawn[3] === 'STATE: KERALA', drawn[3]);
check('with the code beside it, not below', drawn[4] === 'CODE: 32', drawn[4]);
check('the INV moved off the name line into the pairs',
      drawn.includes('INV: 1748') && !/INV/.test(drawn[0]), JSON.stringify(drawn));
check('the SBL moved off the state line', drawn.includes('SBL: SBL/99') && !/SBL/.test(drawn[3]));
const stateRow = doc.calls.filter(c => c.t === 'STATE: KERALA' || c.t === 'CODE: 32');
check('a pair shares one line', stateRow[0].y === stateRow[1].y, JSON.stringify(stateRow));
check('and the second cell starts at the half-column',
      stateRow[1].x === 100 + 6 + (260 - 12) / 2, String(stateRow[1].x));
check('the height it drew is the height it measured',
      used === partyBoxLines(buyerBlk) * 10, used + ' vs ' + partyBoxLines(buyerBlk) * 10);

console.log('\n[5b] A long street wraps onto a second line instead of vanishing');
// A street too wide for the column, with everything else comfortable — the
// box must wrap that one line rather than shrink the whole side.
const LONG_STREET = 'DOOR 5, MARKET ROAD, NEAR THE OLD BUS STAND';
const longBlk = partyBlock({ name: 'X', address: LONG_STREET, place: 'kumily',
                             pin: '685509', state: 'kerala', st_code: '32' });
const wrapDoc = fakeDoc(3);
const wrapOpts = { x: 0, w: 100, top: 0, lineH: 10 };
const wrapLay = partyBoxLayout(wrapDoc, longBlk, wrapOpts);
drawPartyBox(wrapDoc, longBlk, { ...wrapOpts, layout: wrapLay });
const wrapped = wrapDoc.calls.map(c => c.t);
check('it stayed at full size instead of shrinking', wrapLay.size === 8, String(wrapLay.size));
check('the street took two lines (name + 2 + town = 4 wide lines)',
      wrapLay.wide.length === 4, JSON.stringify(wrapLay.wide));
check('which together are the whole street, nothing dropped',
      (wrapped[1] + ' ' + wrapped[2]) === LONG_STREET, wrapped[1] + ' | ' + wrapped[2]);
check('each fits the column', [wrapped[1], wrapped[2]].every(t => t.length * 3 <= 100 - 12),
      JSON.stringify([wrapped[1], wrapped[2]]));
check('the town line survives the wrap', wrapped[3] === 'KUMILY-685509', JSON.stringify(wrapped.slice(3, 5)));
check('the state still follows it', wrapped[4] === 'STATE: KERALA', JSON.stringify(wrapped.slice(4, 6)));
check('and the measured height counts the extra line',
      wrapLay.height === (partyBoxLines(longBlk) + 1) * 10,
      wrapLay.height + ' vs ' + (partyBoxLines(longBlk) + 1) * 10);

console.log('\n[6] A cramped column shrinks the type instead of overprinting');
// charW 12 makes every string far too wide, so the fitter must walk down to
// its 6pt floor rather than let a cell run under its neighbour.
const tight = fakeDoc(12);
drawPartyBox(tight, partyBlock(BUYER), { x: 0, w: 160, top: 0, lineH: 10 });
check('the font drops to the 6pt floor', tight.calls[0].size === 6, String(tight.calls[0].size));
check('every cell is drawn at that one size',
      tight.calls.every(c => c.size === 6), JSON.stringify(tight.calls.map(c => c.size)));

// HTML templates ---------------------------------------------------------
console.log('\n[7] Every HTML layout of every document prints the same block');
const cfg = { short_name: 'ISPL', trade_name: 'ISPL', flag_commission_bank: 'false' };
const agriBill = {
  billDate: '01/09/2026', eTradeNo: '12',
  seller: PLANTER,
  lineItems: [{ lot: '7', qty: 10, pqty: 10, price: 100, prate: 100, amount: 1000, puramt: 1000 }],
  summary: { totalQty: 10, totalPuramt: 1000, netAmount: 1000 },
};
const commBill = {
  billDate: '01/09/2026', auction: { ano: '12', date: '01/09/2026' },
  seller: PLANTER, purchaser: BUYER,
  lineItems: [{ lot: '7', qty: 10, rate: 100, cardamomCost: 1000 }],
  commission: 10, cgst: 0.9, sgst: 0.9, igst: 0,
};
// Sales invoice — the buyer as the `buyers` table shapes it, plus a genuine
// consignee so Shipped-To is a party of its own, not a mirror.
const salesInv = {
  buyer: {
    buyer1: BUYER.name, add1: 'DOOR 5, MARKET ROAD', add2: '', pla: 'kumily', pin: '685509',
    state: 'kerala', st_code: '32', gstin: BUYER.gstin, pan: BUYER.pan, sbl: BUYER.sbl,
    cbuyer1: 'HILL ESTATE WAREHOUSE', cadd1: '9 GODOWN LANE', cpla: 'munnar', cpin: '685612',
    cstate: 'kerala', cst_code: '32', cgstin: '32AAACH9999H1Z2', cpan: 'AAACH9999H',
  },
  lineItems: [{ lot: '7', qty: 10, price: 100, amount: 1000 }],
  summary: { totalQty: 10, totalAmount: 1000, grandTotal: 1000 },
};
// Purchase invoice — the buyer is our own company.
const purchInv = {
  seller: { name: 'ASP SPICES', address: 'MILL ROAD', place: 'THENI', pin: '625531',
            state: 'TAMIL NADU', st_code: '33', gstin: '33AAACA1111A1Z9' },
  buyer: { name: 'indian spices pvt ltd', address: '3,NONDIMAGAN STREET', place: 'CUMBUM',
           pin: '625516', state: 'tamil nadu', st_code: '33',
           gstin: '33AAACI0000A1Z5', pan: 'AAACI0000A' },
  lineItems: [{ lot: '7', qty: 10, price: 100, amount: 1000, puramt: 1000 }],
  summary: { totalQty: 10, totalPuramt: 1000, grandTotal: 1000 },
};
// Debit note — the receiver comes out of `traders`, so hand the view a db
// that answers with one.
const dnTrader = {
  name: 'DEALER SPICES LLP', padd: '12 MAIN ROAD, THENI', ppla: 'bodinayakanur', pin: '625513',
  pstate: 'tamil nadu', pst_code: '33', pan: 'AABCD5555D',
  cr: '33AABCD5555D1Z1',   // a dealer's GSTIN lives in traders.cr
  aadhar: 'SBL/77',        // …and their SBL in traders.aadhar
};
const dnDb = { get: () => dnTrader, all: () => [] };
const debitNote = { name: dnTrader.name, ano: '12', date: '2026-09-01', no: 5,
                    cgst: 1, sgst: 1, igst: 0, total: 100 };

// Tags out, entities and runs of whitespace normalised — what the reader sees.
const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
                    .replace(/ /g, ' ').replace(/\s+/g, ' ');
// Whether two strings land in the SAME text node — i.e. on one printed line.
// The flattened text can't tell "one line" from "two adjacent elements", and
// the state sharing the address's line is precisely the bug being fixed.
const sameLine = (html, a, b) => html.split(/<[^>]+>/)
  .some(t => t.includes(a) && t.includes(b));

const settingFor = {
  'agri-bill': 'agri_bill_template', 'commission-bill': 'commission_bill_template',
  'sales-invoice': 'sales_invoice_template', 'purchase-invoice': 'purchase_invoice_template',
  'debit-note': 'debit_note_template',
};
// [docType, layout, view builder, [parties to verify]]. A party is
// [who, name, street, town-PIN, state, code].
const SELLER_LINES = ['ANNAMALAI M', '12 MAIN ROAD, THENI', 'BODINAYAKANUR-625513', 'TAMIL NADU', 'CODE: 33'];
const BUYER_LINES  = ['SPICE TRADERS PVT LTD', 'DOOR 5, MARKET ROAD', 'KUMILY-685509', 'KERALA', 'CODE: 32'];
const SHIP_LINES   = ['HILL ESTATE WAREHOUSE', '9 GODOWN LANE', 'MUNNAR-685612', 'KERALA', 'CODE: 32'];
const OURCO_LINES  = ['INDIAN SPICES PVT LTD', '3,NONDIMAGAN STREET', 'DOOR NO.650, CUMBUM-625516', 'TAMIL NADU', 'CODE: 33'];
const RECV_LINES   = ['DEALER SPICES LLP', '12 MAIN ROAD, THENI', 'BODINAYAKANUR-625513', 'TAMIL NADU', 'CODE: 33'];
const layouts = [
  ['agri-bill', 'classic', c => buildAgriBillView(agriBill, c, '1'), { seller: SELLER_LINES }],
  ['agri-bill', 'modern', c => buildAgriBillView(agriBill, c, '1'), { seller: SELLER_LINES }],
  ['commission-bill', 'classic', c => buildCommissionView(commBill, c, '1', true), { seller: SELLER_LINES, buyer: BUYER_LINES }],
  ['commission-bill', 'modern', c => buildCommissionView(commBill, c, '1', true), { seller: SELLER_LINES, buyer: BUYER_LINES }],
  ['commission-bill', 'letterhead', c => buildCommissionView(commBill, c, '1', true), { seller: SELLER_LINES, buyer: BUYER_LINES }],
  ['sales-invoice', 'classic', c => buildSalesInvoiceView(salesInv, c, 'L', '1', '01/09/2026'), { buyer: BUYER_LINES, consignee: SHIP_LINES }],
  ['sales-invoice', 'modern', c => buildSalesInvoiceView(salesInv, c, 'L', '1', '01/09/2026'), { buyer: BUYER_LINES, consignee: SHIP_LINES }],
  ['sales-invoice', 'letterhead', c => buildSalesInvoiceView(salesInv, c, 'L', '1', '01/09/2026'), { buyer: BUYER_LINES, consignee: SHIP_LINES }],
  ['purchase-invoice', 'classic', c => buildPurchaseInvoiceView(purchInv, c, '1'), { buyer: OURCO_LINES }],
  ['purchase-invoice', 'modern', c => buildPurchaseInvoiceView(purchInv, c, '1'), { buyer: OURCO_LINES }],
  ['purchase-invoice', 'letterhead', c => buildPurchaseInvoiceView(purchInv, c, '1'), { buyer: OURCO_LINES }],
  ['debit-note', 'letterhead', c => buildDebitNoteView(debitNote, dnDb, c), { receiver: RECV_LINES }],
  ['debit-note', 'modern', c => buildDebitNoteView(debitNote, dnDb, c), { receiver: RECV_LINES }],
];
for (const [docType, key, view, parties] of layouts) {
  const cfgT = { ...cfg, [settingFor[docType]]: key };
  const raw = getInvoiceTemplate(docType, cfgT).render(view(cfgT));
  const flat = strip(raw);
  const label = `${docType}/${key}`;
  for (const [who, lines] of Object.entries(parties)) {
    const [name, street, town, state, code] = lines;
    // Each line appears, in this order, after the one before it.
    let at = -1, bad = '';
    for (const bit of lines) {
      const i = flat.indexOf(bit, at + 1);
      if (i <= at) { bad = `"${bit}" out of order (at ${i}, previous ${at})`; break; }
      at = i;
    }
    check(`${label} — ${who} reads name, street, town-PIN, state, code`, bad === '', bad);
    check(`${label} — ${who}: the town is not tacked onto the street`,
          !sameLine(raw, street, town), label);
    check(`${label} — ${who}: the state is not tacked onto the town`,
          !sameLine(raw, town, state), label);
    // …and it carries its own label, so it cannot be read as one more line
    // of the address. The label and the name may sit in separate elements,
    // so this is checked against the flattened text.
    check(`${label} — ${who}: the state prints under its own label`,
          flat.includes('STATE: ' + state), label);
  }
  // Whatever registration the party carries has to reach the page — a box
  // that silently drops the GSTIN is worse than one that lays it out oddly.
  const reg = { 'commission-bill': '32AABCS1234K1Z5', 'sales-invoice': '32AABCS1234K1Z5',
                'purchase-invoice': '33AAACI0000A1Z5', 'debit-note': '33AABCD5555D1Z1' }[docType];
  if (reg) check(`${label} — the GSTIN survives the reflow`, flat.includes('GSTIN: ' + reg), label);
}

console.log('\n[8] flag_commission_bank still adds the phone + account rows');
const bankCfg = { ...cfg, commission_bill_template: 'letterhead', flag_commission_bank: 'true' };
const withBank = buildCommissionView(commBill, bankCfg, '1', true);
const sellerKeys = withBank.seller.block.rest.map(r => r.k).join(',');
check('the seller block carries Ph and A/C', sellerKeys.includes('Ph,A/C'), sellerKeys);
check('the buyer block never does',
      !withBank.purchaser.block.rest.some(r => r.k === 'Ph' || r.k === 'A/C'));
const lhHtml = getInvoiceTemplate('commission-bill', bankCfg).render(withBank);
check('and the letterhead prints them',
      lhHtml.includes('9876543210') && lhHtml.includes('11122233344'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
