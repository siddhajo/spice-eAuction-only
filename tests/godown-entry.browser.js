// Godown utility — the Entry Type choice on BOTH surfaces, in a headless Chrome.
//
// The operator decides at the scale, before anything else is typed, whether
// this is a booking or a godown receipt. Picking "godown" has to rewire the
// form, not just set a flag, and that is what this checks:
//
//   • the Lot No box stops being a picked/typed auction number and becomes a
//     read-out of the godown series the server owns;
//   • the lot-number grid (desktop) / picker (mobile) disappears — a godown
//     number is deliberately NOT in the trade's allocation, so there is
//     nothing there to pick;
//   • the auction-only controls (Reserved Price, Immediate Payment, Reserve)
//     go away, because they all describe a lot that is going up for sale;
//   • with the feature flag OFF the chooser is not there at all, and the form
//     is exactly the booking form it has always been.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'godown-ui-'));
const PORT = 47389;
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
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && login.d.token;
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: {
    br1: 'BODI', flag_godown: 'true', godown_lot_prefix: 'G',
    // Both auction-only blocks ON, so "they disappear in godown mode" is a
    // real observation rather than them being hidden by their own flags.
    flag_immediate_reserve: 'true', flag_reserved_price: 'true',
  }});
  await api('POST', '/api/auctions', { ano: '1', date: '2026-10-11', crop_type: 'ISP' });
  await api('POST', '/api/auctions/1/allocations', {
    allocations: [{ branch: 'BODI', start_lot: '001', end_lot: '010' }],
  });
  await api('POST', '/api/traders', { name: 'RAVI PLANTER', tel: '9790744444', ppla: 'BODI' });
  // One ordinary booking, so "the godown row is absent" is measured against a
  // list that is not simply empty.
  await api('POST', '/api/lots', { auction_id: 1, lot_no: '001', trader_id: 1, branch: 'BODI',
    grade: '1', bags: 10, litre: '300', qty: 100.5, sample_wt: 0, gross_wt: 100.5 });

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
    cleanup(); process.exit(0);
  }
  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });

  // ══ DESKTOP ══════════════════════════════════════════════════════
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => go('lotentry'));
  await page.waitForSelector('#le-mode', { timeout: 15000 });
  // The branch picker is filled from settings AFTER the screen opens, and the
  // next-lot suggestion reads it — without the wait the suggestion check below
  // measures an empty select rather than the heuristic.
  await page.waitForFunction(
    () => [...document.getElementById('le-branch').options].some(o => o.value === 'BODI'),
    { timeout: 15000 });

  const shown = (sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    return !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  }, sel);

  console.log('[1] The chooser is there, on "Book for auction"');
  check('Entry Type is visible with the flag on', await shown('#le-mode'));
  check('it sits ABOVE the seller — it decides what the rest of the form means',
        await page.evaluate(() => {
          const m = document.querySelector('#le-form-card .feat-godown');
          const s = document.getElementById('le-seller-row');
          if (!m || !s) return false;
          return !!(m.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
        }));
  check('booking is the default', await page.evaluate(() => _le.entryMode === 'auction'));
  check('the lot box is typeable for a booking',
        await page.evaluate(() => document.getElementById('le-lotno').readOnly === false));

  console.log('\n[2] Switching to godown rewires the form');
  await page.evaluate(() => { document.getElementById('le-branch').value = 'BODI'; leSetEntryMode('godown'); });
  await new Promise(r => setTimeout(r, 600));   // the next-number preview is a fetch
  const god = await page.evaluate(() => ({
    mode: _le.entryMode,
    lotRO: document.getElementById('le-lotno').readOnly,
    lotVal: document.getElementById('le-lotno').value,
    hint: getComputedStyle(document.getElementById('le-godown-hint')).display,
    nextLabel: document.getElementById('le-godown-next').textContent,
    irShown: getComputedStyle(document.querySelector('#le-form-card .feat-immediate-reserve')).display,
    rpVis: getComputedStyle(document.querySelector('#le-form-card .feat-reserved-price')).visibility,
    gridHidden: document.getElementById('le-lot-grid-section').dataset.godownHidden,
  }));
  check('the mode sticks', god.mode === 'godown', god.mode);
  check('the lot box becomes a read-out', god.lotRO === true, JSON.stringify(god));
  check('showing the next number in the godown series', /^G\d+$/.test(god.lotVal), god.lotVal);
  check('the explanation is shown', god.hint === 'block', god.hint);
  check('with the same number named in it', god.nextLabel === god.lotVal, god.nextLabel + ' vs ' + god.lotVal);
  check('Immediate Payment + Reserve are gone', god.irShown === 'none', god.irShown);
  check('Reserved Price is gone', god.rpVis === 'hidden', god.rpVis);
  check('and the allocation grid is shut', god.gridHidden === '1', god.gridHidden);

  console.log('\n[3] Ticking Reserve cannot survive the switch');
  const resAfter = await page.evaluate(() => {
    leSetEntryMode('auction');
    document.getElementById('le-reserved').checked = true;
    leSetEntryMode('godown');
    return document.getElementById('le-reserved').checked;
  });
  check('a held godown receipt is a contradiction, so Reserve is cleared', resAfter === false);

  console.log('\n[4] Switching back restores the booking form');
  await page.evaluate(() => leSetEntryMode('auction'));
  await new Promise(r => setTimeout(r, 400));
  const back = await page.evaluate(() => ({
    lotRO: document.getElementById('le-lotno').readOnly,
    hint: getComputedStyle(document.getElementById('le-godown-hint')).display,
    irShown: getComputedStyle(document.querySelector('#le-form-card .feat-immediate-reserve')).display,
    gridHidden: document.getElementById('le-lot-grid-section').dataset.godownHidden,
  }));
  check('the lot box is typeable again', back.lotRO === false, JSON.stringify(back));
  check('the explanation is hidden', back.hint === 'none', back.hint);
  check('the auction-only controls are back', back.irShown !== 'none', back.irShown);
  check('and the grid is allowed to paint again', back.gridHidden === '0', back.gridHidden);
  // Repainted, not merely un-flagged: converting a stored lot into a booking
  // needs a free chip to pick, because the Lot No box is read-only in edit mode.
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('le-lot-grid-section')).display !== 'none',
    { timeout: 10000 }).then(() => check('and repainted, so a number can be picked', true))
    .catch(() => check('and repainted, so a number can be picked', false, 'grid stayed hidden'));

  console.log('\n[5] Saving one through the real form');
  // Drives leSaveLot() itself: the seller is set the way the picker sets it,
  // the weights are typed, and the server is left to number the entry.
  const savedRow = await page.evaluate(async () => {
    const sellers = await j('/api/traders?search=RAVI');
    const list = Array.isArray(sellers) ? sellers : (sellers.traders || sellers.rows || []);
    _le.selectedSeller = list[0];
    _le.selectedBankId = null;
    document.getElementById('le-branch').value = 'BODI';
    leSetEntryMode('godown');
    document.getElementById('le-bags').value = '18';
    document.getElementById('le-litre').value = '300';
    document.getElementById('le-qty').value = '180.5';
    await leSaveLot();
    const rows = await j('/api/lots/1?godown=1');
    return {
      rows: rows.map(r => ({ lot: r.lot_no, godown: Number(r.godown), qty: Number(r.qty), bags: Number(r.bags) })),
      err: document.getElementById('le-err').textContent,
      modeAfter: _le.entryMode,
      boxAfter: document.getElementById('le-lotno').value,
    };
  });
  check('the entry saves with no error', !savedRow.err, savedRow.err);
  check('it lands as a godown row in the godown series',
        savedRow.rows.length === 1 && /^G\d+$/.test(savedRow.rows[0].lot) && savedRow.rows[0].godown === 1,
        JSON.stringify(savedRow.rows));
  check('carrying the weight that was typed',
        savedRow.rows[0] && savedRow.rows[0].qty === 180.5 && savedRow.rows[0].bags === 18,
        JSON.stringify(savedRow.rows[0]));
  check('the form stays in godown mode for the next receipt', savedRow.modeAfter === 'godown', savedRow.modeAfter);
  await page.waitForFunction(() => /^G\d+$/.test(document.getElementById('le-lotno').value), { timeout: 10000 })
    .then(() => check('and previews the next number in the series', true))
    .catch(() => check('and previews the next number in the series', false, 'box: ' + savedRow.boxAfter));
  // Back to a booking for the checks that follow.
  await page.evaluate(() => { _le.selectedSeller = null; leSetEntryMode('auction'); });

  console.log('\n[6] A godown row in the lists says what it is');
  const badges = await page.evaluate(() => {
    _le.recentLots = [{ id: 91, lot_no: 'G001', grade: '1', bags: 18, litre: 300, qty: 180.5,
                        name: 'RAVI PLANTER', branch: 'BODI', godown: 1, created_at: null }];
    _le.recentTotal = 1;
    renderLeRecent();
    const row = document.querySelector('#le-recent-list .le-recent-row') ||
                document.querySelector('.le-recent-row');
    return { html: row ? row.innerHTML : '', cls: row ? row.className : '' };
  });
  check('the recent-entries row is badged GODOWN', /GODOWN/.test(badges.html), badges.cls);
  check('and carries the godown row class', /godown/.test(badges.cls), badges.cls);

  console.log('\n[7] A godown lot number never poisons the next-lot suggestion');
  // Its "G" prefix used to disagree with the branch's numeric lots, and the
  // local fallback then gave up — Lot No stopped auto-filling for the branch.
  const sugg = await page.evaluate(async () => {
    _le.recentLots = [
      { lot_no: '003', branch: 'BODI', godown: 0 },
      { lot_no: 'G001', branch: 'BODI', godown: 1 },
    ];
    document.getElementById('le-branch').value = 'BODI';
    document.getElementById('le-lotno').value = '';
    // Blanking the trade makes leNextLotNo() bail without asking the server,
    // so what is measured here is the LOCAL max+1 heuristic — the one the
    // G-prefix used to break.
    const keepAid = document.getElementById('le-auction').value;
    document.getElementById('le-auction').value = '';
    await leAutoSuggestLotNo();
    const v = document.getElementById('le-lotno').value;
    document.getElementById('le-auction').value = keepAid;
    return v;
  });
  check('the suggestion still comes from the numeric lots', sugg === '004', JSON.stringify(sugg));

  console.log('\n[8] The Auction Desk panel is the AUCTION\'s lots');
  // Its KPI strip says it mirrors computeTradeKpi, and that counts auction
  // lots only — so a stored row must not appear here or in those figures.
  const desk = await page.evaluate(async () => {
    go('hub');
    // The trade picker is REFILLED asynchronously when the screen opens, which
    // wipes a value set too early — wait for the fill to settle, then pick.
    const sel = document.getElementById('hub-auction');
    await new Promise(r => setTimeout(r, 1200));
    for (let i = 0; i < 40 && (!sel || !sel.options.length); i++) await new Promise(r => setTimeout(r, 150));
    if (sel && sel.options.length) sel.value = sel.options[sel.options.length - 1].value;
    await hubLoadLots();
    const lots = (window._hubLots || []).map(l => String(l.lot_no));
    return { lots, anyGodown: lots.some(x => /^G\d/.test(x)),
             picked: sel ? sel.value : null,
             opts: sel ? [...sel.options].map(o => o.value) : [] };
  });
  check('no godown row is listed on the Auction Desk', desk.anyGodown === false, JSON.stringify(desk.lots));
  check('…and the booking still is', desk.lots.includes('001'),
        JSON.stringify({ lots: desk.lots, picked: desk.picked, opts: desk.opts }));
  await page.evaluate(() => go('registers'));
  await new Promise(r => setTimeout(r, 400));

  console.log('\n[9] The Godown Register is offered on the Registers screen');
  const reg = await page.evaluate(() => {
    const sel = document.getElementById('reg-type');
    const opt = sel && sel.querySelector('option[value="godown"]');
    sel.value = 'godown'; onRegTypeChange();
    return {
      offered: !!opt && getComputedStyle(opt).display !== 'none',
      depotShown: getComputedStyle(document.getElementById('reg-branch-wrap')).display !== 'none',
      cols: regColumns('godown').map(c => c.key),
    };
  });
  check('the register type is listed', reg.offered === true);
  check('and asks for a depot', reg.depotShown === true);
  check('its columns are a stock sheet, not a money report',
        reg.cols.includes('bag') && reg.cols.includes('qty') && reg.cols.includes('gross_wt')
        && !reg.cols.includes('amount'), JSON.stringify(reg.cols));

  console.log('\n[10] Flag OFF — the whole choice is not there');
  await api('PUT', '/api/company-settings', { settings: { flag_godown: 'false' } });
  // Put both stale selections in place first, so "pinned back" is a real
  // observation and not a state that happened to be right already.
  await page.evaluate(() => {
    leSetEntryMode('godown', { suggest: false });
    document.getElementById('reg-type').value = 'godown';
  });
  const off = await page.evaluate(async () => {
    // applyFeatureFlags takes no argument and re-reads the settings itself,
    // which is exactly what the Settings screen does after a save.
    await applyFeatureFlags();
    return {
      attr: document.body.getAttribute('data-feat-godown'),
      chooser: getComputedStyle(document.querySelector('#le-form-card .feat-godown')).display,
      mode: _le.entryMode,
      regType: document.getElementById('reg-type').value,
    };
  });
  check('the body flag is off', off.attr === '0', off.attr);
  check('the chooser collapses', off.chooser === 'none', off.chooser);
  check('a stale godown selection is pinned back to a booking', off.mode === 'auction', off.mode);
  check('and the register falls back off the hidden option', off.regType !== 'godown', off.regType);

  // ══ MOBILE ═══════════════════════════════════════════════════════
  console.log('\n[11] Mobile — the same choice, thumb-sized');
  await api('PUT', '/api/company-settings', { settings: { flag_godown: 'true' } });
  const mob = await browser.newPage();
  mob.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await mob.waitForSelector('#le-mode', { timeout: 15000 });
  // The next-number preview is an authenticated call, so the page needs the
  // session the test already holds.
  await mob.evaluate(tok => { token = tok; localStorage.setItem('sa_token', tok); }, TOKEN);
  const m1 = await mob.evaluate(async () => {
    const r = await fetch('/api/config'); const d = await r.json();
    cfgGodown = !!d.godown; cfgGodownPrefix = d.godownPrefix || 'G';
    cfgImmediateReserve = true; cfgShowReservedPrice = true;
    applyGodownVis();
    return {
      wrap: getComputedStyle(document.getElementById('le-mode-wrap')).display,
      mode: entryMode,
      configGodown: !!d.godown,
      prefix: d.godownPrefix,
    };
  });
  check('the config reaches the phone', m1.configGodown === true && m1.prefix === 'G', JSON.stringify(m1));
  check('the chooser shows', m1.wrap !== 'none', m1.wrap);
  check('booking is the default', m1.mode === 'auction', m1.mode);

  const m2 = await mob.evaluate(() => {
    aid = 1; br = 'BODI';
    document.getElementById('le-reserved').checked = true;
    setEntryMode('godown');
    return {
      mode: entryMode,
      picker: getComputedStyle(document.getElementById('le-lot-picker')).display,
      banner: getComputedStyle(document.getElementById('le-godown-banner')).display,
      ir: getComputedStyle(document.getElementById('le-immediate-reserve-wrap')).display,
      rp: getComputedStyle(document.getElementById('le-reserved-price-wrap')).display,
      reserved: document.getElementById('le-reserved').checked,
      pressed: document.querySelector('#le-mode button[data-mode="godown"]').getAttribute('aria-pressed'),
    };
  });
  check('the mode switches', m2.mode === 'godown' && m2.pressed === 'true', JSON.stringify(m2));
  check('the lot picker is replaced by the godown banner',
        m2.picker === 'none' && m2.banner !== 'none', JSON.stringify(m2));
  check('the auction-only controls go away', m2.ir === 'none' && m2.rp === 'none', JSON.stringify(m2));
  check('Reserve is cleared', m2.reserved === false);
  await new Promise(r => setTimeout(r, 600));
  const nextTxt = await mob.evaluate(() => document.getElementById('le-godown-next').textContent);
  check('the banner previews the next godown number', /^#G\d+$/.test(nextTxt), nextTxt);

  console.log('\n[12] Mobile — saving a godown receipt from the phone');
  // The phone sends NO lot number (the banner was a preview), so this also
  // proves the server is the one numbering the series.
  const msave = await mob.evaluate(async () => {
    const r = await fetch('/api/traders?search=RAVI', { headers: ah() });
    const d = await r.json();
    const list = Array.isArray(d) ? d : (d.traders || d.rows || []);
    selT = list[0]; aid = 1; br = 'BODI';
    setEntryMode('godown');
    document.getElementById('le-bags').value = '7';
    document.getElementById('le-litre').value = '295';
    document.getElementById('le-qty').value = '68.75';
    await saveLot();
    const after = await (await fetch('/api/lots/1?godown=1', { headers: ah() })).json();
    return {
      saved: (after || []).map(x => ({ lot: x.lot_no, qty: Number(x.qty), godown: Number(x.godown) })),
      label: document.getElementById('le-saved-label').textContent,
      mode: entryMode,
    };
  });
  const mine = (msave.saved || []).find(x => x.qty === 68.75);
  check('the phone saves a godown row', !!mine && mine.godown === 1, JSON.stringify(msave.saved));
  check('numbered from the godown series by the server', !!mine && /^G\d+$/.test(mine.lot), mine && mine.lot);
  check('and the Saved bar names the number that was stored',
        !!mine && msave.label.indexOf(mine.lot) >= 0, msave.label);
  check('the phone stays in godown mode for the next receipt', msave.mode === 'godown', msave.mode);

  console.log('\n[13] Mobile — a saved godown lot is badged in My Lots');
  const mcard = await mob.evaluate(() => {
    const host = document.getElementById('ml-list');
    if (!host) return { html: '', missing: true };
    renderMyLots([{ id: 5, lot_no: 'G001', grade: '1', bags: 18, litre: 300, qty: 180.5,
                    trader_name: 'RAVI PLANTER', godown: 1, user_id: 'admin', created_at: '' }]);
    const c = host.querySelector('.lot-card');
    return { html: c ? c.outerHTML : '', missing: !c };
  });
  if (mcard.missing) {
    check('My Lots renders a godown card', false, 'no card rendered (renderMyLots/#ml-list changed?)');
  } else {
    check('the card is badged GODOWN', /GODOWN/.test(mcard.html));
    check('and tinted as a godown card', /lot-card godown/.test(mcard.html), mcard.html.slice(0, 80));
  }

  console.log('\n[14] Mobile — flag OFF hides the choice and pins it back');
  const moff = await mob.evaluate(() => {
    cfgGodown = false; applyGodownVis();
    return { wrap: getComputedStyle(document.getElementById('le-mode-wrap')).display, mode: entryMode,
             picker: getComputedStyle(document.getElementById('le-lot-picker')).display };
  });
  check('the chooser is hidden', moff.wrap === 'none', moff.wrap);
  check('the form is a booking form again', moff.mode === 'auction', moff.mode);
  check('with the lot picker back', moff.picker !== 'none', moff.picker);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log('--- server log tail ---\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); });
