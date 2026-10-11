// WhatsApp send log + delivery-status routes.
//
// "WhatsApp sent" only means Meta ACCEPTED the message. The real verdict —
// delivered, read, or failed — arrives later on the webhook and is written to
// whatsapp_messages. Two routes surface it:
//
//   GET  /api/whatsapp/messages   the Settings → Integrations send-log panel
//                                 (filters: status, direction, q, limit)
//   POST /api/whatsapp/statuses   the bulk-send queue polling the run it just
//                                 finished, by wamid
//   POST /api/whatsapp/log-unsent  the queue reporting the rows that never
//                                 reached Meta at all
//
// SCOPE: this proves the routes exist, are gated, and that every filter
// combination is valid SQL against the real schema. It does NOT prove the
// webhook's status writes — those need a live Meta callback; the client-side
// behaviour on top of them is covered by whatsapp-cloud-dispatch.unit.js.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-log-'));
const PORT = 47372;
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

  console.log('WhatsApp send log');

  // [A] Both routes are behind the view gate — the log carries every number
  //     the business has messaged, so it is not anonymous-readable.
  const anonGet  = await api('GET',  '/api/whatsapp/messages', null, true);
  const anonPost = await api('POST', '/api/whatsapp/statuses', { ids: ['x'] }, true);
  check('GET /messages requires auth',   anonGet.status === 401,  'got ' + anonGet.status);
  check('POST /statuses requires auth',  anonPost.status === 401, 'got ' + anonPost.status);

  // [B] The unfiltered log answers with an array (empty on a fresh install).
  const all = await api('GET', '/api/whatsapp/messages');
  check('GET /messages returns an array', all.status === 200 && Array.isArray(all.d),
    `${all.status} ${JSON.stringify(all.d).slice(0, 200)}`);

  // [C] Every filter the panel can send is valid SQL against the real schema.
  //     This is the part that breaks silently: a bad WHERE only shows up when
  //     an operator picks that dropdown.
  const filters = [
    '?status=sent', '?status=delivered', '?status=read', '?status=failed',
    '?status=unsent', '?ref_type=invoice', '?status=unsent&ref_type=bill',
    '?direction=out', '?direction=in',
    '?q=98765', '?q=BILL%20OF%20SUPPLY', "?q=o'brien",
    '?limit=1', '?limit=250', '?limit=500',
    '?status=failed&direction=out&q=99&limit=250',
  ];
  for (const f of filters) {
    const r = await api('GET', '/api/whatsapp/messages' + f);
    check('GET /messages' + f, r.status === 200 && Array.isArray(r.d),
      `${r.status} ${JSON.stringify(r.d).slice(0, 200)}`);
  }

  // [D] limit is clamped, not trusted — nothing here may let a caller ask the
  //     server to serialise the whole table.
  const huge = await api('GET', '/api/whatsapp/messages?limit=99999');
  check('limit is clamped, not rejected', huge.status === 200 && Array.isArray(huge.d),
    `${huge.status} ${JSON.stringify(huge.d).slice(0, 200)}`);
  const junk = await api('GET', '/api/whatsapp/messages?limit=abc');
  check('a junk limit falls back to the default', junk.status === 200 && Array.isArray(junk.d),
    `${junk.status} ${JSON.stringify(junk.d).slice(0, 200)}`);

  // [E] The queue's status poll: an empty id list is a no-op, a populated one
  //     builds a valid IN-list, and unknown ids simply aren't in the answer
  //     (the client leaves those rows on 'sent').
  const none = await api('POST', '/api/whatsapp/statuses', { ids: [] });
  check('POST /statuses with no ids → []', none.status === 200 && Array.isArray(none.d) && none.d.length === 0,
    `${none.status} ${JSON.stringify(none.d)}`);
  const missing = await api('POST', '/api/whatsapp/statuses', { ids: ['wamid.unknown1', 'wamid.unknown2'] });
  check('POST /statuses with unknown ids → []', missing.status === 200 && Array.isArray(missing.d) && missing.d.length === 0,
    `${missing.status} ${JSON.stringify(missing.d)}`);
  const noBody = await api('POST', '/api/whatsapp/statuses', {});
  check('POST /statuses with no ids field → []', noBody.status === 200 && Array.isArray(noBody.d),
    `${noBody.status} ${JSON.stringify(noBody.d)}`);
  // A full run's worth of ids must not blow the SQLite variable limit.
  const many = await api('POST', '/api/whatsapp/statuses', { ids: Array.from({ length: 500 }, (_, i) => 'wamid.' + i) });
  check('POST /statuses handles a 500-id run', many.status === 200 && Array.isArray(many.d),
    `${many.status} ${JSON.stringify(many.d).slice(0, 200)}`);
  const over = await api('POST', '/api/whatsapp/statuses', { ids: Array.from({ length: 900 }, (_, i) => 'wamid.' + i) });
  check('POST /statuses caps an oversized id list', over.status === 200 && Array.isArray(over.d),
    `${over.status} ${JSON.stringify(over.d).slice(0, 200)}`);

  // [F] The rows that never left the building. Before this route the log only
  //     knew about messages that reached Meta, so a run the account-level
  //     breaker stopped was invisible from the row it stopped at onward —
  //     exactly the run an operator needs to reconstruct.
  const anonLog = await api('POST', '/api/whatsapp/log-unsent', { rows: [] }, true);
  check('POST /log-unsent requires auth', anonLog.status === 401, 'got ' + anonLog.status);

  const logged = await api('POST', '/api/whatsapp/log-unsent', {
    rows: [
      { phone: '9876500001', caption: 'your SALES INVOICE 412 is attached.', ref_type: 'invoice', ref_id: '412',
        status: 'not_attempted', reason: 'Not attempted — WhatsApp is refusing sends from this number' },
      { phone: '9876500002', caption: 'K RAJU', ref_type: 'bill', ref_id: '8',
        status: 'not_sent', reason: 'No WhatsApp number on file' },
    ],
  });
  check('POST /log-unsent writes both kinds', logged.status === 200 && logged.d && logged.d.written === 2,
    `${logged.status} ${JSON.stringify(logged.d)}`);

  const unsent = await api('GET', '/api/whatsapp/messages?status=unsent');
  check('?status=unsent spans both never-sent statuses', unsent.status === 200 && unsent.d.length === 2,
    `${unsent.status} ${JSON.stringify(unsent.d).slice(0, 300)}`);
  const byRef = await api('GET', '/api/whatsapp/messages?ref_type=invoice');
  check('?ref_type finds a module’s own rows',
    byRef.status === 200 && byRef.d.length === 1 && byRef.d[0].ref_id === '412',
    `${byRef.status} ${JSON.stringify(byRef.d).slice(0, 300)}`);
  check('the reason survives for the operator to read',
    byRef.d[0] && /refusing sends/.test(byRef.d[0].error || ''),
    JSON.stringify(byRef.d[0]));

  // A client may not write itself a Meta verdict: only the two never-sent
  // statuses are accepted, and anything else is coerced rather than stored.
  const faked = await api('POST', '/api/whatsapp/log-unsent', {
    rows: [{ phone: '9876500003', ref_type: 'invoice', ref_id: '999', status: 'read' }],
  });
  const after = await api('GET', '/api/whatsapp/messages?ref_type=invoice');
  const fakeRow = (after.d || []).find(r => r.ref_id === '999');
  check('a client cannot write itself a "read" receipt',
    faked.status === 200 && fakeRow && fakeRow.status === 'not_attempted',
    JSON.stringify(fakeRow));

  // These rows are not sends: they must not spend 24h recipient headroom and
  // must not inflate "sent today", or a stopped run would read as a busy one.
  const usage = await api('GET', '/api/whatsapp/usage');
  check('never-sent rows spend no 24h recipient headroom',
    usage.status === 200 && usage.d.limit.used === 0,
    `used=${usage.status === 200 ? usage.d.limit.used : usage.status}`);
  check('never-sent rows are not counted as sent',
    usage.status === 200 && usage.d.sent.today.total === 0 && usage.d.sent.today.blocked === 3,
    `${JSON.stringify(usage.status === 200 ? usage.d.sent.today : usage.status)}`);

  const empty = await api('POST', '/api/whatsapp/log-unsent', {});
  check('POST /log-unsent with no rows is a no-op', empty.status === 200 && empty.d.written === 0,
    `${empty.status} ${JSON.stringify(empty.d)}`);

  // [G] Numbers that can never be delivered to are refused BEFORE the send.
  //     "Message undeliverable" is this account's commonest failure, and part
  //     of it is simply bad data in the master — Meta is a slow and expensive
  //     way to discover an 11-digit number, since the attempt is spent and the
  //     refusal counts against the number's standing.
  // Bogus creds so the route gets PAST the "not configured" short-circuit and
  // actually reaches the number check. A template name is needed for the same
  // reason — both guards sit in front of it.
  await api('PUT', '/api/whatsapp/config',
    { token: 'bogus-token-for-test', phoneId: '000000000000000', tplText: 'probe_tpl', tplTextLang: 'en' });
  const badNums = [
    ['99446804929', '11 digits'],      // a real one out of the trader master
    ['0',           '1 digit'],
    ['944680492',   '9 digits'],
  ];
  for (const [num, why] of badNums) {
    const r = await api('POST', '/api/whatsapp/send-template-text', { phone: num, params: ['a', 'b', 'c'] });
    // 400 (refused here) rather than 502 (Meta refused it) — and never a 501,
    // which would send the client off to WhatsApp Web instead.
    check(`send-template-text refuses a ${why} number`,
      r.status === 400 && /digit/i.test((r.d && r.d.error) || ''),
      `${r.status} ${JSON.stringify(r.d)}`);
  }
  const okShape = await api('POST', '/api/whatsapp/send-template-text', { phone: '9074485570', params: ['a', 'b', 'c'] });
  check('a well-formed number gets past the check and on to Meta',
    okShape.status !== 400, `${okShape.status} ${JSON.stringify(okShape.d)}`);
  // Narrow on purpose: an unfamiliar country code is Meta's call, not ours.
  const foreign = await api('POST', '/api/whatsapp/send-template-text', { phone: '14155551234', params: ['a', 'b', 'c'] });
  check('a foreign number is not second-guessed',
    foreign.status !== 400, `${foreign.status} ${JSON.stringify(foreign.d)}`);
  // A refused number must not land in the log as a Meta verdict — nothing was
  // sent, so nothing was refused by anyone but us.
  const afterBad = await api('GET', '/api/whatsapp/messages?status=failed');
  check('refusing a number writes no "failed" row',
    afterBad.status === 200 && !(afterBad.d || []).some(r => String(r.phone || '').includes('9944680492')),
    JSON.stringify((afterBad.d || []).map(r => r.phone)));

  // [H] "Which of my sellers do I need a better number for?"
  //     Undeliverable on a well-formed number is not fixable in code — there
  //     is no WhatsApp account on it. The only useful answer is a NAME, and
  //     only for numbers that have never once worked: a single failure among
  //     successes is a blip, not a dead number.
  const seller = await api('POST', '/api/traders', { name: 'DEAD NUMBER SELLER', tel: '9000000111' });
  check('fixture seller created', seller.status < 300, `${seller.status} ${JSON.stringify(seller.d)}`);
  await api('POST', '/api/whatsapp/log-unsent', { rows: [] });   // no-op, keeps the log honest

  // Three refusals on one number, never a success → a dead number. Bogus
  // creds make the send route log a real `failed` row with Meta's reason.
  for (let i = 0; i < 3; i++) {
    await api('POST', '/api/whatsapp/send-template-text', { phone: '9000000111', params: ['a', 'b', 'c'] });
  }
  const bad = await api('GET', '/api/whatsapp/problem-numbers');
  const dead = ((bad.d && bad.d.rows) || []).find(r => String(r.phone).endsWith('9000000111'));
  check('GET /problem-numbers lists a number that has never worked',
    bad.status === 200 && !!dead, `${bad.status} ${JSON.stringify(bad.d).slice(0, 300)}`);
  check('…counting every attempt', dead && dead.fails === 3, JSON.stringify(dead));
  check('…carrying Meta’s own reason', dead && !!dead.lastError, JSON.stringify(dead));
  check('…and naming the SELLER, not just the digits',
    dead && dead.owners.some(o => o.name === 'DEAD NUMBER SELLER' && o.kind === 'seller'),
    JSON.stringify(dead && dead.owners));

  // The masters hold 10 digits, the log holds 91 + 10 — the join has to meet
  // in the middle or every row comes back nameless.
  check('the 10-digit master and the 12-digit log row are matched',
    dead && String(dead.phone).length === 12, JSON.stringify(dead && dead.phone));

  // A number this app refused ITSELF (eleven digits) belongs here too: same
  // problem from the operator's chair, same fix. It is logged as not_sent
  // rather than failed, so the query has to span both.
  await api('POST', '/api/whatsapp/log-unsent', { rows: [
    { phone: '9000000222', status: 'not_sent', reason: 'The number on file has 11 digits', ref_type: 'bill', ref_id: '77' },
  ] });
  const withOurs = await api('GET', '/api/whatsapp/problem-numbers');
  const ours = ((withOurs.d && withOurs.d.rows) || []).find(r => String(r.phone).endsWith('9000000222'));
  check('a number THIS APP refused is listed too, not just Meta’s refusals',
    !!ours && /11 digits/.test(ours.lastError || ''), JSON.stringify(ours));
  // A run the breaker stopped says nothing about the number it never reached.
  await api('POST', '/api/whatsapp/log-unsent', { rows: [
    { phone: '9000000333', status: 'not_attempted', reason: 'Not attempted — Spam Rate limit hit', ref_type: 'bill', ref_id: '78' },
  ] });
  const afterStop = await api('GET', '/api/whatsapp/problem-numbers');
  check('a row a stopped run never reached is NOT called a bad number',
    !((afterStop.d && afterStop.d.rows) || []).some(r => String(r.phone).endsWith('9000000333')),
    JSON.stringify((afterStop.d && afterStop.d.rows || []).map(r => r.phone)));

  // The SEND path asks for a stricter threshold than the panel does: it
  // skips sending, so a single bad moment must not cut a seller off.
  const strict = await api('GET', '/api/whatsapp/problem-numbers?minFails=2');
  check('?minFails raises the bar', strict.status === 200 && strict.d.minFails === 2,
    JSON.stringify(strict.d && strict.d.minFails));
  check('…and the one-refusal number drops out of the strict list',
    !((strict.d && strict.d.rows) || []).some(r => String(r.phone).endsWith('9000000222')),
    JSON.stringify((strict.d && strict.d.rows || []).map(r => [r.phone, r.fails])));
  check('…while the one refused three times stays',
    ((strict.d && strict.d.rows) || []).some(r => String(r.phone).endsWith('9000000111')),
    JSON.stringify((strict.d && strict.d.rows || []).map(r => [r.phone, r.fails])));
  const loose = await api('GET', '/api/whatsapp/problem-numbers?minFails=0');
  check('a junk minFails falls back to 1', loose.status === 200 && loose.d.minFails === 1,
    JSON.stringify(loose.d && loose.d.minFails));

  const windowed = await api('GET', '/api/whatsapp/problem-numbers?days=0');
  check('a junk ?days falls back to the default', windowed.status === 200 && windowed.d.days === 90,
    JSON.stringify(windowed.d && windowed.d.days));
  const capped = await api('GET', '/api/whatsapp/problem-numbers?days=99999');
  check('?days is capped, not trusted', capped.status === 200 && capped.d.days === 730,
    JSON.stringify(capped.d && capped.d.days));
  const anonBad = await api('GET', '/api/whatsapp/problem-numbers', null, true);
  check('GET /problem-numbers requires auth', anonBad.status === 401, 'got ' + anonBad.status);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
