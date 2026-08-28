/*
 * trader-lot-sync.js — push a corrected seller master record onto their lots.
 *
 * `lots` denormalises the seller: name / cr / pan / tel / address are copied
 * onto the lot row at entry time so exports, invoices and the Spice-Board CSV
 * can be built from one table. That copy goes stale the moment somebody fixes
 * the seller in the Sellers master — which is exactly what the Validate-Lots
 * "click the seller and correct them" flow does. Every trader-update path
 * calls this so master and lots stay in step.
 *
 * Rows that already back a printed document are deliberately left alone:
 *   - invoiced lots (`invo` set) must keep the seller details the invoice was
 *     actually raised with, or the reprint stops matching the original;
 *   - locked lots are admin-protected by definition.
 * Both are counted and returned so the caller can tell the operator what was
 * skipped instead of silently under-updating.
 */

// traders column → lots column. The two tables disagree on exactly one name
// (traders.pin ↔ lots.ppin); everything else is a straight copy.
const FIELD_MAP = [
  ['name',     'name'],
  ['cr',       'cr'],
  ['pan',      'pan'],
  ['tel',      'tel'],
  ['aadhar',   'aadhar'],
  ['padd',     'padd'],
  ['ppla',     'ppla'],
  ['pin',      'ppin'],
  ['pstate',   'pstate'],
  ['pst_code', 'pst_code'],
];

// Lots we never rewrite. Kept as one expression so the count query and the
// UPDATE can't drift apart.
const FROZEN = `(COALESCE(invo,'') <> '' OR locked_at IS NOT NULL)`;

/**
 * Re-stamp every editable lot belonging to `traderId` from the traders row.
 * Returns { updated, skipped } — skipped = invoiced/locked lots left as-is.
 * Never throws: a propagation failure must not fail the seller save itself.
 */
function syncLotsFromTrader(db, traderId) {
  const id = Number(traderId);
  if (!db || !Number.isFinite(id)) return { updated: 0, skipped: 0 };
  try {
    const t = db.get('SELECT * FROM traders WHERE id = ?', [id]);
    if (!t) return { updated: 0, skipped: 0 };

    const frozenRow = db.get(
      `SELECT COUNT(*) AS n FROM lots WHERE trader_id = ? AND ${FROZEN}`, [id]
    );

    // Values are stringified before binding — sql.js binds a JS number into a
    // TEXT column as a REAL, which would store a PIN of 685553 as "685553.0".
    const sets = FIELD_MAP.map(([, lotCol]) => `${lotCol} = ?`).join(', ');
    const vals = FIELD_MAP.map(([tCol]) => (t[tCol] == null ? '' : String(t[tCol])));
    const info = db.run(
      `UPDATE lots SET ${sets} WHERE trader_id = ? AND NOT ${FROZEN}`,
      [...vals, id]
    );

    return {
      updated: Number(info && info.changes) || 0,
      skipped: Number(frozenRow && frozenRow.n) || 0,
    };
  } catch (e) {
    console.error('syncLotsFromTrader failed for trader', id, e);
    return { updated: 0, skipped: 0, error: e.message };
  }
}

/*
 * Persist a seller's bank accounts, KEEPING each account's trader_banks id.
 *
 * This used to live as two near-identical copies (server.js + mobile-bridge.js)
 * whose comments each record a bug caused by the pair drifting apart — one copy
 * forgot `account_type`, the other forgot `branch`, and each wiped the other's
 * column on the next save. One implementation, called from both.
 *
 * The ids matter. `lots.bank_id` pins a lot to the account it should be paid
 * into, and the old implementation deleted every one of a seller's rows and
 * re-inserted them on each save. trader_banks is AUTOINCREMENT, so the rebuilt
 * rows came back with NEW ids and every existing pin was silently orphaned —
 * 35 lots in this install point at bank rows that no longer exist. Matching
 * incoming accounts to the rows already on file keeps the ids stable, so a pin
 * survives an unrelated edit to the seller's name or address.
 *
 * Accounts are matched on (acctnum, ifsc) — what actually identifies a bank
 * account. Anything else about the row (bank name, branch, holder, type) is
 * editable detail and gets updated in place. Duplicate entries are queued so
 * two rows holding the same account each keep their own id rather than
 * collapsing onto one.
 *
 * Also mirrors the DEFAULT account back into traders.ifsc/acctnum/holder_name
 * so legacy single-bank code paths (older exports, invoice generators) still
 * see a primary account.
 */
