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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
