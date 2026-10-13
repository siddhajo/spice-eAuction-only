// Settings → Integrations → WhatsApp Business → Send log.
//
// The pane stacks two tables — "Numbers that have never worked" and the send
// log — and both can run to hundreds of rows. Unbounded and stacked, reaching
// the log meant scrolling the whole settings panel past the bad-numbers list.
// Each band is now a collapsible fold with its OWN scroll box and a coloured
// header.
//
//   [bands]   two folds, titled, each with a count badge
//   [colour]  the headers are different colours, and both are legible
//   [scroll]  each band scrolls on its own — one at the bottom leaves the
//             other at the top, which is the whole point
//   [sticky]  column labels survive the scroll inside the band
//   [fold]    clicking a header collapses only that band, and the choice
//             survives a reload
//   [chrome]  the controls that re-scope a list do NOT scroll away with it
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-folds-'));
const PORT = 47398;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// Enough rows in each band that both overflow their box.
const BAD = {
  rows: Array.from({ length: 40 }, (_, i) => ({
    phone: '9800' + String(100000 + i),
    fails: 3 + (i % 5),
    lastAt: '2026-10-0' + (1 + (i % 9)),
    lastError: 'Message undeliverable (no WhatsApp account)',
    owners: [{ kind: 'seller', id: i + 1, name: 'SELLER ' + (i + 1) }],
  })),
};
const LOG = Array.from({ length: 60 }, (_, i) => ({
  phone: '9900' + String(100000 + i),
  caption: 'Invoice ' + (i + 1),
  msg_type: 'document',
  status: ['sent', 'delivered', 'read', 'failed'][i % 4],
  error: i % 4 === 3 ? 'Message undeliverable' : '',
  created_at: '2026-10-12 1' + (i % 10) + ':05:00',
  updated_at: '2026-10-12 1' + (i % 10) + ':06:00',
}));

