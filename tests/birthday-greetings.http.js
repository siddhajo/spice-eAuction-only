// Birthday greetings — the HTTP surface.
//
// Covers what the engine tests cannot: the feature gate, the permission
// gates, the shape the Birthdays screen reads, and the guard that stops a
// stale screen greeting the wrong person. The engine's own semantics (the
// send-once ledger, the sweep gates, DOB parsing) are in
// tests/birthday-send-once.unit.js and tests/birthday-greetings.unit.js.
//
// No Meta account is involved, so every real send FAILS here — which is
// itself worth pinning: an unconfigured WhatsApp must produce a reported
// failure per row, never a 500.
//
//   node tests/birthday-greetings.http.js
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'birthday-http-'));
const PORT = 47391;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

let TOKEN = '';
async function api(method, url, body, noAuth) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      (TOKEN && !noAuth) ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const setFlags = (settings) => api('PUT', '/api/company-settings', { settings });

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

// Local yyyy-mm-dd — never toISOString, which is a day behind for most of
// the morning in every timezone this app runs in.
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  const today = new Date();
  const TODAY = ymd(today);
  const soonD = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 5);

  console.log('Birthday greetings — HTTP');

  // [A] OFF is the shipped state, and off must mean inert — not just a
  //     hidden sidebar entry. A screen somebody bookmarks, or a stale tab
  //     left open when an admin turns the feature off, must get nothing.
  const offGet = await api('GET', '/api/birthdays');
  check('flag OFF → 403 on the worklist', offGet.status === 403, JSON.stringify(offGet));
  check('the 403 names the flag and where to find it',
    /Birthday Greetings.*Settings/.test((offGet.d && offGet.d.error) || ''), JSON.stringify(offGet.d));
  const offSend = await api('POST', '/api/birthdays/send', { items: [{ party_type: 'seller', party_id: 1 }] });
  check('flag OFF → 403 on send', offSend.status === 403);
  const offSweep = await api('POST', '/api/birthdays/run-sweep', {});
  check('flag OFF → 403 on run-sweep', offSweep.status === 403);

  // [B] These routes carry every party's phone number and read the whole
  //     master, so they sit behind the same view gate as the send log.
  const anon = await api('GET', '/api/birthdays', null, true);
  check('unauthenticated → 401', anon.status === 401, JSON.stringify(anon));

  await setFlags({ flag_birthday_greetings: 'true' });

  // [C] The worklist, read the way the screen reads it.
  await api('POST', '/api/traders', { name: 'BIRTHDAY PLANTER', cr: 'CR.1', tel: '9876543210', dob: `1980-${TODAY.slice(5)}` });
  await api('POST', '/api/traders', { name: 'DD MM PLANTER', cr: 'CR.2', tel: '9876543211', dob: `${TODAY.slice(8)}/${TODAY.slice(5, 7)}/1975` });
  await api('POST', '/api/traders', { name: 'NO DOB PLANTER', cr: 'CR.3', tel: '9876543212', dob: '' });
  await api('POST', '/api/traders', { name: 'BAD DOB PLANTER', cr: 'CR.4', tel: '9876543213', dob: 'sometime in june' });
  await api('POST', '/api/traders', { name: 'NO PHONE PLANTER', cr: 'CR.5', tel: '', dob: `1990-${TODAY.slice(5)}` });
  await api('POST', '/api/buyers', { buyer: 'BDB', buyer1: 'BIRTHDAY BUYER CO', tel: '9800000001', dob: `1970-${TODAY.slice(5)}` });
  await api('POST', '/api/buyers', { buyer: 'SOON', buyer1: 'NEXT WEEK CO', tel: '9800000002', dob: `1970-${ymd(soonD).slice(5)}` });

  let g = await api('GET', '/api/birthdays');
  check('flag ON → 200', g.status === 200, JSON.stringify(g.d && g.d.error));
  const t = (g.d && g.d.today) || [];
  check('today lists every readable DOB, sellers and buyers', t.length === 4,
    `got ${t.length}: ${t.map(r => r.name).join(', ')}`);
  check('a buyer is in there', t.some(r => r.party_type === 'buyer' && /BIRTHDAY BUYER/.test(r.name)));
  check('dd/mm/yyyy is read the same as the date picker', t.some(r => /DD MM PLANTER/.test(r.name)));
  check('an unreadable DOB is left out rather than guessed at', !t.some(r => /BAD DOB/.test(r.name)));
  // Listed but unsendable: the operator needs to SEE that this seller's
  // birthday is today and the app has no number for them.
  const np = t.find(r => /NO PHONE/.test(r.name));
  check('a party with no phone is listed with an empty phone', np && !np.phone, JSON.stringify(np));
  check('each row carries the message that would go out',
    t.every(r => typeof r.message === 'string' && r.message.length > 0));
  check('nobody is marked greeted yet', t.every(r => r.greeted === false));
  check('buyer_id / seller_id are real master ids, not names',
    t.every(r => Number.isInteger(r.party_id) && r.party_id > 0));

  // Namesakes: two sellers can share a name, so the screen must key on the
  // id. Two rows with the same name and the same birthday must both appear.
  await api('POST', '/api/traders', { name: 'BIRTHDAY PLANTER', cr: 'CR.9', tel: '9876549999', dob: `1988-${TODAY.slice(5)}` });
  g = await api('GET', '/api/birthdays');
  const twins = (g.d.today || []).filter(r => r.name === 'BIRTHDAY PLANTER');
  check('namesakes are two rows, not one', twins.length === 2, JSON.stringify(twins.map(r => r.party_id)));
  check('and they have different ids', twins.length === 2 && twins[0].party_id !== twins[1].party_id);

  // [D] Upcoming is a separate list and must not repeat today.
  check('upcoming finds next week', (g.d.upcoming || []).some(r => /NEXT WEEK/.test(r.name)));
  check('upcoming never repeats today', (g.d.upcoming || []).every(r => r.days_away > 0));
  const wide = await api('GET', '/api/birthdays?days=1');
  check('days= narrows the window', (wide.d.upcoming || []).length === 0,
    JSON.stringify((wide.d.upcoming || []).map(r => r.name)));

  // [E] The counts that explain an empty screen. Without these, "no
  //     birthdays today" and "nobody has a date of birth on file" look the
  //     same to the operator.
  check('parties with no DOB are counted', g.d.counts && g.d.counts.no_dob >= 1, JSON.stringify(g.d.counts));
  check('unreadable DOBs are counted separately', g.d.counts.bad_dob >= 1, JSON.stringify(g.d.counts));
  check('parties with no phone are counted', g.d.counts.no_phone >= 1, JSON.stringify(g.d.counts));
  check('the screen is told whether WhatsApp is configured at all',
    g.d.whatsapp && g.d.whatsapp.configured === false);
  check('the screen is told the auto-send settings', g.d.config && g.d.config.auto === false && g.d.config.hour === 9,
    JSON.stringify(g.d.config));

  // [F] ?date= — the only way to demonstrate the screen on a day nobody has
  //     a birthday, and what the "missed yesterday" view is built on.
  const other = await api('GET', `/api/birthdays?date=${ymd(soonD)}`);
  check('?date= moves the worklist', (other.d.today || []).some(r => /NEXT WEEK/.test(r.name)),
    JSON.stringify((other.d.today || []).map(r => r.name)));
  check('?date= excludes the original day', !(other.d.today || []).some(r => /BIRTHDAY BUYER/.test(r.name)));
  const junk = await api('GET', '/api/birthdays?date=29/09/2026');
  check('an unparseable ?date= falls back to today rather than 500ing',
    junk.status === 200 && junk.d.date === TODAY, JSON.stringify(junk.d && junk.d.date));

  // [G] Party-type settings reach the worklist.
  await setFlags({ birthday_send_buyers: 'false' });
  const noBuyers = await api('GET', '/api/birthdays');
  check('"Greet Buyers" off drops buyers from the worklist',
    !(noBuyers.d.today || []).some(r => r.party_type === 'buyer'));
  check('...and sellers stay', (noBuyers.d.today || []).some(r => r.party_type === 'seller'));
  // A buyer excluded by the setting must not be sendable either — otherwise
  // a stale screen re-enables the party the admin just turned off.
  const sneaky = await api('POST', '/api/birthdays/send', { items: [{ party_type: 'buyer', party_id: 1 }] });
  check('an excluded buyer cannot be sent to', sneaky.status === 400, JSON.stringify(sneaky.d));
  await setFlags({ birthday_send_buyers: 'true' });

  // [H] Send. WhatsApp is not configured in this harness, so every attempt
  //     must come back as a REPORTED failure with Meta's reason — the row
  //     stays on the screen and the operator can retry.
  const seller = (g.d.today || []).find(r => r.party_type === 'seller' && r.phone);
  const send = await api('POST', '/api/birthdays/send',
    { items: [{ party_type: seller.party_type, party_id: seller.party_id }] });
  check('send returns 200 with a per-row verdict, not a 500', send.status === 200, JSON.stringify(send));
  check('the row failed', send.d.failed === 1 && send.d.sent === 0, JSON.stringify(send.d));
  check('and says WhatsApp is not configured',
    /not configured/i.test(((send.d.results || [])[0] || {}).error || ''), JSON.stringify(send.d.results));
  const afterFail = await api('GET', '/api/birthdays');
  check('a failed attempt is in the ledger', (afterFail.d.log || []).some(r => r.status === 'failed'));
  check('a failed attempt does NOT mark the party greeted',
    (afterFail.d.today || []).find(r => r.party_id === seller.party_id).greeted === false);
  check('the ledger records who tried',
    ((afterFail.d.log || [])[0] || {}).sent_by === 'admin', JSON.stringify((afterFail.d.log || [])[0]));

  // [I] The stale-screen guard. The server re-derives the birthday list and
  //     refuses anybody who is not having one today, so a tab left open
  //     overnight cannot greet yesterday's list this morning.
  const wrongDay = await api('POST', '/api/birthdays/send',
    { items: [{ party_type: 'buyer', party_id: 2 }] });   // the NEXT WEEK buyer
  check('a party with no birthday today is refused', wrongDay.status === 400, JSON.stringify(wrongDay.d));
  check('the refusal tells the operator to reload', /reload/i.test((wrongDay.d && wrongDay.d.error) || ''));
  const nobody = await api('POST', '/api/birthdays/send', { items: [] });
  check('an empty selection is a 400', nobody.status === 400);
  const ghost = await api('POST', '/api/birthdays/send',
    { items: [{ party_type: 'seller', party_id: 99999 }] });
  check('an unknown party is a 400, not a crash', ghost.status === 400, JSON.stringify(ghost.d));
  // A mixed selection sends the valid half and names the rest.
  const mixed = await api('POST', '/api/birthdays/send', {
    items: [{ party_type: 'seller', party_id: seller.party_id }, { party_type: 'seller', party_id: 99999 }],
  });
  check('a mixed selection still processes the valid rows', mixed.status === 200 && mixed.d.results.length === 1,
    JSON.stringify(mixed.d));
  check('and reports the ones it could not place', (mixed.d.unknown || []).length === 1, JSON.stringify(mixed.d.unknown));

  // [J] run-sweep is a settings action, not an everyday one: it is the
  //     "prove the automatic path works" button, so it needs the same
  //     permission as the switch that turns automatic sending on.
  const sweep = await api('POST', '/api/birthdays/run-sweep', {});
  check('run-sweep answers with why it did nothing', sweep.status === 200 && /auto-send off/.test(sweep.d.reason || ''),
    JSON.stringify(sweep.d));
  await setFlags({ birthday_auto_send: 'true', birthday_send_hour: '0' });
  const sweep2 = await api('POST', '/api/birthdays/run-sweep', {});
  check('with auto-send on the sweep runs', sweep2.d.ran === true, JSON.stringify(sweep2.d));
  check('every send still fails without a Meta account, and is reported',
    sweep2.d.failed >= 1 && sweep2.d.sent === 0, JSON.stringify(sweep2.d));
  const auto = await api('GET', '/api/birthdays');
  check('sweep attempts are tagged auto in the ledger', (auto.d.log || []).some(r => r.mode === 'auto'));
  check('an unattended sweep records no operator',
    ((auto.d.log || []).find(r => r.mode === 'auto') || {}).sent_by === '');

  // [K] buyers.dob round-trips through the master form — the feature is
  //     useless if editing a buyer silently drops the date.
  const bl = await api('GET', '/api/buyers?q=BDB');
  const brow = (Array.isArray(bl.d) ? bl.d : (bl.d && bl.d.rows) || []).find(x => x.buyer === 'BDB');
  check('buyers.dob is returned by the list route', brow && !!brow.dob, JSON.stringify(brow && brow.dob));
  const upd = await api('PUT', `/api/buyers/${brow.id}`,
    Object.assign({}, brow, { dob: '1971-12-25' }));
  check('a buyer edit accepts a new DOB', upd.status === 200, JSON.stringify(upd.d));
  const bl2 = await api('GET', '/api/buyers?q=BDB');
  const brow2 = (Array.isArray(bl2.d) ? bl2.d : (bl2.d && bl2.d.rows) || []).find(x => x.buyer === 'BDB');
  check('and it persists', brow2 && brow2.dob === '1971-12-25', JSON.stringify(brow2 && brow2.dob));
  check('...which takes that buyer off today\'s list',
    !((await api('GET', '/api/birthdays')).d.today || []).some(r => r.party_id === brow.id && r.party_type === 'buyer'));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); done(1); });
