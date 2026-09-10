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
//      live — leftovers are listed in the summary and the operator opts in.
//   5. The "is the API available?" probe does not cache a NEGATIVE forever.
//   6. The bulk LEDGER accounts for every ticked row: a row whose PDF can't
//      be built stays in the list as a Failed line with its reason, instead
//      of being dropped so the counts silently disagree with the selection.
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
  '_waCloudApiAvailable', '_waPrepareRow', '_waAutoPass', '_waManualPass',
  '_waQueueSummary', '_waSummaryLine', '_runWaQueue', '_waQueueAct', '_waQueueRender',
  '_waEsc', '_waRowSent', '_waQueueButtons', '_waQueueRetryable', '_waQueueCopy',
  '_waPollables', '_waPollDelivery', '_ensureWaQueueModal',
];

// The negative-probe TTL is a module-level const, not part of any function —
// read it out of the file too so the test uses the shipped value.
// Declared as `let`, not `const`, so a test can shrink the poll interval to
// something a test run can wait for. The VALUE still comes from the shipped
// source, which is the point of extracting it.
function extractConst(name) {
  const m = new RegExp(`^const ${name} = .*$`, 'm').exec(HTML);
  assert.ok(m, `could not find const ${name} in public/index.html`);
  return m[0].replace(/^const /, 'let ');
}
// Multi-line `const NAME = {` … `};` block (the status-chip table).
function extractObject(name) {
  const re = new RegExp(`^const ${name} = \\{`, 'm');
  const m = re.exec(HTML);
  assert.ok(m, `could not find const ${name} in public/index.html`);
  const end = HTML.indexOf('\n};\n', m.index);
  assert.ok(end > m.index, `could not find the end of ${name}`);
  return HTML.slice(m.index, end + 4);
}

// Test-controlled state the extracted code reads.
const state = {
  status: { configured: true },
  statusHttpOk: true,
  statusProbes: 0,
  sendResult: { status: 200, body: { ok: true } },
  opened: [],         // WhatsApp Web URLs
  errors: [],         // showError() messages
  toasts: [],
  statusLines: [],    // every status line painted into the modal
  lastRows: [],       // ledger snapshot at the last paint
  manualActions: [],  // queued answers for the manual pass
  summaryActions: [], // queued answers for the summary panel
  sendSeq: 0,         // hands each send a distinct wamid when tracking is on
  trackIds: false,
  pollCount: 0,
  pollStatus: null,   // (wamid, nth poll) => {status, error} | null
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
  navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', clipboard: { writeText(){} } },
  showError: (e) => { state.errors.push(e && e.message ? e.message : String(e)); },
  toast: (m) => { state.toasts.push(m); },
  alert: () => {},
  showModal: () => {}, hideModal: () => {},
  window: { open: (u) => { state.opened.push(u); } },
  document: {
    // Minimal stand-ins for the queue modal's elements.
    getElementById: () => ({ textContent: '', style: {}, querySelector: () => ({ textContent: '' }) }),
    createElement: () => ({ style: {}, click(){}, remove(){}, querySelector: () => ({ textContent: '' }) }),
    body: { appendChild(){}, removeChild(){} },
  },
  fetch: async (url, opts) => {
    // Must be tested BEFORE '/api/whatsapp/status' — that string is a prefix
    // of this one, and matching it first sends every delivery poll to the
    // availability probe.
    if (String(url).includes('/api/whatsapp/statuses')) {
      state.pollCount++;
      const ids = JSON.parse(opts.body).ids;
      const n = state.pollCount;
      const out = ids.map(id => state.pollStatus && state.pollStatus(id, n)).filter(Boolean);
      return { ok: true, status: 200, json: async () => out };
    }
    if (String(url).includes('/api/whatsapp/status')) {
      state.statusProbes++;
      return {
        ok: state.statusHttpOk, status: state.statusHttpOk ? 200 : 401,
        json: async () => state.status,
      };
    }
    if (String(url).includes('/api/whatsapp/send-template')) {
      const r = state.sendResult;
      const body = (state.trackIds && r.body && r.body.ok)
        ? Object.assign({}, r.body, { id: 'wamid-' + (++state.sendSeq) })
        : r.body;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => body };
    }
    throw new Error('unexpected fetch ' + url);
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  extractConst('_WA_NEGATIVE_TTL_MS') + '\n' +
  extractConst('_WA_POLL_EVERY_MS') + '\n' +
  extractConst('_WA_POLL_FOR_MS') + '\n' +
  extractObject('_WA_CHIP') + '\n' +
  NAMES.map(extract).join('\n'), sandbox);

sandbox._ensureWaQueueModal = () => ({});
// The real renderer needs a live DOM; stub it, but keep the ledger observable
// so the tests can assert on what the operator would be looking at.
sandbox._waQueueRender = (i, status) => {
  if (status != null) state.statusLines.push(status);
  const q = vm.runInContext('_waQ', sandbox);
  if (q) state.lastRows = q.rows.map(r => ({ name: r.name, status: r.status, reason: r.reason, wamid: r.wamid || '' }));
};
// The summary panel blocks on a click. _waQueueButtons('summary') is the last
// thing that runs before that await, so answer from there.
sandbox.__nextSummaryAction = () => state.summaryActions.shift() || 'close';
vm.runInContext(`
  _waQueueButtons = function(mode){
    if (mode === 'summary') setTimeout(() => _waQueueAct(__nextSummaryAction()), 0);
  };
`, sandbox);

