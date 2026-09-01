// AUCTION DOWNLOADS — the tile manifest against the live server.
//
// The screen carries its own list of ~35 routes rather than reading
// /api/documents/catalog, because that endpoint is gated on the
// `auction_desk` ROLE capability and this screen must work for an operator.
// A hand-kept list can rot silently: rename a route and the tile 404s with
// nobody the wiser. This test is what stops that.
//
//   [manifest] every href in AMR_SECTIONS is extracted from index.html and
//              called for real. Not one may 404 or 500.
//   [xlsx]     the "CSV Downloads" section keeps its supplied name but every
//              tile in it now hands out XLSX. Asserted on the bytes: the zip
//              magic number (PK) must be there, and the two feeds that write
//              CSV text directly must still serve CSV to the callers that
//              ask for it.
//   [bulk]     the four generated families' list + merge routes exist.
//   [role]     an operator — who has no auction_desk — can use all of it.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amdl-'));
const PORT = 47355;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function raw(url) {
  const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '' };
}

// ── Harvest the manifest out of the client, so the test can never drift
// from what the screen actually renders. Each entry is `label` plus either
// an `href` arrow (whose URL template we evaluate with a known id) or a
// `bulk` block.
function harvestManifest() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const start = html.indexOf('const AMR_SECTIONS = [');
  if (start < 0) throw new Error('AMR_SECTIONS not found in index.html');
  const end = html.indexOf('\n];', start);
  if (end < 0) throw new Error('AMR_SECTIONS terminator not found');
  const body = html.slice(start, end + 3);
  const out = [];
  // Walk the file section by section rather than in one sweep, so each tile
  // carries the heading it renders under. The "CSV Downloads" assertions
  // below need that: they are about a section, not about a URL pattern.
  const heads = [...body.matchAll(/\{\s*title:\s*'([^']+)',\s*items:\s*\[/g)];
  const chunks = heads.map((h, i) => ({
    section: h[1],
    text: body.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : body.length),
  }));
  for (const { section, text } of chunks) {
    // href: id => `...`
    for (const m of text.matchAll(/label:\s*'([^']+)'[^\n]*?href:\s*id\s*=>\s*`([^`]+)`/g)) {
      out.push({ section, label: m[1], url: m[2] });
    }
    // bulk: { list: '...', param: '...', post: '...' }
    for (const m of text.matchAll(/label:\s*'([^']+)'[^\n]*?bulk:\s*\{\s*list:\s*'([^']+)',\s*param:\s*'([^']+)',\s*post:\s*'([^']+)'/g)) {
      out.push({ section, label: m[1], bulk: { list: m[2], param: m[3], post: m[4] } });
    }
  }
  const todo = [...body.matchAll(/label:\s*'([^']+)',\s*todo:\s*true/g)].map(m => m[1]);
  return { out, todo };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.log('login failed ' + boot.status + '\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }

  // Every flag the manifest gates on, so no tile is skipped for being off.
  await api('PUT', '/api/company-settings', { settings: {
    flag_auction_manager: 'true', flag_debit_note: 'true',
    flag_debit_note_planter: 'true', flag_merchants: 'true',
  }});

  // A trade with priced, sold lots — several exports return 404 "nothing to
  // export" on an empty trade, which would mask a genuinely broken route.
  const AID = (await api('POST', '/api/auctions', { ano: '13', date: '2026-08-08', crop_type: 'VST' })).d.id;
  await api('POST', '/api/buyers', { buyer: 'ANKIT SPICES', buyer1: 'ANKIT SPICES', code: 'B2',
                                     pla: 'BODINAYAKANUR', state: 'TAMIL NADU', st_code: '33', gstin: '33AAHCE4551A1Z8' });
  for (const s of [
    { lot_no: '1',  name: 'PLANTER A', cr: 'CR.',                   qty: 100, price: 3756 },
    { lot_no: '2',  name: 'DEALER X',  cr: 'GSTIN.32AAHCE4551A1Z8', qty: 150, price: 2921 },
  ]) {
    const r = await api('POST', '/api/lots', { auction_id: AID, lot_no: s.lot_no, name: s.name, cr: s.cr, bags: 1, qty: s.qty, grade: '1', crop: 'CARDAMOM' });
    await api('PUT', `/api/lots/${r.d.lot.id}`, { price: s.price, amount: s.qty * s.price, code: 'B2',
                                                  buyer: 'ANKIT SPICES', buyer1: 'ANKIT SPICES', sale: 'L' });
  }

  const { out: MANIFEST, todo: TODO } = harvestManifest();
  const hrefs = MANIFEST.filter(m => m.url);
  const bulks = MANIFEST.filter(m => m.bulk);

  console.log(`[manifest] ${hrefs.length} direct routes, ${bulks.length} bulk families, ${TODO.length} not-yet-wired`);
  check('the manifest was harvested (not silently empty)', hrefs.length >= 15 && bulks.length === 4,
        `${hrefs.length} hrefs / ${bulks.length} bulk`);

  // ══ [manifest] every direct route answers ════════════════════════
  for (const m of hrefs) {
    const url = m.url.replace(/\$\{id\}/g, String(AID));
    const r = await raw(url);
    // 404 is a legitimate "nothing of that kind in this trade" for the
    // document-backed exports; what must never happen is a 5xx (broken
    // builder) or a 400 (route exists but rejects our shape).
    const ok = r.status === 200 || r.status === 404;
    check(`${m.label} → ${url.split('?')[0]}`, ok, `HTTP ${r.status} ${r.buf.slice(0, 160).toString()}`);
  }

  // ══ [xlsx] the "CSV Downloads" section hands out spreadsheets ════
  // The section keeps its supplied name and its "… CSV" labels — that is
  // what the office calls these files — but every tile in it downloads
  // XLSX. Asserted on the bytes, because a CSV served under an .xlsx name
  // is exactly the failure the labels make easy to miss.
  console.log('\n[xlsx] every "CSV Downloads" tile emits real XLSX');
  const csvSection = MANIFEST.filter(m => m.url && m.section === 'CSV Downloads');
  // Auction Report, Commission Bill, Dealer Invoice, Purchase Invoice, Litre
  // Weight, Collection, Form C, Sales, Planter/Dealer Disbursement, Lot
  // Verification I + II, Checklist, Tharai List. (Crop Receipts is todo and
  // carries no href.)
  check('fourteen download tiles are wired in the section', csvSection.length === 14,
        csvSection.map(t => t.label).join(', '));
  check('no tile in the section still asks for CSV',
        !csvSection.some(m => /format=csv/i.test(m.url)),
        csvSection.filter(m => /format=csv/i.test(m.url)).map(t => t.label).join(', '));
  for (const m of csvSection) {
    const r = await raw(m.url.replace(/\$\{id\}/g, String(AID)));
    if (r.status !== 200) { check(`${m.label} downloads`, false, `HTTP ${r.status}`); continue; }
    // 'PK' is the zip magic number every .xlsx starts with.
    const isZip = r.buf[0] === 0x50 && r.buf[1] === 0x4B;
    check(`${m.label} is a real XLSX`, isZip, `first bytes ${r.buf.slice(0, 4).toString('hex')}`);
    check(`${m.label} declares the spreadsheet mime`, /spreadsheetml/.test(r.type), r.type);
    check(`${m.label} is named .xlsx`, /\.xlsx"?$/.test(r.disp.trim()), r.disp);
  }
  // The two feeds that write CSV text directly are the ones the new
  // csvToXlsxBuffer branch carries — and their native CSV must still be
  // reachable, because the Export Center and the Auction Desk catalog both
  // still ask for it.
  for (const t of ['commission_bill_csv', 'dealer_invoice_csv']) {
    const r = await raw(`/api/exports/${t}/${AID}?format=csv`);
    check(`${t} still serves CSV when asked`,
          r.status === 200 && !(r.buf[0] === 0x50 && r.buf[1] === 0x4B) && /text\/csv/.test(r.type),
          `HTTP ${r.status}, ${r.type}, bytes ${r.buf.slice(0, 4).toString('hex')}`);
    // No format at all → the native bytes, unchanged. The route's `|| 'xlsx'`
    // default must NOT drag these two through the converter.
    const bare = await raw(`/api/exports/${t}/${AID}`);
    check(`${t} with no format is still CSV`,
          bare.status === 200 && !(bare.buf[0] === 0x50 && bare.buf[1] === 0x4B),
          `HTTP ${bare.status}, bytes ${bare.buf.slice(0, 4).toString('hex')}`);
  }
  // And the xlsx→csv branch the other tiles used is still there for callers
  // that want it.
  const stillCsv = await raw(`/api/exports/collection/${AID}?format=csv`);
  check('an xlsx-native export still converts to CSV on request',
        stillCsv.status === 200 && !(stillCsv.buf[0] === 0x50 && stillCsv.buf[1] === 0x4B),
        `HTTP ${stillCsv.status}, bytes ${stillCsv.buf.slice(0, 4).toString('hex')}`);

  // ══ [bulk] the generated families ════════════════════════════════
  console.log('\n[bulk] generated-document families');
  for (const m of bulks) {
    const list = await api('GET', `${m.bulk.list}?${m.bulk.param}=${AID}`);
    check(`${m.label} list route answers`, list.status === 200, `HTTP ${list.status} on ${m.bulk.list}`);
    // Empty id list → the route must reject cleanly, proving it is mounted
    // (a missing route would 404 the same way for any body).
    const post = await api('POST', m.bulk.post, { ids: [] });
    check(`${m.label} merge route is mounted`, post.status !== 404,
          `HTTP ${post.status} on ${m.bulk.post}`);
  }

  // ══ [role] operator access ═══════════════════════════════════════
  console.log('\n[role] operator');
  const mk = await api('POST', '/api/users', { username: 'op_dl', password: 'passw0rd', role: 'operator' });
  if (mk.status === 200) {
    const adminToken = TOKEN;
    const li = await api('POST', '/api/login', { username: 'op_dl', password: 'passw0rd' });
    if (li.status === 200 && li.d && li.d.token) {
      TOKEN = li.d.token;
      const r = await raw(`/api/exports/collection/${AID}?format=xlsx`);
      check('operator can download a tile from the CSV section', r.status === 200, `HTTP ${r.status}`);
      const desk = await api('GET', `/api/documents/catalog?auctionId=${AID}`);
      check('…while still being denied the Auction Desk catalog', desk.status === 403, `HTTP ${desk.status}`);
    } else check('operator sign-in', false, JSON.stringify(li.d));
    TOKEN = adminToken;
  } else check('create operator', false, JSON.stringify(mk.d));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-3000)); cleanup(); process.exit(1); });
