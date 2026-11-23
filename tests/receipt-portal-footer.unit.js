// LOT RECEIPT — the "download your bills" line must print on EVERY receipt.
//
// The portal address was added to the three renderers in mobile-bridge.js
// (full PDF, thermal ESC/POS, compact) and the helper read only the config
// shape that file builds — `cfg.portalUrl`. The DESKTOP slip is a fourth
// renderer, generateCropReceiptPDF in invoice-pdf.js, reached by
// GET /api/receipt/:lotId with raw getSettingsFlat() settings. It printed
// nothing, and nothing failed: the footer is *meant* to be silent when the
// portal is off, so a missing line looks exactly like a switched-off one.
//
// So this pins both halves — the helper reads either config shape, and the
// renderers actually call it:
//
//   [shape]     mobile cfg and raw settings produce the same line
//   [off]       flag off, or address blank, prints nothing at all
//   [desktop]   the server-rendered PDF carries the address
//   [wiring]    every server-side receipt renderer calls the shared helper
//   [browser]   the slip the DESKTOP APP actually prints carries it too
//   [compact]   …and so does the lean thermal stub, the other print format
//
// [browser] is the important one. There are FIVE lot-receipt renderers, and
// the desktop Lot Entry print is not any of the Node ones: it builds the
// slip as HTML in the page (leBuildDetailedHtml in public/index.html) and
// hands it to the browser's print dialog. The first fix here wired up
// generateCropReceiptPDF — a real renderer, but NOT the one the operator
// prints from — so the slip still came out without the link. This section
// runs the page's own builder, so the check matches what gets printed.
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

// Decode a PDFKit document's text back out — same approach as
// tests/auction-report-column-fit.unit.js.
function pdfText(buf) {
  const zlib = require('zlib');
  let raw = '';
  const s = buf.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    try { raw += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) {}
  }
  let out = '';
  for (const tj of raw.match(/\[[^\]]*\]\s*TJ/g) || []) {
    for (const h of tj.match(/<([0-9A-Fa-f]+)>/g) || []) {
      out += Buffer.from(h.slice(1, -1), 'hex').toString('latin1');
    }
    out += ' ';
  }
  return out;
}
// PDFKit kerns mid-word, so the decoded run has stray spaces in it.
const squash = (s) => s.replace(/\s+/g, '');

const URL = 'rns-eauction.up.railway.app/my';

