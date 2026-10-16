// Export filenames carry the AUCTION NUMBER — proved where id ≠ ano.
//
// Everything about this was invisible in the live data, because every auction
// there happens to have id == ano: a filename built from the internal row id
// looked exactly like one built from the trade number. It stops looking right
// the moment the two diverge — an auction is deleted (ids are AUTOINCREMENT
// and never reused), or an ano is not a plain number (`ano` is TEXT).
//
// So this test seeds a trade whose id and ano CANNOT be confused: three
// auctions are created and only the third is used, and its ano is the string
// "77/A" — which also exercises the sanitiser, since a "/" in a filename would
// change which directory the download lands in.
//
// A reading of these assertions that passes while the code is wrong is worth
// guarding against: each one checks the ano is present AND that the bare id is
// not, because "_3" appearing nowhere is the actual requirement.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'expfn-'));
const PORT = 47419;
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
// The filename off the Content-Disposition, or '' when the route sent none.
async function nameOf(url, opts) {
  const r = await fetch(B + url, Object.assign({
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  }, opts || {}));
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return { status: r.status, name: m ? m[1].trim() : '', cd };
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
  if (!TOKEN) { console.log('login failed\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }

  // Two throwaway trades first, so the one under test cannot have id 1.
  await api('POST', '/api/auctions', { ano: '1', date: '2026-08-01', state: 'TAMIL NADU' });
  await api('POST', '/api/auctions', { ano: '2', date: '2026-08-02', state: 'TAMIL NADU' });
  const ANO = '77/A';
  const made = await api('POST', '/api/auctions', { ano: ANO, date: '2026-08-19', state: 'TAMIL NADU' });
  const AID = made.d && made.d.id;
  check('seeded a trade whose id and ano differ', !!AID && String(AID) !== '77',
        `id=${AID} ano=${ANO} :: ${JSON.stringify(made.d).slice(0, 160)}`);
  // "/" is not legal in a filename — it must arrive sanitised, not raw.
  const ANO_SAFE = '77-A';

  const lot = await api('POST', '/api/lots', {
    auction_id: AID, lot_no: '201', branch: 'NIRAPPELKADA',
    name: 'RAMU PLANTER', cr: 'CR.', bags: 5, qty: 100.5, grade: '1', crop: 'CARDAMOM',
  });
  check('seeded a lot', lot.status === 200, JSON.stringify(lot.d).slice(0, 200));
  const LOTID = lot.d && lot.d.lot && lot.d.lot.id;

  // ── A report that is scoped to the trade ──────────────────────────────
  console.log('\n[reports] the trade number, never the row id');
  const says = (name, what) => name.includes(what);
  const notId = (name) => !new RegExp(`(^|[_-])${AID}([_.]|$)`).test(name);

  for (const [label, url] of [
    ['Form C',        `/api/spice-board-reports/form_c/export?format=xlsx&auctionId=${AID}`],
    ['Form D',        `/api/spice-board-reports/form_d/export?format=xlsx&auctionId=${AID}`],
    ['Sales journal', `/api/exports/sales-journal?auctionId=${AID}`],
    ['Sales register',`/api/exports/sales-register?auctionId=${AID}`],
  ]) {
    const r = await nameOf(url);
    check(`${label} names the trade (${ANO_SAFE})`,
      r.status === 200 && says(r.name, ANO_SAFE), `HTTP ${r.status} → ${r.name || r.cd}`);
    check(`${label} does not name the row id (${AID})`, notId(r.name), r.name);
  }

  // ── A per-document PDF: the collision case ────────────────────────────
  // A sales invoice number is unique only WITHIN a trade — 35 (sale, invo)
  // pairs repeat across trades in the live data — so the trade has to be in
  // the name or two different invoices download over each other.
  console.log('\n[documents] a document number alone is not a name');
  const lotPrice = await api('PUT', `/api/lots/${LOTID}`, { price: 2000, buyer: 'B1' });
  check('priced the lot', lotPrice.status === 200, JSON.stringify(lotPrice.d).slice(0, 200));

  const rc = await nameOf(`/api/receipt/${LOTID}`);
  check('crop receipt names the trade and the lot',
    rc.status === 200 && says(rc.name, ANO_SAFE) && says(rc.name, '201'),
    `HTTP ${rc.status} → ${rc.name || rc.cd}`);

  // ── Not trade-scoped: the date range instead of a wrong ano ───────────
  console.log('\n[date-range] reports with no trade carry their range');
  const tds = await nameOf('/api/exports/tds-return?from=2026-08-01&to=2026-08-31');
  check('TDS return names its date range',
    tds.status === 200 && says(tds.name, '2026-08-01') && says(tds.name, '2026-08-31'),
    `HTTP ${tds.status} → ${tds.name || tds.cd}`);

  // A register asked for by range must NOT claim a trade it was not scoped to.
  const regRange = await nameOf('/api/exports/sales-register?from=2026-08-01&to=2026-08-31');
  check('a range-scoped register names the range, not a trade',
    regRange.status === 200 && says(regRange.name, '2026-08-01') && !says(regRange.name, ANO_SAFE),
    `HTTP ${regRange.status} → ${regRange.name || regRange.cd}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
