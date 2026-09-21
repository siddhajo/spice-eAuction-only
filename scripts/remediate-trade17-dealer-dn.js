// scripts/remediate-trade17-dealer-dn.js
//
// Move two sellers in ONE trade from the planter debit-note stream to the
// dealer one, without debiting their commission twice.
//
// WHY THIS EXISTS
// ---------------
// Until 2026-09-21 Lot Entry graded a seller on GSTIN **+ SBL**. A seller
// holding a GSTIN with a blank SBL was therefore stamped Grade 1, and the two
// debit-note streams — which partition on the stored `lots.grade` — sent them
// the wrong way:
//   • dealer DN  (`grade='2'`) skipped them entirely
//   • planter DN (`grade='1'`, and the LOT-WISE query carries no GSTIN filter
//     at all) billed them instead
// while the purchase invoice, which runs on the GSTIN-only rule, gave them an
// RD purchase. Trade 17 came out as 18 RD purchases against 16 dealer DNs.
//
// Lot Entry now grades on the GSTIN alone, so no NEW lot can land this way.
// This script repairs the rows already written under the old rule.
//
// WHAT IT DOES
// ------------
//   1. Verifies the planter DNs it is about to remove are EXACTLY the
//      duplicate — their total must equal the seller's Σ lots.com to the
//      paisa. If it does not, the script refuses: something other than this
//      defect is in play and a human needs to look.
//   2. Deletes those planter DNs.
//   3. Optionally renumbers the trade's remaining planter DNs so the series
//      stays gap-free (see --renumber below).
//   4. Re-stamps the sellers' lots to Grade 2.
//
// It deliberately STOPS THERE. The dealer debit notes themselves are created
// through the app's own Generate Debit Notes flow, so numbering, sale-type
// derivation, the GST split and the rounding all come from the same code path
// every other DN in the book came from — not from hand-written SQL here.
//
// SAFETY
// ------
//   • Dry run unless --apply is passed. The dry run prints the exact plan.
//   • --apply copies config.db to data/backups/ first and does the whole
//     change in ONE transaction: it either all lands or none of it does.
//   • Refuses outright if a target lot is locked, if a dealer DN already
//     exists for one of these sellers, or if any planter DN being removed has
//     a recorded WhatsApp send against it.
//
// USAGE
//   node scripts/remediate-trade17-dealer-dn.js                  # dry run
//   node scripts/remediate-trade17-dealer-dn.js --apply
//   node scripts/remediate-trade17-dealer-dn.js --apply --renumber
//
//   --renumber  After deleting, close the holes: renumber the trade's
//               remaining planter DNs so the series runs unbroken again.
//               The planter DN series is CONTINUOUS ACROSS TRADES (trade 16
//               ends 2338, trade 17 runs 2339-2566 with no gaps), so deleting
//               mid-series otherwise leaves permanent holes in a statutory
//               document series. Only safe while none of the affected notes
//               have been issued — the script checks the send log and refuses
//               to renumber a note that has been sent.
//   --ano N     Trade number (default 17).
//   --seller S  Repeatable. Defaults to the two sellers found in trade 17.

const path = require('path');
const fs = require('fs');
process.chdir(path.dirname(__dirname));   // run from project root

const { initDb, getDb, DB_PATH } = require('../db');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY    = has('--apply');
const RENUMBER = has('--renumber');
const valOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ANO = String(valOf('--ano', '17')).trim();
const SELLERS = argv.reduce((acc, a, i) => {
  if (a === '--seller' && argv[i + 1]) acc.push(argv[i + 1].toUpperCase());
  return acc;
}, []);

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const die = (msg) => { console.error('\n  REFUSED — ' + msg + '\n'); process.exit(1); };

// Has a planter debit note been sent to the seller?
//
// whatsapp_messages.ref_type/ref_id exist but NOTHING populates them — every
// row in the live log carries ref_type ''. So the structured columns are
// checked (in case a future sender starts filling them) AND the caption is
// matched, which the sender does write: "your DEBIT NOTE 2408 for ₹… is
// attached." The note number alone is ambiguous across trades and across the
// dealer/planter series, so a hit here is treated as "look at this", not as
// proof — it makes the script refuse rather than proceed quietly.
function sendsFor(db, rows) {
  if (!rows.length) return [];
  const byRef = db.all(
    `SELECT ref_id AS id FROM whatsapp_messages
      WHERE ref_type IN ('debit-note-planter','debit_notes_planter')
        AND ref_id IN (${rows.map(() => '?').join(',')})`,
    rows.map(r => r.id)
  ).map(r => r.id);
  const capHits = db.all(
    `SELECT caption, created_at FROM whatsapp_messages
      WHERE UPPER(COALESCE(caption,'')) LIKE '%DEBIT NOTE%'`
  ).filter(m => rows.some(r => new RegExp('DEBIT NOTE\\s+' + String(r.note_no) + '\\b', 'i').test(m.caption || '')));
  return [
    ...rows.filter(r => byRef.includes(r.id)).map(r => `note ${r.note_no} (ref_id)`),
    ...capHits.map(m => `${m.caption} [${m.created_at}]`),
  ];
}

