// SELLER-WARNING BADGES + THE DASHBOARD HEADER, driven in a real headless Chrome.
//
//   [D] the dashboard logo rides in the greeting row, horizontally centred
//   [T] the trade snapshot is hidden until its toggle is used, and the
//       auction picker stays reachable while it is
//   [K] the Auction Desk carries a seller-warning filter that narrows the
//       lot table, its KPI strip and its totals together
//   [M] the Auction Manager shows the same badges on Lots / Planters /
//       Traders and filters by them, per-lot on Lots and per-seller on the
//       other two
//
// Writes full-page screenshots to /tmp for eyeballing.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-ui-'));
const PORT = 47368;
const B = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.BADGE_SHOT_DIR || os.tmpdir();

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

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  // The Auction Manager is a separate screen behind its own flag.
  await api('PUT', '/api/company-settings', { settings: { flag_auction_manager: 'true' } });

  const a = (await api('POST', '/api/auctions', { ano: '21', date: '2026-08-20', state: 'TAMIL NADU' })).d;
  const aid = a.id || (a.auction && a.auction.id);

  // Four sellers, each missing something different, so every branch of
  // lotSellerIssues is represented and the filter has more than one option:
  //   CLEAN     — GSTIN + PAN + phone + a bank account   → no badges
  //   NOPAN     — GSTIN + phone + bank, no PAN           → "No PAN"
  //   NOBANK    — GSTIN + PAN + phone, no bank           → "No bank"
  //   NOGSTIN   — PAN + phone + bank, no GSTIN           → "No GSTIN"
  const sellers = [
    { name: 'CLEAN ESTATES',   cr: 'GSTIN.32AAHCE4551A1Z8', pan: 'AAHCE4551A', tel: '9000010001', bank: true },
    { name: 'NOPAN TRADERS',   cr: 'GSTIN.32AAHCE4552A1Z8', pan: '',           tel: '9000010002', bank: true },
    { name: 'NOBANK TRADERS',  cr: 'GSTIN.32AAHCE4553A1Z8', pan: 'AAHCE4553A', tel: '9000010003', bank: false },
    { name: 'NOGSTIN PLANTER', cr: '',                      pan: 'AAHCE4554A', tel: '9000010004', bank: true },
  ];
  const ids = {};
  for (const s of sellers) {
    const r = await api('POST', '/api/traders', { name: s.name, cr: s.cr, pan: s.pan, tel: s.tel });
    ids[s.name] = r.d && (r.d.id || (r.d.trader && r.d.trader.id));
    if (s.bank) {
      await api('POST', `/api/traders/${ids[s.name]}/banks`, {
        bank_name: 'STATE BANK', acctnum: '11111111000' + Object.keys(ids).length,
        ifsc: 'SBIN0001234', account_type: 'Savings' });
    }
  }
  // Two lots each, so a per-seller row rolls more than one lot up.
  let lotNo = 100;
  for (const s of sellers) {
    for (let k = 0; k < 2; k++) {
      const r = await api('POST', '/api/lots', {
        auction_id: aid, lot_no: String(++lotNo), name: s.name, trader_id: ids[s.name],
        cr: s.cr, pan: s.pan, tel: s.tel, qty: 100, bags: 4, grade: '1',
        crop: 'CARDAMOM', branch: 'BODINAYAKANUR' });
      const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
      await api('PUT', `/api/lots/${id}`, { price: 2000, amount: 200000 });
    }
  }

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
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 900 });
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

  // ── [D] Dashboard header ─────────────────────────────────────────
  console.log('[D] dashboard header');
  await page.evaluate(() => go('dash'));
  await page.waitForFunction(() => !!document.querySelector('#tc-dash .greeting .dash-logo-badge'), { timeout: 20000 });
  const head = await page.evaluate(() => {
    const g = document.querySelector('#tc-dash .greeting');
    const badge = g.querySelector('.dash-logo-badge');
    const h1 = g.querySelector('h1');
    const gr = g.getBoundingClientRect(), br = badge.getBoundingClientRect(), hr = h1.getBoundingClientRect();
    return {
      inGreeting: !!badge.closest('.greeting'),
      // How far the badge's centre sits from the greeting row's centre.
      offCentre: Math.abs((br.left + br.right) / 2 - (gr.left + gr.right) / 2),
      // Its top edge against the greeting text — "moved upward" means it is
      // level with the header, not stacked under it.
      aboveH1Bottom: br.top < hr.bottom,
    };
  });
  check('logo sits inside the greeting row', head.inGreeting);
  check('…horizontally centred in it', head.offCentre < 2, 'off by ' + head.offCentre + 'px');
  check('…and level with the greeting rather than below it', head.aboveH1Bottom);

  // ── [T] Trade snapshot toggle ────────────────────────────────────
  // In cumulative mode, which is what the card is headed "All Auctions" for.
  console.log('\n[T] trade snapshot toggle');
  // Through the picker, not loadStats() directly, so the cumulative scope is
  // recorded as an explicit pick — the toggle's re-render has to preserve it.
  await page.evaluate(() => dashPickAuction('all'));
  // loadStats() is async and not awaited by the picker, so wait for the
  // repaint rather than reading the outgoing render.
  await page.waitForFunction(
    () => /All Auctions/.test(document.querySelector('.dash-snap-toggle-btn')?.textContent || ''),
    { timeout: 20000 });
  const shut = await page.evaluate(() => ({
    card: !!document.getElementById('dash-snap-card'),
    btn: document.querySelector('.dash-snap-toggle-btn')?.textContent.replace(/\s+/g, ' ').trim(),
    expanded: document.querySelector('.dash-snap-toggle-btn')?.getAttribute('aria-expanded'),
    picker: !!document.querySelector('.dash-snap-toggle select'),
    oneCol: !!document.querySelector('.dash-snap-row.snap-hidden'),
  }));
  check('the snapshot is off on a first visit', !shut.card);
  check('a toggle offers it', /Show All Auctions/.test(shut.btn || ''), shut.btn);
  check('…marked closed for assistive tech', shut.expanded === 'false', shut.expanded);
  check('the auction picker moves onto the toggle bar', shut.picker);
  check('Quick Actions takes the freed column', shut.oneCol);

  await page.evaluate(() => toggleDashSnapVisible());
  await page.waitForFunction(() => !!document.getElementById('dash-snap-card'), { timeout: 20000 });
  const open = await page.evaluate(() => ({
    btn: document.querySelector('.dash-snap-toggle-btn')?.textContent.replace(/\s+/g, ' ').trim(),
    expanded: document.querySelector('.dash-snap-toggle-btn')?.getAttribute('aria-expanded'),
    barPicker: !!document.querySelector('.dash-snap-toggle select'),
    cardPicker: !!document.querySelector('#dash-snap-card select'),
    stored: localStorage.getItem('dashSnapVisible'),
    twoCol: !document.querySelector('.dash-snap-row.snap-hidden'),
  }));
  check('the toggle opens the card', /Hide All Auctions/.test(open.btn || ''), open.btn);
  check('…marked open for assistive tech', open.expanded === 'true', open.expanded);
  check('the picker goes back to the card header, not duplicated',
        open.cardPicker && !open.barPicker, JSON.stringify(open));
  check('the row is two columns again', open.twoCol);
  check('the choice is remembered', open.stored === '1', open.stored);

  await page.screenshot({ path: path.join(SHOT_DIR, 'dash-snap-open.png'), fullPage: false });
  await page.evaluate(() => toggleDashSnapVisible());
  await page.waitForFunction(() => !document.getElementById('dash-snap-card'), { timeout: 20000 });
  check('and toggling back hides it again',
        await page.evaluate(() => localStorage.getItem('dashSnapVisible') === '0'));
  await page.screenshot({ path: path.join(SHOT_DIR, 'dash-snap-shut.png'), fullPage: false });

  // The header is a three-column grid on a desktop; on a phone it has to
  // stack rather than squeeze the greeting or push the button off-screen.
  await page.setViewport({ width: 390, height: 780 });
  await page.evaluate(() => loadStats());
  await page.waitForFunction(() => !!document.querySelector('#tc-dash .greeting .dash-logo-badge'), { timeout: 20000 });
  const narrow = await page.evaluate(() => {
    const g = document.querySelector('#tc-dash .greeting');
    const gr = g.getBoundingClientRect();
    const kids = Array.from(g.children).map(c => c.getBoundingClientRect());
    return {
      stacked: kids.every((r, i) => i === 0 || r.top >= kids[i - 1].bottom - 1),
      fits: kids.every(r => r.left >= gr.left - 1 && r.right <= gr.right + 1),
      // Scoped to the dashboard panel: the app SHELL (topbar chips, sidebar)
      // has its own narrow-viewport overflow that predates this header.
      dashOverflow: (() => { const d = document.getElementById('tc-dash');
        return d.scrollWidth - d.clientWidth; })(),
    };
  });
  check('the header stacks on a phone-width screen', narrow.stacked, JSON.stringify(narrow));
  check('…with nothing spilling out of the column', narrow.fits, JSON.stringify(narrow));
  check('…and the dashboard panel does not scroll sideways', narrow.dashOverflow <= 0, String(narrow.dashOverflow));
  await page.screenshot({ path: path.join(SHOT_DIR, 'dash-narrow.png'), fullPage: false });
  await page.setViewport({ width: 1440, height: 900 });

  // ── [K] Auction Desk badge filter ────────────────────────────────
  console.log('\n[K] Auction Desk seller-warning filter');
  await page.evaluate(() => go('hub'));
  // Entering the Desk kicks off more than one load — the screen's own refresh
  // plus the one the auction <select> fires as it is filled — and each blanks
  // the table while it is in flight. Wait for the row count to hold steady
  // rather than for the first paint, which a later load would pull away.
  const deskSettled = async () => {
    for (let i = 0; i < 40; i++) {
      await page.waitForFunction(() => document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length === 8, { timeout: 20000 });
      await new Promise(r => setTimeout(r, 400));
      if (await page.evaluate(() => document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length === 8)) return;
    }
    throw new Error('Auction Desk lot table never settled');
  };
  await deskSettled();
  const deskOpts = await page.evaluate(() => ({
    shown: document.getElementById('hub-lot-badge-wrap')?.style.display !== 'none',
    opts: Array.from(document.querySelectorAll('#hub-lot-badge option')).map(o => o.value),
    labels: Array.from(document.querySelectorAll('#hub-lot-badge option')).map(o => o.textContent.trim()),
    badged: document.querySelectorAll('#hub-lot-rows .dl-issue').length,
    rows: document.querySelectorAll('#hub-lot-rows tr[data-lot-id]').length,
  }));
  check('the filter appears once a seller is flagged', deskOpts.shown);
  check('its options name the warnings actually present',
        ['', '__any', '__none', 'No GSTIN', 'No PAN', 'No bank'].every(v => deskOpts.opts.includes(v)),
        JSON.stringify(deskOpts.opts));
  check('…with a per-warning lot count',
        deskOpts.labels.some(l => l === 'No PAN (2)'), JSON.stringify(deskOpts.labels));
  check('badges render on the rows', deskOpts.badged > 0, String(deskOpts.badged));
  check('all eight lots are listed to begin with', deskOpts.rows === 8, String(deskOpts.rows));

  const deskPick = async (v) => {
    await page.evaluate((val) => {
      const s = document.getElementById('hub-lot-badge');
      s.value = val; s.dispatchEvent(new Event('change'));
    }, v);
    return page.evaluate(() => ({
      rows: Array.from(document.querySelectorAll('#hub-lot-rows tr[data-lot-id] td:nth-child(2)'))
              .map(td => { const c = td.cloneNode(true); c.querySelectorAll('.dl-issue').forEach(n => n.remove()); return c.textContent.trim(); }),
      count: document.getElementById('hub-lot-count')?.textContent.trim(),
      kpiLots: (document.querySelector('#hub-kpi .stat .n')?.textContent || '').trim(),
      foot: document.getElementById('hub-lot-foot')?.textContent.replace(/\s+/g, ' ').trim(),
      ringed: document.querySelectorAll('#hub-lot-rows .dl-issue-on').length,
      // The dropdown keeps every option so the pick can be changed again.
      opts: document.querySelectorAll('#hub-lot-badge option').length,
    }));
  };
  const noPan = await deskPick('No PAN');
  check('picking a warning narrows the table to it',
        noPan.rows.length === 2 && noPan.rows.every(n => n === 'NOPAN TRADERS'), JSON.stringify(noPan.rows));
  check('the KPI strip narrows with it', noPan.kpiLots === '2', noPan.kpiLots);
  check('so does the totals row', /2 lots/.test(noPan.foot || ''), noPan.foot);
  check('the header says the list is filtered', /matching/.test(noPan.count || ''), noPan.count);
  check('the matching badge is ringed on each row', noPan.ringed === 2, String(noPan.ringed));
  check('the option list is not narrowed with the rows', noPan.opts === deskOpts.opts.length,
        noPan.opts + ' vs ' + deskOpts.opts.length);

  const anyWarn = await deskPick('__any');
  check('"any warning" holds every flagged seller', anyWarn.rows.length === 6, String(anyWarn.rows.length));
  const noWarn = await deskPick('__none');
  check('"no warnings" holds only the clean one',
        noWarn.rows.length === 2 && noWarn.rows.every(n => n === 'CLEAN ESTATES'), JSON.stringify(noWarn.rows));
  const back = await deskPick('');
  check('clearing the pick restores every lot', back.rows.length === 8, String(back.rows.length));
  await page.screenshot({ path: path.join(SHOT_DIR, 'hub-badge-filter.png'), fullPage: false });

  // ── [M] Auction Manager badges + filter ──────────────────────────
  console.log('\n[M] Auction Manager badges and filter');
  await page.evaluate(() => go('auctionmgr'));
  await page.waitForFunction(() => document.querySelectorAll('#am-body table.am-tbl tbody tr').length > 0, { timeout: 20000 });
  const amStart = await page.evaluate(() => ({
    shown: document.getElementById('am-badge')?.style.display !== 'none',
    opts: Array.from(document.querySelectorAll('#am-badge option')).map(o => o.textContent.trim()),
    badged: document.querySelectorAll('#am-body .dl-issue').length,
    rows: document.querySelectorAll('#am-body table.am-tbl tbody tr').length,
  }));
  check('the Lots tab carries badges', amStart.badged > 0, String(amStart.badged));
  check('and a seller-warning filter beside the text box', amStart.shown);
  check('counted per LOT on the Lots tab',
        amStart.opts.some(l => l === 'No PAN (2)'), JSON.stringify(amStart.opts));
  check('every lot is listed to begin with', amStart.rows === 8, String(amStart.rows));

  const amPick = async (v) => {
    await page.evaluate((val) => amBadgeFilter(val), v);
    return page.evaluate(() => Array.from(document.querySelectorAll('#am-body table.am-tbl tbody tr'))
      .map(tr => { const c = tr.cloneNode(true); c.querySelectorAll('.dl-issue').forEach(n => n.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); }));
  };
  const amNoBank = await amPick('No bank');
  check('the pick narrows the lots', amNoBank.length === 2 && amNoBank.every(t => /NOBANK TRADERS/.test(t)),
        JSON.stringify(amNoBank));
  check('and the select-all checkbox follows the same set',
        await page.evaluate(() => _amRows.filter(_amMatch).length) === 2);

  // Planters / Traders count and filter by SELLER, and a matched seller keeps
  // every lot they booked rather than only the flagged ones.
  await page.evaluate(() => amSubTab('traders'));
  const amTraders = await page.evaluate(() => ({
    opts: Array.from(document.querySelectorAll('#am-badge option')).map(o => o.textContent.trim()),
    rows: Array.from(document.querySelectorAll('#am-body table.am-tbl tbody tr')).map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const c = tds[0].cloneNode(true); c.querySelectorAll('.dl-issue').forEach(n => n.remove());
      return { name: c.textContent.trim(), lots: tds[2].textContent.trim(), lotNos: tds[3].textContent.trim() };
    }),
    badged: document.querySelectorAll('#am-body .dl-issue').length,
  }));
  check('counted per SELLER on the Traders tab',
        amTraders.opts.some(l => l === 'No bank (1)'), JSON.stringify(amTraders.opts));
  check('the seller row is badged too', amTraders.badged > 0, String(amTraders.badged));
  check('the pick narrows to that seller',
        amTraders.rows.length === 1 && amTraders.rows[0].name === 'NOBANK TRADERS', JSON.stringify(amTraders.rows));
  check('…keeping BOTH of their lots, not just a flagged subset',
        amTraders.rows[0] && amTraders.rows[0].lots === '2', JSON.stringify(amTraders.rows[0]));

  await page.evaluate(() => amBadgeFilter('No GSTIN'));
  await page.evaluate(() => amSubTab('planters'));
  const amPlanters = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#am-body table.am-tbl tbody tr td:first-child')).map(td => {
      const c = td.cloneNode(true); c.querySelectorAll('.dl-issue').forEach(n => n.remove()); return c.textContent.trim(); }));
  check('the Planters tab filters on the same pick',
        amPlanters.length === 1 && amPlanters[0] === 'NOGSTIN PLANTER', JSON.stringify(amPlanters));

  await page.evaluate(() => { amBadgeFilter(''); amSubTab('lots'); });
  check('clearing the pick restores every lot',
        await page.evaluate(() => document.querySelectorAll('#am-body table.am-tbl tbody tr').length) === 8);
  await page.screenshot({ path: path.join(SHOT_DIR, 'am-badge-filter.png'), fullPage: false });

  console.log(`\n  screenshots → ${SHOT_DIR}/dash-snap-*.png, hub-badge-filter.png, am-badge-filter.png`);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Error', e); cleanup(); process.exit(1); });
