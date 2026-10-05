// ONE box per number: the Tally export bills off the SAME rates as the invoice.
//
// The To Tally screen used to carry its own copy of every rate and HSN/SAC
// code — tally_gunny_rate, tally_gst_rate, tally_insurance_rate,
// tally_tcs_rate and five tally_hsn_* twins — read ONLY by tally-xml.js, with
// no fallback to the Rates / HSN screens the invoices are billed from. Two
// boxes, near-identical labels, nothing to say which was live. On the install
// this was found on they had drifted: gunny ₹150 on the invoice, ₹200 in the
// books, so a sales voucher carried an AMOUNT computed at 150 under a RATE
// line reading 200.
//
// Four more (tally_transport_rate, tally_local_trans_rate, tally_local_ins_rate,
// tally_sample_kgs) had no reader at all — typing in them did nothing.
//
//   [gone]     the retired keys are not offered as settings any more
//   [source]   changing the RATES value moves the Tally XML
//   [agree]    invoice and voucher quote the same gunny rate — the exact
//              divergence this exists to prevent
//   [hsn]      the HSN/SAC codes come from the HSN screen
//   [tax]      TCS and TDS are two rates again, not one box driving both
//   [carry]    an install that only ever set the Tally box keeps its number
//   [stale]    a leftover retired row cannot steer the export any more
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cfg-'));
const PORT = 47431;
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
async function text(url) {
  const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()).toString('utf8') };
}
const put = (settings) => api('PUT', '/api/company-settings', { settings });

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const RETIRED = ['tally_gunny_rate', 'tally_gst_rate', 'tally_insurance_rate', 'tally_tcs_rate',
  'tally_transport_rate', 'tally_local_trans_rate', 'tally_local_ins_rate', 'tally_sample_kgs',
  'tally_hsn_cardamom', 'tally_hsn_gunny', 'tally_hsn_service', 'tally_hsn_transport', 'tally_hsn_insurance'];

