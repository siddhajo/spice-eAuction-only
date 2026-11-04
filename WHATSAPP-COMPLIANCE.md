# WhatsApp compliance — what went wrong, and what the app does about it

**Date of the enforcement:** 4 November 2026
**Notice received from Meta:**

> We have disabled RNS Spices and its WhatsApp Business accounts due to activity that
> does not comply with WhatsApp's Business Terms of Service: breach of Terms of
> Acceptable Use.

---

## 1. The one-paragraph version

Nothing in the app was broken. Every guard it had was a guard about Meta's **limits** —
the 250-recipients-per-24-hours ceiling, message throughput, billing — and the app
obeyed all of them carefully. What it had no concept of at all was Meta's **permission**
rules, which are a different thing: who has agreed to be messaged, and who has asked us
to stop. The app had nowhere to record the first and never read the second. Marketing
messages went to hundreds of phone numbers that had arrived in a bulk master import,
and sellers who replied "STOP" kept getting them.

The `Spam Rate limit hit` (error 131048) hit on 9 October 2026 was Meta saying this out
loud, a month in advance. It was read as a capacity problem and answered with a capacity
fix. It was a reputation problem.

---

## 2. The violations, one at a time

Ordered by how much each one contributed. Policy references are to WhatsApp's **Business
Terms of Service**, the **Business Messaging Policy** it incorporates, and the **Terms of
Acceptable Use**.

### V1 — Marketing messages with no opt-in, and no way to record one

**What the rule says.** A business must obtain opt-in before messaging a person on
WhatsApp. The opt-in has to be collected outside WhatsApp, must clearly state that the
person will receive messages *from this business on WhatsApp*, and the business must be
able to show where it came from if asked.

**What the app did.** Two campaigns sent marketing-class messages to anybody who matched
a rule about their records:

| Campaign | Audience | Scale measured on the live master |
|---|---|---|
| Birthday greetings (`birthday-greetings.js`) | every seller or buyer carrying a date of birth | capped at 50/day |
| Dormant-seller reminders (`seller-reminders.js`) | sellers whose last booking fell in a 60–180 day window | 203 due at the shipped settings, 834 at the loosest |

Neither asked whether the recipient had agreed, because there was no column in the
database in which an agreement could have been recorded. The implicit basis was "their
phone number is on our master". Of the 4,765 sellers on file, **3,085 had never booked a
lot** — they arrived in one bulk import. For them "their number is on our master" means
nothing at all.

**Why it is the main cause.** This is the rule Meta enforces on, and it is enforced
through recipient behaviour: people who did not ask to be messaged block and report. That
block-and-report rate is what the quality rating measures, and what the 131048 ceiling
reflects.

### V2 — Opt-out requests recorded and never read

**What the rule says.** A business must honour a request to stop, promptly, and must not
message that person again.

**What the app did.** The Meta webhook wrote every inbound message into a table called
`whatsapp_inbound`. Nothing ever read it except a diagnostic screen showing the last 30
rows, built to debug approval buttons. There was no scan for "STOP", no unsubscribe
handling, and no concept of a silenced contact. A seller who replied *"stop sending"*,
*"வேண்டாம்"*, or *"remove me"* stayed on the birthday list and the dormant-seller list
indefinitely, and would be messaged again on the next sweep.

Worse: when Meta itself reported that a recipient had stopped our messages (error
**131050**), the app classified it as an ordinary per-message failure — bad luck, try the
next row — and carried on down the list.

This is the violation that is hardest to defend in an appeal, because the evidence that
we were told is sitting in our own database.

### V3 — Ignoring the quality rating, the only warning Meta gives

**What the rule says.** Nothing explicitly — but Meta publishes a per-number quality
rating (green / yellow / red) precisely so that a sender can back off before enforcement.

**What the app did.** It read `quality_rating` from the Graph API and **printed it on a
settings card**. No code anywhere consulted it. Sending continued identically at green,
yellow and red. A degraded rating is the last step before a number is restricted, and the
app treated it as decoration.

