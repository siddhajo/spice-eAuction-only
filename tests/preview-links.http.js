// PREVIEW LINKS — a previewed document must save under its REAL name.
//
// Preview used to fetch the PDF with an Authorization header, wrap it in a
// Blob and open the object URL. A blob URL is `blob:https://host/<uuid>`:
// no path, no headers, so Chrome's PDF viewer had nothing to name the file
// after and offered "9a1281db-2001-4c06-9474-8cf409c0cc22" in Save As. The
// server HAD sent the right name in Content-Disposition — the Blob threw
// it away.
//
// Now `?previewlink=1` parks the rendered PDF and answers with a URL whose
// last path segment is the filename. What this pins:
//
//   [link]     the link is handed back, and names the file as the direct
//              export does — the two names must not drift apart
//   [serve]    the parked document really is the PDF, served inline
//   [guard]    an unknown id is refused, and the id is not guessable
//   [compat]   plain export / download is byte-for-byte unaffected
//   [fallback] an endpoint that ignores the parameter still returns a PDF,
//              which is what lets the client fall back to a blob tab
const path = require('path'), fs = require('fs'), os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prevlink-'));
const PORT = 3000 + Math.floor(Math.random() * 1500) + 400;
const B = 'http://127.0.0.1:' + PORT;

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', b => { srvLog += b; });
srv.stderr.on('data', b => { srvLog += b; });
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

