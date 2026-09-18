// HOW-TO GUIDE → the two "it stopped working" posters, and the deep link the
// Settings cards use to reach them.
//
// Both paid services are topped up OUTSIDE this app — credits at the GST
// provider, a card at Meta — so the guide is where the recharge steps live
// (RECHARGE-GSTIN-WHATSAPP.md is the same material in long form). What must
// hold:
//
//   [A] /help.html#<poster id> opens that poster directly, not the tile list.
//       Without it, "How do I recharge?" would dump the operator on 37 tiles
//   [B] a fragment nav switches posters on an ALREADY-loaded guide — that is
//       the cheap path openHelpOverlay(id) takes once the iframe exists
//   [C] "back to all screens" drops the fragment, so a reload lands on the
//       tiles rather than back on the poster just left
//   [D] the cards in Settings → Integrations really do carry the button, and
//       clicking it lands the iframe on the right poster
//
// Driven in a real headless Chrome; skips cleanly where no Chrome exists.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'help-rc-'));
const PORT = 47519;
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
  await fetch(B + '/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
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
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.setViewport({ width: 1400, height: 1000 });

  console.log('\n[A] a fragment opens its poster straight away');
  await page.goto(B + '/help.html#gstrecharge', { waitUntil: 'networkidle0' });
  let g = await page.evaluate(() => ({
    poster: getComputedStyle(document.getElementById('poster')).display,
    home:   getComputedStyle(document.getElementById('home')).display,
    title:  document.querySelector('#poster-body h2')?.textContent || '',
    count:  document.getElementById('coach-count')?.textContent || '',
  }));
  check('the poster is showing, the tiles are not', g.poster === 'block' && g.home === 'none', JSON.stringify(g));
  check('it is the GST recharge walkthrough', /Recharge GST lookup credits/.test(g.title), g.title);
  check('its tour starts at step 1', /Step 1 of 4/.test(g.count), g.count);

  console.log('\n[B] a fragment nav switches posters without a reload');
  await page.evaluate(() => location.replace('/help.html#warecharge'));
  await new Promise(r => setTimeout(r, 300));
  g = await page.evaluate(() => ({
    title: document.querySelector('#poster-body h2')?.textContent || '',
    count: document.getElementById('coach-count')?.textContent || '',
  }));
  check('now on the WhatsApp poster', /Recharge WhatsApp/.test(g.title), g.title);
  check('its tour starts at step 1', /Step 1 of 4/.test(g.count), g.count);

  console.log('\n[C] leaving a poster drops the fragment');
  await page.evaluate(() => showHome());
  g = await page.evaluate(() => ({ hash: location.hash, home: getComputedStyle(document.getElementById('home')).display }));
  check('hash cleared, tiles back', g.hash === '' && g.home === 'block', JSON.stringify(g));
  const tiles = await page.evaluate(() => [...document.querySelectorAll('#tilewrap .tile b')].map(x => x.textContent));
  check('both posters are listed as tiles',
    tiles.includes('Recharge GST lookup credits') && tiles.includes('Recharge WhatsApp'),
    tiles.filter(x => /Recharge/.test(x)).join(' | '));
  await page.goto(B + '/help.html', { waitUntil: 'networkidle0' });
  check('no fragment still shows the tiles',
    await page.evaluate(() => getComputedStyle(document.getElementById('home')).display) === 'block');

  console.log('\n[D] the Settings cards reach the guide');
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
  await page.waitForFunction(() => /How do I recharge/.test(document.getElementById('gst-api-status-host')?.innerHTML || ''), { timeout: 15000 })
    .then(() => check('the GST card carries the button', true))
    .catch(() => check('the GST card carries the button', false));

  // Open the WhatsApp Usage pane so its card renders, then use its button.
  await page.evaluate(() => { if (typeof _waSetTab === 'function') _waSetTab('usage'); });
  await page.waitForFunction(() => /How do I recharge/.test(document.getElementById('whatsapp-usage-host')?.innerHTML || ''), { timeout: 20000 })
    .then(() => check('the WhatsApp usage card carries the button', true))
    .catch(() => check('the WhatsApp usage card carries the button', false));

  await page.evaluate(() => openHelpOverlay('warecharge'));
  await page.waitForFunction(() => {
    const f = document.querySelector('#help-ov iframe');
    try { return f && f.contentDocument?.querySelector('#poster-body h2')?.textContent.includes('Recharge WhatsApp'); }
    catch (_) { return false; }
  }, { timeout: 20000 }).then(() => check('clicking through lands on the WhatsApp poster', true))
    .catch(() => check('clicking through lands on the WhatsApp poster', false));
  check('the overlay is open',
    await page.evaluate(() => getComputedStyle(document.getElementById('help-ov')).display) === 'flex');

  // Second call, iframe already loaded — the fragment-nav path.
  await page.evaluate(() => openHelpOverlay('gstrecharge'));
  await page.waitForFunction(() => {
    const f = document.querySelector('#help-ov iframe');
    try { return f && f.contentDocument?.querySelector('#poster-body h2')?.textContent.includes('Recharge GST lookup credits'); }
    catch (_) { return false; }
  }, { timeout: 20000 }).then(() => check('a second call re-aims the loaded iframe', true))
    .catch(() => check('a second call re-aims the loaded iframe', false));

  console.log('\npage errors: ' + (errs.length ? errs.join(' | ') : 'none'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(log.slice(-2000)); cleanup(); process.exit(1); });
