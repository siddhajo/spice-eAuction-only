// Seller and buyer phone fields take ten digits and nothing else.
//
// The rule has two halves, and an earlier attempt got them backwards. TYPING is
// hard-capped: the eleventh keystroke does nothing. Dropping maxlength so a
// typed "+91…" could roll through to the right digits looked clever and was
// wrong — it turned a fat-fingered eleventh digit into a plausible-looking
// WRONG number by pushing the leading digit out, silently. A country code is
// handled on PASTE instead, where the whole string arrives at once.
//
// The stored data already says this is the shape: 4 591 of 4 593 sellers hold
// exactly ten digits with no punctuation anywhere. The strays (a 1-digit and an
// 11-digit row, and a few junk buyer numbers) are typos the box now refuses to
// take again.
//
// Four boxes write these two columns and all four have to agree, or the rule is
// only as strong as the screen nobody used: the Sellers modal, the Buyers modal,
// Lot Entry's inline "add seller", and the PWA's new-seller form (which was
// accepting 15 characters including a '+').
//
// The Lorry-report WhatsApp box is deliberately NOT in scope — it accepts a full
// international number with its country code and says so on screen.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const pptr = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phone10-'));
const PORT = 47378;
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
  const login = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = login.d && (login.d.token || login.d.accessToken);
  if (!TOKEN) { console.error('login failed', login.status, login.d, '\n', srvLog.slice(-2000)); cleanup(); process.exit(1); }

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
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(tok => { localStorage.setItem('t', tok); }, TOKEN);
  await page.goto(B + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#t-tel', { timeout: 15000 });

  // Type character by character through the real keyboard, so the oninput
  // handler runs exactly as it does for an operator.
  const reveal = (p, sel) => p.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.classList && (n.classList.contains('modal-bg') || n.classList.contains('modal-overlay'))) {
        n.classList.add('show');
      }
      if (getComputedStyle(n).display === 'none') n.style.display = 'block';
    }
    return !!el.offsetParent;
  }, sel);
  const typeInto = async (p, sel, text) => {
    await reveal(p, sel);
    await p.evaluate(s => { const el = document.querySelector(s); el.value = ''; el.focus(); }, sel);
    await p.type(sel, text, { delay: 0 });
    return p.evaluate(s => document.querySelector(s).value, sel);
  };
  // A real paste: a ClipboardEvent carrying the text, which is what the
  // onpaste handler reads. Dispatching a bare 'input' would test nothing,
  // since the country-code rule lives on the paste path.
  const pasteInto = async (p, sel, text) => {
    await reveal(p, sel);
    return p.evaluate((s, t) => {
      const el = document.querySelector(s);
      el.value = ''; el.focus(); el.setSelectionRange(0, 0);
      const dt = new DataTransfer();
      dt.setData('text', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return el.value;
    }, sel, text);
  };
  const attrs = (p, sel) => p.evaluate(s => {
    const el = document.querySelector(s);
    return { maxlength: el.getAttribute('maxlength'), inputmode: el.getAttribute('inputmode'), type: el.type };
  }, sel);

  // These fields live in modals that start hidden; a real keystroke needs a
  // visible, focusable element, so open them the way the screen does.
  await page.evaluate(() => {
    showModal('trader-modal');
    showModal('buyer-modal');
    showModal('lorry-wa-modal');
    const le = document.getElementById('le-newseller-modal');
    if (le) le.style.display = 'flex';
  });

  const FIELDS = [
    ['Sellers modal',      '#t-tel'],
    ['Buyers modal',       '#b-tel'],
    ['Lot Entry new seller', '#le-ns-tel'],
  ];

  console.log('[1] Every seller/buyer phone box is capped and numeric');
  for (const [label, sel] of FIELDS) {
    const a = await attrs(page, sel);
    check(`${label}: numeric keypad on a phone`, a.inputmode === 'numeric', JSON.stringify(a));
    check(`${label}: hard-capped at ten`, a.maxlength === '10', JSON.stringify(a));
  }

  console.log('\n[2] Past ten digits, the keystrokes do NOTHING');
  // Not merely "the value is ten long" — the first ten must be what survives.
  // The bug this replaces kept the value at ten while scrolling the number
  // along, so digit 11 quietly evicted digit 1 and left a wrong number that
  // looked perfectly normal.
  for (const [label, sel] of FIELDS) {
    const v = await typeInto(page, sel, '979074444412345');
    check(`${label}: keeps the first ten typed, unshifted`, v === '9790744444', JSON.stringify(v));
  }
  const stepwise = await page.evaluate(async () => {
    const el = document.querySelector('#t-tel');
    el.value = '9790744444'; el.focus();
    const before = el.value;
    // The 11th keystroke, as the browser delivers it under maxlength.
    el.setSelectionRange(10, 10);
    document.execCommand && document.execCommand('insertText', false, '9');
    return { before, after: el.value };
  });
  check('an 11th keystroke on a full box changes nothing',
        stepwise.after === stepwise.before, JSON.stringify(stepwise));

  console.log('\n[3] Letters, spaces and symbols never land');
  for (const [label, sel] of FIELDS) {
    const v = await typeInto(page, sel, '97907-44444');
    check(`${label}: punctuation is dropped as typed`, v === '9790744444', JSON.stringify(v));
  }
  const abc = await typeInto(page, '#t-tel', 'abc98765xyz43210');
  check('letters are dropped as typed', abc === '9876543210', JSON.stringify(abc));
  // Hand-typing a country code fills the box before the number is finished —
  // that is the accepted cost of a hard cap, and paste is the answer for it.
  const typedCC = await typeInto(page, '#t-tel', '+919790744444');
  check('a hand-typed +91 fills up at ten and stops', typedCC === '9197907444', JSON.stringify(typedCC));

  console.log('\n[4] Pasting keeps the number, not the country code');
  // This is the case that makes "keep the last ten" the only safe rule. Keeping
  // the FIRST ten would store 9197907444 — a number belonging to nobody —
  // and store it without a word.
  for (const [label, sel] of FIELDS) {
    const v = await pasteInto(page, sel, '+91 97907 44444');
    check(`${label}: pasted "+91 97907 44444" → 9790744444`, v === '9790744444', JSON.stringify(v));
  }
  check('a pasted "0091…" loses the prefix too',
        (await pasteInto(page, '#b-tel', '0091 97907 44444')) === '9790744444');
  check('a pasted number already clean is untouched',
        (await pasteInto(page, '#b-tel', '9876543210')) === '9876543210');
  // The guard that stops the country-code strip eating a real number: 9198765432
  // is ten digits and starts with 91, and must survive whole.
  check('a real number starting 91 is not mistaken for a country code',
        (await pasteInto(page, '#b-tel', '9198765432')) === '9198765432',
        JSON.stringify(await pasteInto(page, '#b-tel', '9198765432')));
  check('a pasted 15-digit string is still cut to ten',
        /^\d{10}$/.test(await pasteInto(page, '#b-tel', '979074444412345')));

  console.log('\n[5] Editing mid-number keeps the caret where it was');
  // Without this the caret jumps to the end on every keystroke, which makes
  // correcting a digit in the middle of a number impossible.
  const caret = await page.evaluate(() => {
    const el = document.querySelector('#t-tel');
    el.value = '9790744444';
    el.focus();
    el.setSelectionRange(3, 3);          // after "979"
    // Operator types a letter in the middle — it must vanish without moving them.
    el.value = '979x0744444';
    el.setSelectionRange(4, 4);
    limitPhoneInput(el);
    return { value: el.value, caret: el.selectionStart };
  });
  // Nothing was dropped from the front here (ten digits in, ten out), so the
  // caret lands back after the same three digits it was after.

  check('the stray character is removed', caret.value === '9790744444', JSON.stringify(caret.value));
  check('and the caret stays put', caret.caret === 3, JSON.stringify(caret.caret));

  console.log('\n[6] A clean ten-digit number is left completely alone');
  const clean = await page.evaluate(() => {
    const el = document.querySelector('#t-tel');
    el.value = '9790744444';
    el.focus();
    el.setSelectionRange(5, 5);
    limitPhoneInput(el);
    return { value: el.value, caret: el.selectionStart };
  });
  check('value unchanged', clean.value === '9790744444', JSON.stringify(clean.value));
  check('caret untouched', clean.caret === 5, JSON.stringify(clean.caret));

  console.log('\n[7] The Lorry-report WhatsApp box still takes a country code');
  const lorry = await typeInto(page, '#lorry-wa-phone', '+919790744444');
  check('it is not capped at ten', lorry === '+919790744444', JSON.stringify(lorry));

  console.log('\n[8] A number typed this way saves as ten bare digits');
  await page.evaluate(() => {
    const el = document.querySelector('#b-tel');
    el.value = ''; el.focus();
  });
  await page.type('#b-tel', '97907 44444', { delay: 0 });
  const typedBuyer = await page.evaluate(() => document.querySelector('#b-tel').value);
  const saved = await api('POST', '/api/buyers', {
    code: 'PH1', buyer: 'PHONE TEST', buyer1: 'PHONE TEST LTD', tel: typedBuyer, sale: 'L',
  });
  check('the buyer saves', saved.status === 200, `${saved.status} ${JSON.stringify(saved.d)}`);
  const stored = (await api('GET', '/api/buyers?all=1')).d.find(b => b.code === 'PH1');
  check('and the stored number is ten bare digits',
        /^\d{10}$/.test(String(stored && stored.tel || '')), JSON.stringify(stored && stored.tel));

  // ══ MOBILE PWA ═══════════════════════════════════════════════════
  console.log('\n[9] The PWA new-seller form follows the same rule');
  const mob = await browser.newPage();
  mob.on('pageerror', e => { fail++; console.log('  FAIL mobile page error: ' + e.message); });
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(B + '/mobile/', { waitUntil: 'domcontentloaded' });
  await mob.waitForSelector('#ns-tel', { timeout: 15000 });
  await mob.evaluate(() => {
    const m = document.getElementById('seller-modal');
    if (m) m.classList.add('show');
    const more = document.getElementById('ns-more');   // whatsapp lives under "+ More details"
    if (more) more.style.display = 'block';
  });
  for (const [label, sel] of [['phone', '#ns-tel'], ['whatsapp', '#ns-whatsapp']]) {
    const a = await attrs(mob, sel);
    check(`PWA ${label}: capped at ten, not the old fifteen`, a.maxlength === '10', JSON.stringify(a));
    const v = await typeInto(mob, sel, '97907 4444412345');
    check(`PWA ${label}: spaces gone, capped at the first ten`, v === '9790744444', JSON.stringify(v));
    check(`PWA ${label}: pasting a +91 number still lands right`,
          (await pasteInto(mob, sel, '+91 97907 44444')) === '9790744444');
  }
  // "Same as phone" copies the already-cleaned value, so the two agree.
  const same = await mob.evaluate(() => {
    document.getElementById('ns-tel').value = '';
    document.getElementById('ns-wa-same').checked = true;
    onWaSameToggle();
    const el = document.getElementById('ns-tel');
    el.value = '9790744444x';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { tel: el.value, wa: document.getElementById('ns-whatsapp').value };
  });
  check('PWA "same as phone" copies the cleaned number', same.tel === '9790744444' && same.wa === same.tel,
        JSON.stringify(same));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) console.log(srvLog.slice(-2000));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e, srvLog.slice(-2000)); cleanup(); process.exit(1); });
