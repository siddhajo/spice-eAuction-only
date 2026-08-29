// App Activity log — the detailed row, rendered in a real headless Chrome.
//
// The HTTP test proves the server records the detail; this proves the widget
// SHOWS it: a plain-English summary line, the named fields under it, and the
// per-document roll of a batch behind a disclosure.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'act-log-ui-'));
const PORT = 47362;
const B = `http://127.0.0.1:${PORT}`;
const SHOT = process.env.SHOT_DIR || TMP;

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
const cleanup = keep => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  if (!keep) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
};

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  // single_session would refuse a second `admin` sign-in from the browser.
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });

  // ── Fixture: a trade whose activity covers the interesting shapes ──
  const auc = await api('POST', '/api/auctions', { ano: '12', date: '2026-08-28', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);
  await api('POST', '/api/buyers', { buyer: 'AK', buyer1: 'MURUGAN TRADERS', pla: 'BODI' });
  await api('POST', '/api/buyers', { buyer: 'BK', buyer1: 'SELVAM & CO', pla: 'CUMBUM' });
  await api('POST', '/api/buyers', { buyer: 'CK', buyer1: 'ANNAI SPICES', pla: 'THENI' });
  const lotIds = [];
  for (const [lot_no, buyer, qty] of [['1','AK',120],['2','AK',80],['3','BK',200],['4','CK',60],['5','CK',140]]) {
    const r = await api('POST', '/api/lots', { auction_id: aid, lot_no, name: 'PLANTER ' + lot_no, qty, grade: '1', bags: 6 });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    lotIds.push(id);
    await api('PUT', `/api/lots/${id}`, { buyer, buyer1: buyer, price: 1250, amount: qty * 1250, bags: 6, sale: 'L' });
  }
  await api('POST', `/api/invoices/generate/${aid}`, { sellerName: 'AK', buyerCode: 'AK', invoiceNo: '1201', saleType: 'L' });
  await api('POST', `/api/invoices/generate-all/${aid}`, { startInvoiceNo: 1202 });
  await api('POST', `/api/payments/${aid}/advance`, { name: 'PLANTER 1', advance: 25000 });
  await api('POST', `/api/payments/lots/${aid}/mark-paid`, { lotIds: [lotIds[0], lotIds[1]] });
  const bl = await api('GET', '/api/buyers?q=AK');
  const ak = ((bl.d && (bl.d.rows || bl.d)) || []).find(r => r.buyer === 'AK');
  if (ak) await api('PUT', `/api/buyers/${ak.id}`, Object.assign({}, ak, { pla: 'THENI', tel: '9876543210' }));

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
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 2 });
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

  // Open Backup → App Activity log through the real UI path.
  await page.evaluate(() => go('backup'));
  await new Promise(r => setTimeout(r, 700));
  await page.evaluate(() => {
    const body = document.getElementById('backup-activity-body');
    if (body && body.style.display === 'none') toggleBackupActivity(); else backupActLoad();
  });
  await page.waitForFunction(() => document.querySelectorAll('#bk-act-tbody tr').length > 3, { timeout: 15000 });

  // Direct children only — the per-document roll nests its own <tr>s.
  const rows = await page.evaluate(() => [...document.querySelectorAll('#bk-act-tbody > tr')].map(tr => ({
    action: tr.children[2]?.textContent.trim(),
    entity: tr.children[3]?.textContent.trim(),
    doc:    tr.children[4]?.textContent.trim(),
    sum:    tr.querySelector('.act-sum')?.textContent.trim() || '',
    chips:  [...tr.querySelectorAll('.act-meta span > .act-field')].map(s => s.textContent.trim()),
    items:  [...tr.querySelectorAll('.act-items tr')].map(r => [...r.children].map(c => c.textContent.trim()).filter(Boolean).join(' ')),
    disc:   tr.querySelector('.act-more > summary')?.textContent.trim() || '',
    title:  tr.getAttribute('title') || '',
  })));

  console.log('[A] Rows read as sentences');
  const gen = rows.find(r => /Generated/.test(r.action));
  check('the single generate shows its invoice number in the Document column',
        !!gen && gen.doc === '1201', gen && gen.doc);
  check('its summary names document, buyer, trade and value',
        !!gen && /Invoice 1201/.test(gen.sum) && /MURUGAN TRADERS/.test(gen.sum) && /#12/.test(gen.sum) && /₹/.test(gen.sum),
        gen && gen.sum);
  check('the fields the summary does NOT spell out render as labelled chips',
        !!gen && gen.chips.includes('Bags:') && gen.chips.includes('Sale:') && gen.chips.includes('Lot no:'),
        gen && JSON.stringify(gen.chips));
  check('fields the summary already states are not repeated as chips',
        !!gen && !gen.chips.includes('Party:') && !gen.chips.includes('Value:'),
        gen && JSON.stringify(gen.chips));
  check('the row carries its origin on hover', !!gen && /IP |POST /.test(gen.title), gen && gen.title);
  if (gen) console.log('       → ' + gen.sum);

  console.log('\n[B] A batch stays one row but stays answerable');
  const batch = rows.find(r => /Batch/.test(r.action));
  check('the batch row is present', !!batch);
  check('the Document column shows the number range', !!batch && /1202/.test(batch.doc), batch && batch.doc);
  check('the summary counts the documents and totals the value',
        !!batch && /invoices?/.test(batch.sum) && /₹/.test(batch.sum), batch && batch.sum);
  check('the per-document roll is behind a disclosure',
        !!batch && /document/.test(batch.disc), batch && batch.disc);
  check('each document in the roll names its buyer',
        !!batch && batch.items.length >= 2 && batch.items.every(t => /SELVAM|ANNAI|MURUGAN/.test(t)),
        batch && JSON.stringify(batch.items));
  if (batch) console.log('       → ' + batch.sum + '  [' + batch.disc + ']');

  console.log('\n[C] Money and master edits');
  const adv = rows.find(r => /Advance/.test(r.action));
  const paid = rows.find(r => /^Paid$/.test(r.action));
  const edit = rows.find(r => /Updated/.test(r.action) && /buyer/.test(r.entity));
  check('the advance names the seller and the amount',
        !!adv && /PLANTER 1/.test(adv.sum) && /25,000/.test(adv.sum), adv && adv.sum);
  check('mark-paid names whose lots were settled',
        !!paid && /PLANTER/.test(paid.sum), paid && paid.sum);
  check('a master edit still shows its A→B diff',
        !!edit && await page.evaluate(() => !!document.querySelector('#bk-act-tbody .act-diff .act-to')),
        edit && edit.sum);
  if (adv) console.log('       → ' + adv.sum);
  if (paid) console.log('       → ' + paid.sum);

  console.log('\n[D] Nothing is left blank');
  check('every rendered row has a summary line',
        rows.every(r => r.sum), JSON.stringify(rows.filter(r => !r.sum).map(r => r.action + '/' + r.entity)));
  check('no row shows the old bare em-dash detail',
        !(await page.evaluate(() => [...document.querySelectorAll('#bk-act-tbody td.act-changes')].some(td => td.textContent.trim() === '—'))));

  // Open every disclosure so the screenshot shows the full shape.
  await page.evaluate(() => {
    // Make sure the Backup tab is the one on screen (the "another admin is
    // signed in" notice can steal focus back to the hub) and get the notice
    // out of the frame.
    if (typeof go === 'function') go('backup');
    document.querySelectorAll('.tc').forEach(t => { t.style.display = t.id === 'tc-backup' ? 'block' : 'none'; });
    document.querySelectorAll('[class*="toast"],[id*="toast"],[class*="banner"]').forEach(n => { n.style.display = 'none'; });
    const card = document.getElementById('backup-activity-card');
    if (card) card.scrollIntoView({ block: 'start' });
    // The table scrolls inside its own max-height box; let it grow so the
    // screenshot shows the whole feed rather than the first two rows.
    const box = document.querySelector('#backup-activity-body div[style*="overflow"]');
    if (box) { box.style.maxHeight = 'none'; box.style.overflow = 'visible'; }
  });
  await new Promise(r => setTimeout(r, 300));
  // Open the per-document rolls last — switching tabs above re-renders the rows.
  await page.evaluate(() => document.querySelectorAll('#bk-act-tbody details').forEach(d => d.open = true));
  const shot = path.join(SHOT, 'activity-log.png');
  const box = await page.evaluate(() => {
    const el = document.getElementById('backup-activity-card');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, window.innerWidth), height: Math.min(r.height, window.innerHeight) };
  });
  if (box && box.height > 20) await page.screenshot({ path: shot, clip: box });
  else await page.screenshot({ path: shot });
  console.log('\nscreenshot: ' + shot);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(srvLog.slice(-1500));
  cleanup(!!process.env.SHOT_DIR);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
