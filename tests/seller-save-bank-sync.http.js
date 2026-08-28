// SELLER SAVE — a bank-sync failure must not be reported as a failed save.
//
// The bug this pins, reported from a live install: editing a seller updated
// the record AND showed a red "syncTraderBanks is not a function" banner. The
// operator reopens the seller and finds the change applied — so the banner is
// lying about what happened.
//
// Cause: PUT /api/traders/:id runs `UPDATE traders` FIRST and calls
// syncTraderBanks AFTER. There is no transaction around the pair, so anything
// thrown by the second step answers 500 for an edit that already committed.
// The install's own trigger was a stale process — require() caches on first
// load, so a server booted while trader-lot-sync.js still lacked that export
// kept the broken import for its whole lifetime.
//
// Two guarantees:
//   [boot]  a build whose trader-lot-sync.js predates the move still STARTS.
//           An earlier revision threw at import time; that was worse than the
//           bug — a missing bank-sync helper breaks one feature, refusing to
//           boot takes down invoicing, exports and every other screen. It now
//           shouts on stderr, substitutes stubs, and serves.
//   [save]  when the bank sync throws — whether from the stub or for real —
//           the seller edit is still reported as saved, with a warning naming
//           what actually failed, never a 500 that contradicts the committed
//           row.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sellersave-'));
const PORT = 47372;
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

