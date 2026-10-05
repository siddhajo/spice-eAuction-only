// RETIRED SETTINGS — the reconciliation that collapses two boxes into one.
//
// Thirteen keys on the To Tally screen were a second copy of a number the app
// was already configured with: tally_gunny_rate, tally_gst_rate,
// tally_insurance_rate, tally_tcs_rate and five tally_hsn_* twins (read only
// by tally-xml.js, with no fallback to the Rates / HSN screens the invoices
// bill from), plus four — tally_transport_rate, tally_local_trans_rate,
// tally_local_ins_rate, tally_sample_kgs — that had no reader at all.
//
// Retiring a key that an install may have FILLED IN is the delicate part.
// initCompanySettings reconciles each pair on boot, and the rules have to hold
// in both directions or somebody loses a rate or gets a silent change:
//
//   [carry]   canonical empty + retired set  → carry it over, so an install
//             that only ever used the Tally box keeps its number
//   [wins]    both set and DIFFERENT         → the canonical one wins (it is
//             what every invoice was billed at) and the change is announced
//   [quiet]   both set and the SAME          → nothing said, nothing written
//   [dead]    a retired key with no canonical twin is never carried anywhere
//   [again]   a second boot carries nothing — the whole thing is idempotent
//   [zero]    "empty" for a number setting means 0, not just blank:
//             getSettingsFlat turns an empty number box into 0
const os = require('os'), path = require('path'), fs = require('fs');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

// db.js reads SPICE_DATA_DIR at require time — set it before anything pulls it
// in, or this test mutates the live data/config.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-cfg-'));
process.env.SPICE_DATA_DIR = TMP;

const ROOT = path.join(__dirname, '..');
const { initDb, getDb, closeDb } = require(path.join(ROOT, 'db'));
const { initCompanySettings, RETIRED_SETTING_KEYS, DEFAULTS } =
  require(path.join(ROOT, 'company-config'));

// Run one boot's worth of settings init, capturing what it printed.
function boot(db) {
  const said = [];
  const real = console.log;
  console.log = (...a) => said.push(a.join(' '));
  try { initCompanySettings(db); } finally { console.log = real; }
  return said.join('\n');
}
const val = (db, k) => {
  const r = db.get('SELECT value FROM company_settings WHERE key = ?', [k]);
  return r ? r.value : null;
};
const setRetired = (db, k, v) => db.run(
  `INSERT INTO company_settings (key, value, category, label, field_type)
   VALUES (?, ?, 'tally', 'retired', 'number')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [k, v]);

(async () => {
  await initDb();
  const db = getDb();
  boot(db);

  console.log('[map] the retirement map is what the rest of this asserts on');
  {
    check('thirteen keys are retired', RETIRED_SETTING_KEYS.size === 13, String(RETIRED_SETTING_KEYS.size));
    check('four of them map to nothing — they had no reader at all',
      [...RETIRED_SETTING_KEYS.values()].filter(v => v === null).length === 4);
    const keys = new Set(DEFAULTS.map(d => d.key));
    const stillSeeded = [...RETIRED_SETTING_KEYS.keys()].filter(k => keys.has(k));
    check('none of them is seeded as a setting any more', stillSeeded.length === 0, JSON.stringify(stillSeeded));
    const missingTwin = [...RETIRED_SETTING_KEYS.values()].filter(v => v && !keys.has(v));
    check('every canonical twin it points at really exists', missingTwin.length === 0, JSON.stringify(missingTwin));
  }

  console.log('[carry] an install that only ever set the Tally box keeps its number');
  {
    db.run("UPDATE company_settings SET value = '0' WHERE key = 'insurance'");
    setRetired(db, 'tally_insurance_rate', '0.75');
    const said = boot(db);
    check('the value lands on the canonical key', val(db, 'insurance') === '0.75', val(db, 'insurance'));
    check('…and it is announced', /carried retired Tally setting/.test(said), said);
    check('…naming both sides', /insurance = 0\.75 \(from tally_insurance_rate\)/.test(said), said);
  }

  console.log('[again] a second boot carries nothing');
  {
    const said = boot(db);
    check('nothing is carried', !/carried retired Tally setting/.test(said), said);
    check('…and the value is untouched', val(db, 'insurance') === '0.75', val(db, 'insurance'));
  }

  console.log('[wins] when both are set and disagree, the invoice rate wins');
  {
    db.run("UPDATE company_settings SET value = '150' WHERE key = 'gunny_rate'");
    setRetired(db, 'tally_gunny_rate', '200');
    const said = boot(db);
    check('the canonical value is NOT overwritten', val(db, 'gunny_rate') === '150', val(db, 'gunny_rate'));
    check('…the retired row is left as it was', val(db, 'tally_gunny_rate') === '200', val(db, 'tally_gunny_rate'));
    check('…and the divergence is reported, not swallowed',
      /NOTICE: retired Tally setting/.test(said) && /tally_gunny_rate=200/.test(said), said);
    check('…saying which figure now applies', /gunny_rate=150/.test(said), said);
  }

  console.log('[quiet] agreeing values say nothing at all');
  {
    db.run("UPDATE company_settings SET value = '150' WHERE key = 'gunny_rate'");
    setRetired(db, 'tally_gunny_rate', '150');
    const said = boot(db);
    check('no notice', !/NOTICE: retired Tally setting/.test(said), said);
    check('no carry', !/carried retired Tally setting/.test(said), said);
  }
  {
    // 5 vs 5.0 is the same rate, and must not nag on every single boot.
    db.run("UPDATE company_settings SET value = '5' WHERE key = 'gst_goods'");
    setRetired(db, 'tally_gst_rate', '5.0');
    const said = boot(db);
    check('5 and 5.0 are the same number, not a divergence',
      !/NOTICE: retired Tally setting/.test(said), said);
  }

  console.log('[dead] a key that mapped to nothing is never carried anywhere');
  {
    setRetired(db, 'tally_transport_rate', '9.99');
    const before = val(db, 'transport');
    const said = boot(db);
    check('the Rates transport is untouched', val(db, 'transport') === before, `${before} -> ${val(db, 'transport')}`);
    check('…and nothing claims to have carried it', !/tally_transport_rate/.test(said), said);
  }

  console.log('[zero] an empty NUMBER box reads as 0, so 0 counts as empty');
  {
    for (const z of ['0', '0.0', '0.00', '', '  ']) {
      db.run("UPDATE company_settings SET value = ? WHERE key = 'insurance'", [z]);
      setRetired(db, 'tally_insurance_rate', '1.25');
      boot(db);
      check(`canonical ${JSON.stringify(z)} is treated as unset and takes the carry`,
        val(db, 'insurance') === '1.25', `${JSON.stringify(z)} -> ${val(db, 'insurance')}`);
    }
    // …but a real 0 that was deliberately typed on BOTH sides stays 0.
    db.run("UPDATE company_settings SET value = '0' WHERE key = 'insurance'");
    setRetired(db, 'tally_insurance_rate', '0');
    boot(db);
    check('two zeroes stay zero', val(db, 'insurance') === '0', val(db, 'insurance'));
  }

  closeDb();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
