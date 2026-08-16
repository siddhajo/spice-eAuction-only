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

module.exports = { syncLotsFromTrader };
