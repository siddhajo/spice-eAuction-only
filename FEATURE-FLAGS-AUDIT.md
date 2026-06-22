# Feature-Flag Wiring Audit

**Audited:** 2026-06-22
**Scope:** All 26 flags defined in `company-config.js` (category `flags`).

## How flags are wired

The app consumes flags two ways:

1. **Frontend** — `applyFeatureFlags()` in [public/index.html](public/index.html#L6884) (~line 6884)
   sets `body[data-feat-*]` attributes, and CSS rules
   `body:not([data-feat-X="1"]) .feat-X { display:none }` hide tagged UI surfaces.
2. **Server-side** — PDF / calc / tally modules (`invoice-pdf.js`, `calculations.js`,
   `tally-xml.js`, `server.js`) read the flag value to alter computed output, or
   endpoints gate writes on it.

> Note: only 10 of the 26 flags pass through `applyFeatureFlags()`. The rest are
> wired server-side (or are dead — see below).

---

## ✅ Wired to working functionality (20)

| Flag | Wired to | Where it acts |
|---|---|---|
| `flag_hsn` | Shows/hides HSN-SAC column on all invoice PDFs (description column expands when off) | `invoice-pdf.js:322,1226,2027` |
| `flag_bank` | Bank-details block on Sales Invoice PDF | `invoice-pdf.js:1798-1837` |
| `flag_invoice_stripe` | Alternate-row grey striping in invoice line-item tables | `invoice-pdf.js:375,901` |
| `flag_round` | Rounds payment amounts + emits "Round Up/Down" line | `calculations.js:729,913` |
| `flag_tds_purchase` | Computes 194Q TDS on purchase invoices + Tally TDS block | `calculations.js:512`, `tally-xml.js:1929` |
| `flag_tds_sales` | TDS column/calc on sales invoices (taxable-value mode) | `calculations.js:375`, `tally-xml.js:578` |
| `flag_wgst` | Switches TDS base to full invoice amount (incl GST) | `calculations.js:376,505` |
| `flag_debit_note` | **Hard server gate** (403) on DN generation + hides all DN UI | `server.js:7109`, `index.html:1109` |
| `flag_debit_note_planter` | **Hard server gate** (403) on planter-DN writes + hides UI | `server.js:8076`, `index.html:1112` |
| `flag_local_ti` | Shows/hides Local Transport/Insurance rate fields in Settings | `index.html:13979` |
| `flag_addl_charges` | Shows/hides Additional Charge name/% fields in Settings | `index.html:13981` |
| `flag_whatsapp` | Shows/hides all WhatsApp share buttons app-wide | `index.html:1105,6898` |
| `flag_price_list_mapping` | Price List Mapping sidebar item + Lots toolbar button (default ON) | `index.html:6908,2524` |
| `tally_purchase_detailed` | Per-lot vs consolidated Tally purchase/URD voucher XML (default ON) | `tally-xml.js:1591,2007` |
| `flag_bulk_set_buyer_code` | "Set Buyer Code" bulk button + modal on Lots tab | `index.html:6917,3317` |
| `flag_bos_purchase_bill` | Toggles Bills tab between Purchase-Bill vs Commission-Bill UI (default ON) | `index.html:1132,6925` |
| `flag_price_check` | **Full gate**: Price Check tab + hard 412 block on Calculate/Invoice/Purchase/Bill/DN until verified | `server.js:2947`, guarded at `4808,5008,5198…` |
| `flag_lot_lock` | **Full gate**: lock/unlock UI + endpoints 404 when off + lock guards on mutations/cascades | `server.js:4213,4299`, `index.html:1145` |
| `flag_reserved_price` | Reserved Price input in Lot Entry (desktop + mobile) | `index.html:6942`, `app.html:596` |

---

## ⚠️ Conditionally wired / UI-only (3)

| Flag | Status | Caveat |
|---|---|---|
| `flag_dispatch` | Wired but **inert in this build** | Only consulted for ASP invoices (`invoice-pdf.js:824`); for the normal ISP/e-Auction path `showDispatch` is forced `true`, so the flag has no effect in the current e-Auction-only mode. |
| `flag_ship` | Wired but **inert in this build** | `showShipTo` is hardcoded `false` for ASP and `true` for ISP (`invoice-pdf.js:823`); the flag value is never the deciding input on the live path. A state-driven auto-toggle at `index.html:14027` sets it but the PDF ignores it. |
| `flag_print_selected_purchase` | **Frontend-only (PARTIAL)** | Button is flag-hidden (`index.html:6913`) but the server `purchase-pdf-bulk` endpoint enforces only ASP context, not the flag (`server.js:5722`). UI-level gate only. |

---

## ❌ Dead — defined but never consumed anywhere (4)

These appear in **Settings → Feature Flags** but toggling them does **nothing**.
Verified by whole-repo grep: zero references outside their definition line.

| Flag | Label | Definition |
|---|---|---|
| `flag_pooling` | Pooling (Single State) | `company-config.js:150` |
| `flag_sample` | Discount in Invoice | `company-config.js:151` |
| `flag_dummy` | Allow Dummy Invoices | `company-config.js:167` (ORIGINAL/DUPLICATE text is hardcoded in PDFs) |
| `flag_export` | Export Invoices | `company-config.js:169` |

---

## Caveats worth remembering

- **20 flags** are genuinely wired and working.
- **4 flags are dead**: `flag_pooling`, `flag_sample`, `flag_dummy`, `flag_export` — candidates for removal.
- **2 flags (`flag_dispatch`, `flag_ship`) are effectively inert** in the current
  e-Auction-only build; their code paths only matter in the ASP context, which the
  PDF generator hardcodes around.
- **Only 3 flags are true security gates** (server enforces them):
  `flag_debit_note`, `flag_debit_note_planter`, `flag_price_check`, `flag_lot_lock`.
  Several "WIRED" UI-toggle flags (`flag_bulk_set_buyer_code`, `flag_bos_purchase_bill`,
  `flag_reserved_price`, `flag_print_selected_purchase`) lack server-side flag re-checks —
  their endpoints respond regardless of flag state. By design (the flag just hides the
  surface), but they are **not** access-control gates.
