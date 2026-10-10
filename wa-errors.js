// ── Is this ONE message's problem, or the whole account's? ─────────
//
// Meta reports a bad number, a template mismatch, a spent 24h ceiling, a
// quality throttle, a billing block and a dead token through the same
// `error.message` string. Telling them apart is the only thing that decides
// what a bulk loop should do next:
//
//   per-message failure  → try the next row
//   account-level stop   → EVERY remaining row will be refused too, and each
//                          refused attempt is one more spam signal against
//                          the number. Stop.
//
// That second case is what "Spam Rate limit hit" (131048) is, and walking a
// 200-row list into it is how a number stays pinned at TIER_250.
//
// The client carries its own copy of this table in public/index.html
// (_waBlockKind) because that file is served as one inline page with no
// module loader. Keep the two in step.
//
// Order matters: 131048 must be tested BEFORE the generic rate-limit
// pattern, or it reads as a throughput hiccup worth retrying.
const WA_BLOCKS = [
  { re: /spam rate limit/i, code: '131048',
    short: 'WhatsApp is refusing sends from this number',
    detail: 'Meta error 131048. The 24-hour recipient ceiling for this number is used up, or its quality rating has dropped. Every further send will be refused until the rolling window clears — and each refusal counts against the number.' },
  { re: /messaging limit|business messaging limit/i, code: '131047',
    short: "This number's 24-hour recipient limit is used up",
    detail: 'The messaging tier allows a fixed number of UNIQUE recipients per rolling 24 hours. Headroom returns gradually as the oldest sends age past 24h, not all at once at midnight.' },
  { re: /\brate limit\b|too many messages|throughput/i, code: '130429',
    short: 'Sending faster than Meta allows',
    detail: 'Meta error 130429 — the account is over its message throughput. Leave it a few minutes and send the rest in smaller batches.' },
  { re: /payment|billing|eligib|insufficient|fund|credit/i, code: '131042',
    short: 'Meta has paused sending — billing',
    detail: 'A payment method or billing problem on the Meta account blocks every template send. Settings → Integrations → Recharge opens the Meta billing hub; nothing in this app can clear it.' },
  { re: /access token|session has expired|oauthexception|invalid.*token|token.*expire/i, code: '190',
    short: 'The WhatsApp access token is no longer valid',
    detail: 'The token in Settings → Integrations has expired or been revoked, so no send can succeed until it is replaced.' },
  { re: /account.*(restricted|disabled|banned|suspend)|restricted.*(account|number)/i, code: '',
    short: 'Meta has restricted this WhatsApp account',
    detail: 'Sending is blocked at the account level. Check the account status in WhatsApp Manager — nothing can go out through the Cloud API until it is lifted.' },
];

// → { code, short, detail, raw } for an account-level stop, null otherwise.
function blockKind(msg) {
  const m = String(msg || '');
  for (const t of WA_BLOCKS) if (t.re.test(m)) return { code: t.code, short: t.short, detail: t.detail, raw: m };
  return null;
}

// ── Numbers that can never be delivered to ─────────────────────
//
// "Message undeliverable" (131026) is the most common failure this account
// sees by a wide margin, and some of it is simply bad data in the master — a
// number with eleven digits, or one digit, can never reach anyone. Meta is a
// slow and expensive way to discover that: the send is spent, and the refusal
// is one more mark against the number's standing, which is what keeps it
// pinned at its current tier.
//
// So obviously-unusable numbers are stopped here instead. The test is
// deliberately narrow — it rejects only what cannot be a working number, and
// never a legitimate foreign one:
//   • nothing at all
//   • fewer than 10 digits          — short of any national number
//   • 11 digits beginning 6-9       — an Indian mobile with a digit too many
//                                     (a US number with its country code is
//                                     also 11 digits but begins with 1)
//   • more than 15 digits           — past the E.164 ceiling
// Everything else is passed through and left to Meta, including numbers
// carrying a country code this business has never used before.
//
// Twinned in public/index.html as _waPhoneProblem for the same no-module-
// loader reason as blockKind above. Keep the two in step.
//
// → a sentence naming the problem, or '' when there is nothing wrong with it.
function phoneProblem(tel) {
  const d = String(tel == null ? '' : tel).replace(/\D/g, '');
  if (!d) return 'No WhatsApp number on file';
  if (d.length < 10) {
    return `The number on file is only ${d.length} digit${d.length === 1 ? '' : 's'} long — it cannot be dialled`;
  }
  if (d.length === 11 && /^[6-9]/.test(d)) {
    return 'The number on file has 11 digits; an Indian mobile has 10, so one digit is wrong or extra';
  }
  if (d.length > 15) return 'The number on file has more than 15 digits — it cannot be dialled';
  return '';
}

module.exports = { blockKind, phoneProblem, WA_BLOCKS };
