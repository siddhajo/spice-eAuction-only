# Customer Onboarding Guide

> How to add (onboard) a **new customer** to Spice e-Auction.
> Read [ARCHITECTURE.md](ARCHITECTURE.md) §7 first if you're new — it explains the
> single-company model that this whole guide is built on.

**Last reviewed:** 2026-09-01

---

## The one thing to understand first

**One customer = one deployment = one database file.**

There is no "add company" button. Each customer gets their **own running copy** of
the app, with their **own `data/config.db`**, their **own license**, and their **own
branding**. Onboarding a customer means: *stand up a fresh deployment, fill in their
settings, brand it, and hand them a login.*

That sounds like a lot, but with the **settings export/import** feature you can clone
a known-good configuration in minutes.

---

## Onboarding at a glance

```
1. Deploy a fresh copy of the app           →  new install, 30-day trial starts
2. First login (create the admin user)
3. Enter company settings                   →  identity, addresses, rates, bank, Tally
   (or IMPORT a settings JSON from a similar customer, then tweak)
4. Apply branding                           →  theme + logo
5. Turn on any optional features they need  →  feature flags
6. Load master data                         →  traders, buyers, auctions
7. Smoke test                               →  enter a lot, generate one invoice
8. Hand over                                →  give credentials + renewal expectations
```

---

## Step 1 — Deploy a fresh instance

Pick the target the customer needs:

- **Cloud (Railway / similar):** deploy this repo as a new service. It runs
  `node server.js` (see `Procfile`). Make sure the data directory **persists across
  deploys** — the license and all data live in `data/config.db`. Set the environment
  variables below.
- **Windows desktop:** build the installer with `npm run build:win` and install it on
  the customer's PC. Data is stored under `%APPDATA%`.

### Whose Railway account? (cloud only)

Two models, and it's worth deciding **before** you deploy, because switching later
means a backup/restore migration:

**Model 1 — your Railway account (the original setup).** Every customer is a service
in the account you own. You pay Railway and bill it on. Simplest to operate, and the
customer never sees `LICENSE_SECRET` or the source. Nothing extra to do — deploy the
repo as a new service and carry on to Step 2.

**Model 2 — the customer's own Railway account.** The customer signs up, pays Railway
directly, and owns the project. Increasingly what customers ask for. You keep one
GitHub account and one private repo throughout — a published Docker image plus a
Railway template does the work, so the customer clicks one button and never gets repo
access.

> **You cannot make a second Railway account from the same GitHub login** — signing in
> with GitHub means your Railway account *is* that GitHub identity. Model 2 isn't about
> linking accounts; it's about making the same private repo deployable *into* accounts
> other people own.

Model 2 has one consequence you must price in: **whoever owns the Railway service can
read its environment variables and its container**, so the customer can see
`LICENSE_SECRET` and, since this is a Node app, the source. The renewal gate becomes
honest-customer protection in practice as well as in theory. Mitigate by using a
**distinct `LICENSE_SECRET` per customer** (you should anyway) so one leak isn't a
fleet-wide leak.

**Setup for Model 2, the migration path off Model 1, and the update story are all in
[RAILWAY-CUSTOMER-ACCOUNTS.md](RAILWAY-CUSTOMER-ACCOUNTS.md).** Come back here at Step
2 once the instance is up.

Whichever model you use, the deployment needs a **persistent volume mounted at
`/app/data`** with `SPICE_DATA_DIR` pointing at it. Skipping this is the single most
common way to break a Spice install: every redeploy wipes the data *and* resets the
license to a fresh 30-day trial.

### Environment variables to set (cloud)

| Variable | Why it matters |
|---|---|
| `LICENSE_SECRET` | **Required.** Must match the secret on your laptop so renewal tokens verify. Keep it secret and consistent for this customer. |
| `PORT` | Optional. Defaults to `3001`. |
| `SPICE_DATA_DIR` | Optional. Where `config.db` lives. Point at a **persistent** volume. |
| `ADMIN_BRANDING_KEY` | Optional. Protects the hidden branding admin page. Change it from the default. |

