// ARRIVALS REPORT — what each depot brought in.
//
// Reproduces the customer's reference sheet (RNS SPICES, auction 13) from a
// seeded trade and checks the arithmetic that sheet is read for. The depot
// manager counts sacks against these numbers, so the failure that matters is
// a total that disagrees with the floor.
//
// The one rule worth pinning above all: this counts EVERY BOOKED LOT, priced
// or not, sold or withdrawn. The reference totals 202 lots — that trade's full
// booked count, not its 187 sold. Every other per-auction report in
// spice-board-reports.js applies an `amount > 0` price gate; this one must not,
// or the sheet under-reports arrivals the moment a lot is withdrawn, and reads
// as empty before bidding (which is when it is actually used).
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arrivals-'));
const PORT = 47376;
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
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()),
           type: r.headers.get('content-type') || '' };
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

// Four depots, shaped like the reference: a big home depot and three smaller
// ones. Lot counts and bag/qty totals are chosen so every figure is checkable
// by hand.
//   depot          lots  bags   qty
//   NIRAPPELKADA     4     20   400.100
//   ANAVILASAM       2      7   150.200
//   MARYKULAM        1      5    83.300
//   KARITHODU        3     12   250.400
//   Total           10     44   884.000
const DEPOTS = [
  { branch: 'NIRAPPELKADA', lots: [[5, 100.000], [5, 100.050], [5, 100.050], [5, 100.000]] },
  { branch: 'ANAVILASAM',   lots: [[4, 100.100], [3,  50.100]] },
  { branch: 'MARYKULAM',    lots: [[5,  83.300]] },
  { branch: 'KARITHODU',    lots: [[4,  83.400], [4,  83.500], [4,  83.500]] },
];

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.log('login failed\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }

  const AID = (await api('POST', '/api/auctions', { ano: '13', date: '2026-08-08', crop_type: 'VST' })).d.id;
  let n = 0;
  const created = [];
  for (const d of DEPOTS) {
    for (const [bags, qty] of d.lots) {
      n++;
      const r = await api('POST', '/api/lots', {
        auction_id: AID, lot_no: String(n), branch: d.branch,
        name: 'SELLER ' + n, cr: 'CR.', bags, qty, grade: '1', crop: 'CARDAMOM',
      });
      if (r.status !== 200) { console.log(`lot ${n} failed: ${JSON.stringify(r.d)}`); cleanup(); process.exit(1); }
      created.push(r.d.lot.id);
    }
  }

  // ══ [json] the arithmetic ════════════════════════════════════════
  console.log('[json] per-depot totals');
  const j = await api('GET', `/api/spice-board-reports/arrivals/data?auctionId=${AID}`);
  const data = j.d && (j.d.sections ? j.d : (j.d.data || j.d));
  const rows = (data && data.sections && data.sections[0] && data.sections[0].rows) || [];
  check('the report answers with a row per depot', rows.length === 4,
        `HTTP ${j.status}, ${rows.length} rows :: ${JSON.stringify(j.d).slice(0, 200)}`);
  const byDepot = Object.fromEntries(rows.map(r => [r.depot, r]));
  const expect = {
    NIRAPPELKADA: [4, 20, 400.100],
    ANAVILASAM:   [2,  7, 150.200],
    MARYKULAM:    [1,  5,  83.300],
    KARITHODU:    [3, 12, 250.400],
  };
  for (const [depot, [lots, bags, qty]] of Object.entries(expect)) {
    const g = byDepot[depot];
    check(`${depot}: ${lots} lots · ${bags} bags · ${qty}`,
          !!g && g.lots === lots && g.bags === bags && Math.abs(g.qty - qty) < 0.0005,
          g ? `${g.lots}/${g.bags}/${g.qty}` : 'missing');
  }
  const grand = data && data.grand;
  check('grand total = 10 lots · 44 bags · 884.000',
        !!grand && grand.lots === 10 && grand.bags === 44 && Math.abs(grand.qty - 884) < 0.0005,
        JSON.stringify(grand));
  check('the depots sum to the grand total',
        rows.reduce((a, r) => a + r.lots, 0) === grand.lots
        && rows.reduce((a, r) => a + r.bags, 0) === grand.bags,
        `${rows.reduce((a, r) => a + r.lots, 0)} vs ${grand.lots}`);
  check('auction no and date are carried', data.auction && String(data.auction.ano) === '13',
        JSON.stringify(data.auction));

  // ══ [unpriced] the rule that separates this from every other report ══
  // Nothing above has a price yet — that alone proves the gate is off, since
  // a priced-only report would have returned nothing at all.
  console.log('\n[scope] arrivals counts what ARRIVED, not what sold');
  check('an all-unpriced trade still reports every lot', grand.lots === 10, JSON.stringify(grand));

  // Now sell some and withdraw one. Arrivals must not move: the sacks are
  // still on the floor either way.
  await api('PUT', `/api/lots/${created[0]}`, { price: 3756, amount: 3756 * 100, code: 'B1', buyer: 'X', buyer1: 'X' });
  await api('PUT', `/api/lots/${created[1]}`, { price: 0, amount: 0, code: 'WD' });
  await api('PUT', `/api/lots/${created[2]}`, { price: 0, amount: 0, code: 'NA' });
  const j2 = await api('GET', `/api/spice-board-reports/arrivals/data?auctionId=${AID}`);
  const g2 = j2.d && j2.d.grand;
  check('pricing, withdrawing and NA-ing lots leaves arrivals unchanged',
        !!g2 && g2.lots === 10 && g2.bags === 44 && Math.abs(g2.qty - 884) < 0.0005,
        JSON.stringify(g2));

  // A lot with no depot is shown, not dropped — the total has to reconcile.
  const orphan = await api('POST', '/api/lots', {
    auction_id: AID, lot_no: '999', name: 'NO DEPOT', cr: 'CR.', bags: 2, qty: 10, grade: '1' });
  if (orphan.status === 200) {
    const j3 = await api('GET', `/api/spice-board-reports/arrivals/data?auctionId=${AID}`);
    const rows3 = j3.d.sections[0].rows;
    check('a lot with no depot gets its own row rather than vanishing',
          rows3.length === 5 && rows3.some(r => /no depot/i.test(r.depot)),
          rows3.map(r => r.depot).join(', '));
    check('…and the grand total still reconciles', j3.d.grand.lots === 11, JSON.stringify(j3.d.grand));
  } else { check('create a depot-less lot', false, JSON.stringify(orphan.d)); }

  // ══ [files] PDF and XLSX ═════════════════════════════════════════
  console.log('\n[files] the tile downloads');
  const pdf = await raw(`/api/spice-board-reports/arrivals/export?format=pdf&auctionId=${AID}`);
  check('PDF downloads', pdf.status === 200, `HTTP ${pdf.status} ${pdf.buf.slice(0, 120).toString()}`);
  check('…and is a real PDF', pdf.buf.slice(0, 4).toString() === '%PDF',
        pdf.buf.slice(0, 8).toString('hex'));
  check('…served as application/pdf', /application\/pdf/.test(pdf.type), pdf.type);
  check('…with more than an empty page', pdf.buf.length > 1200, `${pdf.buf.length} bytes`);

  const xlsx = await raw(`/api/spice-board-reports/arrivals/export?format=xlsx&auctionId=${AID}`);
  check('XLSX downloads too', xlsx.status === 200, `HTTP ${xlsx.status}`);
  check('…and is a real workbook', xlsx.buf[0] === 0x50 && xlsx.buf[1] === 0x4B,
        xlsx.buf.slice(0, 4).toString('hex'));

  // The tile the Auction Downloads screen actually renders.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('the Arrivals Report tile is wired, not a placeholder',
        /label: 'Arrivals Report',\s*href:/.test(html),
        (html.match(/label: 'Arrivals Report'[^\n]*/) || ['not found'])[0]);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-3000)); cleanup(); process.exit(1); });