### V4 — Repeated sends to numbers that could never work

**What the rule says.** Acceptable Use prohibits conduct that degrades the service for
others; a high rate of undeliverable sends is one of the signals Meta reads as a sender
behaving carelessly with contact data.

**What the app did.** Partially guarded. `wa-errors.js → phoneProblem()` already rejected
obviously-impossible numbers (too few digits, eleven digits starting 6-9), and a
`problem-numbers` report listed numbers that had failed repeatedly. But nothing *blocked*
a send to a number Meta had already refused several times, so a bulk run spent fresh
refusals on the same dead numbers from the bulk import, every time.

### V5 — No frequency discipline per recipient

**What the rule says.** Business Messaging Policy expects messages to be relevant and not
excessive; Meta additionally enforces its own per-user marketing frequency cap and silently
drops messages that exceed it (error **131049**).

**What the app did.** The birthday campaign and the reminder campaign each had their own
cooldown and knew nothing about the other, so a seller could get a "we miss you" nudge and
a birthday wish days apart. Across all message classes there was no per-contact ceiling at
all: a bulk run could send one party their invoice, their debit note and their payment
notice in the same morning.

### V6 — WhatsApp Web offered as a way round Meta's limits

**What the rule says.** Bulk or automated messaging through the consumer WhatsApp app
breaches the personal WhatsApp Terms of Service, and deliberately circumventing the
messaging limits Meta has set for a business number is itself prohibited conduct.

**What the app did.** The pre-flight gate — shown when a bulk run was bigger than the
remaining 24-hour headroom — offered three buttons: Cancel, Send anyway, and **Use
WhatsApp Web**, under the sentence:

> "WhatsApp Web sends from your own phone's account and is not subject to this limit — it
> just needs one click per message."

That is an instruction to evade the limit, written into the product. The limit is not an
inconvenience; it is how Meta rates a sender it is not yet sure about.

### V7 — A free-text escape hatch that skipped the template rules

Both campaigns had a `*_free_text` setting that sent the greeting or reminder as a plain
text message instead of an approved template. Plain text only reaches contacts whose
24-hour service window is open — so in practice it reached almost nobody — but it was
written to the log as message type `text`, which is indistinguishable from a genuine
service reply. Any rule keyed on message type would have had a hole in it the size of
both campaigns.

---

## 3. What was built

One new module, `wa-compliance.js`, holding a single function — `gate()` — that every
WhatsApp send now passes through, and the consent ledger it answers from.

**Enforcement is server-side**, inside the send helpers in `server.js`. That is the whole
design argument: a guard that lived in the browser would be one forgotten caller away from
repeating the breach. The client greys rows out as a courtesy; the decision is never the
client's.

### The rules, in the order they are applied

| # | Rule | Applies to | Fixes |
|---|---|---|---|
| 1 | **Sending paused** — one switch stops everything, both unattended sweeps included | every class | — |
| 2 | **Opted out** — blocks every class, invoices included (two scopes, below) | every class | V2 |
| 3 | **Marketing needs an opt-in on record** | marketing only | **V1** |
| 4 | **One marketing message per contact per 30 days**, counted across both campaigns | marketing only | V5 |
| 5 | **At most 3 messages to one contact per 24 hours** | all but service replies | V5 |
| 6 | **Quality rating** — yellow stops marketing, red stops everything but replies | all but service replies | V3 |
| 7 | **Known-dead number** — 3 refusals in 90 days with no delivery ever | all but service replies | V4 |

**Utility messages are not gated on opt-in.** An invoice, a bill, a payment notice rests
on the business relationship — that is exactly what Meta's utility template category is
for, and refusing those would break the firm without improving compliance. They are still
gated on opt-out, on the daily ceiling, and on account health.

**Service replies — answering somebody who messaged us — are never blocked on consent.**
They are solicited by definition, and replying promptly is the one thing that *improves* a
quality rating.

