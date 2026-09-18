// SETTINGS → INTEGRATIONS — the panel that is live cards, not a form.
//
// Every other settings category is a list of field groups. Integrations is
// the GST status card + the WhatsApp panel + a handful of fields, laid out as
// collapsible sections of its own (see renderIntegrationSections in
// public/index.html). WhatsApp used to own THREE of those sections — setup,
// usage, send log — each drawing its own bordered card inside the section's
// own header; they are now one section with three tabs. Four things must hold:
//
//   [A] the "which key box is live?" note follows the provider dropdown
//       immediately — before any save — because a key pasted into the idle
//       box is silently ignored, which looks exactly like a key that is wrong
//   [B] collapsing hides a section, it does not REMOVE it: captureCurrentPanel
//       harvests `#settings-root [data-key]`, so a removed field would be
//       dropped from the next save with no error at all
//   [C] the card hosts are still hydrated after a collapse/expand round — and
//       the send log, deferred because most visits never open it, fills the
//       first time its tab is clicked
//   [D] exactly one tab pane is visible at a time
//
// Driven in a real headless Chrome; skips cleanly where no Chrome exists.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'set-int-'));
const PORT = 47412;
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', b => log += b); srv.stderr.on('data', b => log += b);
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await (await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const TOKEN = login.token;
  await fetch(B + '/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ username: 'uiadmin', password: 'pw1234', role: 'admin' }),
  });

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`
${pass} passed, ${fail} failed
`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.setViewport({ width: 1400, height: 1000 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  await page.waitForFunction(() => document.body.hasAttribute('data-feat-whatsapp') && !!window._currentTab, { timeout: 20000 });
  await page.evaluate(() => go('settings'));
  await new Promise(r => setTimeout(r, 1200));
  await page.evaluate(() => selectCat('integrations'));
  await new Promise(r => setTimeout(r, 2000));

  console.log('[A] the note follows the provider dropdown, before any save');
  let notes = await page.evaluate(() => {
    const sel = document.querySelector('[data-key="gst_api_provider"]');
    sel.value = 'gstinapi';
    sel.dispatchEvent(new Event('change'));
    return [...document.querySelectorAll('[data-gst-key-note]')]
      .map(n => n.dataset.gstKeyNote + ': ' + n.textContent.trim());
  });
  check('gstinapi marked in use', /gstinapi: ● In use/.test(notes.join('|')), notes.join('|'));
  check('gstincheck marked idle', /gstincheck: ○ Not in use/.test(notes.join('|')), notes.join('|'));
  notes = await page.evaluate(() => {
    const sel = document.querySelector('[data-key="gst_api_provider"]');
    sel.value = 'gstincheck';
    sel.dispatchEvent(new Event('change'));
    return [...document.querySelectorAll('[data-gst-key-note]')]
      .map(n => n.dataset.gstKeyNote + ': ' + n.textContent.trim());
  });
  check('switching back flips them', /gstincheck: ● In use/.test(notes.join('|')), notes.join('|'));

  console.log('\n[B] a value typed inside a COLLAPSED section still saves');
  await page.evaluate(() => {
    document.querySelector('[data-key="gst_api_key"]').value = 'TYPEDKEY';
    document.querySelector('[data-key="gst_api_provider"]').value = 'gstinapi';
    document.querySelector('[data-key="gst_api_key_gstinapi"]').value = 'OTHERKEY';
    // Collapse every section, then save — the body is display:none, not gone.
    toggleAllSetGroups();
  });
  const collapsed = await page.evaluate(() =>
    [...document.querySelectorAll('#settings-root .set-group')].every(c => !c.classList.contains('open')));
  check('collapse-all closed every section', collapsed);
  check('the fields are still in the DOM while collapsed',
        await page.evaluate(() => !!document.querySelector('[data-key="gst_api_key"]')));
  await page.evaluate(() => saveSettings());
  await new Promise(r => setTimeout(r, 2500));
  const flat = await (await fetch(B + '/api/company-settings/flat', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  check('gstincheck key saved', flat.gst_api_key === 'TYPEDKEY', flat.gst_api_key);
  check('gstinapi key saved', flat.gst_api_key_gstinapi === 'OTHERKEY', flat.gst_api_key_gstinapi);
  check('provider saved', flat.gst_api_provider === 'gstinapi', flat.gst_api_provider);

  console.log('\n[C] expand-all brings them back, hosts still hydrated');
  await page.evaluate(() => toggleAllSetGroups());
  await new Promise(r => setTimeout(r, 800));
  const sizes = () => page.evaluate(() => ({
    gst: (document.getElementById('gst-api-status-host') || {}).innerHTML?.length || 0,
    wa: (document.getElementById('whatsapp-config-host') || {}).innerHTML?.length || 0,
    usage: (document.getElementById('whatsapp-usage-host') || {}).innerHTML?.length || 0,
    logh: (document.getElementById('whatsapp-log-host') || {}).innerHTML?.length || 0,
  }));
  const hosts = await sizes();
  check('GST, setup and overview cards are filled',
    hosts.gst > 200 && hosts.wa > 200 && hosts.usage > 200, JSON.stringify(hosts));
  // The log is a fetch of up to 500 rows that most visits never look at, so it
  // waits for its tab. Filling it eagerly is the thing this pins against.
  check('the send log waits for its tab', hosts.logh === 0, JSON.stringify(hosts));
  await page.evaluate(() => _waSetTab('log'));
  await new Promise(r => setTimeout(r, 1200));
  check('opening the Send log tab fills it', (await sizes()).logh > 200, JSON.stringify(await sizes()));

  console.log('\n[D] one WhatsApp section, three tabs, one pane at a time');
  const tabs = await page.evaluate(() => ({
    sections: [...document.querySelectorAll('#settings-root .set-group-head h3')].map(h => h.textContent.trim()),
    count: document.querySelectorAll('#settings-root .wa-tab').length,
    visible: [...document.querySelectorAll('#settings-root [data-wapane]')].filter(p => !p.hidden).map(p => p.dataset.wapane),
    on: [...document.querySelectorAll('#settings-root .wa-tab.on')].map(b => b.dataset.watab),
  }));
  check('WhatsApp is one section, not three',
    tabs.sections.filter(t => /WhatsApp/i.test(t)).length === 1, JSON.stringify(tabs.sections));
  check('it carries three tabs', tabs.count === 3, String(tabs.count));
  check('only the chosen pane is showing',
    tabs.visible.length === 1 && tabs.visible[0] === 'log' && tabs.on.join() === 'log', JSON.stringify(tabs));

  // Screenshots of each tab — the panel is judged by eye, so leave one behind.
  const shots = [];
  for (const t of ['overview', 'setup', 'log']) {
    await page.evaluate((x) => _waSetTab(x), t);
    await new Promise(r => setTimeout(r, 400));
    const f = path.join(os.tmpdir(), `integrations-${t}.png`);
    await page.screenshot({ path: f, fullPage: true });
    shots.push(f);
  }
  console.log('  screenshots:\n    ' + shots.join('\n    '));

  console.log('\npage errors: ' + (errs.length ? errs.join(' | ') : 'none'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); cleanup(); process.exit(1); });
