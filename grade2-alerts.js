// ── grade2-alerts.js ───────────────────────────────────────────────
// Soft-alert engine for grade-2 booking concentration.
//
// Business rule (configured in Settings → Booking Alerts):
//   • As lots are booked into an auction, watch grade-2's share of the
//     TOTAL weight booked so far (grade-2 kg ÷ total kg).
//   • When that share crosses `grade2_alert_threshold_pct`, send a soft
//     alert to the DEPOT MANAGER (in-app + WhatsApp [+ email if wired]).
//   • If grade-2 booking then PROCEEDS FURTHER (more grade-2 weight is
//     booked while still over the limit), ESCALATE to the IMMEDIATE
//     SUPERIOR.
//   • Each level fires at most once per auction.
//
// "Grade-2 lot" = a lot whose `grade` column trims to '2' (the lot-entry
// UI auto-assigns '2' for GSTIN sellers; '1' otherwise). Weight = lots.qty
// in kilograms.
//
// State lives entirely in the `grade2_alerts` table (see db.js) — no
// in-memory state — so it survives restarts and works across processes:
//   no 'manager' row for the auction  → manager alert may fire
//   'manager' row present, grade-2 grew, no 'superior' row → escalate
//
// evaluate() is SYNCHRONOUS for the DB write (so the booking response can
// carry the just-fired alert immediately) and dispatches WhatsApp/email
// fire-and-forget (so a slow Meta API call never blocks lot entry).

const { getSettingBool, getSettingNum, getSetting } = require('./company-config');

// kg → "12,345 kg (12.35 MT)" for human-readable alert bodies.
function fmtWeight(kg) {
  const n = Number(kg) || 0;
  const kgStr = n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const mt = (n / 1000).toFixed(2);
  return `${kgStr} kg (${mt} MT)`;
}

// Aggregate the auction's booked weight, split out grade-2.
function _summarise(db, auctionId) {
  const r = db.get(
    `SELECT COUNT(*) AS lot_count,
            COALESCE(SUM(qty), 0) AS total_weight,
            COALESCE(SUM(CASE WHEN TRIM(grade) = '2' THEN qty ELSE 0 END), 0) AS grade2_weight
       FROM lots
      WHERE auction_id = ?`,
    [auctionId]
  ) || {};
  return {
    lotCount:     Number(r.lot_count)     || 0,
    totalWeight:  Number(r.total_weight)  || 0,
    grade2Weight: Number(r.grade2_weight) || 0,
  };
}

function _existingAlert(db, auctionId, level) {
  return db.get(
    'SELECT * FROM grade2_alerts WHERE auction_id = ? AND level = ? ORDER BY id DESC LIMIT 1',
    [auctionId, level]
  );
}

// Compose the WhatsApp/in-app message body for a fired alert.
function _composeMessage(level, ctx) {
  const pct = (ctx.ratio * 100).toFixed(1);
  const thr = (ctx.threshold * 100).toFixed(0);
  const trade = ctx.ano ? `Trade ${ctx.ano}` : `Auction #${ctx.auctionId}`;
  if (level === 'manager') {
    return `🚨 Grade-2 booking alert — ${trade}: grade-2 is now ${pct}% of booked weight ` +
           `(${fmtWeight(ctx.grade2Weight)} of ${fmtWeight(ctx.totalWeight)} across ${ctx.lotCount} lots), ` +
           `over the ${thr}% limit. Please review.`;
  }
  return `🚨 ESCALATION — ${trade}: grade-2 booking has CONTINUED past the ${thr}% limit ` +
         `despite the depot-manager alert. Now ${pct}% ` +
         `(${fmtWeight(ctx.grade2Weight)} of ${fmtWeight(ctx.totalWeight)}, ${ctx.lotCount} lots). ` +
         `Immediate review needed.`;
}

