// Unit test for the client-side WhatsApp dispatch layer in public/index.html.
//
// What it pins down (the behaviours that were broken):
//   1. A live Cloud API + a phone number sends on ONE click — no WhatsApp Web
//      tab, no "Send & Next" queue.
//   2. A Meta REJECTION (bad number, expired token) is reported to the
//      operator; it must NOT silently open WhatsApp Web, which made a broken
//      integration look like a working manual fallback.
//   3. Only a genuinely unusable API (501 not configured / 400 no template)
//      drops to WhatsApp Web.
//   4. Bulk sends never enter the click-per-row manual pass while the API is
//      live — leftovers are reported and the operator opts in.
//   5. The "is the API available?" probe does not cache a NEGATIVE forever.
//
// The functions are lifted verbatim out of index.html so the test tracks the
// shipped source rather than a copy.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Slice out `function NAME(` … up to the line that closes it at column 0.
function extract(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm');
  const m = re.exec(HTML);
  assert.ok(m, `could not find function ${name}() in public/index.html`);
  const start = m.index;
  const end = HTML.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of ${name}()`);
  return HTML.slice(start, end + 3);
}

const NAMES = [
  '_normalizePhoneForWa', '_isMobile', '_waCloudSendText', '_waCloudSendDocument',
  '_waSendDocument', '_waSendText', '_waOpenText', '_waOpenDocument',
  '_waCloudApiAvailable', '_waManualPass', '_runWaQueue',
  '_waQueueShow', '_waQueueButtons', '_ensureWaQueueModal',
];

// The negative-probe TTL is a module-level const, not part of any function —
// read it out of the file too so the test uses the shipped value.
function extractConst(name) {
  const m = new RegExp(`^const ${name} = .*$`, 'm').exec(HTML);
  assert.ok(m, `could not find const ${name} in public/index.html`);
  return m[0];
}

// Test-controlled state the extracted code reads.
const state = {
  status: { configured: true },
  statusHttpOk: true,
  statusProbes: 0,
  sendResult: { status: 200, body: { ok: true } },
  opened: [],        // WhatsApp Web URLs
  errors: [],        // showError() messages
  toasts: [],
  confirmAnswer: false,
  confirmPrompts: [],
  manualActions: [], // queued answers for the manual pass
};

const sandbox = {
  B: '',
  T: 'test-token',
  console,
  Date,
  FormData: class { constructor(){ this.f = {}; } append(k, v){ this.f[k] = v; } },
  File: class { constructor(parts, name, opts){ this.name = name; this.type = opts && opts.type; } },
  Blob: class {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
  setTimeout,
  navigator: { userAgent: 'Mozilla/5.0 (Macintosh)' },
  showError: (e) => { state.errors.push(e && e.message ? e.message : String(e)); },
  toast: (m) => { state.toasts.push(m); },
  alert: () => {},
  confirm: (m) => { state.confirmPrompts.push(m); return state.confirmAnswer; },
  showModal: () => {}, hideModal: () => {},
  window: { open: (u) => { state.opened.push(u); } },
  document: {
    // Minimal stand-ins for the queue modal's elements.
    getElementById: () => ({ textContent: '', style: {}, querySelector: () => ({ textContent: '' }) }),
    createElement: () => ({ style: {}, click(){}, remove(){}, querySelector: () => ({ textContent: '' }) }),
    body: { appendChild(){}, removeChild(){} },
  },
  fetch: async (url, opts) => {
    if (String(url).includes('/api/whatsapp/status')) {
      state.statusProbes++;
      return {
        ok: state.statusHttpOk, status: state.statusHttpOk ? 200 : 401,
        json: async () => state.status,
      };
    }
    if (String(url).includes('/api/whatsapp/send-template')) {
      const r = state.sendResult;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }
    throw new Error('unexpected fetch ' + url);
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extractConst('_WA_NEGATIVE_TTL_MS') + '\n' + NAMES.map(extract).join('\n'), sandbox);

// The manual pass blocks on a click; feed it scripted answers.
sandbox._waQueueShow = () => {};
sandbox._waQueueButtons = () => {};
sandbox._ensureWaQueueModal = () => ({});
vm.runInContext(`
  _waQueueAct = null;
  _waQueueState = null;
`, sandbox);

// Replace the click-await with the scripted answer queue.
sandbox.__nextManualAction = () => state.manualActions.shift() || 'stop';
vm.runInContext(`
  _waManualPass = async function(list, note){
    let sent=0, skipped=0;
    for (const it of list) {
      const a = __nextManualAction();
      if (a === 'stop') break;
      if (a === 'skip') { skipped++; continue; }
      if (it.blob) await _waOpenDocument(it); else _waOpenText(it.phone, it.message);
      sent++;
    }
    return { sent, skipped };
  };
`, sandbox);

function reset(over = {}) {
  state.status = { configured: true };
  state.statusHttpOk = true;
  state.statusProbes = 0;
  state.sendResult = { status: 200, body: { ok: true } };
  state.opened = []; state.errors = []; state.toasts = [];
  state.confirmAnswer = false; state.confirmPrompts = []; state.manualActions = [];
  Object.assign(state, over);
  // Clear the availability cache between cases.
  vm.runInContext('_waApiCheck = null; _waApiCheckAt = 0;', sandbox);
}

const blob = new sandbox.Blob();
let failures = 0;
async function test(name, fn) {
  reset();
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

(async () => {
  console.log('WhatsApp Cloud dispatch');

  await test('single document send: API live + phone → sent, no WhatsApp Web', async () => {
    const ok = await sandbox._waSendDocument({ blob, filename: 'a.pdf', phone: '9876543210', params: ['A','b','C'], message: 'm' });
    assert.strictEqual(ok, true, 'expected the Cloud API send to report success');
    assert.deepStrictEqual(state.opened, [], 'must not open WhatsApp Web on a successful API send');
    assert.deepStrictEqual(state.errors, []);
  });

  await test('single document send: Meta rejects → error shown, no WhatsApp Web', async () => {
    state.sendResult = { status: 502, body: { error: 'Message undeliverable' } };
    const ok = await sandbox._waSendDocument({ blob, filename: 'a.pdf', phone: '9876543210', params: [], message: 'm' });
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(state.opened, [], 'a Meta rejection must not silently open WhatsApp Web');
    assert.ok(/Message undeliverable/.test(state.errors.join('|')), 'the Meta reason must reach the operator, got: ' + state.errors);
  });

  await test('single document send: API not configured → WhatsApp Web fallback', async () => {
    state.sendResult = { status: 501, body: { error: 'not configured', fallback: true } };
    await sandbox._waSendDocument({ blob, filename: 'a.pdf', phone: '9876543210', params: [], message: 'm' });
    assert.strictEqual(state.opened.length, 1, 'an unusable API is the one case that should fall back');
    assert.ok(/web\.whatsapp\.com/.test(state.opened[0]));
  });

  await test('single document send: no template configured → WhatsApp Web fallback', async () => {
    state.sendResult = { status: 400, body: { error: 'No document template configured', fallback: true } };
    await sandbox._waSendDocument({ blob, filename: 'a.pdf', phone: '9876543210', params: [], message: 'm' });
    assert.strictEqual(state.opened.length, 1);
  });

  await test('single TEXT send (Payments): API live → sent, no WhatsApp Web', async () => {
    const ok = await sandbox._waSendText({ phone: '9876543210', params: ['A','b','C'], message: 'PAYMENT CREDITED' });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(state.opened, [], 'Payments must not open WhatsApp Web when the API can send');
  });

  await test('single TEXT send: Meta rejects → error shown, no WhatsApp Web', async () => {
    state.sendResult = { status: 502, body: { error: 'Business eligibility payment issue' } };
    const ok = await sandbox._waSendText({ phone: '9876543210', params: [], message: 'm' });
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(state.opened, []);
    assert.ok(/Business eligibility/.test(state.errors.join('|')), 'got: ' + state.errors);
  });

  await test('bulk: API live → all sent automatically, manual pass never runs', async () => {
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '9000000002', message: 'm2', params: [] },
      { name: 'C', phone: '9000000003', message: 'm3', params: [] },
    ];
    await sandbox._runWaQueue(items);
    assert.deepStrictEqual(state.opened, [], 'no WhatsApp Web tabs when every record went through the API');
    assert.deepStrictEqual(state.confirmPrompts, [], 'nothing left over → no summary prompt');
    assert.ok(/3 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('bulk: API live, one row has no number → summary offered, not forced', async () => {
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '',           message: 'm2', params: [] },
    ];
    await sandbox._runWaQueue(items);
    assert.strictEqual(state.confirmPrompts.length, 1, 'the leftover should be reported, not silently queued');
    assert.ok(/No WhatsApp number on file/.test(state.confirmPrompts[0]), state.confirmPrompts[0]);
    assert.deepStrictEqual(state.opened, [], 'declining the prompt must not open anything');
    assert.ok(/1 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('bulk: operator accepts the summary → manual pass runs on leftovers only', async () => {
    state.confirmAnswer = true;
    state.manualActions = ['send'];
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '',           message: 'm2', params: [] },
    ];
    await sandbox._runWaQueue(items);
    assert.strictEqual(state.opened.length, 1, 'only the leftover should open WhatsApp Web');
  });

  await test('bulk: API NOT configured → manual pass runs directly (only way to send)', async () => {
    state.status = { configured: false };
    state.manualActions = ['send', 'send'];
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '9000000002', message: 'm2', params: [] },
    ];
    await sandbox._runWaQueue(items);
    assert.strictEqual(state.opened.length, 2);
    assert.deepStrictEqual(state.confirmPrompts, [], 'no summary prompt — the manual pass already handled them');
  });

  await test('bulk: Stop during the auto pass → no follow-up prompt', async () => {
    // Stop is an explicit "end this run"; the cancelled records must not come
    // back as a "open these in WhatsApp Web?" question.
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '9000000002', message: 'm2', params: [] },
    ];
    // _runWaQueue clears the flag on entry, so press Stop mid-run: the modal
    // paint hook for the first record raises it, leaving the second pending.
    const orig = sandbox._waQueueShow;
    sandbox._waQueueShow = () => { vm.runInContext('_waQueueStopped = true;', sandbox); };
    await sandbox._runWaQueue(items);
    sandbox._waQueueShow = orig;
    assert.deepStrictEqual(state.confirmPrompts, [], 'Stop must not raise the leftovers prompt');
    assert.deepStrictEqual(state.opened, []);
    assert.ok(/1 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('availability probe: a positive answer is cached', async () => {
    assert.strictEqual(await sandbox._waCloudApiAvailable(), true);
    assert.strictEqual(await sandbox._waCloudApiAvailable(), true);
    assert.strictEqual(state.statusProbes, 1, 'a live API should be probed once per page');
  });

  await test('availability probe: a negative is NOT cached forever', async () => {
    state.statusHttpOk = false;                       // e.g. a token refresh in flight
    assert.strictEqual(await sandbox._waCloudApiAvailable(), false);
    vm.runInContext('_waApiCheckAt = Date.now() - 120000;', sandbox);  // TTL elapsed
    state.statusHttpOk = true;
    assert.strictEqual(await sandbox._waCloudApiAvailable(), true,
      'one failed probe must not pin the rest of the session to WhatsApp Web');
    assert.strictEqual(state.statusProbes, 2);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
