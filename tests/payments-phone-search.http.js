// Payments → seller search by phone number.
//
// The rollup's phone came only from lots.tel, a snapshot taken when the lot was
// BOOKED. A seller whose number was added or corrected on their master record
// afterwards — or whose lots were imported without one — was unfindable by
// phone even though the office had the number on file. The rollup now carries
// every number the seller can be reached on in `tel_search`.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-phone-'));
const PORT = 47365;
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

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const done = c => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(c);
};

// The exact filter the Payments tab applies in the browser (sellerMatches).
function sellerMatches(term, name, tel) {
  const t = String(term == null ? '' : term).trim().toLowerCase();
  if (!t) return true;
  if (String(name || '').toLowerCase().includes(t)) return true;
  const d = t.replace(/\D+/g, '');
  const needle = d.length >= 4 ? d.slice(-10) : '';
  return !!needle && String(tel || '').replace(/\D+/g, '').includes(needle);
}

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  const auc = await api('POST', '/api/auctions', { ano: '31', date: '2026-08-20', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // Three sellers, three ways of holding a phone number:
  //  A — number on the master BEFORE the lot was booked (snapshot has it too)
  //  B — number added to the master after the lot was INVOICED. trader-lot-sync
  //      deliberately freezes invoiced lots (a reprint must keep the details it
  //      was raised with), so this seller's snapshot stays blank for good —
  //      and Payments is exactly where you look for a seller you owe money to.
  //  C — no phone at all, only a WhatsApp number on the master
  const mk = async (name, tel) => {
    const r = await api('POST', '/api/traders', { name, tel: tel || '' });
    return (r.d && (r.d.id || (r.d.trader && r.d.trader.id))) || null;
  };
  const idA = await mk('ANBU SELVAM', '9876500001');
  const idB = await mk('BASKARAN S', '');
  const idC = await mk('CHELLAM R', '');

  await api('POST', '/api/buyers', { buyer: 'BK', buyer1: 'SELVAM & CO' });
  let lot = 0;
  const book = async (traderId, name, buyer) => {
    lot++;
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no: String(lot), trader_id: traderId, name, qty: 100, grade: '1', bags: 4 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`, { price: 1000, amount: 100000, bags: 4, buyer: buyer || '', buyer1: buyer || '' });
    return id;
  };
  await book(idA, 'ANBU SELVAM');
  await book(idB, 'BASKARAN S', 'BK');
  await book(idC, 'CHELLAM R');

  // B's lot is invoiced — from here on trader-lot-sync will not touch it.
  const gen = await api('POST', `/api/invoices/generate/${aid}`,
    { sellerName: 'BK', buyerCode: 'BK', invoiceNo: '900', saleType: 'L' });
  check('B\'s lot is invoiced (so its seller snapshot is now frozen)', gen.status === 200, JSON.stringify(gen.d));

  // …and only now do the numbers reach the masters for B and C.
  await api('PUT', `/api/traders/${idB}`, { name: 'BASKARAN S', tel: '9876500002' });
  await api('PUT', `/api/traders/${idC}`, { name: 'CHELLAM R', tel: '', whatsapp: '9876500003' });

  const pay = await api('GET', `/api/payments/${aid}`);
  const rows = (pay.d && (pay.d.sellers || pay.d.rows || pay.d)) || [];
  const of = n => rows.find(r => String(r.name).toUpperCase() === n);
  check('payments returns all three sellers', rows.length === 3, JSON.stringify(rows.map(r => r.name)));

  const A = of('ANBU SELVAM'), Bm = of('BASKARAN S'), C = of('CHELLAM R');
  const hay = r => (r && (r.tel_search || r.tel)) || '';

  console.log('[A] Phone stamped on the lot (worked before, must keep working)');
  check('found by full number', sellerMatches('9876500001', A.name, hay(A)));
  check('found by the last digits', sellerMatches('500001', A.name, hay(A)));
  check('found when typed with punctuation', sellerMatches('+91 98765 00001', A.name, hay(A)));

  console.log('\n[B] Phone added to the master AFTER the lot was booked');
  // Prove the premise: the lot itself carries no number, so this seller was
  // genuinely unfindable by phone before the master fallback went in.
  const lotsB = await api('GET', `/api/lots/${aid}`);
  const lotRows = (Array.isArray(lotsB.d) ? lotsB.d : (lotsB.d && (lotsB.d.rows || lotsB.d.lots))) || [];
  const bLot = lotRows.find(l => String(l.name).toUpperCase() === 'BASKARAN S');
  check('the lot snapshot really is blank for this seller',
        !!bLot && String(bLot.tel || '').trim() === '', bLot && `lot tel="${bLot.tel}"`);
  check('found by their master phone number', sellerMatches('9876500002', Bm.name, hay(Bm)),
        `tel=${Bm.tel} tel_search=${Bm.tel_search}`);
  check('the displayed phone falls back to the master too',
        String(Bm.tel || '').replace(/\D+/g, '') === '9876500002', String(Bm.tel));

  console.log('\n[C] Only a WhatsApp number on file');
  check('found by their WhatsApp number', sellerMatches('9876500003', C.name, hay(C)),
        `tel=${C.tel} tel_search=${C.tel_search}`);

  console.log('\n[D] The search still discriminates');
  check('a number nobody has matches nobody',
        rows.every(r => !sellerMatches('9999999999', r.name, hay(r))));
  check('one seller\'s number does not match another',
        rows.filter(r => sellerMatches('9876500002', r.name, hay(r))).length === 1,
        JSON.stringify(rows.filter(r => sellerMatches('9876500002', r.name, hay(r))).map(r => r.name)));
  check('searching by name still works', sellerMatches('chellam', C.name, hay(C)));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(srvLog.slice(-1500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
