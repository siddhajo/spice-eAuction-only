// Dummy Seller Details, reached from the dashboard's CURRENT AUCTION panel.
//
// The Lots tab could already mask a lot's seller in bulk, but that is not
// where an operator stands on auction day — the Current Auction panel is, and
// it is the panel that sits next to the "⬇ Spices Board CSV" button the mask
// exists to feed. So the same action is reachable from here:
//
//   • a "🎭 Dummy Lots" row in the stats panel, which says how many lots in
//     this trade will present a stand-in seller, and links to exactly those
//   • a "🎭 Dummy Details" button in the panel header, opening the trade's
//     whole lot list with tick boxes
//   • the per-depot drill-down, which gets the same ticking scoped to a branch
//
// The server side of the write is lot-dummy-details.http.js's business; what
// only a browser can answer is whether the gates, the ticking and the repaint
// actually hold together.
//
//   [gate]    neither surface appears with flag_lot_dummy_details OFF
//   [stat]    the Dummy Lots row counts the masked lots and links to them
//   [tick]    the lot list ticks, the header tick obeys the FILTER, and the
//             selection bar counts what is ticked
//   [apply]   setting a dummy from here writes it and repaints the list, so
//             the 🎭 badge appears without a manual refresh
//   [depot]   the per-branch drill-down carries the same ticking
//   [filter]  the dummy dropdown narrows the list to masked / unmasked lots
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-dummy-ui-'));
const PORT = 47418;
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
  const lr = await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const ld = await lr.json();
  TOKEN = ld && (ld.token || ld.accessToken);
  if (!TOKEN) { console.error('login failed', ld, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  // The panel only draws itself for a trade with lots, and the depot drill
  // needs more than one branch to be worth testing.
  const auc = await api('POST', '/api/auctions', { ano: '71', date: '2026-09-24', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  const lots = [
    { lot_no: '001', branch: 'ANAVILASAM' },
    { lot_no: '002', branch: 'ANAVILASAM' },
    { lot_no: '003', branch: 'BODI' },
    { lot_no: '004', branch: 'BODI' },
  ];
  const lotIds = [];
  for (const l of lots) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no: l.lot_no, name: 'REAL SELLER ' + l.lot_no,
      qty: 100, grade: '1', bags: 10, branch: l.branch, cr: 'CR.100' + l.lot_no,
    });
    lotIds.push(r.d.id || (r.d.lot && r.d.lot.id));
  }
  check('four lots created across two branches', lotIds.every(Boolean), JSON.stringify(lotIds));

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
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1600, height: 1100 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#lot-dummy-modal', { timeout: 15000 });

  // Flip a flag and repaint the panel. Both the panel header button and the
  // stats row are drawn from the body attribute, so the attribute has to be
  // re-applied the way a settings save would.
  async function setFlag(on) {
    await api('PUT', '/api/company-settings', { settings: { flag_lot_dummy_details: on ? 'true' : 'false' } });
    // applyFeatureFlags() is what re-reads the settings and re-stamps the body
    // attributes — the same path a settings save takes in the app.
    await page.evaluate(async (aid) => {
      await applyFeatureFlags();
      // The tab is 'dash', and loadStats() is what PAINTS the panel's host
      // element — loadDepotSummary() only fills it. Both, in that order.
      go('dash');
      await loadStats(aid);
      await loadDepotSummary(aid);
    }, aid);
    await page.waitForFunction(
      () => !!document.querySelector('#dash-current-auction .card'), { timeout: 15000 });
  }

  const panel = () => page.evaluate(() => {
    const host = document.getElementById('dash-current-auction');
    return {
      exists: !!host,
      headerBtn: !!(host && [...host.querySelectorAll('button')].find(b => /Dummy Details/.test(b.textContent))),
      statRow: !!(host && /Dummy Lots/.test(host.textContent)),
      statCount: (() => {
        if (!host) return null;
        const a = [...host.querySelectorAll('a')].find(x => /Dummy Lots/.test(x.textContent));
        const row = a && a.closest('div');
        return row ? row.parentElement.textContent.replace(/\s+/g, ' ').trim() : null;
      })(),
    };
  });

  console.log('[gate] with the flag OFF neither surface appears');
  await setFlag(false);
  {
    const p = await panel();
    check('the Current Auction panel is drawn', p.exists);
    check('no header Dummy Details button', !p.headerBtn);
    check('no Dummy Lots stat row', !p.statRow);
  }

  console.log('[stat] flag ON surfaces both, and the count starts at none');
  await setFlag(true);
  {
    const p = await panel();
    check('the header button appears', p.headerBtn);
    check('the Dummy Lots stat row appears', p.statRow);
    check('…reading None while nothing is masked', /None/.test(p.statCount || ''), p.statCount);
  }

  // Open the trade-wide list from the header button.
  async function openTradeList() {
    await page.evaluate((aid) => openTradeDummyLots(aid), aid);
    await new Promise(r => setTimeout(r, 500));
  }
  const listState = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#depot-lots-body tbody tr')];
    return {
      rows: rows.length,
      ticks: document.querySelectorAll('#depot-lots-body td.dl-pick input').length,
      headerTick: !!document.getElementById('dl-pick-all'),
      selBarShown: (() => {
        const b = document.getElementById('dl-selbar');
        return !!b && getComputedStyle(b).display !== 'none';
      })(),
      selCount: (document.getElementById('dl-selcount') || {}).textContent || '',
      badges: document.querySelectorAll('#depot-lots-body .dl-dummy-badge').length,
      dummyFilter: !!document.getElementById('dl-dummy-filter'),
      lotNos: rows.map(tr => tr.querySelectorAll('td')[1]?.textContent.trim()),
    };
  });

  console.log('[tick] the trade-wide list ticks, and the bar counts it');
  await openTradeList();
  {
    const st = await listState();
    check('all four lots are listed', st.rows === 4, JSON.stringify(st.lotNos));
    check('every row has a tick box', st.ticks === 4, String(st.ticks));
    check('there is a header tick', st.headerTick);
    check('the selection bar is hidden with nothing ticked', !st.selBarShown);
    check('no 🎭 badge yet', st.badges === 0, String(st.badges));
    check('no dummy dropdown while no lot is masked', !st.dummyFilter);
  }

  // Tick two rows by clicking, the way an operator would.
  await page.evaluate(() => {
    const cbs = [...document.querySelectorAll('#depot-lots-body td.dl-pick input')];
    cbs[0].click(); cbs[1].click();
  });
  await new Promise(r => setTimeout(r, 200));
  {
    const st = await listState();
    check('the selection bar appears once something is ticked', st.selBarShown);
    check('…counting exactly what was ticked', st.selCount === '2', st.selCount);
  }

  console.log('[tick] the header tick obeys the filter, not the whole list');
  await page.evaluate(() => {
    dlClearPick();
    depotLotsFilter('lot', '00');          // still all four
    depotLotsFilter('lot', '003');         // narrow to one
  });
  await new Promise(r => setTimeout(r, 200));
  {
    const st = await listState();
    check('the filter narrowed the list to one lot', st.rows === 1, JSON.stringify(st.lotNos));
  }
  await page.evaluate(() => document.getElementById('dl-pick-all').click());
  await new Promise(r => setTimeout(r, 200));
  {
    const sel = await page.evaluate(() => _dl.picked.size);
    check('ticking the header selects only the visible lot — not all four', sel === 1, String(sel));
  }

  console.log('[apply] setting a dummy from here writes it and repaints the list');
  await page.evaluate(() => {
    document.getElementById('dl-selbar').querySelector('.dl-dummy-btn').click();
  });
  await new Promise(r => setTimeout(r, 400));
  {
    const open = await page.evaluate(() =>
      document.getElementById('lot-dummy-modal').classList.contains('show'));
    check('the shared Dummy Details modal opens', open);
    const n = await page.evaluate(() => document.getElementById('ldd-count').textContent);
    check('…addressed at the one ticked lot', n === '1', n);
  }
  await page.evaluate(() => {
    document.getElementById('ldd-name').value = 'MASKED PLANTER';
    document.getElementById('ldd-cr').value = 'CR.9999';
    document.getElementById('ldd-apply').click();
  });
  await new Promise(r => setTimeout(r, 900));
  {
    // The write landed...
    const r = await api('GET', `/api/lots/${aid}`);
    const lot3 = (r.d || []).find(l => String(l.lot_no) === '003');
    check('the dummy identity is stored on the ticked lot',
      lot3 && lot3.dummy_name === 'MASKED PLANTER' && lot3.dummy_cr === 'CR.9999',
      JSON.stringify(lot3 && { n: lot3.dummy_name, c: lot3.dummy_cr }));
    const untouched = (r.d || []).find(l => String(l.lot_no) === '004');
    check('…and only on that one', untouched && !String(untouched.dummy_name || '').trim());

    // ...and the open list repainted itself, without a manual refresh.
    const st = await listState();
    check('the list repainted with the 🎭 badge', st.badges === 1, JSON.stringify(st));
    check('the selection was cleared after the save', !st.selBarShown);
    check('the dummy dropdown now exists, since a lot is masked', st.dummyFilter);
  }

  console.log('[filter] the dummy dropdown narrows to masked / unmasked');
  await page.evaluate(() => { depotLotsFilter('lot', ''); depotLotsFilter('dummy', '1'); });
  await new Promise(r => setTimeout(r, 200));
  {
    const st = await listState();
    check('"Dummy set" shows just the masked lot', st.rows === 1 && st.lotNos[0] === '003', JSON.stringify(st.lotNos));
  }
  await page.evaluate(() => depotLotsFilter('dummy', '0'));
  await new Promise(r => setTimeout(r, 200));
  {
    const st = await listState();
    check('"No dummy" shows the other three', st.rows === 3, JSON.stringify(st.lotNos));
  }

  console.log('[stat] the panel now reports the masked lot, and links to it');
  await page.evaluate(() => hideModal('depot-lots-modal'));
  await page.evaluate(async (aid) => { go('dash'); await loadStats(aid); await loadDepotSummary(aid); }, aid);
  await page.waitForFunction(
    () => !!document.querySelector('#dash-current-auction .card'), { timeout: 15000 });
  {
    const p = await panel();
    check('the Dummy Lots row counts it', /\b1\b/.test(p.statCount || '') && !/None/.test(p.statCount || ''), p.statCount);
  }
  await page.evaluate(() => {
    const host = document.getElementById('dash-current-auction');
    [...host.querySelectorAll('a')].find(x => /Dummy Lots/.test(x.textContent)).click();
  });
  await new Promise(r => setTimeout(r, 700));
  {
    const st = await listState();
    const sel = await page.evaluate(() => (document.getElementById('dl-dummy-filter') || {}).value);
    check('clicking it opens the list pre-filtered to the masked lots',
      st.rows === 1 && st.lotNos[0] === '003' && sel === '1', JSON.stringify({ ...st, sel }));
  }

  console.log('[depot] the per-branch drill-down carries the same ticking');
  await page.evaluate(() => hideModal('depot-lots-modal'));
  await page.evaluate((aid) => openDepotLots(aid, 'ANAVILASAM'), aid);
  await new Promise(r => setTimeout(r, 700));
  {
    const st = await listState();
    check('only that branch\'s lots are listed', st.rows === 2, JSON.stringify(st.lotNos));
    check('…each with a tick box', st.ticks === 2, String(st.ticks));
    check('…and a fresh selection, not the one from the other list', !st.selBarShown);
  }

  console.log('[gate] turning the flag off takes the ticking away again');
  await page.evaluate(() => hideModal('depot-lots-modal'));
  await setFlag(false);
  await page.evaluate((aid) => openDepotLots(aid, 'ANAVILASAM'), aid);
  await new Promise(r => setTimeout(r, 700));
  {
    const st = await listState();
    check('the lots still list', st.rows === 2, JSON.stringify(st.lotNos));
    check('…with no tick boxes', st.ticks === 0, String(st.ticks));
    check('…no header tick', !st.headerTick);
    check('…and no 🎭 badge, because the feature is not part of the app', st.badges === 0, String(st.badges));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