### Message classes

Every send declares a class, resolved by `classify(msgType, refType)`:

- `marketing` — birthday greetings, dormant-seller reminders
- `utility` — invoices, bills, debit notes, payment notices
- `service` — a free-text reply inside a contact's 24-hour window

`ref_type` is consulted **before** `msg_type`, which is what closes V7: a campaign's
free-text fallback writes `msg_type: 'text'` but carries `ref_type: 'birthday'`, so it is
still classified as marketing. An unrecognised message type falls back to `utility`, never
to `service` — a sender nobody registered must not inherit the loosest rules by accident.

### The consent ledger — `wa_consent`

One row per **decided** contact. Three facts matter about its design:

1. **Keyed on the last ten digits of the number.** The send log stores `91` + ten digits,
   the masters mostly store the bare ten, and an operator typing an opt-out from a phone
   call types whatever they were read. All three have to land on the same row, or an
   opt-out is honoured for one spelling of a number and ignored for another.
2. **The absence of a row is a third state — "never asked" — and is never stored as one.**
   Writing it would make an untouched master look audited.
3. **`source` and `basis` are kept on every row.** `source` is how it was captured
   (`reply`, `button`, `operator`, `meta`, `import`); `basis` is the evidence in words —
   *"signed the 2026 registration form"*, *"asked on the phone, 4 Nov"*. "We have consent"
   with nothing behind it is the claim that got this account disabled, so the app makes the
   evidence a field. First opt-in date and latest opt-out date are both retained: an
   auditor asks *since when did you have permission* and *when did you stop*, and one
   column overwritten by the other loses whichever answer is needed.

### Two scopes of opt-out

A bare "STOP" means **everything**, which is Meta's own convention and the stricter
reading — so that is the default, and it stops an invoice too. Anything unrecognised, or
absent, resolves to the same.

But "stop the birthday messages, keep sending my bills" is a real request, and a single
total-silence setting could only answer it by cutting that seller off from their own
documents — which is honouring the request badly. So an operator can record a
**marketing-only** opt-out: greetings and reminders stop, invoices and notices continue.

Only an operator can record the narrower scope. A stop *reply* is never narrowed
automatically, because no reader of words is confident enough to decide that on somebody
else's behalf. The opt-out register names the scope of every entry, because the difference
matters to the business: a total opt-out means that party's invoice has to go by another
route, while a marketing-only one costs nothing but a greeting.

### Opt-out detection — two tiers, deliberately

`detectIntent()` reads inbound replies in English, Tamil, and Tamil typed with Latin
letters, and returns one of three answers:

- **`stop`** — unambiguous. *"STOP"*, *"unsubscribe"*, *"remove me"*, *"don't message me
  again"*, *"வேண்டாம்"*. **Applied automatically, on the spot.**
- **`review`** — probably an opt-out, but containing a word that turns up in ordinary
  auction conversation. *"not interested"*, *"wrong number"*, anything with a bare
  *cancel* / *quit* / *end* / *block*. **Listed for an operator to decide. Never applied
  automatically.**
- **`start`** — an explicit opt-in. Held to at least the same strictness: a bare *"yes"* or
  *"ok"* is **not** an opt-in, because it is an answer to something and we do not know what.

The split is the point. The first draft of this had one generous pattern list and a comment
saying a false opt-out only costs one contact who can be put back by hand. That is wrong
here: *"when does the auction end"* would have silenced that seller, and what they would
then stop receiving is their own purchase invoice and payment notice — which nobody would
notice for weeks. A missed opt-out is the breach that disabled the account; a wrongly
applied one cuts a customer off from their own documents. The unambiguous half needs no
human. The ambiguous half does.

Messages longer than 12 words are never read as commands at all — *"can I cancel lot 42 and
move the rest to next week?"* is a conversation.

A marketing template's own **Stop button** bypasses the word limit entirely: a tap has only
one meaning.

