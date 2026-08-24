// Two changes, one trade:
//
//   [1] The Checklist export carries a DUMMY column (lots.dummy_code, the
//       free-text tag typed per lot in Price Entry) — in BOTH the XLSX and
//       the PDF, whose queries must stay in lock-step.
//
//   [2] Auction Desk → Lots prints a settled non-sale (code WD / NA) with a
//       real 0.00 amount plus a WD / NA badge, while a lot that is merely
//       awaiting price import keeps its em dash.
//
// End-to-end HTTP for the exports; the row renderer is asserted in a real
// browser at the end (skipped when no Chrome is available).
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-dummy-'));
const PORT = 47371;
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

(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', boot.status, srvLog.slice(-2000)); cleanup(); process.exit(1); }
  await api('POST', '/api/users', { username: 'uiadmin', password: 'pw1234', role: 'admin' });

  const auc = await api('POST', '/api/auctions', { ano: '51', date: '2026-08-22', state: 'TAMIL NADU' });
  const aid = auc.d.id || (auc.d.auction && auc.d.auction.id);

  // 001 sold (tagged "AX7"), 002 withdrawn, 003 not auctioned, 004 pending.
  const mk = async (lot_no, extra) => {
    const r = await api('POST', '/api/lots', Object.assign({ auction_id: aid, lot_no, name: 'RAMU', bags: 2, qty: 73.4 }, extra));
    return r.d.id || (r.d.lot && r.d.lot.id);
  };
  const id1 = await mk('001');
  const id2 = await mk('002');
  const id3 = await mk('003');
  await mk('004');
  await api('PUT', `/api/lots/${id1}`, { price: 100, amount: 7340, code: 'TS', buyer: 'TS' });
  await api('PUT', `/api/lots/${id2}`, { code: 'WD' });
  await api('PUT', `/api/lots/${id3}`, { code: 'NA' });
  // The Price Entry dummy-code tag lives behind its own endpoint.
  await api('POST', `/api/lots/${id1}/dummy-code`, { value: 'AX7' });

  const lots = (await api('GET', `/api/lots/${aid}`)).d;
  const byLot = n => lots.find(l => String(l.lot_no).replace(/^0+/, '') === String(n));
  check('fixture: the dummy code stored on lot 001',
        byLot(1) && byLot(1).dummy_code === 'AX7', JSON.stringify(byLot(1) && byLot(1).dummy_code));
  check('fixture: lot 002 is WD, lot 003 is NA, lot 004 has no code',
        byLot(2).code === 'WD' && byLot(3).code === 'NA' && !String(byLot(4).code || '').trim(),
        JSON.stringify([byLot(2).code, byLot(3).code, byLot(4).code]));

  // ── [1] Checklist exports ────────────────────────────────────
  console.log('\n[1] Checklist export carries the DUMMY column');
  const ExcelJS = require('exceljs');
  const xr = await fetch(`${B}/api/exports/checklist/${aid}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('XLSX endpoint returns 200', xr.status === 200, String(xr.status));
  if (xr.status === 200) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await xr.arrayBuffer()));
    const ws = wb.worksheets[0];
    // Find the header row by its first cell, then read across it — the sheet
    // carries title + meta lines above the table.
    let hdr = null, hdrRow = 0;
    ws.eachRow((row, n) => {
      const vals = row.values.slice(1).map(v => String(v == null ? '' : (v.text || v)).trim());
      if (!hdr && vals.includes('LOT') && vals.includes('QTY')) { hdr = vals.filter(Boolean); hdrRow = n; }
    });
    check('header row found', !!hdr, JSON.stringify(hdr));
    check('columns are LOT | DUMMY | BUYER | BAGS | QTY | SALE',
          JSON.stringify(hdr) === JSON.stringify(['LOT', 'DUMMY', 'BUYER', 'BAGS', 'QTY', 'SALE']),
          JSON.stringify(hdr));
    const dataRows = [];
    ws.eachRow((row, n) => { if (n > hdrRow) dataRows.push(row.values.slice(1).map(v => String(v == null ? '' : (v.text || v)).trim())); });
    const r001 = dataRows.find(r => String(r[0]).replace(/^0+/, '') === '1');
    check('lot 001 prints its dummy code in the second column',
          r001 && r001[1] === 'AX7', JSON.stringify(r001));
    const r002 = dataRows.find(r => String(r[0]).replace(/^0+/, '') === '2');
    check('an untagged lot leaves the DUMMY cell blank',
          r002 && (r002[1] === '' || r002[1] == null), JSON.stringify(r002));
    check('every lot is still listed, withdrawn included',
          dataRows.filter(r => /^0*\d+$/.test(String(r[0]))).length === 4,
          String(dataRows.length));
  }

  const pr = await fetch(`${B}/api/exports/checklist/${aid}?format=pdf`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('PDF endpoint returns 200', pr.status === 200, String(pr.status));
  if (pr.status === 200) {
    const buf = Buffer.from(await pr.arrayBuffer());
    check('PDF is non-trivial', buf.length > 1000, String(buf.length));
  }
  // The PDF's own text is written as subset-font glyph indices, so it can't be
  // scanned. Assert the two things that actually decide what it prints — its
  // column spec, and the row query behind it — straight from the module. The
  // header comment on both requires them to stay in lock-step with the XLSX.
  const { COLS } = require(path.join(ROOT, 'exports-pdf.js'));
  check('PDF column spec matches the XLSX column set',
        JSON.stringify(COLS.checklist.map(c => c.header)) ===
        JSON.stringify(['LOT', 'DUMMY', 'BUYER', 'BAGS', 'QTY', 'SALE']),
        JSON.stringify(COLS.checklist.map(c => c.header)));
  check('PDF DUMMY column reads the `dummy` key the query supplies',
        COLS.checklist.find(c => c.header === 'DUMMY')?.key === 'dummy',
        JSON.stringify(COLS.checklist.find(c => c.header === 'DUMMY')));

  // ── [1b] Bulk dummy code ─────────────────────────────────────
  // Price Entry's "Set Buyer Code & Split" modal tags a whole selection at
  // once. The route is separate from bulk-set-buyer on purpose: a tag must
  // never touch price or qty, so it can't invalidate a price-check stamp.
  console.log('\n[1b] Bulk dummy code over a selection');
  {
    const before = (await api('GET', `/api/lots/${aid}`)).d;
    const pick = before.filter(l => ['002', '003', '004'].includes(String(l.lot_no)));
    const r = await api('POST', '/api/lots/dummy-code/bulk',
                        { ids: pick.map(l => l.id), value: 'BATCH-9' });
    check('the bulk route tags every selected lot', r.status === 200 && r.d.updated === 3,
          JSON.stringify(r.d));
    const after = (await api('GET', `/api/lots/${aid}`)).d;
    const dc = n => (after.find(l => String(l.lot_no).replace(/^0+/, '') === String(n)) || {}).dummy_code;
    check('all three carry the new tag', dc(2) === 'BATCH-9' && dc(3) === 'BATCH-9' && dc(4) === 'BATCH-9',
          JSON.stringify([dc(2), dc(3), dc(4)]));
    // WD/NA lots are excluded from the invoice split because they can't be
    // invoiced; a tag has no such constraint, so they must be tagged too.
    check('a WD and an NA lot are tagged like any other', dc(2) === 'BATCH-9' && dc(3) === 'BATCH-9',
          JSON.stringify([dc(2), dc(3)]));
    check('an unselected lot keeps its own tag untouched', dc(1) === 'AX7', String(dc(1)));

    // Price / qty must be exactly as they were — this is the whole reason the
    // tag does not go through the general lot update.
    const p = n => { const l = after.find(x => String(x.lot_no).replace(/^0+/, '') === String(n)); return [l.price, l.qty, l.amount]; };
    const pb = n => { const l = before.find(x => String(x.lot_no).replace(/^0+/, '') === String(n)); return [l.price, l.qty, l.amount]; };
    check('tagging changed no price, qty or amount',
          JSON.stringify([p(1), p(2), p(3), p(4)]) === JSON.stringify([pb(1), pb(2), pb(3), pb(4)]),
          JSON.stringify([p(1), p(2), p(3), p(4)]));

    const over = await api('POST', '/api/lots/dummy-code/bulk',
                           { ids: [pick[0].id], value: '  ' + 'X'.repeat(60) + '  ' });
    check('the value is trimmed and capped at 40 chars like the per-lot route',
          over.status === 200 && over.d.value === 'X'.repeat(40), JSON.stringify(over.d.value));

    const none = await api('POST', '/api/lots/dummy-code/bulk', { ids: [], value: 'Z' });
    check('an empty id list is refused with 400', none.status === 400, String(none.status));

    // Put lot 002 back so [2]'s row-rendering assertions see the fixture they
    // were written against.
    await api('POST', '/api/lots/dummy-code/bulk', { ids: pick.map(l => l.id), value: '' });
    const reset = (await api('GET', `/api/lots/${aid}`)).d;
    check('blank clears the tag again', reset.filter(l => ['002', '003', '004'].includes(String(l.lot_no)))
            .every(l => !String(l.dummy_code || '')), 'still tagged');
  }

  // ── [2] Auction Desk row rendering ───────────────────────────
  console.log('\n[2] Auction Desk → Lots: 0.00 + WD / NA badge');
  let pptr = null, chrome = null;
  try { pptr = require('puppeteer-core'); } catch (_) {}
  if (pptr) {
    for (const p of [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
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
  }
  if (!chrome) {
    console.log('  skip no Chrome available — row rendering not checked');
  } else {
    browser = await pptr.launch({ executablePath: chrome.executablePath, args: chrome.args, headless: true });
    const page = await browser.newPage();
    page.on('pageerror', e => { fail++; console.log('  FAIL page error: ' + e.message); });
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#inp-u', { timeout: 15000 });
    await page.evaluate(() => {
      document.getElementById('inp-u').value = 'uiadmin';
      document.getElementById('inp-p').value = 'pw1234';
      login();
    });
    await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', { timeout: 20000 });

    const cells = await page.evaluate((rows) => {
      window._hubLots = rows;
      hubRenderLots();
      const out = {};
      for (const tr of document.querySelectorAll('#hub-lot-rows tr')) {
        const tds = tr.children;
        if (tds.length < 9) continue;
        out[tds[0].textContent.trim()] = {
          amount: tds[6].textContent.trim(),
          buyer: tds[7].textContent.trim(),
          badge: tds[7].querySelector('.hub-lot-badge')?.textContent.trim() || '',
          nilBadge: !!tds[7].querySelector('.hub-lot-badge.is-nil'),
          greyRow: tr.classList.contains('is-wd'),
        };
      }
      return out;
    }, lots);

    const c1 = cells['001'], c2 = cells['002'], c3 = cells['003'], c4 = cells['004'];
    check('a SOLD lot still shows its real amount', c1 && c1.amount === '7,340.00', JSON.stringify(c1));
    check('a sold lot keeps its plain buyer-code badge',
          c1 && c1.badge === 'TS' && !c1.nilBadge, JSON.stringify(c1));

    check('a WITHDRAWN lot shows 0.00 in Amount', c2 && c2.amount === '0.00', JSON.stringify(c2));
    check('…and carries a WD badge on the buyer cell', c2 && c2.badge === 'WD', JSON.stringify(c2));
    check('…styled as a settled non-sale, not a buyer code', c2 && c2.nilBadge, JSON.stringify(c2));
    check('…with the row still greyed', c2 && c2.greyRow, JSON.stringify(c2));

    check('a NOT-AUCTIONED lot shows 0.00 and an NA badge',
          c3 && c3.amount === '0.00' && c3.badge === 'NA' && c3.nilBadge, JSON.stringify(c3));

    check('a lot merely AWAITING PRICING keeps the em dash (never a fake 0.00)',
          c4 && c4.amount === '—' && c4.badge === '', JSON.stringify(c4));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
