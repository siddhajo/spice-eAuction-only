// FORM-D "Place of auction", carried on the TRADE.
//
// The venue is known when the auction is created, and it is the one thing
// Form-D asks for that nothing else about a trade records — so it is set
// there (`auctions.place`, picked from the `formd_places` list) instead of
// being asked for again at print time, when nobody remembers which of two
// venues trade #71 was held at.
//
// The resolution order is the whole feature, most specific first:
//   1. the caller's explicit ?place= (the Spice Board dropdown) — per print
//   2. the trade's own `auctions.place`
//   3. the configured branch / legacy business_place — what every trade did
//      before this existed, and still the answer for trades created before it
//
//   [create]   POST /api/auctions stores it, and a NEW venue is appended to
//              the formd_places list so it is only ever typed once
//   [dedupe]   the same venue (any casing / spacing) is not added twice
//   [update]   PUT stores it; an ABSENT key leaves it alone, '' clears it
//   [resolve]  Form-D prints trade → override → branch, in that order
//   [legacy]   a trade with no place behaves exactly as before
//   [filters]  the Spice Board screen is told the trade's place
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auc-place-'));
const PORT = 47421;
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
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const PUTTADY = 'e-Auction Spices Park Puttady';
const BODI    = 'e-Auction Spices Board Bodinayakanur';
const NEWVEN  = 'e-Auction Spices Board Kumily';