let TOKEN = '';
const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', b => { log += b.toString(); });
srv.stderr.on('data', b => { log += b.toString(); });
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
  const lr = await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  TOKEN = (await lr.json() || {}).token;
  if (!TOKEN) { console.error('login failed\n', log.slice(-1500)); cleanup(); process.exit(1); }

  let chrome = null;
  for (const p of [process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = p; break; } } catch (_) {}
  }
  if (!chrome) {
    console.log('  skip no Chrome available — UI checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(fail ? 1 : 0);
  }
  browser = await pptr.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/api/whatsapp/problem-numbers')) {
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(BAD) });
    }
    if (u.includes('/api/whatsapp/messages')) {
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(LOG) });
    }
    r.continue();
  });
  await page.setViewport({ width: 1500, height: 1000 });

  async function openSendLog() {
    await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
    await page.goto(B + '/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1200));
    await page.evaluate(() => { go('settings'); });
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(() => {
      _activeCat = 'integrations';
      if (typeof renderSettingsNav === 'function') renderSettingsNav();
      renderSettingsPanel();
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.evaluate(() => _waSetTab('log'));
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log('[bands] two folds, titled, each with its count');
  await openSendLog();
  const bands = await page.evaluate(() =>
    [...document.querySelectorAll('[data-wapane="log"] .wa-fold')].map(f => ({
      key: f.dataset.wafold,
      title: f.querySelector('.wa-fold-hd .t').textContent.trim(),
      count: (f.querySelector('.wa-fold-hd .n') || {}).textContent || '',
      scrolls: !!f.querySelector('.wa-fold-scroll'),
    })));
  check('there are exactly two bands', bands.length === 2, JSON.stringify(bands));
  check('the first is the never-worked numbers',
    /never worked/i.test((bands[0] || {}).title || ''), JSON.stringify(bands));
  check('the second is the send log',
    /send log/i.test((bands[1] || {}).title || ''), JSON.stringify(bands));
  check('each band carries its row count', bands.every(b => /^\d+$/.test(b.count.trim())), JSON.stringify(bands));
  check('each band has its own scroll box', bands.every(b => b.scrolls), JSON.stringify(bands));

  console.log('\n[colour] the two headers are different, and both legible');
  const toneProbe = () => {
    const lum = (rgb) => { const c = rgb.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126*c[0] + .7152*c[1] + .0722*c[2]; };
    // The cardamom tokens are color-mix() values, which compute to
    // `color(srgb 0.87 0.96 0.93)` — floats in 0..1, not 0..255 ints like
    // rgb(). Reading both as ints turns a high-contrast pair into 1:1.
    const px = (s) => {
      const n = (String(s).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      return /^color\(/.test(String(s).trim()) ? n.map(v => v * 255) : n;
    };
    return [...document.querySelectorAll('[data-wapane="log"] .wa-fold-hd')].map(h => {
      const cs = getComputedStyle(h);
      const a = lum(px(cs.color)), b = lum(px(cs.backgroundColor));
      const hi = Math.max(a, b), lo = Math.min(a, b);
      return { bg: cs.backgroundColor, fg: cs.color, bgLum: +b.toFixed(3),
               ratio: +((hi + .05) / (lo + .05)).toFixed(2), cursor: cs.cursor };
    });
  };
  const tone = await page.evaluate(toneProbe);
  check('the headers are two different colours',
    tone.length === 2 && tone[0].bg !== tone[1].bg, JSON.stringify(tone));
  check('both header labels clear 4.5:1 on their own band',
    tone.every(t => t.ratio >= 4.5), JSON.stringify(tone));
  check('the header reads as clickable', tone.every(t => t.cursor === 'pointer'), JSON.stringify(tone));

  console.log('\n[dark] both tints are <token>-lt, i.e. mixes with WHITE');
  // Which is the trap: on the dark ground a -lt tint comes back as a bright
  // band. The bands must keep their identity without glaring.
  await page.evaluate(() => document.body.setAttribute('data-dark', '1'));
  await new Promise(r => setTimeout(r, 300));
  const dark = await page.evaluate(toneProbe);
  check('the headers are still two distinguishable bands in dark mode',
    dark.length === 2 && (dark[0].bg !== dark[1].bg || dark[0].fg !== dark[1].fg), JSON.stringify(dark));
  check('both still clear 4.5:1 on the dark ground',
    dark.every(t => t.ratio >= 4.5), JSON.stringify(dark));
  check('neither header is a bright band on dark',
    dark.every(t => t.bgLum < 0.5), JSON.stringify(dark));
  await page.evaluate(() => document.body.setAttribute('data-dark', '0'));
  await new Promise(r => setTimeout(r, 300));

  console.log('\n[scroll] each band scrolls on its own');
  const sc = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[data-wapane="log"] .wa-fold-scroll')];
    const over = boxes.map(b => b.scrollHeight - b.clientHeight);
    boxes[0].scrollTop = 99999;                  // drive the first to its end
    return { over, first: boxes[0].scrollTop, second: boxes[1].scrollTop, n: boxes.length };
  });
  check('both bands overflow their box (so there is something to scroll)',
    sc.n === 2 && sc.over.every(o => o > 20), JSON.stringify(sc));
  check('scrolling the first band actually moves it', sc.first > 20, JSON.stringify(sc));
  check('…and leaves the second band at the top', sc.second === 0, JSON.stringify(sc));

  console.log('\n[sticky] column labels survive the scroll');
  const stick = await page.evaluate(() => {
    const box = document.querySelector('[data-wapane="log"] .wa-fold-scroll');
    box.scrollTop = 99999;
    const th = box.querySelector('thead th');
    return { pos: getComputedStyle(th).position,
             thTop: Math.round(th.getBoundingClientRect().top),
             boxTop: Math.round(box.getBoundingClientRect().top) };
  });
  check('the header row is sticky', stick.pos === 'sticky', JSON.stringify(stick));
  check('…and stays at the top of its own box while scrolled',
    Math.abs(stick.thTop - stick.boxTop) <= 2, JSON.stringify(stick));

  console.log('\n[chrome] the controls do not scroll away with the rows');
  const outside = await page.evaluate(() => {
    const bad = document.querySelector('[data-wafold="bad"]');
    const logf = document.querySelector('[data-wafold="log"]');
    return {
      dayBtnsOutside: !bad.querySelector('.wa-fold-scroll').contains(bad.querySelector('.wa-row')),
      filtersOutside: !logf.querySelector('.wa-fold-scroll').contains(logf.querySelector('.wa-row')),
      capOutside: !bad.querySelector('.wa-fold-scroll').contains(bad.querySelector('.wa-cap')),
    };
  });
  check('the day-range buttons sit outside the scroll box', outside.dayBtnsOutside, JSON.stringify(outside));
  check('the log filters sit outside the scroll box', outside.filtersOutside, JSON.stringify(outside));
  check('the caption sits outside the scroll box', outside.capOutside, JSON.stringify(outside));

  console.log('\n[fold] collapsing one band leaves the other open, and sticks');
  const folded = await page.evaluate(() => {
    document.querySelector('[data-wafold="bad"] .wa-fold-hd').click();
    const bad = document.querySelector('[data-wafold="bad"]');
    const logf = document.querySelector('[data-wafold="log"]');
    return {
      badCollapsed: bad.classList.contains('collapsed'),
      badBodyHidden: getComputedStyle(bad.querySelector('.wa-fold-bd')).display === 'none',
      logStillOpen: !logf.classList.contains('collapsed'),
      aria: bad.querySelector('.wa-fold-hd').getAttribute('aria-expanded'),
      stored: localStorage.getItem('waFoldBad'),
    };
  });
  check('the clicked band collapses', folded.badCollapsed, JSON.stringify(folded));
  check('…its body is actually hidden', folded.badBodyHidden, JSON.stringify(folded));
  check('…the other band is untouched', folded.logStillOpen, JSON.stringify(folded));
  check('…and the header reports it to a screen reader', folded.aria === 'false', JSON.stringify(folded));
  check('…and the choice is remembered', folded.stored === '0', JSON.stringify(folded));

  await openSendLog();
  const after = await page.evaluate(() => ({
    badCollapsed: document.querySelector('[data-wafold="bad"]').classList.contains('collapsed'),
    logOpen: !document.querySelector('[data-wafold="log"]').classList.contains('collapsed'),
  }));
  check('the collapsed band is still collapsed after a reload', after.badCollapsed, JSON.stringify(after));
  check('…and the open one is still open', after.logOpen, JSON.stringify(after));

  if (process.env.SHOT_DIR) {
    await page.evaluate(() => { localStorage.removeItem('waFoldBad'); });
    await page.evaluate(() => _renderWhatsappBadNumbers());
    await new Promise(r => setTimeout(r, 900));
    await page.evaluate(() => document.querySelector('[data-wafold="bad"]').scrollIntoView({ block: 'start' }));
    await new Promise(r => setTimeout(r, 400));
    const el = await page.$('[data-wapane="log"]');
    await el.screenshot({ path: process.env.SHOT_DIR + '/wa-folds-light.png' });
    await page.evaluate(() => document.body.setAttribute('data-dark', '1'));
    await new Promise(r => setTimeout(r, 500));
    await el.screenshot({ path: process.env.SHOT_DIR + '/wa-folds-dark.png' });
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
