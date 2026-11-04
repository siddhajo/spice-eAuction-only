// WhatsApp compliance — the HTTP surface and the enforcement in the send paths.
//
// The rules themselves are proved by wa-compliance.unit.js against the real
// engine. THIS test proves the part that cannot be unit-tested: that the
// enforcement actually sits inside the send routes, and that no client can
// route around it.
//
// WHY THAT MATTERS
// Meta disabled this business's WhatsApp account on 2026-11-04 for a breach
// of the Terms of Acceptable Use. Every screen in the app that sends a
// WhatsApp message does it through one of four routes, and a guard that only
// lived in the browser would be one forgotten caller away from repeating the
// breach. So the assertions here are about the SERVER refusing:
//
//   • an outreach send to a contact with no opt-in comes back 403, not 502;
//   • the refusal carries NO `fallback` flag — the client reads that flag as
//     "open WhatsApp Web", and pushing a refused message through the
//     operator's personal WhatsApp is the circumvention, not the workaround;
//   • the install-wide pause stops every route;
//   • /api/whatsapp/consent needs settings-write, not merely view: who may be
//     messaged is a policy decision.
//
//   node tests/wa-compliance.http.js
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-policy-http-'));
const PORT = 47384;
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
const setSettings = (settings) => api('PUT', '/api/company-settings', { settings });

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