let T = '';
const api = async (m, u, b) => {
  const r = await fetch(B + u, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};
// A GET with the operator's token, returning headers + bytes.
const get = async (u, withAuth) => {
  const r = await fetch(B + u, { headers: withAuth === false ? {} : { Authorization: 'Bearer ' + T } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { s: r.status, type: r.headers.get('content-type') || '',
           cd: r.headers.get('content-disposition') || '', buf,
           json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; } })() };
};
const nameFromCd = (cd) => { const m = /filename="([^"]+)"/.exec(cd || ''); return m ? m[1] : ''; };

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;

  // ── Fixture: one trade with a few priced lots, so an export has rows ──
  await api('PUT', '/api/company-settings', { settings: { gunny_rate: '150', br1: 'BODI' } });
  const A = (await api('POST', '/api/auctions', { ano: '24', date: '2026-11-10', crop_type: 'ISP' })).d.id;
  await api('POST', `/api/auctions/${A}/allocations`, { allocations: [{ branch: 'BODI', from_no: 1, to_no: 40 }] });
  const sel = (await api('POST', '/api/traders', { name: 'GANESHBABU', tel: '9790744444', place: 'CUMBUM' })).d;
  const sid = sel && (sel.id || sel.trader_id);
  for (const [lot, bags, qty] of [['016', 1, 33.9], ['017', 2, 57.3], ['018', 3, 137.7]]) {
    await api('POST', '/api/lots', { auction_id: A, lot_no: lot, trader_id: sid, name: 'GANESHBABU',
                                     branch: 'BODI', bags, qty, gross_wt: qty + 1 });
  }

  // A buyer, and prices carrying their code, so the pre-invoice route has
  // something to render. Without this it 404s and every check below it
  // passes vacuously.
  await api('POST', '/api/buyers',
    { buyer: 'AK', buyer1: 'MURUGAN TRADERS', pla: 'BODI', gstin: '33ALCPU9807E1Z0' });
  const lotRows = (await api('GET', `/api/lots/${A}`)).d;
  const ids = (Array.isArray(lotRows) ? lotRows : []).map(l => l.id);
  await api('POST', '/api/lots/bulk-price', { items: ids.map(id => ({ id, price: 1500 })) });
  // buildSalesInvoice matches on lots.buyer — the lot's BUYER, not the
  // alternate `code` column that bulk-price writes.
  for (const id of ids) await api('PUT', `/api/lots/${id}`, { buyer: 'AK' });
  await api('POST', '/api/lots/calculate/' + A, {});

  // Pick a lorry report — the family the operator previews from. Its PDF is
  // the carbon-copy slip in the bug report.
  const RPT = 'lot_slip_code';
  const base = `/api/lorry-reports/${RPT}/${A}?format=pdf&inline=1`;

  // ── [compat] the direct path must be untouched ───────────────────────
  console.log('\n[compat] the ordinary export is unchanged');
  const direct = await get(base);
  const directName = nameFromCd(direct.cd);
  check('the plain inline export still returns a PDF',
    direct.s === 200 && direct.type.includes('application/pdf') &&
    direct.buf.slice(0, 5).toString() === '%PDF-',
    { s: direct.s, type: direct.type });
  check('…still inline, still named', /inline/.test(direct.cd) && /\.pdf$/.test(directName), direct.cd);
  const dl = await get(`/api/lorry-reports/${RPT}/${A}?format=pdf`);
  check('…and without inline=1 it is still an attachment',
    /attachment/.test(dl.cd) && nameFromCd(dl.cd) === directName, dl.cd);

  // ── [link] asking for a link ─────────────────────────────────────────
  console.log('\n[link] ?previewlink=1 returns a URL, not the bytes');
  const linked = await get(base + '&previewlink=1');
  check('the answer is JSON carrying a url',
    linked.s === 200 && linked.json && typeof linked.json.url === 'string', linked.json);
  const url = (linked.json && linked.json.url) || '';
  if (!url || !directName) {
    console.log('\n  ABORT: no preview link (or no direct filename) to test against — ' +
                'everything below would pass vacuously.');
    console.log('  direct: ' + JSON.stringify(direct.cd) + '  link: ' + JSON.stringify(linked.json));
    console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed');
    cleanup(); process.exit(1);
  }
  check('…the url is a /p/<id>/<name> path', /^\/p\/[0-9a-f]{32}\/.+\.pdf$/.test(url), url);
  check('…and its LAST SEGMENT is the very name the direct export gives',
    decodeURIComponent(url.split('/').pop()) === directName,
    { link: decodeURIComponent(url.split('/').pop() || ''), direct: directName });

  // ── [serve] the parked document ──────────────────────────────────────
  console.log('\n[serve] the link serves the document, named, to a plain browser');
  const served = await get(url, false);          // NO Authorization header
  check('it is served without an auth header (a tab cannot send one)', served.s === 200, served.s);
  check('…as a PDF', served.type.includes('application/pdf'), served.type);
  check('…inline, under the real filename', /inline/.test(served.cd) && nameFromCd(served.cd) === directName, served.cd);
  // Not byte-equal to `direct`: PDFKit stamps a creation time, so two
  // renders of the same report differ in a few bytes. Same size and a real
  // PDF header is the honest claim against a separate render — the parked
  // copy's own stability is pinned by the repeat fetch below.
  check('…and it is the same document the direct export returned',
    served.buf.slice(0, 5).toString() === '%PDF-' && served.buf.length === direct.buf.length,
    { link: served.buf.length, direct: direct.buf.length });
  check('…and it is not cached anywhere', /no-store/.test(
    (await fetch(B + url)).headers.get('cache-control') || ''));

  // A viewer may re-request or ask for ranges, so the id must not burn on
  // first use.
  const again = await get(url, false);
  check('a second fetch returns the very same parked bytes (viewers re-request)',
    again.s === 200 && again.buf.equals(served.buf),
    { first: served.buf.length, second: again.buf.length });

  // ── [guard] ──────────────────────────────────────────────────────────
  console.log('\n[guard] a link is good for one document and nothing else');
  check('an unknown id is refused', (await get('/p/' + 'a'.repeat(32) + '/X.pdf', false)).s === 404);
  check('…and a short/garbage id too', (await get('/p/1/X.pdf', false)).s === 404);
  const renamed = await get(url.replace(/\/[^/]+$/, '/Renamed.pdf'), false);
  check('the filename in the path is cosmetic — the id selects the document',
    renamed.s === 200 && renamed.buf.equals(served.buf));
  check('…and the served name comes from the PARK, not from the path',
    nameFromCd(renamed.cd) === directName, renamed.cd);
  const second = await get(base + '&previewlink=1');
  check('each request mints a DIFFERENT id', second.json.url !== url, { a: url, b: second.json.url });
  check('…and the operator token never appears in the link', url.indexOf(T) === -1);

  // ── [fallback] ───────────────────────────────────────────────────────
  // The client sends previewlink=1 to every PDF endpoint, including ones
  // that know nothing about it. Those must still answer with the PDF, which
  // is what makes the client's blob fallback safe.
  console.log('\n[fallback] an endpoint that ignores the parameter still sends a PDF');
  const xlsx = await get(`/api/lorry-reports/${RPT}/${A}?format=xlsx&previewlink=1`);
  check('a non-PDF format ignores it and returns the spreadsheet',
    xlsx.s === 200 && /spreadsheet/.test(xlsx.type), xlsx.type);

  // ── [content-type] the trap this nearly shipped with ─────────────────
  // Express's res.json() does NOT override a Content-Type the route already
  // set. One route set 'application/pdf' before handing over, so the link
  // JSON went out labelled as a PDF — and the client, which decides between
  // "link" and "raw bytes" by looking at that header, would have tried to
  // render the JSON. The link path must always declare itself as JSON.
  console.log('\n[content-type] a preview link always announces itself as JSON');
  const ctLink = await fetch(B + base + '&previewlink=1', { headers: { Authorization: 'Bearer ' + T } });
  check('the lorry report link is application/json',
    (ctLink.headers.get('content-type') || '').includes('application/json'),
    ctLink.headers.get('content-type'));

  // The pre-invoice is the route that had the stray header.
  const piBody_ = JSON.stringify({ saleType: 'L', buyerCode: 'AK', lotNos: [] });
  const piHdr = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T };
  const piDirect = await fetch(B + `/api/invoices/preview-pdf/${A}`,
    { method: 'POST', headers: piHdr, body: piBody_ });
  const piLink = await fetch(B + `/api/invoices/preview-pdf/${A}?previewlink=1`,
    { method: 'POST', headers: piHdr, body: piBody_ });
  // Whatever it answers (a real PDF or a 4xx for an unknown buyer), it must
  // never answer JSON under a PDF content type.
  const piCt = piLink.headers.get('content-type') || '';
  const piBody = Buffer.from(await piLink.arrayBuffer());
  const looksJson = piBody.slice(0, 1).toString() === '{';
  check('the pre-invoice never labels JSON as a PDF',
    !(looksJson && piCt.includes('application/pdf')),
    { ct: piCt, head: piBody.slice(0, 40).toString() });
  // Guard against the whole section going vacuous again: the pre-invoice
  // MUST actually have rendered, or these checks prove nothing.
  check('the pre-invoice fixture really renders (not a 404 passing vacuously)',
    piDirect.status === 200 && piLink.status === 200,
    { direct: piDirect.status, link: piLink.status,
      head: piBody.slice(0, 80).toString() });
  check('…and the link answer is a /p/ url, not the PDF bytes',
    looksJson && /\/p\/[0-9a-f]{32}\//.test(piBody.toString('utf8')),
    piBody.slice(0, 80).toString());

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nCRASHED:', e && e.stack || e);
  console.error('\n--- server log ---\n' + srvLog.slice(-2500));
  cleanup();
  process.exit(1);
});
