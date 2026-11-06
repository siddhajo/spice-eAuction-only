// "✓ Done with alternate sellers" — retiring the feature, and getting it back.
//
// Setting stand-in sellers is a one-off staging job before the Spices Board
// return goes out; afterwards the 🎭 controls are clutter on a screen the
// office uses daily. The dialog's Done button retires them in one action
// instead of sending the user to hunt for a flag.
//
// Two things make this safe rather than destructive, and both are pinned here:
//   • it drives the SAME install flag Settings → Flags drives, so there is one
//     source of truth and no second "hidden" state to disagree with it;
//   • it hides CONTROLS only. Alternate sellers already saved stay on their
//     lots and keep printing on the e-Auction CSV and Form C — "hide this"
//     must never be read as "undo all of it".
//
//   [before]   with the feature on, the button, filter and 🎭 ALT badge show
//   [confirm]  cancelling the prompt changes nothing
//   [hide]     Done hides the button, the Lots filter and the dialog at once
//   [badge]    …and the 🎭 ALT badge goes from the rows WITHOUT a reload.
//              CSS gating only reaches elements that exist in the markup; the
//              badge is painted into a string by the row renderer, so rows
//              already on screen keep it until something repaints them.
//   [keeps]    the masks already saved survive, untouched
//   [output]   THE ONE THAT MATTERS — the e-Auction CSV the Spices Board
//              receives is byte-identical before and after hiding. The first
//              cut of this feature drove flag_lot_dummy_details, which also
//              decides whether a mask PRINTS, so hiding the clutter silently
//              un-masked every seller on the regulator's return. Two settings
//              now: flag_lot_dummy_details is the feature (and the printing),
//              flag_alt_seller_controls is the controls.
//   [setting]  the CONTROLS flag moved and the feature flag did NOT
//   [restore]  turning the controls flag back on brings every control back
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-done-'));
const PORT = 47526;
const B = `http://${'127.0.0.1'}:${PORT}`;

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

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const lr = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = lr.d && (lr.d.token || lr.d.accessToken);
  if (!TOKEN) { console.error('login failed', lr.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', {
    settings: { flag_lot_dummy_details: 'true', br1: 'ANAVILASAM' },
  });
  const auc = await api('POST', '/api/auctions', { ano: '121', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));
  const lotIds = [];
  for (const lot_no of ['001', '002']) {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name: 'REAL SELLER ' + lot_no, cr: '', qty: 100, bags: 10,
      grade: '1', crop: 'CARDAMOM', branch: 'ANAVILASAM',
    });
    lotIds.push(r.d && (r.d.id || (r.d.lot && r.d.lot.id)));
  }
  // A mask already staged — it must survive the hide.
  await api('POST', '/api/lots/dummy-details/bulk', {
    ids: [lotIds[0]], dummy_name: 'STAND-IN SELLER', dummy_tel: '9876500000',
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
  if (!chrome) {
    console.log('  skip no Chrome available — UI checks not run');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    cleanup(); process.exit(0);
  }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  let answerConfirm = true;
  page.on('dialog', d => (answerConfirm ? d.accept() : d.dismiss()).catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });

  // Open Lots on this trade and tick both lots — the button needs a selection.
  const openLotsAndTick = async () => page.evaluate(async (aid, ids) => {
    go('lots');
    await fillAucSelect('lot-auction');
    const sel = document.getElementById('lot-auction'); if (sel) sel.value = String(aid);
    await loadLots();
    document.querySelectorAll('#lots-list .lot-select-cb').forEach(cb => {
      if (ids.includes(Number(cb.value))) { cb.checked = true; }
    });
    BulkActions._sync('lot');
  }, aid, lotIds);

  const shown = (id) => page.evaluate((i) => {
    const el = document.getElementById(i);
    if (!el) return 'missing';
    return getComputedStyle(el).display === 'none' ? 'hidden' : 'shown';
  }, id);
  const featAttr = () => page.evaluate(() => document.body.getAttribute('data-feat-lot-dummy-details'));
  // How many rows in the Lots table are wearing the 🎭 ALT badge.
  const altBadges = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#lots-list tr'))
      .filter(tr => /\u{1F3AD}\s*ALT/u.test(tr.textContent || '')).length);
  // /api/company-settings/flat coerces booleans — it answers `true`, not the
  // stored string 'true'. Normalise rather than comparing to either, so this
  // keeps working whichever shape the endpoint settles on.
  const flagOn = async (key) => {
    const v = ((await api('GET', '/api/company-settings/flat')).d || {})[key];
    return /^(1|true|yes|on)$/i.test(String(v));
  };
  // The actual file the Spices Board receives.
  const eauctionCsv = async () => {
    const r = await fetch(B + `/api/spice-board-reports/eauction_csv/export?format=csv&auctionId=${aid}`,
                          { headers: { Authorization: 'Bearer ' + TOKEN } });
    return r.ok ? Buffer.from(await r.arrayBuffer()).toString('utf8') : `HTTP ${r.status}`;
  };

  console.log('[before] with the feature on, the controls are there');
  // Snapshot the regulator's file BEFORE anything is hidden.
  const csvBefore = await eauctionCsv();
  check('the e-Auction CSV carries the stand-in seller to begin with',
    /STAND-IN SELLER/.test(csvBefore) && !/REAL SELLER 001/.test(csvBefore),
    csvBefore.slice(0, 200));
  await openLotsAndTick();
  check('the 🎭 button is shown', (await shown('lot-bulk-dummy')) === 'shown', await shown('lot-bulk-dummy'));
  check('the Lots alternate-seller filter is shown',
    (await shown('lot-dummy-filter')) === 'shown', await shown('lot-dummy-filter'));
  check('the body gate is on', (await featAttr()) === '1', String(await featAttr()));
  check('the masked lot wears the 🎭 ALT badge', (await altBadges()) === 1,
    `${await altBadges()} badged rows`);

  console.log('[confirm] cancelling the prompt changes nothing');
  {
    answerConfirm = false;
    await page.evaluate(() => openLotDummyDetailsModal());
    await page.waitForFunction(
      () => document.getElementById('lot-dummy-modal')?.classList.contains('show'), { timeout: 8000 });
    check('the Done button is in the dialog', (await shown('ldd-done')) === 'shown', await shown('ldd-done'));
    await page.evaluate(() => lddHideFeature());
    await new Promise(r => setTimeout(r, 400));
    check('declining leaves the controls on', (await flagOn('flag_alt_seller_controls')) === true,
      String(await flagOn('flag_alt_seller_controls')));
    check('…and the dialog still open', 
      await page.evaluate(() => document.getElementById('lot-dummy-modal').classList.contains('show')));
    answerConfirm = true;
  }

  console.log('[hide] Done retires every control at once');
  {
    await page.evaluate(() => lddHideFeature());
    await page.waitForFunction(
      () => document.body.getAttribute('data-feat-lot-dummy-details') === '0', { timeout: 8000 });
    check('the dialog closed',
      await page.evaluate(() => !document.getElementById('lot-dummy-modal').classList.contains('show')));
    check('the 🎭 button is hidden', (await shown('lot-bulk-dummy')) === 'hidden', await shown('lot-bulk-dummy'));
    check('the Lots filter is hidden too',
      (await shown('lot-dummy-filter')) === 'hidden', await shown('lot-dummy-filter'));
    check('and the dialog itself is gated off',
      (await shown('lot-dummy-modal')) === 'hidden', await shown('lot-dummy-modal'));
  }

  console.log('[badge] the 🎭 ALT mark leaves the rows without a reload');
  {
    // The table was already on screen when the flag flipped. Give the
    // repaint a moment, then assert on the live DOM — NOT after a reload,
    // which would hide the very bug this covers.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('#lots-list tr'))
        .filter(tr => /\u{1F3AD}\s*ALT/u.test(tr.textContent || '')).length === 0,
      { timeout: 8000 }).catch(() => {});
    check('no row is badged any more', (await altBadges()) === 0,
      `${await altBadges()} badged rows still showing`);
    check('…and the seller name itself is still there',
      await page.evaluate(() => /REAL SELLER 001/.test(document.getElementById('lots-list').textContent)));
    // It must hold across a reload — this is a stored setting, not a session
    // state that a refresh would undo.
    await page.reload({ waitUntil: 'networkidle2' });
    await openLotsAndTick();
    check('still hidden after a reload, with lots ticked',
      (await shown('lot-bulk-dummy')) === 'hidden', await shown('lot-bulk-dummy'));
  }

  console.log('[keeps] the masks already saved are untouched');
  {
    const lots = ((await api('GET', `/api/lots?auction_id=${aid}&limit=100`)).d || {}).lots || [];
    const masked = lots.find(l => String(l.lot_no) === '001') || {};
    check('the staged alternate name is still on the lot',
      String(masked.dummy_name || '') === 'STAND-IN SELLER', JSON.stringify(masked.dummy_name));
    check('…and its phone', String(masked.dummy_tel || '') === '9876500000', String(masked.dummy_tel));
  }

  console.log('[output] the Spices Board file is UNCHANGED');
  {
    const csvAfter = await eauctionCsv();
    check('the e-Auction CSV still carries the stand-in seller',
      /STAND-IN SELLER/.test(csvAfter), csvAfter.slice(0, 200));
    check('…and still does NOT leak the real one',
      !/REAL SELLER 001/.test(csvAfter), csvAfter.slice(0, 200));
    check('byte-for-byte identical to before hiding — the whole point',
      csvAfter === csvBefore,
      csvAfter === csvBefore ? '' : 'the regulator file CHANGED when the controls were hidden');
  }

  console.log('[setting] the CONTROLS flag moved, the feature flag did not');
  check('flag_alt_seller_controls is now off',
    (await flagOn('flag_alt_seller_controls')) === false,
    String(await flagOn('flag_alt_seller_controls')));
  check('flag_lot_dummy_details is UNTOUCHED — it governs what prints',
    (await flagOn('flag_lot_dummy_details')) === true,
    String(await flagOn('flag_lot_dummy_details')));

  console.log('[restore] Settings → Flags brings it all back');
  {
    await api('PUT', '/api/company-settings', { settings: { flag_alt_seller_controls: 'true' } });
    await page.reload({ waitUntil: 'networkidle2' });
    await openLotsAndTick();
    check('the 🎭 button is back', (await shown('lot-bulk-dummy')) === 'shown', await shown('lot-bulk-dummy'));
    check('the Lots filter is back', (await shown('lot-dummy-filter')) === 'shown', await shown('lot-dummy-filter'));
    check('the body gate is on again', (await featAttr()) === '1', String(await featAttr()));
    check('the 🎭 ALT badge is back on the masked row', (await altBadges()) === 1,
      `${await altBadges()} badged rows`);
    // And the restored controls still see the staged mask.
    await page.evaluate(() => openLotDummyDetailsModal());
    await page.waitForFunction(
      () => document.getElementById('lot-dummy-modal')?.classList.contains('show'), { timeout: 8000 });
    check('the dialog opens again', 
      await page.evaluate(() => document.getElementById('lot-dummy-modal').classList.contains('show')));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
