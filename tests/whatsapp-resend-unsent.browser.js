// "↻ Select unsent" — resending only what WhatsApp did not deliver.
//
// A bulk run that Meta stops partway used to be unrecoverable: the queue's
// ledger died with the modal, and the rows the breaker never attempted were
// never POSTed anywhere, so the send log knew nothing about them. Every send
// now carries a ref naming its record, and the rows that never left the
// building are written to the log too — which lets a screen line its rows up
// against the log and tick exactly the ones still owed.
//
// The property this test exists to protect is NEGATIVE: a row the log says
// nothing about is UNKNOWN, not unsent, and must never be ticked. Refs only
// started being recorded on 2026-10-10, so every document raised before that
// has no record — ticking those would send a second copy to buyers served
// months ago.
//
// Real Chrome because the whole thing is live DOM: a button that must be
// visible before anything is ticked, a per-row mark painted into the
// checkbox cell, and a selection that has to hand off to the existing
// "WhatsApp Selected" flow.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-resend-'));
const PORT = 47389;
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

// Six invoices, one per outcome the button has to tell apart.
const ROWS = [
  { id: 1, buyer: 'AA', buyer1: 'ALPHA TRADERS',  sale: 'L', invo: '101', ano: '11', date: '2026-10-10', bag: 1, qty: 10, amount: 900, cgst: 25, sgst: 25, igst: 0, tot: 1000 },
  { id: 2, buyer: 'BB', buyer1: 'BETA SPICES',    sale: 'L', invo: '102', ano: '11', date: '2026-10-10', bag: 2, qty: 20, amount: 180, cgst: 10, sgst: 10, igst: 0, tot: 200 },
  { id: 3, buyer: 'CC', buyer1: 'GAMMA EXPORTS',  sale: 'L', invo: '103', ano: '11', date: '2026-10-10', bag: 3, qty: 30, amount: 28,  cgst: 1,  sgst: 1,  igst: 0, tot: 30 },
  { id: 4, buyer: 'DD', buyer1: 'DELTA MASALA',   sale: 'L', invo: '104', ano: '11', date: '2026-10-10', bag: 4, qty: 40, amount: 48,  cgst: 1,  sgst: 1,  igst: 0, tot: 50 },
  { id: 5, buyer: 'EE', buyer1: 'EPSILON SPICES', sale: 'L', invo: '105', ano: '11', date: '2026-10-10', bag: 5, qty: 50, amount: 58,  cgst: 1,  sgst: 1,  igst: 0, tot: 60 },
  { id: 6, buyer: 'FF', buyer1: 'ZETA TRADERS',   sale: 'L', invo: '106', ano: '11', date: '2026-10-10', bag: 6, qty: 60, amount: 68,  cgst: 1,  sgst: 1,  igst: 0, tot: 70 },
];

