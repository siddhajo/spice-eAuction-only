// Separate "blank voucher number" toggles for the RD and URD purchase XML.
//
// `tally_purchase_manual_voucherno` used to be ONE switch over both purchase
// vouchers. It is now two — `_rd` (dealer) and `_urd` (agriculturist) — so a
// site can hand-number one series in Tally while the other keeps its generated
// numbers. This pins each toggle to its own voucher, and pins the carry-over
// migration that upgrades an install which had the single flag ON.
const os = require('os'), path = require('path'), fs = require('fs');
const Database = require('better-sqlite3');
const { generRDPurchaseXML, generURDPurchaseXML } = require('../tally-xml');
const { initCompanySettings } = require('../company-config');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// Minimal rows — only the fields the voucher-number path reads have to be real.
const RD_ROW = {
  date: '2026-08-19', ano: '14', invo: '114', name: 'AAA TRADERS',
  gstin: '33AAAAA0000A1Z5', qtytot: 100, amounttot: 500000, rate: 5000,
  cgst: 0, sgst: 0, igst: 25000, total: 525000, lots: [],
};
const URD_ROW = {
  date: '2026-08-19', ano: '14', invo: '201', name: 'MURUGANANDAM K',
  qtytot: 71.7, amounttot: 227862.6, bilamttot: 227862.6, total: 227862.6, lots: [],
};
// The tag we care about; `<REFERENCE>` carries the same value.
const vchNo = xml => (xml.match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/) || [])[1];

console.log('[1] Each toggle blanks only its OWN voucher');
const rd  = cfg => vchNo(generRDPurchaseXML([RD_ROW], cfg));
const urd = cfg => vchNo(generURDPurchaseXML([URD_ROW], cfg));

const bothOff = {};
check('both OFF → RD keeps its generated number',  !!rd(bothOff),  JSON.stringify(rd(bothOff)));
check('both OFF → URD keeps its generated number', !!urd(bothOff), JSON.stringify(urd(bothOff)));

const rdOnly = { tally_purchase_manual_voucherno_rd: 'true' };
check('RD ON → RD voucher number is blank', rd(rdOnly) === '', JSON.stringify(rd(rdOnly)));
check('RD ON → URD is UNAFFECTED', !!urd(rdOnly), JSON.stringify(urd(rdOnly)));

const urdOnly = { tally_purchase_manual_voucherno_urd: 'true' };
check('URD ON → URD voucher number is blank', urd(urdOnly) === '', JSON.stringify(urd(urdOnly)));
check('URD ON → RD is UNAFFECTED', !!rd(urdOnly), JSON.stringify(rd(urdOnly)));

const bothOn = { tally_purchase_manual_voucherno_rd: 'true', tally_purchase_manual_voucherno_urd: 'true' };
check('both ON → both blank', rd(bothOn) === '' && urd(bothOn) === '');

console.log('\n[2] Legacy single flag still honoured as a fallback');
const legacy = { tally_purchase_manual_voucherno: 'true' };
check('legacy flag alone blanks RD',  rd(legacy) === '',  JSON.stringify(rd(legacy)));
check('legacy flag alone blanks URD', urd(legacy) === '', JSON.stringify(urd(legacy)));
const legacyOverridden = { tally_purchase_manual_voucherno: 'true', tally_purchase_manual_voucherno_rd: 'false' };
check('an explicit new key wins over the legacy flag (RD keeps its number)',
      !!rd(legacyOverridden), JSON.stringify(rd(legacyOverridden)));
check('…while the other voucher still follows the legacy flag',
      urd(legacyOverridden) === '', JSON.stringify(urd(legacyOverridden)));

console.log('\n[3] Settings migration carries the old value onto both keys');
function settingsAfterMigration(seedOldValue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvn-'));
  const db = new Database(path.join(dir, 't.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS company_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'company', label TEXT NOT NULL DEFAULT '',
    field_type TEXT NOT NULL DEFAULT 'text');`);
  if (seedOldValue != null) {
    db.prepare("INSERT INTO company_settings (key, value, category, label, field_type) VALUES (?,?,?,?,?)")
      .run('tally_purchase_manual_voucherno', seedOldValue, 'flags', 'legacy', 'boolean');
  }
  initCompanySettings(db);
  const get = k => {
    const r = db.prepare('SELECT value FROM company_settings WHERE key = ?').get(k);
    return r ? r.value : null;
  };
  const out = {
    legacy: get('tally_purchase_manual_voucherno'),
    rd:     get('tally_purchase_manual_voucherno_rd'),
    urd:    get('tally_purchase_manual_voucherno_urd'),
  };
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const upgraded = settingsAfterMigration('true');
check('an install with the old flag ON gets BOTH new toggles ON',
      upgraded.rd === 'true' && upgraded.urd === 'true', JSON.stringify(upgraded));
check('and the stale key is dropped from Settings', upgraded.legacy === null, JSON.stringify(upgraded));

const untouched = settingsAfterMigration('false');
check('an install with the old flag OFF gets both toggles OFF',
      untouched.rd === 'false' && untouched.urd === 'false', JSON.stringify(untouched));

const fresh = settingsAfterMigration(null);
check('a fresh install seeds both toggles OFF',
      fresh.rd === 'false' && fresh.urd === 'false' && fresh.legacy === null, JSON.stringify(fresh));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
