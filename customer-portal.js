/**
 * ── CUSTOMER PORTAL ───────────────────────────────────────────────────────
 *
 * The self-service door at `/my`. A seller or a buyer signs in with their own
 * phone number and downloads the documents raised in THEIR name — nothing
 * else. Mounted from server.js the same way mobile-bridge.js is, with the
 * host injecting the handful of helpers that live in server.js.
 *
 * ── The one rule everything here exists to enforce ────────────────────────
 *
 *   A party sees a document ONLY when an `party_links` row says that
 *   document's party is reachable from the phone that is signed in.
 *
 * Nothing is derived from a name. Seller documents scope on `trader_id`
 * (present on 100% of rows in all four seller tables); sales invoices scope
 * on `invoices.buyer_id`, added and backfilled by the migration in db.js. An
 * invoice whose buyer_id the backfill could not resolve unambiguously is
 * NEVER visible here — see that migration for why that is the right failure.
 *
 * ── One phone, several parties ────────────────────────────────────────────
 *
 * A number may hold more than one party, by explicit business decision
 * (2026-11-13). Households and planter groups share a handset, and refusing
 * the second person would lock roughly half the seller base out of their own
 * paperwork. So the session authenticates a HANDSET and the portal lists
 * every party linked to it.
 *
 * The consequence is stated rather than hidden: whoever holds the phone sees
 * every party on it. Three things contain it —
 *   1. a link is a deliberate grant; nothing is visible until one exists,
 *   2. an admin can revoke any single link without touching the others, and
 *      revocation bites on the NEXT REQUEST because the party list is
 *      resolved per request rather than frozen into the session,
 *   3. every download is recorded in `party_downloads`.
 *
 * ── What is deliberately NOT shown ────────────────────────────────────────
 *
 *   • proforma drafts (`is_proforma = 1`) — not documents anyone was issued
 *   • invoices for lots on hold (`lots.invoice_hold = 1`)
 *   • anything at all while `flag_customer_portal` is off (the default)
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// ── Normalisation ─────────────────────────────────────────────────────────
// Last TEN digits, the same key whatsapp_messages.phone_key uses, so a number
// stored as "+91 98478 66703", "098478-66703" or "9847866703" is one party.
function phoneKey(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Hash-vs-hash, so a timing leak would only ever reveal how much of a HASH
// matched — useless for guessing a code. Done properly anyway: this is a
// credential check, and "the attack doesn't work here" is a worse reason to
// skip it than "it costs one line".
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

// ── In-memory throttles ───────────────────────────────────────────────────
// Deliberately in-process and not a table: these counters are worthless after
// a restart anyway (an attacker cannot force one), and writing a row per
// rejected attempt would turn a flood into disk growth on a 5 GB volume —
// which is the attack succeeding by another route. The OTP rows themselves
// are the durable record.
const RATE = new Map();   // key → { n, resetAt }
function rateHit(key, limit, windowMs) {
  const now = Date.now();
  const cur = RATE.get(key);
  if (!cur || now > cur.resetAt) { RATE.set(key, { n: 1, resetAt: now + windowMs }); return { ok: true, remaining: limit - 1 }; }
  cur.n += 1;
  if (cur.n > limit) return { ok: false, retryInSec: Math.ceil((cur.resetAt - now) / 1000) };
  return { ok: true, remaining: limit - cur.n };
}
// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RATE) if (now > v.resetAt) RATE.delete(k);
}, 10 * 60 * 1000).unref?.();

// Which document kinds each side of the trade may see.
//
// A SELLER gets the commission bill and nothing else. Their debit note is the
// GST note for the commission that the commission bill already shows as a
// deduction — putting both in front of a grower reads as being charged twice,
// which is a phone call to the office, not a service. Deliberately enforced
// in ONE place and applied to the download as well as the list: a kind that
// is not listed must not be reachable by typing its URL either, or "we don't
// show that" is decoration.
// A seller gets ONE of two documents depending on who they are: an
// agriculturist gets a commission bill, a registered dealer gets a purchase
// invoice. Both belong on their side of the portal — before `purchase` was
// here, every GSTIN-holding seller signed in to an empty screen with nothing
// saying why.
const VISIBLE_KINDS = {
  seller: ['bill', 'purchase'],
  buyer:  ['invoice'],
};

const OTP_TTL_MIN      = 10;   // how long a code stays usable
const OTP_MAX_ATTEMPTS = 5;    // wrong guesses before the code is burned
const SESSION_TTL_HRS  = 12;   // a portal sign-in lasts a working day
// How long the page makes someone wait before offering "Send again". Shorter
// than the server's 3-per-15-minutes throttle on purpose: the button should
// come back before the throttle bites, so a person who genuinely did not get
// the message is not told off for asking twice.
const RESEND_COOLDOWN_SEC = 45;

// ── Auto-enrolment ────────────────────────────────────────────────────────
//
// Called when a document is RAISED for a party. Without it the portal is a
// snapshot: the one-time seed enrols whoever held a document that day, and
// every planter onboarded afterwards silently cannot sign in — they get the
// same cheerful "code sent" as a stranger and nothing arrives, with nothing
// anywhere saying why.
//
// Raising a document for somebody IS the deliberate act that a link is meant
// to record, so this does not weaken the default-deny rule; it just stops it
// needing a human to remember.
//
// Three deliberate restrictions:
//
//   1. A HAND-MADE link ('admin' / 'claim') is never touched: an admin who
//      bound a corrected number has said something the master does not
//      know, and overwriting it would undo the correction and, on a shared
//      handset, hand the documents back to the previous holder. A link this
//      code created ITSELF follows the master instead — if the office fixes
//      a phone number, the grant moves with it and the old row is retired.
//   2. Only a clean ten-digit number. A blank or malformed `tel` is not a
//      grant to anybody.
//   3. Runs whether or not `flag_customer_portal` is on. A link grants
//      nothing by itself — every portal route 404s while the flag is off —
//      and enrolling only while it happens to be on would leave a hole for
//      every document raised before somebody flipped it.
//
// Never throws: a failure here must not fail an invoice.
function autoEnrol(db, partyKind, partyId, rawPhone, opts) {
  opts = opts || {};
  try {
    const id = Number(partyId);
    if (!Number.isFinite(id) || id <= 0) return false;
    if (partyKind !== 'seller' && partyKind !== 'buyer') return false;
    const pkey = phoneKey(rawPhone);
    if (!pkey) return false;

    const live = db.all(
      `SELECT id, phone_key, source FROM party_links
        WHERE party_kind = ? AND party_id = ? AND status = 'active'`,
      [partyKind, id]);

    // Already reachable on this number.
    if (live.some(l => String(l.phone_key) === pkey)) return false;

    // `onlyIfLinked` is for the MASTER-EDIT hook: moving an existing grant
    // to a corrected number is right, but creating one because somebody
    // typed a phone number is not — enrolment still waits for a document.
    if (opts.onlyIfLinked && !live.length) return false;

    // A HAND-MADE grant is never touched. An admin who bound a corrected
    // number, or a party who claimed one, has said something the master
    // does not know; pulling the master's value back over it would undo
    // the correction and, on a shared handset, hand the documents back to
    // whoever held the old number.
    if (live.some(l => l.source === 'admin' || l.source === 'claim')) return false;

    // What is left is a link this code created ITSELF from a master value
    // that has since changed — the office corrected the number and the
    // grant stayed on the old one. Two things were wrong at once: the party
    // could not sign in with their real number, and whoever now holds the
    // OLD number could still read their documents. The master is the
    // authority for a link this code owns, so follow it and retire the
    // stale row. Retired, not deleted: who could once see what is exactly
    // the question asked after a dispute.
    for (const l of live) {
      db.run(`UPDATE party_links
                 SET status = 'revoked', revoked_at = datetime('now','localtime'),
                     revoked_by = 'master phone changed'
               WHERE id = ?`, [l.id]);
    }

    db.run(
      `INSERT INTO party_links (party_kind, party_id, phone_key, status, source, created_by)
       VALUES (?,?,?,'active','auto','document raised')`,
      [partyKind, id, pkey]);
    return true;
  } catch (e) {
    if (!/UNIQUE/i.test((e && e.message) || '')) {
      console.warn('[portal] auto-enrol failed for %s %s: %s', partyKind, partyId, e && e.message);
    }
    return false;
  }
}

function mountPortal(app, deps) {
  const {
    getDb,
    getSettingsFlat,
    // Document renderers, injected because the helpers they need
    // (buildAgriBill's fallbacks, the line-item caches, the numbering
    // helpers) are defined in server.js and not exported. Injecting them
    // means the customer is served by the SAME code that prints the
    // office's copy — there is no second renderer here to drift from it.
    renderSalesInvoicePdf,
    renderBillOfSupplyPdf,
    // The same commission renderer over MANY bills at once — it already
    // paginates one A4 page per lot, so a period download is one call.
    renderBillOfSupplyPdfMany,
    // A registered dealer's document. See VISIBLE_KINDS.
    renderPurchaseInvoicePdf,
    // Map(bill id -> the NETT its commission bill prints). Injected rather
    // than recomputed here: a second implementation of this number is a
    // second number.
    commissionNettForBills,
    // Injected but currently unreachable: sellers are not shown their debit
    // notes (see VISIBLE_KINDS). Kept wired so re-enabling them is a one-word
    // change to that table rather than a re-plumb.
    renderDebitNotePlanterPdf,
    // Host auth. The admin surface is NOT behind the feature flag — an
    // admin has to be able to enrol people and check the audit trail
    // before the door is opened, and after it is closed again.
    requireAdmin,
  } = deps;

  const flagOn = (db) => {
    try { return String(getSettingsFlat(db).flag_customer_portal || '') === 'true'; }
    catch (_) { return false; }
  };

  // Every portal route sits behind the flag. Off ⇒ the door does not exist,
  // rather than existing and refusing: a 404 tells a scanner nothing.
  function requirePortalOn(req, res, next) {
    if (!flagOn(getDb())) return res.status(404).json({ error: 'Not found' });
    next();
  }

  const clientIp = (req) =>
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || '';

  // ── 1. THE PARTIES A HANDSET OPENS ──────────────────────────────────────
  // Resolved from the live links on EVERY request, never cached into the
  // session — that is what makes a revoke take effect immediately.
  function partiesFor(db, pkey) {
    if (!pkey) return [];
    const rows = db.all(
      `SELECT party_kind, party_id FROM party_links
        WHERE phone_key = ? AND status = 'active'
        ORDER BY party_kind, party_id`, [pkey]);
    const out = [];
    for (const r of rows) {
      if (r.party_kind === 'seller') {
        const t = db.get('SELECT id, name, ppla, pstate FROM traders WHERE id = ?', [r.party_id]);
        if (t) out.push({ kind: 'seller', id: t.id, name: t.name || '', place: t.ppla || '', state: t.pstate || '' });
      } else if (r.party_kind === 'buyer') {
        const b = db.get('SELECT id, buyer, buyer1, pla, state FROM buyers WHERE id = ?', [r.party_id]);
        if (b) out.push({ kind: 'buyer', id: b.id, name: b.buyer1 || b.buyer || '', place: b.pla || '', state: b.state || '' });
      }
    }
    return out;
  }

  // ── 2. SESSION ──────────────────────────────────────────────────────────
  function requireParty(req, res, next) {
    const hdr = (req.headers.authorization || '').replace('Bearer ', '');
    // window.open() cannot set a header, and a PDF has to open in a tab to
    // get a real print dialog on a phone — the same reason mobile-bridge's
    // requireAuthFlex exists. Query tokens are accepted on GET only.
    const tok = hdr || (req.method === 'GET' ? String(req.query.token || '') : '');
    if (!tok) return res.status(401).json({ error: 'Please sign in again.' });
    const db = getDb();
    const sess = db.get('SELECT * FROM party_sessions WHERE token = ?', [tok]);
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const dead = db.get(`SELECT CASE WHEN datetime('now','localtime') > ? THEN 1 ELSE 0 END AS x`, [sess.expires_at]);
    if (dead && Number(dead.x)) {
      db.run('DELETE FROM party_sessions WHERE token = ?', [tok]);
      return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
    }
    const parties = partiesFor(db, sess.phone_key);
    // Every link revoked while they were signed in. Ending the session is
    // the honest response — leaving them on an empty screen reads as a bug.
    if (!parties.length) {
      db.run('DELETE FROM party_sessions WHERE token = ?', [tok]);
      return res.status(403).json({ error: 'This number no longer has access. Please contact the office.' });
    }
    db.run(`UPDATE party_sessions SET last_used_at = datetime('now','localtime') WHERE token = ?`, [tok]);
    req.portal = { token: tok, phoneKey: sess.phone_key, parties };
    next();
  }

  // Is this party actually one of the ones this handset opens? Every
  // document read goes through here — it is the single choke point where
  // "only their own data" is enforced.
  function claimParty(req, kind, id) {
    const want = String(kind || '');
    const wantId = Number(id);
    return req.portal.parties.find(p => p.kind === want && p.id === wantId) || null;
  }

  // ── 3. OTP DELIVERY ─────────────────────────────────────────────────────
  // Two channels, chosen by `portal_otp_channel`:
  //
  //   whatsapp — the Cloud API, through an AUTHENTICATION-category template.
  //              See _waSendPortalOtp in server.js for why it cannot borrow
  //              the invoice template.
  //   log      — writes the code to the server log. A TEST channel: it lets
  //              the feature be exercised before a real one exists, and no
  //              customer can sign in through it.
  //
  // A WhatsApp failure does NOT fall back to the log. That looks like
  // helpfulness and is the opposite: it writes a live sign-in code into a
  // log file nobody is watching, while the operator believes codes are
  // going out over WhatsApp. A failure is reported and the code simply
  // goes undelivered — the person taps "Send code" again.
  async function deliverOtp(db, cfg, pkey, code) {
    const channel = String(cfg.portal_otp_channel || 'log');
    if (channel === 'whatsapp') {
      const wa = deps.sendPortalOtpWhatsApp;
      if (typeof wa !== 'function') {
        console.error('[portal] portal_otp_channel=whatsapp but no sender is wired in. No code sent.');
        return { channel: 'whatsapp', ok: false, error: 'sender not available' };
      }
      let r;
      try { r = await wa(db, pkey, code); }
      catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
      if (!r || !r.ok) {
        console.error('[portal] WhatsApp sign-in code NOT delivered to %s: %s', pkey, (r && r.error) || 'unknown');
      }
      return { channel: 'whatsapp', ok: !!(r && r.ok), error: r && r.error };
    }
    console.log(`[portal] OTP for ${pkey}: ${code} (channel=log — TEST ONLY)`);
    return { channel: 'log', ok: true };
  }

  // ── 4. ROUTES ───────────────────────────────────────────────────────────

  // Public config for the login screen. Says nothing about who is enrolled.
  app.get('/api/portal/config', requirePortalOn, (req, res) => {
    const cfg = getSettingsFlat(getDb());
    res.set('Cache-Control', 'no-store');
    // The company block the DOCUMENTS print, resolved by the same helper
    // (effectiveCompany) so the page and the paperwork can never disagree
    // about the address or the GSTIN. All of it is already on every invoice
    // the customer holds, so none of it is a disclosure.
    //
    // The OTP channel used to be here and is deliberately gone: it told an
    // unauthenticated caller whether codes are deliverable on this install,
    // i.e. whether the door is worth attacking.
    let co = {};
    try { co = require('./invoice-pdf').effectiveCompany(cfg) || {}; } catch (_) {}
    const logo = path.join(__dirname, 'public', 'logo-ispl.png');
    res.json({
      company: co.name || cfg.trade_name || 'Spice e-Auction',
      logoUrl: fs.existsSync(logo) ? '/logo-ispl.png' : null,
      address: [co.address1, co.address2, [co.place, co.pin].filter(Boolean).join(' - ')]
                 .map(x => String(x || '').trim()).filter(Boolean),
      state: co.stateName || '',
      phone: co.phone || '',
      email: co.email || '',
      gstin: co.gstin || '',
      // Minutes of quiet before the page covers itself. Public because the
      // page needs it before anyone signs in, and it discloses nothing —
      // it is a number of minutes, not data.
      screensaverMinutes: Math.max(0, Math.min(1440, parseFloat(cfg.portal_screensaver_minutes) || 0)),
    });
  });

  app.post('/api/portal/otp/request', requirePortalOn, async (req, res) => {
    const db = getDb();
    const pkey = phoneKey(req.body && req.body.phone);
    if (!pkey) return res.status(400).json({ error: 'Enter your 10-digit mobile number.' });

    const ip = clientIp(req);
    // Two independent limits. Per-phone stops someone pestering one party;
    // per-IP stops one machine walking the whole master.
    const perPhone = rateHit('otp:p:' + pkey, 3, 15 * 60 * 1000);
    if (!perPhone.ok) return res.status(429).json({ error: `Too many codes requested. Try again in ${Math.ceil(perPhone.retryInSec / 60)} minutes.` });
    const perIp = rateHit('otp:i:' + ip, 20, 15 * 60 * 1000);
    if (!perIp.ok) return res.status(429).json({ error: 'Too many attempts from this device. Try again later.' });

    const known = partiesFor(db, pkey).length > 0;
    const cfg = getSettingsFlat(db);
    let channel = 'none';
    if (known) {
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      // ONLY THE NEWEST CODE WORKS. Without this, asking for a second code
      // leaves the first one live for the rest of its ten minutes: verify
      // picks the latest UNCONSUMED row, so spending the new code simply
      // promotes the old one back to being the latest unconsumed. Two valid
      // codes at once is one more than anybody intended, and the window is
      // widest exactly when a person is retrying because something went
      // wrong. Superseded rows are marked consumed, not deleted — the
      // channel/attempt history is what support reads.
      db.run(`UPDATE party_otp SET consumed_at = datetime('now','localtime')
               WHERE phone_key = ? AND consumed_at IS NULL`, [pkey]);
      db.run(
        `INSERT INTO party_otp (phone_key, code_hash, expires_at, channel, ip)
         VALUES (?, ?, datetime('now','localtime','+${OTP_TTL_MIN} minutes'), ?, ?)`,
        [pkey, sha256(pkey + ':' + code), String(cfg.portal_otp_channel || 'log'), ip]);
      // Spent codes are rubbish the moment they expire, and this table takes
      // a row per ATTEMPT — including every probe at a number that is not on
      // the books. Unpruned, a flood writes to the volume indefinitely, which
      // is the attack succeeding by the back door. A day is long enough for
      // the audit question ("did a code go out to this number this morning?")
      // and short enough that the table never becomes storage.
      db.run(`DELETE FROM party_otp WHERE created_at < datetime('now','localtime','-1 day')`);
      const sent = await deliverOtp(db, cfg, pkey, code);
      channel = sent.channel;
      // Record HOW it went on the OTP row, so support can answer "did the
      // code actually go out?" from the admin screen rather than from the
      // Railway log. Never the code itself.
      try {
        db.run(`UPDATE party_otp SET channel = ? WHERE id = (SELECT MAX(id) FROM party_otp WHERE phone_key = ?)`,
          [sent.ok ? sent.channel : (sent.channel + ':failed'), pkey]);
      } catch (_) {}
    }
    // The SAME response either way, to the byte. Telling an unknown number
    // that it is unknown turns this endpoint into a free lookup of who
    // trades here — and `channel` did exactly that in the first cut, by
    // coming back 'log' for a number on the books and 'none' for one that
    // is not. Which channel carried the code is the operator's business,
    // so it goes to the log and not down the wire.
    if (known) console.log(`[portal] OTP issued for ${pkey} via ${channel}`);
    // ttlSeconds drives the countdown on the page. It is a CONSTANT, not a
    // read of the row that was just written — an unknown number must get a
    // byte-identical reply, and anything derived from "was a row written?"
    // is an oracle.
    res.json({ ok: true, sent: true, ttlMinutes: OTP_TTL_MIN, ttlSeconds: OTP_TTL_MIN * 60,
               resendAfterSeconds: RESEND_COOLDOWN_SEC });
  });

  app.post('/api/portal/otp/verify', requirePortalOn, (req, res) => {
    const db = getDb();
    const pkey = phoneKey(req.body && req.body.phone);
    const code = String((req.body && req.body.code) || '').trim();
    if (!pkey || !code) return res.status(400).json({ error: 'Enter the 6-digit code.' });

    const vg = rateHit('vfy:' + pkey, 10, 15 * 60 * 1000);
    if (!vg.ok) return res.status(429).json({ error: 'Too many wrong codes. Try again later.' });

    const row = db.get(
      `SELECT * FROM party_otp
        WHERE phone_key = ? AND consumed_at IS NULL
          AND datetime('now','localtime') <= expires_at
          AND attempts < ?
        ORDER BY id DESC LIMIT 1`, [pkey, OTP_MAX_ATTEMPTS]);
    if (!row) return res.status(401).json({ error: 'That code has expired. Please request a new one.' });

    if (!sameSecret(row.code_hash, sha256(pkey + ':' + code))) {
      db.run('UPDATE party_otp SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      return res.status(401).json({ error: 'That code is not right.' });
    }

    const parties = partiesFor(db, pkey);
    if (!parties.length) return res.status(403).json({ error: 'This number does not have access. Please contact the office.' });

    // Burn every outstanding code for this number, not just the one used.
    // Belt and braces next to the supersede-on-issue above.
    db.run(`UPDATE party_otp SET consumed_at = datetime('now','localtime')
             WHERE phone_key = ? AND consumed_at IS NULL`, [pkey]);
    const token = crypto.randomBytes(32).toString('hex');
    db.run(
      `INSERT INTO party_sessions (token, phone_key, expires_at, device, ip)
       VALUES (?, ?, datetime('now','localtime','+${SESSION_TTL_HRS} hours'), ?, ?)`,
      [token, pkey, String(req.headers['user-agent'] || '').slice(0, 80), clientIp(req)]);
    db.run(`DELETE FROM party_sessions WHERE expires_at < datetime('now','localtime')`);
    res.json({ token, phone: pkey, parties });
  });

  app.post('/api/portal/logout', requirePortalOn, requireParty, (req, res) => {
    getDb().run('DELETE FROM party_sessions WHERE token = ?', [req.portal.token]);
    res.json({ ok: true });
  });

  app.get('/api/portal/me', requirePortalOn, requireParty, (req, res) => {
    res.set('Cache-Control', 'no-store');
    // The phone is the account here, so the page shows it back: on a shared
    // handset it is the only thing that says WHOSE sign-in this is.
    res.json({ phone: req.portal.phoneKey, parties: req.portal.parties });
  });

  // ── Indian financial year, server side ──────────────────────────────────
  // 1 April → 31 March. "2026-27" means 2026-04-01 .. 2027-03-31. The page
  // derives the same thing client-side for its picker; this exists so the
  // BULK download resolves its own period instead of trusting a list of ids
  // from the browser — the server picking the rows is what makes "download
  // everything for October" safe without validating anything.
  function fyRange(fy) {
    const m = String(fy || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const start = Number(m[1]);
    return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
  }
  function monthRange(ym) {
    const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
  }
  // `month` wins over `fy` when both are given — the page sends both so the
  // filename can name the year even on a month download.
  function periodRange(q) {
    return monthRange(q.month) || fyRange(q.fy) || null;
  }

  // The rows a party may see, optionally narrowed to a period. ONE function,
  // used by the list and by the bulk download, so the thing you see and the
  // thing you get can never be different sets.
  function documentsFor(db, party, range) {
    const win = range ? ' AND date BETWEEN ? AND ?' : '';
    const span = range ? [range.from, range.to] : [];
    const out = [];
    if (party.kind === 'seller') {
      const rows = db.all(
        `SELECT * FROM bills WHERE trader_id = ?${win} ORDER BY date DESC, id DESC`,
        [party.id, ...span]);
      // The amount shown is the NETT the commission bill PRINTS — cardamom
      // cost plus sample refund, less commission and GST — not bills.net,
      // which is the gross bill-of-supply value. They differ by the
      // commission, so showing `net` here put a figure on the row that the
      // document the grower then opens does not contain.
      const nett = (typeof commissionNettForBills === 'function')
        ? commissionNettForBills(db, rows) : new Map();
      for (const r of rows)
        out.push({ kind: 'bill', id: r.id, ano: r.ano, date: r.date, no: String(r.bil || ''),
                   amount: nett.has(r.id) ? nett.get(r.id) : r.net, label: 'Commission Bill',
                   _li: r.line_items, _lotNo: r.lot_no });

      // Registered dealers are billed by purchase invoice instead. The
      // amount is `total - tds`, which is what the document prints as its
      // Grand Total (render-purchase-html: invoiceAmount = grandTotal -
      // tdsAmount). `total` alone is the SUBTOTAL above the 194Q line, so a
      // row showing it would differ from the paper by the TDS — ₹628 on the
      // first dealer this was checked against.
      for (const r of db.all(
        `SELECT id, ano, date, invo AS no, lot_no,
                (COALESCE(total,0) - COALESCE(tds,0)) AS amount
           FROM purchases
          WHERE trader_id = ?${win} ORDER BY date DESC, id DESC`, [party.id, ...span]))
        out.push({ kind: 'purchase', id: r.id, ano: r.ano, date: r.date, no: String(r.no || ''),
                   amount: r.amount, label: 'Purchase Invoice', _lotNo: r.lot_no });
    } else {
      for (const r of db.all(
        `SELECT i.id, i.ano, i.date, i.invo AS no, i.tot AS amount, i.line_items
           FROM invoices i
          WHERE i.buyer_id = ?
            AND COALESCE(i.is_proforma,0) = 0
            AND NOT EXISTS (
                  SELECT 1 FROM lots l
                   WHERE l.auction_id = i.auction_id
                     AND l.invo = i.invo
                     AND COALESCE(l.invoice_hold,0) = 1)
            ${range ? 'AND i.date BETWEEN ? AND ?' : ''}
          ORDER BY i.date DESC, i.id DESC`, [party.id, ...span]))
        out.push({ kind: 'invoice', id: r.id, ano: r.ano, date: r.date, no: String(r.no || ''),
                   amount: r.amount, label: 'Tax Invoice', _li: r.line_items });
    }
    return attachLotNos(db, party, out);
  }

  // The LOT NUMBERS behind a document.
  //
  // A grower checks a bill against the lots they brought and a buyer against
  // what they bid on, so the row has to name them. Where they live differs by
  // document, which is the whole reason this is one function:
  //   bill      line_items JSON — every bill on this install is lot-wise,
  //             so that is one lot
  //   invoice   line_items JSON — one invoice spans up to 57 lots
  //   purchase  NEITHER. Dealers are billed seller-wise with lot_no blank on
  //             all 149 rows, so the lots have to come from the lots table.
  //
  // Sorted numerically: lot numbers are TEXT ('090', '127'), and a plain
  // string sort puts '1000' before '99'.
  function attachLotNos(db, party, docs) {
    const byLot = (a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    };
    const fromJson = (raw) => {
      try {
        const a = JSON.parse(raw || '[]');
        if (!Array.isArray(a)) return [];
        return [...new Set(a.map(x => String((x && x.lot) == null ? '' : x.lot).trim()).filter(Boolean))];
      } catch (_) { return []; }
    };

    const needLookup = [];
    for (const d of docs) {
      let lots = d._li != null ? fromJson(d._li) : [];
      if (!lots.length && d._lotNo != null && String(d._lotNo).trim()) lots = [String(d._lotNo).trim()];
      d.lots = lots.sort(byLot);
      if (!d.lots.length) needLookup.push(d);
      delete d._li; delete d._lotNo;
    }
    if (!needLookup.length) return docs;

    // ONE query for everything still missing, not one per row.
    try {
      if (party.kind === 'seller') {
        const aucs = [...new Set(needLookup.map(d => String(d.ano == null ? '' : d.ano).trim()).filter(Boolean))];
        if (!aucs.length) return docs;
        const ph = aucs.map(() => '?').join(',');
        const rows = db.all(
          `SELECT TRIM(a.ano) AS ano, l.lot_no
             FROM lots l JOIN auctions a ON a.id = l.auction_id
            WHERE l.trader_id = ? AND TRIM(a.ano) IN (${ph})`, [party.id, ...aucs]);
        const map = new Map();
        for (const r of rows) {
          const k = String(r.ano);
          if (!map.has(k)) map.set(k, new Set());
          const v = r.lot_no == null ? '' : String(r.lot_no).trim();
          if (v) map.get(k).add(v);
        }
        for (const d of needLookup) {
          const set = map.get(String(d.ano == null ? '' : d.ano).trim());
          d.lots = set ? [...set].sort(byLot) : [];
        }
      }
    } catch (e) {
      // A document with no lot list still lists and still downloads; it just
      // shows no lot line. Never fail the page over a label.
      console.warn('[portal] lot-number lookup failed:', e && e.message);
    }
    return docs;
  }

  // What a party has done with us, per financial year. Money first: it is
  // the number they opened the page for. Quantities come from the document
  // rows rather than from the lots, so a re-stamped lot can never make the
  // page disagree with the paperwork in the customer's hand.
  function totalsFor(db, party, documents) {
    const byFy = {};
    const bump = (fy, k, v) => {
      if (!fy) return;
      byFy[fy] = byFy[fy] || { documents: 0, amount: 0, qty: 0, bags: 0, lastDate: '' };
      byFy[fy][k] += Number(v) || 0;
    };
    // 1 April → 31 March, the same window the page's picker uses.
    const fyOf = (d) => {
      const m = String(d || '').match(/^(\d{4})-(\d{2})/);
      if (!m) return '';
      const start = Number(m[2]) >= 4 ? Number(m[1]) : Number(m[1]) - 1;
      return start + '-' + String((start + 1) % 100).padStart(2, '0');
    };

    // Quantities come from each document's OWN table — a seller can hold
    // both commission bills and purchase invoices (an agriculturist who
    // later registered), and reading only `bills` left a dealer's headline
    // saying 0 kg next to a ₹59 lakh total.
    const TABLE = { bill: 'bills', purchase: 'purchases', invoice: 'invoices' };
    const qtyById = new Map();
    for (const kind of Object.keys(TABLE)) {
      const ids = documents.filter(d => d.kind === kind).map(d => d.id);
      if (!ids.length) continue;
      const ph = ids.map(() => '?').join(',');
      const bagCol = kind === 'invoice' ? 'bag' : '0 AS bag';
      for (const r of db.all(`SELECT id, qty, ${bagCol} FROM ${TABLE[kind]} WHERE id IN (${ph})`, ids)) {
        qtyById.set(kind + ':' + r.id, r);
      }
    }
    for (const d of documents) {
      const fy = fyOf(d.date);
      const extra = qtyById.get(d.kind + ':' + d.id) || {};
      bump(fy, 'documents', 1);
      bump(fy, 'amount', d.amount);
      bump(fy, 'qty', extra.qty);
      bump(fy, 'bags', extra.bag);
      if (fy && (!byFy[fy].lastDate || d.date > byFy[fy].lastDate)) byFy[fy].lastDate = d.date;
    }
    return byFy;
  }

  // ── 5. THE DOCUMENT LIST ────────────────────────────────────────────────
  // One party at a time, always scoped on an id the caller has been proven
  // to hold. `ano` is the trade NUMBER — never auctions.id — because that is
  // what is printed on the paperwork the customer is holding.
  app.get('/api/portal/documents', requirePortalOn, requireParty, (req, res) => {
    const db = getDb();
    const [kind, idRaw] = String(req.query.party || '').split(':');
    const party = claimParty(req, kind, idRaw);
    if (!party) return res.status(403).json({ error: 'Not your record.' });
    const documents = documentsFor(db, party);
    res.set('Cache-Control', 'no-store');
    // A roll-up the page can show per financial year. Computed from the same
    // rows the list returns, so the headline and the list can never tell two
    // different stories — and so the figures honour every exclusion
    // (proforma, stopped invoices) without repeating a single filter.
    res.json({ party, documents, totals: totalsFor(db, party, documents) });
  });

  // ── 5b. EVERYTHING FOR A PERIOD, AS ONE PDF ─────────────────────────────
  // A grower who wants last month's bills wants ONE file, not nine taps. The
  // period is resolved server-side from `fy`/`month` rather than from a list
  // of ids the page supplies: the set that comes back is then by construction
  // the same set the list showed, and there is no id list to tamper with.
  app.get('/api/portal/documents/bulk', requirePortalOn, requireParty, async (req, res) => {
    const db = getDb();
    const [kind, idRaw] = String(req.query.party || '').split(':');
    const party = claimParty(req, kind, idRaw);
    if (!party) return res.status(403).json({ error: 'Not your record.' });

    // Two ways to ask for a bundle, and BOTH start from the party's own
    // allowed set rather than from anything the browser says:
    //   • a period   — fy/month, resolved here
    //   • a selection — ?ids=, intersected with that set
    // An id the party does not hold is refused outright rather than quietly
    // dropped: a silent drop would hand back a file that is not what was
    // asked for, and hide a tampering attempt in the process.
    const asked = String(req.query.ids || '').trim();
    // A SELECTION is checked against the party's whole set, not against the
    // period: the two filters are alternatives, and validating a selection
    // against the period would report a legitimately-selected document from
    // another month as "not yours", which is both wrong and alarming.
    const range = asked ? null : periodRange(req.query);
    let docs = documentsFor(db, party, range);

    if (asked) {
      const want = asked.split(',').map(n => Number(n)).filter(Number.isFinite);
      if (!want.length) return res.status(400).json({ error: 'No documents selected.' });
      const allowed = new Set(docs.map(d => d.id));
      const stranger = want.find(id => !allowed.has(id));
      if (stranger !== undefined) return res.status(403).json({ error: 'Not your document.' });
      const pick = new Set(want);
      docs = docs.filter(d => pick.has(d.id));
    }

    if (!docs.length) return res.status(404).json({ error: 'Nothing to download for that period.' });
    // A cap, because this renders one Chromium page per document and a
    // runaway request is the one way a customer can cost this box real work.
    if (docs.length > 60) {
      return res.status(413).json({
        error: `That is ${docs.length} documents. Please pick a single month — the whole year is too large to send in one file.`,
      });
    }

    try {
      let pdf;
      if (party.kind === 'seller') {
        // A seller may hold BOTH kinds (an agriculturist who later
        // registered). The commission renderer lays out many bills in one
        // pass; purchase invoices render singly and are merged on the end,
        // so a mixed bundle still arrives as one file.
        const billIds = docs.filter(d => d.kind === 'bill').map(d => d.id);
        const parts = [];
        if (billIds.length) {
          const rows = db.all(
            `SELECT * FROM bills WHERE id IN (${billIds.map(() => '?').join(',')}) ORDER BY date DESC, id DESC`,
            billIds);
          parts.push((await renderBillOfSupplyPdfMany(db, rows)).pdf);
        }
        for (const d of docs.filter(x => x.kind === 'purchase')) {
          const row = db.get('SELECT * FROM purchases WHERE id = ?', [d.id]);
          if (row) parts.push((await renderPurchaseInvoicePdf(db, row)).pdf);
        }
        pdf = await require('./pdf/merge-pdf').mergePdfs(parts);
      } else {
        const parts = [];
        for (const d of docs) {
          const row = db.get('SELECT * FROM invoices WHERE id = ?', [d.id]);
          if (!row) continue;
          const one = await renderSalesInvoicePdf(db, row);
          parts.push(one.pdf);
        }
        pdf = await require('./pdf/merge-pdf').mergePdfs(parts);
      }

      for (const d of docs) {
        db.run(
          `INSERT INTO party_downloads (phone_key, party_kind, party_id, doc_kind, doc_id, doc_no, ip)
           VALUES (?,?,?,?,?,?,?)`,
          [req.portal.phoneKey, party.kind, party.id, d.kind, d.id, d.no, clientIp(req)]);
      }

      const tag = asked
        ? `${docs.length}_documents`
        : String(req.query.month || req.query.fy || 'all').replace(/[^\w-]/g, '');
      const safe = String(party.name || 'documents').replace(/[^\w]+/g, '_').slice(0, 40);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}_${tag}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(pdf);
    } catch (e) {
      console.error('[portal] bulk render failed:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Could not build that file just now.' });
    }
  });

  // ── 6. THE DOWNLOAD ─────────────────────────────────────────────────────
  // Re-checks ownership from the DOCUMENT ROW rather than trusting whatever
  // the list handed out: the list and the download are separate requests and
  // only the row itself knows whose document it is.
  app.get('/api/portal/documents/:kind/:id/pdf', requirePortalOn, requireParty, async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad document id.' });

    try {
      let party = null, docNo = '', pdf = null, filename = 'document.pdf';
      // The kind must be one this party's side is allowed at all, before we
      // even look the row up. See VISIBLE_KINDS.
      const kindOk = (side) => (VISIBLE_KINDS[side] || []).includes(req.params.kind);

      if (req.params.kind === 'bill') {
        if (!kindOk('seller')) return res.status(404).json({ error: 'Unknown document type.' });
        const row = db.get('SELECT * FROM bills WHERE id = ?', [id]);
        if (!row) return res.status(404).json({ error: 'Not found.' });
        party = claimParty(req, 'seller', row.trader_id);
        if (!party) return res.status(403).json({ error: 'Not your document.' });
        docNo = String(row.bil || '');
        ({ pdf, filename } = await renderBillOfSupplyPdf(db, row));

      } else if (req.params.kind === 'purchase') {
        if (!kindOk('seller')) return res.status(404).json({ error: 'Unknown document type.' });
        const row = db.get('SELECT * FROM purchases WHERE id = ?', [id]);
        if (!row) return res.status(404).json({ error: 'Not found.' });
        party = claimParty(req, 'seller', row.trader_id);
        if (!party) return res.status(403).json({ error: 'Not your document.' });
        docNo = String(row.invo || '');
        ({ pdf, filename } = await renderPurchaseInvoicePdf(db, row));

      } else if (req.params.kind === 'invoice') {
        if (!kindOk('buyer')) return res.status(404).json({ error: 'Unknown document type.' });
        const row = db.get('SELECT * FROM invoices WHERE id = ?', [id]);
        if (!row) return res.status(404).json({ error: 'Not found.' });
        party = claimParty(req, 'buyer', row.buyer_id);
        if (!party) return res.status(403).json({ error: 'Not your document.' });
        // The list already excludes these; re-checked because a document can
        // be put on hold between the list and the click.
        if (Number(row.is_proforma)) return res.status(403).json({ error: 'Not available.' });
        const held = db.get(
          `SELECT 1 AS x FROM lots WHERE auction_id = ? AND invo = ? AND COALESCE(invoice_hold,0) = 1 LIMIT 1`,
          [row.auction_id, row.invo]);
        if (held) return res.status(403).json({ error: 'This invoice is on hold. Please contact the office.' });
        docNo = String(row.invo || '');
        ({ pdf, filename } = await renderSalesInvoicePdf(db, row));

      } else {
        return res.status(404).json({ error: 'Unknown document type.' });
      }

      db.run(
        `INSERT INTO party_downloads (phone_key, party_kind, party_id, doc_kind, doc_id, doc_no, ip)
         VALUES (?,?,?,?,?,?,?)`,
        [req.portal.phoneKey, party.kind, party.id, req.params.kind, id, docNo, clientIp(req)]);

      // ?dl=1 → save, otherwise view in the tab. Two buttons on the page,
      // because on a phone "open" and "keep a copy" are different intentions
      // and the browser's own menu is where that choice goes to die.
      const disposition = String(req.query.dl || '') === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(pdf);
    } catch (e) {
      console.error('[portal] document render failed:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Could not produce that document just now.' });
    }
  });

  // ── 7. ADMIN: CUSTOMER ACCESS ───────────────────────────────────────────
  // Deliberately outside the feature flag: enrolment and the audit trail
  // have to be reachable before the portal is switched on and after it is
  // switched off again.

  // Who can see what. `shares` is the number this page exists to surface —
  // one phone may open several parties, so an admin must be able to SEE
  // that rather than discover it from a complaint.
  app.get('/api/portal/admin/links', requireAdmin, (req, res) => {
    const db = getDb();
    const q = String(req.query.q || '').trim();
    const where = ["l.status = 'active'"];
    const args = [];
    if (q) {
      where.push(`(l.phone_key LIKE ? OR UPPER(COALESCE(t.name, b.buyer1, b.buyer, '')) LIKE UPPER(?))`);
      args.push('%' + q.replace(/\D/g, '') + '%', '%' + q + '%');
    }
    const rows = db.all(
      `SELECT l.id, l.party_kind, l.party_id, l.phone_key, l.source, l.created_at, l.created_by,
              COALESCE(t.name, b.buyer1, b.buyer, '(deleted)') AS party_name,
              (SELECT COUNT(*) FROM party_links x
                WHERE x.phone_key = l.phone_key AND x.status = 'active') AS shares
         FROM party_links l
         LEFT JOIN traders t ON l.party_kind = 'seller' AND t.id = l.party_id
         LEFT JOIN buyers  b ON l.party_kind = 'buyer'  AND b.id = l.party_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.phone_key, party_name
        LIMIT 500`, args);
    const total = db.get(`SELECT COUNT(*) AS n FROM party_links WHERE status='active'`) || { n: 0 };
    res.set('Cache-Control', 'no-store');
    res.json({ rows, total: total.n, shown: rows.length });
  });

  app.post('/api/portal/admin/links', requireAdmin, (req, res) => {
    const db = getDb();
    const kind = String((req.body && req.body.party_kind) || '');
    const id = Number(req.body && req.body.party_id);
    const pkey = phoneKey(req.body && req.body.phone);
    if (kind !== 'seller' && kind !== 'buyer') return res.status(400).json({ error: 'party_kind must be seller or buyer' });
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'party_id is required' });
    if (!pkey) return res.status(400).json({ error: 'A 10-digit phone number is required' });
    const exists = kind === 'seller'
      ? db.get('SELECT id FROM traders WHERE id = ?', [id])
      : db.get('SELECT id FROM buyers WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: 'No such party' });
    try {
      db.run(
        `INSERT INTO party_links (party_kind, party_id, phone_key, status, source, created_by)
         VALUES (?,?,?,'active','admin',?)`,
        [kind, id, pkey, (req.user && req.user.username) || '']);
    } catch (e) {
      // The partial unique index — already granted. Not an error worth
      // showing: the admin wanted this state and this state now holds.
      if (!/UNIQUE/i.test(e.message || '')) throw e;
    }
    const shares = db.get(`SELECT COUNT(*) AS n FROM party_links WHERE phone_key = ? AND status='active'`, [pkey]);
    res.json({ ok: true, phone_key: pkey, shares: (shares && shares.n) || 1 });
  });

  app.post('/api/portal/admin/links/:id/revoke', requireAdmin, (req, res) => {
    const db = getDb();
    const row = db.get('SELECT * FROM party_links WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'No such link' });
    db.run(
      `UPDATE party_links SET status='revoked', revoked_at=datetime('now','localtime'), revoked_by=?
        WHERE id = ?`, [(req.user && req.user.username) || '', row.id]);
    // The session stays, deliberately: partiesFor() is re-read on every
    // request, so the revoked party drops out on the customer's next tap
    // while any OTHER party on that handset keeps working.
    res.json({ ok: true });
  });

  // ── Seeding from the phone master ───────────────────────────────────────
  // One-time import: every party that holds at least one document and has a
  // phone number on the master gets a link. Shared numbers produce several
  // links, which is the accepted arrangement here.
  //
  // Defaults to a DRY RUN. This writes thousands of grants in one click and
  // an admin should see the counts — particularly how many handsets end up
  // opening more than one party — before any of it is real.
  app.post('/api/portal/admin/seed', requireAdmin, (req, res) => {
    const db = getDb();
    const commit = !!(req.body && req.body.commit);
    const CLEAN = (c) => `substr(replace(replace(replace(replace(replace(IFNULL(${c},''),' ',''),'-',''),'+',''),'(',''),')',''), -10)`;

    // Holds a document the portal can actually SHOW: a commission bill, or
    // a purchase invoice for a registered dealer. Debit notes are
    // deliberately absent — a seller is not shown those, so enrolling on one
    // alone used to let somebody sign in to an empty screen.
    const sellers = db.all(
      `SELECT t.id, ${CLEAN('t.tel')} AS pkey FROM traders t
        WHERE LENGTH(${CLEAN('t.tel')}) = 10
          AND EXISTS (SELECT 1 FROM bills b WHERE b.trader_id = t.id
                      UNION ALL SELECT 1 FROM purchases p WHERE p.trader_id = t.id)`);
    const buyers = db.all(
      `SELECT b.id, ${CLEAN('b.tel')} AS pkey FROM buyers b
        WHERE LENGTH(${CLEAN('b.tel')}) = 10
          AND EXISTS (SELECT 1 FROM invoices i WHERE i.buyer_id = b.id AND COALESCE(i.is_proforma,0) = 0)`);

    const phones = new Map();
    const note = (k) => phones.set(k, (phones.get(k) || 0) + 1);
    sellers.forEach(r => note(r.pkey));
    buyers.forEach(r => note(r.pkey));
    let shared = 0, sharedParties = 0;
    for (const n of phones.values()) if (n > 1) { shared += 1; sharedParties += n; }

    let written = 0;
    if (commit) {
      const by = (req.user && req.user.username) || '';
      // Goes through autoEnrol so the seed and the document path obey ONE
      // rule — including the reconciliation: a re-run repairs a link left
      // pointing at a number the master no longer holds, which a plain
      // INSERT…catch(UNIQUE) silently left broken.
      const put = (kind, id, pkey) => { if (autoEnrol(db, kind, id, pkey)) written += 1; };
      sellers.forEach(r => put('seller', r.id, r.pkey));
      buyers.forEach(r => put('buyer', r.id, r.pkey));
    }

    res.json({
      committed: commit,
      sellers: sellers.length,
      buyers: buyers.length,
      distinctPhones: phones.size,
      sharedPhones: shared,
      partiesOnSharedPhones: sharedParties,
      written,
    });
  });

  // The log channel's read-back. Exists so the feature can be exercised
  // before a real SMS or WhatsApp channel is connected — it hands an admin
  // the code that was just issued. It returns the HASH's source only
  // because the plaintext was never stored; the code itself is in the
  // server log. This endpoint reports the OTP's STATE, not its value.
  app.get('/api/portal/admin/otp-state', requireAdmin, (req, res) => {
    const db = getDb();
    const pkey = phoneKey(req.query.phone);
    if (!pkey) return res.status(400).json({ error: 'phone is required' });
    const row = db.get(
      `SELECT id, expires_at, attempts, consumed_at, channel, created_at
         FROM party_otp WHERE phone_key = ? ORDER BY id DESC LIMIT 1`, [pkey]);
    res.set('Cache-Control', 'no-store');
    res.json({ phone_key: pkey, otp: row || null });
  });

  // Send a REAL sign-in code to a number of the admin's choosing, to prove
  // the template works before `portal_otp_channel` is switched over. Meta's
  // own error comes back verbatim — "template name does not exist",
  // "number of parameters does not match" and the category complaints are
  // all things you want to read exactly as written, not summarised.
  //
  // It sends a code that genuinely signs that number in, so it is admin-only
  // and it refuses a number that is not enrolled: a test that messages a
  // stranger is not a test.
  app.post('/api/portal/admin/otp-test', requireAdmin, async (req, res) => {
    const db = getDb();
    const pkey = phoneKey(req.body && req.body.phone);
    if (!pkey) return res.status(400).json({ error: 'A 10-digit phone number is required' });
    const parties = partiesFor(db, pkey);
    if (!parties.length) {
      return res.status(404).json({ error: 'That number is not linked to any party. Link it first on Customer Access.' });
    }
    const wa = deps.sendPortalOtpWhatsApp;
    if (typeof wa !== 'function') return res.status(500).json({ error: 'WhatsApp sender not available in this build' });

    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    db.run(`UPDATE party_otp SET consumed_at = datetime('now','localtime')
             WHERE phone_key = ? AND consumed_at IS NULL`, [pkey]);
    db.run(
      `INSERT INTO party_otp (phone_key, code_hash, expires_at, channel, ip)
       VALUES (?, ?, datetime('now','localtime','+${OTP_TTL_MIN} minutes'), 'whatsapp-test', ?)`,
      [pkey, sha256(pkey + ':' + code), clientIp(req)]);

    let r;
    try { r = await wa(db, pkey, code); }
    catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
    res.json({
      ok: !!(r && r.ok),
      phone_key: pkey,
      parties: parties.map(p => p.name),
      wamid: (r && r.id) || null,
      // Meta's words, not ours.
      error: (r && r.error) || null,
      policy: (r && r.policy) || null,
      note: (r && r.ok)
        ? 'Accepted by Meta. Delivery is asynchronous — check the WhatsApp send log for the receipt.'
        : 'Not sent. Nothing reached the customer.',
    });
  });

  // Who downloaded what. On a shared handset this is the record that
  // answers the only question that matters after a dispute.
  app.get('/api/portal/admin/downloads', requireAdmin, (req, res) => {
    const db = getDb();
    const rows = db.all(
      `SELECT d.*, COALESCE(t.name, b.buyer1, b.buyer, '') AS party_name
         FROM party_downloads d
         LEFT JOIN traders t ON d.party_kind = 'seller' AND t.id = d.party_id
         LEFT JOIN buyers  b ON d.party_kind = 'buyer'  AND b.id = d.party_id
        ORDER BY d.id DESC LIMIT 200`);
    res.set('Cache-Control', 'no-store');
    res.json({ rows });
  });

  // ── 7. THE PAGE ─────────────────────────────────────────────────────────
  // Its own small surface. Emphatically NOT public/index.html, which is
  // 3.1 MB — the people this is for are on a phone on mobile data.
  const portalDir = path.join(__dirname, 'public-portal');
  app.get(['/my', '/my/'], (req, res, next) => {
    if (!flagOn(getDb())) return next();
    const f = path.join(portalDir, 'my.html');
    if (!fs.existsSync(f)) return next();
    res.set('Cache-Control', 'no-store');
    res.sendFile(f);
  });

  return { phoneKey, partiesFor };
}

module.exports = { mountPortal, phoneKey, autoEnrol };