// Replace the manual pass's click-await with the scripted answer queue,
// mirroring the row bookkeeping the shipped version does.
sandbox.__nextManualAction = () => state.manualActions.shift() || 'stop';
vm.runInContext(`
  _waManualPass = async function(list, note){
    for (const row of list) {
      const a = __nextManualAction();
      if (a === 'stop' || a === 'close') break;
      if (a === 'skip') { row.status = 'skipped'; row.reason = 'Skipped by operator'; continue; }
      if (!await _waPrepareRow(row, 0)) continue;
      if (row.item.blob) await _waOpenDocument(row.item);
      else _waOpenText(row.phone, row.item.message);
      row.status = 'opened';
      row.reason = '';
    }
  };
`, sandbox);

function reset(over = {}) {
  state.status = { configured: true };
  state.statusHttpOk = true;
  state.statusProbes = 0;
  state.sendResult = { status: 200, body: { ok: true } };
  state.opened = []; state.errors = []; state.toasts = [];
  state.statusLines = []; state.lastRows = [];
  state.manualActions = []; state.summaryActions = [];
  state.sendSeq = 0; state.trackIds = false; state.pollCount = 0; state.pollStatus = null;
  Object.assign(state, over);
  // Clear the availability cache between cases.
  vm.runInContext('_waApiCheck = null; _waApiCheckAt = 0;', sandbox);
}

