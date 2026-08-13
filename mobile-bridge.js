/**
 * mobile-bridge.js — PWA compatibility layer for the merged app.
 *
 * Mounts the mobile lot-entry UI (PWA's app.html) at `/mobile` and
 * registers the alias/shim endpoints under `/api/auth/*`, `/api/config`,
 * `/api/status`, `/api/logo`, `/api/lots` (query-string filter form),
 * etc. so the mobile UI can talk to spice-config's existing API without
 * the HTML knowing about the rename.
 *
 * Why a bridge instead of patching app.html:
 *   - app.html is a known-good piece of code (1600+ lines). Patching ~30
 *     fetch() callsites inline would be a maintenance burden every time
 *     we re-import the PWA's UI.
 *   - All deltas live in this one file — easy to audit, easy to remove
 *     later if we ever rewrite the mobile UI on spice-config's native API.
 *
 * Pass 1 scope (this file): everything app.html needs to log in, browse
 *   auctions, search/create sellers + banks, and CRUD lots.
 * Pass 2 scope (next iteration): receipt PDF, batch/seller print routes
 *   — currently stubbed with 501 so missing-feature buttons surface a
 *   clear "not yet" message instead of generic network errors.
 */

const path = require('path');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { formatDateForDisplay } = require('./report-formatters');

// ════════════════════════════════════════════════════════════════════
// RECEIPT-PRINT HELPERS — ported from PWA server.js's renderer code.
// ════════════════════════════════════════════════════════════════════
// All field-name remappings live here so the renderer can stay agnostic:
//   spice-config column → PWA renderer expects
//     lots.gross_wt     → lot.gross_weight
//     lots.sample_wt    → lot.sample_weight
//     lots.name         → lot.trader_name (denormalised seller name)
//     lots.ppin         → lot.pin
// The query selects these aliased fields directly so renderSellerReceipt
// (which is a verbatim port) doesn't need to know about the rename.

// Spice-config logo location (single-company build — always ispl.png).
function getLogoPath() {
  const p = path.join(__dirname, 'public', 'logo-ispl.png');
  return fs.existsSync(p) ? p : null;
}

// Sync a trader's banks array into the trader_banks table. Mirrors the
// helper of the same name in server.js (the desktop UI POSTs the full
// banks array on the main trader endpoints; both this bridge and the
// native server route need to persist them).
//
// Strategy: delete the trader's existing rows and re-insert. Bank counts
// per trader are tiny (typically 1–3), so the delete+reinsert cost is
// negligible and the logic stays simple. Also mirrors the FIRST bank
// back into traders.ifsc/acctnum/holder_name so legacy single-bank
// code paths (exports, older invoice generators) still see a primary
// account.
function syncTraderBanks(db, traderId, banks) {
  const arr = Array.isArray(banks) ? banks.filter(b => b && (b.acctnum || b.ifsc)) : [];
  db.run('DELETE FROM trader_banks WHERE trader_id = ?', [traderId]);
  for (const b of arr) {
    db.run(
      'INSERT INTO trader_banks (trader_id, bank_name, acctnum, ifsc, holder_name) VALUES (?,?,?,?,?)',
      [traderId, b.bank_name || '', String(b.acctnum || ''), String(b.ifsc || ''), b.holder_name || '']
    );
  }
  // Mirror first bank into the parent traders row for legacy compatibility
  const first = arr[0] || {};
  db.run(
    'UPDATE traders SET ifsc=?, acctnum=?, holder_name=? WHERE id=?',
    [first.ifsc || '', first.acctnum || '', first.holder_name || '', traderId]
  );
}

// Mask an account number for the receipt according to admin-set policy.
// Mirrors the PWA's privacy switch verbatim.
function maskAcctForReceipt(acctnum, maskType) {
  if (!acctnum || !maskType || maskType === 'none') return acctnum;
  const a = String(acctnum);
  if (maskType === 'show_last4' || maskType === 'show_last4_star') {
    if (a.length <= 4) return a;
    return '*'.repeat(a.length - 4) + a.slice(-4);
  }
  if (maskType === 'show_first4_last4') {
    if (a.length <= 8) return a;
    return a.slice(0, 4) + '*'.repeat(a.length - 8) + a.slice(-4);
  }
  return acctnum;
}

// Pull the receipt-relevant settings from spice-config's company_settings.
// Field names match what the PWA renderer reads off cfg.
function getReceiptConfig(db) {
  const get = (key, fb = '') => {
    const r = db.get('SELECT value FROM company_settings WHERE key = ?', [key]);
    return r ? r.value : fb;
  };
  const getBool = (key, fb = false) => {
    const v = get(key, '');
    if (!v) return fb;
    return v === 'true' || v === '1';
  };
  return {
    appTitle:     get('trade_name', 'Spice Auction'),
    // Operator's Date Format (Settings → Business Mode). Drives the receipt
    // header date so it matches every other printed document.
    dateFormat:   get('date_format', 'dd/mm/yyyy'),
    // Company contact shown on the DETAILED receipt header (logo-to-the-side
    // letterhead). Kerala office is the primary; Tamil Nadu is the fallback.
    companyPhone: get('kl_phone', '') || get('tn_phone', ''),
    companyGstin: get('kl_gstin', '') || get('tn_gstin', ''),
    showUser:     getBool('show_username', false),
    acctMask:     get('acct_mask', 'none'),
    showMoisture: getBool('show_moisture', false),
    sampleWeight: parseFloat(get('sample_weight', '0')) || 0,
    // Operator-chosen lot-receipt columns (Settings → Lot Entry Defaults).
    // Lot# always prints; the rest are opt-in/out here. Drives both the Full
    // and Compact receipt renderers so the user decides what's on the slip.
    receiptCols: {
      grade:    getBool('lot_receipt_show_grade',  false),
      bags:     getBool('lot_receipt_show_bags',   true),
      litre:    getBool('lot_receipt_show_litre',  false),
      net:      getBool('lot_receipt_show_net',    true),
      sample:   getBool('lot_receipt_show_sample', true),
      gross:    getBool('lot_receipt_show_gross',  true),
      crpt:     getBool('lot_receipt_show_crpt',   false),
      moisture: getBool('show_moisture',           false),
    },
    // Thermal paper width (Settings → Lot Entry Defaults → "Lot Receipt
    // Paper Width"). Same key the desktop print path reads, so a 58mm
    // HOP-HL58 prints the same width from mobile / WhatsApp. Blank/0 keeps
    // the legacy widths (compact ~63mm, full 340pt).
    paperWidthMm: parseFloat(get('lot_receipt_width_mm', '')) || 0,
    labels:       {},  // spice-config doesn't customize labels; defaults fine
  };
}

// ── HEADER (full size: ~340pt wide) ──────────────────────────────
function addReceiptHeader(doc, appTitle, branch, dateFmt, tradeNo, pageW, companyPhone, companyGstin) {
  const pw = pageW || 340;
  const m = receiptMargin(pw, false);
  const w = pw - 2 * m;
  const sc = w / 300;                         // 1 at the default 340pt roll
  const fs = (b) => Math.max(6, b * sc);      // shrink header text on a narrow roll
  // Letterhead header: logo pinned to the LEFT, company block (name / branch /
  // phone / GSTIN) set beside it and left-aligned so the lines stack cleanly.
  const startY = doc.y;
  const logoPath = getLogoPath();
  let textX = m, textW = w, logoSz = 0;
  if (logoPath) {
    logoSz = Math.round(42 * (w / 300));  // scale logo with paper width
    try {
      doc.image(logoPath, m, startY, { width: logoSz, height: logoSz });
      textX = m + logoSz + 9;
      textW = w - logoSz - 9;
    } catch (e) { logoSz = 0; textX = m; textW = w; }
  }
  doc.font('Helvetica-Bold').fontSize(fs(14)).text(appTitle, textX, startY, { width: textW });
  doc.font('Helvetica').fontSize(fs(9.5)).text((branch || '') + ' BRANCH', textX, doc.y, { width: textW });
  if (companyPhone) doc.fontSize(fs(9)).text('Ph: ' + companyPhone, textX, doc.y, { width: textW });
  if (companyGstin) doc.fontSize(fs(9)).text('GSTIN: ' + companyGstin, textX, doc.y, { width: textW });
  // Make sure the header clears the logo before drawing the divider.
  if (logoSz && doc.y < startY + logoSz) doc.y = startY + logoSz;
  doc.moveDown(0.4);
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.5).stroke(); doc.moveDown(0.4);

  // Auction # on the LEFT, Date on the RIGHT. Smaller font, a wider Date
  // column and lineBreak:false keep "Date: dd/mm/yyyy" on ONE line even on a
  // narrow thermal roll (it used to wrap when w/2 was too small for the value).
  doc.font('Helvetica').fontSize(fs(8));
  const y0 = doc.y;
  doc.text('Auction #' + tradeNo, m, y0, { width: w * 0.45, lineBreak: false });
  doc.text('Date: ' + dateFmt, m + w * 0.45, y0, { width: w * 0.55, align: 'right', lineBreak: false });
  doc.y = y0 + Math.max(10, 13 * Math.min(1, sc));
  doc.moveDown(0.2);
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).dash(3, { space: 3 }).lineWidth(0.5).stroke().undash();
  doc.moveDown(0.4);
}

// ── HEADER (compact: ~180pt wide, thermal-printer friendly) ──────
function addReceiptHeaderCompact(doc, appTitle, branch, dateFmt, tradeNo, pageW) {
  const pw = pageW || 180;
  const m = receiptMargin(pw, true);
  const w = pw - 2 * m;
  const sc = w / 160;                        // 1 at the default 180pt roll
  const fs = (b) => Math.max(5, b * sc);     // shrink header text on a 58mm roll
  // Compact stub: no logo — a lean thermal receipt keeps only the name/branch.
  doc.font('Helvetica-Bold').fontSize(fs(10)).text(appTitle, m, doc.y, { width: w, align: 'center' });
  doc.fontSize(fs(7.5)).text((branch || '') + ' BRANCH', m, doc.y, { width: w, align: 'center' });
  doc.moveDown(0.2);
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.4).stroke(); doc.moveDown(0.2);
  // Auction # on the LEFT, Date on the RIGHT (matches the detailed slip).
  // Smaller font + wider Date column + no wrap keeps it on one line.
  doc.font('Helvetica').fontSize(fs(6.5));
  const y0 = doc.y;
  doc.text('Auction #' + tradeNo, m, y0, { width: w * 0.45, lineBreak: false });
  doc.text('Date: ' + dateFmt, m + w * 0.45, y0, { width: w * 0.55, align: 'right', lineBreak: false });
  doc.y = y0 + Math.max(9, 10 * sc);
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).dash(2, { space: 2 }).lineWidth(0.4).stroke().undash();
  doc.moveDown(0.2);
}