### Meta's own refusals now feed the ledger

- **131050** ("user has stopped / not opted in / user preference") → the contact is recorded
  as **opted out**, attributed to Meta, and nothing further is sent to them. This closes the
  worst part of V2.
- **131049** (per-user marketing frequency cap) → recorded, and treated as an account-level
  stop so the run halts rather than pushing through.
- **368** / "temporarily blocked for policy violations" → added to the account-level stop
  table.

All three are in `wa-errors.js` (and its twin table in `public/index.html`). Before this,
131050 and 131049 were classed as per-message failures, so a 200-row run read them as bad
luck and kept going — the precise behaviour being penalised.

### What the pre-flight gate offers now (V6)

The "Use WhatsApp Web" button and the sentence explaining that it evades the limit are
gone. The three options are now **Cancel**, **Send what fits** (the default — sends the
rows the 24-hour window has room for and leaves the rest, logged as unsent so
"↻ Select unsent" finds them tomorrow), and **Send anyway**. WhatsApp Web remains available
on an install where the Cloud API is not configured at all, and for single manual sends;
it is no longer offered as the answer to a spent ceiling.

### Refusals are visible, not silent

An enforced refusal writes two rows:

- `whatsapp_messages` gets a **`blocked`** row — so an invoice the app declined to send
  shows up on the Send log and on "↻ Select unsent", and the operator knows to deliver it
  another way. It counts as a send nowhere: it spends no 24-hour recipient headroom and
  adds nothing to "sent today".
- `wa_policy_log` keeps the reasoning — which rule, which class, enforce or warn.

The two are separate on purpose. Readers answer "where does this document stand?" by taking
the newest `whatsapp_messages` row per `(ref_type, ref_id)`. In `warn` mode a message goes
out *despite* a verdict against it, so writing that verdict to the send log would put a row
newer than the real send in front of every reader and make a delivered invoice read as
refused.

---

## 4. Settings

**Settings → WhatsApp Compliance** (new category):

| Setting | Default | What it does |
|---|---|---|
| `wa_compliance_mode` | `enforce` | `enforce` refuses; `warn` sends anyway and records what would have been refused; `off` restores the pre-ban behaviour. An unrecognised value falls back to `enforce` — a typo must not switch the protection off. |
| `wa_sending_paused` | off | The emergency stop. Nothing leaves over WhatsApp at all, and both sweeps return without reading a party. **This is what to turn on the moment Meta writes about the account.** |
| `wa_marketing_gap_days` | 30 | Minimum days between marketing messages to one contact, across both campaigns. |
| `wa_max_per_contact_day` | 3 | Maximum messages of any class to one contact per 24 hours. |
| `wa_assume_legacy_optin` | **off** | Treats every existing seller and buyer as opted in. This is exactly the assumption the account was disabled over. It exists only for an install that has genuinely collected written consent. |
| `wa_legacy_optin_basis` | blank | Where that written consent is recorded. Shown on the Compliance tab, and the answer if Meta reviews the account. |
| `wa_stop_marketing_on_yellow` | on | Pause greetings and reminders below a green rating. |
| `wa_stop_all_on_red` | on | Pause everything but replies at red. |
| `wa_dead_number_fails` | 3 | Refusals with no delivery ever before a number is left alone. |

---

## 5. The screen

**Settings → Integrations → WhatsApp Business → Compliance** (a fourth tab). It answers four
questions in the order an operator has them:

1. **Is sending safe right now?** — quality rating, enforcement mode, and a loud banner when
   paused or running in warn mode.
2. **Who may we message?** — opted in / opted out / **never asked**. On an install that has
   never collected consent, "never asked" is the entire master, and the number is shown
   plainly because that figure *is* the exposure.
3. **Is anybody waiting on us?** — unread "stop" replies get a red banner and a single button
   that applies them all; the ambiguous ones are listed with both answers for a person to pick.