> On **first boot** the app generates a unique `install_id` and starts a **30-day
> trial**. The boot log prints the install id and expiry — note it down, you'll need
> the install id to mint a renewal token later.

---

## Step 2 — First login & admin user

Open the app and sign in. Create the customer's **admin** account (or set the password
on the default admin). From there you can create additional staff users with limited
roles under **Settings → User Management**.

Roles are granular — give lot-entry staff `lot_write` only, give a manager `export`
and `settings_write`, reserve full admin for yourself/the owner.

---

## Step 3 — Enter (or import) company settings

This is the heart of onboarding. Settings live under **Settings**, organized into ~14
categories. You have two ways to fill them in:

### Option A — Import from a similar customer (fast)

1. On an existing, well-configured customer go to **Settings → Export** (downloads a
   JSON of all ~130 settings).
2. On the new customer go to **Settings → Import** and upload that JSON.
3. **Then change the customer-specific fields** (see checklist below). Don't skip this —
   GSTIN, PAN, bank accounts and addresses are different for every customer.

### Option B — Fill in from scratch

Work through the categories. The must-fill ones:

| Category | Fields to set |
|---|---|
| **Company identity** | Trade name, legal name, short name, PAN, CIN/Partnership no, FSSAI, SBL |
| **Business state** | `TAMIL NADU` or `KERALA` (drives which address/bank set is used) |
| **Address** | Address lines, place, PIN, GSTIN, phone, email, branch (for the chosen state) |
| **Rates & charges** | Commission %, GST rates, transport ₹/kg, insurance, gunny rate, discounts |
| **HSN / SAC codes** | Cardamom, gunny, transport, insurance, service |
| **Bank details** | Bank name, account number, IFSC (per state) |
| **Season / FY** | Season name, short code, start/end dates |
| **Invoice settings** | Prefix, separator, dispatched-through, signature text |
| **Tally** | Company name + ledger mappings (only if they use Tally export) |

> **Customer-specific checklist (always verify after an import):**
> ☐ GSTIN ☐ PAN ☐ CIN/Partnership no ☐ bank account & IFSC ☐ addresses & phone/email
> ☐ business state ☐ invoice prefix ☐ season dates ☐ Tally company name.

---

## Step 4 — Branding

1. Upload the customer's **logo** under **Settings** (logo upload). It appears on the
   login screen, the top bar, and on generated PDFs.
2. Pick a **theme** under **Settings → Appearance** — choose a preset (color), density,
   and font. For deeper white-labeling, the hidden admin page at
   `/admin/branding?key=<ADMIN_BRANDING_KEY>` exposes the full preset controls.

---

## Step 5 — Turn on optional features they need

Most optional features ship **off**. Enable only what this customer wants (under
Settings — these are the feature flags):

| If the customer wants… | Turn on |
|---|---|
| To freeze lots once entered | Lot locking (`flag_lot_lock`) |
| To verify a price sheet before invoicing | Price check (`flag_price_check`) |
| Debit notes for discount corrections | Debit notes (`flag_debit_note`) |
| Reserved price on lots | `flag_reserved_price` |
| Local transport/insurance fields | `flag_local_ti` |
| HSN columns / bank details on invoices | `flag_hsn` / `flag_bank` |
| TDS handling | `flag_tds_sales` / `flag_tds_purchase` |
| WhatsApp sending | `flag_whatsapp` **+** configure credentials (Step 5a) |

### Step 5a — External integrations (only if requested)

- **WhatsApp:** enter Meta Cloud API credentials under the WhatsApp config screen.
  Until configured, send actions are disabled — that's expected.
- **GST lookup:** depends on an external GST API; configure if the customer wants
  in-app GSTIN validation.

See the full flag list and status in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-feature-catalog--status).

---

## Step 6 — Load master data

Before live use, load the starting data:

1. **Traders / sellers** — add manually or **bulk import** (CSV/Excel template),
   including bank accounts.
