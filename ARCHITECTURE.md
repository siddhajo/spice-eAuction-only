# Spice e-Auction — Architecture Guide

> A practical, plain-language map of how this app is built, what it does, and where
> everything lives. Pair this with [CUSTOMER-ONBOARDING.md](CUSTOMER-ONBOARDING.md)
> when setting up a new customer.

**Last reviewed:** 2026-06-10 · **App version:** 1.0.0 · **Mode:** e-Auction (single company per install)

---

## 1. What this app is (in one paragraph)

Spice e-Auction is an **admin back-office** for spice trading companies in India
(cardamom auctions in particular). One company runs auctions; staff enter **lots**,
the app **calculates** prices, taxes and charges, then generates **sales invoices,
purchase invoices, commission bills and debit notes** as PDFs. On top of that it
produces a rich set of **reports and exports** — Excel, legacy DBF, **Tally XML**,
and statutory **Spice Board** forms. It ships in three forms: a **web app**, a
**Windows desktop app** (Electron), and a **mobile PWA** for lot entry.

---

## 2. The big picture

```
                        ┌──────────────────────────────────────────┐
        USERS           │  Desktop Web        Mobile PWA   Windows  │
                        │  /public            /public-     Electron │
                        │  (index.html)       mobile        app     │
                        └─────────┬───────────────┬────────────┬────┘
                                  │   HTTP / REST (Express)     │
                        ┌─────────┴─────────────────────────────┐
                        │            server.js                   │
                        │  auth · masters · lots · invoicing ·   │
                        │  reports · exports · settings · admin  │
                        └─────────┬───────────────────┬──────────┘
                                  │                    │
         ┌────────────────────────┘          ┌────────┴───────────────────┐
         │   CALCULATION & FORMATTING         │   EXPORT / REPORT BUILDERS  │
         │   calculations.js                  │   exports.js  exports-pdf.js│
         │   invoice-pdf.js                   │   auction-reports.js        │
         │   distance.js  amount-words.js     │   lorry-reports.js          │
         │   report-formatters.js             │   spice-board-reports.js    │
         │   price-check.js                   │   dbf-exports.js  tally-xml │
         └────────────────────────┬───────────┴───────────┬────────────────┘
                                  │                        │
                        ┌─────────┴────────────────────────┴──────────┐
                        │              db.js  (data layer)             │
                        │   better-sqlite3 (desktop) · sql.js (cloud)  │
                        └────────────────────┬─────────────────────────┘
                                             │
                                   data/config.db  (one SQLite file = one company)
```