// Ordered lot-receipt columns the operator turned on (cfg.receiptCols).
// Lot# is mandatory; the rest are opt-in. Each field carries a relative
// `weight` so the renderers distribute the available width proportionally —
// which means any combination of columns fits the slip without overflow.
// `val(l, cfg)` produces the cell text for a lot row.
function enabledReceiptFields(cfg) {
  const L = cfg.labels || {}; const lb = (k, d) => L[k] || d;
  const rc = cfg.receiptCols || {};
  const all = [
    { key: 'lot_no',   on: true,        hdr: lb('lot_no', 'Lot#'),      weight: 1.1, val: l => String(l.lot_no != null ? l.lot_no : '') },
    { key: 'grade',    on: !!rc.grade,  hdr: lb('grade', 'Grade'),      weight: 0.9, val: l => String(l.grade || '') },
    { key: 'bags',     on: rc.bags !== false, hdr: lb('bags', 'Bags'),  weight: 0.8, val: l => String(l.bags != null ? l.bags : '') },
    { key: 'litre',    on: !!rc.litre,  hdr: lb('litre_wt', 'Litre'),   weight: 0.9, val: l => String(l.litre || '') },
    { key: 'net',      on: rc.net !== false,  hdr: lb('net_wt', 'Net'),  weight: 1.2, val: l => Number(l.qty || 0).toFixed(3) },
    { key: 'sample',   on: rc.sample !== false, hdr: lb('sample_wt', 'Smp'), weight: 1.0, val: (l, c) => { const sw = Number(l.sample_weight) || (c && c.sampleWeight) || 0; return sw ? sw.toFixed(3) : ''; } },
    { key: 'gross',    on: rc.gross !== false, hdr: lb('gross_wt', 'Gross'), weight: 1.2, val: l => l.gross_weight != null ? Number(l.gross_weight).toFixed(3) : '' },
    { key: 'moisture', on: !!rc.moisture, hdr: lb('moisture', 'Mst%'),  weight: 0.8, val: l => l.moisture ? Number(l.moisture).toFixed(1) : '' },
    { key: 'crpt',     on: !!rc.crpt,   hdr: lb('crpt', 'CropRcpt'),    weight: 1.1, val: l => String(l.crpt || '') },
  ];
  const on = all.filter(f => f.on);
  // Never render a lonely Lot# column — if the operator turned everything else
  // off, fall back to the classic Net/Gross so the slip still carries weights.
  return on.length > 1 ? on : all.filter(f => ['lot_no', 'net', 'gross'].includes(f.key));
}

// ── RENDERER (full) ──────────────────────────────────────────────
function renderSellerReceipt(doc, sellerLots, cfg) {
  // Content width + column scale follow the configured paper width (same
  // receiptPageW the document page was sized to). sc === 1 at the default
  // 340pt page, so default receipts are byte-for-byte unchanged. On a narrow
  // roll, shrink fonts (floored at 5.5pt so they stay legible) and the fixed
  // per-row heights (floored at vs=0.78) so the slip fits without overflow.
  const pageW = receiptPageW(false, cfg.paperWidthMm);
  const m = receiptMargin(pageW, false);
  const w = pageW - 2 * m;
  const sc = w / 300;
  const fs = (b) => Math.max(5.5, b * sc);
  const vs = Math.max(0.78, Math.min(1, sc));
  const lot = sellerLots[0];
  const dateFmt = formatDateForDisplay(lot.date, cfg.dateFormat);
  const L = cfg.labels || {};
  const lb = (k, d) => L[k] || d;
  const headerBranch = cfg.branch || lot.branch;

  addReceiptHeader(doc, cfg.appTitle, headerBranch, dateFmt, lot.ano, pageW, cfg.companyPhone, cfg.companyGstin);

  const lw = 70 * sc;
  const maskedAcct = maskAcctForReceipt(lot.acctnum, cfg.acctMask);
  const sellerFields = [
    [lb('seller', 'Seller'), lot.trader_name],
    [lb('gstin',  'GSTIN'),  lot.cr],
    [lb('acct_no','A/C No'), maskedAcct || '--NIL--'],
    [lb('ifsc',   'IFSC'),   lot.ifsc || '--NIL--'],
  ];
  doc.fontSize(fs(9));
  sellerFields.forEach(([label, value]) => {
    if (!value) return;
    const y = doc.y;
    doc.font('Helvetica-Bold').text(label, m, y, { width: lw });
    doc.font('Helvetica').text(String(value), m + lw, y, { width: w - lw });
    if (doc.y < y + 13 * vs) doc.y = y + 13 * vs;
  });

  doc.moveDown(0.3);
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.5).stroke(); doc.moveDown(0.3);

  // Columns are operator-chosen and width-distributed by weight so any mix fits.
  const fields = enabledReceiptFields(cfg);
  const onKeys = new Set(fields.map(f => f.key));
  const totW = fields.reduce((a, f) => a + f.weight, 0);
  const cols = fields.map(f => w * f.weight / totW);
  const hdrs = fields.map(f => f.hdr);

  const hdrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(fs(7.5));
  let cx = m;
  hdrs.forEach((h, i) => { doc.text(h, cx, hdrY, { width: cols[i], align: 'center', lineBreak: false, ellipsis: true }); cx += cols[i]; });
  doc.y = hdrY + 11 * vs;
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.3).stroke(); doc.moveDown(0.2);

  doc.font('Helvetica').fontSize(fs(8));
  let totalQty = 0, totalGross = 0, totalBags = 0, totalSample = 0;
  sellerLots.forEach(l => {
    const ry = doc.y;
    cx = m;
    // lineBreak:false keeps every value on ONE line so a slightly-wide number
    // (e.g. "105.000") can't wrap and shove the row's cells out of alignment.
    fields.forEach((f, i) => { doc.text(String(f.val(l, cfg)), cx, ry, { width: cols[i], align: 'center', lineBreak: false }); cx += cols[i]; });
    doc.y = ry + 13 * vs;
    totalQty    += Number(l.qty) || 0;
    totalGross  += Number(l.gross_weight) || 0;
    totalBags   += Number(l.bags) || 0;
    totalSample += Number(l.sample_weight) || cfg.sampleWeight || 0;
  });

  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.5).stroke(); doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(fs(8));
  // Totals line mirrors whichever weight columns the operator kept on. Each
  // "Label: value unit" segment uses NON-BREAKING spaces ( ) so a number
  // never gets split from its unit; the slip may wrap only at the "  |  "
  // separators, keeping "Net: 100.500 kg" intact on a narrow roll.
  const seg = [sellerLots.length + ' lot(s)'];
  if (onKeys.has('bags')) seg.push(totalBags + ' ' + lb('bags','bags'));
  if (onKeys.has('net'))  seg.push(lb('net_wt','Net') + ': ' + totalQty.toFixed(3) + ' kg');
  if (onKeys.has('sample') && totalSample) seg.push(lb('sample_wt','Smp') + ': ' + totalSample.toFixed(3) + ' kg');
  if (onKeys.has('gross')  && totalGross)  seg.push(lb('gross_wt','Grs') + ': ' + totalGross.toFixed(3) + ' kg');
  doc.text(seg.join('   |   '), m, doc.y, { width: w, align: 'center' });

  doc.moveDown(0.4);
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.5).stroke(); doc.moveDown(0.2);
  if (cfg.showUser) {
    doc.font('Helvetica').fontSize(fs(8)).fillColor('#888')
       .text('Entered by: ' + (lot.user_id || ''), m, doc.y, { width: w });
    doc.moveDown(0.2);
  }
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(fs(10))
     .text('** THANK YOU **', m, doc.y, { width: w, align: 'center' });
}

// ── RENDERER (ESC/POS raw bytes, for Bluetooth thermal printers) ──
// Produces a 58mm ESC/POS receipt from the same lot data + operator column
// config as the PDF renderers, so a Bluetooth print matches the PDF slip.
// The client writes these bytes straight to the printer (Web Bluetooth) or
// hands them to the RawBT print service. `charWidth` chars per line (32 for
// a 58mm Font-A roll; 42/48 for wider rolls).
function buildEscposReceipt(lots, cfg, opts) {
  const ESC = 0x1B, GS = 0x1D;
  const WIDTH = (opts && opts.charWidth) || 32;
  const chunks = [];
  const raw  = (...b) => chunks.push(Buffer.from(b));
  const put  = (s)   => chunks.push(Buffer.from(String(s), 'latin1'));
  const nl   = ()    => raw(0x0A);
  const line = (s)   => { put(s == null ? '' : s); nl(); };
  const left   = () => raw(ESC, 0x61, 0x00);
  const center = () => raw(ESC, 0x61, 0x01);
  const boldOn = () => raw(ESC, 0x45, 0x01);
  const boldOff= () => raw(ESC, 0x45, 0x00);
  const big    = (on) => raw(GS, 0x21, on ? 0x11 : 0x00); // double W+H / normal
  const rule   = (ch) => line((ch || '-').repeat(WIDTH));
  // Left/right justified on one WIDTH-wide line (truncates the left label if
  // the pair would overflow so the right value always shows in full).
  const lr = (l, r) => {
    l = String(l == null ? '' : l); r = String(r == null ? '' : r);
    let gap = WIDTH - l.length - r.length;
    if (gap < 1) { l = l.slice(0, Math.max(0, WIDTH - r.length - 1)); gap = WIDTH - l.length - r.length; }
    return l + ' '.repeat(Math.max(1, gap)) + r;
  };

  const lot0 = lots[0] || {};
  const dateFmt = formatDateForDisplay(lot0.date, cfg.dateFormat);
  const branch = cfg.branch || lot0.branch || '';
  const fields = enabledReceiptFields(cfg);
  const onKeys = new Set(fields.map(f => f.key));

  raw(ESC, 0x40);                 // initialize
  center();
  boldOn(); big(true); line(cfg.appTitle || 'RECEIPT'); big(false);
  if (branch) line(branch + ' BRANCH');
  boldOff();
  if (cfg.companyPhone) line('Ph: ' + cfg.companyPhone);
  if (cfg.companyGstin) line('GSTIN: ' + cfg.companyGstin);
  left();
  rule();
  line(lr('Auction #' + (lot0.ano || ''), 'Date: ' + dateFmt));
  rule();
  boldOn(); line('Seller: ' + (lot0.trader_name || '')); boldOff();
  if (lot0.cr) line('GSTIN: ' + lot0.cr);
  const acct = maskAcctForReceipt(lot0.acctnum, cfg.acctMask);
  if (acct) line('A/C: ' + acct);
  if (lot0.ifsc) line('IFSC: ' + lot0.ifsc);
  rule();

  let totalQty = 0, totalGross = 0, totalBags = 0, totalSample = 0;
  lots.forEach(l => {
    boldOn(); line('Lot #' + (l.lot_no != null ? l.lot_no : '')); boldOff();
    fields.forEach(f => {
      if (f.key === 'lot_no') return;
      const v = String(f.val(l, cfg));
      if (v === '') return;
      line(lr('  ' + f.hdr, v));
    });
    totalQty    += Number(l.qty) || 0;
    totalGross  += Number(l.gross_weight) || 0;
    totalBags   += Number(l.bags) || 0;
    totalSample += Number(l.sample_weight) || cfg.sampleWeight || 0;
  });
  rule();
  boldOn();
  line(lots.length + ' lot(s)');
  if (onKeys.has('bags'))                   line(lr('Total Bags', String(totalBags)));
  if (onKeys.has('net'))                    line(lr('Total Net', totalQty.toFixed(3) + ' kg'));
  if (onKeys.has('sample') && totalSample)  line(lr('Total Smp', totalSample.toFixed(3) + ' kg'));
  if (onKeys.has('gross')  && totalGross)   line(lr('Total Gross', totalGross.toFixed(3) + ' kg'));
  boldOff();
  rule();
  center(); boldOn(); line('** THANK YOU **'); boldOff(); left();
  raw(0x0A, 0x0A, 0x0A, 0x0A);    // feed clear of the tear bar
  raw(GS, 0x56, 0x00);            // full cut (ignored by cutter-less printers)
  return Buffer.concat(chunks);
}

