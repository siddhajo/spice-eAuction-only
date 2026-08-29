// A proforma draft is identified by INVOICE NO + BUYER + SALE TYPE.
//
// stampProformaRaised (server.js) resolves the draft on all three and stamps
// it by its own id. The rule exists because the draft series are numbered per
// sale type, so one trade routinely holds two drafts with the same number —
// trade 15 had a Local 33 (ERPL) and an Inter-state 33 (S KUMAR). Marking
// "draft 33" raised without checking whose, and in which series, stamped both;
// the buyer whose draft was never raised then vanished from the Collection
// register, because the report read the draft as superseded and no original
// existed to replace it.
//
//   [triple]  the right row is stamped when buyer + number + sale all match
//   [buyer]   another buyer's same-numbered draft is never touched
//   [series]  the same buyer's OTHER series draft is never touched
//   [change]  a draft raised under a different sale type is still stamped —
//             when that leaves exactly one candidate
//   [refuse]  when the number is ambiguous for one buyer across series and the
//             sale type matches neither, nothing is stamped rather than guessed
const os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'raise-id-'));
process.env.SPICE_DATA_DIR = TMP;   // db.js reads this — never the real data dir

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// The function under test lives in server.js, which starts an HTTP listener on
// require. Read it out of the source and evaluate just that declaration — the
// alternative is booting a server to exercise four lines of SQL.
function loadStamp() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = src.indexOf('function stampProformaRaised(');
  if (start < 0) throw new Error('stampProformaRaised not found in server.js');
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error('could not delimit stampProformaRaised');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end + 2)}; return stampProformaRaised;`)();
}

(async () => {
  const { initDb, getDb } = require(path.join(ROOT, 'db.js'));
  await initDb();
  const db = getDb();
  const stamp = loadStamp();

  db.run(`INSERT INTO auctions (ano, date, state) VALUES ('99','2026-08-29','TAMIL NADU')`);
  const aid = db.get('SELECT id FROM auctions ORDER BY id DESC LIMIT 1').id;
  const mkDraft = (sale, invo, buyer) => {
    db.run(`INSERT INTO invoices (auction_id, ano, date, sale, invo, buyer, buyer1, qty, tot, is_proforma, raised_invo)
            VALUES (?,'99','2026-08-29',?,?,?,?,100,100000,1,'')`, [aid, sale, invo, buyer, buyer]);
    return db.get('SELECT id FROM invoices ORDER BY id DESC LIMIT 1').id;
  };
  const raisedOf = (id) => String((db.get('SELECT raised_invo FROM invoices WHERE id = ?', [id]) || {}).raised_invo || '');

  // The trade-15 arrangement: two buyers, same draft number, different series.
  const ERPL_L33 = mkDraft('L', '33', 'ERPL');
  const KUMAR_I33 = mkDraft('I', '33', 'S KUMAR');

  console.log('[triple] the row matching all three is the one stamped');
  const hit = stamp(db, aid, 'S KUMAR', '33', 'I', '30');
  check('it reports the row it stamped', hit === KUMAR_I33, `${hit} vs ${KUMAR_I33}`);
  check("S KUMAR's Inter-state draft 33 is marked raised as 30", raisedOf(KUMAR_I33) === '30',
        raisedOf(KUMAR_I33));

  console.log('\n[buyer] another buyer\'s draft with the same number is untouched');
  check("ERPL's Local draft 33 is still pending", raisedOf(ERPL_L33) === '', raisedOf(ERPL_L33));

  console.log('\n[series] the same buyer\'s other series is untouched');
  const ERPL_I33 = mkDraft('I', '33', 'ERPL');
  const hit2 = stamp(db, aid, 'ERPL', '33', 'I', '31');
  check('the Inter-state one is stamped', hit2 === ERPL_I33 && raisedOf(ERPL_I33) === '31',
        `${hit2} / ${raisedOf(ERPL_I33)}`);
  check('…and the Local one of the SAME buyer is still pending',
        raisedOf(ERPL_L33) === '', raisedOf(ERPL_L33));

  console.log('\n[change] drafted Local, billed Inter-state');
  // One candidate only, so the sale type not matching is not ambiguity — this
  // is the supported "raise under a different sale type" flow.
  const SW_L44 = mkDraft('L', '44', 'SWITCH');
  const hit3 = stamp(db, aid, 'SWITCH', '44', 'I', '700');
  check('the draft is still stamped', hit3 === SW_L44 && raisedOf(SW_L44) === '700',
        `${hit3} / ${raisedOf(SW_L44)}`);

  console.log('\n[refuse] ambiguous number for one buyer, matching neither series');
  const AMB_L55 = mkDraft('L', '55', 'AMBIG');
  const AMB_I55 = mkDraft('I', '55', 'AMBIG');
  const hit4 = stamp(db, aid, 'AMBIG', '55', 'E', '800');
  check('nothing is stamped rather than guessed', hit4 === null, String(hit4));
  check('both drafts stay pending', raisedOf(AMB_L55) === '' && raisedOf(AMB_I55) === '',
        `${raisedOf(AMB_L55)} / ${raisedOf(AMB_I55)}`);
  // …but naming the series resolves it.
  const hit5 = stamp(db, aid, 'AMBIG', '55', 'L', '800');
  check('naming the sale type picks the right one', hit5 === AMB_L55 && raisedOf(AMB_L55) === '800',
        `${hit5} / ${raisedOf(AMB_L55)}`);
  check('…and leaves the other alone', raisedOf(AMB_I55) === '', raisedOf(AMB_I55));

  console.log('\n[guards] nothing to stamp');
  check('an unknown number stamps nothing', stamp(db, aid, 'ERPL', '999', 'L', '1') === null);
  check('an unknown buyer stamps nothing', stamp(db, aid, 'NOBODY', '33', 'L', '1') === null);
  check('an already-raised draft is not re-stamped',
        stamp(db, aid, 'S KUMAR', '33', 'I', '999') === null && raisedOf(KUMAR_I33) === '30',
        raisedOf(KUMAR_I33));

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