// Fire one alert level: persist the row (sync) then dispatch external
// channels (async, best-effort). Returns the inserted row.
function _fire(db, level, ctx, deps) {
  const message = _composeMessage(level, ctx);
  const recipient = level === 'manager'
    ? { name: getSetting(db, 'grade2_manager_name'),  whatsapp: getSetting(db, 'grade2_manager_whatsapp'),  email: getSetting(db, 'grade2_manager_email') }
    : { name: getSetting(db, 'grade2_superior_name'), whatsapp: getSetting(db, 'grade2_superior_whatsapp'), email: getSetting(db, 'grade2_superior_email') };

  // Channel statuses start as 'pending'/'skipped'; async dispatch updates them.
  const channels = {
    inapp:    'shown',
    whatsapp: recipient.whatsapp ? 'pending' : 'skipped',
    email:    recipient.email    ? 'pending' : 'skipped',
  };

  const info = db.run(
    `INSERT INTO grade2_alerts
       (auction_id, level, grade2_weight, total_weight, ratio, threshold, lot_count, message, channels)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [ctx.auctionId, level, ctx.grade2Weight, ctx.totalWeight, ctx.ratio, ctx.threshold,
     ctx.lotCount, message, JSON.stringify(channels)]
  );
  const alertId = info.lastInsertRowid;

  // Audit trail (best-effort).
  if (typeof deps.audit === 'function') {
    try { deps.audit('grade2_alert', alertId, { level, ratio: ctx.ratio, threshold: ctx.threshold, recipient: recipient.name || '' }); } catch (_) {}
  }

  // External dispatch — fire and forget. Update `channels` as each resolves.
  const updateChannel = (key, status) => {
    try {
      const row = db.get('SELECT channels FROM grade2_alerts WHERE id = ?', [alertId]);
      const c = row && row.channels ? JSON.parse(row.channels) : channels;
      c[key] = status;
      db.run('UPDATE grade2_alerts SET channels = ? WHERE id = ?', [JSON.stringify(c), alertId]);
    } catch (_) { /* never break dispatch on a logging hiccup */ }
  };

  if (recipient.whatsapp && typeof deps.sendWhatsApp === 'function') {
    Promise.resolve(deps.sendWhatsApp(recipient.whatsapp, message, { ref_type: 'grade2_alert', ref_id: alertId }))
      .then((res) => updateChannel('whatsapp', res && res.ok ? 'sent' : ('failed: ' + ((res && res.error) || 'unknown'))))
      .catch((e) => updateChannel('whatsapp', 'failed: ' + (e && e.message || e)));
  }
  if (recipient.email && typeof deps.sendEmail === 'function') {
    const subject = level === 'manager' ? 'Grade-2 booking alert' : 'Grade-2 booking — ESCALATION';
    Promise.resolve(deps.sendEmail(recipient.email, subject, message))
      .then((res) => updateChannel('email', res && res.skipped ? 'skipped: ' + (res.reason || 'not configured') : (res && res.ok ? 'sent' : ('failed: ' + ((res && res.error) || 'unknown')))))
      .catch((e) => updateChannel('email', 'failed: ' + (e && e.message || e)));
  }

  return db.get('SELECT * FROM grade2_alerts WHERE id = ?', [alertId]);
}

// Main entry point. Call after any lot create/edit. Returns the alert row
// that just fired (so the caller can echo it in the API response), or null
// if nothing fired. Never throws — wrap-free for callers, but callers should
// still guard since it touches the DB.
//
//   deps = {
//     sendWhatsApp(phone, message, ref) -> Promise<{ ok, id?, error? }>,
//     sendEmail(to, subject, body)      -> Promise<{ ok?, skipped?, reason?, error? }>,
//     audit(action, entityId, details)  -> void   (optional)
//   }
function evaluate(db, auctionId, deps = {}) {
  if (!auctionId) return null;
  if (!getSettingBool(db, 'grade2_alert_enabled')) return null;

  const thresholdPct = getSettingNum(db, 'grade2_alert_threshold_pct');
  const threshold = (thresholdPct > 0 ? thresholdPct : 25) / 100;
  const minLots = Math.max(0, getSettingNum(db, 'grade2_alert_min_lots'));

  const s = _summarise(db, auctionId);
  if (s.totalWeight <= 0) return null;            // nothing booked yet
  if (s.lotCount < minLots) return null;          // noise guard

  const ratio = s.grade2Weight / s.totalWeight;

  const auction = db.get('SELECT ano FROM auctions WHERE id = ?', [auctionId]);
  const ctx = {
    auctionId,
    ano: auction ? auction.ano : '',
    grade2Weight: s.grade2Weight,
    totalWeight: s.totalWeight,
    lotCount: s.lotCount,
    ratio,
    threshold,
  };

  const managerAlert  = _existingAlert(db, auctionId, 'manager');
  const superiorAlert = _existingAlert(db, auctionId, 'superior');

  // Over the limit?
  if (ratio < threshold) return null;

  // First crossing → alert the depot manager.
  if (!managerAlert) {
    return _fire(db, 'manager', ctx, deps);
  }

  // Manager already alerted. Escalate to the superior once grade-2 booking
  // has PROCEEDED FURTHER (more grade-2 weight booked since the manager
  // alert) and we're still over the limit.
  if (!superiorAlert && s.grade2Weight > Number(managerAlert.grade2_weight || 0)) {
    return _fire(db, 'superior', ctx, deps);
  }

  return null;
}

module.exports = { evaluate, fmtWeight };
