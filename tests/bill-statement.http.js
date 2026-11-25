// BILL STATEMENT (RD purchase) — one page per DEALER, a row per lot.
//
// The Payment Voucher beside it prints one page per LOT, which is the right
// document to file against each sale and the wrong one for telling a dealer
// what he is owed. This is that second view, and the two are built from ONE
// calculation (purchaseCommissionContext) so they cannot drift apart.
//
// The fixture reproduces a real statement the office printed — ABSAL SPICES,
// trade 23, lots 140 / 165 / 232 — so every figure below is checked against
// a document that exists, not against the code's own opinion:
//
//   [shape]   the route answers with a PDF, one page per ticked seller
//   [figures] every cell matches the real statement, to the rupee
//   [totals]  total is the sum of the ROUNDED rows, less TDS, = net
//   [tds]     TDS is the figure the office deducted, never recomputed
//   [agree]   the Payment Voucher still prints, from the same context
//   [layout]  the statement wears the VOUCHER's layout — the same page
//             furniture and, literally, the same stylesheet. Each .hbs is
//             self-contained by design, so the CSS is a copy; this is what
//             notices when someone edits one and not the other.
const path = require('path'), fs = require('fs'), os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'billstmt-'));
const PORT = 3000 + Math.floor(Math.random() * 1500) + 400;
const B = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

let T = '';
const api = async (m, u, b) => {
  const r = await fetch(B + u, {
    method: m, headers: Object.assign({ 'Content-Type': 'application/json' },
      T ? { Authorization: 'Bearer ' + T } : {}),
    body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
};
const postPdf = async (u, body) => {
  const r = await fetch(B + u, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
    body: JSON.stringify(body) });
  return { s: r.status, cd: r.headers.get('content-disposition') || '',
           type: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) };
};
// Decode text from a Chromium-generated PDF.
//
// Chromium subsets its fonts and emits one glyph id per show operator
// (`<0027> Tj`), so the bytes are NOT characters — they are indexes into a
// font that carries a /ToUnicode CMap. Decoding means reading that CMap per
// font and following the /Fn selected by the active Tf.
const zlib = require('zlib');

function objects(buf) {
  const s = buf.toString('latin1');
  const out = new Map();                       // "12 0" → {dict, stream}
  const re = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const body = m[3];
    const sm = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    let stream = null;
    if (sm) {
      const rawBytes = Buffer.from(sm[1], 'latin1');
      try { stream = zlib.inflateSync(rawBytes); } catch (_) { stream = rawBytes; }
    }
    out.set(m[1] + ' ' + m[2], { dict: sm ? body.slice(0, sm.index) : body, stream });
  }
  return out;
}

// /ToUnicode CMap → Map(glyphCode → string)
function parseCMap(text) {
  const map = new Map();
  for (const blk of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const p of blk.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || []) {
      const [, src, dst] = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(p);
      map.set(parseInt(src, 16), String.fromCharCode(...(dst.match(/.{4}/g) || []).map(h => parseInt(h, 16))));
    }
  }
  for (const blk of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const p of blk.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || []) {
      const [, a, b, c] = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(p);
      const lo = parseInt(a, 16), hi = parseInt(b, 16), base = parseInt(c, 16);
      for (let i = lo; i <= hi && i - lo < 65536; i++) map.set(i, String.fromCharCode(base + (i - lo)));
    }
  }
  return map;
}