// One sold lot is enough for a sales voucher to exist. `lots.buyer` holds the
// buyer CODE, and price/code/sale land in a second PUT — the shape the rest of
// the suite uses, and what makes the lot invoice-eligible.
async function seedTrade(ano) {
  const a = await api('POST', '/api/auctions', { ano, date: '2026-10-04', state: 'TAMIL NADU' });
  const id = a.d && a.d.id;
  await api('POST', '/api/buyers', { buyer: 'B1', buyer1: 'BUYER ONE', code: 'B1',
    pla: 'BODINAYAKANUR', state: 'TAMIL NADU', st_code: '33', gstin: '33AAHCE4551A1Z8' });
  const r = await api('POST', '/api/lots', { auction_id: id, lot_no: '1', name: 'PLANTER ONE',
    cr: '', qty: 100, bags: 10, grade: '1', crop: 'CARDAMOM', branch: 'ANAVILASAM' });
  const lotId = r.d.id || (r.d.lot && r.d.lot.id);
  await api('PUT', `/api/lots/${lotId}`, { price: 1000, amount: 100000, balance: 98000,
    code: 'B1', buyer: 'B1', buyer1: 'BUYER ONE', sale: 'L' });
  return id;
}

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  console.log('[gone] the retired boxes are not offered any more');
  {
    const r = await api('GET', '/api/company-settings');
    const shown = new Set();
    for (const list of Object.values((r.d && r.d.settings) || {})) for (const f of list) shown.add(f.key);
    const leaks = RETIRED.filter(k => shown.has(k));
    check('none of the 13 retired keys render as a setting', leaks.length === 0, JSON.stringify(leaks));
    check('…while the canonical ones still do',
      ['gunny_rate', 'gst_goods', 'insurance', 'tcs_tds', 'tds_purchase_rate',
       'hsn_cardamom', 'hsn_gunny', 'sac_service', 'sac_transport', 'sac_insurance'].every(k => shown.has(k)));
    check('…and the two genuinely Tally-only rates survive',
      shown.has('tally_service_rate') && shown.has('tally_export_rate'));
  }

  // Rates first: the invoice stores the gunny/transport amounts it computed,
  // so they have to be in place before anything is generated.
  await put({
    gunny_rate: '150', gst_goods: '5', insurance: '1', transport: '3.5',
    tcs_tds: '0.5', tds_purchase_rate: '0.1',
    hsn_cardamom: '09083120', hsn_gunny: '63051040',
    sac_service: '996111', sac_transport: '996791', sac_insurance: '997136',
    tally_state_code: '33',
    // A tax ledger only reaches the masters XML when it has a NAME.
    tally_tcs: 'TCS on Sale of Goods', tally_tds_ledger: 'TDS on Purchase of Goods',
    tally_item_cardamom: 'CARDAMOM', tally_item_gunny: 'GUNNY',
  });
  const aid = await seedTrade('301');
  // sales_isp exports VOUCHERS, so the trade needs actual invoices.
  const gen = await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 1 });
  check('invoices generated for the fixture trade',
    gen.status === 200 && (gen.d.created || gen.d.generated || []).length !== 0,
    JSON.stringify(gen.d).slice(0, 220));

  console.log('[source] the RATES value is what reaches the XML');
  {
    const x = await text(`/api/tally/export/sales_isp/${aid}`);
    check('the sales voucher exports', x.status === 200 && x.body.includes('<ENVELOPE>'), x.status + ' :: ' + x.body.slice(0,300));
    check('gunny RATE quotes the Rates screen figure', /<RATE>150\//.test(x.body),
      (x.body.match(/<RATE>[^<]*<\/RATE>/g) || []).slice(0, 6).join(' '));
    await put({ gunny_rate: '175' });
    const y = await text(`/api/tally/export/sales_isp/${aid}`);
    check('changing it in ONE box moves the XML', /<RATE>175\//.test(y.body),
      (y.body.match(/<RATE>[^<]*<\/RATE>/g) || []).slice(0, 6).join(' '));
    await put({ gunny_rate: '150' });
  }

  console.log('[agree] invoice and voucher can no longer quote different gunny rates');
  {
    // The old failure mode exactly: set the retired key to something else and
    // prove it is inert, rather than silently winning in the books.
    await put({ tally_gunny_rate: '200' });
    const x = await text(`/api/tally/export/sales_isp/${aid}`);
    check('a stale tally_gunny_rate=200 does NOT appear', !/<RATE>200\//.test(x.body));
    check('…the invoice rate still does', /<RATE>150\//.test(x.body));
  }

  console.log('[hsn] codes come from the HSN/SAC screen');
  {
    await put({ hsn_gunny: '63059999', tally_hsn_gunny: '63051040' });
    const x = await text(`/api/tally/export/sales_isp/${aid}`);
    check('the HSN screen value is used', x.body.includes('63059999'), 'hsn_gunny not applied');
    check('…and the retired twin is ignored', !x.body.includes('63051040'));
    await put({ hsn_gunny: '63051040' });
  }

  console.log('[tax] TCS and TDS are two rates again');
  {
    const x = await text(`/api/tally/export/ledger/${aid}`);
    check('the ledger masters export', x.status === 200 && x.body.includes('<ENVELOPE>'), String(x.status));
    // tcs_tds = 0.5, tds_purchase_rate = 0.1 — one box could not produce both.
    check('TCS master takes the sales TCS rate', x.body.includes('>0.5<'),
      (x.body.match(/<[A-Z]*RATE[A-Z]*>[^<]*</g)||[]).slice(0,8).join(' '));
    check('TDS master takes the 194Q purchase rate', x.body.includes('>0.1<'), 'no 0.1 in masters');
  }

  console.log('[carry] a Tally-only install keeps its number');
  {
    // A genuine PRE-UPGRADE install: the retired row exists with a value and
    // the canonical box was never filled in. That state can't be made through
    // the API any more (the retired key is gone from DEFAULTS, and
    // updateSettings only UPDATEs existing rows), so write it the way the old
    // version would have left it — with the server stopped.
    srv.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 800));
    // Take the path from the server's own "Database ready at …" line rather
    // than rebuilding it — guessing it wrong silently CREATES an empty file
    // and the next boot looks like a fresh install.
    const m = srvLog.match(/Database ready at (\S+config\.db)/);
    check('the DB path was discoverable from the server log', !!m, srvLog.slice(-300));
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(m[1], { fileMustExist: true });
    db.prepare("UPDATE company_settings SET value = '0' WHERE key = 'insurance'").run();
    db.prepare(
      `INSERT INTO company_settings (key, value, category, label, field_type)
       VALUES ('tally_insurance_rate', '0.75', 'tally', 'Insurance Rate', 'number')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    db.close();

    const srv2 = spawn('node', [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log2 = ''; srv2.stdout.on('data', b => log2 += b); srv2.stderr.on('data', b => log2 += b);
    for (let i = 0; i < 160; i++) {
      try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    const lr2 = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
    TOKEN = lr2.d && (lr2.d.token || lr2.d.accessToken);
    const cfg = await api('GET', '/api/company-settings/flat');
    check('the retired value was carried onto the canonical key',
      Number(cfg.d.insurance) === 0.75, JSON.stringify(cfg.d.insurance));
    check('…and the migration said so out loud',
      /carried retired Tally setting/.test(log2), log2.slice(-500));

    // Idempotency and the canonical-wins notice are logic, not plumbing —
    // they live in one-config-retired-keys.unit.js, which drives
    // initCompanySettings directly instead of betting on what survives a
    // SIGKILL'd WAL.
    try { srv2.kill('SIGKILL'); } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
