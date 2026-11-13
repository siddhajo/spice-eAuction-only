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
const VISIBLE_KINDS = {
  seller: ['bill'],
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
    // Company name only. The OTP channel used to be here, which told an
    // unauthenticated caller whether codes are actually deliverable on this
    // install — i.e. whether the door is worth attacking. Admins read it
    // from Settings instead.
    res.json({ company: cfg.trade_name || cfg.company_name || 'Spice e-Auction' });
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
      for (const r of db.all(
        `SELECT id, ano, date, bil AS no, net AS amount FROM bills
          WHERE trader_id = ?${win} ORDER BY date DESC, id DESC`, [party.id, ...span]))
        out.push({ kind: 'bill', id: r.id, ano: r.ano, date: r.date, no: String(r.no || ''), amount: r.amount, label: 'Commission Bill' });
    } else {
      for (const r of db.all(
        `SELECT i.id, i.ano, i.date, i.invo AS no, i.tot AS amount
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
        out.push({ kind: 'invoice', id: r.id, ano: r.ano, date: r.date, no: String(r.no || ''), amount: r.amount, label: 'Tax Invoice' });
    }
    return out;
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
    res.set('Cache-Control', 'no-store');
    res.json({ party, documents: documentsFor(db, party) });
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
        // The commission renderer already lays out one A4 page per lot across
        // many bills, so hand it the whole set rather than merging N files.
        const rows = db.all(
          `SELECT * FROM bills WHERE id IN (${docs.map(() => '?').join(',')}) ORDER BY date DESC, id DESC`,
          docs.map(d => d.id));
        ({ pdf } = await renderBillOfSupplyPdfMany(db, rows));
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

    const sellers = db.all(
      `SELECT t.id, ${CLEAN('t.tel')} AS pkey FROM traders t
        WHERE LENGTH(${CLEAN('t.tel')}) = 10
          AND EXISTS (SELECT 1 FROM bills b WHERE b.trader_id = t.id
                      UNION ALL SELECT 1 FROM debit_notes_planter d WHERE d.trader_id = t.id)`);
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
      const put = (kind, id, pkey) => {
        try {
          db.run(`INSERT INTO party_links (party_kind, party_id, phone_key, status, source, created_by)
                  VALUES (?,?,?,'active','seeded',?)`, [kind, id, pkey, by]);
          written += 1;
        } catch (e) { if (!/UNIQUE/i.test(e.message || '')) throw e; }
      };
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

module.exports = { mountPortal, phoneKey };
