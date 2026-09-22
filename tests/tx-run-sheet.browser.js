// Price Entry → "⚡ Generate All Documents" — the review sheet, driven in a
// real browser.
//
// The sheet is the only place a wrong start number can be caught before five
// statutory series are consumed, so what it SHOWS is the feature. This checks
// the things a server test cannot: that the button is on Price Entry, that the
// sheet lists a row per document type with an editable start number, that the
// sales rows say they are DRAFTS, that the "Will use" range tracks what is
// typed, that a re-run finds nothing left to do, and that the one row which
// would renumber an existing draft starts unticked.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txsheet-'));
const PORT = 47427;
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
let br;
async function cleanup() {
  try { if (br) await br.close(); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}


// WCAG contrast of an element against the first opaque background behind it.
// Same helper shape as tests/_ramp.js uses for its page-wide sweep.
const CONTRAST_FNS = `
 function _l(c){const v=c.map(x=>{x/=255;return x<=.03928?x/12.92:Math.pow((x+.055)/1.055,2.4)});return .2126*v[0]+.7152*v[1]+.0722*v[2]}
 function _p(s){const m=String(s).match(/\\d+(\\.\\d+)?/g)||[];return[+m[0]||0,+m[1]||0,+m[2]||0]}
 function _bg(el){let e=el;while(e){const b=getComputedStyle(e).backgroundColor;const m=String(b).match(/\\d+(\\.\\d+)?/g);if(m&&(m.length<4||parseFloat(m[3])>0)&&b!=='transparent')return _p(b);e=e.parentElement}return[255,255,255]}
 function K(el){const a=_l(_p(getComputedStyle(el).color)),b=_l(_bg(el));const hi=Math.max(a,b),lo=Math.min(a,b);return Math.round(((hi+.05)/(lo+.05))*100)/100}
`;

const GST = '33AAAAA0000A1Z5';
(async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  TOKEN = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).d.token;
  // The seeded `admin` account is not what the UI logs in with in the other
  // browser tests — a separate admin user is created and used instead.
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });
  await api('PUT', '/api/company-settings',
    { settings: { flag_debit_note: 'true', flag_debit_note_planter: 'true',
                  flag_proforma_invoice: 'true' } });

  // A trade with BOTH sale types, so the sheet has to split sales invoices
  // into one row per series.
  const aid = (await api('POST', '/api/auctions', { ano: '901', date: '2026-09-18', state: 'TAMIL NADU' })).d.id;
  await api('POST', '/api/buyers', { buyer: 'BL', buyer1: 'LOCAL BUYER', sale: 'L' });
  await api('POST', '/api/buyers', { buyer: 'BI', buyer1: 'INTER BUYER', sale: 'I' });
  const mk = async (lot_no, name, buyer, cr) => {
    const r = await api('POST', '/api/lots', {
      auction_id: aid, lot_no, name, cr: cr || '', qty: 100,
      grade: cr ? '2' : '1', bags: 10, crop: 'CARDAMOM',
    });
    const id = r.d.id || (r.d.lot && r.d.lot.id);
    await api('PUT', `/api/lots/${id}`, { buyer, price: 500, amount: 50000 });
  };
  await mk('1', 'AAA TRADERS', 'BL', GST);
  await mk('2', 'BBB TRADERS', 'BI', GST);
  await mk('3', 'PLANTER AAA', 'BL', '');
  await api('POST', `/api/lots/calculate/${aid}`);

  const ep = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(p => fs.existsSync(p));
  if (!ep) { console.log('no Chrome — skipping'); await cleanup(); process.exit(0); }
  br = await pptr.launch({ executablePath: ep, args: ['--no-sandbox'], headless: true });
  const page = await br.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message)));
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inp-u');
  await page.evaluate(() => {
    document.getElementById('inp-u').value = 'uiadmin';
    document.getElementById('inp-p').value = 'pw1234';
    login();
  });
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });

  // ── The button ──────────────────────────────────────────────────
  console.log('[A] The button is on Price Entry');
  // Let the app finish booting before switching tabs — it restores the last
  // tab on load, which would otherwise land on top of our go().
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => go('priceentry'));
  await page.waitForFunction(
    () => document.getElementById('tc-priceentry')?.classList.contains('active'),
    { timeout: 10000 });
  await new Promise(r => setTimeout(r, 800));
  const btn = await page.evaluate(() => {
    const b = document.getElementById('pe-gen-all');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { text: b.textContent.trim(), visible: !!b.offsetParent,
             display: cs.display, perm: document.body.getAttribute('data-perm-invoice-write'),
             tabShown: getComputedStyle(document.getElementById('tc-priceentry')).display };
  });
  check('⚡ Generate All Documents is present and visible',
        btn && btn.visible && /Generate All Documents/.test(btn.text), JSON.stringify(btn));

  // ── The sheet ───────────────────────────────────────────────────
  console.log('\n[B] It opens a review sheet, one row per document type');
  await page.evaluate(aid => { _pe.aid = aid; openTxRunModal(); }, aid);
  await page.waitForFunction(() => document.querySelectorAll('#tx-run-body .tx-start').length > 0,
    { timeout: 15000 });
  const sheet = await page.evaluate(() => ({
    shown: document.getElementById('tx-run-modal').classList.contains('show'),
    rows: Array.from(document.querySelectorAll('#tx-run-body tbody tr')).map(tr => ({
      label: tr.children[1].querySelector('div').textContent.trim(),
      count: tr.children[2].textContent.trim(),
      start: tr.querySelector('.tx-start')?.value || '',
      ticked: !!tr.querySelector('.tx-tick')?.checked,
      range: tr.children[4].textContent.trim(),
    })),
    go: document.getElementById('tx-run-go').textContent.trim(),
  }));
  check('the sheet is open', sheet.shown);
  check('sales invoices are split per sale type — one row each',
        sheet.rows.filter(r => /Sales Invoices/.test(r.label)).length === 2,
        JSON.stringify(sheet.rows.map(r => r.label)));
  // A one-click run raises DRAFTS on the sales side. An operator who thought
  // they had just issued tax invoices would be badly misled, so the row says so.
  check('…and each says it is a proforma draft',
        sheet.rows.filter(r => /Sales Invoices/.test(r.label))
                  .every(r => /proforma draft/.test(r.label)),
        JSON.stringify(sheet.rows.map(r => r.label)));
  check('every other module gets its own row',
        ['Purchase Invoices', 'Bills of Supply', 'Debit Notes (Service)', 'Debit Notes — Planter']
          .every(l => sheet.rows.some(r => r.label === l)),
        JSON.stringify(sheet.rows.map(r => r.label)));
  check('each row carries a pre-filled start number',
        sheet.rows.filter(r => r.count !== '0' && r.count !== '—').every(r => /^\d+$/.test(r.start)),
        JSON.stringify(sheet.rows.map(r => ({ l: r.label, s: r.start }))));
  check('and shows the range it would consume',
        sheet.rows.filter(r => r.ticked).every(r => /^#\d+–#\d+$/.test(r.range)),
        JSON.stringify(sheet.rows.map(r => ({ l: r.label, range: r.range }))));
  check('the Generate button names how many types are ticked',
        /Generate \d+ document type/.test(sheet.go), sheet.go);
  if (process.env.SHOT_DIR) {
    await new Promise(r => setTimeout(r, 900));   // let the modal finish fading in
    await page.screenshot({ path: process.env.SHOT_DIR + '/tx-sheet.png' });
    // Dark mode overrides only the --spice-* tokens, so a sheet styled with
    // the generic aliases would keep its light colours on the dark ground.
    await page.evaluate(() => { document.body.dataset.dark = '1'; });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: process.env.SHOT_DIR + '/tx-sheet-dark.png' });
    await page.evaluate(() => { delete document.body.dataset.dark; });
  }

  // ── Typing a number moves the range ─────────────────────────────
  console.log('\n[C] The "Will use" range tracks what is typed');
  const typed = await page.evaluate(() => {
    const inp = document.querySelector('[data-txstart="0"]');
    inp.value = '250'; inp.dispatchEvent(new Event('input'));
    const i = 0;
    return document.getElementById('tx-range-' + i).textContent.trim();
  });
  check('typing 250 re-renders the range from 250', /^#250–#\d+$/.test(typed), typed);

  // ── Running it ──────────────────────────────────────────────────
  console.log('\n[D] Running reports per-module results');
  await page.evaluate(() => {
    // Put the edited box back to what the server suggested.
    const inp = document.querySelector('[data-txstart="0"]');
    inp.value = String(_txRows[0].start); inp.dispatchEvent(new Event('input'));
    runTxPipeline();
  });
  await page.waitForFunction(
    () => /Generated|did not complete/.test(document.getElementById('tx-run-body').textContent),
    { timeout: 30000 });
  const result = await page.evaluate(() => ({
    banner: document.getElementById('tx-run-body').textContent.slice(0, 160),
    lines: Array.from(document.querySelectorAll('#tx-run-body tbody tr')).map(tr => tr.textContent.replace(/\s+/g, ' ').trim()),
    actions: document.getElementById('tx-run-actions').textContent.replace(/\s+/g, ' ').trim(),
  }));
  check('it reports a successful run', /Generated \d+ document/.test(result.banner), result.banner);
  check('…with a line per module, each naming its consumed range',
        result.lines.filter(l => /#\d+–#\d+/.test(l)).length >= 3,
        JSON.stringify(result.lines));
  check('…and offers Run again / Done', /Run again/.test(result.actions) && /Done/.test(result.actions),
        result.actions);

  // The documents really exist.
  const inv = (await api('GET', `/api/invoices?auction_id=${aid}&docType=proforma`)).d;
  check('two proforma drafts were written', ((inv && (inv.rows || inv)) || []).length === 2,
        JSON.stringify((inv && (inv.rows || inv) || []).map(r => r.invo)));

  // ── A re-run must not quietly write a second set ────────────────
  console.log('\n[E] Re-opening the sheet after a run');
  await page.evaluate(() => openTxRunModal());
  await page.waitForFunction(() => document.querySelectorAll('#tx-run-body tbody tr').length > 0,
    { timeout: 15000 });
  const again = await page.evaluate(() => Array.from(document.querySelectorAll('#tx-run-body tbody tr')).map(tr => ({
    label: tr.children[1].querySelector('div').textContent.trim(),
    note: tr.children[1].textContent.replace(/\s+/g, ' ').trim(),
    count: tr.children[2].textContent.trim(),
    ticked: !!tr.querySelector('.tx-tick')?.checked,
    disabled: !!tr.querySelector('.tx-tick')?.disabled,
    range: tr.children[4].textContent.trim(),
  })));
  // Purchases and bills now TOP UP: their parties already hold a document, so
  // nothing is left to do and the row cannot be run by accident. Before the
  // guard went in, a second click wrote a full duplicate set under fresh
  // numbers — which the number-collision claim does NOT catch, because those
  // numbers are genuinely free.
  const pur = again.find(r => r.label === 'Purchase Invoices');
  check('purchase invoices report nothing left to generate', pur.count === '0',
        JSON.stringify(pur));
  check('…and the row is not selectable', pur.ticked === false, JSON.stringify(pur));

  // Drafts count as DONE. A raised draft is not work the trade still owes, so
  // the sales row reports zero and goes quiet like any other finished module —
  // it must not keep offering a number box that would renumber a draft the
  // buyer may already be holding. Replacing drafts is a deliberate act, and
  // the row says where to do it.
  const draftRow = again.find(r => /Sales Invoices/.test(r.label));
  check('the draft row reports nothing outstanding', draftRow.count === '0',
        JSON.stringify(draftRow));
  check('…and is not selectable, so a raised draft is never silently renumbered',
        draftRow.ticked === false && draftRow.disabled === true, JSON.stringify(draftRow));
  check('…and offers no number range to consume', draftRow.range === '',
        JSON.stringify(draftRow));
  check('…while saying the drafts exist and where to replace them',
        /draft.*already raised/.test(draftRow.note) && /Invoices tab/.test(draftRow.note),
        JSON.stringify(draftRow));

  // ── Dark mode ───────────────────────────────────────────────────
  // The sheet is a table inside a .modal, and .modal's background is
  // var(--card) — an alias declared on :root, so it stays WHITE under
  // body[data-dark="1"]. The element defaults this table would otherwise
  // inherit (td{color:var(--spice-text-main)}, and the dark-mode input rule)
  // are written against the --spice-* tokens, which DO flip. Left alone that
  // put the row labels at 1.1:1 and the number inputs at 1.22:1 — invisible.
  // The fix is a scoped block pinning the sheet to the non-flipping aliases;
  // this is the guard that stops it rotting back.
  console.log('\n[F] The sheet stays readable in dark mode');
  await page.evaluate(() => openTxRunModal());
  await page.waitForFunction(() => document.querySelectorAll('#tx-run-body .tx-start').length > 0,
    { timeout: 15000 });
  const dark = await page.evaluate(`(() => {${CONTRAST_FNS}
    document.body.dataset.dark = '1';
    const row = document.querySelector('#tx-run-body tbody tr');
    const out = {
      label: K(row.children[1].querySelector('div')),
      count: K(row.children[2]),
      will:  K(row.children[4]),
      th:    K(document.querySelector('#tx-run-body thead th')),
      input: K(document.querySelector('#tx-run-body .tx-start')),
    };
    delete document.body.dataset.dark;
    return out;
  })()`);
  const WORST = Math.min(...Object.values(dark));
  check('every part of the sheet clears WCAG AA (4.5:1) on dark mode',
        WORST >= 4.5, JSON.stringify(dark));
  check('…the row labels in particular, which were 1.1:1 before the fix',
        dark.label >= 4.5, `label ${dark.label}`);
  check('…and the start-number inputs, which were 1.22:1',
        dark.input >= 4.5, `input ${dark.input}`);

  check('no page errors along the way', pageErrors.length === 0, JSON.stringify(pageErrors));

  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e, '\n', srvLog.slice(-2000)); await cleanup(); process.exit(1); });