2. **Buyers** — add or bulk import (GSTIN/PAN, trade names).
3. **Auctions** — create the first auction/trade, set branch **lot allocations**, and
   optionally mark a **default auction** (used by the mobile app).

> Migrating from an old DBF system? Use **Settings → Admin → Import old data**, which
> has preview / run / **undo**, so you can verify before committing.

---

## Step 7 — Smoke test

Confirm the install actually works before handover:

1. Create a test auction and **enter one lot**.
2. Run **Calculate** — check the amount, charges and GST look right.
3. **Generate one sales invoice** and open the PDF — confirm the logo, company name,
   address, GSTIN and bank details are the customer's, not the template's.
4. Run **one export** (e.g. Excel sales journal or Tally XML) and open it.
5. If they use mobile: install the **PWA** and enter a lot from a phone.

Delete the test data afterward (bulk delete has a preflight + undo window).

---

## Step 8 — Handover & licensing

1. Give the customer their **login URL/app** and admin credentials.
2. Explain the **30-day license**: the app shows an amber warning at ≤7 days and a red
   one at ≤3 days. On expiry, login is blocked (HTTP 451) and the app shows
   **`/renew.html`**.
3. **To renew**, you (the developer) mint a token:
   ```bash
   node tools/license-sign.js --install-id <THEIR_INSTALL_ID> --days 30
   ```
   Send the token to the customer; they paste it into `/renew.html`. The token is
   bound to that customer's install id and verified with `LICENSE_SECRET`, so it only
   works on their deployment.

Full licensing details (setup, testing, troubleshooting, remote admin) are in
[LICENSING.md](LICENSING.md).

---

## Onboarding checklist (copy this per customer)

```
Customer: ______________________   Date: ____________   Target: Cloud / Desktop

[ ] Railway account model decided (yours / customer's)
[ ] Deployed fresh instance (persistent volume at /app/data, SPICE_DATA_DIR set)
[ ] LICENSE_SECRET set — unique to this customer — and recorded
[ ] Noted install_id + trial expiry from first boot
[ ] Admin user created; staff users + roles set
[ ] Company settings entered or imported
[ ] Customer-specific fields verified (GSTIN/PAN/bank/address/state/prefix/season)
[ ] Logo uploaded; theme chosen
[ ] Required feature flags enabled
[ ] WhatsApp / GST configured (if requested)
[ ] Traders, buyers, auctions loaded
[ ] Smoke test passed (lot → calculate → invoice PDF → export)
[ ] Test data cleaned up
[ ] Credentials handed over; renewal process explained
```

---

## Common questions

**Can two customers share one deployment?**
No. The app is single-company by design. Run a separate deployment per customer.

**How do I copy one customer's setup to another?**
Use **Settings → Export** on the source and **Settings → Import** on the target, then
change the customer-specific fields (GSTIN, bank, addresses, etc.).

**A customer is locked out after 30 days — did they lose data?**
No. The lockout only blocks login. Their data is intact in `config.db`. Mint a renewal
token (Step 8) and they're back in.

**Where is all their data?**
In the single `data/config.db` file. Back it up to back up the whole customer.

**Can I run several customers' deployments from one GitHub account?**
Yes — that's the normal setup, and it works whether the deployments live in your
Railway account or in each customer's own. What you *can't* do is create more than one
Railway account from one GitHub login. See
[RAILWAY-CUSTOMER-ACCOUNTS.md](RAILWAY-CUSTOMER-ACCOUNTS.md).

**A customer wants to move to their own Railway account. Do they lose data or restart
their license?**
Neither, if you migrate properly: back up via `/api/system/backup`, restore into the
new deployment, and set the **same** `LICENSE_SECRET`. `install_id` and the paid-up
expiry live inside `config.db`, so they travel with the backup and existing renewal
tokens keep working. Full procedure in
[RAILWAY-CUSTOMER-ACCOUNTS.md §7](RAILWAY-CUSTOMER-ACCOUNTS.md#7-moving-an-existing-customer-off-your-railway-account-onto-theirs).
