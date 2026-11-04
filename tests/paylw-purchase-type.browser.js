// Payments — Lot-wise: the RD / URD purchase-type views, driven through the
// REAL screen in a headless Chrome.
//
// The server-side split is covered by paylw-purchase-type.http.js. What only a
// browser can answer is whether the URD view actually FOLDS: one row per
// seller, the lot count as the disclosure control, aggregates that add up, and
// — the part that protects money — a group checkbox that ticks its own lots
// and nothing else, so the export count still reconciles.
//
//   [switch]  the control exists, defaults to Both, and Both is today's screen
//   [fold]    URD = one row per seller, with the lot count and summed figures
//   [expand]  clicking the count reveals that seller's ordinary lot rows
//   [tick]    a group box ticks exactly its own payable lots
//   [mixed]   a seller whose lots differ says "mixed" rather than picking one
//   [rd]      RD stays strictly lot-wise
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paylw-ptype-ui-'));
const PORT = 47471;
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
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

  await api('PUT', '/api/company-settings', { settings: { flag_lotwise_payments: 'true', br1: 'ANAVILASAM' } });
  const auc = await api('POST', '/api/auctions', { ano: '61', date: '2026-10-20', state: 'TAMIL NADU' });
  const aid = auc.d && (auc.d.id || (auc.d.auction && auc.d.auction.id));

  // One RD dealer with 2 lots, and two URD planters: one with 3 lots in a
  // single branch, one with 2 lots across two branches (the "mixed" case).
  const mk = async (name, cr, banks) => {
    const t = await api('POST', '/api/traders',
      { name, cr, padd: 'ADDR', ppla: 'PLACE', banks: banks || [] });
    const id = t.d && (t.d.id || (t.d.trader && t.d.trader.id));
    if (!id) { console.error('trader failed', name, t.status, t.d); cleanup(); process.exit(1); }
    return id;
  };
  const acct = (n, holder) => [{ acctnum: n, ifsc: 'HDFC0001234', bank_name: 'HDFC',
    holder_name: holder, account_type: 'Savings', is_default: 1 }];
  const dealerId  = await mk('AAA TRADERS',    'GSTIN.33AAHCE4551A1Z8', acct('1000011111', 'AAA TRADERS'));
  const planterId = await mk('MURUGANANDAM K', '',                      acct('1000022222', 'MURUGANANDAM K'));
  const mixedId   = await mk('RAVI KUMAR',     'CR.4821',               acct('1000033333', 'RAVI KUMAR'));

  const addLot = async (lot_no, name, cr, traderId, branch) => {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, cr, qty: 100, bags: 10,
      grade: cr ? '2' : '1', crop: 'CARDAMOM', branch, trader_id: traderId,
    });
    const id = r.d && (r.d.id || (r.d.lot && r.d.lot.id));
    if (!id) { console.error('lot failed', lot_no, r.status, r.d); cleanup(); process.exit(1); }
    await api('PUT', `/api/lots/${id}`, { price: 2000, amount: 200000, balance: 196000 });
    return id;
  };
  await addLot('1', 'AAA TRADERS', 'GSTIN.33AAHCE4551A1Z8', dealerId, 'ANAVILASAM');
  await addLot('2', 'AAA TRADERS', 'GSTIN.33AAHCE4551A1Z8', dealerId, 'ANAVILASAM');
  await addLot('3', 'MURUGANANDAM K', '', planterId, 'ANAVILASAM');
  await addLot('4', 'MURUGANANDAM K', '', planterId, 'ANAVILASAM');
  await addLot('5', 'MURUGANANDAM K', '', planterId, 'ANAVILASAM');
  await addLot('6', 'RAVI KUMAR', 'CR.4821', mixedId, 'ANAVILASAM');
  await addLot('7', 'RAVI KUMAR', 'CR.4821', mixedId, 'BODINAYAKANUR');

  // ── Drive the real screen ────────────────────────────────────────────
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
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });

  await page.evaluate(a => {
    if (typeof showTab === 'function') showTab('payments');
    const sel = document.getElementById('paylw-auction');
    if (sel) sel.value = String(a);
  }, aid);
  await page.evaluate(() => loadPayLotwise && loadPayLotwise());
  await page.evaluate(a => {
    const sel = document.getElementById('paylw-auction');
    if (sel) { sel.value = String(a); payLwOnAuctionChange(); }
  }, aid);

  // Search under a given purchase type, with the bank filter wide open.
  const search = async (ptype) => {
    await page.evaluate(p => {
      const l = document.getElementById('paylw-link');   if (l) l.value = 'all';
      const t = document.getElementById('paylw-ptype');  if (t) t.value = p;
    }, ptype);
    await page.evaluate(() => payLwSearch());
    await page.waitForFunction(() => {
      const b = document.getElementById('paylw-body');
      return b && (b.querySelector('table') || /No lots matched|No unlinked/.test(b.textContent));
    }, { timeout: 8000 });
  };
  // Only TOP-LEVEL rows: an expanded group nests a whole table inside a <tr>,
  // and those child rows must not be counted as rows of the outer table.
  const topRows = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body > .paylw-scroll > table > tbody > tr'))
    .filter(tr => !tr.classList.contains('paylw-grp-kids'))
    .map(tr => ({
      group:   tr.getAttribute('data-paylw-group') || '',
      seller:  (tr.children[1]?.textContent || '').trim(),
      lotCell: (tr.children[2]?.textContent || '').trim(),
      qty:     (tr.children[3]?.textContent || '').trim(),
      branch:  (tr.children[4]?.textContent || '').trim(),
      bank:    (tr.children[5]?.textContent || '').trim(),
      payable: (tr.children[7]?.textContent || '').trim().replace(/\s+/g, ' '),
    })));
  const selectedCount = () => page.evaluate(() => _payLwState.selected.size);
  const header = () => page.evaluate(() => Array.from(
    document.querySelectorAll('#paylw-body > .paylw-scroll > table > thead th'))
    .map(th => th.textContent.trim()));

  console.log('[switch] the control is there and defaults to the old screen');
  {
    const opts = await page.evaluate(() => {
      const s = document.getElementById('paylw-ptype');
      return s ? { value: s.value, options: Array.from(s.options).map(o => o.value) } : null;
    });
    check('the Purchase type select exists', !!opts, String(opts));
    check('…offering all / rd / urd',
      opts && JSON.stringify(opts.options) === JSON.stringify(['all', 'rd', 'urd']),
      opts && JSON.stringify(opts.options));
    check('…and defaulting to Both', opts && opts.value === 'all', opts && opts.value);
    await search('all');
    const rows = await topRows();
    check('Both lists every lot, one row each — unchanged behaviour',
      rows.length === 7 && rows.every(r => !r.group),
      `${rows.length} rows :: ${rows.map(r => r.lotCell).join(',')}`);
    check('…under a "Lot" column', (await header()).includes('Lot'), (await header()).join(' | '));
  }

  console.log('[rd] RD Purchase stays strictly lot-wise');
  {
    await search('rd');
    const rows = await topRows();
    check('only the dealer\'s two lots, one row each',
      rows.length === 2 && rows.every(r => !r.group && /AAA TRADERS/.test(r.seller)),
      `${rows.length} :: ${rows.map(r => r.seller + '/' + r.lotCell).join(' | ')}`);
    check('lot numbers, not counts', rows.map(r => r.lotCell).join(',') === '1,2',
      rows.map(r => r.lotCell).join(','));
    check('the column is still "Lot"', (await header()).includes('Lot'));
  }

  console.log('[fold] URD Purchase folds one row per seller');
  let urdRows;
  {
    await search('urd');
    urdRows = await topRows();
    check('two sellers, not five lots', urdRows.length === 2,
      `${urdRows.length} :: ${urdRows.map(r => r.seller).join(' | ')}`);
    check('every row is a group row', urdRows.every(r => r.group.startsWith('t:')),
      urdRows.map(r => r.group).join(' | '));
    check('the column heading becomes "Lots"',
      (await header()).includes('Lots') && !(await header()).includes('Lot'),
      (await header()).join(' | '));
    const mk = urdRows.find(r => /MURUGANANDAM/.test(r.seller));
    const rk = urdRows.find(r => /RAVI KUMAR/.test(r.seller));
    check('the planter with 3 lots says so', mk && /3 lots/.test(mk.lotCell), mk && mk.lotCell);
    check('the planter with 2 lots says so', rk && /2 lots/.test(rk.lotCell), rk && rk.lotCell);
    check('Qty is summed over the seller\'s lots (3 × 100)',
      mk && /300/.test(mk.qty.replace(/,/g, '')), mk && mk.qty);
    // 3 × 1,96,000 = 5,88,000. Read as a NUMBER rather than pattern-matched,
    // so a wrong sum that happens to contain the digits cannot pass.
    const asNum = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
    check('Payable is summed over the seller\'s lots (3 × 1,96,000 = 5,88,000)',
      mk && asNum(mk.payable) === 588000, mk && `${mk.payable} → ${asNum(mk.payable)}`);
    check('…and the other seller\'s is its own 2 × 1,96,000 = 3,92,000',
      rk && asNum(rk.payable) === 392000, rk && `${rk.payable} → ${asNum(rk.payable)}`);
    check('no RD seller appears in the URD view',
      !urdRows.some(r => /AAA TRADERS/.test(r.seller)), urdRows.map(r => r.seller).join(' | '));
  }

  console.log('[mixed] differing values are named, not guessed');
  {
    const rk = (await topRows()).find(r => /RAVI KUMAR/.test(r.seller));
    check('two branches on one seller reads "mixed"', rk && /mixed/i.test(rk.branch),
      rk && rk.branch);
    const mk = (await topRows()).find(r => /MURUGANANDAM/.test(r.seller));
    check('one branch on one seller reads the branch', mk && /ANAVILASAM/.test(mk.branch),
      mk && mk.branch);
    check('a single shared account is shown, not called mixed',
      mk && /1000022222/.test(mk.bank), mk && mk.bank);
  }

  console.log('[expand] the lot count opens the seller');
  {
    const key = (await topRows()).find(r => /MURUGANANDAM/.test(r.seller)).group;
    await page.evaluate(k => payLwToggleGroup(k), key);
    await page.waitForFunction(() => !!document.querySelector('#paylw-body tr.paylw-grp-kids'), { timeout: 8000 });
    const kids = await page.evaluate(() => Array.from(
      document.querySelectorAll('#paylw-body tr.paylw-grp-kids tbody tr'))
      .map(tr => (tr.children[2]?.textContent || '').trim()));
    check('its three lot rows appear', kids.length === 3 && kids.join(',') === '3,4,5', kids.join(','));
    check('the outer table still shows two seller rows',
      (await topRows()).length === 2, String((await topRows()).length));
    check('the disclosure arrow flips to open',
      /▾/.test((await topRows()).find(r => /MURUGANANDAM/.test(r.seller)).lotCell));
    await page.evaluate(k => payLwToggleGroup(k), key);
    const stillThere = await page.evaluate(() => !!document.querySelector('#paylw-body tr.paylw-grp-kids'));
    check('clicking again closes it', !stillThere);
  }

  console.log('[tick] a group box ticks exactly its own lots');
  {
    await search('urd');
    await page.evaluate(() => payLwTickAll(false));
    check('nothing selected to start', (await selectedCount()) === 0, String(await selectedCount()));
    const key = (await topRows()).find(r => /MURUGANANDAM/.test(r.seller)).group;
    await page.evaluate(k => payLwTickGroup(k, true), key);
    check('ticking the 3-lot seller selects 3 lots', (await selectedCount()) === 3,
      String(await selectedCount()));
    const ids = await page.evaluate(() => [..._payLwState.selected]);
    const names = await page.evaluate(sel => _payLwState.lots
      .filter(l => sel.includes(l.id)).map(l => l.name), ids);
    check('…and they are all that seller\'s',
      names.length === 3 && names.every(n => /MURUGANANDAM/.test(n)), names.join(' | '));
    const key2 = (await topRows()).find(r => /RAVI KUMAR/.test(r.seller)).group;
    await page.evaluate(k => payLwTickGroup(k, true), key2);
    check('ticking the other seller adds its 2, for 5', (await selectedCount()) === 5,
      String(await selectedCount()));
    await page.evaluate(k => payLwTickGroup(k, false), key);
    check('unticking the first leaves only the second\'s 2', (await selectedCount()) === 2,
      String(await selectedCount()));
    // The group box's tri-state has to be set in JS — assert it really is.
    await page.evaluate(() => {
      const l = _payLwState.lots.find(x => /MURUGANANDAM/.test(x.name));
      _payLwState.selected.add(l.id);
      _payLwRender();
    });
    const tri = await page.evaluate(k => {
      const cb = document.querySelector(`#paylw-body .paylw-cb-group[data-key="${k}"]`);
      return cb ? { checked: cb.checked, indeterminate: cb.indeterminate } : null;
    }, key);
    check('one of three ticked shows the group box indeterminate',
      tri && tri.indeterminate === true && tri.checked === false, JSON.stringify(tri));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
