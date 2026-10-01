// Birthday greetings — the date arithmetic and the message.
//
// This is the half of the feature that has no server and no Meta account:
// reading a free-text `dob` into a month and a day, deciding which calendar
// day each birthday is greeted on, and composing the wording. It is also the
// half most likely to be wrong silently — a DOB the parser misreads produces
// a greeting on the wrong day rather than an error.
//
//   node tests/birthday-greetings.unit.js
const b = require('../birthday-greetings');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };
const md = (v) => { const p = b.parseDob(v); return p ? `${p.m}/${p.d}` : null; };
const ymd2 = (v) => { const p = b.parseDob(v); return p ? `${p.y}-${p.m}-${p.d}` : null; };

console.log('Birthday greetings — DOB parsing');

// [A] What the date pickers write. ISO, unambiguous.
check('yyyy-mm-dd', ymd2('1980-01-31') === '1980-1-31');
check('yyyy/mm/dd', ymd2('1980/01/31') === '1980-1-31');
check('ISO with a time appended', ymd2('1980-01-31T00:00:00.000Z') === '1980-1-31');

// [B] What the imports bring in. Day first — see the AMBIGUITY RULE in the
//     engine: every import into this app came from a dd/mm source, so
//     05/06/1980 must be 5 June and never 6 May.
check('dd/mm/yyyy is day-first', md('05/06/1980') === '6/5');
check('dd-mm-yyyy is day-first', md('31-01-1980') === '1/31');
check('dd.mm.yyyy', md('31.01.1980') === '1/31');
check('dd-mmm-yyyy (DBF style)', md('31-Jan-1980') === '1/31');
check('dd mmm yyyy, long month name', md('31 January 1980') === '1/31');

// [C] Two-digit years pivot on today, because a birth date is always past.
const cy = new Date().getFullYear();
check('two-digit year 80 → 1980', ymd2('31/01/80') === '1980-1-31');
check('two-digit year never lands in the future',
  (() => { const p = b.parseDob('31/01/' + String((cy + 1) % 100).padStart(2, '0')); return p && p.y <= cy; })());

// [D] Junk must return null, not a wrong day. A misparse greets the wrong
//     person on the wrong day; a null simply never greets.
check('blank → null', b.parseDob('') === null);
check('null → null', b.parseDob(null) === null);
check('free text → null', b.parseDob('not a date') === null);
check('month 13 → null', b.parseDob('1980-13-01') === null);
check('30 February → null', b.parseDob('1980-02-30') === null);
check('unknown month word → null', b.parseDob('31-Xyz-1980') === null);

// [E] An implausible YEAR is dropped but the DAY is kept — the greeting does
//     not depend on the year, only the age does.
check('year 1800 dropped, day kept', (() => { const p = b.parseDob('31-01-1800'); return p && p.m === 1 && p.d === 31 && p.y === null; })());
check('future year dropped, day kept', (() => { const p = b.parseDob(`${cy + 5}-01-31`); return p && p.d === 31 && p.y === null; })());

console.log('\nGreeting day (leap years)');
const g = b._internals._greetDay;
// 29 February exists one year in four. Greeting it only on a real 29th
// would greet those parties once every four years, which reads as the
// feature being broken.
check('29 Feb in a leap year is greeted on the 29th',
  JSON.stringify(g({ m: 2, d: 29 }, 2028)) === JSON.stringify({ m: 2, d: 29 }));
check('29 Feb in a non-leap year is greeted on the 28th',
  JSON.stringify(g({ m: 2, d: 28 + 1 }, 2027)) === JSON.stringify({ m: 2, d: 28 }));
check('a real 28 Feb is untouched',
  JSON.stringify(g({ m: 2, d: 28 }, 2027)) === JSON.stringify({ m: 2, d: 28 }));
check('1900 is not a leap year', b._internals._isLeap(1900) === false);
check('2000 is a leap year', b._internals._isLeap(2000) === true);

console.log('\nLocal-date handling');
// ymd() must never go through toISOString: for any clock east of UTC — which
// is every install this ships to — that returns YESTERDAY for most of the
// morning, and the sweep would greet a day early.
const morning = new Date(2026, 8, 29, 2, 30);   // 29 Sep 2026, 02:30 local
check('ymd() uses local components, not UTC', b.ymd(morning) === '2026-09-29',
  `got ${b.ymd(morning)}`);
check('parseYmd round-trips', b.ymd(b.parseYmd('2026-02-28')) === '2026-02-28');
check('parseYmd rejects junk', b.parseYmd('29/09/2026') === null);