(async () => {
  const { receiptFooterLines, portalFooterUrlText } =
    require(path.join(ROOT, 'receipt-footer.js'));

  // ── [shape] both config shapes, one answer ───────────────────────────
  console.log('\n[shape] the helper reads either config shape');
  const mobileCfg = { portalUrl: 'https://' + URL, companyEmail: 'rnsspices@gmail.com' };
  const rawCfg = {
    flag_customer_portal: 'true',
    portal_public_url: 'https://' + URL,
    kl_email: 'rnsspices@gmail.com',
  };
  const want = ['Your bills online:', URL, 'rnsspices@gmail.com'];
  check('the mobile shape (getReceiptConfig) resolves',
    JSON.stringify(receiptFooterLines(mobileCfg)) === JSON.stringify(want),
    JSON.stringify(receiptFooterLines(mobileCfg)));
  check('…and raw settings (getSettingsFlat) resolve IDENTICALLY',
    JSON.stringify(receiptFooterLines(rawCfg)) === JSON.stringify(want),
    JSON.stringify(receiptFooterLines(rawCfg)));
  check('the scheme and any trailing slash are stripped',
    portalFooterUrlText({ flag_customer_portal: 'true', portal_public_url: 'https://' + URL + '//' }) === URL);
  check('an address stored WITHOUT a scheme is left alone',
    portalFooterUrlText({ flag_customer_portal: 'true', portal_public_url: URL }) === URL);

  // ── [off] silence is deliberate, and must stay exact ─────────────────
  console.log('\n[off] a receipt never points at a shut door');
  check('flag off prints no address',
    portalFooterUrlText({ flag_customer_portal: 'false', portal_public_url: 'https://' + URL }) === '');
  check('flag on but address blank prints no address',
    portalFooterUrlText({ flag_customer_portal: 'true', portal_public_url: '' }) === '');
  check('…and neither leaks the "Your bills online:" label',
    !receiptFooterLines({ flag_customer_portal: 'false', portal_public_url: 'https://' + URL })
      .includes('Your bills online:'));

  // ── [desktop] the renderer that was missed ───────────────────────────
  console.log('\n[desktop] GET /api/receipt/:lotId → generateCropReceiptPDF');
  const { generateCropReceiptPDF } = require(path.join(ROOT, 'invoice-pdf.js'));
  const lot = { ano: 'A-21', lot_no: '101', bags: 12, qty: '250.50', branch: 'CUMBUM',
                crop: 'R-0042', name: 'GANESHBABU', cr: '33ALCPU9807E1Z0' };
  const base = { business_state: 'KERALA', trade_name: 'RNS SPICES', short_name: 'RNS',
                 kl_address1: '1/234 Main Road', kl_place: 'CUMBUM', kl_pin: '625516',
                 kl_phone: '9747360094', kl_email: 'rnsspices@gmail.com' };

  const onPdf = pdfText(await generateCropReceiptPDF(lot,
    Object.assign({}, base, { flag_customer_portal: 'true', portal_public_url: 'https://' + URL })));
  check('the slip prints the portal address',
    squash(onPdf).includes(squash(URL)), onPdf.slice(-180));
  check('…under a line telling the seller what it is for',
    squash(onPdf).includes(squash('Download your bills anytime at')));

  const offPdf = pdfText(await generateCropReceiptPDF(lot,
    Object.assign({}, base, { flag_customer_portal: 'false', portal_public_url: 'https://' + URL })));
  check('portal off → the slip says nothing about it',
    !squash(offPdf).includes(squash(URL)) &&
    !squash(offPdf).includes(squash('Download your bills')));
  check('…and the rest of the slip is unharmed',
    squash(offPdf).includes(squash('GANESHBABU')) && squash(offPdf).includes('RECEIPT'));

  // ── [wiring] the check that would have caught the bug ────────────────
  // A receipt renderer that doesn't consult the shared helper prints
  // nothing and fails silently, so assert the call is present rather than
  // trusting the next person to remember.
  console.log('\n[wiring] every receipt renderer consults the shared helper');
  const mb = fs.readFileSync(path.join(ROOT, 'mobile-bridge.js'), 'utf8');
  const ip = fs.readFileSync(path.join(ROOT, 'invoice-pdf.js'), 'utf8');
  check('mobile-bridge.js imports it rather than keeping a private copy',
    /require\(['"]\.\/receipt-footer['"]\)/.test(mb) &&
    !/^function receiptFooterLines/m.test(mb));
  check('…and calls it in all three of its renderers',
    (mb.match(/receiptFooterLines\(/g) || []).length >= 3,
    'found ' + (mb.match(/receiptFooterLines\(/g) || []).length);
  check('invoice-pdf.js imports it',
    /require\(['"]\.\/receipt-footer['"]\)/.test(ip));
  check('…and the desktop slip renderer calls it',
    /portalFooterUrlText\(/.test(ip.slice(ip.indexOf('function generateCropReceiptPDF'))));

  // ── [browser] the slip the desktop app really prints ────────────────
  // Lot Entry → print builds the HTML in the page. Pull the actual
  // functions out of index.html and run them, rather than trusting a grep:
  // a grep cannot tell whether portalUrl survives the hand-off into
  // leBuildDetailedHtml, which is exactly where it would go missing.
  console.log('\n[browser] Lot Entry print → leBuildDetailedHtml (public/index.html)');
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const grab = (name) => {
    const i = page.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('receipt builder not found in index.html: ' + name);
    let d = 0, started = false;
    for (let k = i; k < page.length; k++) {
      const c = page[k];
      if (c === '{') { d++; started = true; }
      else if (c === '}') { d--; if (started && d === 0) return page.slice(i, k + 1); }
    }
    throw new Error('unbalanced braces in ' + name);
  };
  const prelude = `
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    const fmtD = () => '12/08/2026';
    const fmtIstDate = () => '20/11/2026';
    const maskAcct = (v) => String(v);
    const maskIfsc = (v) => String(v);
  `;
  const buildSlip = new Function(prelude +
    ['leGroupLotsByTrader', '_leReceiptFields', 'leBuildCompactHtml',
     'leBuildDetailedHtml', 'leBuildReceiptHtml'].map(grab).join('\n\n') +
    '\n; return leBuildReceiptHtml;')();

  const lots = [{ id: 1, lot_no: '101', trader_id: 7, name: 'GANESHBABU', branch: 'CUMBUM',
                  state: 'KERALA', cr: '33ALCPU9807E1Z0', bags: 12, qty: 250.5,
                  gross_wt: 255.0, sample_wt: 0.5, ppla: 'CUMBUM', ppin: '625516' }];
  // The live install's own settings — KERALA, a 58mm roll, DETAILED format.
  const pageCfg = { business_state: 'KERALA', trade_name: 'RNS SPICES', short_name: 'RNS',
                    kl_phone: '9747360094', kl_email: 'rnsspices@gmail.com',
                    kl_gstin: '33ALCPU9807E1Z0', lot_receipt_format: 'DETAILED',
                    lot_receipt_width_mm: '58' };
  const slip = (over) => buildSlip('detailed', lots,
    { cfg: Object.assign({}, pageCfg, over), auction: { ano: '21', date: '2026-08-12' }, traderInfo: {} });

  const onSlip = slip({ flag_customer_portal: 'true', portal_public_url: 'https://' + URL });
  check('the printed slip carries the portal address',
    onSlip.includes(URL));
  check('…with the line that tells the seller what it is',
    onSlip.includes('Download your bills anytime at'));
  check('…and the company email, on its OWN line under the phone',
    /Ph: 9747360094<\/div>\s*<div class="brand-addr brand-email">rnsspices@gmail\.com<\/div>/.test(onSlip),
    'header block did not match');
  check('an address stored without a scheme still prints once',
    (slip({ flag_customer_portal: 'true', portal_public_url: URL }).match(new RegExp(URL.replace(/[.\/]/g, '\\$&'), 'g')) || []).length === 1);

  const offSlip = slip({ flag_customer_portal: 'false', portal_public_url: 'https://' + URL });
  check('portal off → the printed slip says nothing about it',
    !offSlip.includes(URL) && !offSlip.includes('Download your bills'));
  check('…but the email stays, because that is not portal-gated',
    offSlip.includes('rnsspices@gmail.com'));

  // ── [compact] the other format the same button can print ───────────
  // The compact stub deliberately drops every contact field, so the portal
  // line is a deliberate exception rather than an oversight — which is
  // precisely the kind of thing a later tidy-up removes. Pin it.
  console.log('\n[compact] Lot Entry print → leBuildCompactHtml (public/index.html)');
  const stub = (over) => buildSlip('compact', lots,
    { cfg: Object.assign({}, pageCfg, { lot_receipt_format: 'COMPACT' }, over),
      auction: { ano: '21', date: '2026-08-12' }, traderInfo: {} });

  const onStub = stub({ flag_customer_portal: 'true', portal_public_url: 'https://' + URL });
  check('the thermal stub carries the portal address',
    onStub.includes(URL));
  check('…with a line saying what it is',
    onStub.includes('Download your bills at'));
  check('…and it is still the LEAN stub otherwise (no phone, no GSTIN)',
    !onStub.includes('9747360094') && !onStub.includes('GSTIN'),
    'the compact stub picked up contact fields it is meant to drop');

  const offStub = stub({ flag_customer_portal: 'false', portal_public_url: 'https://' + URL });
  check('portal off → the stub says nothing about it',
    !offStub.includes(URL) && !offStub.includes('Download your bills'));
  check('…and the stub still prints its lots and totals',
    offStub.includes('GANESHBABU') && offStub.includes('250.500'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nCRASHED:', e && e.stack || e); process.exit(1); });