4. **What have the rules refused?** — per rule, over 30 days, plus the opt-out register with
   the evidence each entry rests on.

Recording a decision is on the same tab. An opt-in cannot be saved without saying where the
permission came from; an opt-out can, because "they asked us to stop" is its own
justification.

The two campaign screens (Birthdays, Seller Reminders) now label a party with no opt-in as
held, with the reason, and count them in the funnel — so an empty worklist explains itself
instead of looking broken.

---

## 6. What to do about the disabled account

The code changes prevent a recurrence. They do not restore the account — only Meta can do
that. In order:

1. **Turn on `wa_sending_paused`** before anything else. A run started during a review is
   what turns a restriction into a disablement.
2. **Appeal in WhatsApp Manager / Business Support Home.** An appeal is far stronger with
   specifics, and the app can now produce them: the opt-out register, the dates, the policy
   log, and the fact that unread stop replies have been applied.
3. **Clear the backlog first, then appeal.** Compliance tab → "Apply all N now". Being able
   to say "we found N contacts who had asked us to stop, and they are now permanently
   suppressed" is a materially better appeal than a promise.
4. **Decide the consent position honestly.** If written consent exists on paper (a
   registration form with a WhatsApp permission line), set `wa_assume_legacy_optin` and
   record where it is in `wa_legacy_optin_basis`. If it does not, leave it off and collect
   opt-ins going forward — invoices and notices keep working either way, which is the part
   of the business that actually depends on WhatsApp.
5. **Consider whether the two marketing campaigns are worth it at all.** The measured
   numbers say: 203 messages to reach the 22 sellers the reminder campaign is genuinely for.
   That ratio is what the enforcement was about. Running them to an opted-in list is fine;
   running them to a master is what cost the account.

---

## 7. Files

| File | What changed |
|---|---|
| `wa-compliance.js` | **New.** The gate, the consent ledger (incl. opt-out scope), intent detection, coverage. |
| `wa-errors.js` | 131050, 131049 and 368 added to the account-level stop table. |
| `db.js` | `wa_consent` and `wa_policy_log` tables; `whatsapp_messages.phone_key` (+ index, + backfill) so the gate's three per-send counters are index lookups rather than three scans of the log per send. |
| `server.js` | `_waGateSend` inside all four send routes, `_waSendText` and the shared outreach sender; opt-out capture in the webhook (inbound replies, Stop buttons, and 131050 on delivery receipts); `_waHealthNow` quality cache; `/api/whatsapp/compliance`, `/api/whatsapp/consent` (POST/DELETE), `/api/whatsapp/consent/apply-replies`; the pause honoured by the sweeper. |
| `company-config.js` | The `wa_policy` settings category and its nine settings. |
| `birthday-greetings.js`, `seller-reminders.js` | Consent read once per run; held parties labelled and counted, not sent. |
| `public/index.html` | The Compliance tab; policy codes in the twin error tables; `blocked` as a queue status; the pre-flight gate's WhatsApp Web bypass replaced with "Send what fits". |
| `tests/wa-compliance.unit.js` | **New**, 141 assertions — the rules, the ledger, the two opt-out scopes, the intent reader. |
| `tests/wa-compliance.http.js` | **New**, 41 assertions — that the enforcement is in the routes and a refusal never offers WhatsApp Web. |
| `tests/wa-compliance.browser.js` | **New** — the Compliance tab's layout and its two loud states. |
| `tests/birthday-*.js`, `tests/seller-reminders.*.js` | Updated for the new rule, each with its own consent-gate section. |

---

## 8. One thing this does not fix

The app can enforce rules about consent. It cannot **collect** consent — that happens at the
counter, on the phone, or on the registration form, outside WhatsApp, which is where Meta
requires it to happen. The ledger is only as good as what gets typed into it. The single
highest-value change outside the code is adding a WhatsApp permission line to the seller and
buyer registration form, and recording it as parties are onboarded.