**The golden rule of this app:** *one deployment = one company = one `config.db` file.*
There is no multi-tenant database. To run a second customer, you run a second copy
of the app. (See [§7](#7-the-single-company-model) and the onboarding guide.)

---

## 3. How it runs (deployment targets)

| Target | Entry point | Database engine | Notes |
|---|---|---|---|
| **Web / Cloud (Railway)** | `server.js` via `Procfile` (`web: node server.js`) | `sql.js` (pure-JS, no native build) | `Dockerfile` + `nixpacks.toml` configure the build. Port `3001` (or `PORT`). |
| **Windows Desktop** | `electron/main.js` (`npm run build:win`) | `better-sqlite3` (native, faster, crash-safe WAL) | One-click NSIS installer. Data in `%APPDATA%`. |
| **Mobile PWA** | `public-mobile/app.html`, served at `/mobile` | (uses the server above) | Installable; `manifest.json` + service worker. Wired up by `mobile-bridge.js`. |

Both database engines expose the **same wrapper API** (`run`, `get`, `all`, `exec`,
`prepare`, `transaction`) from `db.js`, so the rest of the code doesn't care which is
in use. See [MIGRATION.md](MIGRATION.md) for the sql.js → better-sqlite3 background.

---

## 4. The codebase, module by module

Each top-level `.js` file is a focused module. Here's what each one is for:

### Core / server
| File | Role |
|---|---|
| `server.js` | The Express server — all ~150 API routes, auth, middleware, wiring. The hub everything connects to. |
| `db.js` | Database layer. Creates the schema, manages the single SQLite file, persists changes. |
| `company-config.js` | Company **settings** store — seeds and reads the ~130 config values (identity, rates, addresses, feature flags). |
| `license.js` | Time-limited licensing (30-day install, signed renewal tokens). |
| `mobile-bridge.js` | Serves the mobile PWA and provides the API shims it needs. |

### Calculation & document generation
| File | Role |
|---|---|
| `calculations.js` | The math engine — turns lots into amounts, commission, charges, GST splits, and payable totals. Builds invoice/bill/debit-note data. |
| `invoice-pdf.js` | Renders sales/purchase invoices, crop receipts and bills as PDFs (letterhead, numbering, formatting). |
| `report-formatters.js` | Shared helpers — Indian number/date formatting, company header drawing. |
| `amount-words.js` | Converts amounts to words (e.g. "One Lakh Twenty-Three Thousand…"). |
| `distance.js` | Estimates PIN-to-PIN road distance for e-way bill / transport charges. |
| `price-check.js` | Validates an uploaded price sheet against live lot prices before transactions. |

### Exports & reports
| File | Role |
|---|---|
| `exports.js` | Excel (XLSX) export builder and the catalog of export types. |
| `exports-pdf.js` | Generic PDF-table renderer for the Excel exports. |
| `auction-reports.js` | Lot slip, collection, and trade reports (custom layouts). |
| `lorry-reports.js` | Transport/logistics reports (lot-slip codes, truck list, buyer-lot-lorry). |
| `spice-board-reports.js` | Statutory Spice Board forms (Form C, Form D, buyers statement). |
| `dbf-exports.js` | Legacy FoxPro **DBF** exports for old downstream systems. |
| `tally-xml.js` | **Tally**-importable XML (sales, RD/URD purchase, debit notes, party ledgers). |

### Tools & helpers (not part of the running server)
| Path | Role |
|---|---|
| `tools/license-sign.js` | Developer CLI to mint a renewal token for a customer. |
| `scripts/` | One-off maintenance scripts. |
| `recover-isp.js` | Recovery helper. |

---

## 5. The data model (SQLite)

Everything lives in one file: **`data/config.db`**. Key tables:

| Group | Tables | What they hold |
|---|---|---|
| **Licensing** | `license_state` | Single row: install id, first-seen, expiry, last token. |
| **Auth** | `users`, `sessions`, `login_history` | Accounts, active logins, audit. |
| **Company** | `company_settings` | ~130 key/value settings (identity, rates, flags, Tally mappings). |
| **Masters** | `traders`, `trader_banks`, `buyers` | Sellers/poolers (+ bank accounts) and buyers. |
| **Auction data** | `auctions`, `lots`, `lot_allocations` | Trade sessions, lot records, branch lot-number ranges. |
| **Documents** | `invoices`, `purchases`, `bills`, `debit_notes` | Generated financial documents. |
| **Integrations** | `whatsapp_config`, `whatsapp_messages`, `gst_api_state`, `route_distances` | External service state and caches. |
| **Audit / safety** | `audit_log`, `import_log`, `reassign_log`, `delete_log` | Change history, import undo, deletion forensics. |

---

## 6. A typical day's data flow

```
1. Set up masters   → Traders, Buyers, and an Auction are created.
2. Lot entry        → Staff add lots (desktop or mobile PWA).         → lots table
3. Price check*     → Upload price sheet; must pass before next step. *(if enabled)
4. Calculate        → calculations.js fills amount, charges, GST.     → lots updated
5. Generate docs    → Invoices / purchases / bills / debit notes.     → documents + PDFs
6. Reports & export → Excel, DBF, Tally XML, Spice Board forms.       → downloads
```

---

## 7. The single-company model

This is the most important architectural fact, so it gets its own section.

- There is **no company picker** and **no company id** in requests.
- The app's identity, rates, branding and all data come from the **one** `config.db`.
- **Licensing is per install**, not per company — each deployment gets its own
  `install_id` and 30-day clock.
- **To onboard another customer, you stand up another deployment** with its own
  database, settings, branding and license.

Branding/identity is resolved with a fallback chain in `_company-identity-fallback.js`
(e.g. company name → Tally name → short name), so a partly-filled settings table
still renders sensible documents.

Full step-by-step instructions are in **[CUSTOMER-ONBOARDING.md](CUSTOMER-ONBOARDING.md)**.

---

## 8. Feature catalog & status

Legend: **✅ Complete** · **🟡 Optional (off by default, behind a feature flag)** ·
**⚙️ Needs external config** · **🚫 Disabled in the e-Auction build**

### Master data
| Feature | Status | Notes |
|---|---|---|
| Traders / sellers (CRUD, banks, import) | ✅ | Multiple bank accounts per trader. |
| Buyers (CRUD, import) | ✅ | GSTIN/PAN, trade-name aliasing. |
| Auctions / trades (CRUD, lot allocations) | ✅ | Branch lot-range allocation, reassignment, default auction. |

### Lot entry
| Feature | Status | Notes |
|---|---|---|
| Desktop lot entry | ✅ | Inline edit, bulk actions, auto-calc. |
| Mobile lot entry (PWA) | ✅ | Touch UI, seller quick-create, per-lot receipt. |
| Lot validation / next-lot suggestion | ✅ | Per branch. |
| Lot locking | 🟡 | `flag_lot_lock` — admin-unlock only. |
| Reserved price field | 🟡 | `flag_reserved_price`. |
| Moisture tracking | 🟡 | `flag_moisture`. |

### Invoicing & billing
| Feature | Status | Notes |
|---|---|---|
| Sales invoices (+ PDF, bulk, revert) | ✅ | Distance-based transport/insurance, GST splits. |
| Purchase invoices (+ PDF, bulk) | ✅ | Seller-side, TDS support. |
| Commission bills (F1 / F2) | ✅ | Single + bulk. |
| Payments summary | ✅ | Seller-wise aggregation, bank export, payment slips. |
| Debit notes | 🟡 | `flag_debit_note` — fully built, off by default. |

### Reports
| Feature | Status | Notes |
|---|---|---|
| Trade summary | ✅ | Lots/bags/qty, hourly timeline, branch breakdown. |
| Branch comparison | ✅ | Cross-branch, time-series. |
| Auction reports (lot slip, collection, trade) | ✅ | Custom XLSX + PDF layouts. |
| Lorry / transport reports | ✅ | Lot-slip code, truck list, buyer-lot-lorry. |
| Spice Board forms (C, D, buyers statement) | ✅ | Statutory cardamom reporting. |
| Price check | 🟡 | `flag_price_check` — gates transactions until prices verified. |

### Exports
| Feature | Status | Notes |
|---|---|---|
| Excel (XLSX) — sales/purchase journals, TDS return | ✅ | Branded headers, Indian formatting. |
| DBF (legacy FoxPro) | ✅ | Collection, movement, journals, TDS, payment. |
| Tally XML (sales, RD/URD purchase, debit note, ledgers) | ✅ | Detailed per-invoice / per-lot toggles. |

### Configuration & branding
| Feature | Status | Notes |
|---|---|---|
| Company settings (~130 fields, 14 categories) | ✅ | Identity, addresses, rates, HSN/SAC, bank, Tally, flags. |
| Settings import / export (JSON) | ✅ | Clone a customer's config in one step. |
| Logo upload | ✅ | Shown on login, topbar, PDFs. |
| Branding / theming (presets, density, fonts) | ✅ | White-label themes per deployment. |

### Platform, security & admin
| Feature | Status | Notes |
|---|---|---|
| Licensing (30-day install + signed renewal) | ✅ | HTTP 451 gate on expiry; `/renew.html`. |
| User authentication & sessions | ✅ | Per-session tokens, revoke sessions. |
| Role-based permissions | ✅ | Granular (view, write, delete, export, settings, etc.). |
| Audit logging & login history | ✅ | Tracks logins, settings changes, deletions. |
| Bulk delete with preflight + undo | ✅ | Soft-delete with recovery window. |
| Legacy data import (preview/run/undo) | ✅ | Migrate from old DBF systems. |
| Database backup & restore | ✅ | Auto-schedule + manual, compressed. |
| Health / stats / insights | ✅ | Revenue trend, dashboards. |

### Integrations
| Feature | Status | Notes |
|---|---|---|
| WhatsApp (send text/document, history, webhook) | ⚙️ | Fully wired; needs Meta Cloud API credentials. |
| GST lookup (GSTIN validation) | ⚙️ | Depends on external GST API; cached. |

### Intentionally disabled in this build
| Feature | Status | Notes |
|---|---|---|
| Sister-concern / ASP dual-company mode | 🚫 | e-Auction is single-company. |
| Praman CSV export, "Amazing" Tally mode, legacy discount models | 🚫 | Removed for the e-Auction build. |

> **Note on completeness:** there are no half-finished features in the running code.
> Items marked 🟡 are complete but **off by default** (flip a flag in Settings to use
> them); items marked ⚙️ are complete but need external credentials to function.

---

## 9. Where to look when…

| You want to… | Start in |
|---|---|
| Change a calculation / tax rule | `calculations.js` |
| Change how an invoice PDF looks | `invoice-pdf.js`, `report-formatters.js` |
| Add/adjust an API route | `server.js` |
| Add a setting or feature flag | `company-config.js` |
| Change the database schema | `db.js` |
| Adjust a Tally export | `tally-xml.js` |
| Onboard a new customer | [CUSTOMER-ONBOARDING.md](CUSTOMER-ONBOARDING.md) |
| Understand licensing in depth | [LICENSING.md](LICENSING.md) |
| Understand the DB engine change | [MIGRATION.md](MIGRATION.md) |

---

## 10. Keeping this document healthy

- This file is a **map, not a mirror** — describe structure and intent, not every line.
- When you add a **feature flag**, add a row to [§8](#8-feature-catalog--status).
- When you add a **module**, add a row to [§4](#4-the-codebase-module-by-module).
- When you add a **table**, add it to [§5](#5-the-data-model-sqlite).
- Update the **Last reviewed** date at the top whenever you touch this file.