// What the send log answers for ref_type=invoice, newest first — the order
// the route guarantees and the reader depends on.
//   1 delivered      → went out, leave it
//   2 failed         → Meta refused it, resend
//   3 not_attempted  → the breaker stopped the run before this row, resend
//   4 no ref at all, but yesterday's message NAMED it → read back out of the
//     caption, which is how a trade sent before 10 Oct is recognised
//   5 not_attempted then sent → a retry that worked; newest word wins
//   6 nothing anywhere → genuinely unknown; the operator is asked, not guessed at
const LOG = [
  { id: 90, ref_type: 'invoice', ref_id: '5', status: 'sent',          error: '',                              created_at: '2026-10-10 10:40', updated_at: '2026-10-10 10:40' },
  { id: 85, ref_type: '', ref_id: '', status: 'sent', error: '', caption: 'your SALES INVOICE L-104 for ₹50 is attached.', created_at: '2026-10-09 16:00', updated_at: '2026-10-09 16:00' },
  { id: 80, ref_type: 'invoice', ref_id: '3', status: 'not_attempted', error: 'Not attempted — Spam Rate limit hit', created_at: '2026-10-10 10:05', updated_at: '2026-10-10 10:05' },
  { id: 70, ref_type: 'invoice', ref_id: '2', status: 'failed',        error: 'Message undeliverable',          created_at: '2026-10-10 10:04', updated_at: '2026-10-10 10:04' },
  { id: 60, ref_type: 'invoice', ref_id: '1', status: 'delivered',     error: '',                              created_at: '2026-10-10 10:03', updated_at: '2026-10-10 10:03' },
  { id: 50, ref_type: 'invoice', ref_id: '5', status: 'not_attempted', error: 'Not attempted — Spam Rate limit hit', created_at: '2026-10-10 10:02', updated_at: '2026-10-10 10:02' },
];

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
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
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
  await new Promise(r => setTimeout(r, 1500));
  // NOT `.toast` — that selector matches #toast itself, and this test reads
  // the toast for every one of its outcomes.
  await page.evaluate(() => { document.querySelectorAll('.banner-dismiss,#dismiss-banner').forEach(e => e.remove()); });

  // The whole feature hangs off the WhatsApp flag; a test install may have it
  // off, which would hide the button under the .feat-whatsapp gate.
  await page.evaluate(() => document.body.setAttribute('data-feat-whatsapp', '1'));

  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => go('invoices'));
    await new Promise(r => setTimeout(r, 300));
    if (await page.evaluate(() => !!document.getElementById('tc-invoices')?.classList.contains('active'))) break;
  }
  check('the Sales Invoices screen is on screen',
    await page.evaluate(() => !!document.getElementById('tc-invoices')?.classList.contains('active')));

  // Stub both the invoice list and the send log. Left installed for the rest
  // of the run: the button re-reads the log every time it is pressed, by
  // design — a stale answer would tick a row someone has since been sent.
  await page.evaluate(async (rows, log) => {
    const realFetch = window.fetch;
    window.__realFetch = realFetch;
    window.__logCalls = 0;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (/\/api\/invoices\?/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ rows, total: rows.length, page: 1, pageSize: 50 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (/\/api\/whatsapp\/messages/.test(u)) {
        window.__logCalls++;
        // Two sweeps: by ref (the new way) and by caption text (the history).
        const q = /[?&]q=([^&]*)/.exec(u);
        const hit = q
          ? log.filter(r => String(r.caption || '').toLowerCase().includes(decodeURIComponent(q[1]).toLowerCase()))
          : log.filter(r => r.ref_type === (/ref_type=([^&]*)/.exec(u) || [, ''])[1]);
        return Promise.resolve(new Response(JSON.stringify(hit),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(url, opts);
    };
    await loadInvoices();
  }, ROWS, LOG);
  await new Promise(r => setTimeout(r, 400));

  console.log('[1] The button is reachable before anything is ticked');
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#tc-invoices button')]
      .find(x => /Select unsent/.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.textContent.trim(), visible: r.width > 0 && r.height > 0, title: b.title };
  });
  check('an "↻ Select unsent" button exists on the Sales Invoices toolbar', !!btn, JSON.stringify(btn));
  // The point of the button is to CREATE a selection, so unlike every other
  // "Selected" action it cannot live behind the ticked-rows gate.
  check('…and it is visible with no rows ticked', !!btn && btn.visible, JSON.stringify(btn));
  check('…and its tooltip says it will not guess at rows with no record',
    !!btn && /no send record are left alone/i.test(btn.title), btn && btn.title);

  console.log('[2] A mark per row, and none where the log has nothing to say');
  const marks = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#invoices-list .inv-select-cb').forEach(cb => {
      const m = cb.parentNode.querySelector('.wa-mark');
      out[cb.value] = m ? { color: m.style.color, title: m.title } : null;
    });
    return out;
  });
  const rgb = (s) => String(s || '').replace(/\s/g, '');
  check('a delivered invoice is marked green',
    marks['1'] && rgb(marks['1'].color) === 'rgb(22,163,74)' && /Delivered/.test(marks['1'].title), JSON.stringify(marks['1']));
  check('a refused one is marked red, quoting Meta',
    marks['2'] && rgb(marks['2'].color) === 'rgb(220,38,38)' && /Message undeliverable/.test(marks['2'].title), JSON.stringify(marks['2']));
  check('one the run never reached is amber, not red',
    marks['3'] && rgb(marks['3'].color) === 'rgb(217,119,6)' && /Never tried/.test(marks['3'].title), JSON.stringify(marks['3']));
  check('an invoice sent BEFORE refs existed is still recognised, from the message text',
    marks['4'] && rgb(marks['4'].color) === 'rgb(134,201,159)' && /matched by message text/.test(marks['4'].title),
    JSON.stringify(marks['4']));
  check('an invoice with nothing anywhere gets no mark at all',
    marks['6'] === null, JSON.stringify(marks['6']));
  check('a row retried successfully shows its newest status, not its first',
    marks['5'] && /Sent/.test(marks['5'].title) && !/Never tried/.test(marks['5'].title), JSON.stringify(marks['5']));

  console.log('[3] Pressing it asks before touching rows it knows nothing about');
  // A stale tick on a delivered row would put a second copy in the run.
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('#invoices-list .inv-select-cb')].find(c => c.value === '1');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const press = async () => {
    await page.evaluate(() => {
      [...document.querySelectorAll('#tc-invoices button')]
        .find(x => /Select unsent/.test(x.textContent || '')).click();
    });
    await new Promise(r => setTimeout(r, 700));
  };
  const prompt = () => page.evaluate(() => {
    const m = document.getElementById('wa-unsent-modal');
    if (!m || m.style.display === 'none') return null;
    return {
      nums: (document.getElementById('wa-unsent-nums') || {}).textContent || '',
      warn: (document.getElementById('wa-unsent-warn') || {}).textContent || '',
      known: (document.getElementById('wa-unsent-known') || {}).textContent || '',
      all: (document.getElementById('wa-unsent-all') || {}).textContent || '',
    };
  });
  const ticks = () => page.evaluate(() =>
    [...document.querySelectorAll('#invoices-list .inv-select-cb')]
      .filter(c => c.checked).map(c => c.value).sort());

  await press();
  let p = await prompt();
  check('it raises a prompt rather than deciding for the operator', !!p, JSON.stringify(p));
  check('…showing all three buckets', !!p && /2/.test(p.nums) && /1/.test(p.nums), JSON.stringify(p && p.nums));
  check('…and saying out loud that "no record" is not "not sent"',
    !!p && /does not mean/i.test(p.warn), JSON.stringify(p && p.warn));
  check('…with both ways out labelled by how many they tick',
    !!p && /Tick the 2 that failed/.test(p.known) && /Tick all 3/.test(p.all),
    JSON.stringify(p && [p.known, p.all]));

  console.log('[3b] "Only the ones that failed" — the safe answer');
  await page.evaluate(() => _waUnsentAnswer(false));
  await new Promise(r => setTimeout(r, 700));
  let t = await ticks();
  check('exactly the refused and never-tried rows are ticked',
    JSON.stringify(t) === JSON.stringify(['2', '3']), JSON.stringify(t));
  check('the delivered row that was already ticked is CLEARED', !t.includes('1'), JSON.stringify(t));
  check('the one recognised from its message text is left alone', !t.includes('4'), JSON.stringify(t));
  check('the successfully retried row is left alone', !t.includes('5'), JSON.stringify(t));
  check('and the unknown row is NOT ticked by this answer', !t.includes('6'), JSON.stringify(t));

  console.log('[4] It hands off to the normal send flow');
  const toast = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  check('the toast counts the two problems separately',
    /2 ticked/.test(toast) && /1 failed/.test(toast) && /1 never tried/.test(toast), JSON.stringify(toast));
  check('…and points at the button that actually sends',
    /WhatsApp Selected/.test(toast), JSON.stringify(toast));
  const sendBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#tc-invoices button')]
      .find(x => /WhatsApp Selected/.test(x.textContent || ''));
    const r = b && b.getBoundingClientRect();
    return b ? { visible: r.width > 0 && r.height > 0 } : null;
  });
  check('the green "WhatsApp Selected" button is now showing',
    sendBtn && sendBtn.visible, JSON.stringify(sendBtn));

  console.log('[4b] "Tick all" — for a batch the operator knows was never sent');
  await press();
  await page.evaluate(() => _waUnsentAnswer(true));
  await new Promise(r => setTimeout(r, 700));
  t = await ticks();
  check('the unknown row joins the failures',
    JSON.stringify(t) === JSON.stringify(['2', '3', '6']), JSON.stringify(t));
  check('but rows known to have gone out STILL are not ticked',
    !t.includes('1') && !t.includes('4') && !t.includes('5'), JSON.stringify(t));
  const toast2 = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  check('and the toast owns up to the guess it was told to make',
    /1 with no record/.test(toast2), JSON.stringify(toast2));

  console.log('[4c] Cancel leaves the selection exactly as it was');
  await press();
  await page.evaluate(() => _waUnsentAnswer(null));
  await new Promise(r => setTimeout(r, 400));
  check('cancelling changes nothing',
    JSON.stringify(await ticks()) === JSON.stringify(['2', '3', '6']), JSON.stringify(await ticks()));

  console.log('[5] The log is re-read on every press, never cached into staleness');
  const before = await page.evaluate(() => window.__logCalls);
  await page.evaluate(() => {
    [...document.querySelectorAll('#tc-invoices button')]
      .find(x => /Select unsent/.test(x.textContent || '')).click();
  });
  await new Promise(r => setTimeout(r, 600));
  check('pressing it again asks the server afresh',
    await page.evaluate(() => window.__logCalls) > before,
    `before=${before} after=${await page.evaluate(() => window.__logCalls)}`);

  console.log('[6] An unreadable log ticks NOTHING rather than guessing');
  await page.evaluate(() => {
    document.querySelectorAll('#invoices-list .inv-select-cb').forEach(cb => { cb.checked = false; });
    syncInvoiceMaster();
  });
  await page.evaluate(() => {
    const prev = window.fetch;
    window.fetch = (url, opts) => /\/api\/whatsapp\/messages/.test(String(url))
      ? Promise.resolve(new Response('{}', { status: 500 }))
      : prev(url, opts);
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('#tc-invoices button')]
      .find(x => /Select unsent/.test(x.textContent || '')).click();
  });
  // j() treats a 5xx as transient and retries three times with 300/900ms
  // backoff before it gives up, so the verdict takes over a second to land.
  await new Promise(r => setTimeout(r, 3500));
  const afterFail = await page.evaluate(() => ({
    ticked: [...document.querySelectorAll('#invoices-list .inv-select-cb')].filter(c => c.checked).length,
    toast: (document.getElementById('toast') || {}).textContent || '',
  }));
  // Not "it clears the selection" — it must not TOUCH the selection. Whatever
  // the operator had ticked is theirs; the button simply declines to act.
  check('nothing is ticked when the log cannot be read', afterFail.ticked === 0, JSON.stringify(afterFail));
  check('…and the operator is told why, not told "nothing to resend"',
    /Could not read/.test(afterFail.toast) && !/Nothing to resend/.test(afterFail.toast), JSON.stringify(afterFail.toast));

  // A look at the real thing: the button beside the green send button, and a
  // dot per row in the checkbox column.
  try {
    await page.evaluate(() => {
      document.querySelectorAll('#invoices-list .inv-select-cb').forEach(cb => { cb.checked = false; });
      syncInvoiceMaster();
    });
    // Repaint against the stub, not the empty test database — the picture is
    // meant to show the five outcomes, not an install with no history.
    await page.evaluate(() => loadInvoices());
    await new Promise(r => setTimeout(r, 600));
    // Scroll the list into view — the marks live in the checkbox column and
    // the toolbar alone proves nothing about them.
    await page.evaluate(() => {
      document.querySelectorAll('.banner,.notice-banner').forEach(e => e.remove());
      const t = document.getElementById('invoices-list');
      if (t) t.closest('table').scrollIntoView({ block: 'center' });
    });
    await new Promise(r => setTimeout(r, 300));
    // The prompt itself, on top of the marked list.
    if (process.env.WA_SHOT_PROMPT) {
      await page.evaluate(() => {
        [...document.querySelectorAll('#tc-invoices button')]
          .find(x => /Select unsent/.test(x.textContent || '')).click();
      });
      await new Promise(r => setTimeout(r, 900));
    }
    const shot = path.join(os.tmpdir(), 'wa-resend-unsent.png');
    await page.screenshot({ path: shot });
    console.log('  screenshot: ' + shot);
  } catch (_) {}

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