console.log('\nAge');
check('age from a dated DOB', b.ageOn({ y: 1980, m: 1, d: 31 }, 2026) === 46);
check('no year → no age', b.ageOn({ y: null, m: 1, d: 31 }, 2026) === null);
check('nonsense age rejected', b.ageOn({ y: 1700, m: 1, d: 31 }, 2026) === null);

console.log('\nCandidates, birthdaysOn and upcoming');
// A fake db: just the two SELECTs the engine issues, answered from arrays.
function fakeDb(traders, buyers, settings = {}) {
  return {
    all: (sql) => (/FROM traders/.test(sql) ? traders : /FROM buyers/.test(sql) ? buyers : []),
    get: () => null,
    run: () => ({ changes: 0 }),
    prepare: (sql) => ({
      get: (k) => (settings[k] === undefined ? undefined : { value: settings[k] }),
      all: () => [],
    }),
  };
}
const TR = [
  { id: 1, name: 'MURUGAN', cr: 'CR.1', dob: '1980-09-29', tel: '9876543210', whatsapp: '' },
  { id: 2, name: 'SELVAM',  cr: 'CR.2', dob: '29/09/1975', tel: '', whatsapp: '9000000002' },
  { id: 3, name: 'NO DOB',  cr: 'CR.3', dob: '',           tel: '9000000003', whatsapp: '' },
  { id: 4, name: 'BAD DOB', cr: 'CR.4', dob: 'unknown',    tel: '9000000004', whatsapp: '' },
  { id: 5, name: 'NO PHONE',cr: 'CR.5', dob: '1990-09-29', tel: '', whatsapp: '' },
  { id: 6, name: 'OCT',     cr: 'CR.6', dob: '1990-10-05', tel: '9000000006', whatsapp: '' },
];
const BY = [
  { id: 7, buyer: 'AK', buyer1: 'AK TRADERS', dob: '29-Sep-1970', tel: '9000000007' },
];
const db = fakeDb(TR, BY);

const cands = b.candidates(db);
check('unparseable and missing DOBs are dropped', cands.length === 5, `got ${cands.length}`);
check('whatsapp wins over tel for a seller',
  cands.find(c => c.party_id === 2).phone === '9000000002');
check('tel is the fallback',
  cands.find(c => c.party_id === 1).phone === '9876543210');
check('a buyer reads its own row',
  cands.find(c => c.party_type === 'buyer').label === 'AK TRADERS');

const today = b.birthdaysOn(db, '2026-09-29');
check('every format lands on the same day', today.length === 4, `got ${today.length}: ${today.map(t => t.label).join(', ')}`);
check('the no-phone party is LISTED, not filtered out',
  today.some(t => t.party_id === 5 && !t.phone));
check('age is stamped', today.find(t => t.party_id === 1).age === 46);
check('nobody else is dragged in', !today.some(t => t.party_id === 6));

const only = b.birthdaysOn(db, '2026-09-29', { sellers: false, buyers: true });
check('party types filter', only.length === 1 && only[0].party_type === 'buyer');

const soon = b.upcoming(db, '2026-09-29', 10);
check('upcoming includes today at days_away 0', soon.some(r => r.days_away === 0));
check('upcoming reaches 5 Oct', soon.some(r => r.party_id === 6 && r.days_away === 6),
  JSON.stringify(soon.filter(r => r.party_id === 6)));
check('upcoming stops at the window edge', !b.upcoming(db, '2026-09-29', 3).some(r => r.party_id === 6));
// A window that straddles new year must roll the year over, or every
// January birthday disappears from the December screen.
const ny = b.upcoming(fakeDb([{ id: 9, name: 'JAN', cr: '', dob: '1980-01-02', tel: '9' }], []), '2026-12-28', 10);
check('the window crosses into next year', ny.length === 1 && ny[0].greet_date === '2027-01-02',
  JSON.stringify(ny));

console.log('\nMessage composition');
const mdb = fakeDb([], [], {
  birthday_message: 'Dear {first_name} ({name}), happy birthday from {company}!',
  trade_name: 'RNS SPICES',
});
check('tokens are substituted',
  b.composeMessage(mdb, { name: 'MURUGAN RAJ', label: 'CR.1 MURUGAN RAJ' })
    === 'Dear MURUGAN (MURUGAN RAJ), happy birthday from RNS SPICES!');
check('a missing setting falls back to the shipped wording',
  /happy birthday/i.test(b.composeMessage(fakeDb([], [], {}), { name: 'X' })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