// ── RENDERER (compact, thermal-printer / ~2.5"×3.5") ─────────────
function renderSellerReceiptCompact(doc, sellerLots, cfg) {
  // Content width + column scale follow the configured paper width (same
  // receiptPageW the document page was sized to). sc === 1 at the default
  // 180pt page, so default thermal slips are byte-for-byte unchanged; a
  // narrower 58mm roll shrinks the FONTS + row heights + columns in step so
  // the slip fits edge-to-edge without wrapping.
  const pageW = receiptPageW(true, cfg.paperWidthMm);
  const m = receiptMargin(pageW, true);
  const w = pageW - 2 * m;
  const sc = w / 160;
  const fs = (b) => Math.max(5, b * sc);        // shrink text to fit a 58mm roll
  const vs = Math.max(0.7, Math.min(1, sc));    // shrink row heights in step
  const NB = String.fromCharCode(160);          // non-breaking space
  const lot = sellerLots[0];
  const dateFmt = formatDateForDisplay(lot.date, cfg.dateFormat);
  const L = cfg.labels || {};
  const lb = (k, d) => L[k] || d;
  const headerBranch = cfg.branch || lot.branch;

  addReceiptHeaderCompact(doc, cfg.appTitle, headerBranch, dateFmt, lot.ano, pageW);

  // Lean stub — seller NAME only. Bank (A/C, IFSC), place and GSTIN are
  // intentionally dropped; those live on the detailed receipt.
  doc.font('Helvetica-Bold').fontSize(fs(7.5))
     .text(lb('seller','Seller') + ': ' + (lot.trader_name || ''), m, doc.y, { width: w });

  doc.moveDown(0.2);
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.4).stroke(); doc.moveDown(0.2);

  // Same operator-chosen columns as the full slip, width-distributed to fit.
  const fields = enabledReceiptFields(cfg);
  const onKeys = new Set(fields.map(f => f.key));
  const totW = fields.reduce((a, f) => a + f.weight, 0);
  const cols = fields.map(f => w * f.weight / totW);
  const hdrs = fields.map(f => f.hdr);

  const hdrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(fs(6.5));
  let cx = m;
  hdrs.forEach((h, i) => { doc.text(h, cx, hdrY, { width: cols[i], align: 'center', lineBreak: false, ellipsis: true }); cx += cols[i]; });
  doc.y = hdrY + 9 * vs;
  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.3).stroke(); doc.moveDown(0.15);

  doc.font('Helvetica').fontSize(fs(7));
  let totalQty = 0, totalGross = 0, totalBags = 0;
  sellerLots.forEach(l => {
    const ry = doc.y;
    cx = m;
    // lineBreak:false → a value never wraps to a second line and breaks the row.
    fields.forEach((f, i) => { doc.text(String(f.val(l, cfg)), cx, ry, { width: cols[i], align: 'center', lineBreak: false }); cx += cols[i]; });
    doc.y = ry + 11 * vs;
    totalQty   += Number(l.qty) || 0;
    totalGross += Number(l.gross_weight) || 0;
    totalBags  += Number(l.bags) || 0;
  });

  doc.moveTo(m, doc.y).lineTo(m + w, doc.y).lineWidth(0.4).stroke(); doc.moveDown(0.2);

  // Totals — non-breaking spaces keep every number glued to its unit; the two
  // lines break only at the "  |  " separators so nothing splits awkwardly.
  const line1 = sellerLots.length + NB + 'lots' + (onKeys.has('bags') ? '   |   ' + totalBags + NB + lb('bags','bags') : '');
  const seg2 = [];
  if (onKeys.has('net'))   seg2.push(lb('net_wt','Net') + NB + totalQty.toFixed(3) + NB + 'kg');
  if (onKeys.has('gross') && totalGross) seg2.push(lb('gross_wt','Grs') + NB + totalGross.toFixed(3) + NB + 'kg');
  const line2 = seg2.join('   |   ');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(fs(8))
     .text(line1 + (line2 ? '\n' + line2 : ''), m, doc.y, { width: w, align: 'center' });
}

// Receipt page WIDTH in points. Mirrors the desktop `lot_receipt_width_mm`
// setting (Settings → Lot Entry Defaults) so the mobile PDF prints to the
// same thermal roll as the desktop slip. Blank/0 keeps the legacy widths
// (compact 180pt ≈ 63mm, full 340pt). PDFKit measures in points (72pt =
// 1in), so mm → pt is mm * 72 / 25.4. Floored at 120pt so a tiny value
// can't make an unprintable sliver of a page. The renderers derive their
// content width + column scale from this SAME helper, so the drawn layout
// always matches the page the document was sized to.
function receiptPageW(compact, paperWidthMm) {
  const mm = Number(paperWidthMm) || 0;
  if (mm > 0) return Math.max(120, Math.round(mm * 72 / 25.4));
  return compact ? 180 : 340;
}

// Side margin (points) for a receipt of the given page width. At the default
// widths this returns the legacy 10pt (compact) / 20pt (full) so existing
// slips are unchanged; on a narrow 58mm roll it shrinks proportionally so the
// content column stays wide enough that nothing wraps. Header + body both call
// this, so their left edge (and the divider rules) always line up.
function receiptMargin(pageW, compact) {
  const base = compact ? 10 : 20;
  const full = compact ? 180 : 340;
  if (pageW >= full) return base;
  return Math.max(compact ? 5 : 7, Math.round(pageW / (compact ? 22 : 18)));
}

function pickReceiptRenderer(fmt, paperWidthMm) {
  const compact = fmt === 'compact';
  const pageW = receiptPageW(compact, paperWidthMm);
  return compact
    ? { render: renderSellerReceiptCompact, pageW, pageSize: [pageW, 252], compact: true }
    : { render: renderSellerReceipt,        pageW, pageSize: [pageW, 550], compact: false };
}

// ── LOT SELECT — single helper used by every print endpoint ─────
// Spice-config has denormalised seller fields on the lots row
// (lots.name, lots.cr, lots.ppla, lots.ppin, lots.tel) so we don't
// strictly need the traders join, BUT joining gives us the freshest
// values when the seller's master record has changed since the lot was
// booked. We also pick the bank from trader_banks (per-lot bank_id pin
// > seller's default), falling back to lots.acctnum/ifsc for legacy data.
// Output columns are aliased to the names PWA's renderer expects.
const LOT_SELECT_SQL = `
  SELECT
    l.id, l.lot_no, l.branch, l.grade, l.crpt, l.bags, l.litre, l.qty,
    l.gross_wt  AS gross_weight,
    l.sample_wt AS sample_weight,
    l.moisture, l.user_id, l.trader_id,
    COALESCE(t.name, l.name, 'Unknown') AS trader_name,
    COALESCE(t.cr,   l.cr,   '') AS cr,
    COALESCE(t.ppla, l.ppla, '') AS ppla,
    COALESCE(t.pin,  l.ppin, '') AS pin,
    COALESCE(
      (SELECT tb.acctnum FROM trader_banks tb WHERE tb.id = l.bank_id),
      (SELECT tb.acctnum FROM trader_banks tb WHERE tb.trader_id = t.id ORDER BY tb.is_default DESC, tb.id LIMIT 1),
      t.acctnum, l.cr, ''
    ) AS acctnum,
    COALESCE(
      (SELECT tb.ifsc FROM trader_banks tb WHERE tb.id = l.bank_id),
      (SELECT tb.ifsc FROM trader_banks tb WHERE tb.trader_id = t.id ORDER BY tb.is_default DESC, tb.id LIMIT 1),
      t.ifsc, ''
    ) AS ifsc,
    a.ano, a.date, a.crop_type
  FROM lots l
  JOIN auctions a ON a.id = l.auction_id
  LEFT JOIN traders t ON t.id = l.trader_id
`;

