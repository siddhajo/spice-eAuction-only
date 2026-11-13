// scripts/portal-enrol.js — enrol parties in the customer portal, from the
// terminal, with no admin password and no browser console.
//
// The portal's admin API needs a signed-in admin, which means a token, which
// means either curl gymnastics or DevTools. Neither is a reasonable ask for
// "I just want to see it work", so this writes to the database directly.
//
// ── IT WILL REFUSE TO RUN WHILE THE SERVER IS UP ─────────────────────────
// The app holds the database in memory and flushes it on a debounce, so a
// write made underneath a running server is silently overwritten the next
// time it saves. Rather than produce that very confusing failure, this
// checks the port first and tells you to stop the server.
//
// Usage — stop the server, then:
//
//   node scripts/portal-enrol.js                    # what WOULD be enrolled
//   node scripts/portal-enrol.js --commit           # enrol every party
//                                                   # holding a document
//   node scripts/portal-enrol.js --commit \
//        --phone 9876543210 --party "GANESHBABU"    # ALSO link your own
//                                                   # number to that seller
//   node scripts/portal-enrol.js --list             # numbers worth testing
//   node scripts/portal-enrol.js --clear            # remove every link
//
// Then start the server again and open /my.
//
// Add --data <dir> to work on a copy instead of the live data/ directory.

const path = require('path');
const net = require('net');

const ROOT = path.dirname(__dirname);
process.chdir(ROOT);

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const DATA   = arg('data', '');
const PORT   = Number(arg('port', 3001));
const COMMIT = has('commit');
const CLEAR  = has('clear');
const LIST   = has('list');
const PHONE  = arg('phone', '');
const PARTY  = arg('party', '');

if (DATA) process.env.SPICE_DATA_DIR = path.resolve(DATA);