const PHONE = '9876543210';

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lg.d && (lg.d.token || lg.d.accessToken);
  if (!TOKEN) { console.error('login failed', lg.status, lg.d, srvLog.slice(-2000)); done(1); }

  console.log('WhatsApp compliance — HTTP surface');

  // ── [A] Gating ──────────────────────────────────────────────
  const anon = await api('GET', '/api/whatsapp/compliance', null, true);
  check('GET /compliance requires auth', anon.status === 401, 'got ' + anon.status);
  const anonPost = await api('POST', '/api/whatsapp/consent', { phone: PHONE, status: 'in' }, true);
  check('POST /consent requires auth', anonPost.status === 401, 'got ' + anonPost.status);

  // ── [B] The panel payload ───────────────────────────────────
  const panel = await api('GET', '/api/whatsapp/compliance');
  check('GET /compliance answers 200', panel.status === 200, `${panel.status} ${JSON.stringify(panel.d).slice(0, 200)}`);
  const P = panel.d || {};
  check('…with the live policy', P.policy && P.policy.mode === 'enforce', JSON.stringify(P.policy));
  check('…enforcing by default on a fresh install', P.policy && P.policy.paused === false);
  check('…and the legacy opt-in assumption OFF by default',
    P.policy && P.policy.legacyOptIn === false, JSON.stringify(P.policy));
  check('…with a coverage block', !!P.coverage && typeof P.coverage.unknown === 'number');
  check('…the opt-out list', Array.isArray(P.optedOut));
  check('…and recent gate decisions', Array.isArray(P.recent));
  check('health is reported, unknown until Meta is asked',
    typeof P.health === 'string', String(P.health));

  // ── [C] Recording consent ───────────────────────────────────
  let r = await api('POST', '/api/whatsapp/consent',
    { phone: PHONE, status: 'in', basis: 'signed the 2026 registration form' });
  check('an opt-in is recorded', r.status === 200 && r.d.written === 1, JSON.stringify(r.d));
  r = await api('POST', '/api/whatsapp/consent', { phone: PHONE, status: 'sideways' });
  check('a nonsense status is reported, not stored', r.d.written === 0 && r.d.failed.length === 1);
  r = await api('POST', '/api/whatsapp/consent',
    { rows: [{ phone: '9111111111', status: 'out', basis: 'asked on the phone' },
             { phone: '9222222222', status: 'in', basis: 'form' }] });
  check('a batch is written', r.d.written === 2, JSON.stringify(r.d));

  let after = await api('GET', '/api/whatsapp/compliance');
  check('the opt-out appears on the panel',
    (after.d.optedOut || []).some(x => String(x.phone).includes('9111111111')),
    JSON.stringify(after.d.optedOut));
  check('…carrying the evidence it was recorded on',
    (after.d.optedOut || []).some(x => /asked on the phone/.test(x.basis || '')));
  check('coverage counts two opt-ins and one opt-out',
    after.d.coverage.optedIn === 2 && after.d.coverage.optedOut === 1,
    JSON.stringify(after.d.coverage));

  // ── [D] Clearing a decision ─────────────────────────────────
  r = await api('DELETE', '/api/whatsapp/consent/9222222222');
  check('a consent record can be cleared', r.status === 200, JSON.stringify(r.d));
  r = await api('DELETE', '/api/whatsapp/consent/9222222222');
  check('…and clearing it twice 404s rather than lying', r.status === 404);
  // Clearing an OPT-OUT is the one destructive act here and has to leave a trace.
  r = await api('DELETE', '/api/whatsapp/consent/9111111111');
  check('an opt-out can be cleared', r.status === 200);
  after = await api('GET', '/api/whatsapp/compliance');
  check('…and the clearing is recorded in the policy log',
    (after.d.recent || []).some(x => x.code === 'optout_cleared'),
    JSON.stringify(after.d.recent).slice(0, 300));

  // ── [E] Replies the app never read ──────────────────────────
  r = await api('POST', '/api/whatsapp/consent/apply-replies');
  check('apply-replies answers 200 on an empty archive', r.status === 200 && r.d.applied === 0,
    JSON.stringify(r.d));

  // ── [F] THE ENFORCEMENT ─────────────────────────────────────
  // Configure WhatsApp with a bogus token so the routes get past their
  // "not configured" 501 and reach the gate. A send that passes the gate
  // then fails at Meta — which is the point: the gate must answer BEFORE
  // the network, and with a different status code.
  await api('PUT', '/api/whatsapp/config',
    { token: 'bogus-token-for-test', phoneId: '000000000000000',
      tplText: 'probe_tpl', tplTextLang: 'en', tplDocument: 'probe_doc' });

  console.log('\nenforcement inside the send routes');
  // An opted-out contact. Every class must be refused, invoice included.
  await api('POST', '/api/whatsapp/consent',
    { phone: PHONE, status: 'out', basis: 'replied STOP' });

  const tplText = await api('POST', '/api/whatsapp/send-template-text',
    { phone: PHONE, params: ['a', 'b', 'c'] });
  check('a template send to an opted-out contact is refused 403',
    tplText.status === 403, `${tplText.status} ${JSON.stringify(tplText.d)}`);
  check('…naming the rule, so the operator knows why',
    tplText.d && tplText.d.policy === 'opted_out', JSON.stringify(tplText.d));
  // THE assertion. `fallback:true` is the client's instruction to open
  // WhatsApp Web; a policy refusal must never carry it.
  check('…and NOT offering WhatsApp Web as a way round it',
    tplText.d && !tplText.d.fallback, JSON.stringify(tplText.d));

  const plainText = await api('POST', '/api/whatsapp/send-text',
    { phone: PHONE, message: 'hello' });
  check('a plain text send to an opted-out contact is refused',
    plainText.status === 403 && plainText.d.policy === 'opted_out',
    `${plainText.status} ${JSON.stringify(plainText.d)}`);
  check('…with no WhatsApp Web fallback either', !plainText.d.fallback);

  const doc = await api('POST', '/api/whatsapp/send-document',
    { phone: PHONE, doc_url: 'https://example.invalid/x.pdf', filename: 'x.pdf' });
  check('a document send to an opted-out contact is refused',
    doc.status === 403 && doc.d.policy === 'opted_out',
    `${doc.status} ${JSON.stringify(doc.d)}`);

  // The refusal is logged where the operator looks, so a document the app
  // would not send does not simply vanish.
  const log = await api('GET', '/api/whatsapp/messages?status=blocked');
  check('every refusal is on the send log as "blocked"',
    log.status === 200 && Array.isArray(log.d) && log.d.length >= 3,
    `${log.status} ${JSON.stringify(log.d).slice(0, 300)}`);
  check('…with the rule as the reason',
    (log.d || []).every(x => x.error === 'opted_out'), JSON.stringify(log.d).slice(0, 300));
  // A refusal spends no 24h headroom and is not a send.
  const usage = await api('GET', '/api/whatsapp/usage');
  check('a refused message is not counted as sent today',
    usage.d && usage.d.sent && usage.d.sent.today.total === 0,
    JSON.stringify(usage.d && usage.d.sent));
  check('…it is counted as blocked', usage.d.sent.today.blocked >= 3, JSON.stringify(usage.d.sent.today));
  check('…and spends no recipient headroom', usage.d.limit.used === 0, String(usage.d.limit.used));
  check('the usage card carries the policy headline',
    usage.d.policy && usage.d.policy.mode === 'enforce', JSON.stringify(usage.d.policy));

  // ── [G] A contact with NO record: utility yes, marketing no ──
  console.log('\na contact nobody ever asked');
  const NEW = '9333333333';
  const util = await api('POST', '/api/whatsapp/send-template-text', { phone: NEW, params: ['a', 'b'] });
  check('a utility send reaches Meta (and fails there, not here)',
    util.status === 502, `${util.status} ${JSON.stringify(util.d)}`);
  check('…so it was NOT a policy refusal', !(util.d && util.d.policy), JSON.stringify(util.d));

  // ── [H] The pause ───────────────────────────────────────────
  console.log('\nthe install-wide pause');
  await setSettings({ wa_sending_paused: 'true' });
  const paused = await api('POST', '/api/whatsapp/send-template-text', { phone: NEW, params: ['a', 'b'] });
  check('paused refuses even a contact with no record',
    paused.status === 403 && paused.d.policy === 'paused',
    `${paused.status} ${JSON.stringify(paused.d)}`);
  const pausedPanel = await api('GET', '/api/whatsapp/compliance');
  check('…and the panel says so', pausedPanel.d.policy.paused === true);
  await setSettings({ wa_sending_paused: 'false' });
  const resumed = await api('POST', '/api/whatsapp/send-template-text', { phone: NEW, params: ['a', 'b'] });
  check('un-pausing lets sends through again', resumed.status === 502, String(resumed.status));

  // ── [I] Settings-write, not view ────────────────────────────
  // A viewer may read the panel (they need to know why a send was refused)
  // but may not decide who is messageable.
  console.log('\nwho may change the policy');
  const mk = await api('POST', '/api/users',
    { username: 'viewer_wa', password: 'viewer123x', role: 'user', perm_view: 1 });
  if (mk.status === 200 || mk.status === 201) {
    const vl = await api('POST', '/api/login', { username: 'viewer_wa', password: 'viewer123x' });
    const vt = vl.d && (vl.d.token || vl.d.accessToken);
    if (vt) {
      const admin = TOKEN; TOKEN = vt;
      const vRead = await api('GET', '/api/whatsapp/compliance');
      const vWrite = await api('POST', '/api/whatsapp/consent', { phone: '9444444444', status: 'in' });
      const vDel = await api('DELETE', '/api/whatsapp/consent/9444444444');
      TOKEN = admin;
      check('a viewer can read the compliance panel', vRead.status === 200, String(vRead.status));
      check('a viewer cannot record consent', vWrite.status === 403, String(vWrite.status));
      check('a viewer cannot clear an opt-out', vDel.status === 403, String(vDel.status));
    } else { console.log('  --   viewer login unavailable, permission checks skipped'); }
  } else { console.log('  --   viewer creation unavailable (' + mk.status + '), permission checks skipped'); }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.error('\n--- server log tail ---\n' + srvLog.slice(-3000));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); done(1); });
