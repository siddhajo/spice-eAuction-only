// Backups — the server-side snapshot folder: list, download, take one now.
//
// The list endpoint already existed but nothing called it, and there was no way
// to GET a snapshot back off the server — which made the whole folder useless
// to exactly the people who need a backup, the ones without shell access to the
// machine. The download route is new, so its path guard is the important part
// here: `name` must stay inside the backup directory however it is spelled.
//
// The scheduled runs now land in this folder too (kind:'auto'), which is only
// safe because they prune: each snapshot is a full copy of the database, so an
// hourly schedule with no cap fills the disk. Auto snapshots prune; the ones a
// person asked for, and the ones taken before a wipe, never do.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-snap-'));
const PORT = 47371;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
// Raw fetch — the download returns a binary body, not JSON.
async function raw(url) {
  const r = await fetch(B + url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, cd: r.headers.get('Content-Disposition') || '' };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', b => { log += b.toString(); });
srv.stderr.on('data', b => { log += b.toString(); });
function done(code) {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}
const bkDir = () => path.join(TMP, 'backups');
const listAutos = () => (fs.existsSync(bkDir()) ? fs.readdirSync(bkDir()) : []).filter(f => /^auto-.*\.db$/.test(f));

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', log.slice(-2000)); done(1); }
  console.log('logged in\n');

  console.log('[1] An untouched install lists nothing rather than erroring');
  let l = await api('GET', '/api/system/backups');
  check('list responds 200', l.status === 200, `got ${l.status}`);
  check('with an empty array', Array.isArray(l.d && l.d.backups) && l.d.backups.length === 0,
        JSON.stringify(l.d));

  console.log('\n[2] Snapshot now — taken by hand');
  const man = await api('POST', '/api/system/backup-now', {});
  check('responds 200', man.status === 200, `got ${man.status}`);
  check('names the file manual-…', /^manual-.*\.db$/.test(String(man.d && man.d.file || '')),
        JSON.stringify(man.d && man.d.file));
  check('reports a real size', Number(man.d && man.d.size) > 0, JSON.stringify(man.d && man.d.size));
  l = await api('GET', '/api/system/backups');
  check('and it is listed', (l.d.backups || []).some(f => f.name === man.d.file), JSON.stringify(l.d.backups));

  console.log('\n[3] Download — the whole point of listing them');
  const dl = await raw('/api/system/backups/' + encodeURIComponent(man.d.file));
  check('responds 200', dl.status === 200, `got ${dl.status}`);
  check('as an attachment under its own name', dl.cd.includes(man.d.file), dl.cd);
  check('with the file\'s bytes', dl.buf.length === Number(man.d.size),
        `${dl.buf.length} vs ${man.d.size}`);
  check('which really is a SQLite database', dl.buf.slice(0, 15).toString() === 'SQLite format 3',
        JSON.stringify(dl.buf.slice(0, 15).toString()));
  const onDisk = fs.readFileSync(path.join(bkDir(), man.d.file));
  check('byte-for-byte what is on the server', dl.buf.equals(onDisk));

  console.log('\n[4] The download cannot be walked out of the backup folder');
  // The live DB sits one level up from data/backups — the obvious target.
  for (const bad of ['../config.db', '..%2Fconfig.db', '....//config.db', 'sub/other.db', '.db', 'no-such-file.db']) {
    const r = await raw('/api/system/backups/' + encodeURIComponent(bad));
    check(`"${bad}" is refused`, r.status === 400 || r.status === 404, `got ${r.status}`);
    check(`"${bad}" returns no database bytes`, r.buf.slice(0, 15).toString() !== 'SQLite format 3',
          r.buf.slice(0, 40).toString());
  }
  // Not a path at all, but a name the pattern would take — proves the
  // existence check, not just the shape check, is doing work.
  const missing = await raw('/api/system/backups/auto-9999-99-99-99-99-99.db');
  check('a well-formed name that does not exist → 404', missing.status === 404, `got ${missing.status}`);

  console.log('\n[5] Scheduled snapshots are named apart and pruned');
  await api('PUT', '/api/company-settings', { settings: { backup_keep_count: '3' } });
  const madeInOrder = [];      // oldest → newest, as the server named them
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/system/backup-now', { kind: 'auto' });
    if (r.status !== 200) { check('auto snapshot ' + i + ' responds 200', false, `got ${r.status}`); break; }
    madeInOrder.push(r.d.file);
    // Filenames carry a whole-second stamp, so back-to-back calls would
    // overwrite each other rather than pile up.
    await new Promise(r2 => setTimeout(r2, 1100));
  }
  const autos = listAutos();
  check('five distinct scheduled snapshots were taken', new Set(madeInOrder).size === 5,
        JSON.stringify(madeInOrder));
  check('auto snapshots are named auto-…', autos.length > 0 && autos.every(f => f.startsWith('auto-')),
        JSON.stringify(autos));
  check('pruned to the keep count of 3', autos.length === 3, `${autos.length}: ${autos.join(', ')}`);
  // The three most recently WRITTEN survive and the first two are gone —
  // pruning the wrong end would leave a folder of stale copies.
  const kept = new Set(autos);
  check('the three kept are the newest three', madeInOrder.slice(2).every(f => kept.has(f)),
        `kept ${JSON.stringify(autos)} of ${JSON.stringify(madeInOrder)}`);
  check('the two oldest were deleted', madeInOrder.slice(0, 2).every(f => !kept.has(f)),
        `kept ${JSON.stringify(autos)} of ${JSON.stringify(madeInOrder)}`);

  console.log('\n[6] Pruning never touches what a person asked for');
  check('the by-hand snapshot survived 5 scheduled runs',
        fs.existsSync(path.join(bkDir(), man.d.file)), man.d.file);
  // A before-delete snapshot is the undo for a wipe — the last thing to bin.
  fs.writeFileSync(path.join(bkDir(), 'before-delete-invoices-2020-01-01T00-00-00.db'), 'x');
  await api('POST', '/api/system/backup-now', { kind: 'auto' });
  check('a before-delete snapshot survives too',
        fs.existsSync(path.join(bkDir(), 'before-delete-invoices-2020-01-01T00-00-00.db')));
  check('and auto snapshots are still capped at 3', listAutos().length === 3,
        JSON.stringify(listAutos()));

  console.log('\n[7] Everything here is admin-only');
  const saveTok = TOKEN;
  TOKEN = '';
  const noAuth = await api('GET', '/api/system/backups');
  check('listing without a token is refused', noAuth.status === 401 || noAuth.status === 403, `got ${noAuth.status}`);
  const noAuthDl = await raw('/api/system/backups/' + encodeURIComponent(man.d.file));
  check('downloading without a token is refused', noAuthDl.status === 401 || noAuthDl.status === 403,
        `got ${noAuthDl.status}`);
  check('and hands back no database bytes', noAuthDl.buf.slice(0, 15).toString() !== 'SQLite format 3');
  TOKEN = saveTok;

  console.log('\n[8] The list is newest-first, so the emergency copy is on top');
  l = await api('GET', '/api/system/backups');
  const times = (l.d.backups || []).map(f => f.mtime);
  check('mtimes descend', times.every((t, i) => i === 0 || times[i - 1] >= t), JSON.stringify(times));
  check('every row carries name, size and mtime',
        (l.d.backups || []).every(f => f.name && Number(f.size) >= 0 && Number(f.mtime) > 0),
        JSON.stringify(l.d.backups && l.d.backups[0]));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(log.slice(-2000));
  done(fail ? 1 : 0);
})().catch(e => { console.error(e, log.slice(-2000)); done(1); });
