// THE WATERMARK, ON THE REAL DOWNLOAD ROUTES.
//
// tests/pdf-watermark.unit.js proves the mark is drawn correctly. This one
// proves it is actually THERE on every PDF a user can download — each document
// type, through the route the button hits, with real data behind it. That is
// the whole claim of the feature ("every PDF"), and it is the kind of claim
// that rots one renderer at a time, so the list below is deliberately long.
// The two engines are covered where they are chosen: the sales invoice is
// pulled twice, once as PDFKit and once as HTML, because it has to survive an
// operator switching a layout.
//
//   [invoices] sales invoice (both engines), purchase invoice, bill of
//              supply, commission bill (+ F2), debit note dealer + planter
//   [exports]  a generic table export, the Spices Board returns, a lorry
//              report, an auction slip, the payment statement, the trade
//              summary — the renderers that are NOT invoice-pdf.js
//   [off]      flag_pdf_watermark = false removes it from every one of them
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const { PDFDocument, PDFName } = require(path.join(ROOT, 'node_modules', 'pdf-lib'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-wm-'));
const PORT = 47437;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function raw(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}

// Image DRAWS per page — see the unit test for why the resource count won't do
// (one embedded logo, referenced by both the header and the watermark).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
function streamText(s) {
  let b; try { b = Buffer.from(s.getContents ? s.getContents() : s.contents); } catch (_) { return ''; }
  try { return zlib.inflateSync(b).toString('latin1'); } catch (_) { return b.toString('latin1'); }
}
function countDraws(ctx, resources, text, depth) {
  const xo = resources && resources.lookup ? resources.lookup(PDFName.of('XObject')) : null;
  if (!xo || !xo.entries) return 0;
  let n = 0;
  for (const [name, ref] of xo.entries()) {
    const key = name.asString ? name.asString() : String(name);
    const uses = (text.match(new RegExp(escRe(key) + '\\s+Do', 'g')) || []).length;
    if (!uses) continue;
    const obj = ctx.lookup(ref);
    const dict = obj && obj.dict ? obj.dict : obj;
    const sub = dict && dict.get ? dict.get(PDFName.of('Subtype')) : null;
    const st = sub ? (sub.asString ? sub.asString() : String(sub)) : '';
    if (st === '/Image') n += uses;
    else if (st === '/Form' && depth < 4) {
      n += uses * countDraws(ctx, ctx.lookup(dict.get(PDFName.of('Resources'))), streamText(obj), depth + 1);
    }
  }
  return n;
}
async function imageDrawsPerPage(buf) {
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  return pdf.getPages().map((p) => {
    const ctx = p.node.context;
    const c = p.node.Contents();
    const streams = !c ? [] : (c.asArray ? c.asArray().map((r) => ctx.lookup(r)) : [c]);
    return countDraws(ctx, p.node.Resources(), streams.map(streamText).join('\n'), 0);
  });
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', b => { log += b.toString(); });
srv.stderr.on('data', b => { log += b.toString(); });
function done(code) {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}

const GST = '33AAAAA0000A1Z5';

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', log.slice(-2000)); done(1); }
  console.log('logged in\n');

  const setFlag = (k, v) => api('PUT', '/api/company-settings', { settings: { [k]: String(v) } });
  await setFlag('flag_debit_note', 'true');
  await setFlag('flag_debit_note_planter', 'true');
  // The logo the watermark stamps is the one the header resolves; the repo
  // ships public/logo-ispl.png, which is what a blank code falls back to.
  await setFlag('logo', 'ispl');

  // A trade with one dealer lot (purchase invoice + dealer DN) and one planter
  // lot (bill of supply + planter DN), both sold to one buyer (sales invoice).
  const auc = await api('POST', '/api/auctions', { ano: '811', date: '2026-09-20', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  await api('POST', '/api/buyers', { buyer: 'BL', buyer1: 'LOCAL BUYER', sale: 'L' });
  for (const [lot_no, name, cr] of [['1', 'AAA TRADERS', GST], ['2', 'PLANTER AAA', '']]) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, cr, qty: 100, grade: cr ? '2' : '1', bags: 10, crop: 'CARDAMOM',
    });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`, { buyer: 'BL', price: 500, amount: 50000 });
  }
  await api('POST', `/api/lots/calculate/${aid}`);
  const plan = (await api('GET', `/api/auctions/${aid}/transaction-plan`)).d;
  const startOf = (id) => ((plan.steps || []).find((s) => s.id === id) || {}).suggestedStart;
  const run = await api('POST', `/api/auctions/${aid}/generate-transactions`, {
    steps: {
      invoices: { start: startOf('invoices') }, purchases: { start: startOf('purchases') },
      bills: { start: startOf('bills') }, debit_notes: { start: startOf('debit_notes') },
      debit_notes_planter: { start: startOf('debit_notes_planter') },
    },
  });
  if (run.status !== 200 || !run.d.ok) { console.error('generate failed', run.status, JSON.stringify(run.d)); done(1); }

  const invId = ((await api('GET', `/api/invoices?auction_id=${aid}`)).d || [])[0].id;
  const dnId = ((await api('GET', `/api/debit-notes?ano=811`)).d || [])[0].id;
  const dnpRows = (await api('GET', `/api/debit-notes-planter?ano=811`)).d || [];
  const dnpId = (dnpRows[0] || {}).id;
  const billId = ((await api('GET', `/api/bills?auction_id=${aid}`)).d || [])[0].id;

  // Each document, pulled with the watermark on and then off. The assertion is
  // relative on purpose: some layouts print a header logo and some don't, and
  // what must hold everywhere is ONE more image drawn per page.
  const DOCS = [
    ['sales invoice (pdfkit)',  ['GET',  `/api/invoices/pdf/${invId}`]],
    ['purchase invoice',        ['GET',  `/api/purchases/pdf/${aid}/${encodeURIComponent('AAA TRADERS')}`]],
    ['bill of supply',          ['GET',  `/api/bills/pdf/${aid}/${encodeURIComponent('PLANTER AAA')}`]],
    ['debit note (dealer)',     ['GET',  `/api/debit-notes/${dnId}/pdf`]],
    ['debit note (planter)',    ['GET',  `/api/debit-notes-planter/${dnpId}/pdf`]],
    ['commission bill',         ['POST', '/api/bills/commission-bos-bulk', { ids: [billId] }]],
    ['commission bill F2',      ['GET',  `/api/bills/commission-bill-f2/${aid}?format=pdf`]],
    ['sales invoice (html)',    ['GET',  `/api/invoices/pdf/${invId}?template=modern`]],

    // ── Exports: the renderers outside invoice-pdf.js ─────────────────
    // The shared table renderer (one call behind most exports)…
    ['export: sales journal',   ['GET',  `/api/exports/sales_journal/${aid}?format=pdf`]],
    ['export: checklist',       ['GET',  `/api/exports/checklist/${aid}?format=pdf`]],
    // …the bespoke ones that bypass it…
    ['export: tharai list',     ['GET',  `/api/exports/tharai_list/${aid}?format=pdf`]],
    ['auction slip',            ['GET',  `/api/exports/lot_slip/${aid}?format=pdf`]],
    ['collection report',       ['GET',  `/api/exports/collection/${aid}?format=pdf`]],
    ['trade report',            ['GET',  `/api/exports/trade_report/${aid}?format=pdf`]],
    // …the statutory returns…
    ['spice board: Form C',     ['GET',  `/api/spice-board-reports/form_c/export?format=pdf&auctionId=${aid}`]],
    ['spice board: Form D',     ['GET',  `/api/spice-board-reports/form_d/export?format=pdf&auctionId=${aid}`]],
    ['spice board: Form D1',    ['GET',  `/api/spice-board-reports/form_d1/export?format=pdf&auctionId=${aid}`]],
    ['spice board: arrivals',   ['GET',  `/api/spice-board-reports/arrivals/export?format=pdf&auctionId=${aid}`]],
    // …the lorry sheets…
    ['lorry: truck list',       ['GET',  `/api/lorry-reports/truck_list/${aid}?format=pdf`]],
    // …and the two statements drawn inline in server.js.
    ['payment statement',       ['GET',  `/api/payments/pdf/${aid}/${encodeURIComponent('PLANTER AAA')}`]],
    ['trade summary',           ['GET',  `/api/reports/summary-pdf/${aid}`]],
  ];

  console.log('[routes] every PDF download carries the mark');
  for (const [label, [method, url, body]] of DOCS) {
    await setFlag('flag_pdf_watermark', 'true');
    const on = await raw(method, url, body);
    await setFlag('flag_pdf_watermark', 'false');
    const off = await raw(method, url, body);
    if (on.status !== 200 || off.status !== 200) {
      // The HTML engine needs a Chromium; skip rather than fail where there
      // is none, the way the browser tests do.
      if (label.includes('html')) { console.log(`  --   ${label}: not rendered (${on.status}) — skipped`); continue; }
      check(`${label}: downloads`, false, `${on.status} / ${off.status}`);
      continue;
    }
    const a = await imageDrawsPerPage(on.buf);
    const b = await imageDrawsPerPage(off.buf);
    check(`${label}: exactly one more image draw per page`,
          a.length > 0 && a.length === b.length && a.every((n, i) => n === b[i] + 1),
          `on ${JSON.stringify(a)} vs off ${JSON.stringify(b)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e, '\n', log.slice(-2000)); done(1); });
