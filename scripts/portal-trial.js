// scripts/portal-trial.js — try the customer portal (/my) against a SAFE COPY
// of the live database.
//
// Everything the portal needs in order to be tried is fiddly exactly once:
// the flag has to be on, links have to be seeded, and the sign-in code goes
// to the server log because no SMS or WhatsApp channel exists yet. This
// script does all of it and then prints the handful of real phone numbers
// worth typing in — a seller on their own number, a shared handset, and a
// buyer — so the interesting cases can be tried without going looking for
// them in SQL.
//
// IT NEVER TOUCHES data/. The live database is COPIED to a sandbox and the
// server is pointed at the copy via SPICE_DATA_DIR, which is the env var
// db.js actually reads. Nothing done in the browser during a trial can reach
// real data.
//
// Usage:
//   node scripts/portal-trial.js            # copy data/, boot, seed, print
//   node scripts/portal-trial.js --port 4010
//   node scripts/portal-trial.js --keep     # reuse the previous sandbox
//
// Ctrl-C stops the server and leaves the sandbox behind for inspection.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
process.chdir(ROOT);

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', 4010));
const KEEP = process.argv.includes('--keep');
const BASE = `http://127.0.0.1:${PORT}`;

const LIVE = path.join(ROOT, 'data');
const SAND = path.join(os.tmpdir(), 'spice-portal-trial');

// ── 1. Sandbox ────────────────────────────────────────────────────────────
if (!KEEP) {
  fs.rmSync(SAND, { recursive: true, force: true });
  fs.mkdirSync(SAND, { recursive: true });
  const db = path.join(LIVE, 'config.db');
  if (!fs.existsSync(db)) {
    console.error(`No database at ${db} — nothing to copy.`);
    process.exit(1);
  }
  fs.copyFileSync(db, path.join(SAND, 'config.db'));
  // The logo lives on the data volume and is rehydrated on boot; without it
  // the PDFs come out unbranded and the trial looks wrong for the wrong
  // reason.
  const brand = path.join(LIVE, 'branding');
  if (fs.existsSync(brand)) fs.cpSync(brand, path.join(SAND, 'branding'), { recursive: true });
  console.log(`Sandbox copy: ${SAND}  (live data/ untouched)`);
} else {
  console.log(`Reusing sandbox: ${SAND}`);
}

// ── 2. Boot ───────────────────────────────────────────────────────────────
const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, SPICE_DATA_DIR: SAND, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
const onOut = (b) => {
  const s = String(b);
  log += s;
  // The sign-in codes are the whole point of watching the log — surface them
  // and keep the rest of the boot chatter out of the way.
  for (const line of s.split('\n')) {
    if (/\[portal\] OTP for/.test(line)) console.log('\n  🔑 ' + line.trim() + '\n');
  }
};
srv.stdout.on('data', onOut);
srv.stderr.on('data', onOut);

const stop = () => { try { srv.kill('SIGKILL'); } catch (_) {} };
process.on('SIGINT', () => { console.log('\nStopping.'); stop(); process.exit(0); });

// ── 3. Set it up through the app's own API ────────────────────────────────
const api = async (method, url, body, token) => {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};

(async () => {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  const USER = arg('user', 'admin');
  const PASS = arg('pass', 'admin123');
  const login = await api('POST', '/api/login', { username: USER, password: PASS });
  if (login.s !== 200 || !login.d || !login.d.token) {
    console.error(`\nCould not sign in as "${USER}". Pass real credentials:`);
    console.error(`  node scripts/portal-trial.js --user <name> --pass <password>\n`);
    console.error('Server said:', JSON.stringify(login.d));
    stop(); process.exit(1);
  }
  const T = login.d.token;

  await api('PUT', '/api/company-settings', { settings: { flag_customer_portal: 'true' } }, T);
  const dry = await api('POST', '/api/portal/admin/seed', {}, T);
  const run = await api('POST', '/api/portal/admin/seed', { commit: true }, T);

  // ── 4. Pick the numbers actually worth typing in ────────────────────────
  const links = (await api('GET', '/api/portal/admin/links', null, T)).d || { rows: [] };
  const byPhone = new Map();
  for (const r of links.rows || []) {
    if (!byPhone.has(r.phone_key)) byPhone.set(r.phone_key, []);
    byPhone.get(r.phone_key).push(r);
  }
  const solo   = [...byPhone.entries()].find(([, v]) => v.length === 1 && v[0].party_kind === 'seller');
  const shared = [...byPhone.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const buyer  = [...byPhone.entries()].find(([, v]) => v.some(x => x.party_kind === 'buyer'));

  const show = (label, entry) => {
    if (!entry) return console.log(`  ${label.padEnd(26)} (none in this data)`);
    const [phone, rows] = entry;
    console.log(`  ${label.padEnd(26)} ${phone}   →  ${rows.length} part${rows.length === 1 ? 'y' : 'ies'}`);
    rows.slice(0, 6).forEach(r => console.log(`  ${''.padEnd(26)}    · ${r.party_name} (${r.party_kind})`));
    if (rows.length > 6) console.log(`  ${''.padEnd(26)}    · …and ${rows.length - 6} more`);
  };

  console.log(`
════════════════════════════════════════════════════════════════════
  CUSTOMER PORTAL — TRIAL READY
════════════════════════════════════════════════════════════════════

  Portal (what a customer sees):   ${BASE}/my
  Admin app (you):                 ${BASE}          ${USER} / ${PASS}

  Enrolled ${run.d && run.d.written} links across ${dry.d && dry.d.distinctPhones} numbers.
  ${dry.d && dry.d.sharedPhones} of those numbers open more than one party (${dry.d && dry.d.partiesOnSharedPhones} parties in total).

  ── Numbers to try ────────────────────────────────────────────────`);
  show('one seller, one number', solo);
  show('a SHARED handset', shared);
  show('a buyer', buyer);
  console.log(`
  ── How to sign in ────────────────────────────────────────────────

  1. Open ${BASE}/my  (use your phone's browser, or DevTools
     device mode — it is built for a 5-inch screen)
  2. Type one of the numbers above, tap "Send code"
  3. The 6-digit code appears HERE, in this terminal, flagged 🔑
     — there is no SMS or WhatsApp channel yet, so the log IS the
     channel. This is why the portal must not be opened to real
     customers until a channel exists.
  4. Enter it, and you are in as that party.

  ── What is worth checking ────────────────────────────────────────

  • The shared handset lists several parties — tap between them and
    confirm each shows only its own documents.
  • Open a document. Compare it against the same one printed from
    the admin app; they come off the same renderer.
  • In the admin app, Settings → Flags → turn "Customer Portal" OFF
    and reload the portal tab: a live session dies immediately.
  • Revoke one link and watch it vanish from the customer's party
    list on their next tap, without signing them out:
        POST ${BASE}/api/portal/admin/links/<id>/revoke
  • Who downloaded what:
        GET  ${BASE}/api/portal/admin/downloads

  Ctrl-C to stop. The sandbox stays at:
    ${SAND}
════════════════════════════════════════════════════════════════════
`);
})().catch(e => { console.error('Trial setup failed:', e); stop(); process.exit(1); });
