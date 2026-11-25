// A BUNDLE CAN CARRY THE THREE SHAPES OF A PURCHASE, NOT JUST THE INVOICE.
//
// A dealer's purchase is ONE document the office prints three ways — the
// purchase invoice, the bill statement and the per-lot payment voucher. The
// row already offered all three as chips. A BUNDLE could not: "Download all",
// and "Download N" after selecting rows, always sent invoices, with nothing
// on screen saying so and no way to ask otherwise.
//
// The server half (?formats=) is pinned in customer-portal.http.js. This is
// the part a dealer actually touches:
//
//   [offer]   the chooser appears where a bundle is on offer, and not where
//             there is nothing to choose between
//   [toggle]  shapes turn on and off, and the last one cannot be turned off
//             (that would ask for an empty file)
//   [send]    the choice really reaches the bundle request — the whole bug
//             was a screen that looked like it had asked for something
//   [select]  it works for a SELECTION too, which is what was asked for
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portalfmt-'));
const PORT = 3000 + Math.floor(Math.random() * 1500) + 400;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + JSON.stringify(d).slice(0, 300) : '')); }
};

let T = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' },
                                   T ? { Authorization: 'Bearer ' + T } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
let browser = null;
const cleanup = () => {
  try { if (browser) browser.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};
// The log channel is the only one that exists until SMS is connected, so the
// test reads the code the way an admin would.
const codeFor = (pkey) => {
  const hits = srvLog.match(new RegExp(`OTP for ${pkey}: (\\d{6})`, 'g')) || [];
  const last = hits[hits.length - 1] || '';
  return (last.match(/(\d{6})$/) || [])[1] || '';
};

(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  T = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  await api('PUT', '/api/company-settings', { settings: {
    gunny_rate: '150', br1: 'BODI', flag_customer_portal: 'true' } });

  // A registered dealer (GSTIN → purchase invoice, which is the row that has
  // three shapes) with TWO purchases, so a selection is a real choice.
  const PHONE = '9790700020';
  const A = (await api('POST', '/api/auctions',
    { ano: '31', date: '2026-11-18', crop_type: 'ISP' })).d.id;
  await api('POST', `/api/auctions/${A}/allocations`,
    { allocations: [{ branch: 'BODI', from_no: 100, to_no: 300 }] });
  await api('POST', '/api/traders',
    { name: 'DEALER SPICES', tel: PHONE, place: 'BODI', cr: '33AAAAA0000A1Z5' });
  const tAll = (await api('GET', '/api/traders?search=DEALER')).d;
  const tRows = Array.isArray(tAll) ? tAll : ((tAll && tAll.rows) || []);
  const sid = (tRows.find(t => /DEALER SPICES/i.test(t.name)) || {}).id;
  await api('PUT', `/api/traders/${sid}`,
    { name: 'DEALER SPICES', tel: PHONE, cr: '33AAAAA0000A1Z5' });
  await api('POST', '/api/buyers', { buyer: 'BUY1', buyer1: 'BUYER ONE', pla: 'BODI' });
  for (const lot of ['140', '141']) {
    await api('POST', '/api/lots', { auction_id: A, lot_no: lot, trader_id: sid,
      name: 'DEALER SPICES', branch: 'BODI', bags: 9, qty: 212.4, gross_wt: 213.4,
      cr: '33AAAAA0000A1Z5' });
  }
  let lots = (await api('GET', `/api/lots/${A}`)).d || [];
  await api('POST', '/api/lots/bulk-set-buyer',
    { ids: lots.map(l => l.id), code: 'BUY1', buyer: 'BUY1', buyer1: 'BUYER ONE', sale: 'L' });
  await api('POST', '/api/lots/bulk-price', { items: lots.map(l => ({ id: l.id, price: 3000 })) });
  await api('POST', `/api/lots/calculate/${A}`, {});
  // One purchase per lot, so the dealer has two rows to pick between.
  await api('PUT', '/api/company-settings', { settings: { flag_lotwise_purchase: 'true' } });
  await api('POST', `/api/purchases/generate-all/${A}`, { startInvoiceNo: 500 });
  const purAll = (await api('GET', `/api/purchases?auction_id=${A}`)).d;
  const purRows = Array.isArray(purAll) ? purAll : ((purAll && purAll.rows) || []);
  check('fixture: the dealer holds a purchase invoice',
        purRows.filter(x => x.trader_id === sid).length >= 1,
        { rows: purRows.length });

  // Sign in through the real OTP flow, then hand the page the session the
  // same way the page itself stores it.
  await fetch(B + '/api/portal/otp/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE }) });
  await new Promise(r => setTimeout(r, 300));
  const vr = await fetch(B + '/api/portal/otp/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, code: codeFor(PHONE) }) });
  const vj = await vr.json().catch(() => null);
  const ptok = vj && vj.token;
  check('fixture: the dealer can sign in to the portal', !!ptok, vj);
  if (!ptok) { console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(1); }

  let chrome = null;
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)) {
    try { if (fs.existsSync(p)) { chrome = { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; break; } } catch (_) {}
  }
  if (!chrome) { console.log('  skip no Chrome available'); console.log(`\n${pass} passed, ${fail} failed\n`); cleanup(); process.exit(0); }

  browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
  // A phone, because that is where this is read.
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(B + '/my', { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => sessionStorage.setItem('portal_token', t), ptok);
  await page.goto(B + '/my', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#doclist .doc').length > 0,
    { timeout: 20000 });

  const shapes = () => page.evaluate(() => {
    const box = document.getElementById('shapes');
    // Tolerates a missing element on purpose: without it, a page that has no
    // chooser at all CRASHES this suite instead of failing it, and a crash
    // says nothing about which of these promises was broken.
    if (!box) return { shown: false, labels: [], on: [], lead: '', missing: true,
                       overflows: false };
    const btns = Array.from(box.querySelectorAll('button'));
    return {
      shown: !box.hidden && btns.length > 0,
      labels: btns.map(b => b.textContent.trim()),
      on: btns.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim()),
      lead: (box.querySelector('.lb') || {}).textContent || '',
      overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  const clickShape = (label) => page.evaluate(l => {
    const box = document.getElementById('shapes');
    if (!box) return false;
    const b = Array.from(box.querySelectorAll('button'))
      .find(x => x.textContent.trim() === l);
    if (b) b.click();
    return !!b;
  }, label);

  // ── [offer] ──────────────────────────────────────────────────────
  console.log('\n[offer] the chooser appears where a bundle is on offer');
  let st = await shapes();
  check('browsing a dealer\'s documents offers the three shapes', st.shown, st);
  check('…named as the row chips name them',
        st.labels.join(',') === 'Invoice,Statement,Voucher', st.labels);
  check('…with the invoice already on, which is what a bundle always held',
        st.on.join(',') === 'Invoice', st.on);
  check('…introduced, so three bare words are not left unexplained',
        /Include/i.test(st.lead), st.lead);
  check('…and it does not push the phone sideways', !st.overflows, st);

  // ── [toggle] ─────────────────────────────────────────────────────
  console.log('\n[toggle] shapes turn on and off, but never all off');
  await clickShape('Statement');
  st = await shapes();
  check('adding a shape turns it on without turning the invoice off',
        st.on.join(',') === 'Invoice,Statement', st.on);
  await clickShape('Invoice');
  st = await shapes();
  check('…and either one can be dropped', st.on.join(',') === 'Statement', st.on);
  await clickShape('Statement');
  st = await shapes();
  check('turning the LAST one off is refused — an empty file is not a choice',
        st.on.join(',') === 'Statement', st.on);

  // ── [send] ───────────────────────────────────────────────────────
  // The bug being prevented: a chooser that looks answered while the
  // request still says invoices.
  console.log('\n[send] the choice reaches the bundle request');
  await clickShape('Voucher');
  await page.evaluate(() => {
    window.__urls = [];
    const real = window.fetch;
    window.fetch = function (u) {
      const s = String(typeof u === 'string' ? u : (u && u.url) || '');
      window.__urls.push(s);
      if (s.indexOf('/documents/bulk') > -1) {
        // Answer with a PDF so the page's save path runs to the end.
        return Promise.resolve(new Response(
          new Blob([new Uint8Array([37, 80, 68, 70, 45])], { type: 'application/pdf' }),
          { status: 200, headers: { 'Content-Disposition': 'attachment; filename="x.pdf"' } }));
      }
      return real.apply(this, arguments);
    };
  });
  await page.evaluate(() => document.getElementById('grab').click());
  await new Promise(r => setTimeout(r, 900));
  const asked = await page.evaluate(() =>
    (window.__urls || []).find(u => u.indexOf('/documents/bulk') > -1) || '');
  check('Download all sends the chosen shapes', /formats=/.test(asked), asked);
  const fmt = decodeURIComponent((asked.match(/formats=([^&]*)/) || [])[1] || '');
  check('…exactly the ones that are on, and no others',
        fmt.split(',').sort().join(',') === 'statement,voucher', { sent: fmt });
  check('…and never the invoice it was not asked for',
        fmt.indexOf('purchase') === -1, { sent: fmt });

  // ── [select] ─────────────────────────────────────────────────────
  // What was actually asked for: the chooser must work for a SELECTION of
  // several documents, not only for "Download all".
  console.log('\n[select] it works on a selection too');
  await page.evaluate(() => { window.__urls = []; document.getElementById('pickbtn').click(); });
  await new Promise(r => setTimeout(r, 300));
  const selEmpty = await page.evaluate(() => ({
    hidden: !document.getElementById('shapes') || document.getElementById('shapes').hidden,
    grabDisabled: document.getElementById('grab').disabled,
  }));
  check('with nothing ticked there is nothing to shape yet',
        selEmpty.hidden && selEmpty.grabDisabled, selEmpty);
  const ticked = await page.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll('#doclist .doc .pick'));
    cbs.forEach(cb => { cb.checked = true; cb.onchange(); });
    return cbs.length;
  });
  await new Promise(r => setTimeout(r, 300));
  st = await shapes();
  check('ticking documents brings the chooser back', st.shown, { ticked, ...st });
  check('…remembering what was chosen a moment ago',
        st.on.join(',') === 'Statement,Voucher', st.on);
  await clickShape('Invoice');
  await page.evaluate(() => document.getElementById('grab').click());
  await new Promise(r => setTimeout(r, 900));
  const asked2 = await page.evaluate(() =>
    (window.__urls || []).find(u => u.indexOf('/documents/bulk') > -1) || '');
  check('…and Download N carries both the ids and the shapes',
        /[?&]ids=/.test(asked2) && /formats=/.test(asked2), asked2);
  const fmt2 = decodeURIComponent((asked2.match(/formats=([^&]*)/) || [])[1] || '');
  check('…all three when all three are on',
        fmt2.split(',').sort().join(',') === 'purchase,statement,voucher', { sent: fmt2 });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nCRASHED:', e && e.stack || e);
  console.error('\n--- server log ---\n' + srvLog.slice(-2500));
  cleanup();
  process.exit(1);
});
