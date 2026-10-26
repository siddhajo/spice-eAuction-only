// The top bars stay put, and the tabs fold away.
//
// The top bar was already sticky; the tab strip under it was not, so on any
// long screen the tabs scrolled away and changing tab meant scrolling back up.
//
//   [pinned]   both bars are still on screen after scrolling a long page
//   [offset]   the strip sits directly under the bar — the offset is the
//              MEASURED bar height, because it wraps and grows at the larger
//              text-size steps, so a constant would gap or overlap
//   [stack]    they do not overlap each other
//   [fold]     the tabs collapse and come back, and the choice is remembered
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'topbar-'));
const PORT = 48152;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const T = (await (await fetch(B + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json()).token;

  let chrome = null;
  for (const p of [process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = p; break; } } catch (_) {}
  }
  if (!chrome) {
    console.log('  skip no Chrome available');
    console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0);
  }
  browser = await pptr.launch({ executablePath: chrome, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1400, height: 820 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => localStorage.setItem('t', t), T);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1800));
  // A screen whose tab strip is shown, with enough below it to scroll.
  await page.evaluate(() => go('traders'));
  await new Promise(r => setTimeout(r, 1500));

  const geom = () => page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    const strip = document.getElementById('tabstrip');
    const b = bar.getBoundingClientRect(), s = strip.getBoundingClientRect();
    return {
      barTop: Math.round(b.top), barBottom: Math.round(b.bottom),
      stripTop: Math.round(s.top), stripVisible: strip.style.display !== 'none',
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
      stripPosition: getComputedStyle(strip).position,
      barPosition: getComputedStyle(bar).position,
      scrollY: window.scrollY, pageScrolls: document.body.scrollHeight > window.innerHeight,
    };
  });

  console.log('[offset] the strip sits under the MEASURED bar height');
  let g = await geom();
  check('the tab strip is on this screen', g.stripVisible, g);
  check('both bars are sticky', g.barPosition === 'sticky' && g.stripPosition === 'sticky', g);
  check('--topbar-h is measured, not a constant', /^\d+px$/.test(g.cssVar) && parseInt(g.cssVar, 10) > 20, g.cssVar);
  check('…and matches the bar actually rendered',
        Math.abs(parseInt(g.cssVar, 10) - (g.barBottom - g.barTop)) <= 1, g);

  console.log('\n[pinned] both stay on screen once the page scrolls');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 500));
  g = await geom();
  if (!g.pageScrolls) {
    check('the page scrolls (otherwise this proves nothing)', false, g);
  } else {
    check('the page actually scrolled', g.scrollY > 0, g);
    check('the top bar is still at the top', g.barTop <= 1 && g.barTop >= -1, g);
    check('the tab strip is still on screen', g.stripTop >= 0 && g.stripTop < 820, g);
    console.log('\n[stack] they do not overlap');
    check('the strip starts at or below the bar\'s bottom edge', g.stripTop >= g.barBottom - 1, g);
  }

  console.log('\n[fold] the tabs collapse and come back');
  const folded = await page.evaluate(() => {
    toggleTabstrip(true);
    const strip = document.getElementById('tabstrip');
    const rows = [...strip.querySelectorAll('.tabrow')];
    return { collapsed: strip.classList.contains('collapsed'),
             rowsHidden: rows.every(r => getComputedStyle(r).display === 'none'),
             btn: document.getElementById('tabstrip-toggle').textContent.trim(),
             stored: localStorage.getItem('tabstripCollapsed'),
             barStillThere: !!document.querySelector('.topbar').offsetHeight };
  });
  check('the tab rows fold away', folded.collapsed && folded.rowsHidden, folded);
  check('…the top bar stays', folded.barStillThere, folded);
  check('…the handle offers to bring them back', /▾/.test(folded.btn), folded.btn);
  check('…and the choice is remembered', folded.stored === '1', folded);

  const back = await page.evaluate(() => {
    toggleTabstrip(false);
    const rows = [...document.querySelectorAll('#tabstrip .tabrow')];
    return { collapsed: document.getElementById('tabstrip').classList.contains('collapsed'),
             anyShown: rows.some(r => getComputedStyle(r).display !== 'none'),
             stored: localStorage.getItem('tabstripCollapsed') };
  });
  check('they come back', !back.collapsed && back.anyShown, back);
  check('…and that is remembered too', back.stored === '0', back);

  if (process.env.SHOT_DIR) {
    await page.evaluate(() => { toggleTabstrip(false); window.scrollTo(0, 400); });
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: process.env.SHOT_DIR + '/topbar-pinned.png' });
    await page.evaluate(() => toggleTabstrip(true));
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: process.env.SHOT_DIR + '/topbar-folded.png' });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); cleanup(); process.exit(1); });