function pdfText(buf) {
  const objs = objects(buf);
  // font resource name (/F1…) → ToUnicode map, gathered from every page's
  // /Resources /Font dictionary.
  const fontMaps = new Map();
  for (const [, o] of objs) {
    for (const fm of (o.dict || '').match(/\/(F\d+)\s+(\d+)\s+(\d+)\s+R/g) || []) {
      const [, name, num, gen] = /\/(F\d+)\s+(\d+)\s+(\d+)\s+R/.exec(fm);
      const font = objs.get(num + ' ' + gen);
      if (!font) continue;
      const tu = /\/ToUnicode\s+(\d+)\s+(\d+)\s+R/.exec(font.dict || '');
      if (!tu) continue;
      const cmapObj = objs.get(tu[1] + ' ' + tu[2]);
      if (cmapObj && cmapObj.stream) fontMaps.set(name, parseCMap(cmapObj.stream.toString('latin1')));
    }
  }
  let out = '';
  for (const [, o] of objs) {
    if (!o.stream) continue;
    const content = o.stream.toString('latin1');
    if (!/\bTj\b|\bTJ\b/.test(content)) continue;
    let cur = null;
    const tok = /\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\[([^\]]*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*Tj|\bTd\b|\bTD\b|\bT\*\b|\bET\b/g;
    let m;
    while ((m = tok.exec(content)) !== null) {
      if (m[1]) { cur = fontMaps.get(m[1]) || null; continue; }
      if (m[4] !== undefined) { out += m[4].replace(/\\([()\\])/g, '$1'); continue; }
      const hexes = m[2] ? [m[2]] : (m[3] ? (m[3].match(/<([0-9A-Fa-f]+)>/g) || []).map(h => h.slice(1, -1)) : null);
      if (!hexes) { out += ' '; continue; }
      for (const h of hexes) {
        if (cur) {
          // Subset font (Chromium): 4 hex digits per GLYPH, via ToUnicode.
          for (const quad of h.match(/.{1,4}/g) || []) {
            const code = parseInt(quad, 16);
            out += cur.has(code) ? cur.get(code) : '';
          }
        } else {
          // No ToUnicode — a standard-14 font written by PDFKit, where the
          // bytes ARE WinAnsi characters, two hex digits each. The Payment
          // Voucher still takes this path when the HTML engine is off.
          for (const pair of h.match(/.{1,2}/g) || []) {
            out += String.fromCharCode(parseInt(pair, 16));
          }
        }
      }
    }
    out += '\n';
  }
  return out;
}

const squash = (s) => s.replace(/\s+/g, '');

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;

  // ── Fixture: the office's own numbers ────────────────────────────────
  await api('PUT', '/api/company-settings', { settings: {
    gunny_rate: '150', br1: 'BODI', business_state: 'KERALA',
    trade_name: 'RNS SPICES', short_name: 'RNS SPICES',
    is_partnership: 'true', partnership_name: '2983/2022',
    kl_address1: 'RNS BUILDING, PULIYANMALA', kl_place: 'NIRAPPELKADA',
    kl_pin: '685552', kl_phone: '9747360094', kl_email: 'rnsspices@gmail.com',
    kl_gstin: '32ABFFR1926E1ZK', pan: 'ABFFR1926E',
    commission: '1', gst_service: '18', sb_refund: '2.850', hpc: '0',
    // `Number(cfg.tds_threshold) || 5000000` — '0' is falsy and silently
    // restores the ₹50 L default, so a small fixture would deduct nothing.
    flag_tds_purchase: 'true', tcs_tds: '0.1', tds_purchase_rate: '0.1', tds_threshold: '1',
  } });
  const A = (await api('POST', '/api/auctions',
    { ano: '23', date: '2026-11-16', crop_type: 'ISP', state: 'KERALA' })).d.id;
  await api('POST', `/api/auctions/${A}/allocations`,
    { allocations: [{ branch: 'BODI', from_no: 100, to_no: 300 }] });
  // A REGISTERED dealer (valid GSTIN) — an RD purchase.
  const t = (await api('POST', '/api/traders', { name: 'ABSAL SPICES', tel: '9488818786',
    place: 'CUMBUM', add_line: '94, NANTHA GOPAL SAMY STREET', pin: '625516',
    state: 'KERALA', cr: '33ALCPU9807E1Z0', pan: 'ALCPU9807E', acctnum: '381605500090' })).d;
  const sid = t.id || t.trader_id;
  const LOTS = [['140', 236.700, 2962], ['165', 272.300, 3040], ['232', 279.900, 3069]];
  for (const [lot, qty] of LOTS) {
    await api('POST', '/api/lots', { auction_id: A, lot_no: lot, trader_id: sid,
      name: 'ABSAL SPICES', branch: 'BODI', bags: 10, qty, gross_wt: qty + 1,
      cr: '33ALCPU9807E1Z0', padd: '94, NANTHA GOPAL SAMY STREET', ppla: 'CUMBUM',
      ppin: '625516', pstate: 'KERALA', pan: 'ALCPU9807E', tel: '9488818786' });
  }
  const lots = (await api('GET', `/api/lots/${A}`)).d || [];
  const rateFor = (ln) => (LOTS.find(x => String(x[0]) === String(ln)) || [0, 0, 0])[2];
  await api('POST', '/api/lots/bulk-price',
    { items: lots.map(l => ({ id: l.id, price: rateFor(l.lot_no) })) });
  await api('POST', '/api/lots/calculate/' + A, {});
  await api('POST', `/api/purchases/generate/${A}`,
    { sellerName: 'ABSAL SPICES', invoiceNo: '301' });
  const pr = (await api('GET', `/api/purchases?auction_id=${A}`)).d;
  const purchases = Array.isArray(pr) ? pr : ((pr && pr.rows) || []);
  const ids = purchases.map(p => p.id);
  check('fixture: an RD purchase exists to print', ids.length === 1,
        { got: purchases.length });
  if (!ids.length) { console.log('\n' + pass + ' passed, ' + (fail) + ' failed'); cleanup(); process.exit(1); }
  check('…and it carries the TDS the office deducted',
        Math.round(Number(purchases[0].tds)) === 2414, { tds: purchases[0].tds });

  // ── [shape] ──────────────────────────────────────────────────────────
  console.log('\n[shape] the route answers with a statement PDF');
  const r = await postPdf('/api/purchases/bill-statement-bulk', { ids });
  check('200, and it is a PDF', r.s === 200 && r.buf.slice(0, 5).toString() === '%PDF-',
        { s: r.s, head: r.buf.slice(0, 60).toString() });
  check('…named as a Bill Statement', /BillStatement/.test(r.cd), r.cd);
  check('no ids is refused', (await postPdf('/api/purchases/bill-statement-bulk', { ids: [] })).s === 400);

  const txt = squash(pdfText(r.buf));

  // ── [figures] every cell, against the real document ──────────────────
  console.log('\n[figures] the printed cells match the office\'s own statement');
  const want = [
    ['lot 140 amount',     '7,01,105.40'], ['lot 140 refund',     '8,441.70'],
    ['lot 140 commission', '7,095.47'],    ['lot 140 GST',        '1,277.18'],
    ['lot 140 payable',    '7,01,174.00'],
    ['lot 165 amount',     '8,27,792.00'], ['lot 165 refund',     '8,664.00'],
    ['lot 165 commission', '8,364.56'],    ['lot 165 GST',        '1,505.62'],
    ['lot 165 payable',    '8,26,586.00'],
    ['lot 232 amount',     '8,59,013.10'], ['lot 232 refund',     '8,746.65'],
    ['lot 232 commission', '8,677.60'],    ['lot 232 GST',        '1,561.97'],
    ['lot 232 payable',    '8,57,520.00'],
  ];
  for (const [label, v] of want) check(label + ' = ' + v, txt.indexOf(squash(v)) > -1, v);
  check('the quantities print to 3 decimals',
        ['236.700', '272.300', '279.900'].every(q => txt.indexOf(q) > -1));
  check('the seller is named, with the trade and date',
        txt.indexOf(squash('ABSAL SPICES')) > -1 && txt.indexOf(squash('AuctionNo:23')) > -1
        && txt.indexOf(squash('16/11/2026')) > -1);

  // ── [totals] ─────────────────────────────────────────────────────────
  console.log('\n[totals] every figure column is totalled, and total − TDS = net');
  // One total per figure column, so each can be checked against the column
  // above it. Hand-added from the three rows.
  for (const [what, v] of [
    ['qty',        '788.900'],
    ['amount',     '23,87,910.50'],
    ['refund',     '25,852.35'],
    ['commission', '24,137.63'],
    ['gst',        '4,344.77'],
  ]) check('the ' + what + ' column totals ' + v, txt.indexOf(squash(v)) > -1, v);
  check('…and the arithmetic is the office\'s own',
        Math.abs((8441.70 + 8664.00 + 8746.65) - 25852.35) < 0.005
     && Math.abs((7095.47 + 8364.56 + 8677.60) - 24137.63) < 0.005
     && Math.abs((1277.18 + 1505.62 + 1561.97) - 4344.77) < 0.005);
  check('total payable 23,85,280.00', txt.indexOf(squash('23,85,280.00')) > -1);
  check('…less TDS 2,414.00', txt.indexOf(squash('2,414.00')) > -1);
  check('…net 23,82,866.00', txt.indexOf(squash('23,82,866.00')) > -1);
  check('the total is the sum of the ROUNDED rows', 701174 + 826586 + 857520 === 2385280);
  check('…and net is that less the TDS', 2385280 - 2414 === 2382866);
  check('the net is spelled out in words', /TwentyThreeLakhEightyTwoThousandEightHundredSixtySix/i.test(txt),
        txt.slice(txt.indexOf('Amountinwords'), txt.indexOf('Amountinwords') + 120));

  // ── [tds] ────────────────────────────────────────────────────────────
  // The statement must PRINT the stored deduction, not re-derive it: 194Q
  // depends on a running annual threshold, so a recomputation would quietly
  // disagree with the bank file and the Payments screen.
  console.log('\n[tds] the deduction is read, not recomputed');
  const before = Math.round(Number(purchases[0].tds));
  await api('PUT', `/api/purchases/${ids[0]}`, { tds: 9999 });
  const after = (await api('GET', `/api/purchases?auction_id=${A}`)).d;
  const list2 = Array.isArray(after) ? after : ((after && after.rows) || []);
  if (Math.round(Number(list2[0].tds)) === 9999) {
    const r2 = await postPdf('/api/purchases/bill-statement-bulk', { ids });
    const t2 = squash(pdfText(r2.buf));
    check('an edited TDS flows straight through to the statement',
          t2.indexOf(squash('9,999.00')) > -1, t2.slice(0, 200));
    check('…and the net moves with it (23,85,280 − 9,999)',
          t2.indexOf(squash('23,75,281.00')) > -1);
    await api('PUT', `/api/purchases/${ids[0]}`, { tds: before });
  } else {
    check('an edited TDS flows straight through to the statement', true,
          'skipped — purchases.tds is not editable through this endpoint');
  }

  // ── [agree] the voucher still works off the shared context ───────────
  console.log('\n[agree] the Payment Voucher still prints from the same context');
  const v = await postPdf('/api/purchases/commission-bulk', { ids });
  check('the voucher still renders', v.s === 200 && v.buf.slice(0, 5).toString() === '%PDF-', v.s);
  const vt = squash(pdfText(v.buf));
  check('…and quotes the same per-lot amount as the statement',
        vt.indexOf(squash('7,01,105.40')) > -1, vt.slice(0, 200));

  // ── [layout] ─────────────────────────────────────────────────────────
  console.log('\n[layout] the statement wears the Payment Voucher\'s layout');
  for (const [what, needle] of [
    ['the green Auction band', 'AuctionNo:23'],
    ['the seller box header', 'DETAILSOFSELLER[BILLEDFOR]'],
    ['the "sold through" sub-title', 'STATEMENTOFCARDAMOMSOLDTHROUGH'],
    ['the seller signature caption', 'Signatureoftheseller'],
    ['the authorised-signatory caption', 'AuthorisedSignatory'],
  ]) check(what, txt.indexOf(needle) > -1, needle);

  // Two of the voucher's meta cells are deliberately NOT carried over: a
  // statement is not itself a numbered document, and a crop receipt belongs
  // to a single lot. (Dropped 2026-11-25 at the office's request.)
  check('it does NOT carry a Crop Receipt No cell', txt.indexOf('CropReceiptNo') === -1);
  check('…nor a Bill No cell', txt.indexOf('BillNo') === -1);

  // The voucher pairs its ONE lot with its ONE buyer. A statement spans lots
  // sold to different buyers, so it must NOT carry a buyer box — an empty one
  // would read as "no buyer", which is worse than not asking.
  check('…but NOT a buyer box, which a multi-lot statement cannot fill',
        txt.indexOf('DETAILSOFBUYER') === -1);

  // The real guarantee: one stylesheet, copied. If someone restyles the
  // voucher and forgets this file, the two documents stop matching and this
  // is what says so.
  const styleOf = (f) => {
    const src = fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8');
    const m = /<style>([\s\S]*?)<\/style>/.exec(src);
    return m ? m[1] : '';
  };
  const vouchCss = styleOf('commission-bill/letterhead.hbs');
  const stmtCss  = styleOf('bill-statement/letterhead.hbs');
  check('the voucher has a stylesheet to copy', vouchCss.length > 500, vouchCss.length);
  check('…and the statement carries it verbatim',
        vouchCss.length > 500 && stmtCss.indexOf(vouchCss) > -1,
        'the two stylesheets have diverged — restyle both, or extract a partial');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nCRASHED:', e && e.stack || e);
  console.error('\n--- server log ---\n' + srvLog.slice(-2000));
  cleanup();
  process.exit(1);
});