const phoneKey = (raw) => {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

// ── Is the server running? ────────────────────────────────────────────────
const portBusy = (port) => new Promise((resolve) => {
  const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  setTimeout(() => { s.destroy(); resolve(false); }, 800);
});

(async () => {
  if (!DATA && await portBusy(PORT)) {
    console.error(`
  The app is still running on port ${PORT}.

  It keeps the database in memory and saves on a debounce, so anything
  written here would be wiped the next time it saves. Stop the server
  (Ctrl-C in its window), re-run this, then start it again.

  Testing against a throwaway copy instead? Add:  --data /tmp/spice-copy
`);
    process.exit(1);
  }

  const { initDb, getDb, flushSave } = require('../db');
  // db.js narrates every migration it considers, which on a mature database
  // is a hundred lines of SQL. Useful in a server boot log, and pure noise in
  // front of the four numbers this script exists to print — so swallow it,
  // unless --verbose says otherwise or something actually goes wrong.
  const chatter = [];
  const realLog = console.log;
  if (!has('verbose')) console.log = (...a) => chatter.push(a.join(' '));
  try {
    await initDb();
  } catch (e) {
    console.log = realLog;
    chatter.forEach(l => realLog(l));
    throw e;
  }
  console.log = realLog;
  const db = getDb();

  const CLEAN = (c) => `substr(replace(replace(replace(replace(replace(IFNULL(${c},''),' ',''),'-',''),'+',''),'(',''),')',''), -10)`;

  if (CLEAR) {
    const n = db.get('SELECT COUNT(*) AS n FROM party_links').n;
    db.run('DELETE FROM party_links');
    db.run('DELETE FROM party_sessions');
    db.run('DELETE FROM party_otp');
    flushSave();
    console.log(`\n  Removed ${n} link(s). Nobody can sign in to the portal now.`);
    console.log('  (party_downloads is kept — it is the audit trail.)\n');
    process.exit(0);
  }

  if (LIST) {
    const rows = db.all(`
      SELECT l.phone_key, COUNT(*) AS parties,
             GROUP_CONCAT(COALESCE(t.name, b.buyer1, b.buyer), ' · ') AS names
        FROM party_links l
        LEFT JOIN traders t ON l.party_kind = 'seller' AND t.id = l.party_id
        LEFT JOIN buyers  b ON l.party_kind = 'buyer'  AND b.id = l.party_id
       WHERE l.status = 'active'
       GROUP BY l.phone_key ORDER BY parties DESC, l.phone_key LIMIT 12`);
    if (!rows.length) { console.log('\n  No links yet. Run with --commit first.\n'); process.exit(0); }
    console.log('\n  Numbers you can sign in with (busiest first):\n');
    for (const r of rows) {
      console.log(`    ${r.phone_key}   ${r.parties} part${r.parties === 1 ? 'y' : 'ies'}`);
      console.log(`                 ${String(r.names).slice(0, 110)}`);
    }
    console.log('\n  The sign-in code prints in the SERVER window, not on a phone.\n');
    process.exit(0);
  }

  // ── Who holds a document? ───────────────────────────────────────────────
  const sellers = db.all(`
    SELECT t.id, t.name, ${CLEAN('t.tel')} AS pkey FROM traders t
     WHERE LENGTH(${CLEAN('t.tel')}) = 10
       AND EXISTS (SELECT 1 FROM bills b WHERE b.trader_id = t.id
                   UNION ALL SELECT 1 FROM debit_notes_planter d WHERE d.trader_id = t.id)`);
  const buyers = db.all(`
    SELECT b.id, COALESCE(b.buyer1, b.buyer) AS name, ${CLEAN('b.tel')} AS pkey FROM buyers b
     WHERE LENGTH(${CLEAN('b.tel')}) = 10
       AND EXISTS (SELECT 1 FROM invoices i WHERE i.buyer_id = b.id AND COALESCE(i.is_proforma,0) = 0)`);

  const phones = new Map();
  [...sellers, ...buyers].forEach(r => phones.set(r.pkey, (phones.get(r.pkey) || 0) + 1));
  const sharedPhones = [...phones.values()].filter(n => n > 1).length;
  const sharedParties = [...phones.values()].filter(n => n > 1).reduce((a, b) => a + b, 0);

  console.log(`
  Sellers holding a document, with a phone : ${sellers.length}
  Buyers  holding an invoice, with a phone : ${buyers.length}
  Distinct numbers                          : ${phones.size}
  Numbers opening MORE THAN ONE party       : ${sharedPhones}  (${sharedParties} parties)`);

  if (!COMMIT && !PHONE) {
    console.log(`
  Nothing written — this was a dry run.
  Add --commit to enrol them.
`);
    process.exit(0);
  }

  let written = 0;
  const put = (kind, id, pkey, source) => {
    try {
      db.run(`INSERT INTO party_links (party_kind, party_id, phone_key, status, source, created_by)
              VALUES (?,?,?,'active',?,'portal-enrol script')`, [kind, id, pkey, source]);
      written += 1;
    } catch (e) { if (!/UNIQUE/i.test(e.message || '')) throw e; }   // already linked
  };

  if (COMMIT) {
    sellers.forEach(r => put('seller', r.id, r.pkey, 'seeded'));
    buyers.forEach(r => put('buyer', r.id, r.pkey, 'seeded'));
    console.log(`\n  Enrolled ${written} link(s).`);
  }

  // ── Link YOUR number to a named party, so you can test as yourself ──────
  if (PHONE) {
    const pkey = phoneKey(PHONE);
    if (!pkey) { console.error(`\n  "${PHONE}" is not a 10-digit number.\n`); process.exit(1); }
    if (!PARTY) { console.error('\n  --phone needs --party "<name to search for>"\n'); process.exit(1); }

    const like = `%${PARTY.toUpperCase()}%`;
    const hits = db.all(
      `SELECT 'seller' AS kind, t.id, t.name FROM traders t
        WHERE UPPER(t.name) LIKE ?
          AND EXISTS (SELECT 1 FROM bills b WHERE b.trader_id = t.id
                      UNION ALL SELECT 1 FROM debit_notes_planter d WHERE d.trader_id = t.id)
        UNION ALL
       SELECT 'buyer', b.id, COALESCE(b.buyer1, b.buyer) FROM buyers b
        WHERE UPPER(COALESCE(b.buyer1, b.buyer)) LIKE ?
          AND EXISTS (SELECT 1 FROM invoices i WHERE i.buyer_id = b.id AND COALESCE(i.is_proforma,0) = 0)
        LIMIT 20`, [like, like]);

    if (!hits.length) {
      console.error(`\n  No party holding a document matches "${PARTY}".`);
      console.error('  Try a shorter fragment of the name.\n');
      process.exit(1);
    }
    if (hits.length > 1) {
      console.log(`\n  "${PARTY}" matches ${hits.length} parties — be more specific:\n`);
      hits.forEach(h => console.log(`    ${h.kind.padEnd(7)} ${h.name}`));
      console.log('');
      process.exit(1);
    }
    const h = hits[0];
    put(h.kind, h.id, pkey, 'admin');
    console.log(`  Linked ${pkey} → ${h.name} (${h.kind}).`);
  }

  flushSave();

  console.log(`
  ────────────────────────────────────────────────────────────────
  Now start the server again and open  http://localhost:${PORT}/my

  Type the number, press "Send code", and the six digits appear in
  the SERVER's window, like this:

      [portal] OTP for ${PHONE ? phoneKey(PHONE) : '9876543210'}: 123456 (channel=log — TEST ONLY)

  There is no SMS or WhatsApp channel yet, so nothing reaches a
  handset. That is the whole reason the flag ships off.

  Numbers worth trying:   node scripts/portal-enrol.js --list
  Undo all of this:       node scripts/portal-enrol.js --clear
  ────────────────────────────────────────────────────────────────
`);
  process.exit(0);
})().catch(e => { console.error('\n  Failed:', e.message, '\n'); process.exit(1); });
