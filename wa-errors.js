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

module.exports = { blockKind, WA_BLOCKS };
