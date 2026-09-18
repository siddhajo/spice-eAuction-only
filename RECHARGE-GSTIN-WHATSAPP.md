# Recharging GSTIN Lookup & WhatsApp

> Operators get this same walkthrough inside the app: **How-to Guide →
> Settings & admin → Recharge GST lookup credits / Recharge WhatsApp**, or the
> **How do I recharge?** button on either card in Settings → Integrations.
> Posters live in `public/help.html`; keep the two in step.

Neither of these is topped up inside Spice. GSTIN lookups are prepaid credits
bought from the lookup provider's own website; WhatsApp is billed by Meta
against a card held in Meta's billing hub. Spice's job is to tell you which
account is running dry, how much is left, and to link you straight to the
right page.

Both live in **Settings → Integrations**: the GST Lookup card, and the
WhatsApp card's **Usage** tab.

---

## Part 1, step 1 — see which GSTIN account is running out

Credits belong to one provider, not to Spice, so the first thing to establish
is *whose* credits you are about to buy.

1. Open **Settings → Integrations**. The **GST Lookup** section leads with a
   coloured status card.
2. Read the **Provider** row. It names the service currently selected —
   `gstincheck.co.in` or `gstinapi.in`. That is the site you recharge.
3. Read **Credits remaining** and, on gstincheck, **Plan expires**. The card's
   colour is the summary: green healthy, amber running low, red critical or
   exhausted.
4. Check the **API key** row says "✓ configured". If it says "not set for …",
   a key exists for the *other* provider only — that is a setup problem, not a
   credit problem.

If **Credits remaining** reads "unknown — run one GST lookup to refresh",
nothing is wrong. Neither provider publishes a free balance endpoint, so the
count only updates when somebody actually looks up a GSTIN from the Sellers or
Buyers form.

## Part 1, step 2 — buy credits and put the key back

1. On the status card, press **↗ Recharge at …** (the pricing page) or the
   **… dashboard ↗** link in the Account row (the login page). Both always
   point at the *selected* provider.
2. Log in, buy a pack, pay.
3. Copy the API key from the provider's dashboard. It is often unchanged after
   a top-up — compare before pasting.
4. Back in Spice, **Settings → Integrations → GST Lookup**, paste it into that
   provider's own field:
   - `GST Lookup API Key (gstincheck.co.in)`
   - `GST Lookup API Key (gstinapi.in)`
5. Save.

The two key fields are independent and both are kept, so switching providers
later costs no retyping. Only the selected provider's key is ever read — a key
pasted into the idle box is silently ignored, and the note under each field
tells you which one is live.

|                  | gstincheck.co.in                                    | gstinapi.in                                          |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Buy credits      | https://gstincheck.co.in/pricing.html                | https://www.gstinapi.in/#pricing                      |
| Account / key    | https://gstincheck.co.in/login.html                  | https://www.gstinapi.in/dashboard                     |
| Packs            | min 1,000 credits @ ₹0.80                            | ₹199 / 250 · ₹599 / 1,200 · ₹2,499 / 6,250            |
| Credits expire   | Yes — 1 year                                         | No                                                    |
| Balance reported | Only on a lookup                                     | `credits_remaining` on every call                     |

## Part 1, step 3 — confirm it worked

Press **↻ Check balance now** on the status card. It deliberately spends one
credit: it runs a real lookup on your own company GSTIN (or asks you for one)
because that is the only way either provider will report a balance. The card
should turn green with the new count and a fresh **Last refreshed** time.

Three things that bite:

- **gstincheck credits expire one year after purchase.** Watch the **Plan
  expires** row, not just the count. Most of a 1,000-credit pack was lost that
  way on 2026-08-20 — the balance was fine, the clock ran out. At a few hundred
  lookups a year, non-expiring credits are worth more than a cheaper per-call
  rate.
- **gstincheck reports a dead account as a success.** It answers HTTP 200 with
  `flag:false` / `CREDIT_NOT_AVAILABLE`, so a lookup that "runs" but fills
  nothing in usually means no credits, not a bad GSTIN. Open **Show raw
  response** on the card to see what actually came back. gstinapi.in returns
  real status codes instead (402 = out of credits).
- **Wrong-provider key.** If the card says the key is not set while you are
  sure you pasted one, you pasted it into the other provider's field, or the
  **GST Lookup Provider** dropdown is on the other service.

---

## Part 2, step 1 — read the WhatsApp card before topping up

WhatsApp has two separate ceilings, and only one of them is about money. Check
which one you have hit before opening Meta's billing page.

