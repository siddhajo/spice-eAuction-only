// Lot Entry — Litre Wt / Moisture as a PICK LIST instead of a typed box.
//
// Settings → Lot Entry Screen holds one value list per field
// (litre_options / moisture_options). Blank is the default and must leave
// both fields exactly as they were — a typed number — because every install
// that never fills them in is relying on that. Fill one in and the field
// becomes a dropdown on the desktop console, the mobile Lot Entry form and
// the mobile Edit Lot sheet.
//
// Three things this must NOT break:
//   • A blank list still gives a typed <input>, and clearing a list hands
//     the typed box back.
//   • A value already saved on a lot but missing from the list survives
//     being loaded into the form — the list restricts what can be PICKED,
//     it must never rewrite what was RECORDED.
//   • "310-600:10" has to expand to 310, 320 … 600 exactly (30 values), and
//     "6.1-7.5:0.1" to 6.1 … 7.5 without float drift (no 6.300000000000001).
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'le-choice-'));
const PORT = 47381;
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

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', b => { srvLog += b.toString(); });
srv.stderr.on('data', b => { srvLog += b.toString(); });
let browser = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  console.log('[1] The keys ship blank — no install changes behaviour on upgrade');
  const flat0 = await api('GET', '/api/company-settings/flat');
  check('litre_options exists and is blank',
        flat0.d && flat0.d.litre_options === '', JSON.stringify(flat0.d && flat0.d.litre_options));
  check('moisture_options exists and is blank',
        flat0.d && flat0.d.moisture_options === '', JSON.stringify(flat0.d && flat0.d.moisture_options));
  const cfg0 = await api('GET', '/api/config');
  check('the mobile config carries both, blank',
        cfg0.d && cfg0.d.litreOptions === '' && cfg0.d.moistureOptions === '',
        JSON.stringify({ l: cfg0.d && cfg0.d.litreOptions, m: cfg0.d && cfg0.d.moistureOptions }));

  let chrome = null;
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) {
    try {
      const mod = require('@sparticuz/chromium');
      const chromium = mod && mod.default ? mod.default : mod;
      const ep = await chromium.executablePath();
      if (ep) chrome = { executablePath: ep, args: (chromium.args || ['--no-sandbox']) };
    } catch (_) {}
  }
  if (!chrome) {
    console.log('  skip no Chrome available — UI checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    cleanup(); process.exit(fail ? 1 : 0);
  }
  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });

  // ══ DESKTOP ══════════════════════════════════════════════════════
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => { if (typeof showTab === 'function') showTab('lotentry'); });
  await page.waitForSelector('#le-litre', { timeout: 15000 });

  console.log('\n[2] Blank list — the field is still a typed box');
  let tag = await page.evaluate(() => document.getElementById('le-litre').tagName);
  check('Litre Wt is an <input>', tag === 'INPUT', tag);

  console.log('\n[3] The range syntax expands the way the range reads');
  const parsed = await page.evaluate(() => ({
    litre: parseChoiceValues('310-600:10'),
    mst:   parseChoiceValues('6.1-7.5:0.1'),
    mixed: parseChoiceValues('310-600:10, 620, 650'),
    plain: parseChoiceValues('5, 10, 15'),
    junk:  parseChoiceValues('   '),
    capped: parseChoiceValues('0-1000000:0.001').length,
  }));
  check('310-600:10 gives 30 values', parsed.litre.length === 30, String(parsed.litre.length));
  check('…from 310 to 600', parsed.litre[0] === '310' && parsed.litre[29] === '600',
        JSON.stringify([parsed.litre[0], parsed.litre[29]]));
  check('6.1-7.5:0.1 gives 15 values', parsed.mst.length === 15, String(parsed.mst.length));
  check('…with one decimal and no float drift',
        parsed.mst.join(',') === '6.1,6.2,6.3,6.4,6.5,6.6,6.7,6.8,6.9,7.0,7.1,7.2,7.3,7.4,7.5',
        parsed.mst.join(','));
  check('a range takes loose extras alongside it',
        parsed.mixed.length === 32 && parsed.mixed[31] === '650', JSON.stringify(parsed.mixed.slice(-3)));
  check('a plain comma list works', parsed.plain.join(',') === '5,10,15', parsed.plain.join(','));
  check('blank means no list', parsed.junk.length === 0, String(parsed.junk.length));
  check('a runaway range is capped, not hung', parsed.capped === 2000, String(parsed.capped));

  console.log('\n[4] With lists set, both fields become dropdowns');
  await api('PUT', '/api/company-settings', { settings: {
    litre_options: '310-600:10', moisture_options: '6.1-7.5:0.1', show_moisture: 'true',
  } });
  await page.evaluate(() => loadLotEntry());
  await new Promise(r => setTimeout(r, 800));
  const st = await page.evaluate(() => {
    const l = document.getElementById('le-litre'), m = document.getElementById('le-moisture');
    return {
      lTag: l.tagName, mTag: m.tagName,
      lOpts: Array.from(l.options).map(o => o.value),
      mOpts: Array.from(m.options).map(o => o.value),
      lId: l.id, lStyleKept: /border-radius/.test(l.getAttribute('style') || ''),
    };
  });
  check('Litre Wt is a <select>', st.lTag === 'SELECT', st.lTag);
  check('Moisture is a <select>', st.mTag === 'SELECT', st.mTag);
  check('it offers a blank plus the 30 litre values',
        st.lOpts.length === 31 && st.lOpts[0] === '' && st.lOpts[1] === '310' && st.lOpts[30] === '600',
        JSON.stringify(st.lOpts.slice(0, 3)) + ' … ' + JSON.stringify(st.lOpts.slice(-1)));
  check('and a blank plus the 15 moisture values',
        st.mOpts.length === 16 && st.mOpts[1] === '6.1' && st.mOpts[15] === '7.5',
        JSON.stringify(st.mOpts.length));
  check('the field keeps its id', st.lId === 'le-litre');
  check('and its look', st.lStyleKept === true);

  console.log('\n[5] Picking a value reads back exactly like the typed box did');
  const picked = await page.evaluate(() => {
    const l = document.getElementById('le-litre');
    l.value = '450';
    return { value: l.value, asInt: parseInt(l.value, 10) };
  });
  check('the select reads back its value', picked.value === '450', picked.value);
  check('and parses as the same number', picked.asInt === 450, String(picked.asInt));

  console.log('\n[6] A lot recorded OFF the list still loads — the figure is not wiped');
  const off = await page.evaluate(() => {
    const l = document.getElementById('le-litre');
    l.value = '305';                       // a lot saved before the list existed
    const shown = l.value;
    l.value = '470';                       // move to a listed value
    const after = l.value;
    const stale = Array.from(l.options).filter(o => o.value === '305').length;
    return { shown, after, stale };
  });
  check('the off-list value survives being loaded', off.shown === '305', off.shown);
  check('and picking a listed value still works', off.after === '470', off.after);
  check('the off-list entry does not linger in the list', off.stale === 0, String(off.stale));

  console.log('\n[6b] "7" and "7.0" are the same moisture reading');
  const same = await page.evaluate(() => {
    const m = document.getElementById('le-moisture');
    m.value = 7;                            // as stored on an older lot
    return { value: m.value, adhoc: Array.from(m.options).filter(o => o.dataset.adhoc === '1').length };
  });
  check('a lot recorded 7 selects the list\'s 7.0', same.value === '7.0', same.value);
  check('without inventing an off-list entry', same.adhoc === 0, String(same.adhoc));

  console.log('\n[7] Clearing the setting hands the typed box back');
  await api('PUT', '/api/company-settings', { settings: { litre_options: '' } });
  await page.evaluate(() => loadLotEntry());
  await new Promise(r => setTimeout(r, 800));
  const back = await page.evaluate(() => {
    const l = document.getElementById('le-litre');
    return { tag: l.tagName, type: l.getAttribute('type'), mTag: document.getElementById('le-moisture').tagName };
  });
  check('Litre Wt is a typed box again', back.tag === 'INPUT', back.tag);
  check('…of the type it always was', back.type === 'number', String(back.type));
  check('and Moisture, still listed, stays a dropdown', back.mTag === 'SELECT', back.mTag);

  // ══ MOBILE ═══════════════════════════════════════════════════════
  console.log('\n[8] Mobile Lot Entry + Edit Lot sheet follow the same lists');
  await api('PUT', '/api/company-settings', { settings: { litre_options: '310-600:10' } });
  const mob = await browser.newPage();
  mob.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(B + '/mobile/', { waitUntil: 'networkidle2' });
  await mob.waitForSelector('#le-litre', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));
  const ms = await mob.evaluate(() => {
    const l = document.getElementById('le-litre'), e = document.getElementById('ed-litre');
    const m = document.getElementById('le-moisture');
    return {
      lTag: l.tagName, eTag: e.tagName, mTag: m.tagName,
      lClass: l.className,
      lCount: l.options ? l.options.length : 0,
      strayClear: !!(l.parentNode && l.parentNode.querySelector && l.parentNode.querySelector('.fld-clear')),
    };
  });
  check('the entry form Litre Wt is a <select>', ms.lTag === 'SELECT', ms.lTag);
  check('the Edit Lot sheet follows it', ms.eTag === 'SELECT', ms.eTag);
  check('Moisture, also listed, is a <select>', ms.mTag === 'SELECT', ms.mTag);
  check('it keeps the entry-field styling', ms.lClass === 'ein', ms.lClass);
  check('with the blank + 30 values', ms.lCount === 31, String(ms.lCount));
  check('and no orphaned ✕ clear button beside it', ms.strayClear === false);

  console.log('\n[9] Mobile Edit Lot keeps a value the list does not carry');
  const me = await mob.evaluate(() => {
    const e = document.getElementById('ed-litre');
    e.value = 305;                    // openEdit() assigns the raw lot value
    const shown = e.value;
    e.value = 500;
    return { shown, listed: e.value };
  });
  check('an off-list litre weight is preserved', me.shown === '305', me.shown);
  check('and a listed one selects normally', me.listed === '500', me.listed);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