function syncTraderBanks(db, traderId, banks) {
  const arr = Array.isArray(banks) ? banks.filter(b => b && (b.acctnum || b.ifsc)) : [];
  const bankKey = b => `${String(b.acctnum || '').trim()}|${String(b.ifsc || '').trim().toUpperCase()}`;

  // Which account was default BEFORE this save? A save from a client that
  // doesn't send the flag (the mobile app, an older desktop build) would
  // otherwise demote the operator's choice back to whichever account happens
  // to be first — and is_default decides which account actually gets paid
  // (calculations.js getBankPaymentData, and every `ORDER BY is_default DESC`
  // reader).
  const prev = db.get(
    'SELECT acctnum, ifsc FROM trader_banks WHERE trader_id = ? AND is_default = 1 LIMIT 1', [traderId]);
  const prevKey = prev ? bankKey(prev) : '';

  // Rows already on file, queued per account so each incoming entry claims at
  // most one. Whatever is left unclaimed is an account the operator removed.
  const unclaimed = new Map();
  for (const row of db.all(
    'SELECT id, acctnum, ifsc FROM trader_banks WHERE trader_id = ? ORDER BY id', [traderId]) || []) {
    const k = bankKey(row);
    if (!unclaimed.has(k)) unclaimed.set(k, []);
    unclaimed.get(k).push(row.id);
  }

  const rowIds = [];
  for (const b of arr) {
    const queue = unclaimed.get(bankKey(b));
    const existingId = (queue && queue.length) ? queue.shift() : null;
    if (existingId != null) {
      // Same account, same id — every lot pinned to it stays pinned to it.
      db.run(
        `UPDATE trader_banks
            SET bank_name = ?, branch = ?, acctnum = ?, ifsc = ?, holder_name = ?, account_type = ?
          WHERE id = ?`,
        [b.bank_name || '', b.branch || '', String(b.acctnum || ''), String(b.ifsc || ''),
         b.holder_name || '', b.account_type || '', existingId]
      );
      rowIds.push(existingId);
    } else {
      const info = db.run(
        'INSERT INTO trader_banks (trader_id, bank_name, branch, acctnum, ifsc, holder_name, account_type) VALUES (?,?,?,?,?,?,?)',
        [traderId, b.bank_name || '', b.branch || '', String(b.acctnum || ''), String(b.ifsc || ''),
         b.holder_name || '', b.account_type || '']
      );
      rowIds.push(info ? info.lastInsertRowid : null);
    }
  }

  // Accounts the operator actually removed. Lots still pinned to one are left
  // alone: the pin is now unresolvable, and every reader treats an
  // unresolvable pin as "no pin", falling back to the seller's default.
  const dropped = [];
  for (const ids of unclaimed.values()) dropped.push(...ids);
  if (dropped.length) {
    db.run(`DELETE FROM trader_banks WHERE id IN (${dropped.map(() => '?').join(',')})`, dropped);
  }

  // Land on exactly one default, in priority order: the row the client
  // flagged, else whichever surviving row still matches the previous default,
  // else the first. A trader holding banks but no default leaves every
  // `ORDER BY is_default DESC` reader picking an arbitrary account.
  let defIdx = arr.findIndex(b => Number(b.is_default) === 1);
  if (defIdx < 0 && prevKey) defIdx = arr.findIndex(b => bankKey(b) === prevKey);
  if (defIdx < 0 && arr.length) defIdx = 0;
  if (defIdx >= 0 && rowIds[defIdx] != null) {
    db.run('UPDATE trader_banks SET is_default = 0 WHERE trader_id = ?', [traderId]);
    db.run('UPDATE trader_banks SET is_default = 1 WHERE id = ?', [rowIds[defIdx]]);
  }

  // Mirror the DEFAULT bank — not merely the first — into the legacy
  // traders.ifsc/acctnum/holder_name columns that older exports still read.
  // This is what the set-default endpoints already do, so both ways of
  // choosing a default leave the trader row in the same state.
  const primary = (defIdx >= 0 ? arr[defIdx] : null) || {};
  db.run(
    'UPDATE traders SET ifsc=?, acctnum=?, holder_name=? WHERE id=?',
    [primary.ifsc || '', primary.acctnum || '', primary.holder_name || '', traderId]
  );
}

module.exports = { syncLotsFromTrader, syncTraderBanks };
