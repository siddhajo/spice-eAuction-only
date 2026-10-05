// FORM-D "Place of auction" on the auction-creation forms, in a real browser.
//
// The server side is auction-place-formd.http.js's business. What only a
// browser can answer is whether an operator can actually set it: the picker
// is filled from a SETTING, it carries a "+ Add a new place…" escape hatch
// whose box only appears when chosen, and the value it computes is what the
// save sends. There are TWO creation forms — the Auctions tab and Lot Entry's
// quick-create — and a trade created from either must not come out missing
// its venue.
//
//   [fill]    both pickers list the formd_places entries, blank first
//   [new]     "+ Add a new place…" reveals a box; what is typed is saved AND
//             appended to the list, so a venue is only ever entered once
//   [edit]    Edit Auction pre-selects the trade's stored place, and keeps
//             showing one that has since been removed from the list
//   [clear]   choosing the blank option clears the venue back to the branch
//   [lotentry] the quick-create form carries the same field
//   [spiceboard] the Form-D screen says which venue the trade will print
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auc-place-ui-'));
const PORT = 47422;
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

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env, { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
let browser = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const PUTTADY = 'e-Auction Spices Park Puttady';
const BODI    = 'e-Auction Spices Board Bodinayakanur';
const KUMILY  = 'e-Auction Spices Board Kumily';

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('PUT', '/api/company-settings', { settings: { tn_branch: 'CUMBUM', business_state: 'TAMIL NADU' } });

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
  await page.setViewport({ width: 1500, height: 1050 });
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#auction-modal', { timeout: 15000 });

  // The picker is filled by a fetch, so wait for the options rather than a
  // fixed sleep — a slow settings read is exactly the case that would make a
  // timing-based test flake.
  const waitPicker = (selId) => page.waitForFunction(
    (id) => (document.getElementById(id) || { options: [] }).options.length > 1,
    { timeout: 10000 }, selId);
  const pickerState = (selId, boxId) => page.evaluate((selId, boxId) => {
    const sel = document.getElementById(selId), box = document.getElementById(boxId);
    return {
      opts: [...(sel ? sel.options : [])].map(o => o.textContent.trim()),
      vals: [...(sel ? sel.options : [])].map(o => o.value),
      value: sel ? sel.value : null,
      boxShown: !!box && getComputedStyle(box).display !== 'none',
    };
  }, selId, boxId);

  console.log('[fill] the Auctions-tab picker lists the configured venues');
  await page.evaluate(() => { go('auctions'); openAuctionAdd(); });
  await waitPicker('a-place');
  {
    const st = await pickerState('a-place', 'a-place-new');
    check('blank "use configured branch" is first', st.vals[0] === '' && /configured branch/i.test(st.opts[0]), JSON.stringify(st.opts));
    check('both seeded venues are offered', st.vals.includes(PUTTADY) && st.vals.includes(BODI), JSON.stringify(st.vals));
    check('"+ Add a new place…" is last', /Add a new place/.test(st.opts[st.opts.length - 1]), JSON.stringify(st.opts));
    check('nothing is pre-selected on a NEW auction', st.value === '');
    check('the new-place box is hidden until it is chosen', !st.boxShown);
  }

  console.log('[new] choosing "+ Add a new place…" reveals the box');
  await page.select('#a-place', '__new__');
  await new Promise(r => setTimeout(r, 200));
  check('the box appears', (await pickerState('a-place', 'a-place-new')).boxShown);
  check('…and the value comes from the box, not the select',
    (await page.evaluate(() => { document.getElementById('a-place-new').value = ' ' + 'e-Auction Spices Board Kumily' + ' '; return auctionPlaceValue(); })) === KUMILY);
  // Switching away must not leave a stale typed value behind to be saved.
  await page.select('#a-place', PUTTADY);
  await new Promise(r => setTimeout(r, 200));
  {
    const st = await pickerState('a-place', 'a-place-new');
    check('switching back hides the box', !st.boxShown);
    check('…and the typed value is dropped, not silently saved',
      (await page.evaluate(() => auctionPlaceValue())) === PUTTADY);
  }

  console.log('[new] a typed venue is saved on the trade AND added to the list');
  await page.evaluate(async () => {
    document.getElementById('a-ano').value = '201';
    document.getElementById('a-date').value = '2026-10-04';
    document.getElementById('a-place').value = '__new__';
    onAuctionPlaceChange();
    document.getElementById('a-place-new').value = 'e-Auction Spices Board Kumily';
    await saveAuction();
  });
  await new Promise(r => setTimeout(r, 900));
  {
    const r = await api('GET', '/api/auctions');
    const row = (r.d || []).find(a => String(a.ano) === '201');
    check('the trade carries the typed venue', row && row.place === KUMILY, JSON.stringify(row && row.place));
    const cfg = await api('GET', '/api/company-settings/flat');
    const list = String(cfg.d.formd_places || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    check('…and it joined the Form-D place list', list.includes(KUMILY), JSON.stringify(list));
  }

  console.log('[edit] Edit Auction pre-selects the stored place');
  const row201 = await (async () => {
    const r = await api('GET', '/api/auctions');
    return (r.d || []).find(a => String(a.ano) === '201');
  })();
  await page.evaluate((a) => openAuctionEdit(a), row201);
  await waitPicker('a-place');
  check('the stored venue is selected', (await pickerState('a-place', 'a-place-new')).value === KUMILY,
    JSON.stringify(await pickerState('a-place', 'a-place-new')));

  console.log('[edit] a venue dropped from the list is still shown, not silently rewritten');
  await api('PUT', '/api/company-settings', { settings: { formd_places: PUTTADY + '\n' + BODI } });
  await page.evaluate((a) => openAuctionEdit(a), row201);
  await waitPicker('a-place');
  {
    const st = await pickerState('a-place', 'a-place-new');
    check('the removed venue is re-added to this one dropdown', st.vals.includes(KUMILY), JSON.stringify(st.vals));
    check('…and is still the selected value', st.value === KUMILY, st.value);
  }

  console.log('[clear] the blank option puts the trade back on the branch');
  await page.evaluate(async () => {
    document.getElementById('a-place').value = '';
    await saveAuction();
  });
  await new Promise(r => setTimeout(r, 900));
  {
    const r = await api('GET', '/api/auctions');
    const row = (r.d || []).find(a => String(a.ano) === '201');
    check('the venue is cleared', row && row.place === '', JSON.stringify(row && row.place));
    const fd = await api('GET', `/api/spice-board-reports/filters?auctionId=${row.id}`);
    check('…and the Spice Board screen reports no trade place', fd.d.place === '', JSON.stringify(fd.d.place));
  }

  console.log('[lotentry] the quick-create form carries the same field');
  await page.evaluate(() => { go('lotentry'); leOpenNewTradeModal(); });
  await waitPicker('le-nt-place');
  {
    const st = await pickerState('le-nt-place', 'le-nt-place-new');
    check('its picker is filled too', st.vals.includes(PUTTADY) && st.vals.includes(BODI), JSON.stringify(st.vals));
    check('…with the same "+ Add a new place…" escape hatch',
      /Add a new place/.test(st.opts[st.opts.length - 1]), JSON.stringify(st.opts));
    check('…and its box starts hidden', !st.boxShown);
  }
  await page.evaluate(async () => {
    document.getElementById('le-nt-ano').value = '202';
    document.getElementById('le-nt-date').value = '2026-10-04';
    document.getElementById('le-nt-place').value = 'e-Auction Spices Board Bodinayakanur';
    await leSaveNewTrade();
  });
  await new Promise(r => setTimeout(r, 1200));
  {
    const r = await api('GET', '/api/auctions');
    const row = (r.d || []).find(a => String(a.ano) === '202');
    check('a trade created from Lot Entry keeps its venue', row && row.place === BODI, JSON.stringify(row && row.place));
  }

  console.log('[spiceboard] the Form-D screen says which venue the trade prints');
  {
    const r = await api('GET', '/api/auctions');
    const id202 = (r.d || []).find(a => String(a.ano) === '202').id;
    const id201 = (r.d || []).find(a => String(a.ano) === '201').id;
    const label = async (aid) => page.evaluate(async (aid) => {
      go('spiceboard');
      await fillAucSelect('sb-auction');
      document.getElementById('sb-auction').value = String(aid);
      await onSbAuctionChange();
      await sbLoadPlaces();
      const sel = document.getElementById('sb-place');
      return { first: sel.options[0].textContent.trim(), value: sel.value };
    }, aid);
    const withPlace = await label(id202);
    check('a trade WITH a venue names it on the blank option',
      /This trade:/.test(withPlace.first) && withPlace.first.includes(BODI), JSON.stringify(withPlace));
    check('…and leaves the dropdown unset, so nothing is overridden',
      withPlace.value === '', withPlace.value);
    const without = await label(id201);
    check('a trade WITHOUT one still says "use configured branch"',
      /configured branch/i.test(without.first), JSON.stringify(without));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
