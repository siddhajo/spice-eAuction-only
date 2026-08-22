// Lot-wise Payments search — the Lots box accepts ranges mixed with single
// lots, e.g. "010-020, 021,022". Ranges expand for matching; gaps inside a
// range are NOT reported as missing (only individually-typed lots are).
// End-to-end HTTP test on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-range-'));
const PORT = 47341;
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
const lotsOf = (d) => (d && d.lots) || [];
const lotNos = (d) => lotsOf(d).map(l => String(l.lot_no)).sort((a, b) => Number(a) - Number(b));

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', b => log += b); srv.stderr.on('data', b => log += b);
const done = (c) => { try { srv.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(c); };

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, log.slice(-2000)); done(1); }

  const auc = await api('POST', '/api/auctions', { ano: '9', date: '2026-08-10', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // Lots stored with LEADING ZEROS: 010..014, 020, 021, 022 (lot 015 is a gap
  // inside the 10-20 range on purpose). All payable.
  const stored = ['010', '011', '012', '013', '014', '020', '021', '022'];
  for (const lot_no of stored) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'RAMU', qty: 100 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`, { price: 100, amount: 10000, balance: 9800 });
  }

  console.log('[1] A single range "010-020" expands and matches leading-zero lots');
  let s = await api('GET', `/api/payments/lots/${aid}?link=all&lots=${encodeURIComponent('010-020')}`);
  check('matches 010..014 and 020 (6 lots), not 021/022',
        JSON.stringify(lotNos(s.d)) === JSON.stringify(['010', '011', '012', '013', '014', '020']),
        JSON.stringify(lotNos(s.d)));
  check('gap lot 015 (never existed) is NOT reported missing for a range',
        (s.d.missing || []).length === 0, JSON.stringify(s.d.missing));

  console.log('\n[2] Range mixed with single lots: "010-012, 021,022"');
  s = await api('GET', `/api/payments/lots/${aid}?link=all&lots=${encodeURIComponent('010-012, 021,022')}`);
  check('matches 010,011,012,021,022 (5 lots)',
        JSON.stringify(lotNos(s.d)) === JSON.stringify(['010', '011', '012', '021', '022']),
        JSON.stringify(lotNos(s.d)));

  console.log('\n[3] A reversed range "022-020" is normalised');
  s = await api('GET', `/api/payments/lots/${aid}?link=all&lots=${encodeURIComponent('022-020')}`);
  check('022-020 → 020,021,022', JSON.stringify(lotNos(s.d)) === JSON.stringify(['020', '021', '022']),
        JSON.stringify(lotNos(s.d)));

  console.log('\n[4] An individually-typed lot that does not exist IS still reported missing');
  s = await api('GET', `/api/payments/lots/${aid}?link=all&lots=${encodeURIComponent('021, 999')}`);
  check('lot 021 matched', lotNos(s.d).includes('021'));
  check('lot 999 reported missing (typed explicitly, not part of a range)',
        (s.d.missing || []).some(m => String(m.lot) === '999' && m.reason === 'missing'),
        JSON.stringify(s.d.missing));

  console.log('\n[5] Numeric range still finds leading-zero storage (14 finds "014")');
  s = await api('GET', `/api/payments/lots/${aid}?link=all&lots=${encodeURIComponent('13-14')}`);
  check('13-14 → 013,014', JSON.stringify(lotNos(s.d)) === JSON.stringify(['013', '014']),
        JSON.stringify(lotNos(s.d)));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(log.slice(-2500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2500)); done(1); });
