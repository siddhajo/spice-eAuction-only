// Text Size control — measured in a real headless Chrome, on both the
// desktop console and the mobile PWA.
//
// The three things that actually matter:
//   [A] At the default step the rendering is UNCHANGED. The whole feature
//       is opt-in, and the viewport-unit rewrite (100vh → calc(100vh /
//       var(--zf))) touched 56 declarations across both files — this is
//       what proves that rewrite is a no-op at --zf:1.
//   [B] Stepping up genuinely enlarges the detail text that the old
//       Comfort Mode could never reach: inline-styled table cells, pills
//       and hint text.
//   [C] Nothing breaks at the largest step — no horizontal overflow, and
//       the mobile full-height screen still fits the phone exactly
//       (the failure mode the dvh compensation exists to prevent).
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'textsize-ui-'));
const PORT = 47337;
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

// Rendered height of an element's text box, in physical px. Under `zoom`,
// getBoundingClientRect() reports the SCALED box — which is exactly what
// the user's eye sees, and therefore what we want to assert on.
const MEASURE = `(() => {
  // When the document is wider than the viewport, name the element driving
  // it — an assertion that just says "1607 > 1440" sends you hunting.
  // position:fixed elements are excluded: several banners in this app are
  // deliberately parked off-screen (e.g. #rr-notif at translateX(120%))
  // and never contribute to document scrollWidth.
  let worst = null;
  const de = document.documentElement;
  if (de.scrollWidth > window.innerWidth + 1) {
    let best = 0;
    document.querySelectorAll('*').forEach(e => {
      const cs = getComputedStyle(e);
      if (cs.position === 'fixed') return;
      const b = e.getBoundingClientRect();
      if (b.width > 0 && b.right > window.innerWidth + 1 && b.right > best) {
        best = b.right;
        worst = e.tagName + (e.id ? '#' + e.id : '') +
                (e.className ? '.' + String(e.className).trim().split(/\\s+/).join('.').slice(0, 40) : '') +
                ' w=' + Math.round(b.width) + ' right=' + Math.round(b.right) +
                ' parent=' + (e.parentElement ? e.parentElement.tagName +
                  (e.parentElement.id ? '#' + e.parentElement.id : '') +
                  (e.parentElement.className ? '.' + String(e.parentElement.className).trim().split(/\\s+/)[0] : '') : '-');
      }
    });
  }
  return {
    zf: getComputedStyle(de).getPropertyValue('--zf').trim(),
    docW: de.scrollWidth,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    worst,
  };
})()`;

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, boot.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('PUT', '/api/company-settings', { settings: { br1: 'BODINAYAKANUR', br2: 'CUMBUM' } });
  await api('POST', '/api/auctions', { ano: '41', date: '2026-08-21', state: 'TAMIL NADU' });
  // This test keeps the bootstrap `admin` session alive over the API for its
  // fixtures, and single_session (on by default) would rightly refuse a
  // second `admin` sign-in from the browser. Give the UI its own account.
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  // …and the mobile page a third, since the desktop page holds uiadmin's.
  await api('POST', '/api/users', { username: 'mobadmin', password: 'pw1234', role: 'operator' });

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
  if (!chrome) {
    console.log('  skip no Chrome available — UI checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    cleanup(); process.exit(0);
  }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });

  // ══ DESKTOP ════════════════════════════════════════════════════════
  console.log('[A] Desktop — default step is unchanged');
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
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
  await page.evaluate(() => go('users'));
  await page.waitForFunction(() => /admin/.test(document.getElementById('users-list')?.textContent || ''), { timeout: 15000 });
  // DataTable mounts its wrapper/scroller asynchronously after the rows
  // appear. Measuring before that settles reads a transient width and
  // reports overflow that isn't in the painted frame.
  await new Promise(r => setTimeout(r, 900));

  const base = await page.evaluate(MEASURE);
  check('default carries no data-textsize attribute',
        await page.evaluate(() => !document.documentElement.hasAttribute('data-textsize')));
  check('default resolves --zf to 1', base.zf === '1', JSON.stringify(base.zf));
  check('default does not overflow horizontally', base.docW <= base.innerW + 1,
        `scrollWidth ${base.docW} vs innerWidth ${base.innerW}`);

  // Measure a probe carrying an INLINE font-size — the exact shape of the
  // ~1,090 declarations the old Comfort Mode could never reach. A real
  // table cell would be the more natural target, but the app re-renders
  // those from its polls mid-measurement, which makes the reading
  // meaningless. The probe is inert and pinned, so it only ever reflects
  // the scale. `white-space:nowrap` keeps re-wrapping out of the result.
  const PROBE = `(() => {
    let p = document.getElementById('__ts_probe');
    if (!p) {
      p = document.createElement('span');
      p.id = '__ts_probe';
      p.setAttribute('style', 'position:absolute;top:0;left:0;font-size:11px;white-space:nowrap;pointer-events:none;opacity:0');
      p.textContent = 'BODINAYAKANUR 1234.567';
      document.body.appendChild(p);
    }
    const r = p.getBoundingClientRect();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
  })()`;
  const cellAt = async () => page.evaluate(PROBE);
  const cellBase = await cellAt();
  check('probe has a measurable size at the default step', cellBase.w > 0, JSON.stringify(cellBase));

  console.log('\n[B] Desktop — stepping up enlarges the detail text');
  for (const [id, wantZf] of [['lg', 1.15], ['xl', 1.3], ['xxl', 1.45]]) {
    await page.evaluate(s => applyTextSize(s, { silent: true }), id);
    // Let the re-layout settle. Changing zoom reflows the whole document
    // and the DataTable's internal horizontal scroller re-measures itself;
    // reading scrollWidth in the same tick catches it mid-flight and
    // reports overflow that isn't there once painted.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise(r => setTimeout(r, 400));
    const m = await page.evaluate(MEASURE);
    check(`${id}: --zf is ${wantZf}`, Math.abs(parseFloat(m.zf) - wantZf) < 0.001, JSON.stringify(m.zf));
    const cell = await cellAt();
    const ratio = cell.w / cellBase.w;
    check(`${id}: inline-styled 11px text renders ~${wantZf}x bigger`,
          Math.abs(ratio - wantZf) < 0.03, `ratio ${ratio.toFixed(3)} (${cellBase.w} → ${cell.w})`);
    check(`${id}: no horizontal overflow`, m.docW <= m.innerW + 1,
          `scrollWidth ${m.docW} vs innerWidth ${m.innerW} — widest: ${m.worst || 'none found'}`);
  }

  console.log('\n[C] Desktop — the control persists and cycles');
  await page.evaluate(() => applyTextSize('xl', { silent: true }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  check('survives a reload',
        await page.evaluate(() => document.documentElement.getAttribute('data-textsize') === 'xl'));
  check('button label shows the current step',
        (await page.evaluate(() => document.getElementById('comfort-toggle-label').textContent)) === '130%');
  // xl → xxl → md, proving the cycle wraps back to the default.
  await page.evaluate(() => { cycleTextSize(); cycleTextSize(); });
  check('cycles back round to the default',
        await page.evaluate(() => !document.documentElement.hasAttribute('data-textsize')));
  check('and clears the stored step to md',
        await page.evaluate(() => localStorage.getItem('spice_textsize')) === 'md');

  console.log('\n[D] Desktop — old Comfort Mode users are migrated');
  await page.evaluate(() => { localStorage.removeItem('spice_textsize'); localStorage.setItem('comfort', '1'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });
  check('comfort=1 lands on the first step up',
        await page.evaluate(() => document.documentElement.getAttribute('data-textsize') === 'lg'));
  check('and the legacy comfort key is cleared',
        await page.evaluate(() => localStorage.getItem('comfort')) === null);
  check('the retired data-comfort attribute is never set',
        await page.evaluate(() => !document.body.hasAttribute('data-comfort')));

  // ══ MOBILE ═════════════════════════════════════════════════════════
  console.log('\n[E] Mobile — full-height layout survives every step');
  const m2 = await browser.newPage();
  m2.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await m2.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await m2.goto(B + '/mobile', { waitUntil: 'domcontentloaded' });
  await m2.evaluate(() => localStorage.clear());
  await m2.goto(B + '/mobile', { waitUntil: 'domcontentloaded' });
  await m2.waitForSelector('#l-user', { timeout: 15000 });
  await m2.evaluate(() => {
    document.getElementById('l-user').value = 'mobadmin';
    document.getElementById('l-pass').value = 'pw1234';
    doLogin();
  });
  await m2.waitForFunction(() => document.getElementById('s-session')?.classList.contains('active')
                              || document.getElementById('s-lots')?.classList.contains('active'), { timeout: 20000 });

  check('mobile allows pinch-zoom again',
        await m2.evaluate(() => {
          const v = document.querySelector('meta[name="viewport"]').content;
          return !/user-scalable\s*=\s*no/.test(v) && !/maximum-scale/.test(v);
        }),
        await m2.evaluate(() => document.querySelector('meta[name="viewport"]').content));

  // The whole point of the dvh compensation: the active full-height screen
  // must match the phone's viewport at EVERY step, or the bottom nav walks
  // off the bottom of the display.
  const screenFit = async () => m2.evaluate(() => {
    const s = document.querySelector('.screen.active');
    return {
      screenH: Math.round(s.getBoundingClientRect().height),
      innerH: window.innerHeight,
      docW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    };
  });
  for (const [id, label] of [['md', 'default'], ['lg', '115%'], ['xl', '130%'], ['xxl', '145%']]) {
    await m2.evaluate(s => applyTextSize(s, true), id);
    const f = await screenFit();
    check(`mobile ${label}: full-height screen still fits the phone exactly`,
          Math.abs(f.screenH - f.innerH) <= 2, `screen ${f.screenH} vs viewport ${f.innerH}`);
    check(`mobile ${label}: no horizontal overflow`, f.docW <= f.innerW + 1,
          `scrollWidth ${f.docW} vs innerWidth ${f.innerW}`);
  }

  console.log('\n[F] Mobile — the smallest labels actually grow');
  // Same probe approach as the desktop, at 8px — the smallest size this
  // screen uses anywhere, and the hardest to read on a phone.
  const TINY = `(() => {
    let p = document.getElementById('__ts_probe');
    if (!p) {
      p = document.createElement('span');
      p.id = '__ts_probe';
      p.setAttribute('style', 'position:absolute;top:0;left:0;font-size:8px;white-space:nowrap;pointer-events:none;opacity:0');
      p.textContent = 'LITRE WT';
      document.body.appendChild(p);
    }
    const r = p.getBoundingClientRect();
    return Math.round(r.width * 100) / 100;
  })()`;
  await m2.evaluate(() => applyTextSize('md', true));
  const tinyBase = await m2.evaluate(TINY);
  check('8px probe has a measurable size at the default step', tinyBase > 0, String(tinyBase));
  await m2.evaluate(() => applyTextSize('xxl', true));
  const tinyBig = await m2.evaluate(TINY);
  check('8px text renders ~1.45x bigger at the largest step',
        tinyBase > 0 && Math.abs((tinyBig / tinyBase) - 1.45) < 0.03,
        `${tinyBase} → ${tinyBig}`);

  check('mobile step survives a reload', await (async () => {
    await m2.evaluate(() => applyTextSize('lg', true));
    await m2.reload({ waitUntil: 'domcontentloaded' });
    await m2.waitForSelector('#ts-label', { timeout: 15000 });
    return m2.evaluate(() => document.documentElement.getAttribute('data-textsize') === 'lg');
  })());
  check('mobile menu label names the current step',
        /Large/.test(await m2.evaluate(() => document.getElementById('ts-label').textContent)),
        await m2.evaluate(() => document.getElementById('ts-label').textContent));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('test crashed:', e, '\n', srvLog.slice(-3000));
  cleanup();
  process.exit(1);
});
