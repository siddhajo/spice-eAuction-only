// Every file the app hands out names its TRADE, by auction NUMBER (`ano`).
//
// Two ways that was being broken, both of which looked fine in the live data:
//
//   · Twelve routes put the internal `auctions.id` in the filename. Every
//     auction currently has id == ano, so the names looked right — until an
//     auction is deleted (ids are AUTOINCREMENT, never reused) or an ano stops
//     being a plain number (`ano` is a TEXT column).
//
//   · Per-document names left the trade out, and those numbers are NOT
//     globally unique: 35 (sale, invo) pairs in the live data are reused
//     across anos, so sales invoice I-18 from auction 14 and I-18 from 15 were
//     both "Invoice_I_18.pdf" and overwrote each other on download. Lot
//     numbers are worse — 490 of 499 are reused across trades.
//
// Both failures are silent: nothing errors, you just can't tell two files
// apart, or you only have one of them. Hence a lint, not a runtime check.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  safeFilePart, exportFileName, anoForFilename, anoLabelForRows, anoLabelForIds, scopeParts,
} = require(path.join(ROOT, 'export-filename'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// ── The helper itself ────────────────────────────────────────────────────
check('joins parts with underscores',
  exportFileName('Invoice', '15', 'L', '9') === 'Invoice_15_L_9');

// The degrade path matters: a document that predates the ano, or a lookup
// that fails, must give back the OLD name rather than "Invoice__L_9" or
// "Invoice_undefined_L_9".
check('drops blank parts rather than doubling the separator',
  exportFileName('Invoice', '', 'L', '9') === 'Invoice_L_9');
check('drops null/undefined parts',
  exportFileName('Invoice', null, undefined, '9') === 'Invoice_9');
check('numbers are usable as parts',
  exportFileName('Batch', 15, 12) === 'Batch_15_12');

// Content-Disposition quotes the filename, so a quote in a party name would
// truncate the header; path separators would change where the file lands.
check('strips characters a filename or the header cannot carry',
  safeFilePart('42/A "x"\\y') === '42-A_-x-y',
  'got ' + JSON.stringify(safeFilePart('42/A "x"\\y')));
check('collapses whitespace instead of leaving spaces in the name',
  safeFilePart('  AAA  TRADERS  ') === 'AAA_TRADERS',
  'got ' + JSON.stringify(safeFilePart('  AAA  TRADERS  ')));

// ── Batch labels ────────────────────────────────────────────────────────
check('a batch within one trade is labelled with that ano',
  anoLabelForRows([{ ano: '15' }, { ano: '15' }]) === '15');
check('a batch spanning trades is labelled Multi, not one of them',
  anoLabelForRows([{ ano: '15' }, { ano: '16' }]) === 'Multi');
check('rows with no ano yield no label at all',
  anoLabelForRows([{}, { ano: '' }]) === '');
check('a non-array is tolerated', anoLabelForRows(null) === '');
check('anoLabelForIds refuses a non-literal table name',
  anoLabelForIds({ all: () => [{ ano: '9' }] }, 'invoices; DROP TABLE x', [1]) === '');
check('anoLabelForIds reads through the db it is handed',
  anoLabelForIds({ all: () => [{ ano: '9' }] }, 'invoices', [1]) === '9');
check('a db that throws degrades to no label',
  anoLabelForIds({ all: () => { throw new Error('nope'); } }, 'invoices', [1]) === '');

// ── Trade-or-date-range scope ───────────────────────────────────────────
const fakeDb = { get: () => ({ ano: '15' }) };
check('scopeParts prefers an explicit ano',
  scopeParts(fakeDb, { ano: '21', auctionId: 3 }).join('_') === '21');
check('scopeParts resolves an auction id to its ano',
  scopeParts(fakeDb, { auctionId: 7 }).join('_') === '15');
check('scopeParts falls back to the date range',
  scopeParts(fakeDb, { from: '2026-08-01', to: '2026-08-31' }).join('_')
    === '2026-08-01_to_2026-08-31');
check('scopeParts on an unscoped report adds nothing',
  scopeParts(fakeDb, {}).length === 0);
check('anoForFilename falls back to the id when the auction is gone',
  anoForFilename({ get: () => null }, 42) === '42');

// ── Lint: no download filename may carry the internal auction id ─────────
// This is the regression that matters. `${auctionId}` inside a filename
// template reads as correct and is not, and it cost nothing to introduce
// because id == ano in the data in front of you.
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MOBILE = fs.readFileSync(path.join(ROOT, 'mobile-bridge.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

for (const [label, src] of [['server.js', SERVER], ['mobile-bridge.js', MOBILE]]) {
  const bad = [];
  src.split(/\r?\n/).forEach((ln, i) => {
    if (!/filename\s*=/i.test(ln)) return;
    // The id appears legitimately as a lookup ARGUMENT: anoForFilename(db,
    // auctionId) is the fix, not the bug. Blank those calls before looking.
    const stripped = ln.replace(/anoForFilename\([^)]*\)/g, 'ANO')
                       .replace(/anoLabelForIds\([^)]*\)/g, 'ANO');
    if (/\$\{\s*(?:opts\.)?auctionId\b/.test(stripped)) {
      bad.push((i + 1) + ': ' + ln.trim());
    }
  });
  check(`${label}: no filename is built from the internal auction id`,
    bad.length === 0, bad.join('\n         '));
}

// Same rule on the client, where the <select> VALUE is the id and the ano is
// only in the option's label — hence anoFromSelect().
{
  const bad = [];
  CLIENT.split(/\r?\n/).forEach((ln, i) => {
    if (!/\.download\s*=/.test(ln)) return;
    const stripped = ln.replace(/anoFromSelect\([^)]*\)/g, 'ANO');
    // `||aid` is the last-resort fallback behind anoFromSelect; flag a bare
    // `${aid}` that no ano lookup stands in front of.
    if (/\$\{\s*aid\s*\}/.test(stripped) && !/ANO\s*\|\|/.test(ln)) {
      bad.push((i + 1) + ': ' + ln.trim());
    }
  });
  check('index.html: no download name is built from the bare auction id',
    bad.length === 0, bad.join('\n         '));
}

// ── Lint: the client must not discard the server's filename ─────────────
// A hand-rolled `a.download = ...` throws away the Content-Disposition the
// server went to the trouble of setting. Every download that targets an
// export endpoint has to read the header first (filenameFromResponse), using
// its own string only as a fallback.
{
  const lines = CLIENT.split(/\r?\n/);
  const bad = [];
  lines.forEach((ln, i) => {
    const m = /\.download\s*=\s*(.+)$/.exec(ln);
    if (!m) return;
    const rhs = m[1];
    // Names built from a template that references an auction are export
    // downloads; a literal like 'settings.json' or a local `name`/`filename`
    // variable is something the client itself produced.
    if (!/\$\{/.test(rhs)) return;
    if (!/\baid\b|anoFromSelect|sbAuctionId/.test(rhs)) return;
    if (!/filenameFromResponse/.test(rhs)) bad.push((i + 1) + ': ' + ln.trim());
  });
  check('index.html: auction-scoped downloads honour the server filename',
    bad.length === 0, bad.join('\n         '));
}

// ── Lint: the per-document PDFs keep their ano ───────────────────────────
// Each of these named a document by a number that repeats across trades.
// Pinned by name because re-introducing any one of them is a silent overwrite.
const MUST_CARRY_ANO = [
  ["Invoice", /exportFileName\('Invoice',\s*stored\.ano/],
  ["PurchaseView", /exportFileName\('PurchaseView',\s*stored\.ano/],
  ["DebitNote", /exportFileName\('DebitNote',\s*dn\.ano/],
  ["DebitNotePlanter", /exportFileName\('DebitNotePlanter',\s*dn\.ano/],
  ["Receipt", /exportFileName\('Receipt',\s*lot\.ano/],
];
for (const [name, re] of MUST_CARRY_ANO) {
  check(`${name} PDF is named with its trade`, re.test(SERVER));
}
check('lot receipts on the phone are named with their trade',
  /exportFileName\('Lot',\s*lot\.ano,\s*lot\.lot_no/.test(MOBILE));

// Batch documents: a count alone is not a name. Two 12-document batches from
// different trades produced the same filename, and the second replaced the
// first.
{
  const bad = [];
  for (const m of SERVER.matchAll(/filename="([A-Za-z]+_?)*Batch_\$\{[^}]*\.length\}/g)) {
    bad.push(m[0]);
  }
  check('no batch PDF is named by document count alone',
    bad.length === 0, bad.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
