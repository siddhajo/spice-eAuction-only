# Sister-Concern Setup Runbook (Railway)

> A focused, copy-paste runbook for standing up a **second, independent** deployment of
> Spice e-Auction for a sister concern of the main branch. Same management and software,
> but a **separate legal entity** → its own deployment, database, license, and branding.
>
> This is the [CUSTOMER-ONBOARDING.md](CUSTOMER-ONBOARDING.md) flow with the decisions
> already made: **target = Railway**, **license secret = separate**, **masters = not shared**.

**Why a second deployment (not one app for both):** the app is single-company by design —
no company picker, no company-id in any request (see [ARCHITECTURE.md §7](ARCHITECTURE.md#7-the-single-company-model)).
Two legal entities must keep their GSTIN, invoice number sequences, Tally exports, audit
logs and backups fully isolated. Separate deployments give that for free.

---

## Decisions locked in

| Decision | Choice | Consequence |
|---|---|---|
| Deployment target | **Railway** (cloud, `node server.js`, `sql.js` engine) | Build via `nixpacks.toml`; needs a persistent volume for `data/`. |
| License secret | **Separate** from the main branch | A unique `LICENSE_SECRET` for this entity. Main-branch renewal tokens will **not** work here, and vice-versa — by design. |
| Shared masters | **No** | Load this entity's traders / buyers / auctions from scratch. Do **not** import the main branch's master data. |

> We **do** clone the main branch's *settings* (rates, HSN/SAC, invoice format, Tally
> mappings, feature flags), because the software behaves the same. We do **not** clone
> *master data* (the trading parties) or the *entity identity* fields.

---

## Step 1 — Create the Railway service

1. New Railway project (or new service in the existing project) pointed at this repo.
2. Confirm it builds with **Nixpacks** — `nixpacks.toml` already provides `nodejs_20`,
   `python3`, `gcc`, `gnumake` and starts with `node server.js`.
3. **Attach a persistent Volume** and mount it (e.g. at `/data`). The whole company —
   license, settings, and all records — lives in one SQLite file under that directory.
   Without a persistent volume, **every deploy wipes the database and resets the license.**

### Variables (Railway → Variables)

```
LICENSE_SECRET     = <a NEW, unique secret for the sister concern>   # required, keep separate from main branch
SPICE_DATA_DIR     = /data                                           # must match the mounted Volume path
ADMIN_BRANDING_KEY = <a non-default value>                           # protects /admin/branding
# PORT is set by Railway automatically; the app falls back to 3001 locally.
```

> ⚠ If `LICENSE_SECRET` is left unset the app runs on a dev-fallback secret and logs a
> warning (see [license.js:38](license.js#L38)) — never go live like that.
> Record this entity's `LICENSE_SECRET` somewhere safe; you need it to mint renewals.

---

## Step 2 — First boot & note the license

- On first boot the app generates a unique `install_id` and starts a **30-day trial**.
  The boot log prints the install id + expiry — **note the install id**, you need it for renewals.
- Open the app URL and sign in. Create the sister concern's **admin** user, then add staff
  under **Settings → User Management** with least-privilege roles.

---

## Step 3 — Clone settings from the main branch, then re-identify

1. On the **main branch** app: **Settings → Export** → downloads the full settings JSON
   (endpoint: `GET /api/company-settings/export`, all ~130 values).
2. On the **sister-concern** app: **Settings → Import** → upload that JSON
   (endpoint: `POST /api/company-settings/import`). Behaviour now matches the main branch.
3. **Overwrite every entity-specific field** — this is the step that makes it a different
   company, not a clone. Verify each:

```
[ ] Trade name / legal name / short name
[ ] GSTIN
[ ] PAN
[ ] CIN / Partnership no
[ ] FSSAI / SBL
[ ] Business state (TAMIL NADU / KERALA — drives address & bank set)
[ ] Address lines, place, PIN, phone, email, branch
[ ] Bank name / account number / IFSC
[ ] Invoice prefix + separator (must NOT collide with the main branch's numbering)
[ ] Tally company name + ledger mappings (if they use Tally export)
[ ] Season name / short code / start & end dates
```

> Rates, GST %, HSN/SAC codes, transport/insurance/gunny rates and feature flags can
> stay as imported if the two entities operate identically — confirm with management.

---

## Step 4 — Branding

1. Upload the sister concern's **logo** under Settings (login screen, top bar, PDFs).
2. Pick a **theme** under **Settings → Appearance**. For full white-label control use
   `/admin/branding?key=<ADMIN_BRANDING_KEY>` (the key you set in Step 1).

---

## Step 5 — Feature flags

Most optional features ship **off**. Mirror only the flags the sister concern actually uses.
If you imported settings in Step 3, the flags came across with them — review them against
[ARCHITECTURE.md §8](ARCHITECTURE.md#8-feature-catalog--status) and turn off anything not wanted.
External integrations (WhatsApp, GST lookup) need their own credentials entered here — they
are **not** carried by the settings JSON.

---

## Step 6 — Load master data (fresh — not shared)

Per the decision, load this entity's own data:

1. **Traders / sellers** — add or bulk-import (CSV/Excel template), including bank accounts.
2. **Buyers** — add or bulk-import (GSTIN/PAN, trade names).
3. **Auctions** — create the first auction, set branch **lot allocations**, optionally mark a
   **default auction** (used by the mobile PWA).

> Do not reuse the main branch's exported masters — these are separate trading books.

---

## Step 7 — Smoke test, then clean up

1. Create a test auction, **enter one lot**.
2. **Calculate** — check amount, charges, GST.
3. **Generate one sales invoice**, open the PDF — confirm the logo, name, address, **GSTIN
   and bank are the sister concern's**, not the main branch's.
4. Run **one export** (Excel sales journal or Tally XML) and open it.
5. If they use mobile: install the **PWA** (`/mobile`) and enter a lot from a phone.
6. Delete the test data (bulk delete has preflight + undo).

---

## Step 8 — Handover & renewals

1. Hand over the app URL + admin credentials.
2. Explain the **30-day license** (amber ≤7 days, red ≤3 days, login blocked + `/renew.html` on expiry).
3. To renew, mint a token **with this entity's separate secret**. Either set `LICENSE_SECRET`
   in your shell to the sister concern's value before signing, or pass it explicitly:

   ```bash
   LICENSE_SECRET=<sister-concern-secret> \
     node tools/license-sign.js --install-id <THEIR_INSTALL_ID> --days 30
   ```

   The token is bound to that install id and verified against this deployment's
   `LICENSE_SECRET`, so it works only here — keeping the two entities' licensing fully separate.
   Full details: [LICENSING.md](LICENSING.md).

---

## One-page checklist (copy per sister concern)

```
Entity: ______________________   Date: ____________   Target: Railway

[ ] Railway service created; Nixpacks build green
[ ] Persistent Volume mounted; SPICE_DATA_DIR points at it
[ ] LICENSE_SECRET set to a NEW separate value (and recorded)
[ ] ADMIN_BRANDING_KEY changed from default
[ ] First boot OK; install_id + trial expiry noted
[ ] Admin user created; staff users + roles set
[ ] Settings imported from main branch
[ ] Entity-specific fields overwritten (name/GSTIN/PAN/bank/address/state/invoice prefix/Tally/season)
[ ] Logo uploaded; theme chosen
[ ] Feature flags reviewed; integrations (WhatsApp/GST) configured if used
[ ] Traders, buyers, auctions loaded FRESH (not shared)
[ ] Smoke test passed (lot → calculate → invoice PDF → export)
[ ] Test data cleaned up
[ ] Credentials handed over; separate-secret renewal process explained
```