1. Open **Settings → Integrations → WhatsApp** and switch to the **Usage** tab
   (the section has three tabs: setup, usage, send log).
2. Read the status line's dot — green **Connected**, amber **Connected · Meta
   figures unavailable**, red **Sends are blocked**, grey **Not configured**.
3. A red banner means money: Meta's own refusal text is quoted in it, and
   nothing will go out until the account is funded.
4. Otherwise read the five tiles:

| Tile                    | What it tells you                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Free messages left      | Service-window messages only. **Not** invoices you can still send.                      |
| Billable this month     | What this month has actually cost, in your Meta billing currency.                       |
| Recipients left (24h)   | The ceiling that stops a bulk run. `TIER_250` = 250 **unique** recipients per 24 hours. |
| Sent today / this month | Exact counts from Spice's own send log, no Meta call needed.                            |

Ten invoices to one buyer spend one of the 250. If **Recipients left (24h)** is
what ran out, no amount of top-up helps — wait out the window or split the run
across days.

Press **Refresh** to re-pull the Meta figures.

## Part 2, step 2 — fund the Meta account

Meta publishes no top-up or balance API, so Spice can only send you to the
right page. The card on file and the balance live entirely in the Meta billing
hub.

1. On the Usage tab, press **Add funds ↗**. It opens
   https://business.facebook.com/billing_hub/payment_settings, or your own URL
   if one is set as an override.
2. Sign in with the Meta account that owns the WhatsApp Business Account —
   RNS Spices, WABA `1580412210089993`. An account that can see the Business
   Manager but not billing will show an empty page.
3. In **Payment settings**, add or re-verify the payment method, and clear any
   outstanding balance. WhatsApp is post-paid: charges accrue through the month
   and are billed to the card, so "recharging" means making sure a valid card is
   attached and nothing is overdue — there is no prepaid wallet to fill.
4. Return to Spice and press **Refresh** on the Usage tab.

The **Meta insights ↗** button beside it opens the same account's WhatsApp
insights, which is where Meta explains a block in more detail than the API
returns.

**Raising the 24h tier is not a purchase.** Meta lifts `TIER_250` on its own as
the number sends consistent, good-quality volume with the business verified and
quality rating GREEN. You cannot buy your way past it.

Two optional knobs live under **Allowance & recharge link** on the same card:
the free-messages-per-month figure (Meta does not publish it over the API, so
it is a stored setting, default 1,000) and a Recharge URL override if your
billing sits somewhere other than the standard hub.

## Part 2, step 3 — confirm sending is back

1. Press **Refresh** on the Usage tab. The red banner should clear and the dot
   go green.
2. Send one real document — a single invoice, not a bulk run — and watch the
   **Send log** tab.
3. "Sent" only means Meta accepted the message. Delivered and read arrive later
   over the webhook.

Four things that bite:

- **Free is not the same as invoices left.** Invoice and payment templates are
  billable at roughly ₹0.115 each unless that contact messaged you within the
  last 24 hours. A sample month showed 1 free message against about 600 billable
  ones, so "999 free left" never means 999 invoices.
- **A send log where every row reads "Sent" and nothing ever says Delivered** is
  a webhook problem, not a billing one. The panel says so in an amber footer;
  fix it in Meta by verifying the webhook and subscribing the `messages` field.
- **Text-only templates have never succeeded on this account.** All five
  attempts in August 2026 failed with "Business eligibility payment issue"
  during the billing block, and it was never retried after the block cleared.
  The Payments screen is the only text-only sender — prove it with one real send
  before trusting it in a run.
- **Funding does not reset the 24h window.** If the run stopped at 250 unique
  recipients, it resumes as the rolling window clears, whatever the balance says.

---

## At a glance

|                 | GSTIN lookup                                                                 | WhatsApp                                                                          |
| --------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| What runs out   | Prepaid lookup credits (and, on gstincheck, the 1-year plan clock)            | Meta's card on file; separately, 250 unique recipients per 24h                       |
| Where in Spice  | Settings → Integrations → GST Lookup card                                     | Settings → Integrations → WhatsApp → Usage tab                                       |
| Where you pay   | The selected provider's own site — gstincheck.co.in or gstinapi.in            | business.facebook.com/billing_hub/payment_settings                                   |
| After paying    | Paste the key into that provider's field, then **↻ Check balance now** (1 credit) | Press **Refresh**, then send one real message                                     |
| Cannot be bought | —                                                                            | The 24h tier — Meta raises it on quality and volume                                  |
