// Two proforma behaviours, both against a THROWAWAY database:
//
//   Task 1 — the sales-invoice number prints the "Proforma Invoice No Prefix"
//            (proforma_invoice_prefix) on proforma documents, inv_prefix on
//            originals, with inv_prefix as the fallback when the proforma
//            prefix is blank.
//   Task 2 — Form D's "5 Highest Buyers" reads PROFORMA invoices when the
//            proforma flow (flag_proforma_invoice) is on, ORIGINALS when off.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proforma-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb, closeDb } = require(path.join(__dirname, '..', 'db.js'));
const { initCompanySettings } = require(path.join(__dirname, '..', 'company-config.js'));
const { buildSalesInvoiceView } = require(path.join(__dirname, '..', 'pdf', 'render-html-invoice.js'));
const { REPORTS } = require(path.join(__dirname, '..', 'spice-board-reports.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// Minimal invoiceData that buildSalesInvoiceView can render without real lots.
function invData(isProforma) {
  return {
    isProforma,
    buyer: { buyer1: 'TEST BUYER', buyer: 'TB' },
    lineItems: [],
    // Enough of the summary shape for the view builder to render the goods
    // rows; the exact figures don't matter — this test only reads invoiceNo.
    summary: {
      isInterState: false, totalAmount: 0, grandTotal: 0,
      totalQty: 0, totalBags: 0, gunnyCost: 0,
      transportCost: 0, insuranceCost: 0,
      taxableValue: 0, cgst: 0, sgst: 0, igst: 0, roundDiff: 0,
    },
    auctionNo: '7',
  };
}
function invNo(cfg, saleType, no, isProforma) {
  return buildSalesInvoiceView(invData(isProforma), cfg, saleType, no, '2026-08-10').invoiceNo;
}

(async () => {
  await initDb();
  const db = getDb();
  // initDb() creates the core tables; company_settings is seeded separately
  // (server.js does this at boot). The Form-D flag read needs it.
  initCompanySettings(db);

  // ══ TASK 1 — invoice-number prefix (HTML engine view builder) ══════
  console.log('[1] Sales-invoice number prefix — proforma vs original');

  // (a) Distinct proforma prefix set → proforma uses it, original keeps inv_prefix.
  const cfgBoth = { inv_prefix: 'ISP', proforma_invoice_prefix: 'PI', season_short: '26-27' };
  check('original invoice uses inv_prefix',
        invNo(cfgBoth, 'L', '9', false) === 'ISP/L-9/26-27',
        invNo(cfgBoth, 'L', '9', false));
  check('proforma invoice uses proforma_invoice_prefix',
        invNo(cfgBoth, 'L', '5', true) === 'PI/L-5/26-27',
        invNo(cfgBoth, 'L', '5', true));
  check('proforma prefix applies to every sale type (I)',
        invNo(cfgBoth, 'I', '5', true) === 'PI/I-5/26-27',
        invNo(cfgBoth, 'I', '5', true));

  // (b) Proforma prefix BLANK → proforma falls back to inv_prefix (no silent
  //     drop of the company marker).
  const cfgBlankPf = { inv_prefix: 'ISP', proforma_invoice_prefix: '', season_short: '26-27' };
  check('blank proforma prefix falls back to inv_prefix',
        invNo(cfgBlankPf, 'L', '5', true) === 'ISP/L-5/26-27',
        invNo(cfgBlankPf, 'L', '5', true));
  check('original unaffected when proforma prefix blank',
        invNo(cfgBlankPf, 'L', '9', false) === 'ISP/L-9/26-27',
        invNo(cfgBlankPf, 'L', '9', false));

  // (c) Both blank → both prefix-less, exactly as a pre-proforma install.
  const cfgNone = { inv_prefix: '', proforma_invoice_prefix: '', season_short: '26-27' };
  check('no prefixes at all → bare number for both',
        invNo(cfgNone, 'L', '9', false) === 'L-9/26-27' &&
        invNo(cfgNone, 'L', '5', true) === 'L-5/26-27',
        `${invNo(cfgNone,'L','9',false)} / ${invNo(cfgNone,'L','5',true)}`);

  // ══ TASK 2 — Form D "5 Highest Buyers" stream ══════════════════════
  console.log('\n[2] Form D top-5 buyers — proforma vs original stream');

  db.run(`INSERT INTO auctions (id,ano,date,state) VALUES (1,'7','2026-08-10','TAMIL NADU')`);
  // A lot so getReportContext has priced rows (top-5 still comes from invoices).
  db.run(`INSERT INTO lots (auction_id,lot_no,name,qty,price,amount,buyer,buyer1)
          VALUES (1,'101','SELLER',100,500,50000,'BUYERA','ALPHA CARDAMOM')`);

  // PROFORMA rows — the advance-stage picture. BETA is the biggest by kilos.
  const proformas = [
    ['ALPHA CARDAMOM', 'BUYERA', 100, 50000],
    ['BETA SPICES',    'BUYERB', 400, 90000],
    ['GAMMA TRADERS',  'BUYERC', 50,  20000],
  ];
  for (const [b1, b, qty, amt] of proformas) {
    db.run(`INSERT INTO invoices (auction_id,ano,date,state,sale,invo,buyer,buyer1,qty,amount,tot,is_proforma)
            VALUES (1,'7','2026-08-10','TAMIL NADU','L',?,?,?,?,?,?,1)`,
      [`P${b}`, b, b1, qty, amt, amt]);
  }
  // ORIGINAL rows — a DIFFERENT winner, so the two streams are distinguishable.
  // Here DELTA dominates and BETA is small, the opposite of the proforma side.
  const originals = [
    ['DELTA EXPORTS',  'BUYERD', 900, 300000],
    ['BETA SPICES',    'BUYERB', 40,  9000],
  ];
  for (const [b1, b, qty, amt] of originals) {
    db.run(`INSERT INTO invoices (auction_id,ano,date,state,sale,invo,buyer,buyer1,qty,amount,tot,is_proforma)
            VALUES (1,'7','2026-08-10','TAMIL NADU','L',?,?,?,?,?,?,0)`,
      [b, b, b1, qty, amt, amt]);
  }

  const setFlag = v => db.run("UPDATE company_settings SET value=? WHERE key='flag_proforma_invoice'", [String(v)]);
  const topNames = () => REPORTS.form_d.json(db, { auctionId: 1 }).top5.map(r => r.name);

  // Flag OFF → originals only. DELTA is the top buyer; the proforma-only
  // buyers (ALPHA, GAMMA) must not appear.
  setFlag('false');
  let names = topNames();
  check('flag OFF → top buyer is the ORIGINAL winner (DELTA EXPORTS)',
        names[0] === 'DELTA EXPORTS', JSON.stringify(names));
  check('flag OFF → proforma-only buyers are absent',
        !names.includes('ALPHA CARDAMOM') && !names.includes('GAMMA TRADERS'),
        JSON.stringify(names));

  // Flag ON → proformas only. BETA is the top buyer (400 kg on the proforma
  // side); DELTA (original-only) must not appear.
  setFlag('true');
  names = topNames();
  check('flag ON → top buyer is the PROFORMA winner (BETA SPICES)',
        names[0] === 'BETA SPICES', JSON.stringify(names));
  check('flag ON → original-only buyer (DELTA) is absent',
        !names.includes('DELTA EXPORTS'), JSON.stringify(names));
  check('flag ON → proforma-only buyers now appear',
        names.includes('ALPHA CARDAMOM') && names.includes('GAMMA TRADERS'),
        JSON.stringify(names));

  // A raised proforma keeps its row (is_proforma=1, raised_invo set). It must
  // still be counted once under the ON stream — not dropped, not doubled.
  db.run("UPDATE invoices SET raised_invo='500' WHERE buyer='BUYERB' AND is_proforma=1");
  const betaRows = REPORTS.form_d.json(db, { auctionId: 1 }).top5.filter(r => r.name === 'BETA SPICES');
  check('flag ON → a raised proforma is still counted exactly once',
        betaRows.length === 1 && betaRows[0].kilos === 400,
        JSON.stringify(betaRows));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  closeDb && closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
