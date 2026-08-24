// Settings screen — grouped navigation + grouped panels.
//
// The Settings sidebar buckets its 17 categories into 5 collapsible
// groups (SET_NAV_GROUPS), and the big categories render as titled
// section cards instead of one flat column (SET_FIELD_GROUPS).
//
// The thing that must never regress: grouping is presentation only.
// Every field that used to be editable must still render with its
// data-key, because captureCurrentPanel() reads
// `#settings-root [data-key]` and a field that stops rendering stops
// being saveable — silently. So each check below counts data-key
// nodes, not just section headers.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'setgroup-'));
const PORT = 47372;
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

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });

  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
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
  // login() finishes by navigating to the operator's landing tab, and it does
  // so asynchronously — going to Settings before that lands gets overridden.
  await page.waitForFunction(() => document.querySelector('.tc#tc-hub') &&
    getComputedStyle(document.querySelector('#tc-hub')).display !== 'none', { timeout: 20000 }).catch(() => {});
  const openSettings = async () => {
    await page.evaluate(() => go('settings'));
    await page.waitForFunction(() => document.querySelectorAll('#set-nav-items .set-nav-item').length > 0 &&
      document.querySelector('.set-panel')?.offsetParent !== null, { timeout: 20000 });
  };
  await openSettings();

  // ══ [A] Sidebar groups ══════════════════════════════════════════
  console.log('[A] Sidebar — categories bucketed into collapsible groups');
  const nav = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('.set-nav-group-head')].map(h => h.textContent.replace(/▶/, '').trim()),
    openGroups: [...document.querySelectorAll('.set-nav-group-head.open')].map(h => h.textContent.replace(/▶/, '').trim()),
    // Categories rendered at all, open or collapsed
    allCats: [...document.querySelectorAll('#set-nav-items .set-nav-item')].map(b => b.textContent.trim()),
    // Categories the operator can actually click right now
    visibleCats: [...document.querySelectorAll('.set-nav-group-body.open .set-nav-item')].length,
    activeGroupHasClass: !!document.querySelector('.set-nav-group-head.has-active'),
  }));
  check('every category still renders in the nav', nav.allCats.length >= 15, `${nav.allCats.length}: ${nav.allCats.join(' | ')}`);
  check('they are split across several groups', nav.groups.length >= 4, nav.groups.join(' | '));
  check('only one group starts open', nav.openGroups.length === 1, nav.openGroups.join(' | '));
  check('the open group is the one holding the active category', nav.activeGroupHasClass, JSON.stringify(nav));
  check('the collapsed groups really hide their categories', nav.visibleCats < nav.allCats.length, `${nav.visibleCats} of ${nav.allCats.length} clickable`);

  // Accordion: opening a second group closes the first, so the nav never
  // creeps back into a 17-item column. Clicking the open one collapses it.
  const toggled = await page.evaluate(() => {
    const heads = () => [...document.querySelectorAll('.set-nav-group-head')];
    const shut = heads().find(h => !h.classList.contains('open'));
    const shutLabel = shut.textContent.replace(/▶/, '').trim();
    shut.click();
    const afterOpen = heads().filter(h => h.classList.contains('open')).map(h => h.textContent.replace(/▶/, '').trim());
    heads().find(h => h.classList.contains('open')).click();   // click the open one
    const afterCollapse = heads().filter(h => h.classList.contains('open')).length;
    return { shutLabel, afterOpen, afterCollapse };
  });
  check('opening another group closes the previous one', toggled.afterOpen.length === 1, toggled.afterOpen.join(' | '));
  check('the group that opened is the one clicked', toggled.afterOpen[0] === toggled.shutLabel, JSON.stringify(toggled));
  check('clicking the open group collapses it', toggled.afterCollapse === 0, String(toggled.afterCollapse));

  // ══ [B] Search spans groups ═════════════════════════════════════
  // Navigating to a category in another group must bring that group open,
  // otherwise the just-selected category is unreachable in the sidebar.
  const afterSelect = await page.evaluate(() => {
    selectCat('tally');
    const open = [...document.querySelectorAll('.set-nav-group-head.open')];
    return {
      openCount: open.length,
      activeVisible: !!document.querySelector('.set-nav-group-body.open .set-nav-item.active'),
    };
  });
  check('selecting a category opens exactly its own group', afterSelect.openCount === 1, JSON.stringify(afterSelect));
  check('the active category is visible in the open group', afterSelect.activeVisible, JSON.stringify(afterSelect));

  console.log('\n[B] Search — matches surface regardless of collapse state');
  const searched = await page.evaluate(() => {
    filterSettings('gst');
    return {
      openGroups: [...document.querySelectorAll('.set-nav-group-head.open')].length,
      totalGroups: [...document.querySelectorAll('.set-nav-group-head')].length,
      cats: [...document.querySelectorAll('.set-nav-group-body.open .set-nav-item')].map(b => b.textContent.trim()),
    };
  });
  check('searching force-opens every group with a hit', searched.openGroups === searched.totalGroups,
    `${searched.openGroups}/${searched.totalGroups}`);
  check('matching categories are reachable while searching', searched.cats.length > 0, searched.cats.join(' | '));
  await page.evaluate(() => filterSettings(''));

  // ══ [C] Panels group without dropping fields ════════════════════
  console.log('\n[C] Panels — section cards keep every editable field');
  // Baseline: what SHOULD render, straight from the client's own copy of
  // the settings, applying the same mode/flag/engine visibility rules the
  // panel applies. If grouping swallowed a field, expected > actual.
  const cats = ['flags', 'lot_entry', 'invoice', 'rates', 'alerts', 'tally', 'company', 'branches', 'bank'];
  for (const ck of cats) {
    const r = await page.evaluate((ck) => {
      selectCat(ck);
      const expected = (_sdata[ck] || [])
        .filter(f => !isFieldHiddenByMode(f.key) && !isFieldHiddenByFlag(f.key))
        .filter(f => !/_engine$/.test(f.key));
      const rendered = [...document.querySelectorAll('#settings-root [data-key]')].map(el => el.dataset.key);
      return {
        expected: expected.map(f => f.key),
        rendered,
        missing: expected.map(f => f.key).filter(k => !rendered.includes(k)),
        dupes: rendered.filter((k, i) => rendered.indexOf(k) !== i),
        sections: [...document.querySelectorAll('#settings-root .set-group-head h3')].map(h => h.textContent.trim()),
      };
    }, ck);
    check(`${ck}: all ${r.expected.length} fields render`, r.missing.length === 0, 'missing: ' + r.missing.join(', '));
    check(`${ck}: no field rendered twice`, r.dupes.length === 0, 'dupes: ' + r.dupes.join(', '));
    if (r.sections.length) console.log(`       ${ck} sections: ${r.sections.join(' · ')}`);
  }

  // ══ [C2] Section cards collapse ═════════════════════════════════
  console.log('\n[C2] Sections — collapsible, without losing their fields');
  const coll = await page.evaluate(() => {
    selectCat('tally');
    const cards = () => [...document.querySelectorAll('#settings-root .set-group')];
    const keysNow = () => [...document.querySelectorAll('#settings-root [data-key]')].map(e => e.dataset.key);
    const before = keysNow().length;
    const first = cards()[0];
    const firstTitle = first.querySelector('h3').textContent.trim();
    const badge = Number(first.querySelector('.g-n').textContent.trim());
    const bodyFields = first.querySelectorAll('.set-group-body [data-key]').length;

    first.querySelector('.set-group-head').click();          // collapse it
    const closedVisible = first.querySelector('.set-group-body').offsetParent !== null;
    const afterCollapse = keysNow().length;                  // must be unchanged

    first.querySelector('.set-group-head').click();          // re-open
    const reopened = first.classList.contains('open');
    return { before, afterCollapse, closedVisible, reopened, firstTitle, badge, bodyFields, cards: cards().length };
  });
  check('the header badge matches the fields in the card', coll.badge === coll.bodyFields,
    `${coll.firstTitle}: badge ${coll.badge} vs ${coll.bodyFields} fields`);
  check('clicking a section header hides its body', !coll.closedVisible, JSON.stringify(coll));
  check('a collapsed section keeps its fields in the DOM (still saveable)',
    coll.afterCollapse === coll.before, `${coll.before} -> ${coll.afterCollapse}`);
  check('clicking again re-opens the section', coll.reopened, JSON.stringify(coll));

  // Collapse state must survive a repaint — toggling a flag re-renders the
  // whole panel, and silently re-expanding everything defeats collapsing.
  const persisted = await page.evaluate(() => {
    selectCat('flags');
    const titleOf = c => c.querySelector('h3').textContent.trim();
    const cards = () => [...document.querySelectorAll('#settings-root .set-group')];
    const target = cards()[1];
    const title = titleOf(target);
    target.querySelector('.set-group-head').click();         // collapse #2
    renderSettingsPanel();                                   // full repaint
    const after = cards().find(c => titleOf(c) === title);
    const others = cards().filter(c => titleOf(c) !== title).every(c => c.classList.contains('open'));
    return { title, stillClosed: !after.classList.contains('open'), others };
  });
  check('a collapsed section stays collapsed across a repaint', persisted.stillClosed, JSON.stringify(persisted));
  check('the other sections stay open', persisted.others, JSON.stringify(persisted));

  // Expand/collapse-all button.
  const allBtn = await page.evaluate(() => {
    selectCat('flags');
    const btn = document.getElementById('set-group-toggle');
    const cards = () => [...document.querySelectorAll('#settings-root .set-group')];
    const shown = btn.style.display !== 'none';
    btn.click();
    const openAfterCollapse = cards().filter(c => c.classList.contains('open')).length;
    const labelWhenClosed = btn.textContent.trim();
    btn.click();
    const openAfterExpand = cards().filter(c => c.classList.contains('open')).length;
    const labelWhenOpen = btn.textContent.trim();
    selectCat('company');                                    // no sections here
    const hiddenOnFlatCat = document.getElementById('set-group-toggle').style.display === 'none';
    return { shown, openAfterCollapse, openAfterExpand, labelWhenClosed, labelWhenOpen, total: cards().length, hiddenOnFlatCat };
  });
  check('the Collapse/Expand-all button shows on a sectioned category', allBtn.shown, JSON.stringify(allBtn));
  check('it collapses every section', allBtn.openAfterCollapse === 0, JSON.stringify(allBtn));
  check('its label then reads "Expand all"', allBtn.labelWhenClosed === 'Expand all', allBtn.labelWhenClosed);
  check('it expands every section back', allBtn.openAfterExpand > 0, JSON.stringify(allBtn));
  check('its label then reads "Collapse all"', allBtn.labelWhenOpen === 'Collapse all', allBtn.labelWhenOpen);
  check('it is hidden on a category with no sections', allBtn.hiddenOnFlatCat, JSON.stringify(allBtn));

  // Searching must override collapse, same as it overrides the nav accordion.
  const searchOpens = await page.evaluate(() => {
    selectCat('tally');
    document.getElementById('set-group-toggle').click();      // collapse everything
    filterSettings('ledger');
    const cards = [...document.querySelectorAll('#settings-root .set-group')];
    const r = { total: cards.length, open: cards.filter(c => c.classList.contains('open')).length };
    filterSettings('');
    return r;
  });
  check('a search re-opens the sections holding the matches',
    searchOpens.total > 0 && searchOpens.open === searchOpens.total, JSON.stringify(searchOpens));

  // ══ [C3] The panel scrolls on its own ═══════════════════════════
  console.log('\n[C3] Scroll — long categories scroll inside the panel');
  await openSettings();   // this block needs real layout, not just the DOM
  const scroll = await page.evaluate(() => {
    selectCat('tally');
    // The collapse tests above left Tally's sections shut; expand them so
    // this measures a genuinely long category.
    const btn = document.getElementById('set-group-toggle');
    if (btn.textContent.trim() === 'Expand all') btn.click();
    const root = document.getElementById('settings-root');
    const panel = document.querySelector('.set-panel');
    const before = root.scrollTop;
    root.scrollTop = 400;
    const moved = root.scrollTop;
    const headerRect = document.querySelector('.set-panel-hdr').getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(root).overflowY,
      scrollable: root.scrollHeight > root.clientHeight + 20,
      scrollH: root.scrollHeight, clientH: root.clientHeight,
      openCards: document.querySelectorAll('#settings-root .set-group.open').length,
      fields: document.querySelectorAll('#settings-root [data-key]').length,
      before, moved,
      panelWithinViewport: panelRect.height <= window.innerHeight,
      headerStaysAtPanelTop: Math.abs(headerRect.top - panelRect.top) < 40,
      pageScrollHeight: document.documentElement.scrollHeight,
    };
  });
  check('the panel body is an overflow-y:auto region', scroll.overflowY === 'auto', scroll.overflowY);
  check('a long category actually overflows it', scroll.scrollable, JSON.stringify(scroll));
  check('it scrolls independently of the page', scroll.moved > scroll.before, JSON.stringify(scroll));
  check('the panel is capped to the viewport', scroll.panelWithinViewport, JSON.stringify(scroll));
  check('the category title stays pinned at the panel top', scroll.headerStaysAtPanelTop, JSON.stringify(scroll));

  const resets = await page.evaluate(() => {
    const root = document.getElementById('settings-root');
    root.scrollTop = 500;
    selectCat('flags');
    return root.scrollTop;
  });
  check('switching category rewinds the scroll to the top', resets === 0, String(resets));

  // Scrolling the PAGE must not bury the panel title / Collapse-all button
  // under the sticky Save bar — both columns pin below it.
  const pinned = await page.evaluate(async () => {
    selectCat('tally');
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => requestAnimationFrame(r));
    const bar = document.querySelector('.set-actions-bar').getBoundingClientRect();
    const hdr = document.querySelector('.set-panel-hdr').getBoundingClientRect();
    const nav = document.querySelector('.set-nav').getBoundingClientRect();
    const btn = document.getElementById('set-group-toggle').getBoundingClientRect();
    const r = {
      stickyTop: getComputedStyle(document.documentElement).getPropertyValue('--set-sticky-top').trim(),
      barBottom: Math.round(bar.bottom), hdrTop: Math.round(hdr.top), navTop: Math.round(nav.top),
      btnVisible: btn.top >= bar.bottom - 1 && btn.bottom <= window.innerHeight,
      navFits: Math.round(nav.bottom) <= window.innerHeight,
    };
    window.scrollTo(0, 0);
    return r;
  });
  check('the sticky offset is measured, not left at the fallback', /^\d+px$/.test(pinned.stickyTop), pinned.stickyTop);
  check('the panel title clears the Save bar when the page is scrolled',
    pinned.hdrTop >= pinned.barBottom - 1, JSON.stringify(pinned));
  check('the sidebar clears it too', pinned.navTop >= pinned.barBottom - 1, JSON.stringify(pinned));
  check('the Collapse-all button stays on screen', pinned.btnVisible, JSON.stringify(pinned));
  check('the pinned sidebar fits the viewport', pinned.navFits, JSON.stringify(pinned));

  // ══ [D] Edits survive switching between grouped panels ══════════
  console.log('\n[D] Editing — a value typed in a section card still saves');
  const saved = await page.evaluate(async () => {
    selectCat('rates');
    const el = document.querySelector('#settings-root [data-key="gunny_rate"]');
    if (!el) return { err: 'gunny_rate did not render' };
    const inSection = !!el.closest('.set-group');
    el.value = '77';
    selectCat('flags');        // captureCurrentPanel() runs on the way out
    const flagEl = document.querySelector('#settings-root [data-key="flag_hsn"]');
    const flagWas = flagEl.checked;
    flagEl.checked = !flagWas;
    selectCat('rates');
    await saveSettings();
    const d = await j('/api/company-settings');
    const flat = {};
    for (const c of Object.keys(d.settings || {})) for (const f of d.settings[c]) flat[f.key] = f.value;
    return { inSection, rate: flat.gunny_rate, flag: flat.flag_hsn, flagWas: String(flagWas) };
  });
  check('the rate field renders inside a section card', saved.inSection, JSON.stringify(saved));
  check('a typed rate persists across panel switches', String(saved.rate) === '77', JSON.stringify(saved));
  check('a toggled flag in a section card persists', String(saved.flag) !== saved.flagWas, JSON.stringify(saved));

  // saveSettings() navigates away, so come back before capturing.
  await page.evaluate(() => { go('settings'); });
  await page.waitForFunction(() => document.querySelectorAll('#set-nav-items .set-nav-item').length > 0, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 1200));   // let the settings re-fetch settle
  const settle = async (fn) => {
    await page.evaluate(fn);
    await new Promise(r => setTimeout(r, 400));
  };
  await settle(() => {
    document.querySelectorAll('.toast,#toast,[class*="toast"],[class*="banner"]').forEach(t => t.remove());
    selectCat('flags');
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const keep = path.join(os.tmpdir(), 'settings-grouped.png');
  await page.screenshot({ path: keep, fullPage: false });

  // Everything collapsed — the whole category as a scannable index.
  await settle(() => { document.getElementById('set-group-toggle').click(); });
  const keep2 = path.join(os.tmpdir(), 'settings-collapsed.png');
  await page.screenshot({ path: keep2, fullPage: false });

  await settle(() => {
    document.getElementById('set-group-toggle').click();
    selectCat('tally');
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const keep3 = path.join(os.tmpdir(), 'settings-tally.png');
  await page.screenshot({ path: keep3, fullPage: false });
  console.log('\n  screenshots:\n    ' + [keep, keep2, keep3].join('\n    '));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
