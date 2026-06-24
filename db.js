/**
 * db.js — SQL.js variant for cloud deploy (Railway etc.)
 *
 * Why: better-sqlite3 needs native compilation that's been failing on
 * Railway's build infra. sql.js is pure JavaScript — no native bindings,
 * no architecture issues, no compile step.
 *
 * Trade-off: sql.js holds the entire DB in memory and writes the whole
 * file on every commit. For a single-server Railway deployment this is
 * fine since concurrent writes within one Node process are sequential.
 * For multi-machine deploys, switch back to better-sqlite3.
 *
 * Compatibility: This wrapper preserves the same API server.js,
 * calculations.js, company-config.js, exports.js, etc. already use:
 *
 *   db.run(sql, params)           // INSERT/UPDATE/DELETE (params array or spread)
 *   db.get(sql, params)           // SELECT one row
 *   db.all(sql, params)           // SELECT many rows
 *   db.exec(sql)                  // multi-statement SQL
 *   db.prepare(sql).run(...args)  // prepared INSERT/UPDATE
 *   db.prepare(sql).get(...args)  // prepared SELECT one
 *   db.prepare(sql).all(...args)  // prepared SELECT many
 *   db.transaction(fn)            // returns a wrapped function
 */

const initSqlJs = require('sql.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// DB path: defaults to ./data/config.db (dev / standalone node).
// Electron packaging sets SPICE_DATA_DIR to %APPDATA%\SpiceConfig so the
// database survives app updates and doesn't sit inside the read-only
// installation folder.
const DB_DIR = process.env.SPICE_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'config.db');

let SQL = null;        // sql.js module instance (loaded once)
let rawDb = null;       // sql.js Database instance
let wrapped = null;     // our API wrapper
let pendingSave = null; // debounced fs.writeFile timer

/**
 * Persist the in-memory DB to disk. Debounced 200ms so a burst of writes
 * (e.g. invoice generation) only triggers one write.
 */
function scheduleSave() {
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    pendingSave = null;
    if (!rawDb) return;
    try {
      const buf = Buffer.from(rawDb.export());
      const tmp = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, DB_PATH);
    } catch (e) {
      console.error('[db] save failed:', e.message);
    }
  }, 200);
}

/**
 * Force-flush any pending save synchronously. Called on shutdown/close.
 */
function flushSave() {
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
  if (!rawDb) return;
  try {
    const buf = Buffer.from(rawDb.export());
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('[db] flush failed:', e.message);
  }
}

/**
 * Initialize the database. async/await is necessary because sql.js loads
 * its WASM module asynchronously.
 */
