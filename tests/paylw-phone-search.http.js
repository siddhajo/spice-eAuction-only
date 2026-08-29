// Payments (lot-wise) → the seller box also takes a phone number.
//
// GET /api/payments/lots/:auctionId matched `seller` against l.name only, so an
// operator holding a phone number and no spelling had to go and look the name
// up first. It now matches the number too — against the lot's own copy AND the
// seller master, because lots.tel is a booking-time snapshot that
// trader-lot-sync refuses to refresh once the lot is invoiced.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-phone-'));
const PORT = 47367;
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

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  const auc = await api('POST', '/api/auctions', { ano: '55', date: '2026-08-22', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  await api('POST', '/api/buyers', { buyer: 'BK', buyer1: 'SELVAM & CO' });

  const mk = async (name, tel) => {
    const r = await api('POST', '/api/traders', { name, tel: tel || '' });
    return (r.d && (r.d.id || (r.d.trader && r.d.trader.id))) || null;
  };
  //  A — number on the master before booking (so the lot snapshot has it too)
  //  B — number reaches the master only AFTER the lot is invoiced (frozen copy)
  //  C — no phone, only WhatsApp on the master
  //  D — no number anywhere, to prove a phone search still excludes people
  const idA = await mk('ANBU SELVAM', '9790744444');
  const idB = await mk('BASKARAN S', '');
  const idC = await mk('CHELLAM R', '');
  const idD = await mk('DHANAM V', '');

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
  await book(idD, 'DHANAM V');

  // Freeze B's seller snapshot by invoicing their lot, THEN give the master a
  // number — trader-lot-sync will not push it down.
  const gen = await api('POST', `/api/invoices/generate/${aid}`,
    { sellerName: 'BK', buyerCode: 'BK', invoiceNo: '900', saleType: 'L' });
  check('B\'s lot is invoiced, so its seller snapshot is frozen', gen.status === 200, JSON.stringify(gen.d));
  await api('PUT', `/api/traders/${idB}`, { name: 'BASKARAN S', tel: '9876500002' });
  await api('PUT', `/api/traders/${idC}`, { name: 'CHELLAM R', tel: '', whatsapp: '9876500003' });

  const search = async (term) => {
    const qs = new URLSearchParams({ link: 'all', status: 'all' });
    if (term) qs.set('seller', term);
    const r = await api('GET', `/api/payments/lots/${aid}?${qs.toString()}`);
    return ((r.d && r.d.lots) || []).map(l => String(l.name).toUpperCase()).sort();
  };

  console.log('[A] Name search is untouched');
  check('a full name still matches', JSON.stringify(await search('ANBU SELVAM')) === JSON.stringify(['ANBU SELVAM']));
  check('a partial name still matches', JSON.stringify(await search('chell')) === JSON.stringify(['CHELLAM R']));
  check('no term lists every payable lot', (await search('')).length === 4);

  console.log('\n[B] Phone search');
  check('finds the seller whose number is on the lot',
        JSON.stringify(await search('9790744444')) === JSON.stringify(['ANBU SELVAM']),
        JSON.stringify(await search('9790744444')));
  check('finds the seller whose number reached the master after invoicing',
        JSON.stringify(await search('9876500002')) === JSON.stringify(['BASKARAN S']),
        JSON.stringify(await search('9876500002')));
  check('finds the seller who only has a WhatsApp number',
        JSON.stringify(await search('9876500003')) === JSON.stringify(['CHELLAM R']),
        JSON.stringify(await search('9876500003')));

  console.log('\n[C] Typed however the operator types it');
  for (const term of ['+91 97907 44444', '97907-44444', '(97907) 44444', '97907.44444', '9790744444']) {
    check(`"${term}" finds the same seller`,
          JSON.stringify(await search(term)) === JSON.stringify(['ANBU SELVAM']),
          JSON.stringify(await search(term)));
  }
  check('a trailing tail still finds them ("744444")',
        JSON.stringify(await search('744444')) === JSON.stringify(['ANBU SELVAM']),
        JSON.stringify(await search('744444')));

  console.log('\n[D] It still discriminates');
  check('a number nobody holds matches nobody', (await search('9999999999')).length === 0);
  check('the seller with no number anywhere is never a phone hit',
        !(await search('9876500002')).includes('DHANAM V') &&
        !(await search('9790744444')).includes('DHANAM V'));
  check('a 3-digit term is treated as a name, not a phone tail',
        (await search('444')).length === 0, JSON.stringify(await search('444')));
  check('the lot filter still composes with it', await (async () => {
    const qs = new URLSearchParams({ link: 'all', status: 'all', seller: '9790744444', lots: '2' });
    const r = await api('GET', `/api/payments/lots/${aid}?${qs.toString()}`);
    return ((r.d && r.d.lots) || []).length === 0;   // lot 2 is B's, not A's
  })());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(srvLog.slice(-1500));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