(async () => {
  await initDb();
  const db = getDb();

  const auction = db.get('SELECT id, ano, date FROM auctions WHERE TRIM(ano) = TRIM(?)', [ANO]);
  if (!auction) die(`no trade #${ANO} in this database`);

  // ── Who needs repairing ───────────────────────────────────────────
  // A seller in this trade who holds a GSTIN, whose lots are still stamped
  // Grade 1, and who carries planter DNs. That is the fingerprint of the old
  // rule; naming sellers with --seller just narrows it further.
  const { hasValidGstinSql } = require('../calculations');
  let targets = db.all(
    `SELECT l.name,
            COUNT(*)                          AS lots,
            SUM(COALESCE(l.com,0))            AS com,
            MAX(l.cr)                         AS cr,
            TRIM(COALESCE(MAX(l.aadhar),''))  AS sbl
       FROM lots l
      WHERE l.auction_id = ?
        AND ${hasValidGstinSql('l.cr')}
        AND TRIM(COALESCE(l.grade,'')) <> '2'
      GROUP BY l.name
      ORDER BY l.name`,
    [auction.id]
  );
  if (SELLERS.length) targets = targets.filter(t => SELLERS.includes(String(t.name).toUpperCase()));
  if (!targets.length) {
    console.log(`\n  Nothing to do — every GSTIN seller in trade #${ANO} is already Grade 2.\n`);
    process.exit(0);
  }

  console.log(`\n  Trade #${auction.ano}  (auction id ${auction.id}, ${auction.date})`);
  console.log(`  Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}${RENUMBER ? ' + renumber planter series' : ''}\n`);

  const plan = [];
  for (const t of targets) {
    const dns = db.all(
      `SELECT id, note_no, lot_no, amount, total FROM debit_notes_planter
        WHERE TRIM(ano) = TRIM(?) AND UPPER(TRIM(name)) = UPPER(TRIM(?))
        ORDER BY CAST(note_no AS INTEGER)`,
      [ANO, t.name]
    );
    const dnTotal = dns.reduce((s, d) => s + Number(d.amount || 0), 0);
    const com = Number(t.com || 0);

    // The whole premise: these planter DNs bill the SAME commission the dealer
    // DN is about to bill. Compared in paise so float noise cannot pass.
    const same = Math.round(dnTotal * 100) === Math.round(com * 100);

    const existingDealerDn = db.get(
      `SELECT note_no FROM debit_notes WHERE TRIM(ano) = TRIM(?) AND UPPER(TRIM(name)) = UPPER(TRIM(?))`,
      [ANO, t.name]
    );
    const lockedLots = db.get(
      `SELECT COUNT(*) AS c FROM lots
        WHERE auction_id = ? AND UPPER(TRIM(name)) = UPPER(TRIM(?)) AND locked_at IS NOT NULL`,
      [auction.id, t.name]
    ).c;

    console.log(`  ${t.name}`);
    console.log(`    GSTIN ${t.cr}   SBL ${t.sbl || '(blank)'}`);
    console.log(`    ${t.lots} lot(s), commission ${money(com)}`);
    console.log(`    ${dns.length} planter DN(s) totalling ${money(dnTotal)}  ${same ? '= commission ✓' : '≠ commission ✗'}`);
    if (dns.length) console.log(`    note nos: ${dns.map(d => d.note_no).join(', ')}`);

    if (!same) die(`${t.name}: the planter DNs total ${money(dnTotal)} but the commission is ${money(com)}. ` +
                   `These are not a straight duplicate — resolve by hand.`);
    if (existingDealerDn) die(`${t.name}: dealer DN #${existingDealerDn.note_no} already exists in trade #${ANO}. ` +
                              `Removing the planter DNs now would leave the commission billed once, not twice — ` +
                              `check the books before continuing.`);
    if (lockedLots) die(`${t.name}: ${lockedLots} lot(s) are locked. Unlock them (admin) and re-run.`);

    const sent = sendsFor(db, dns);
    if (sent.length) die(`${t.name}: the send log has ${sent.length} entr(y/ies) that look like these ` +
                         `planter DNs —\n      ${sent.join('\n      ')}\n    Deleting an issued document ` +
                         `is not something this script will do.`);

    plan.push({ ...t, dns, com });
    console.log('');
  }

  const allDnIds  = plan.flatMap(p => p.dns.map(d => d.id));
  const totalCom  = plan.reduce((s, p) => s + p.com, 0);
  const totalLots = plan.reduce((s, p) => s + p.lots, 0);

  // ── Planter series integrity ──────────────────────────────────────
  const series = db.all(
    `SELECT id, note_no FROM debit_notes_planter WHERE TRIM(ano) = TRIM(?)
      ORDER BY CAST(note_no AS INTEGER)`, [ANO]);
  const lo = Math.min(...series.map(r => parseInt(r.note_no, 10)));
  const hi = Math.max(...series.map(r => parseInt(r.note_no, 10)));
  const wasContiguous = (hi - lo + 1) === series.length;
  let renumbering = [];
  if (RENUMBER) {
    const keep = series.filter(r => !allDnIds.includes(r.id));
    renumbering = keep
      .map((r, i) => ({ id: r.id, from: String(r.note_no), to: String(lo + i) }))
      .filter(r => r.from !== r.to);
    const sentKeep = sendsFor(db, keep);
    if (sentKeep.length) die(`${sentKeep.length} planter DN(s) in trade #${ANO} look already sent — renumbering ` +
                             `would change the number on a document the seller is holding —\n      ` +
                             `${sentKeep.join('\n      ')}\n    Re-run without --renumber.`);
  }

  console.log('  ── PLAN ' + '─'.repeat(52));
  console.log(`  1. delete ${allDnIds.length} planter debit note(s) — ${money(totalCom)} of commission`);
  if (RENUMBER) {
    console.log(`  2. renumber ${renumbering.length} remaining planter DN(s) to close the series`);
    console.log(`     trade #${ANO} planter series: ${lo}-${hi} (${series.length} notes, ` +
                `${wasContiguous ? 'contiguous' : 'ALREADY has gaps'})`);
    console.log(`     after: ${lo}-${lo + series.length - allDnIds.length - 1}`);
  } else {
    console.log(`  2. leave the planter series as-is — this WILL leave ${allDnIds.length} hole(s) in ` +
                `${lo}-${hi}${wasContiguous ? ', which is contiguous today' : ''}`);
  }
  console.log(`  3. set grade = '2' on ${totalLots} lot(s)`);
  console.log(`  4. NOT DONE HERE: generate the dealer debit notes.`);
  const nextDn = db.get(`SELECT MAX(CAST(note_no AS INTEGER)) AS mx FROM debit_notes WHERE TRIM(ano) = TRIM(?)`, [ANO]);
  const startAt = (parseInt(nextDn && nextDn.mx, 10) || 0) + 1;
  console.log(`     Open Debit Notes → trade #${ANO} → Generate; it will offer ${plan.length} ` +
              `seller(s) starting at #${startAt}.`);
  console.log('  ' + '─'.repeat(59) + '\n');

  if (!APPLY) {
    console.log('  Dry run — nothing written. Re-run with --apply to commit.\n');
    process.exit(0);
  }

  // ── Apply ─────────────────────────────────────────────────────────
  const backupDir = path.join(path.dirname(DB_PATH), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupDir, `pre-remediate-trade${ANO}-${stamp}.db`);
  fs.copyFileSync(DB_PATH, backup);
  console.log(`  backup → ${backup}`);

  db.run('BEGIN');
  try {
    db.run(`DELETE FROM debit_notes_planter WHERE id IN (${allDnIds.map(() => '?').join(',')})`, allDnIds);
    // Renumber via a temporary negative number first: the target numbers
    // overlap the ones still in use, so a straight UPDATE would collide with
    // rows not yet moved.
    for (const r of renumbering) db.run('UPDATE debit_notes_planter SET note_no = ? WHERE id = ?', ['-' + r.to, r.id]);
    for (const r of renumbering) db.run('UPDATE debit_notes_planter SET note_no = ? WHERE id = ?', [r.to, r.id]);
    for (const p of plan) {
      db.run(
        `UPDATE lots SET grade = '2' WHERE auction_id = ? AND UPPER(TRIM(name)) = UPPER(TRIM(?))`,
        [auction.id, p.name]
      );
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    console.error('\n  FAILED, rolled back:', e.message);
    console.error(`  The database is untouched. A copy of it is also at ${backup}\n`);
    process.exit(1);
  }

  console.log(`  done — ${allDnIds.length} planter DN(s) removed, ` +
              `${renumbering.length} renumbered, ${totalLots} lot(s) re-graded.`);
  console.log(`\n  NEXT: Debit Notes → trade #${ANO} → Generate (starts at #${startAt}).\n`);
})();