// ══ [boot] a build with the old module still serves ══════════════
// Run server.js with a stub that exports only the OLD name — exactly the
// state the live deployment was in. It must START, warn on stderr, and still
// answer requests; and a seller edit against it must save and warn rather
// than 500. Booting a real server on a spare port and driving it is the only
// way to prove "degrades" rather than "dies".
function bootWithBrokenModule() {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
  // A shim directory that resolves ./trader-lot-sync to a crippled copy while
  // every other require falls through to the real tree.
  const shim = path.join(SANDBOX, 'boot.js');
  fs.writeFileSync(shim, `
    const Module = require('module');
    const path = require('path');
    const ROOT = ${JSON.stringify(ROOT)};
    const orig = Module._load;
    Module._load = function (req, parent, isMain) {
      if (/trader-lot-sync$/.test(req)) {
        // The pre-refactor export set: syncLotsFromTrader only.
        const real = orig.call(this, path.join(ROOT, 'trader-lot-sync.js'), parent, isMain);
        return { syncLotsFromTrader: real.syncLotsFromTrader };
      }
      return orig.call(this, req, parent, isMain);
    };
    require(path.join(ROOT, 'server.js'));
  `);
  const SPARE = 47373, SB = `http://127.0.0.1:${SPARE}`;
  return new Promise(async (resolve) => {
    const p = spawn('node', [shim], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { SPICE_DATA_DIR: SANDBOX, PORT: String(SPARE), NODE_ENV: 'test' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', exited = null;
    p.stdout.on('data', b => out += b); p.stderr.on('data', b => out += b);
    p.on('exit', (code) => { exited = code; });

    let alive = false;
    for (let i = 0; i < 100 && exited === null; i++) {
      try { const r = await fetch(SB + '/api/health'); if (r.status < 500) { alive = true; break; } } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    // Drive a seller edit against the crippled build.
    let edit = null, saved = null;
    if (alive) {
      const call = async (m, u, b, tok) => {
        const r = await fetch(SB + u, { method: m,
          headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}),
          body: b ? JSON.stringify(b) : undefined });
        let d = null; try { d = await r.json(); } catch (_) {}
        return { status: r.status, d };
      };
      const li = await call('POST', '/api/login', { username: 'admin', password: 'admin123' });
      const tok = li.d && li.d.token;
      const mk = await call('POST', '/api/traders',
        { name: 'STALE SELLER', cr: 'CR.', pan: 'ABCDE1234F', tel: '9790744444' }, tok);
      const tid = mk.d && mk.d.trader && mk.d.trader.id;
      if (tid) {
        edit = await call('PUT', `/api/traders/${tid}`, {
          name: 'STALE SELLER EDITED', cr: 'CR.', pan: 'ABCDE1234F', tel: '9790744444',
          banks: [{ bank_name: 'SBI', acctnum: '1', ifsc: 'SBIN0001234', is_default: 1 }],
        }, tok);
        saved = await call('GET', `/api/traders/${tid}`, null, tok);
      }
    }
    try { p.kill('SIGKILL'); } catch (_) {}
    setTimeout(() => {
      try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
      resolve({ exited, out, alive, edit, saved });
    }, 300);
  });
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  console.log('[boot] a build missing the export still serves');
  const boot = await bootWithBrokenModule();
  // The whole point of the revision: it must NOT die. An exit here means the
  // app is down for every screen because one helper is missing.
  check('the server starts and answers', boot.alive === true && boot.exited === null,
        `alive=${boot.alive} exit=${boot.exited} :: ` + boot.out.split('\n').filter(l => l.trim()).slice(-4).join(' | '));
  check('…shouting about the inconsistent build on stderr',
        /INCONSISTENT BUILD/.test(boot.out) && /syncTraderBanks/.test(boot.out),
        boot.out.split('\n').filter(l => /INCONSIST|Missing/.test(l)).join(' | ') || '(no banner)');
  check('a seller edit against it is NOT reported as failed',
        !!boot.edit && boot.edit.status === 200,
        boot.edit ? `HTTP ${boot.edit.status}` : 'edit never ran');
  check('…the edit actually saved',
        !!boot.saved && (boot.saved.d || {}).name === 'STALE SELLER EDITED',
        boot.saved ? String((boot.saved.d || {}).name) : 'no read-back');
  check('…and the operator is told the BANKS are what failed',
        !!boot.edit && /bank/i.test(boot.edit.d.warning || ''),
        boot.edit ? String(boot.edit.d.warning) : 'n/a');

  // ══ [save] the normal path, then the failing one ═══════════════
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.log('login failed\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }

  console.log('\n[save] a healthy edit');
  const bank = { bank_name: 'SBI', branch: 'MAIN', acctnum: '123456789012',
                 ifsc: 'SBIN0001234', holder_name: 'A', account_type: 'SB', is_default: 1 };
  const made = await api('POST', '/api/traders',
    { name: 'BANK SELLER', cr: 'CR.', pan: 'ABCDE1234F', tel: '9790744444', banks: [bank] });
  const tid = made.d && made.d.trader && made.d.trader.id;
  check('seller created with a bank', !!tid, JSON.stringify(made.d).slice(0, 200));

  const ok = await api('PUT', `/api/traders/${tid}`,
    { name: 'BANK SELLER EDITED', cr: 'CR.', pan: 'ABCDE1234F', tel: '9790744444', banks: [bank] });
  check('a clean edit answers 200', ok.status === 200, `HTTP ${ok.status}`);
  check('…with no warning', !ok.d.warning, String(ok.d.warning));
  const after = await api('GET', `/api/traders/${tid}`);
  check('…and the edit landed', (after.d.name || '') === 'BANK SELLER EDITED', after.d.name);

  // Force the sync to blow up mid-save the way the live install did. A bank
  // row whose acctnum is an object cannot be bound by the driver, so
  // syncTraderBanks throws from inside the INSERT.
  console.log('\n[save] the bank sync fails mid-edit');
  const bad = await api('PUT', `/api/traders/${tid}`, {
    name: 'BANK SELLER SECOND', cr: 'CR.', pan: 'ABCDE1234F', tel: '9790744444',
    banks: [{ bank_name: 'SBI', acctnum: { nope: 1 }, ifsc: { nope: 1 }, is_default: 1 }],
  });
  // Whatever the driver does with that row, the CONTRACT must hold: the save
  // is never reported as failed once the trader row has been written.
  check('the save is not reported as a failure', bad.status === 200,
        `HTTP ${bad.status} ${JSON.stringify(bad.d).slice(0, 200)}`);
  const after2 = await api('GET', `/api/traders/${tid}`);
  check('the seller edit still landed', (after2.d.name || '') === 'BANK SELLER SECOND', after2.d.name);
  if (bad.d && bad.d.warning) {
    check('the warning names the banks, not the save',
          /bank/i.test(bad.d.warning) && /saved/i.test(bad.d.warning), bad.d.warning);
    // A driver can reject a bad bind with a value that has no .message; the
    // operator must not be handed "…could not be updated: undefined".
    check('…and it says something about the cause',
          !/undefined\s*$/.test(bad.d.warning), bad.d.warning);
    console.log('         warning: ' + bad.d.warning);
  } else {
    // The driver accepted the row rather than throwing — fine, but then the
    // accounts must actually be there. Either way, no 500 for a saved edit.
    check('no warning means the accounts were written',
          Array.isArray(after2.d.banks), JSON.stringify(after2.d.banks || null).slice(0, 160));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + (e && e.stack || e) + '\n' + srvLog.slice(-3000)); cleanup(); process.exit(1); });