async function initDb() {
  if (wrapped) return wrapped;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Load sql.js wasm runtime once
  if (!SQL) SQL = await initSqlJs();

  // Open existing DB or create empty one
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    rawDb = new SQL.Database(buf);
  } else {
    rawDb = new SQL.Database();
  }

  // Enable foreign keys
  rawDb.run("PRAGMA foreign_keys = ON;");

  wrapped = makeWrapper();

  // Save on process exit (best-effort)
  const onExit = () => { flushSave(); };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  process.on('beforeExit', onExit);

  // ── LICENSE STATE ──────────────────────────────────────────
  // Single-row table (CHECK id = 1) holding the per-install license
  // state. On first boot, ./license.js inserts a row with a fresh
  // install_id and a 30-day trial expiry. The dev's signed tokens
  // bump expires_at when applied via /api/license/apply.
  //
  // active_token stores the most recently applied token verbatim so
  // an operator can copy it back out if they need to re-apply on a
  // restored backup, and so the dev can audit who has what.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS license_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    install_id TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    active_token TEXT
  )`);

  // ── SESSIONS ───────────────────────────────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_used_at TEXT DEFAULT (datetime('now','localtime')),
    device_label TEXT DEFAULT '',
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // ── USERS ──────────────────────────────────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    token TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── TRADERS (NAM.DBF — sellers/poolers) ────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS traders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cr TEXT DEFAULT '',
    pan TEXT DEFAULT '',
    tel TEXT DEFAULT '',
    aadhar TEXT DEFAULT '',
    padd TEXT DEFAULT '',
    ppla TEXT DEFAULT '',
    pin TEXT DEFAULT '',
    pstate TEXT DEFAULT '',
    pst_code TEXT DEFAULT '',
    ifsc TEXT DEFAULT '',
    acctnum TEXT DEFAULT '',
    holder_name TEXT DEFAULT '',
    whatsapp TEXT DEFAULT '',
    email TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── TRADER BANKS ───────────────────────────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS trader_banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trader_id INTEGER NOT NULL,
    bank_name TEXT DEFAULT '',
    branch TEXT DEFAULT '',
    acctnum TEXT NOT NULL,
    ifsc TEXT NOT NULL,
    holder_name TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    FOREIGN KEY (trader_id) REFERENCES traders(id)
  )`);

  // ── BUYERS (SBL.DBF — buyers/dealers/traders) ──────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS buyers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer TEXT NOT NULL,
    buyer1 TEXT DEFAULT '',
    code TEXT DEFAULT '',
    sbl TEXT DEFAULT '',
    add1 TEXT DEFAULT '',
    add2 TEXT DEFAULT '',
    pla TEXT DEFAULT '',
    pin TEXT DEFAULT '',
    state TEXT DEFAULT '',
    st_code TEXT DEFAULT '',
    gstin TEXT DEFAULT '',
    pan TEXT DEFAULT '',
    tel TEXT DEFAULT '',
    ti TEXT DEFAULT '',
    sale TEXT DEFAULT 'L',
    email TEXT DEFAULT '',
    tdsq TEXT DEFAULT '',
    cbuyer1 TEXT DEFAULT '',
    cadd1 TEXT DEFAULT '',
    cadd2 TEXT DEFAULT '',
    cpla TEXT DEFAULT '',
    cpin TEXT DEFAULT '',
    cstate TEXT DEFAULT '',
    cst_code TEXT DEFAULT '',
    cgstin TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── AUCTIONS (trade sessions) ──────────────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS auctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ano TEXT NOT NULL,
    date TEXT NOT NULL,
    crop_type TEXT DEFAULT '',
    state TEXT DEFAULT '',
    start_time TEXT,
    end_time TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    -- Stamped by /api/price-check/verify when the operator has verified
    -- the auction's lots against an external price sheet AND cleared
    -- every code-level discrepancy. Acts as the green-light gate for
    -- calculate / invoice / purchase / bill / debit-note generation.
    -- Auto-cleared by any endpoint that mutates lot price or code.
    price_checked_at TEXT DEFAULT '',
    -- Set on the FIRST successful price-check verify; never cleared
    -- afterwards. Lets the gate distinguish "never verified" (hard
    -- block on transactions) from "verified once but now stale"
    -- (soft warning only — buttons stay clickable).
    price_checked_ever_at TEXT DEFAULT '',
    -- Stamped by /api/auctions/:id/validate-lots/confirm when the
    -- operator has validated the ENTERED lots (no duplicate lot numbers,
    -- every lot has a seller) AND acknowledged any warnings (sellers
    -- missing GSTIN / bank / PAN / phone). Acts as the green-light gate
    -- for PRICE IMPORT (auctions/import mode='price'). Auto-cleared by any
    -- endpoint that inserts/edits/deletes a lot, so re-validation is
    -- required after every change. Gated by the flag_lot_validation flag.
    lots_validated_at TEXT DEFAULT ''
  )`);

  // ── LOTS (CPA1.DBF — main lot data, before + after trade) ─
  wrapped.exec(`CREATE TABLE IF NOT EXISTS lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL,
    lot_no TEXT NOT NULL,
    crop TEXT DEFAULT '',
    grade TEXT DEFAULT '',
    crpt TEXT DEFAULT '',
    branch TEXT DEFAULT '',
    state TEXT DEFAULT 'TAMIL NADU',
    trader_id INTEGER,
    name TEXT DEFAULT '',
    padd TEXT DEFAULT '',
    ppla TEXT DEFAULT '',
    ppin TEXT DEFAULT '',
    pstate TEXT DEFAULT '',
    pst_code TEXT DEFAULT '',
    cr TEXT DEFAULT '',
    pan TEXT DEFAULT '',
    tel TEXT DEFAULT '',
    aadhar TEXT DEFAULT '',
    bags INTEGER DEFAULT 0,
    litre TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    gross_wt REAL DEFAULT 0,
    sample_wt REAL DEFAULT 0,
    moisture TEXT DEFAULT '',
    price REAL DEFAULT 0,
    -- Reserved / floor price entered at lot-entry time. Gated by
    -- flag_reserved_price on the client; the column always exists so
    -- toggling the flag later doesn't lose data. User types this
    -- per-lot (no auto-increment). Surfaces in column L of the
    -- e-Auction (Spices Board) CSV.
    reserved_price REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    code TEXT DEFAULT '',
    buyer TEXT DEFAULT '',
    buyer1 TEXT DEFAULT '',
    sale TEXT DEFAULT '',
    invo TEXT DEFAULT '',
    pqty REAL DEFAULT 0,
    prate REAL DEFAULT 0,
    puramt REAL DEFAULT 0,
    com REAL DEFAULT 0,
    sertax REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    dcgst REAL DEFAULT 0,
    dsgst REAL DEFAULT 0,
    digst REAL DEFAULT 0,
    refud REAL DEFAULT 0,
    refund REAL DEFAULT 0,
    advance REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    bilamt REAL DEFAULT 0,
    paid TEXT DEFAULT '',
    user_id TEXT DEFAULT '',
    bank_id INTEGER,
    -- Immediate-payment flag (per lot). When 1, the seller is settled
    -- immediately and the early-payment discount is calculated for the
    -- lot; when 0 the lot's discount is 0. Also added via ALTER for
    -- older DBs in the migrations block below.
    immediate_payment INTEGER DEFAULT 0,
    -- Record-lock columns (also added via ALTER for older DBs in the
    -- migrations block below). See POST /api/lots/lock in server.js for
    -- semantics. Defined here so fresh DBs get the columns + the
    -- idx_lots_locked index on the very first boot.
    locked_at TEXT DEFAULT NULL,
    locked_by TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (auction_id) REFERENCES auctions(id),
    FOREIGN KEY (trader_id) REFERENCES traders(id)
  )`);

  // ── INVOICES (INV.DBF — sales invoices) ────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER,
    ano TEXT NOT NULL,
    date TEXT NOT NULL,
    state TEXT DEFAULT '',
    sale TEXT DEFAULT 'L',
    invo TEXT NOT NULL,
    buyer TEXT DEFAULT '',
    buyer1 TEXT DEFAULT '',
    gstin TEXT DEFAULT '',
    place TEXT DEFAULT '',
    lot TEXT DEFAULT '',
    bag INTEGER DEFAULT 0,
    qty REAL DEFAULT 0,
    price REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    gunny REAL DEFAULT 0,
    pava_hc REAL DEFAULT 0,
    ins REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    tcs REAL DEFAULT 0,
    rund REAL DEFAULT 0,
    tot REAL DEFAULT 0,
    addl_chg REAL DEFAULT 0,
    addl_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── PURCHASES (PURCHASE.DBF — purchase invoices for registered dealers)
  wrapped.exec(`CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER,
    ano TEXT NOT NULL,
    date TEXT NOT NULL,
    state TEXT DEFAULT '',
    br TEXT DEFAULT '',
    name TEXT DEFAULT '',
    add_line TEXT DEFAULT '',
    place TEXT DEFAULT '',
    gstin TEXT DEFAULT '',
    invo TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    rund REAL DEFAULT 0,
    total REAL DEFAULT 0,
    tds REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── BILLS (BILL.DBF — bills of supply for unregistered/agriculturist)
  wrapped.exec(`CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ano TEXT NOT NULL,
    date TEXT NOT NULL,
    state TEXT DEFAULT '',
    br TEXT DEFAULT '',
    crpt TEXT DEFAULT '',
    bil INTEGER DEFAULT 0,
    name TEXT DEFAULT '',
    add_line TEXT DEFAULT '',
    pla TEXT DEFAULT '',
    pstate TEXT DEFAULT '',
    st_code TEXT DEFAULT '',
    crr TEXT DEFAULT '',
    pan TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    net REAL DEFAULT 0,
    -- Per-lot snapshot (JSON) captured at generation time so the Bill of
    -- Supply PDF can always render the LOT NO / PRICE / VALUE columns even
    -- if the underlying lots are later edited, deleted, or re-imported.
    line_items TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── DEBIT NOTES ────────────────────────────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS debit_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ano TEXT NOT NULL,
    date TEXT NOT NULL,
    state TEXT DEFAULT '',
    name TEXT DEFAULT '',
    note_no TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    total REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── DEBIT NOTES — PLANTER ──────────────────────────────────
  // Same schema as `debit_notes`, but scoped to PLANTER / agriculturist
  // sellers (sourced from the `bills` / bills-of-supply table) rather than
  // registered-dealer purchases. Kept in a separate table so the two DN
  // streams have independent trade-wise numbering and never collide.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS debit_notes_planter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ano TEXT NOT NULL,
    date TEXT NOT NULL,
    state TEXT DEFAULT '',
    name TEXT DEFAULT '',
    note_no TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    total REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── ROUTE DISTANCES (e-way bill <DISTANCE> field) ──────────
  // Saved per (from_pin, to_pin) pair, normalised so the smaller PIN
  // is always stored first — that way A↔B and B↔A share one row. Used
  // by the To Tally → 🗺️ E-way Bill Distance UI: user looks up the
  // distance once on the NIC portal, types it in, and every invoice
  // between the same two PINs (this auction and all future ones) picks
  // it up automatically.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS route_distances (
    from_pin TEXT NOT NULL,
    to_pin TEXT NOT NULL,
    km INTEGER NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (from_pin, to_pin)
  )`);

  // ── LOT ALLOCATIONS (per-trade per-branch lot-number ranges) ──
  // Each row reserves a contiguous range of lot numbers (e.g. 001-080)
  // for one branch within one trade. The Lot Entry workflow validates
  // every saved lot's lot_no against these ranges so two field-staff
  // users in different branches can't collide on the same lot number.
  // Ranges are inclusive on both ends and may have an optional alpha
  // prefix (e.g. A001-A080) — see parseLotNo() in server.js.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS lot_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    start_lot TEXT NOT NULL,
    end_lot TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (auction_id) REFERENCES auctions(id)
  )`);

  // ── AUDIT LOG ──────────────────────────────────────────────
  wrapped.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── LOGIN HISTORY ──────────────────────────────────────────
  // Per-login tracking: IP, device type, username. Used by:
  //   - the desktop admin Users → Login History panel
  //   - the mobile bridge's /api/auth/login (writes a row each login)
  // Capped to last ~100 entries per user by the login handler.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // ── IMPORT LOG (Task 8 — "Import Old Data") ───────────────
  // One row per import run (preview, dry-run, or actual import). Used
  // by the Import Old Data → History panel so the admin can audit
  // what was imported, when, by whom, and how many rows landed.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT NOT NULL,
    filename TEXT DEFAULT '',
    dry_run INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    imported INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    errors TEXT DEFAULT '',
    user_id INTEGER,
    username TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    -- JSON array of target-table primary key IDs created by this import.
    -- Drives the "Undo this import" action on the Import Old Data screen:
    -- to roll back, we DELETE rows in the target table whose id is in
    -- this list, snapshot the DB first, then stamp undone_at.
    inserted_ids TEXT DEFAULT '',
    undone_at TEXT DEFAULT ''
  )`);

  // ── GRADE-2 BOOKING ALERTS ─────────────────────────────────
  // One row per fired alert. Existence of rows IS the per-auction state
  // machine: no 'manager' row for an auction → the manager alert can still
  // fire; a 'manager' row present + grade-2 weight has grown since → the
  // 'superior' escalation can fire. Each (auction_id, level) fires once.
  // `channels` is a JSON blob recording per-channel send status (inapp /
  // whatsapp / email). Written by grade2-alerts.js; surfaced in-app via
  // GET /api/grade2-alerts and acknowledged via POST /api/grade2-alerts/:id/ack.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS grade2_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL,
    level TEXT NOT NULL,                -- 'manager' | 'superior'
    grade2_weight REAL DEFAULT 0,
    total_weight REAL DEFAULT 0,
    ratio REAL DEFAULT 0,               -- grade2_weight / total_weight (0..1)
    threshold REAL DEFAULT 0,           -- threshold ratio in effect (0..1)
    lot_count INTEGER DEFAULT 0,
    message TEXT DEFAULT '',
    channels TEXT DEFAULT '',           -- JSON: { inapp, whatsapp, email } statuses
    acknowledged_at TEXT DEFAULT NULL,
    acknowledged_by TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (auction_id) REFERENCES auctions(id)
  )`);
  wrapped.exec(
    'CREATE INDEX IF NOT EXISTS idx_grade2_alerts_auction ON grade2_alerts(auction_id, level)'
  );

  // Records each lot-range reassignment so the tile UI can flag
  // recently-moved lots and admins can audit branch transfers.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS reassign_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL,
    from_branch TEXT NOT NULL,
    to_branch TEXT NOT NULL,
    start_lot TEXT NOT NULL,
    end_lot TEXT NOT NULL,
    user_id INTEGER,
    username TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Forensic record of every "Delete All" wipe. Captures the operator,
  // the affected resource, how many rows actually went away, where the
  // pre-wipe backup landed, and the client IP — so a misclick can be
  // traced and recovered from the snapshot.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS delete_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource TEXT NOT NULL,
    deleted_count INTEGER DEFAULT 0,
    cascade_counts TEXT DEFAULT '',
    backup_path TEXT DEFAULT '',
    user_id INTEGER,
    username TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── GST LOOKUP API STATE (gstincheck.co.in credits cache) ──
  // Single-row cache (id pinned to 1) of the last-observed credit/quota
  // envelope from the GST lookup API. Refreshed opportunistically on every
  // real GSTIN lookup so the Settings → Integrations card + topbar pill can
  // render "X searches left" without burning a paid lookup. last_response_raw
  // stores the trimmed JSON envelope (minus the large `data` blob) for audit.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS gst_api_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credits_remaining INTEGER,
    credits_total INTEGER,
    plan_expires_at TEXT,
    last_checked_at TEXT,
    last_response_raw TEXT
  )`);

  // ── WHATSAPP CLOUD API ─────────────────────────────────────
  // Single-row credential + template store (id pinned to 1). DB-side
  // fallback for the WhatsApp config; process.env values take priority at
  // read time (see _waConfig in server.js). Kept OUT of company_settings on
  // purpose — that table is exposed to the browser via the settings flat
  // endpoint, and the access token / app secret must never reach the client.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS whatsapp_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT DEFAULT '',
    phone_id TEXT DEFAULT '',
    waba_id TEXT DEFAULT '',
    app_secret TEXT DEFAULT '',
    verify_token TEXT DEFAULT '',
    display_number TEXT DEFAULT '',
    tpl_document TEXT DEFAULT '',
    tpl_document_lang TEXT DEFAULT 'en',
    tpl_text TEXT DEFAULT '',
    tpl_text_lang TEXT DEFAULT 'en',
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  wrapped.exec("INSERT OR IGNORE INTO whatsapp_config (id) VALUES (1)");

  // Outbound/inbound message log. Every Cloud send inserts a row; the Meta
  // webhook later updates `status`/`error` by `wamid` as delivery receipts
  // arrive (sent → delivered → read, or failed). `ref_type`/`ref_id` tie a
  // message back to the purchase/invoice/debit-note it was sent for.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wamid TEXT DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'out',
    phone TEXT DEFAULT '',
    msg_type TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    status TEXT DEFAULT 'queued',
    error TEXT DEFAULT '',
    ref_type TEXT DEFAULT '',
    ref_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Inbound messages (replies) recorded from the webhook. Primarily a log;
  // also signals that a contact's 24h customer-service window is open.
  wrapped.exec(`CREATE TABLE IF NOT EXISTS whatsapp_inbound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wamid TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    body TEXT DEFAULT '',
    received_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── INDEXES ────────────────────────────────────────────────
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_traders_name ON traders(name)',
    'CREATE INDEX IF NOT EXISTS idx_lots_auction ON lots(auction_id)',
    'CREATE INDEX IF NOT EXISTS idx_lots_lot ON lots(lot_no)',
    'CREATE INDEX IF NOT EXISTS idx_lots_name ON lots(name)',
    'CREATE INDEX IF NOT EXISTS idx_lots_buyer ON lots(buyer)',
    'CREATE INDEX IF NOT EXISTS idx_lots_sale ON lots(sale)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_sale ON invoices(sale, invo)',
    'CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date)',
    'CREATE INDEX IF NOT EXISTS idx_purchases_name ON purchases(name)',
    'CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(date)',
    'CREATE INDEX IF NOT EXISTS idx_bills_name ON bills(name)',
    'CREATE INDEX IF NOT EXISTS idx_buyers_buyer ON buyers(buyer)',
    'CREATE INDEX IF NOT EXISTS idx_buyers_buyer1 ON buyers(buyer1)',
    'CREATE INDEX IF NOT EXISTS idx_lot_alloc_auction ON lot_allocations(auction_id)',
    'CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_login_history_created ON login_history(created_at DESC)',
    // Fast lookup for seller uniqueness checks (cr / tel / pan are the
    // de-dup keys used by the unified create-seller path).
    'CREATE INDEX IF NOT EXISTS idx_traders_cr  ON traders(cr)',
    'CREATE INDEX IF NOT EXISTS idx_traders_tel ON traders(tel)',
    'CREATE INDEX IF NOT EXISTS idx_traders_pan ON traders(pan)',
    // FK child-side index. SQLite auto-indexes the parent side of a FK
    // (traders.id is PK) but not the child column, so every DELETE FROM
    // traders triggers a full scan of trader_banks to check for orphans.
    // Without this, bulk seller deletion is O(N·M) — quadratic.
    'CREATE INDEX IF NOT EXISTS idx_trader_banks_trader ON trader_banks(trader_id)',
    // Webhook delivery-receipt updates look up the originating send by its
    // Meta message id; the send-log panel filters by recipient.
    'CREATE INDEX IF NOT EXISTS idx_wa_messages_wamid ON whatsapp_messages(wamid)',
    'CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(phone)',
  ];
  for (const idx of indexes) { try { wrapped.exec(idx); } catch (e) {} }

  // ── MIGRATIONS (for existing databases created before schema changes) ──
  const migrations = [
    // Per-import undo: existing DBs need the two new columns added so
    // the Undo button on the History panel can find inserted rows and
    // mark the entry as rolled back.
    "ALTER TABLE import_log ADD COLUMN inserted_ids TEXT DEFAULT ''",
    "ALTER TABLE import_log ADD COLUMN undone_at TEXT DEFAULT ''",
    // Bank branch name — populated by the IFSC auto-lookup in seller edit.
    "ALTER TABLE trader_banks ADD COLUMN branch TEXT DEFAULT ''",
    // Price-check gate timestamp — see auctions schema for semantics.
    "ALTER TABLE auctions ADD COLUMN price_checked_at TEXT DEFAULT ''",
    "ALTER TABLE auctions ADD COLUMN price_checked_ever_at TEXT DEFAULT ''",
    'ALTER TABLE purchases ADD COLUMN auction_id INTEGER',
    'ALTER TABLE invoices ADD COLUMN auction_id INTEGER',
    'ALTER TABLE bills ADD COLUMN auction_id INTEGER',
    "ALTER TABLE bills ADD COLUMN line_items TEXT DEFAULT ''",
    'ALTER TABLE debit_notes ADD COLUMN auction_id INTEGER',
    "ALTER TABLE buyers ADD COLUMN code TEXT DEFAULT ''",
    "ALTER TABLE buyers ADD COLUMN cadd2 TEXT DEFAULT ''",
    "ALTER TABLE buyers ADD COLUMN email TEXT DEFAULT ''",
    "ALTER TABLE buyers ADD COLUMN tdsq TEXT DEFAULT ''",
    "ALTER TABLE buyers ADD COLUMN sbl TEXT DEFAULT ''",
    // Discount GST columns (per-lot, when flag_disc_gst is ON)
    'ALTER TABLE lots ADD COLUMN dcgst REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN dsgst REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN digst REAL DEFAULT 0',
    // Reserved price — gated by flag_reserved_price on the client.
    // See lots schema for semantics. The leading control_price ADD
    // covers installs that briefly seeded that name (single dev cycle);
    // the UPDATE migrates any values; then reserved_price is added.
    'ALTER TABLE lots ADD COLUMN control_price REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN reserved_price REAL DEFAULT 0',
    'UPDATE lots SET reserved_price = control_price WHERE reserved_price = 0 AND control_price > 0',
    // ASP invoice traceability — when a lot is first invoiced as an ASP
    // sale (state=Kerala), `lots.invo` gets the ASP invoice number AND a
    // copy is preserved here. Then when the same lot is invoiced as an
    // ISP sale (state=Tamil Nadu) later, `lots.invo` is overwritten with
    // the ISP invoice number, but `lots.asp_invo` keeps the original ASP
    // ref. This lets the sales list show both numbers side-by-side.
    "ALTER TABLE lots ADD COLUMN asp_invo TEXT DEFAULT ''",
    // ── Dual-view planter calculation columns ─────────────────
    // calculateLot() chooses ISP vs ASP rules based on cfg.business_state,
    // then writes the active view into pqty/prate/puramt. The Tally URD
    // voucher needs ISP values regardless of which mode dad is currently in,
    // so we now ALWAYS persist BOTH calculations on every save:
    //   isp_pqty/isp_prate/isp_puramt → planter side as ISP would compute
    //   asp_pqty/asp_prate/asp_puramt → planter side as ASP would compute
    // The legacy pqty/prate/puramt columns continue to mirror whichever
    // matches the current business_state, so the existing UI / reports /
    // exports keep working unchanged. Reports that need a specific view
    // (like the URD Tally voucher) read the prefixed columns directly.
    'ALTER TABLE lots ADD COLUMN isp_pqty REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN isp_prate REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN isp_puramt REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN asp_pqty REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN asp_prate REAL DEFAULT 0',
    'ALTER TABLE lots ADD COLUMN asp_puramt REAL DEFAULT 0',
    // Per-lot bank pin — used by the mobile PWA workflow so a seller with
    // multiple bank accounts can have a specific one stamped on each lot.
    // Falls back to the trader's default bank (trader_banks.is_default=1)
    // for lots that don't pin one explicitly.
    'ALTER TABLE lots ADD COLUMN bank_id INTEGER',
    // Trader contact channels added in the mobile PWA workflow. Both
    // optional; whatsapp falls back to tel in the UI when blank.
    "ALTER TABLE traders ADD COLUMN whatsapp TEXT DEFAULT ''",
    "ALTER TABLE traders ADD COLUMN email TEXT DEFAULT ''",
    // Distance for e-way bill <DISTANCE> field on ISP sales vouchers.
    // Populated manually per-invoice from the To Tally → 🗺️ E-way Bill
    // Distance UI: user looks up the value on NIC's Pin-to-Pin Distance
    // Search page (or Google Maps), pastes it here, clicks Save. Value
    // is then emitted verbatim on the next voucher regen.
    'ALTER TABLE invoices ADD COLUMN distance_km INTEGER',
    // Additional Charge — sum(cardamom) × cfg.addl_charge_value, sits
    // below the Round on/off line. addl_name carries the user-defined
    // ledger label (also used as the Tally ledger name in XML).
    "ALTER TABLE invoices ADD COLUMN addl_chg REAL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN addl_name TEXT DEFAULT ''",
    // Per-invoice lorry / truck number. Set from the Invoices tab via a
    // bulk-action button; emitted into the e-way bill <VEHICLENUMBER>
    // (and BASICSHIPVESSELNO) fields when generating sales vouchers
    // so dad doesn't have to type it into Tally manually.
    'ALTER TABLE invoices ADD COLUMN lorry_no TEXT',
    // Drop legacy pincodes/pin_distances tables that supported the old
    // haversine auto-compute path. We replaced that with the manual-
    // override workflow (above), so these tables are now dead weight.
    // IF EXISTS makes this idempotent — fresh DBs have nothing to drop;
    // upgraded DBs shed the orphan tables on next restart.
    'DROP TABLE IF EXISTS pin_distances',
    'DROP TABLE IF EXISTS pincodes',
    // One-time data fix: backfill the denormalised seller columns on
    // lots that were entered via the mobile PWA before the POST /api/lots
    // handler started copying from `traders`. UPDATE..FROM isn't supported
    // by older SQLite builds bundled with sql.js, so we use correlated
    // subqueries. Idempotent — the WHERE clause only touches lots whose
    // denormalised column is empty (or NULL) AND a trader row exists.
    `UPDATE lots SET name = (SELECT name FROM traders WHERE traders.id = lots.trader_id)
       WHERE (name IS NULL OR name = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET cr = (SELECT cr FROM traders WHERE traders.id = lots.trader_id)
       WHERE (cr IS NULL OR cr = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET pan = (SELECT pan FROM traders WHERE traders.id = lots.trader_id)
       WHERE (pan IS NULL OR pan = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET tel = (SELECT tel FROM traders WHERE traders.id = lots.trader_id)
       WHERE (tel IS NULL OR tel = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET padd = (SELECT padd FROM traders WHERE traders.id = lots.trader_id)
       WHERE (padd IS NULL OR padd = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET ppla = (SELECT ppla FROM traders WHERE traders.id = lots.trader_id)
       WHERE (ppla IS NULL OR ppla = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET ppin = (SELECT pin FROM traders WHERE traders.id = lots.trader_id)
       WHERE (ppin IS NULL OR ppin = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET pstate = (SELECT pstate FROM traders WHERE traders.id = lots.trader_id)
       WHERE (pstate IS NULL OR pstate = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET pst_code = (SELECT pst_code FROM traders WHERE traders.id = lots.trader_id)
       WHERE (pst_code IS NULL OR pst_code = '') AND trader_id IS NOT NULL`,
    `UPDATE lots SET aadhar = (SELECT aadhar FROM traders WHERE traders.id = lots.trader_id)
       WHERE (aadhar IS NULL OR aadhar = '') AND trader_id IS NOT NULL`,
    // Per-lot record lock. When locked_at is set, the row becomes
    // uneditable for non-admins, both directly (PUT/DELETE /api/lots,
    // bulk lot mutations, calculate) and indirectly (sales invoice /
    // purchase / debit-note edit/delete/revert that would touch the lot).
    // Admins can always edit. Only an admin can clear the lock.
    // locked_by carries the username of whoever set the lock — purely
    // for audit/UI display; permission is decided from req.user.role.
    // The whole feature collapses to a no-op when flag_lot_lock is off.
    'ALTER TABLE lots ADD COLUMN locked_at TEXT DEFAULT NULL',
    'ALTER TABLE lots ADD COLUMN locked_by TEXT DEFAULT NULL',
    // Immediate-payment flag — drives whether the per-lot early-payment
    // discount is calculated (only computed for lots flagged 1).
    'ALTER TABLE lots ADD COLUMN immediate_payment INTEGER DEFAULT 0',
    // Lot-validation gate (flag_lot_validation). Stamped on a clean
    // "Validate Entered Lots" confirm; cleared by any lot insert/edit/
    // delete. Blocks price import (mode='price') until re-validated.
    "ALTER TABLE auctions ADD COLUMN lots_validated_at TEXT DEFAULT ''",
  ];
  for (const m of migrations) {
    try { wrapped.exec(m); console.log('Migration applied:', m); }
    catch (e) { /* column already exists — ignore */ }
  }

  // Index on locked_at — used by the Lots tab list sort/filter and by
  // the cascade-lock helpers (lotsLockedFor*) that scan by auction +
  // buyer/seller with locked_at NOT NULL. Created here (after the
  // ALTERs ran) so upgrades to an existing DB still get the index
  // without depending on the column having been declared in CREATE.
  try { wrapped.exec('CREATE INDEX IF NOT EXISTS idx_lots_locked ON lots(locked_at)'); }
  catch (_) { /* index may already exist — ignore */ }

  // One-time data fix: legacy ASP-only lots (where invo==asp_invo) had their
  // `sale` field set during the old ASP-generation logic. The current logic
  // doesn't set it (so ISP can pick the right sale type per buyer). Clear
  // those legacy rows so they show up in ISP eligibility.
  // Idempotent: subsequent runs do nothing because the rows are already
  // cleared. Safe to run on a fresh DB (no rows match the WHERE).
  try {
    const fix = wrapped.run(
      `UPDATE lots SET sale = ''
       WHERE asp_invo IS NOT NULL AND asp_invo != ''
         AND invo = asp_invo
         AND sale IS NOT NULL AND sale != ''`
    );
    if (fix && fix.changes > 0) {
      console.log(`Migration: cleared sale on ${fix.changes} ASP-only lots so ISP eligibility works`);
    }
  } catch (e) { /* ignore — column may not exist on first run */ }

  // One-time data fix: legacy invoices were stamped with the auction's
  // state (TAMIL NADU/KERALA based on physical auction location), not the
  // business context state. Retag them so the sales list can correctly
  // distinguish ASP rows from ISP rows.
  //
  // Heuristic per invoice:
  //   - If the invoice's `invo` equals `lots.asp_invo` for any of its
  //     buyer/auction lots AND those lots' current `invo` differs from
  //     `asp_invo` → invoice was the ASP step (stamp KERALA).
  //   - Else if any of those lots have `asp_invo == invo == this invoice's
  //     invo` → ASP-only run (stamp KERALA).
  //   - Otherwise → ISP invoice (stamp TAMIL NADU).
  // Safe-by-default: only updates rows we can confidently classify.
  // Idempotent: re-running produces the same labels.
  try {
    const allInvs = wrapped.all('SELECT id, auction_id, buyer, invo FROM invoices');
    let aspCount = 0, ispCount = 0;
    for (const inv of allInvs) {
      const lotMatches = wrapped.all(
        `SELECT invo, asp_invo FROM lots
         WHERE auction_id = ? AND buyer = ?
           AND (invo = ? OR asp_invo = ?)`,
        [inv.auction_id, inv.buyer, inv.invo, inv.invo]
      );
      // Determine state: ASP if this invoice matches asp_invo on any lot,
      // ISP otherwise (lots have a different ISP invo and asp_invo links
      // back to this row).
      let isASP = false;
      for (const l of lotMatches) {
        if (l.asp_invo === inv.invo) { isASP = true; break; }
        // If lot's invo == this inv's invo AND lot's asp_invo is empty,
        // this is most likely an ISP-only invoice — but COULD be an ASP
        // run pre-asp_invo column. Default to ISP context (TN).
      }
      const newState = isASP ? 'KERALA' : 'TAMIL NADU';
      wrapped.run('UPDATE invoices SET state = ? WHERE id = ?', [newState, inv.id]);
      if (isASP) aspCount++; else ispCount++;
    }
    if (aspCount + ispCount > 0) {
      console.log(`Migration: retagged ${aspCount} invoices as KERALA (ASP) and ${ispCount} as TAMIL NADU (ISP) based on lot lineage`);
    }
  } catch (e) { /* table may not exist on fresh DB — ignore */ }

  const row = wrapped.get('SELECT COUNT(*) as cnt FROM users');
  if (!row || row.cnt === 0) {
    const hash = crypto.createHash('sha256').update('admin123').digest('hex');
    wrapped.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['admin', hash, 'admin']);
    console.log('Default admin created (admin / admin123)');
  }

  console.log('Database ready at', DB_PATH, '(better-sqlite3, WAL mode)');
  return wrapped;
}

/**
 * Normalize params so callers can pass either an array or spread arguments.
 * Accepts: fn('sql', [a, b, c])  OR  fn('sql', a, b, c)  OR  fn('sql')
 */
function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

function makeWrapper() {
  // sql.js note: prepared statements need .free() to release memory.
  // We create-use-free per call to keep the API simple and match the
  // existing usage patterns (no long-lived prepared statements).

  /**
   * Run a SQL with bound params and return rows as objects.
   * Internal helper used by get/all.
   */
  function execStatement(sql, params) {
    const stmt = rawDb.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  /**
   * Run an INSERT/UPDATE/DELETE/etc with bound params (no result rows).
   */
  function runStatement(sql, params) {
    const stmt = rawDb.prepare(sql);
    try {
      stmt.run(params);
    } finally {
      stmt.free();
    }
    // sql.js doesn't expose lastInsertRowid/changes per-statement easily.
    // Use the connection-level helpers.
    return {
      lastInsertRowid: rawDb.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] ?? 0,
      changes: rawDb.getRowsModified(),
    };
  }

  return {
    /**
     * Execute multi-statement SQL (no params, no return).
     */
    exec(sql) {
      rawDb.exec(sql);
      scheduleSave();
    },

    /**
     * Run an INSERT/UPDATE/DELETE. Accepts params as array or spread.
     */
    run(sql, ...rest) {
      const params = normalizeParams(rest);
      const info = runStatement(sql, params);
      scheduleSave();
      return info;
    },

    /**
     * SELECT one row. Returns row object or null.
     */
    get(sql, ...rest) {
      const params = normalizeParams(rest);
      const rows = execStatement(sql, params);
      return rows[0] || null;
    },

    /**
     * SELECT many rows. Returns array (possibly empty).
     */
    all(sql, ...rest) {
      const params = normalizeParams(rest);
      return execStatement(sql, params);
    },

    /**
     * Prepare a statement. sql.js doesn't naturally cache prepared
     * statements across reuses (and freeing too early causes errors),
     * so we re-prepare on each call. Slower than better-sqlite3 but
     * functionally equivalent.
     */
    prepare(sql) {
      return {
        run(...args) {
          const info = runStatement(sql, args);
          scheduleSave();
          return info;
        },
        get(...args) {
          const rows = execStatement(sql, args);
          return rows[0] || null;
        },
        all(...args) {
          return execStatement(sql, args);
        }
      };
    },

    /**
     * Wrap a function in a transaction. Implements via BEGIN/COMMIT/ROLLBACK.
     */
    transaction(fn) {
      return function (...args) {
        rawDb.run("BEGIN");
        try {
          const result = fn(...args);
          rawDb.run("COMMIT");
          scheduleSave();
          return result;
        } catch (e) {
          rawDb.run("ROLLBACK");
          throw e;
        }
      };
    },

    // Escape hatch — only for code that needs the raw sql.js Database.
    get raw() { return rawDb; }
  };
}

function getDb() {
  if (!wrapped) throw new Error('Call initDb() first');
  return wrapped;
}

function closeDb() {
  flushSave();
  if (rawDb) {
    rawDb.close();
    rawDb = null;
    wrapped = null;
  }
}

/**
 * Replace the entire database from a buffer (used by /api/system/restore).
 * Validates that the buffer is a SQLite file (header magic), opens it as a
 * fresh sql.js Database, persists to disk, then swaps it in. Throws on any
 * error so the caller can surface a clean message — the existing DB is left
 * untouched on failure.
 */
async function replaceFromBuffer(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // SQLite files start with "SQLite format 3\0" (16 bytes).
  const magic = buf.slice(0, 16).toString('utf8').replace(/\0+$/, '');
  if (magic !== 'SQLite format 3') {
    throw new Error('Uploaded file is not a valid SQLite database');
  }
  if (!SQL) SQL = await initSqlJs();
  // Sanity-check: must open without throwing.
  let test;
  try { test = new SQL.Database(buf); } catch (e) {
    throw new Error('SQLite file is corrupt or unreadable: ' + e.message);
  }
  // Quick integrity check
  try {
    const r = test.exec('PRAGMA integrity_check');
    const ok = r && r[0] && r[0].values && r[0].values[0] && r[0].values[0][0] === 'ok';
    if (!ok) throw new Error('integrity_check did not return "ok"');
  } catch (e) {
    test.close();
    throw new Error('Integrity check failed: ' + e.message);
  }
  // Flush any pending writes from the current DB before replacing it.
  flushSave();
  // Close the live DB and swap.
  if (rawDb) { try { rawDb.close(); } catch(_){} }
  rawDb = test;
  // Persist immediately so a crash right after restore doesn't lose it.
  try {
    const out = Buffer.from(rawDb.export());
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    throw new Error('Failed to persist restored DB: ' + e.message);
  }
  return { ok: true, size: buf.length };
}

module.exports = { initDb, getDb, closeDb, flushSave, replaceFromBuffer, DB_PATH };