function mountMobile(app, deps) {
  const { getDb, requireAuth, hash, ROLE_PERMISSIONS, onReassignRequest } = deps;

  // ── 0. LAZY SELF-HEAL SCHEMA ──────────────────────────────────────
  // The bridge owns these tables/columns — declare them here so the
  // bridge works even if db.js wasn't updated on this install. Runs on
  // the first request that needs it (NOT at mount time — initDb() hasn't
  // finished yet when mountMobile runs). Cached via a closure flag so
  // it only runs once per process. All operations idempotent.
  let _healed = false;
  function ensureBridgeSchema() {
    if (_healed) return;
    try {
      const db = getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS login_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        ip TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )`);
      // Unified seller schema — whatsapp/email must exist for the
      // mobile create/edit flow. Add if missing; harmless if already
      // there (each ALTER wrapped in its own try/catch).
      try { db.exec("ALTER TABLE traders ADD COLUMN whatsapp TEXT DEFAULT ''"); } catch (_) {}
      try { db.exec("ALTER TABLE traders ADD COLUMN email TEXT DEFAULT ''"); } catch (_) {}
      _healed = true;
    } catch (e) {
      // Not fatal — log and continue; the handler will surface the
      // underlying error if the schema really is broken.
      console.warn('[mobile-bridge] self-heal deferred:', e.message);
    }
  }
  // Express middleware: heal once before the first /api/* request.
  app.use('/api', (req, _res, next) => { ensureBridgeSchema(); next(); });

  // ── 0b. requireAuthFlex — accepts Authorization header OR ?token= ─
  // Print URLs are opened via window.open() (the only way mobile browsers
  // give us a real print dialog with a renderable PDF preview). window.open
  // can NOT set the Authorization header, so the mobile UI appends the
  // token as a query string. Spice-config's native requireAuth only reads
  // the header, so query-string tokens 401 there. This helper closes that
  // gap for the print routes ONLY — every other route stays on the strict
  // header-only requireAuth.
  function requireAuthFlex(req, res, next) {
    const hdr = (req.headers.authorization || '').replace('Bearer ', '');
    const tok = hdr || String(req.query.token || '');
    if (!tok) return res.status(401).json({ error: 'No token' });
    const db = getDb();
    const session = db.get('SELECT * FROM sessions WHERE token = ?', [tok]);
    if (!session) return res.status(403).json({ error: 'Session expired — please sign in again' });
    const user = db.get('SELECT * FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(403).json({ error: 'Unauthorized' });
    db.run(`UPDATE sessions SET last_used_at = datetime('now','localtime') WHERE token = ?`, [tok]);
    req.user = user;
    req.session = session;
    next();
  }

  // ── 1. STATIC MOUNT ──────────────────────────────────────────────
  // Serves /mobile, /mobile/app.html, /mobile/manifest.json, /mobile/icon.svg.
  // Phones will install the PWA from /mobile/ (manifest scope = /mobile/).
  const mobileDir = path.join(__dirname, 'public-mobile');
  // The explicit route MUST be registered BEFORE express.static. Otherwise
  // static() auto-redirects `/mobile` → `/mobile/` with a 301 (its built-in
  // directory-handling) before our app.get gets a chance to run.
  app.get('/mobile', (_req, res) => res.sendFile(path.join(mobileDir, 'app.html')));
  app.use('/mobile', express.static(mobileDir, { maxAge: 0 }));

  // ── 2. AUTH ALIASES ─────────────────────────────────────────────
  // PWA uses /api/auth/* paths. spice-config uses /api/login etc.
  // We wrap login/me so the response shape matches what app.html expects
  // ({user: {...}, token} rather than {token, role, username}).

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const db = getDb();
    const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || user.password_hash !== hash(password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    // Multi-device sessions — DON'T delete existing sessions. Field staff
    // can keep the desktop admin UI logged in while using the phone too.
    db.run(
      'INSERT INTO sessions (token, user_id, device_label) VALUES (?, ?, ?)',
      [token, user.id, (req.headers['user-agent'] || '').slice(0, 80)]
    );
    db.run(
      'INSERT INTO login_history (user_id, username, ip, user_agent) VALUES (?, ?, ?, ?)',
      [
        user.id,
        user.username,
        req.headers['x-forwarded-for'] || req.connection.remoteAddress || '',
        /Mobile|Android|iPhone/i.test(req.headers['user-agent'] || '') ? 'Mobile' : 'Desktop',
      ]
    );
    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        branch: user.branch || '',
      },
      token,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    if (t) getDb().run('DELETE FROM sessions WHERE token = ?', [t]);
    res.json({ success: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        branch: req.user.branch || '',
      },
    });
  });

  app.post('/api/auth/change-password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current and new password required' });
    }
    if (new_password.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }
    const db = getDb();
    const user = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.password_hash !== hash(current_password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash(new_password), user.id]);
    // Kill all OTHER sessions of this user
    db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [user.id, req.session.token]);
    res.json({ success: true });
  });

  // ── 3. CONFIG SHIM (branches / crop types / title / settings) ──
  // The PWA's app.html hits GET /api/config (no query string) on every
  // login + session start, and expects a SINGLE FLAT OBJECT with every
  // setting it cares about. Build that shape from spice-config's
  // company_settings table.
  //
  // PWA-expected fields:
  //   branches[]      ← br1..br9 (skip blanks)
  //   cropTypes[]     ← default_crop_type + sensible fallbacks
  //   title           ← trade_name
  //   sampleWeight    ← sample_weight (lot_entry category)
  //   showMoisture    ← show_moisture
  //   defaultLitre    ← default_litre
  //   editEnabled     ← edit_enabled (boolean)
  //   editTimeout     ← edit_timeout_sec
  //   labels{}        ← reserved; safe to leave empty (PWA has defaults)
  //   pageLimit, showUsername, tradeTileTitle, acctMask ← defaults
  app.get('/api/config', (req, res) => {
    const db = getDb();
    const type = String(req.query.type || '').toLowerCase();

    // Helper: read a single setting
    const get = (key, fallback = '') => {
      const r = db.get(`SELECT value FROM company_settings WHERE key = ?`, [key]);
      return r ? r.value : fallback;
    };
    const getNum  = (key, fallback = 0) => { const v = parseFloat(get(key, '')); return isNaN(v) ? fallback : v; };
    const getBool = (key, fallback = false) => {
      const v = get(key, '');
      if (v === '' || v == null) return fallback;
      return v === 'true' || v === '1';
    };

    // Branch list — keys br1..br9, blank values dropped
    const brRows = db.all(
      `SELECT key, value FROM company_settings
       WHERE category = 'branches' AND key LIKE 'br_'
       ORDER BY key`
    );
    const branches = brRows
      .filter(r => r.value && String(r.value).trim())
      .map((r, i) => ({
        id: i + 1, type: 'branch',
        value: String(r.value).trim().toUpperCase(),
        sort_order: i,
      }));

    // Crop types — synthesise from default_crop_type + fallbacks
    const defCrop = String(get('default_crop_type', '')).trim().toUpperCase();
    const cropSet = new Set();
    if (defCrop) cropSet.add(defCrop);
    ['ASP', 'VST'].forEach(c => cropSet.add(c));
    const cropTypes = Array.from(cropSet).map((v, i) => ({
      id: i + 1, type: 'crop_type', value: v, sort_order: i,
    }));

    // Single-type shorthand: PWA's original /api/config?type=branch
    // returned { items: [...] }. Preserve that for any caller that uses it.
    if (type === 'branch')    return res.json({ items: branches });
    if (type === 'crop_type') return res.json({ items: cropTypes });
    if (type === 'title')     return res.json({ items: [{ id: 1, type: 'title', value: get('trade_name', 'Spice Auction'), sort_order: 0 }] });

    // Full config object — what app.html expects from a no-arg GET.
    res.json({
      branches,
      cropTypes,
      title:           get('trade_name', 'Spice Auction'),
      editTimeout:     parseInt(get('edit_timeout_sec', '0'), 10) || 0,
      editEnabled:     getBool('edit_enabled', true),
      sampleWeight:    getNum('sample_weight', 0),
      // Per-bag empty gunny weight. > 0 switches mobile Lot Entry into
      // "Weight w/ Gunny" mode (net = weight_with_gunny − bags × this).
      defaultGunny:    getNum('default_gunny_weight', 0),
      // When true, the operator picks the Gunny Wt/Bag per lot (editable,
      // persisted across lots, stored on the lot) rather than the global
      // Default Gunny Weight above.
      userGunny:       getBool('user_gunny_weight', false),
      showMoisture:    getBool('show_moisture', false),
      // Reserved Price visibility flag. Drives the Reserved Price
      // input on the mobile Lot Entry form. (The Crop Receipt input is now
      // flag-gated too — see showCropReceipt below.)
      showReservedPrice: getBool('flag_reserved_price', false),
      // Crop Receipt No field on the mobile Lot Entry form. When on, the field
      // shows and seeds from the next number after the highest recorded crpt
      // (or cropReceiptStart when the book is empty); subsequent lots +1.
      showCropReceipt:  getBool('show_crop_receipt', false),
      cropReceiptStart: get('crop_receipt_start_no', ''),
      // Immediate Payment + Reserve-this-Lot checkboxes on the mobile Lot
      // Entry + Edit forms. OFF hides both controls; the lot columns persist.
      immediateReserve: getBool('flag_immediate_reserve', false),
      // Seller field placement on the Lot Entry form. true = below the
      // Reserve section; false (default) = at the top.
      sellerAtBottom:  getBool('lot_entry_seller_at_bottom', false),
      // Per-field visibility for the auto-calculated read-only weight fields.
      showSampleField: getBool('mobile_show_sample_field', true),
      showGrossField:  getBool('mobile_show_gross_field', true),
      // "Send via WhatsApp" action on the mobile Saved bar (shares the lot
      // receipt PDF with the seller). Gated by the same master flag the
      // desktop share buttons use.
      whatsapp:        getBool('flag_whatsapp', false),
      // Admin-designated default trade (auction id) — the mobile app
      // pre-selects + highlights it in the trade picker. null = none set.
      defaultAuctionId: (parseInt(get('default_auction_id', ''), 10) || null),
      defaultLitre:    get('default_litre', ''),
      // PWA defaults — surfaced here for completeness; not currently
      // backed by spice-config settings, so static-ish values are fine.
      pageLimit:       20,
      showUsername:    false,
      tradeTileTitle:  'Active Trade',
      acctMask:        'none',
      labels:          {},
    });
  });

  // ── 3b. NEXT CROP-RECEIPT NUMBER ────────────────────────────────
  // The mobile Lot Entry form seeds its Crop Receipt No from here.
  // Mirrors the client-side _incrementCrptStr: take the highest existing
  // crpt (compared by its numeric tail), +1, preserving any non-digit
  // prefix and the zero-pad width. When no lot has a crpt yet, fall back
  // to the configured start number (crop_receipt_start_no) as-is.
  app.get('/api/crop-receipt/next', requireAuthFlex, (req, res) => {
    const db = getDb();
    const rows = db.all("SELECT crpt FROM lots WHERE crpt IS NOT NULL AND TRIM(crpt) != ''");
    let best = null, bestNum = -1n;
    for (const r of rows) {
      const m = String(r.crpt || '').trim().match(/^(\D*?)(\d+)$/);
      if (!m) continue;
      let n; try { n = BigInt(m[2]); } catch (_) { continue; }
      if (n > bestNum) { bestNum = n; best = { prefix: m[1] || '', num: m[2] }; }
    }
    let next = '';
    if (best) {
      const inc = (BigInt(best.num) + 1n).toString();
      next = best.prefix + (inc.length >= best.num.length ? inc : inc.padStart(best.num.length, '0'));
    } else {
      const startRow = db.get("SELECT value FROM company_settings WHERE key = 'crop_receipt_start_no'");
      next = startRow && startRow.value != null ? String(startRow.value).trim() : '';
    }
    res.json({ next });
  });

  // ── 3c. NEXT SELLER USER ID ─────────────────────────────────────
  // Suggested User ID for a NEW seller: highest existing user_id (by
  // numeric tail) + 1, preserving any prefix + zero-pad width. Starts at
  // "1" when none exist. The client pre-fills this but leaves it editable,
  // and the POST/PUT handlers still enforce uniqueness.
  // Registered before the /api/traders/:id routes so ":id" can't shadow it.
  app.get('/api/traders/next-user-id', requireAuthFlex, (req, res) => {
    const db = getDb();
    const rows = db.all("SELECT user_id FROM traders WHERE user_id IS NOT NULL AND TRIM(user_id) != ''");
    let best = null, bestNum = -1n;
    for (const r of rows) {
      const m = String(r.user_id || '').trim().match(/^(\D*?)(\d+)$/);
      if (!m) continue;
      let n; try { n = BigInt(m[2]); } catch (_) { continue; }
      if (n > bestNum) { bestNum = n; best = { prefix: m[1] || '', num: m[2] }; }
    }
    let next = '1';
    if (best) {
      const inc = (BigInt(best.num) + 1n).toString();
      next = best.prefix + (inc.length >= best.num.length ? inc : inc.padStart(best.num.length, '0'));
    }
    res.json({ next });
  });

  // ── 4. AUCTIONS ENVELOPE ────────────────────────────────────────
  // PWA's app.html does `const trades = d.auctions || [];` so it expects
  // an envelope object, not the flat array spice-config returns natively.
  // Wrap the native array in {auctions: [...]} for the mobile client.
  app.get('/api/mobile/auctions', requireAuth, (_req, res) => {
    const db = getDb();
    const rows = db.all(
      `SELECT *, (SELECT COUNT(*) FROM lots WHERE auction_id=auctions.id) AS lot_count
       FROM auctions ORDER BY date DESC, ano DESC LIMIT 100`
    );
    // The admin-chosen default trade — the mobile picker pre-selects +
    // highlights it. null when none is set (or it was deleted).
    const defRow = db.get(`SELECT value FROM company_settings WHERE key = 'default_auction_id'`);
    const defaultAuctionId = defRow ? (parseInt(defRow.value, 10) || null) : null;
    res.json({ auctions: rows, defaultAuctionId });
  });

  // ── 4. STATUS ALIAS ─────────────────────────────────────────────
  // PWA's app.html pings /api/status on boot to detect "logged out vs
  // server unreachable". spice-config has /api/health; alias it.
  app.get('/api/status', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // ── 5. LOGO ALIAS ───────────────────────────────────────────────
  // PWA's app.html does `<img src="/api/logo">` to render the company
  // brand on the login screen and app bar. We have to stream actual
  // image bytes here — the earlier 302 → /api/branding pointed at a
  // JSON response, which an <img> tag cannot render (so the mobile UI
  // silently fell back to the text-only "Spice Auction" title).
  //
  // spice-config stores the configured logo at public/logo-ispl.png
  // (uploaded via Settings → Company → Logo, persisted by
  // POST /api/company-settings/logo/ispl). We prefer the ISP file
  // (matching /api/branding's logoUrl choice); if only the ASP variant
  // is uploaded we fall back to that. 404 when neither exists so the
  // client hides the <img> elements gracefully.
  app.get('/api/logo', (req, res) => {
    const candidates = [
      path.join(__dirname, 'public', 'logo-ispl.png'),
      path.join(__dirname, 'public', 'logo-asp.png'),
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        // Short cache — the client already cache-busts with ?t=<ms>
        // (see loadAppLogo in public-mobile/app.html), so the max-age
        // only protects against accidental re-fetches in the same
        // session.
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Type', 'image/png');
        return res.sendFile(file);
      }
    }
    res.status(404).json({ error: 'No logo configured' });
  });

  // ── 6. LOTS — query-string filter form ──────────────────────────
  // PWA: GET /api/lots?auction_id=N&branch=X (returns {lots, stats}).
  // Spice-config: GET /api/lots/:auctionId  (returns flat array).
  // We add a new endpoint at the PWA path that reshapes to PWA's expected
  // {lots, stats} envelope. Spice-config's own UI keeps using the path
  // form unchanged.
  app.get('/api/lots', requireAuth, (req, res) => {
    const { auction_id, branch, user_id, seller, page, limit } = req.query;
    if (!auction_id) return res.status(400).json({ error: 'auction_id is required' });
    const db = getDb();
    let where = 'l.auction_id = ?';
    const params = [parseInt(auction_id, 10)];
    if (branch)  { where += ' AND l.branch = ?'; params.push(branch); }
    if (user_id) { where += ' AND l.user_id = ?'; params.push(user_id); }
    if (seller)  {
      // Match against fresh master data first, falling back to the
      // denormalised name on the lot row for legacy lots without a
      // trader_id back-reference.
      where += ' AND (COALESCE(t.name, l.name, "") LIKE ? COLLATE NOCASE)';
      params.push(`%${seller}%`);
    }

    const stats = db.get(
      `SELECT COUNT(*) AS lot_count,
              COALESCE(SUM(l.qty), 0)  AS total_qty,
              COALESCE(SUM(l.bags), 0) AS total_bags
       FROM lots l
       LEFT JOIN traders t ON t.id = l.trader_id
       WHERE ${where}`,
      params
    ) || { lot_count: 0, total_qty: 0, total_bags: 0 };

    // Pagination (opt-in)
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const hasLimit = limit !== undefined && limit !== '' && limit !== null;
    const pageSize = hasLimit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 0;

    let q = `SELECT l.*,
                    COALESCE(t.name, l.name, 'Unknown Trader') AS trader_name,
                    COALESCE(t.cr,   l.cr,   '') AS cr,
                    COALESCE(t.pan,  l.pan,  '') AS pan,
                    COALESCE(t.ppla, l.ppla, '') AS ppla,
                    COALESCE(t.pin,  l.ppin, '') AS pin,
                    COALESCE(t.tel,  l.tel,  '') AS tel,
                    (SELECT tb.acctnum FROM trader_banks tb
                       WHERE tb.id = l.bank_id) AS lot_bank_acctnum,
                    (SELECT tb.ifsc FROM trader_banks tb
                       WHERE tb.id = l.bank_id) AS lot_bank_ifsc,
                    (SELECT tb.acctnum FROM trader_banks tb
                       WHERE tb.trader_id = l.trader_id
                       ORDER BY tb.is_default DESC, tb.id ASC LIMIT 1) AS def_acctnum,
                    (SELECT tb.ifsc FROM trader_banks tb
                       WHERE tb.trader_id = l.trader_id
                       ORDER BY tb.is_default DESC, tb.id ASC LIMIT 1) AS def_ifsc
             FROM lots l
             LEFT JOIN traders t ON t.id = l.trader_id
             WHERE ${where}
             ORDER BY CAST(l.lot_no AS INTEGER) ASC, l.lot_no ASC`;
    const qParams = [...params];
    if (pageSize > 0) {
      q += ' LIMIT ? OFFSET ?';
      qParams.push(pageSize, (pageNum - 1) * pageSize);
    }
    const lots = db.all(q, qParams).map(r => ({
      ...r,
      // Normalize the bank columns the PWA expects:
      acctnum: r.lot_bank_acctnum || r.def_acctnum || '',
      ifsc:    r.lot_bank_ifsc    || r.def_ifsc    || '',
      // PWA reads gross_weight/sample_weight; spice-config stores gross_wt/sample_wt
      gross_weight:  r.gross_wt  || null,
      sample_weight: r.sample_wt || 0,
    }));

    const users = db.all(
      'SELECT DISTINCT user_id FROM lots WHERE auction_id = ? ORDER BY user_id',
      [parseInt(auction_id, 10)]
    );
    const branches = db.all(
      'SELECT DISTINCT branch FROM lots WHERE auction_id = ? ORDER BY branch',
      [parseInt(auction_id, 10)]
    );
    const totalPages = pageSize > 0 ? Math.ceil(stats.lot_count / pageSize) : 1;
    res.json({
      lots,
      stats: {
        lotCount:  stats.lot_count,
        totalQty:  Math.round(stats.total_qty * 1000) / 1000,
        totalBags: stats.total_bags,
      },
      pagination: { page: pageNum, totalPages, total: stats.lot_count, pageSize },
      filters: {
        users: users.map(u => u.user_id).filter(Boolean),
        branches: branches.map(b => b.branch).filter(Boolean),
      },
    });
  });

  // ── 7. LOT DETAIL (for edit modal) ─────────────────────────────
  // PWA pre-fills the edit form's gross/sample weights from this endpoint.
  app.get('/api/lots/:id/detail', requireAuth, (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const row = db.get('SELECT * FROM lots WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Lot not found' });
    res.json({
      lot: {
        ...row,
        // Field-name mapping back to PWA's expected names
        gross_weight:  row.gross_wt  || null,
        sample_weight: row.sample_wt || 0,
      },
    });
  });

  // ── 7b. LOT-REASSIGN REQUESTS (mobile operator → admin) ─────────
  // A field operator raises a request to move a lot-number range between
  // branches (e.g. they've run out of lots allocated to their branch).
  // The request lands in a pending queue; an admin approves (which runs
  // the real reassignment) or denies. These three routes are the operator
  // side: raise a request, list my requests (also the polling signal for
  // decisions), and mark a decision as seen (clears the in-app badge).
  //
  // Validation here is deliberately light — presence + no duplicate open
  // request. The authoritative range validation (range belongs to the
  // from-branch, no lots already saved) runs again at approval time in
  // server.js, so a request that goes stale is cleanly denied rather than
  // corrupting allocations.
  app.post('/api/mobile/reassign-requests', requireAuth, (req, res) => {
    const db = getDb();
    const b = req.body || {};
    const auction_id = parseInt(b.auction_id, 10);
    const from_branch = String(b.from_branch || '').trim();
    const to_branch   = String(b.to_branch || '').trim();
    const reason      = String(b.reason || '').trim();

    // Two selection forms:
    //   • lots: ["001","007","012"] — explicit, possibly-disjoint pick
    //   • start_lot / end_lot        — contiguous range
    // Either way we also stash a display range (min–max) in start/end so the
    // admin queue + operator list can render without parsing the JSON.
    let lotsArr = [];
    let start_lot = String(b.start_lot || '').trim();
    let end_lot   = String(b.end_lot || '').trim();
    if (Array.isArray(b.lots) && b.lots.length) {
      lotsArr = Array.from(new Set(b.lots.map((l) => String(l || '').trim()).filter(Boolean)));
      // Sort by (prefix, numeric tail) to derive the display range.
      const parsed = lotsArr
        .map((l) => { const m = l.match(/^([A-Za-z]*)(\d+)$/); return m ? { lot: l, prefix: m[1].toUpperCase(), num: parseInt(m[2], 10) } : null; })
        .filter(Boolean)
        .sort((a, z) => a.prefix === z.prefix ? a.num - z.num : a.prefix.localeCompare(z.prefix));
      if (!parsed.length) return res.status(400).json({ error: 'No valid lot numbers selected' });
      start_lot = parsed[0].lot;
      end_lot   = parsed[parsed.length - 1].lot;
    }

    if (!auction_id || !from_branch || !to_branch || !start_lot || !end_lot) {
      return res.status(400).json({ error: 'auction_id, from_branch, to_branch and at least one lot are all required' });
    }
    if (from_branch === to_branch) {
      return res.status(400).json({ error: 'FROM and TO branch must be different' });
    }

    const lotsJson = lotsArr.length ? JSON.stringify(lotsArr) : '';

    // Reject an identical selection already awaiting a decision (avoids the
    // admin seeing duplicate rows if the operator double-taps).
    const dup = db.get(
      `SELECT id FROM lot_reassign_requests
        WHERE auction_id = ? AND status = 'pending'
          AND from_branch = ? AND to_branch = ? AND start_lot = ? AND end_lot = ?
          AND COALESCE(lots,'') = ?`,
      [auction_id, from_branch, to_branch, start_lot, end_lot, lotsJson]
    );
    if (dup) return res.status(409).json({ error: 'A matching request is already pending admin review' });

    db.run(
      `INSERT INTO lot_reassign_requests
         (auction_id, from_branch, to_branch, start_lot, end_lot, lots, reason,
          requester_user_id, requester_username, status)
       VALUES (?,?,?,?,?,?,?,?,?,'pending')`,
      [auction_id, from_branch, to_branch, start_lot, end_lot, lotsJson, reason,
       (req.user && req.user.id) || null, (req.user && req.user.username) || '']
    );
    const row = db.get('SELECT * FROM lot_reassign_requests WHERE id = last_insert_rowid()');
    // Notify admins over WhatsApp (best-effort; no-op if not configured).
    if (typeof onReassignRequest === 'function') { try { onReassignRequest(row); } catch (_) {} }
    res.json({ success: true, request: row });
  });

  // List the current operator's own requests for an auction. Used both to
  // render the "My requests" list and as the polling signal: any row with
  // status != 'pending' and seen_at IS NULL is a decision the operator
  // hasn't acknowledged yet.
  app.get('/api/mobile/reassign-requests', requireAuth, (req, res) => {
    const db = getDb();
    const auction_id = parseInt(req.query.auction_id, 10);
    const uid = (req.user && req.user.id) || null;
    const params = [uid];
    let where = 'requester_user_id = ?';
    if (auction_id) { where += ' AND auction_id = ?'; params.push(auction_id); }
    const rows = db.all(
      `SELECT * FROM lot_reassign_requests WHERE ${where} ORDER BY created_at DESC, id DESC`,
      params
    );
    const unseen = rows.filter(r => r.status !== 'pending' && !r.seen_at).length;
    // Allocation revision marker for this auction: the latest reassign_log
    // id. It bumps on EVERY reassignment (this operator's, another
    // operator's, or a direct admin move), so any polling session can
    // detect that lot ranges changed and reload its grid — not just the
    // operator who raised the request.
    let alloc_rev = 0;
    if (auction_id) {
      try {
        const r = db.get('SELECT MAX(id) AS rev FROM reassign_log WHERE auction_id = ?', [auction_id]);
        alloc_rev = (r && r.rev) || 0;
      } catch (_) { /* reassign_log optional */ }
    }
    res.json({ requests: rows, unseen_decisions: unseen, alloc_rev });
  });

  // Mark a decided request as seen (clears the badge). Scoped to the
  // requesting operator so one operator can't clear another's badge.
  app.post('/api/mobile/reassign-requests/:id/seen', requireAuth, (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const uid = (req.user && req.user.id) || null;
    const row = db.get('SELECT * FROM lot_reassign_requests WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Request not found' });
    if (row.requester_user_id !== uid) return res.status(403).json({ error: 'Not your request' });
    db.run(`UPDATE lot_reassign_requests SET seen_at = datetime('now','localtime') WHERE id = ?`, [id]);
    res.json({ success: true });
  });

  // ── 8. TRADER QUICK-CREATE (PWA POST /api/traders) ─────────────
  // Single unified seller-create path used by BOTH apps. Mobile PWA hits
  // /api/traders directly; desktop's "Add Seller" buttons also reach here
  // (the bridge mounts before the native /api/traders POST, so the bridge
  // wins the route).
  //
  // Strong uniqueness:
  //   - GSTIN (cr) — if present, must be unique across all traders
  //   - PAN        — if present, must be unique
  //   - Phone (tel) + Name — same combo treated as a duplicate
  // These checks run BEFORE insert so neither app can race two creates
  // for the same person.
  app.post('/api/traders', requireAuth, (req, res) => {
    const t = req.body || {};
    if (!t.name || !String(t.name).trim()) {
      return res.status(400).json({ error: 'Seller name is required' });
    }
    const emailClean = (t.email || '').toString().trim();
    if (emailClean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const db = getDb();
    const nameTrim = String(t.name).trim().toUpperCase();
    const crTrim   = String(t.cr  || '').trim();
    const panTrim  = String(t.pan || '').trim().toUpperCase();
    const telTrim  = String(t.tel || '').trim();

    // Strict uniqueness — GSTIN (cr) is the strongest identifier.
    // Compare via UPPER(TRIM(...)) so legacy rows with stray whitespace
    // (common from XLSX imports) still match — a `pan = ? COLLATE NOCASE`
    // check is whitespace-blind and was letting duplicates through.
    //
    // BUT: a bare "CR." / "CR" placeholder carries NO real GSTIN — thousands
    // of agriculturist sellers share it. Deduping on it would silently return
    // an unrelated existing seller instead of creating the new one (the "seller
    // added but not found" bug). Only dedup when `cr` has an actual identifier.
    const crAlnum = crTrim.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const crIsReal = crAlnum !== '' && crAlnum !== 'CR';
    if (crIsReal) {
      const dup = db.get(
        'SELECT * FROM traders WHERE UPPER(TRIM(cr)) = UPPER(?) LIMIT 1',
        [crTrim]
      );
      if (dup) {
        dup.banks = db.all(
          'SELECT * FROM trader_banks WHERE trader_id = ? ORDER BY is_default DESC, id', [dup.id]
        );
        return res.json({ trader: dup, deduped: true, reason: 'GSTIN match' });
      }
    }
    // PAN is the next strongest. Same TRIM-tolerant comparison.
    if (panTrim) {
      const dup = db.get(
        'SELECT * FROM traders WHERE UPPER(TRIM(pan)) = UPPER(?) LIMIT 1',
        [panTrim]
      );
      if (dup) {
        dup.banks = db.all(
          'SELECT * FROM trader_banks WHERE trader_id = ? ORDER BY is_default DESC, id', [dup.id]
        );
        return res.json({ trader: dup, deduped: true, reason: 'PAN match' });
      }
    }
    // Soft dedup — same name + same phone is treated as a single person
    if (telTrim) {
      const dup = db.get('SELECT * FROM traders WHERE name = ? AND tel = ? LIMIT 1',
        [nameTrim, telTrim]);
      if (dup) {
        dup.banks = db.all(
          'SELECT * FROM trader_banks WHERE trader_id = ? ORDER BY is_default DESC, id', [dup.id]
        );
        return res.json({ trader: dup, deduped: true, reason: 'name+phone match' });
      }
    }

    // User ID must be unique across sellers (when provided). Unlike GSTIN/PAN
    // this is a hard reject, not a silent dedup — a duplicate user id is an
    // operator error, not "the same person".
    const userIdTrim = String(t.user_id || '').trim();
    if (userIdTrim) {
      const dupUid = db.get('SELECT id, name FROM traders WHERE UPPER(TRIM(user_id)) = UPPER(?) LIMIT 1', [userIdTrim]);
      if (dupUid) return res.status(409).json({ error: `User ID "${userIdTrim}" is already used by seller "${dupUid.name}"` });
    }

    const info = db.run(
      `INSERT INTO traders (name,cr,pan,tan,tel,aadhar,padd,ppla,pin,pstate,pst_code,ifsc,acctnum,holder_name,whatsapp,email,dob,user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        nameTrim,
        crTrim,
        panTrim,
        (t.tan || '').toString().trim().toUpperCase(),
        telTrim,
        (t.aadhar || '').toString().trim(),
        (t.padd || '').toString().trim(),
        (t.ppla || '').toString().trim().toUpperCase(),
        (t.pin || '').toString().trim(),
        (t.pstate || 'TAMIL NADU').toString().trim().toUpperCase(),
        (t.pst_code || '33').toString().trim(),
        '', '', '',
        (t.whatsapp || '').toString().trim(),
        emailClean,
        (t.dob || '').toString().trim(),
        (t.user_id || '').toString().trim(),
      ]
    );
    // Persist multi-bank rows when the desktop UI sends them. The flat
    // ifsc/acctnum/holder_name columns above were intentionally set to
    // empty strings — syncTraderBanks mirrors the first bank back into
    // them, keeping legacy readers happy without duplicating data.
    if (Array.isArray(t.banks)) {
      syncTraderBanks(db, info.lastInsertRowid, t.banks);
    }
    const created = db.get('SELECT * FROM traders WHERE id = ?', [info.lastInsertRowid]);
    if (created) {
      created.banks = db.all(
        'SELECT * FROM trader_banks WHERE trader_id = ? ORDER BY is_default DESC, id',
        [info.lastInsertRowid]
      );
    }
    res.status(201).json({ trader: created });
  });

  // ── 8b. TRADER UPDATE (PWA PUT /api/traders/:id) ───────────────
  // Mobile PWA hits this to update whatsapp/email/contact fields. Desktop
  // also hits the same path. Single write path = single source of truth.
  //
  // The bridge handles whatsapp + email (which spice-config's native PUT
  // doesn't know about) and delegates everything else to a full UPDATE
  // covering all editable fields. Uniqueness re-checked on cr/pan changes
  // so an edit can't introduce a duplicate either.
  app.put('/api/traders/:id', requireAuth, (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const trader = db.get('SELECT * FROM traders WHERE id = ?', [id]);
    if (!trader) return res.status(404).json({ error: 'Seller not found' });
    const t = req.body || {};
    const emailClean = t.email != null ? String(t.email).trim() : null;
    if (emailClean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    // Uniqueness re-check on cr / pan changes. UPPER(TRIM(...)) on the
    // stored side so legacy rows with stray whitespace still collide
    // — a plain `pan = ? COLLATE NOCASE` is whitespace-blind and was
    // letting duplicates through on edit.
    if (t.cr != null && String(t.cr).trim() && String(t.cr).trim() !== trader.cr) {
      const dup = db.get(
        'SELECT id FROM traders WHERE UPPER(TRIM(cr)) = UPPER(?) AND id != ?',
        [String(t.cr).trim(), id]
      );
      if (dup) return res.status(409).json({ error: 'Another seller already has this GSTIN' });
    }
    if (t.pan != null && String(t.pan).trim() && String(t.pan).trim().toUpperCase() !== trader.pan) {
      const dup = db.get(
        'SELECT id FROM traders WHERE UPPER(TRIM(pan)) = UPPER(?) AND id != ?',
        [String(t.pan).trim().toUpperCase(), id]
      );
      if (dup) return res.status(409).json({ error: 'Another seller already has this PAN' });
    }
    // User ID uniqueness (when set/changed) — exclude self.
    if (t.user_id != null && String(t.user_id).trim() && String(t.user_id).trim() !== String(trader.user_id || '').trim()) {
      const dup = db.get(
        'SELECT id, name FROM traders WHERE UPPER(TRIM(user_id)) = UPPER(?) AND id != ?',
        [String(t.user_id).trim(), id]
      );
      if (dup) return res.status(409).json({ error: `User ID "${String(t.user_id).trim()}" is already used by seller "${dup.name}"` });
    }
    // Partial update — only write fields that were sent. Mobile sends a
    // subset (just acctnum/ifsc/whatsapp/email on edit-from-banks);
    // desktop sends the full record.
    const sets = []; const vals = [];
    const setField = (col, val, transform = (v) => v) => {
      if (val !== undefined) { sets.push(col + ' = ?'); vals.push(transform(val)); }
    };
    setField('name',        t.name,        (v) => String(v).trim().toUpperCase());
    setField('cr',          t.cr,          (v) => String(v).trim());
    setField('pan',         t.pan,         (v) => String(v).trim().toUpperCase());
    setField('tan',         t.tan,         (v) => String(v).trim().toUpperCase());
    setField('tel',         t.tel,         (v) => String(v).trim());
    setField('aadhar',      t.aadhar,      (v) => String(v).trim());
    setField('padd',        t.padd,        (v) => String(v).trim());
    setField('ppla',        t.ppla,        (v) => String(v).trim().toUpperCase());
    setField('pin',         t.pin,         (v) => String(v).trim());
    setField('pstate',      t.pstate,      (v) => String(v).trim().toUpperCase());
    setField('pst_code',    t.pst_code,    (v) => String(v).trim());
    setField('ifsc',        t.ifsc,        (v) => String(v).trim().toUpperCase());
    setField('acctnum',     t.acctnum,     (v) => String(v).trim());
    setField('holder_name', t.holder_name, (v) => String(v).trim());
    setField('dob',         t.dob,         (v) => String(v).trim());
    setField('user_id',     t.user_id,     (v) => String(v).trim());
    setField('whatsapp',    t.whatsapp,    (v) => String(v).trim());
    if (emailClean !== null) { sets.push('email = ?'); vals.push(emailClean); }
    // No flat-field changes is fine — the user may have only edited
    // banks. Don't short-circuit before the banks sync below.
    if (sets.length > 0) {
      vals.push(id);
      db.run(`UPDATE traders SET ${sets.join(', ')} WHERE id = ?`, vals);
    }
    // Persist banks when the desktop UI sends them. PWA/mobile typically
    // omits the banks array (it uses /api/traders/:id/banks instead);
    // the array-check means absent payload = leave existing banks alone.
    if (Array.isArray(t.banks)) {
      syncTraderBanks(db, id, t.banks);
    }
    const updated = db.get('SELECT * FROM traders WHERE id = ?', [id]);
    updated.banks = db.all(
      'SELECT * FROM trader_banks WHERE trader_id = ? ORDER BY is_default DESC, id', [id]
    );
    res.json({ success: true, trader: updated });
  });

  // ── 8c. TRADER GET BY ID — ensures fresh fetch ──────────────────
  // Mobile uses this after edits to refresh the displayed trader. Always
  // reads from the DB (no cache); both apps see the same data.
  // :id is constrained to digits — the bridge mounts BEFORE the native
  // server.js routes, so an unconstrained `:id` here captured the literal
  // `/api/traders/template` request (id="template") and 404'd it as "Seller
  // not found", breaking the seller import template download.
  app.get('/api/traders/:id(\\d+)', requireAuth, (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const trader = db.get('SELECT * FROM traders WHERE id = ?', [id]);
    if (!trader) return res.status(404).json({ error: 'Seller not found' });
    trader.banks = db.all(
      'SELECT * FROM trader_banks WHERE trader_id = ? ORDER BY is_default DESC, id', [id]
    );
    // Explicit no-cache headers so phones with aggressive PWA caching
    // never serve stale seller data.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.json(trader);
  });

  // ── 9. TRADER LAST-LOT + BANKS (PWA helper) ────────────────────
  app.get('/api/traders/:id/last-lot', requireAuth, (req, res) => {
    const db = getDb();
    const traderId = parseInt(req.params.id, 10);
    const lot = db.get(
      `SELECT grade, litre, bags, branch
         FROM lots WHERE trader_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      [traderId]
    );
    let banks = db.all(
      `SELECT id, trader_id, bank_name, branch, acctnum, ifsc, holder_name, is_default
         FROM trader_banks WHERE trader_id = ?
         ORDER BY is_default DESC, id ASC`,
      [traderId]
    );
    // Auto-migrate: if no rows in trader_banks but the trader row has an
    // account number, copy it across so the picker has something to show.
    if (!banks.length) {
      const t = db.get('SELECT acctnum, ifsc, holder_name FROM traders WHERE id = ?', [traderId]);
      if (t && t.acctnum && String(t.acctnum).trim()) {
        db.run(
          `INSERT INTO trader_banks (trader_id, bank_name, acctnum, ifsc, holder_name, is_default)
           VALUES (?, '', ?, ?, ?, 1)`,
          [traderId, String(t.acctnum).trim(), t.ifsc || '', t.holder_name || '']
        );
        banks = db.all(
          `SELECT id, trader_id, bank_name, acctnum, ifsc, holder_name, is_default
             FROM trader_banks WHERE trader_id = ?
             ORDER BY is_default DESC, id ASC`,
          [traderId]
        );
      }
    }
    res.json({ lastLot: lot || null, banks });
  });

  // ── 10. TRADER BANK CRUD ───────────────────────────────────────
  // PWA exposes per-trader bank management. Spice-config does this through
  // a different route shape; replicate the PWA contract here.
  app.post('/api/traders/:id/banks', requireAuth, (req, res) => {
    const db = getDb();
    const traderId = parseInt(req.params.id, 10);
    const { acctnum, ifsc, label, holder_name, branch, is_default } = req.body || {};
    if (!acctnum || !String(acctnum).trim()) {
      return res.status(400).json({ error: 'Account number is required' });
    }
    const trader = db.get('SELECT id FROM traders WHERE id = ?', [traderId]);
    if (!trader) return res.status(404).json({ error: 'Trader not found' });
    if (is_default) {
      db.run('UPDATE trader_banks SET is_default = 0 WHERE trader_id = ?', [traderId]);
    }
    // Spice-config stores the user-visible bank label in `bank_name`. PWA
    // calls it `label`. Map across. `branch` (the bank branch, typically
    // auto-filled from the IFSC lookup) is stored so the lot-entry seller
    // picker can show it alongside the other bank details.
    const info = db.run(
      `INSERT INTO trader_banks (trader_id, bank_name, branch, acctnum, ifsc, holder_name, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        traderId,
        String(label || '').trim(),
        String(branch || '').trim(),
        String(acctnum).trim(),
        String(ifsc || '').trim().toUpperCase(),
        String(holder_name || '').trim(),
        is_default ? 1 : 0,
      ]
    );
    // Sync default to traders row (legacy callers read traders.acctnum/ifsc)
    if (is_default) {
      db.run(
        'UPDATE traders SET acctnum = ?, ifsc = ?, holder_name = ? WHERE id = ?',
        [String(acctnum).trim(), String(ifsc || '').trim().toUpperCase(), String(holder_name || '').trim(), traderId]
      );
    }
    res.json({ id: info.lastInsertRowid });
  });

  app.put('/api/traders/:tid/banks/:bid', requireAuth, (req, res) => {
    const db = getDb();
    const tid = parseInt(req.params.tid, 10);
    const bid = parseInt(req.params.bid, 10);
    const { acctnum, ifsc, label, holder_name, branch } = req.body || {};
    const bank = db.get(
      'SELECT * FROM trader_banks WHERE id = ? AND trader_id = ?', [bid, tid]
    );
    if (!bank) return res.status(404).json({ error: 'Bank not found' });
    db.run(
      `UPDATE trader_banks
       SET acctnum = COALESCE(?, acctnum),
           ifsc = COALESCE(?, ifsc),
           bank_name = COALESCE(?, bank_name),
           holder_name = COALESCE(?, holder_name),
           branch = COALESCE(?, branch)
       WHERE id = ?`,
      [
        acctnum != null ? String(acctnum).trim() : null,
        ifsc != null ? String(ifsc).trim().toUpperCase() : null,
        label != null ? String(label).trim() : null,
        holder_name != null ? String(holder_name).trim() : null,
        branch != null ? String(branch).trim() : null,
        bid,
      ]
    );
    res.json({ success: true });
  });

  app.delete('/api/traders/:tid/banks/:bid', requireAuth, (req, res) => {
    const db = getDb();
    const tid = parseInt(req.params.tid, 10);
    const bid = parseInt(req.params.bid, 10);
    const bank = db.get(
      'SELECT * FROM trader_banks WHERE id = ? AND trader_id = ?', [bid, tid]
    );
    if (!bank) return res.status(404).json({ error: 'Bank not found' });
    db.run('DELETE FROM trader_banks WHERE id = ?', [bid]);
    // If we deleted the default, promote the next-oldest to default
    if (bank.is_default) {
      const next = db.get(
        'SELECT id FROM trader_banks WHERE trader_id = ? ORDER BY id LIMIT 1', [tid]
      );
      if (next) db.run('UPDATE trader_banks SET is_default = 1 WHERE id = ?', [next.id]);
    }
    res.json({ success: true });
  });

  app.post('/api/traders/:tid/banks/:bid/default', requireAuth, (req, res) => {
    const db = getDb();
    const tid = parseInt(req.params.tid, 10);
    const bid = parseInt(req.params.bid, 10);
    const bank = db.get(
      'SELECT * FROM trader_banks WHERE id = ? AND trader_id = ?', [bid, tid]
    );
    if (!bank) return res.status(404).json({ error: 'Bank not found' });
    db.run('UPDATE trader_banks SET is_default = 0 WHERE trader_id = ?', [tid]);
    db.run('UPDATE trader_banks SET is_default = 1 WHERE id = ?', [bid]);
    // Sync traders row to new default
    db.run(
      `UPDATE traders SET acctnum = ?, ifsc = ?, holder_name = ? WHERE id = ?`,
      [bank.acctnum || '', bank.ifsc || '', bank.holder_name || '', tid]
    );
    res.json({ success: true });
  });

  // ── 11. LOTS — CLEAR MINE ───────────────────────────────────────
  // PWA admin button: delete all of MY lots in the current auction.
  app.post('/api/lots/clear-mine', requireAuth, (req, res) => {
    const db = getDb();
    const { auction_id } = req.body || {};
    if (!auction_id) return res.status(400).json({ error: 'auction_id required' });
    const result = db.run(
      'DELETE FROM lots WHERE auction_id = ? AND user_id = ?',
      [parseInt(auction_id, 10), req.user.username]
    );
    res.json({ success: true, deleted: result.changes });
  });

  // ── 11b. SELLER HISTORY (existing bookings panel) ───────────────
  // The lot-entry screen shows a "📒 EXISTING BOOKINGS" box once a
  // seller is selected, listing every lot already booked for that
  // seller in the current trade across ALL branches (so a field user
  // in NEDUMKANDAM sees that the same seller already has lots in
  // PAMPUPARA). PWA had /api/reports/seller-history/:traderId — port
  // it here over spice-config's schema.
  //
  // Response shape (matches PWA so app.html parses unchanged):
  //   { lots: [{ id, lot_no, branch, grade, bags, qty, created_at }],
  //     summary: { total_qty, total_bags, lot_count } }
  app.get('/api/reports/seller-history/:traderId', requireAuth, (req, res) => {
    const db = getDb();
    const traderId  = parseInt(req.params.traderId, 10);
    const auctionId = parseInt(req.query.auction_id, 10);
    if (!traderId || !auctionId) {
      // Return an empty-but-valid shape rather than 400 — the mobile UI
      // gracefully shows "None in this trade" for empty arrays and the
      // worst we'd accomplish with 400 is the same "Failed to load"
      // message that prompted this fix.
      return res.json({ lots: [], summary: { total_qty: 0, total_bags: 0, lot_count: 0 } });
    }
    const lots = db.all(
      `SELECT l.id, l.lot_no, l.branch, l.grade,
              l.bags, l.qty, l.created_at, l.user_id
         FROM lots l
        WHERE l.trader_id = ? AND l.auction_id = ?
        ORDER BY CAST(l.lot_no AS INTEGER), l.lot_no`,
      [traderId, auctionId]
    );
    const summary = lots.reduce((acc, l) => {
      acc.total_qty  += Number(l.qty)  || 0;
      acc.total_bags += Number(l.bags) || 0;
      acc.lot_count  += 1;
      return acc;
    }, { total_qty: 0, total_bags: 0, lot_count: 0 });
    // No-cache: this panel must always be fresh — bookings can be added
    // by another field user a moment ago.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.json({ lots, summary });
  });

  // ── 12. PRINT / RECEIPT ENDPOINTS (Pass 2) ──────────────────────
  // Six routes — receipt for one lot, batch by lot-id list, all lots for
  // a single seller, all lots for all sellers in an auction. Both GET and
  // POST variants for the batch/seller calls so the mobile UI can use
  // window.open() (GET) for the print dialog while desktop callers can
  // POST a JSON array of ids if they prefer.

  // (1) Single-lot receipt — printed right after a save from the mobile UI.
  app.get('/api/lots/:id/receipt', requireAuthFlex, (req, res) => {
    const db = getDb();
    const lot = db.get(LOT_SELECT_SQL + ' WHERE l.id = ?', [parseInt(req.params.id, 10)]);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    // If a branch was passed, enforce it — prevents printing a receipt
    // whose header would lie about which branch the lot lives in.
    const branch = req.query && req.query.branch;
    if (branch && lot.branch !== branch) {
      return res.status(404).json({ error: `Lot ${lot.lot_no} is not in ${branch}` });
    }

    const cfg = getReceiptConfig(db);
    if (branch) cfg.branch = branch;
    const r = pickReceiptRenderer(req.query.format, cfg.paperWidthMm);

    const doc = new PDFDocument({ size: r.pageSize, margin: r.compact ? 10 : 20 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Lot_${lot.lot_no}_Receipt.pdf"`);
    doc.pipe(res);
    r.render(doc, [lot], cfg);
    doc.end();
  });

  // (1b) Single-lot receipt as raw ESC/POS bytes — for Bluetooth thermal
  // printers (Web Bluetooth writes these straight to the printer; RawBT
  // consumes them too). ?width=32|42|48 chars per line (default 32 = 58mm).
  app.get('/api/lots/:id/receipt.escpos', requireAuthFlex, (req, res) => {
    const db = getDb();
    const lot = db.get(LOT_SELECT_SQL + ' WHERE l.id = ?', [parseInt(req.params.id, 10)]);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });
    const branch = req.query && req.query.branch;
    if (branch && lot.branch !== branch) return res.status(404).json({ error: `Lot ${lot.lot_no} is not in ${branch}` });
    const cfg = getReceiptConfig(db);
    if (branch) cfg.branch = branch;
    const charWidth = parseInt(req.query.width, 10) || 32;
    const buf = buildEscposReceipt([lot], cfg, { charWidth });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="Lot_${lot.lot_no}_Receipt.bin"`);
    res.send(buf);
  });

  // (3b) All lots for one seller, as raw ESC/POS bytes.
  app.get('/api/lots/print-seller.escpos', requireAuthFlex, (req, res) => {
    const db = getDb();
    const traderId = parseInt(req.query.trader_id, 10);
    const auctionId = parseInt(req.query.auction_id, 10);
    if (!traderId || !auctionId) return res.status(400).json({ error: 'trader_id and auction_id required' });
    const branch = (req.query && req.query.branch) || '';
    const params = [auctionId, traderId];
    let where = 'l.auction_id = ? AND l.trader_id = ?';
    if (branch) { where += ' AND l.branch = ?'; params.push(branch); }
    const lots = db.all(LOT_SELECT_SQL + ' WHERE ' + where + ' ORDER BY CAST(l.lot_no AS INTEGER), l.lot_no', params);
    if (!lots.length) return res.status(404).json({ error: branch ? `No lots for this seller in ${branch}` : 'No lots found' });
    const cfg = getReceiptConfig(db);
    if (branch) cfg.branch = branch;
    const charWidth = parseInt(req.query.width, 10) || 32;
    const buf = buildEscposReceipt(lots, cfg, { charWidth });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="Seller_${(lots[0].trader_name || 'Receipt').replace(/[^A-Za-z0-9]+/g, '_')}.bin"`);
    res.send(buf);
  });

  // Shared helper — groups arbitrary lot rows by seller, then renders
  // one receipt page per seller. Used by print-batch and print-all-sellers.
  function streamGroupedReceipts(lots, req, res, cfg, filename) {
    const r = pickReceiptRenderer(req.query.format || (req.body && req.body.format), cfg.paperWidthMm);
    const groups = {};
    for (const l of lots) {
      const key = l.trader_id || ('u_' + (l.trader_name || 'unknown'));
      (groups[key] || (groups[key] = [])).push(l);
    }
    const doc = new PDFDocument({ size: r.pageSize, margin: r.compact ? 10 : 20 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    doc.pipe(res);
    Object.values(groups).forEach((group, idx) => {
      if (idx > 0) doc.addPage();
      r.render(doc, group, cfg);
    });
    doc.end();
  }

  // (2) Batch by explicit lot-id list. Mobile passes ?ids=1,2,3 via GET
  // (window.open); desktop posts { ids: [...] } as JSON.
  function handlePrintBatch(ids, req, res) {
    const db = getDb();
    if (!ids || !ids.length) return res.status(400).json({ error: 'No lot IDs provided' });
    const branch = (req.query && req.query.branch) || (req.body && req.body.branch) || '';
    let lots = ids
      .map(id => db.get(LOT_SELECT_SQL + ' WHERE l.id = ?', [parseInt(id, 10)]))
      .filter(Boolean);
    if (branch) lots = lots.filter(l => l.branch === branch);
    if (!lots.length) {
      return res.status(404).json({ error: branch ? `No lots in ${branch}` : 'No lots found' });
    }
    const cfg = getReceiptConfig(db);
    if (branch) cfg.branch = branch;
    streamGroupedReceipts(lots, req, res, cfg, `Lots_Receipt_${lots.length}.pdf`);
  }
  app.post('/api/lots/print-batch', requireAuthFlex, (req, res) =>
    handlePrintBatch(req.body && req.body.ids, req, res));
  app.get('/api/lots/print-batch', requireAuthFlex, (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(n => n > 0);
    handlePrintBatch(ids, req, res);
  });

  // (3) All lots for one seller in one auction — "📄 All by Seller"
  function handlePrintSeller(traderId, auctionId, req, res) {
    const db = getDb();
    if (!traderId || !auctionId) {
      return res.status(400).json({ error: 'trader_id and auction_id required' });
    }
    const branch = (req.query && req.query.branch) || (req.body && req.body.branch) || '';
    const params = [parseInt(auctionId, 10), parseInt(traderId, 10)];
    let where = 'l.auction_id = ? AND l.trader_id = ?';
    if (branch) { where += ' AND l.branch = ?'; params.push(branch); }
    const lots = db.all(LOT_SELECT_SQL + ' WHERE ' + where + ' ORDER BY CAST(l.lot_no AS INTEGER), l.lot_no', params);
    if (!lots.length) {
      return res.status(404).json({
        error: branch ? `No lots for this seller in ${branch}` : 'No lots found',
      });
    }
    const cfg = getReceiptConfig(db);
    if (branch) cfg.branch = branch;
    const fmt = (req.query && req.query.format) || (req.body && req.body.format);
    const r = pickReceiptRenderer(fmt, cfg.paperWidthMm);
    // Auto-grow page for long seller histories. Width follows the configured
    // paper roll (r.pageW); only the height grows with the lot count.
    const pageSize = r.compact
      ? [r.pageW, Math.min(160 + lots.length * 12 + 60, 700)]
      : [r.pageW, Math.min(200 + lots.length * 18 + 80, 800)];
    const doc = new PDFDocument({ size: pageSize, margin: r.compact ? 10 : 20 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="Seller_${(lots[0].trader_name || 'Receipt').replace(/[^A-Za-z0-9]+/g,'_')}.pdf"`);
    doc.pipe(res);
    r.render(doc, lots, cfg);
    doc.end();
  }
  app.post('/api/lots/print-seller', requireAuthFlex, (req, res) =>
    handlePrintSeller(req.body && req.body.trader_id, req.body && req.body.auction_id, req, res));
  app.get('/api/lots/print-seller', requireAuthFlex, (req, res) =>
    handlePrintSeller(req.query.trader_id, req.query.auction_id, req, res));

  // (4) Every seller in an auction (optionally branch-scoped) — admin's
  // end-of-day bulk print.
  app.get('/api/lots/print-all-sellers/:auctionId', requireAuthFlex, (req, res) => {
    const db = getDb();
    const auctionId = parseInt(req.params.auctionId, 10);
    const branch = req.query.branch || '';
    const params = [auctionId];
    let where = 'l.auction_id = ?';
    if (branch) { where += ' AND l.branch = ?'; params.push(branch); }
    // Order by seller name first so each PDF page covers one seller in lot order.
    const lots = db.all(
      LOT_SELECT_SQL + ' WHERE ' + where +
      ' ORDER BY COALESCE(t.name, l.name), CAST(l.lot_no AS INTEGER), l.lot_no',
      params
    );
    if (!lots.length) return res.status(404).json({ error: 'No lots found' });
    const cfg = getReceiptConfig(db);
    if (branch) cfg.branch = branch;
    streamGroupedReceipts(lots, req, res, cfg, 'All_Sellers_Receipt.pdf');
  });

  console.log('[mobile-bridge] mounted /mobile + PWA-compat routes (Pass 1 + Pass 2 receipts)');
}

module.exports = { mountMobile };
