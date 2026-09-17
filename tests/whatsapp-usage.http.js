// WhatsApp usage & billing route.
//
// GET /api/whatsapp/usage answers the three questions the Settings →
// Integrations "Usage & billing" card exists for: how many free messages are
// left this month, how many recipients are left in the rolling 24h messaging
// limit, and how many this install has sent (today / this month).
//
// SCOPE: everything that does NOT need a live Meta account — the gate, the
// documented response shape, the local send-log counters (including the rule
// that a FAILED send spends no messaging-limit headroom), and the two
// operator-editable knobs (free allowance + recharge URL override) round-
// tripping through company settings. The Meta half (pricing_analytics,
// whatsapp_business_manager_messaging_limit) degrades to `source:
// 'unavailable'` plus a reason, which is exactly what this test asserts —
// proving the route never fails just because Meta is unreachable.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-usage-'));
const PORT = 47374;
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

  console.log('WhatsApp usage & billing');

  // [A] The route carries every number the business has messaged this month —
  //     same sensitivity as the send log, so it sits behind the view gate.
  const anon = await api('GET', '/api/whatsapp/usage', null, true);
  check('GET /usage rejects anonymous', anon.status === 401 || anon.status === 403, 'got ' + anon.status);

  // [B] Nothing configured: the card must still render. Every counter is
  //     present and zero, and the unreadable halves say WHY rather than
  //     inventing a balance.
  const u0 = (await api('GET', '/api/whatsapp/usage')).d || {};
  check('unconfigured still 200s with a full shape',
    u0.configured === false && u0.sent && u0.limit && u0.free && u0.billing,
    JSON.stringify(u0).slice(0, 300));
  check('counters start at zero',
    u0.sent.today.total === 0 && u0.sent.month.total === 0 && u0.sent.total === 0 && u0.limit.used === 0,
    JSON.stringify(u0.sent));
  check('free/limit report unavailable WITH a reason',
    u0.free.source === 'unavailable' && !!u0.free.error &&
    u0.limit.source === 'unavailable' && !!u0.limit.error,
    JSON.stringify({ free: u0.free, limit: u0.limit }));
  check('default free allowance is Meta\'s 1,000/month', u0.free.allowance === 1000, String(u0.free.allowance));
  check('recharge falls back to the Meta billing hub',
    /billing_hub/.test(u0.billing.url) && u0.billing.customUrl === '' && !u0.billing.blocked,
    JSON.stringify(u0.billing));
  check('month label names the calendar month',
    /^[A-Z][a-z]+ \d{4}$/.test(String(u0.monthLabel || '')), String(u0.monthLabel));

  // [C] Both knobs are ordinary company settings, and the route reads them
  //     back — this is what makes the allowance correctable when Meta moves it.
  await api('PUT', '/api/company-settings', { settings: { wa_free_allowance: '250', wa_billing_url: 'https://pay.example.com/topup' } });
  const u1 = (await api('GET', '/api/whatsapp/usage')).d || {};
  check('free allowance override is honoured', u1.free.allowance === 250, String(u1.free.allowance));
  check('recharge URL override replaces the Meta link',
    u1.billing.url === 'https://pay.example.com/topup' && u1.billing.customUrl === 'https://pay.example.com/topup',
    JSON.stringify(u1.billing));
  await api('PUT', '/api/company-settings', { settings: { wa_free_allowance: '1000', wa_billing_url: '' } });

  // [D] Counters track the send log. Configure bogus creds so a send is
  //     ATTEMPTED (and logged as failed) instead of short-circuiting on 501.
  await api('PUT', '/api/whatsapp/config', { token: 'bogus-token-for-test', phoneId: '000000000000000' });
  const send = await api('POST', '/api/whatsapp/send-text', { phone: '9876543210', message: 'usage counter probe' });
  check('send with bogus creds is refused, not crashed', send.status === 502 || send.status === 400, 'got ' + send.status);
  const u2 = (await api('GET', '/api/whatsapp/usage?fresh=1')).d || {};
  check('the failed send is counted in today + this month',
    u2.sent.today.total === 1 && u2.sent.month.total === 1 && u2.sent.today.failed === 1,
    JSON.stringify(u2.sent));
  // The messaging limit counts recipients actually DELIVERED to. A send Meta
  // refused spends none of the 250, so it must not shrink the headroom.
  check('a failed send spends no 24h recipient headroom', u2.limit.used === 0, String(u2.limit.used));
  check('Meta being unreachable does not fail the route',
    u2.configured === true && u2.free.source === 'unavailable' && typeof u2.free.error === 'string',
    JSON.stringify(u2.free));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); done(1); });
