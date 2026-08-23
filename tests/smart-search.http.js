// Smart list search — every list screen's search box also accepts a PHONE
// NUMBER (any punctuation, digits-only comparison) and a LOT-NUMBER SPEC
// ("12", "12,15", "10-20"). Both are OR-ed onto the endpoint's existing LIKE,
// so plain keyword search must keep behaving exactly as before.
// End-to-end HTTP test on a throwaway data dir.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-search-'));
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
const rowsOf = (d) => Array.isArray(d) ? d : ((d && d.rows) || []);

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

  // ── Fixtures ────────────────────────────────────────────────
  // Seller phone stored WITHOUT punctuation; the searches below type it WITH.
  await api('POST', '/api/traders', { name: 'RAMU', tel: '9876543210' });
  await api('POST', '/api/traders', { name: 'SOMU', tel: '9000000001' });
  await api('POST', '/api/buyers',  { buyer: 'JPB', buyer1: 'JP TRADERS', code: 'JP', tel: '9876500011' });

  const auc = await api('POST', '/api/auctions', { ano: '11', date: '2026-08-12', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // Lots stored with LEADING ZEROS so the canonical-number match is exercised.
  const stored = ['005', '010', '011', '012', '020'];
  for (const lot_no of stored) {
    await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'RAMU', qty: 100, tel: '9876543210' });
  }
  await api('POST', '/api/lots', { auction_id: aid, lot_no: '030', name: 'SOMU', qty: 50, tel: '9000000001' });

  const lotNos = (d) => rowsOf(d).map(l => String(l.lot_no)).sort();

  console.log('[1] /api/lots — lot spec: single, comma list, range, mixed');
  let s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('10')}`);
  check('"10" matches the lot stored as "010"',
        lotNos(s.d).includes('010'), JSON.stringify(lotNos(s.d)));

  s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('5,20')}`);
  check('"5,20" matches 005 + 020 only',
        JSON.stringify(lotNos(s.d)) === JSON.stringify(['005', '020']), JSON.stringify(lotNos(s.d)));

  s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('10-12')}`);
  check('range "10-12" matches 010,011,012',
        JSON.stringify(lotNos(s.d)) === JSON.stringify(['010', '011', '012']), JSON.stringify(lotNos(s.d)));

  s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('10-11, 30')}`);
  check('mixed "10-11, 30" matches 010,011,030',
        JSON.stringify(lotNos(s.d)) === JSON.stringify(['010', '011', '030']), JSON.stringify(lotNos(s.d)));

  console.log('[2] /api/lots — phone number typed with punctuation');
  s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('+91 98765 43210')}`);
  check('punctuated phone finds RAMU\'s 5 lots and not SOMU\'s',
        lotNos(s.d).length === 5 && !lotNos(s.d).includes('030'), JSON.stringify(lotNos(s.d)));

  console.log('[3] /api/lots — plain keyword search is unchanged');
  s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('SOMU')}`);
  check('seller name still matches by keyword',
        JSON.stringify(lotNos(s.d)) === JSON.stringify(['030']), JSON.stringify(lotNos(s.d)));
  s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('ZZZ-NOTHING')}`);
  check('a non-matching word returns nothing (not reinterpreted as a range)',
        lotNos(s.d).length === 0, JSON.stringify(lotNos(s.d)));

  console.log('[4] /api/lots — summary=1 counts the SAME filtered set');
  s = await api('GET', `/api/lots/${aid}?search=${encodeURIComponent('10-12')}&summary=1`);
  check('summary honours the lot spec (n = 3)', s.d && s.d.n === 3, JSON.stringify(s.d));

  console.log('[5] /api/traders + /api/buyers — punctuated phone');
  s = await api('GET', `/api/traders?page=1&pageSize=50&search=${encodeURIComponent('98765-43210')}`);
  check('seller found by punctuated phone',
        rowsOf(s.d).some(r => r.name === 'RAMU'), JSON.stringify(rowsOf(s.d).map(r => r.name)));
  s = await api('GET', `/api/buyers?page=1&pageSize=50&search=${encodeURIComponent('98765 00011')}`);
  check('buyer found by punctuated phone',
        rowsOf(s.d).some(r => r.buyer1 === 'JP TRADERS'), JSON.stringify(rowsOf(s.d).map(r => r.buyer1)));
  s = await api('GET', `/api/traders?page=1&pageSize=50&search=${encodeURIComponent('RAMU')}`);
  check('seller keyword search unchanged',
        rowsOf(s.d).some(r => r.name === 'RAMU'), JSON.stringify(rowsOf(s.d).map(r => r.name)));

  console.log('[6] Other list endpoints accept the new syntax without erroring');
  for (const url of ['/api/invoices', '/api/purchases', '/api/bills', '/api/debit-notes', '/api/debit-notes-planter']) {
    for (const q of ['10-12', '+91 98765 43210', 'RAMU']) {
      const r = await api('GET', `${url}?page=1&pageSize=50&search=${encodeURIComponent(q)}`);
      check(`${url} search="${q}" → 200`, r.status === 200, `status ${r.status} ${JSON.stringify(r.d)}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); done(1); });
