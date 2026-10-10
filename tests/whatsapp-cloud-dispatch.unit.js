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
//   7. An ACCOUNT-level refusal (spam rate limit, billing block, dead token)
//      stops the whole run at the row it hit. Firing the rest of the
//      selection at a wall that refuses all of them is 200 more spam signals
//      against the number, which is what pins it to its current tier.
//   8. The 24h recipient ceiling is checked BEFORE the first send, and the
//      operator's answer at that gate is honoured.
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
  '_waBlockKind', '_waFriendlyError', '_waRecipientsNeeded', '_waPreflight',
  '_waRefFields', '_waPartyRef', '_waLogUnsent',
  '_waRowKey', '_waMarkLoad', '_waMarkKind', '_waPaintMarks', '_waSelectUnsent',
  '_waCaptionLoad', '_waRowState', '_waIndexLoad', '_waUnsentAsk', '_waUnsentAnswer',
];

// The negative-probe TTL is a module-level const, not part of any function —
// read it out of the file too so the test uses the shipped value.
// Declared as `let`, not `const`, so a test can shrink the poll interval to
// something a test run can wait for. The VALUE still comes from the shipped
// source, which is the point of extracting it.
function extractConst(name) {
  const m = new RegExp(`^(?:const|let) ${name} = .*$`, 'm').exec(HTML);
  assert.ok(m, `could not find const/let ${name} in public/index.html`);
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
  sends: [],          // every phone the send route was actually called with
  usage: null,        // /api/whatsapp/usage body, or null for "Meta is quiet"
  gateAnswer: 'go',   // what the operator picks at the pre-flight prompt
  gateAsked: 0,
  sendBodies: [],     // the raw request body of every send, for ref assertions
  logRows: [],        // what GET /messages answers; null = the log is unreadable
  unsent: [],         // every row reported to /api/whatsapp/log-unsent
  unsentHttpOk: true,
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
  // The page's JSON helper, which the send-log reader uses.
  j: async (url) => {
    if (!String(url).includes('/api/whatsapp/messages')) throw new Error('unexpected j() ' + url);
    if (state.logRows === null) throw new Error('log unreadable');
    const q = /[?&]q=([^&]*)/.exec(String(url));
    if (q) {
      // The caption sweep: the route matches a substring of phone or caption.
      const needle = decodeURIComponent(q[1]).toLowerCase();
      return state.logRows.filter(r => String(r.caption || '').toLowerCase().includes(needle));
    }
    const m = /ref_type=([^&]*)/.exec(String(url));
    const want = m ? decodeURIComponent(m[1]) : '';
    return state.logRows.filter(r => r.ref_type === want);
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
    if (String(url).includes('/api/whatsapp/log-unsent')) {
      JSON.parse(opts.body).rows.forEach(r => state.unsent.push(r));
      return { ok: state.unsentHttpOk, status: state.unsentHttpOk ? 200 : 500, json: async () => ({ ok: true }) };
    }
    if (String(url).includes('/api/whatsapp/usage')) {
      if (!state.usage) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => state.usage };
    }
    if (String(url).includes('/api/whatsapp/send-template')) {
      state.sends.push(opts && opts.body ? String(opts.body).slice(0, 200) : '');
      state.sendBodies.push(opts && opts.body);
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
  extractObject('WA_LISTS') + '\n' +
  extractObject('_WA_CAPTION_RE') + '\n' +
  extractObject('_WA_LABEL_OF') + '\n' +
  extractConst('_waUnsentApply') + '\n' +
  extractObject('_WA_MARK_DOT') + '\n' +
  extractConst('WA_MARK_LOOKBACK') + '\n' +
  extractConst('WA_MARK_TTL_MS') + '\n' +
  extractConst('_waMarkCache') + '\n' +
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
// Keep the shipped button logic reachable — one case asserts on which
// buttons the operator is actually offered, which the stub below erases.
vm.runInContext('__shippedButtons = _waQueueButtons;', sandbox);
vm.runInContext(`
  _waQueueButtons = function(mode){
    if (mode === 'summary') setTimeout(() => _waQueueAct(__nextSummaryAction()), 0);
  };
`, sandbox);

// Replace the manual pass's click-await with the scripted answer queue,
// mirroring the row bookkeeping the shipped version does.
// The pre-flight prompt is a real modal; the decision logic around it is
// what this suite pins, so the prompt itself answers from the script.
sandbox.__gateAnswer = () => { state.gateAsked++; return state.gateAnswer; };
vm.runInContext('_waGateResolve = null; _waPreflightAsk = async function(){ return __gateAnswer(); };', sandbox);

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
  state.sends = []; state.usage = null; state.gateAnswer = 'go'; state.gateAsked = 0;
  state.unsent = []; state.unsentHttpOk = true; state.sendBodies = [];
  state.logRows = [];
  vm.runInContext('for (const k in _waMarkCache) delete _waMarkCache[k];', sandbox);
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


  // ── Account-level stops ────────────────────────────────────────
  await test('_waBlockKind tells an account stop from a per-message failure', async () => {
    const b = sandbox._waBlockKind('Spam Rate limit hit');
    assert.ok(b, '"Spam Rate limit hit" is Meta 131048 — an account-level stop');
    assert.strictEqual(b.code, '131048');
    // Order matters: 131048 must not be read as the generic throughput error.
    assert.notStrictEqual(sandbox._waBlockKind('Rate limit hit').code, '131048');
    assert.ok(sandbox._waBlockKind('Business eligibility payment issue'), 'a billing block stops everything');
    assert.ok(sandbox._waBlockKind('Error validating access token: Session has expired'), 'a dead token stops everything');
    assert.strictEqual(sandbox._waBlockKind('Message undeliverable'), null, 'a bad number is THIS row only');
    assert.strictEqual(sandbox._waBlockKind('Recipient not on WhatsApp'), null);
  });

  await test('_waFriendlyError explains the error without hiding Meta’s words', async () => {
    const out = sandbox._waFriendlyError('Spam Rate limit hit');
    assert.ok(/24-hour/.test(out), 'the operator needs the plain-English reading: ' + out);
    assert.ok(/Spam Rate limit hit/.test(out), 'the raw text must survive for support threads: ' + out);
    assert.strictEqual(sandbox._waFriendlyError('Message undeliverable'), 'Message undeliverable');
  });

  await test('bulk: a spam-rate-limit stops the run — untried rows are not fired at the wall', async () => {
    let n = 0;
    const items = ['A','B','C','D','E'].map((name, i) => ({ name, phone: '900000000' + i, message: 'm', params: [] }));
    // Row 1 goes out, row 2 comes back with the account-level refusal.
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      if (String(url).includes('/api/whatsapp/send-template')) {
        state.sends.push(url);
        if (++n >= 2) return { ok: false, status: 502, json: async () => ({ error: 'Spam Rate limit hit' }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return origFetch(url, opts);
    };
    await sandbox._runWaQueue(items);
    sandbox.fetch = origFetch;
    assert.strictEqual(state.sends.length, 2,
      'the run must stop at the refusal, not spend 3 more sends on a wall: ' + state.sends.length);
    assert.strictEqual(rowsBy('sent').length, 1);
    assert.strictEqual(rowsBy('failed').length, 1);
    assert.strictEqual(rowsBy('skipped').length, 3, 'untried rows must say so: ' + JSON.stringify(state.lastRows));
    assert.ok(/Not attempted/.test(rowsBy('skipped')[0].reason), rowsBy('skipped')[0].reason);
    assert.ok(/Stopped by WhatsApp/.test(state.statusLines.join('|')),
      'the summary must lead with the stop, not a tally: ' + state.statusLines.join('|'));
    assert.deepStrictEqual(state.opened, [], 'stopping must not silently open WhatsApp Web either');
  });

  await test('bulk: Retry is withheld once Meta has stopped the run', async () => {
    // Retrying an account-level stop fails by definition and spends another
    // refusal on the number. WhatsApp Web, which the limit does not touch,
    // must stay on offer.
    const shown = {};
    const realGet = sandbox.document.getElementById;
    sandbox.document.getElementById = (id) => ({ style: { set display(v) { shown[id] = v !== 'none'; } } });
    vm.runInContext('_waQ = { rows: [{ status: "failed" }, { status: "skipped" }] };', sandbox);
    vm.runInContext('__shippedButtons("summary");', sandbox);
    assert.strictEqual(shown['wa-q-retry'], true, 'an ordinary failed run still offers Retry');
    vm.runInContext('_waQ.blocked = { short: "WhatsApp is refusing sends from this number" };', sandbox);
    vm.runInContext('__shippedButtons("summary");', sandbox);
    sandbox.document.getElementById = realGet;
    vm.runInContext('_waQ = null;', sandbox);
    assert.strictEqual(shown['wa-q-retry'], false, 'a blocked run must not offer Retry');
    assert.strictEqual(shown['wa-q-manual'], true, 'WhatsApp Web is the way out and must remain');
  });

  await test('bulk: an ordinary per-message rejection does NOT stop the run', async () => {
    state.sendResult = { status: 502, body: { error: 'Message undeliverable' } };
    const items = ['A','B','C'].map((name, i) => ({ name, phone: '900000000' + i, message: 'm', params: [] }));
    await sandbox._runWaQueue(items);
    assert.strictEqual(state.sends.length, 3, 'every row deserves its own attempt: ' + state.sends.length);
    assert.strictEqual(rowsBy('failed').length, 3);
    assert.strictEqual(rowsBy('skipped').length, 0, 'nothing should be written off as untried');
  });

  // ── The pre-flight ceiling ─────────────────────────────────────
  await test('pre-flight: a run that fits is never questioned', async () => {
    state.usage = { limit: { cap: 250, used: 10, remaining: 240, tier: 'TIER_250' } };
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm', params: [] }]);
    assert.strictEqual(state.gateAsked, 0, 'no prompt when there is headroom');
    assert.strictEqual(rowsBy('sent').length, 1);
  });

  await test('pre-flight: no headroom → the operator is asked BEFORE the first send', async () => {
    state.usage = { limit: { cap: 250, used: 251, remaining: 0, tier: 'TIER_250' } };
    state.gateAnswer = 'cancel';
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm', params: [] }]);
    assert.strictEqual(state.gateAsked, 1, 'the ceiling is knowable up front — ask');
    assert.strictEqual(state.sends.length, 0, 'Cancel must send nothing at all');
  });

  await test('pre-flight: choosing WhatsApp Web routes the run away from the API', async () => {
    state.usage = { limit: { cap: 250, used: 251, remaining: 0, tier: 'TIER_250' } };
    state.gateAnswer = 'web';
    state.manualActions = ['send'];
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm', params: [] }]);
    assert.strictEqual(state.sends.length, 0, 'not one send may go to the spent API');
    assert.strictEqual(state.opened.length, 1, 'the WhatsApp Web route is the whole point of the choice');
  });

  await test('pre-flight: "Send anyway" is honoured — the gate warns, it does not forbid', async () => {
    state.usage = { limit: { cap: 250, used: 251, remaining: 0, tier: 'TIER_250' } };
    state.gateAnswer = 'go';
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm', params: [] }]);
    assert.strictEqual(state.sends.length, 1, 'the operator may know something the counter does not');
  });

  await test('pre-flight: an unreadable usage call never blocks the day’s work', async () => {
    state.usage = null;                      // /api/whatsapp/usage answers 500
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm', params: [] }]);
    assert.strictEqual(state.gateAsked, 0);
    assert.strictEqual(rowsBy('sent').length, 1, 'unknown headroom must fail OPEN');
  });

  await test('pre-flight: rows that look their number up count as new recipients', async () => {
    const need = sandbox._waRecipientsNeeded([
      { name: 'A', phone: '9000000001' },
      { name: 'B', phone: '+91 90000 00001' },   // same number, written differently
      { name: 'C', prepare: async () => ({}) },  // unknown until the run
    ]);
    assert.strictEqual(need.known, 1, 'one unique number, however it was typed');
    assert.strictEqual(need.unknown, 1);
    assert.strictEqual(need.max, 2, 'the estimate is an upper bound');
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


  // ── The send log has to describe the WHOLE run ───────────────
  // Every other row in whatsapp_messages is written by a send route, so the
  // log only ever knew about messages that reached Meta — and the one run an
  // operator most needs to reconstruct, the one the breaker stopped, was the
  // run it knew least about. These cases pin the rows the client reports back.

  await test('unsent: a stopped run reports every row it never tried', async () => {
    let n = 0;
    const items = ['A','B','C','D','E'].map((name, i) => ({
      name, phone: '900000000' + i, message: 'm', params: [],
      ref: { type: 'invoice', id: 100 + i },
    }));
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      if (String(url).includes('/api/whatsapp/send-template')) {
        state.sends.push(url);
        if (++n >= 2) return { ok: false, status: 502, json: async () => ({ error: 'Spam Rate limit hit' }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return origFetch(url, opts);
    };
    await sandbox._runWaQueue(items);
    sandbox.fetch = origFetch;
    assert.strictEqual(state.unsent.length, 3,
      'the three rows the breaker never tried must reach the log: ' + JSON.stringify(state.unsent));
    assert.deepStrictEqual(state.unsent.map(r => r.ref_id), ['102','103','104'],
      'and they must be named by their RECORD, not just a phone number');
    assert.ok(state.unsent.every(r => r.status === 'not_attempted'), JSON.stringify(state.unsent));
    assert.ok(state.unsent.every(r => r.ref_type === 'invoice'), JSON.stringify(state.unsent));
    assert.ok(/Not attempted/.test(state.unsent[0].reason), state.unsent[0].reason);
  });

  await test('unsent: a row Meta actually refused is left to the server', async () => {
    // The send route logs its own failure, with Meta's reason and whatever
    // wamid came back. A second row invented here would be NEWER and would
    // win any "where does this document stand?" read — so it must not exist.
    let n = 0;
    const items = ['A','B','C'].map((name, i) => ({
      name, phone: '900000000' + i, message: 'm', params: [], ref: { type: 'bill', id: i },
    }));
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      if (String(url).includes('/api/whatsapp/send-template')) {
        state.sends.push(url);
        if (++n === 2) return { ok: false, status: 502, json: async () => ({ error: 'Message undeliverable' }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return origFetch(url, opts);
    };
    await sandbox._runWaQueue(items);
    sandbox.fetch = origFetch;
    assert.strictEqual(state.sends.length, 3, 'a per-message rejection must not stop the run');
    assert.strictEqual(rowsBy('failed').length, 1);
    assert.deepStrictEqual(state.unsent, [],
      'the server already logged that failure: ' + JSON.stringify(state.unsent));
  });

  await test('unsent: no number on file is reported as not_sent, with the reason', async () => {
    await sandbox._runWaQueue([
      { name: 'A', phone: '9000000001', message: 'm', params: [], ref: { type: 'bill', id: 7 } },
      { name: 'B', phone: '',           message: 'm', params: [], ref: { type: 'bill', id: 8 } },
    ]);
    assert.strictEqual(state.sends.length, 1, 'only the row with a number can be sent');
    assert.strictEqual(state.unsent.length, 1, JSON.stringify(state.unsent));
    assert.strictEqual(state.unsent[0].status, 'not_sent');
    assert.strictEqual(state.unsent[0].ref_id, '8');
    assert.ok(/No WhatsApp number/.test(state.unsent[0].reason), state.unsent[0].reason);
  });

  await test('unsent: a document that will not build is reported too', async () => {
    await sandbox._runWaQueue([
      { name: 'A', ref: { type: 'purchase', id: 42 },
        prepare: async () => { throw new Error('PDF route 500'); } },
    ]);
    assert.strictEqual(state.sends.length, 0);
    assert.strictEqual(state.unsent.length, 1, JSON.stringify(state.unsent));
    assert.strictEqual(state.unsent[0].status, 'not_sent');
    assert.strictEqual(state.unsent[0].ref_type, 'purchase');
    assert.ok(/PDF route 500/.test(state.unsent[0].reason), state.unsent[0].reason);
  });

  await test('unsent: a row is never reported twice', async () => {
    // The breaker writes its shortfall mid-run so a walked-away-from run is
    // still recorded; the close-time sweep then covers everything else. The
    // two passes overlap, and a double write would double-count the gap.
    let n = 0;
    const items = ['A','B','C','D'].map((name, i) => ({
      name, phone: '900000000' + i, message: 'm', params: [], ref: { type: 'invoice', id: i },
    }));
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      if (String(url).includes('/api/whatsapp/send-template')) {
        state.sends.push(url);
        if (++n >= 1) return { ok: false, status: 502, json: async () => ({ error: 'Spam Rate limit hit' }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return origFetch(url, opts);
    };
    await sandbox._runWaQueue(items);
    sandbox.fetch = origFetch;
    const ids = state.unsent.map(r => r.ref_id).sort();
    assert.deepStrictEqual(ids, ['1','2','3'], JSON.stringify(state.unsent));
  });

  await test('unsent: a log write that fails costs nothing but the record', async () => {
    state.unsentHttpOk = false;
    let n = 0;
    const items = ['A','B','C'].map((name, i) => ({
      name, phone: '900000000' + i, message: 'm', params: [], ref: { type: 'invoice', id: i },
    }));
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      if (String(url).includes('/api/whatsapp/send-template')) {
        state.sends.push(url);
        if (++n >= 1) return { ok: false, status: 502, json: async () => ({ error: 'Spam Rate limit hit' }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return origFetch(url, opts);
    };
    await sandbox._runWaQueue(items);
    sandbox.fetch = origFetch;
    assert.strictEqual(rowsBy('skipped').length, 2,
      'the on-screen ledger is unaffected by a log failure: ' + JSON.stringify(state.lastRows));
    // Mid-run attempt + close-time retry, both refused — the rows are
    // un-flagged after a failure rather than being silently given up on.
    assert.ok(state.unsent.length >= 4, 'the close-time sweep must try again: ' + state.unsent.length);
  });

  await test('unsent: a run bigger than one request still reports every row', async () => {
    // A thousand-lot trade can put more rows into one run than the route
    // accepts in a single POST. A truncated tail here would be the same
    // invisible shortfall this whole mechanism exists to end.
    const items = Array.from({ length: 1200 }, (_, i) => ({
      name: 'S' + i, phone: '9' + String(100000000 + i), message: 'm', params: [],
      ref: { type: 'invoice', id: i },
    }));
    let posts = 0;
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      if (String(url).includes('/api/whatsapp/log-unsent')) posts++;
      if (String(url).includes('/api/whatsapp/send-template')) {
        state.sends.push(url);
        return { ok: false, status: 502, json: async () => ({ error: 'Spam Rate limit hit' }) };
      }
      return origFetch(url, opts);
    };
    await sandbox._runWaQueue(items);
    sandbox.fetch = origFetch;
    assert.strictEqual(state.unsent.length, 1199,
      'every row after the one that hit the wall: ' + state.unsent.length);
    assert.ok(posts >= 3, 'and it must be split across requests, not truncated: ' + posts);
  });

  // ── Which record was this message about? ─────────────────────

  await test('ref: a document send names its record to the server', async () => {
    await sandbox._runWaQueue([
      { name: 'A', phone: '9000000001', params: ['A', 'your SALES INVOICE 412 is attached.', 'CO'],
        blob, filename: 'i.pdf', ref: { type: 'invoice', id: 412 } },
    ]);
    assert.strictEqual(state.sendBodies.length, 1);
    assert.strictEqual(state.sendBodies[0].f.ref_type, 'invoice');
    assert.strictEqual(state.sendBodies[0].f.ref_id, '412', 'ids travel as strings');
  });

  await test('ref: a text send names its record too', async () => {
    await sandbox._runWaQueue([
      { name: 'A', phone: '9000000001', message: 'm', params: [], ref: { type: 'payment', id: '3:t91' } },
    ]);
    const body = JSON.parse(state.sendBodies[0]);
    assert.strictEqual(body.ref_type, 'payment');
    assert.strictEqual(body.ref_id, '3:t91');
  });

  await test('ref: a sender with no ref still sends, just anonymously', async () => {
    await sandbox._runWaQueue([{ name: 'A', phone: '9000000001', message: 'm', params: [] }]);
    const body = JSON.parse(state.sendBodies[0]);
    assert.strictEqual(body.ref_type, '');
    assert.strictEqual(body.ref_id, '');
  });

  await test('ref: the two id-less modules key on the trader, not the name', async () => {
    // Seller names repeat. A payment ref keyed on the name would merge two
    // sellers' statements into one history and claim both were sent.
    const a = sandbox._waPartyRef('payment', 7, { traderId: 91, name: 'K RAJU' });
    const b = sandbox._waPartyRef('payment', 7, { traderId: 92, name: 'K RAJU' });
    assert.notStrictEqual(a.id, b.id, 'two namesakes must not share a ref: ' + a.id);
    assert.strictEqual(a.type, 'payment');
    // The single-row action and the bulk queue must agree character for
    // character, or the same statement reads as two different documents.
    assert.strictEqual(sandbox._waPartyRef('payment', '7', { traderId: '91', userId: 'u1', name: 'K RAJU' }).id, a.id);
    // No trader id on the row → the name is the last resort, not a crash.
    assert.strictEqual(sandbox._waPartyRef('lot_receipt', 7, { name: ' k raju ' }).id, '7:nK RAJU');
  });


  // ── "Resend only the ones that did not go out" ───────────────
  // The log carries a ref per send, so a screen can line its rows up against
  // it. The property that matters most here is NEGATIVE: a row the log says
  // nothing about must never be ticked. Refs only started being written on
  // 2026-10-10, so every document raised before that has no record — ticking
  // those would send a second copy to people served months ago.

  // A stand-in for one of the six lists. Each checkbox knows its ref id, and
  // `hidden` mimics a row filtered out by the screen's search box.
  function fakeList(rows) {
    const cbs = rows.map(r => ({
      value: String(r.id), checked: !!r.checked, className: 'inv-select-cb',
      parentNode: { querySelector: () => null, appendChild(){}, style: {} },
      closest: () => ({ style: { display: r.hidden ? 'none' : '' } }),
      // The caption matcher reads the document number off the row, the same
      // way the sender composed it into the message.
      getAttribute: (k) => (k === 'data-invo' ? (r.invo || '') : k === 'data-sale' ? (r.sale || '') : ''),
    }));
    const list = {
      querySelector: () => cbs[0] || null,
      querySelectorAll: () => cbs,
    };
    // Capture what the "which rows?" prompt is told, so the counts it puts in
    // front of the operator can be asserted rather than assumed.
    const shown = {};
    const realGet = sandbox.document.getElementById;
    sandbox.document.getElementById = (id) => {
      if (id === 'invoices-list') return list;
      if (/^wa-unsent-/.test(id)) {
        return { style: {}, disabled: false,
          set textContent(v) { shown[id] = v; }, get textContent() { return shown[id] || ''; },
          set innerHTML(v) { shown[id] = v; },  get innerHTML() { return shown[id] || ''; } };
      }
      return realGet(id);
    };
    return { cbs, shown, restore: () => { sandbox.document.getElementById = realGet; } };
  }
  const logRow = (id, status, over = {}) => Object.assign(
    { ref_type: 'invoice', ref_id: String(id), status, created_at: '2026-10-10 09:00', error: '' }, over);
  // A pre-ref row: no ref_id at all, identified only by what the message said.
  const oldRow = (label, status, over = {}) => Object.assign(
    { ref_type: '', ref_id: '', status, created_at: '2026-10-09 11:00', error: '',
      caption: `your SALES INVOICE ${label} for ₹1,000 is attached.` }, over);
  // The button asks before touching rows it has no record for. `answer` is
  // what the operator picks: false = only the known failures, true = those
  // plus the no-record rows, null = cancel.
  const asked = () => vm.runInContext('typeof _waUnsentApply === "function"', sandbox);
  async function pick(answer) {
    if (!asked()) return false;                 // it did not need to ask
    await sandbox._waUnsentAnswer(answer);
    return true;
  }

  await test('marks: a record with no log row is unknown, never "unsent"', async () => {
    state.logRows = [logRow(1, 'read'), logRow(2, 'failed')];
    const f = fakeList([{ id: 1 }, { id: 2 }, { id: 3 }]);   // 3 predates refs entirely
    await sandbox._waSelectUnsent('inv');
    assert.ok(asked(), 'a row it knows nothing about must be ASKED about, never ticked silently');
    await pick(false);                                       // "only the ones that failed"
    assert.strictEqual(f.cbs[0].checked, false, 'a delivered invoice must not be resent');
    assert.strictEqual(f.cbs[1].checked, true,  'the failed one is the point of the button');
    assert.strictEqual(f.cbs[2].checked, false, 'NO RECORD IS NOT A RECORD OF FAILURE');
    // The one row it cannot speak for is put in front of the operator as a
    // number with a caveat, not folded silently into either answer.
    assert.ok(/No record/.test(f.shown['wa-unsent-nums'] || ''), f.shown['wa-unsent-nums']);
    assert.ok(/does not mean/i.test(f.shown['wa-unsent-warn'] || ''), f.shown['wa-unsent-warn']);
    assert.ok(/Tick all 2/.test(f.shown['wa-unsent-all'] || ''),
      'the other way out has to say how many it would tick: ' + f.shown['wa-unsent-all']);
    f.restore();
  });

  await test('marks: every way of not going out is ticked', async () => {
    state.logRows = [logRow(1, 'failed'), logRow(2, 'not_attempted'), logRow(3, 'not_sent'),
                     logRow(4, 'sent'), logRow(5, 'delivered'), logRow(6, 'queued')];
    const f = fakeList([1,2,3,4,5,6].map(id => ({ id })));
    await sandbox._waSelectUnsent('inv');
    await pick(false);
    f.restore();
    assert.deepStrictEqual(f.cbs.map(c => c.checked), [true, true, true, false, false, false],
      JSON.stringify(f.cbs.map(c => c.checked)));
    const t = state.toasts.join('|');
    assert.ok(/3 ticked/.test(t), t);
    assert.ok(/1 failed/.test(t) && /2 never tried/.test(t),
      'failed and never-tried are different problems and are counted apart: ' + t);
  });

  await test('marks: newest row wins — a retry that worked clears the row', async () => {
    // The log APPENDS, so a record that was not_attempted at 10:00 and sent at
    // 10:40 carries both rows. Reading the older one would resend it forever.
    state.logRows = [logRow(1, 'delivered', { created_at: '2026-10-10 10:40' }),
                     logRow(1, 'not_attempted', { created_at: '2026-10-10 10:00' })];
    const f = fakeList([{ id: 1 }]);
    await sandbox._waSelectUnsent('inv');
    await pick(false);
    f.restore();
    assert.strictEqual(f.cbs[0].checked, false, 'the newest word is "delivered"');
  });

  await test('marks: a stale tick is cleared, not left to send a duplicate', async () => {
    state.logRows = [logRow(1, 'read'), logRow(2, 'failed')];
    const f = fakeList([{ id: 1, checked: true }, { id: 2 }]);
    await sandbox._waSelectUnsent('inv');
    await pick(false);
    f.restore();
    assert.strictEqual(f.cbs[0].checked, false,
      'a leftover tick would put a second copy into the run');
  });

  await test('marks: rows filtered off the screen are left alone', async () => {
    state.logRows = [logRow(1, 'failed'), logRow(2, 'failed')];
    const f = fakeList([{ id: 1 }, { id: 2, hidden: true }]);
    await sandbox._waSelectUnsent('inv');
    await pick(false);
    f.restore();
    assert.strictEqual(f.cbs[1].checked, false,
      'the button acts on what the operator can see, like every other select-all here');
  });

  await test('marks: an unreadable log ticks NOTHING and says so', async () => {
    state.logRows = null;
    const f = fakeList([{ id: 1 }, { id: 2 }]);
    await sandbox._waSelectUnsent('inv');
    assert.ok(!asked(), 'an unreadable log is not a decision to put to the operator');
    f.restore();
    assert.deepStrictEqual(f.cbs.map(c => c.checked), [false, false]);
    assert.ok(/Could not read/.test(state.toasts.join('|')), state.toasts.join('|'));
    assert.ok(!/\d+ ticked/.test(state.toasts.join('|')) && !/Nothing ticked/.test(state.toasts.join('|')),
      '"I do not know" must never be reported as "nothing to resend"');
  });

  await test('marks: nothing to resend is said plainly', async () => {
    state.logRows = [logRow(1, 'read'), logRow(2, 'delivered')];
    const f = fakeList([{ id: 1 }, { id: 2 }]);
    await sandbox._waSelectUnsent('inv');
    assert.ok(!asked(), 'nothing is unknown here, so there is nothing to ask');
    f.restore();
    assert.ok(/Nothing ticked/.test(state.toasts.join('|')), state.toasts.join('|'));
  });

  await test('marks: the status reader groups every status it can meet', async () => {
    ['read','delivered','sent','queued'].forEach(st =>
      assert.strictEqual(sandbox._waMarkKind(st), 'ok', st));
    ['failed','not_attempted','not_sent'].forEach(st =>
      assert.strictEqual(sandbox._waMarkKind(st), 'bad', st));
    assert.strictEqual(sandbox._waMarkKind(''), null);
    assert.strictEqual(sandbox._waMarkKind('something Meta invents later'), null,
      'an unknown status must fall through to "no opinion", never to "resend it"');
  });

  await test('marks: Payments keys on the trader, matching what its sender logged', async () => {
    // Payments has no row id: the mark lookup must rebuild character for
    // character the key _waPartyRef gave the send, or no row ever matches.
    // `const` at the top of a vm script is a lexical binding, not a property
    // of the sandbox object — reach it by evaluating inside the context.
    const d = vm.runInContext('WA_LISTS', sandbox).pay;
    const realGet = sandbox.document.getElementById;
    sandbox.document.getElementById = (id) => (id === 'pay-auction' ? { value: '7' } : realGet(id));
    const cb = { value: 'K RAJU', getAttribute: (k) => (k === 'data-trader-id' ? '91' : '') };
    const key = sandbox._waRowKey(d, cb);
    sandbox.document.getElementById = realGet;
    assert.strictEqual(key, sandbox._waPartyRef('payment', 7, { traderId: 91, name: 'K RAJU' }).id,
      'the screen and the sender must agree: ' + key);
  });

  // ── Reading the history that has no ref ─────────────────────
  // Refs started on 2026-10-10. Everything before that is in the log with an
  // empty ref_id, and without these cases a whole trade of already-sent
  // documents would read as "no record" — which is exactly the pile the
  // operator would then be invited to resend.

  await test('history: an old send is recognised from what the message said', async () => {
    state.logRows = [oldRow('L-67', 'read'), oldRow('L-68', 'failed')];
    const f = fakeList([{ id: 1, invo: '67', sale: 'L' }, { id: 2, invo: '68', sale: 'L' }]);
    await sandbox._waSelectUnsent('inv');
    assert.ok(!asked(), 'both rows are accounted for, so there is nothing to ask: ' + JSON.stringify(f.shown));
    f.restore();
    assert.strictEqual(f.cbs[0].checked, false, 'L-67 went out before refs existed and must not be resent');
    assert.strictEqual(f.cbs[1].checked, true,  'L-68 was refused and is still owed');
  });

  await test('history: the sale-type prefix is part of the number', async () => {
    // The message says "SALES INVOICE L-67" — matching on "67" alone would
    // also claim I-67 and E-67, three different invoices to three buyers.
    state.logRows = [oldRow('L-67', 'read')];
    const f = fakeList([{ id: 1, invo: '67', sale: 'I' }]);
    await sandbox._waSelectUnsent('inv');
    await pick(true);
    f.restore();
    assert.strictEqual(f.cbs[0].checked, true, 'I-67 is a different invoice from L-67');
  });

  await test('history: a ref beats a caption when both exist', async () => {
    // The ref is exact and newer. A stale caption from an earlier attempt
    // must not override a verdict recorded against the record itself.
    state.logRows = [logRow(1, 'failed'), oldRow('L-67', 'read')];
    const f = fakeList([{ id: 1, invo: '67', sale: 'L' }]);
    await sandbox._waSelectUnsent('inv');
    f.restore();
    assert.strictEqual(f.cbs[0].checked, true, 'the ref says it failed, and the ref wins');
  });

  await test('history: a number buried in the rupee amount is not a match', async () => {
    // "for ₹1,000" tokenises into 1 and 000 on a naive split. The number is
    // only ever read from the slot right after the document name.
    state.logRows = [oldRow('L-67', 'read', { caption: 'your SALES INVOICE L-67 for ₹1,000 is attached.' })];
    const f = fakeList([{ id: 1, invo: '000', sale: 'L' }, { id: 2, invo: '1', sale: 'L' }]);
    await sandbox._waSelectUnsent('inv');
    assert.ok(asked(), 'neither row is accounted for');
    await pick(true);
    f.restore();
    assert.deepStrictEqual(f.cbs.map(c => c.checked), [true, true],
      'an amount must never vouch for an invoice number');
  });

  await test('history: debit notes and payments deliberately do NOT caption-match', async () => {
    // Both DN screens write the identical "your DEBIT NOTE 55 for …" over two
    // separate number series, and payments name no document at all. A wrong
    // "already sent" there means a seller never gets their note, so those
    // three fall through to "no record" instead of guessing.
    const RE = vm.runInContext('_WA_CAPTION_RE', sandbox);
    assert.ok(RE.invoice && RE.purchase && RE.bill, Object.keys(RE).join(','));
    ['debit_note', 'debit_note_planter', 'payment', 'lot_receipt'].forEach(t =>
      assert.ok(!RE[t], t + ' must not be matched by caption'));
  });

  await test('history: the operator can take the no-record rows too', async () => {
    state.logRows = [oldRow('L-67', 'read')];
    const f = fakeList([{ id: 1, invo: '67', sale: 'L' }, { id: 2, invo: '68', sale: 'L' }]);
    await sandbox._waSelectUnsent('inv');
    assert.ok(asked());
    await pick(true);                                  // "tick all"
    f.restore();
    assert.strictEqual(f.cbs[0].checked, false, 'what is known to have gone out is still never ticked');
    assert.strictEqual(f.cbs[1].checked, true);
    assert.ok(/1 with no record/.test(state.toasts.join('|')), state.toasts.join('|'));
  });

  await test('history: cancelling the prompt changes nothing', async () => {
    state.logRows = [logRow(1, 'failed')];
    const f = fakeList([{ id: 1, checked: false }, { id: 2, checked: true }]);
    await sandbox._waSelectUnsent('inv');
    assert.ok(asked());
    await pick(null);
    f.restore();
    assert.deepStrictEqual(f.cbs.map(c => c.checked), [false, true],
      'Cancel must leave the selection exactly as the operator had it');
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