// Form-D's JSON carries the resolved place at summary.place — the same value
// the PDF prints in its "Place of auction" cell.
async function formdPlace(auctionId, override) {
  const qs = `auctionId=${auctionId}` + (override != null ? `&place=${encodeURIComponent(override)}` : '');
  const r = await api('GET', `/api/spice-board-reports/form_d/data?${qs}`);
  return r.d && r.d.summary && r.d.summary.place;
}
const placesList = async () => {
  const r = await api('GET', '/api/company-settings/flat');
  return String((r.d && r.d.formd_places) || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
};

// A trade needs a sold lot or Form-D has nothing to build from.
async function makeTrade(ano, place) {
  const body = { ano, date: '2026-10-04', state: 'TAMIL NADU' };
  if (place !== undefined) body.place = place;
  const a = await api('POST', '/api/auctions', body);
  const id = a.d && a.d.id;
  await api('POST', '/api/lots', {
    auction_id: id, lot_no: '001', name: 'SELLER ' + ano, cr: 'CR.900' + ano,
    qty: 100, bags: 10, grade: '1', branch: 'ANAVILASAM',
    price: 500, amount: 50000, code: 'B1', buyer: 'BUYER ONE', buyer1: 'BUYER ONE',
  });
  return { id, res: a };
}

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  // A configured branch, so step 3 of the chain has something to answer with.
  await api('PUT', '/api/company-settings', { settings: { tn_branch: 'CUMBUM', business_state: 'TAMIL NADU' } });

  console.log('[create] the venue is stored on the trade');
  const seeded = await placesList();
  check('the seeded place list has the two default venues',
    seeded.includes(PUTTADY) && seeded.includes(BODI), JSON.stringify(seeded));

  const t1 = await makeTrade('101', PUTTADY);
  check('POST /api/auctions accepts a place', t1.res.status === 200, JSON.stringify(t1.res.d));
  check('…and echoes it back', t1.res.d.place === PUTTADY, JSON.stringify(t1.res.d));
  {
    const r = await api('GET', '/api/auctions');
    const row = (r.d || []).find(a => String(a.ano) === '101');
    check('…and it is on the auction row', row && row.place === PUTTADY, JSON.stringify(row && row.place));
  }
  check('a place already in the list is not re-added', t1.res.d.placeAdded === false, JSON.stringify(t1.res.d));

  console.log('[create] a NEW venue joins the list, so it is typed once');
  const t2 = await makeTrade('102', NEWVEN);
  check('the new venue is reported as added', t2.res.d.placeAdded === true, JSON.stringify(t2.res.d));
  {
    const list = await placesList();
    check('…and is in the formd_places setting', list.includes(NEWVEN), JSON.stringify(list));
    check('…appended, not reordered — the old entries keep their place',
      list[0] === PUTTADY && list[list.length - 1] === NEWVEN, JSON.stringify(list));
  }

  console.log('[dedupe] the same venue never lands twice');
  const t3 = await makeTrade('103', '  E-AUCTION   spices board KUMILY  ');
  check('different casing and spacing is not a new entry', t3.res.d.placeAdded === false, JSON.stringify(t3.res.d));
  {
    const list = await placesList();
    const hits = list.filter(p => p.toLowerCase().replace(/\s+/g, ' ').includes('kumily')).length;
    check('…so the list still holds exactly one Kumily', hits === 1, JSON.stringify(list));
  }
  check('but the trade stores what was typed, whitespace-collapsed',
    t3.res.d.place === 'E-AUCTION spices board KUMILY', JSON.stringify(t3.res.d.place));

  console.log('[create] no place is still a perfectly good trade');
  const t0 = await makeTrade('100');
  check('omitting place stores blank', t0.res.d.place === '', JSON.stringify(t0.res.d));
  check('…and adds nothing to the list', t0.res.d.placeAdded === false);

  console.log('[resolve] Form-D prints trade → override → branch');
  check('a trade with a place prints it', (await formdPlace(t1.id)) === PUTTADY, await formdPlace(t1.id));
  check('…and an explicit ?place= still wins, for a one-off print',
    (await formdPlace(t1.id, BODI)) === BODI, await formdPlace(t1.id, BODI));
  check('a trade with NO place falls back to the configured branch',
    (await formdPlace(t0.id)) === 'CUMBUM', await formdPlace(t0.id));
  check('…and that trade still takes an override',
    (await formdPlace(t0.id, BODI)) === BODI, await formdPlace(t0.id, BODI));
  // Blank override = "don't override", not "print nothing" — the Spice Board
  // dropdown's empty option sends exactly this.
  check('an EMPTY ?place= defers to the trade rather than blanking it',
    (await formdPlace(t1.id, '')) === PUTTADY, await formdPlace(t1.id, ''));

  console.log('[update] PUT stores it; an absent key must not wipe it');
  {
    const r = await api('PUT', `/api/auctions/${t1.id}`,
      { ano: '101', date: '2026-10-04', crop_type: 'VST', state: 'TAMIL NADU', place: BODI });
    check('PUT with a place changes it', r.status === 200 && r.d.place === BODI, JSON.stringify(r.d));
    check('…and Form-D follows', (await formdPlace(t1.id)) === BODI, await formdPlace(t1.id));
  }
  {
    // The Lot Entry quick-create and any older caller send no `place` at all.
    const r = await api('PUT', `/api/auctions/${t1.id}`,
      { ano: '101', date: '2026-10-04', crop_type: 'VST', state: 'TAMIL NADU' });
    check('PUT WITHOUT the key leaves the venue alone', r.status === 200, JSON.stringify(r.d));
    check('…proved by Form-D still printing it', (await formdPlace(t1.id)) === BODI, await formdPlace(t1.id));
  }
  {
    const r = await api('PUT', `/api/auctions/${t1.id}`,
      { ano: '101', date: '2026-10-04', crop_type: 'VST', state: 'TAMIL NADU', place: '' });
    check('an EXPLICIT blank clears it', r.status === 200 && r.d.place === '', JSON.stringify(r.d));
    check('…and Form-D goes back to the configured branch',
      (await formdPlace(t1.id)) === 'CUMBUM', await formdPlace(t1.id));
  }

  console.log('[filters] the Spice Board screen is told the trade’s place');
  {
    const r = await api('GET', `/api/spice-board-reports/filters?auctionId=${t2.id}`);
    check('filters carry the place', r.d && r.d.place === NEWVEN, JSON.stringify(r.d && r.d.place));
    const r0 = await api('GET', `/api/spice-board-reports/filters?auctionId=${t0.id}`);
    check('…and blank for a trade without one', r0.d && r0.d.place === '', JSON.stringify(r0.d && r0.d.place));
  }

  console.log('[resolve] the printed PDF carries it too');
  {
    const r = await fetch(B + `/api/spice-board-reports/form_d/export?auctionId=${t2.id}&format=pdf`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const buf = Buffer.from(await r.arrayBuffer());
    check('Form-D PDF renders for a trade with a place',
      r.status === 200 && buf.slice(0, 4).toString() === '%PDF' && buf.length > 2000,
      `${r.status} ${buf.length}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