const blob = new sandbox.Blob();
const rowsBy = (status) => state.lastRows.filter(r => r.status === status);
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
    assert.strictEqual(rowsBy('sent').length, 3);
    assert.ok(/3 of 3 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('bulk: the ledger shows every row moving through its states', async () => {
    const items = [{ name: 'A', phone: '9000000001', message: 'm1', params: [] }];
    await sandbox._runWaQueue(items);
    assert.ok(state.statusLines.some(l => /Sending automatically/.test(l)),
      'the operator must see a per-row progress line, got: ' + state.statusLines.join(' | '));
    assert.ok(state.statusLines.some(l => /^Finished — /.test(l)),
      'the run must end on a summary line, got: ' + state.statusLines.join(' | '));
  });

  await test('bulk: API live, one row has no number → listed as failed, nothing forced', async () => {
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '',           message: 'm2', params: [] },
    ];
    await sandbox._runWaQueue(items);   // summary answered with the default 'close'
    assert.strictEqual(rowsBy('failed').length, 1, 'the leftover must stay in the ledger');
    assert.strictEqual(rowsBy('failed')[0].reason, 'No WhatsApp number on file');
    assert.deepStrictEqual(state.opened, [], 'closing the summary must not open anything');
    assert.ok(/1 of 2 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('bulk: operator picks "Open failed in WhatsApp Web" → manual pass, leftovers only', async () => {
    state.summaryActions = ['manual'];
    state.manualActions = ['send'];
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '',           message: 'm2', params: [] },
    ];
    await sandbox._runWaQueue(items);
    assert.strictEqual(state.opened.length, 1, 'only the leftover should open WhatsApp Web');
  });

  await test('bulk: "Retry failed" re-sends only the failed rows', async () => {
    state.summaryActions = ['retry'];
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '9000000002', message: 'm2', params: [] },
    ];
    // First pass: Meta rejects both. Then the retry succeeds.
    state.sendResult = { status: 502, body: { error: 'Temporary failure' } };
    const orig = sandbox._waQueueButtons;
    sandbox._waQueueButtons = (mode) => {
      if (mode !== 'summary') return;
      state.sendResult = { status: 200, body: { ok: true } };   // API recovers
      setTimeout(() => sandbox._waQueueAct(sandbox.__nextSummaryAction()), 0);
    };
    await sandbox._runWaQueue(items);
    sandbox._waQueueButtons = orig;
    assert.strictEqual(rowsBy('sent').length, 2, 'both rows should be sent after the retry');
    assert.ok(/2 of 2 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('bulk: a row whose PDF cannot be built stays in the ledger as Failed', async () => {
    // The bug this replaces: prep threw, the row was console.warn'd away and
    // never counted, so "25 sent" for 30 ticked rows had no explanation.
    const items = [
      { name: 'A', phone: '9000000001', prepare: async () => ({ phone: '9000000001', message: 'm1', params: [] }) },
      { name: 'B', phone: '9000000002', prepare: async () => { throw new Error('PDF route 500'); } },
      { name: 'C', phone: '9000000003', prepare: async () => ({ phone: '9000000003', message: 'm3', params: [] }) },
    ];
    await sandbox._runWaQueue(items);
    assert.strictEqual(state.lastRows.length, 3, 'every ticked row must remain in the ledger');
    assert.strictEqual(rowsBy('sent').length, 2, 'one bad row must not abort the run');
    const bad = rowsBy('failed');
    assert.strictEqual(bad.length, 1);
    assert.strictEqual(bad[0].name, 'B');
    assert.ok(/PDF route 500/.test(bad[0].reason), 'the reason must reach the operator, got: ' + bad[0].reason);
    assert.ok(/2 of 3 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('bulk: prepare() runs lazily — nothing is built before the modal is up', async () => {
    let builtBeforeFirstPaint = 0;
    let painted = 0;
    const origRender = sandbox._waQueueRender;
    sandbox._waQueueRender = (i, s) => { painted++; origRender(i, s); };
    const items = [1, 2, 3].map(n => ({
      name: 'S' + n,
      prepare: async () => {
        if (!painted) builtBeforeFirstPaint++;
        return { phone: '90000000' + n, message: 'm' + n, params: [] };
      },
    }));
    await sandbox._runWaQueue(items);
    sandbox._waQueueRender = origRender;
    assert.strictEqual(builtBeforeFirstPaint, 0,
      'PDFs must be built inside the queue, not in a silent pre-pass before the modal appears');
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
  });

  await test('bulk: Stop during the auto pass → remaining rows marked, nothing opened', async () => {
    // Stop is an explicit "end this run": the cancelled records must be
    // visible with a reason, and must NOT be pushed into WhatsApp Web.
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '9000000002', message: 'm2', params: [] },
    ];
    // _runWaQueue clears the flag on entry, so press Stop mid-run: the first
    // paint raises it, leaving the second row pending.
    const orig = sandbox._waQueueRender;
    sandbox._waQueueRender = (i, s) => { vm.runInContext('_waQueueStopped = true;', sandbox); orig(i, s); };
    await sandbox._runWaQueue(items);
    sandbox._waQueueRender = orig;
    assert.deepStrictEqual(state.opened, [], 'Stop must not open WhatsApp Web');
    assert.strictEqual(rowsBy('skipped').length, 2, 'cancelled rows must say so');
    assert.strictEqual(rowsBy('skipped')[0].reason, 'Stopped');
  });

  await test('bulk: the ✕ ends the run even from the summary', async () => {
    state.summaryActions = ['abort'];
    const items = [{ name: 'A', phone: '9000000001', message: 'm1', params: [] }];
    await sandbox._runWaQueue(items);   // must settle, not hang
    assert.ok(/1 of 1 sent/.test(state.toasts.join('|')), 'toast: ' + state.toasts);
  });

  await test('delivery receipts flip Sent → Delivered → Read while the summary is open', async () => {
    // "Sent" is only Meta ACCEPTING the message. The webhook's later verdict
    // is the one the operator actually cares about, so the summary must move
    // under them rather than freezing on the optimistic count.
    state.trackIds = true;
    state.pollStatus = (id, n) => ({ wamid: id, status: n === 1 ? 'delivered' : 'read', error: '' });
    vm.runInContext('_WA_POLL_EVERY_MS = 10;', sandbox);
    const orig = sandbox._waQueueButtons;
    sandbox._waQueueButtons = (mode) => {
      // Hold the summary open long enough for a few poll cycles.
      if (mode === 'summary') setTimeout(() => sandbox._waQueueAct('close'), 150);
    };
    const items = [
      { name: 'A', phone: '9000000001', message: 'm1', params: [] },
      { name: 'B', phone: '9000000002', message: 'm2', params: [] },
    ];
    await sandbox._runWaQueue(items);
    sandbox._waQueueButtons = orig;
    assert.ok(state.pollCount > 0, 'the summary must poll for delivery receipts');
    assert.strictEqual(rowsBy('read').length, 2, 'rows should settle on Read, got: ' + JSON.stringify(state.lastRows));
    assert.ok(/2 delivered/.test(state.toasts.join('|')), 'toast should report deliveries: ' + state.toasts);
  });

  await test('a failed delivery receipt surfaces the carrier reason', async () => {
    state.trackIds = true;
    state.pollStatus = (id) => ({ wamid: id, status: 'failed', error: 'Recipient not on WhatsApp' });
    vm.runInContext('_WA_POLL_EVERY_MS = 10;', sandbox);
    const orig = sandbox._waQueueButtons;
    sandbox._waQueueButtons = (mode) => {
      if (mode === 'summary') setTimeout(() => sandbox._waQueueAct('close'), 120);
    };
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm1', params: [] }]);
    sandbox._waQueueButtons = orig;
    const bad = rowsBy('failed');
    assert.strictEqual(bad.length, 1, 'a bounced message must stop looking like a success');
    assert.strictEqual(bad[0].reason, 'Recipient not on WhatsApp');
  });

  await test('no wamids (webhook off) → the poller retires instead of stalling the summary', async () => {
    // The send routes only return an id when the API answered; a run with no
    // ids to track must not hold the summary hostage for the full window.
    const t0 = Date.now();
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm1', params: [] }]);
    assert.strictEqual(state.pollCount, 0, 'nothing to poll → no requests');
    assert.ok(Date.now() - t0 < 1000, 'the summary must not wait out the poll window');
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
