# Spice Letterhead Sales Invoice — TallyPrime add-on

Reproduces the app's **Letterhead** sales-invoice layout
([templates/sales-invoice/letterhead.hbs](../templates/sales-invoice/letterhead.hbs))
as a TallyPrime print format, so an invoice printed from Tally looks like one
printed from the app.

Built and tested against **TallyPrime 7.1**.

---

## What's in the box

| File | Purpose |
|---|---|
| `SpiceLetterheadInvoice.tdl` | The add-on. Company identity, UDF declarations, the layout, and the print hotkey. |
| — paired with `../tally-xml.js` | Emits four UDFs on the sales voucher that the layout reads. |

---

## Install — do these in order

The order matters. Tally **silently discards UDF tags it does not recognise**,
so a voucher imported before the TDL is loaded arrives with no lot numbers, no
auction number and no buyer SBL — and nothing anywhere reports an error.

### 1. Fill in the company block

Open `SpiceLetterheadInvoice.tdl` and edit **section 1** only. These values are
not read from the voucher — Tally's company master has no FSSAI or SBL field,
so the letterhead identity is set once here:

```
SpiceCoName      : "IDEAL SPICES PRIVATE LIMITED"
SpiceCoAddr1     : "..."
SpiceCoFSSAI     : "..."
SpiceCoGSTIN     : "..."
SpiceCoSBL       : "..."
SpiceCoPAN       : "..."
SpiceBankName    : "..."
...
```

Copy them from **Settings → Company** in the app, so the Tally print and the
app print agree. Leave a value as `""` to drop that line from the header.

Also check `SpiceGSTRate` (default `5`) and `SpiceHSNCard` (default
`09083120`) match `tally_gst_rate` / `tally_hsn_cardamom` in
**Settings → To Tally**.

### 2. Load the TDL into TallyPrime

1. Copy `SpiceLetterheadInvoice.tdl` somewhere stable, e.g.
   `C:\Tally\SpiceLetterheadInvoice.tdl`. Not the Downloads folder — Tally
   loads it from this path at every startup.
2. In TallyPrime: **F1 (Help) → TDL & Add-On → F4 (Manage Local TDLs)**
3. Set *Load selected TDL/TCP files on startup* to **Yes**
4. Add the full path to the file
5. **Ctrl+A** to accept, then restart TallyPrime

Verify it loaded: **F1 → TDL & Add-On** should list the file with no error. A
syntax error shows here as a red entry with a line number — fix and restart.

### 3. Re-export from the app

Vouchers already sitting in Tally were imported **before** the UDFs existed, so
they carry none of the four values and will print with blank Lot / Auction No /
SBL cells. Re-export the auction from the app and re-import it.

### 4. Print

Open a sales invoice in Tally (display or alter) and press **Alt+L**.

---

## The four UDFs

These are the values the printed invoice shows that Tally has no native field
for. They are declared in section 2 of the TDL and emitted by
[`tally-xml.js`](../tally-xml.js) (`UDF_NAMES`).

| UDF | Bound to | Source in the app |
|---|---|---|
| `SpiceLotNo` | each inventory line | `lots.lot_no` |
| `SpiceBags` | each inventory line | `lots.bags` |
| `SpiceAuctionNo` | the voucher | `invoices.ano` |
| `SpiceBuyerSBL` | the voucher | `buyers.sbl` |

**Both halves must spell the name identically.** If you rename one, rename the
other. [`tests/tally-letterhead-udf.unit.js`](../tests/tally-letterhead-udf.unit.js)
pins the names, the object each one binds to, and that blanks emit no tag.

### Why UDFs and not `BASICPACKAGEMARKS`

`tally-xml.js` already writes `<BASICPACKAGEMARKS>` (lot no) and
`<BASICNUMPACKAGES>` (bags) inside each `<ALLINVENTORYENTRIES.LIST>`. In
Tally's schema those two are **voucher-level despatch fields** ("Marks" /
"No. & Kind of Packages"), not inventory-entry fields — so Tally is expected to
ignore them where they currently sit. They were left untouched (the reference
export carried them, and removing them risks an unrelated regression), and the
UDFs are the per-line copy the layout actually reads.

---

## Known limitations

Read these before comparing the Tally print side by side with the app's PDF.

**Not pixel-identical.** TDL is a fixed row/column layout engine, not CSS. The
structure, banner, column grid and totals block match; things the .hbs does
with absolute positioning — the "Sl.NO" pinned inside the title bar, the
vertically-centred logo — are approximated with right-aligned fields.

**No background fills.** The template's soft-green header bands (`#e8f1e0`) have
no TDL equivalent in a print format. Those rows print bold-on-white instead.

**Logo is JPEG-only and print-only.** Tally renders `Type: Logo` fields in
Print and Preview but never on screen. Put a `.jpg` in the TallyPrime program
folder and name it in `SpiceLogoFile`. PNG (which is what
`data/branding/logo-ispl.png` is) will not render — convert it first.

**Always prints "TAX INVOICE".** The app's proforma flag does not survive the
trip to Tally — a proforma is exported as an ordinary sales voucher, so the
layout has nothing to branch on. If proformas need to print as "PROFORMA
INVOICE" from Tally, that needs a fifth UDF carrying `is_proforma`.

**Per-line tax is computed, not read.** Tally holds GST as invoice-level ledger
totals, so the CGST/SGST/IGST columns are derived per line as
`line value × rate`, and intra vs inter is decided by comparing the buyer's
GSTIN state code against `SpiceCoStateCode`. This matches how the app builds
the same columns. The column totals and the grand total are summed from these
line figures, so the printed total can never disagree with the column above it
— but on an invoice where Tally's own tax ledgers were hand-edited, the print
will show the computed figure rather than the edited one.

**Aggregate mode has no lot numbers.** With **Settings → To Tally → Detailed**
off, the app sends one inventory line covering every lot, so there is no single
lot number to print and the Lot cell is blank. Keep Detailed on for this layout.

**Sales invoice only.** Purchase invoice, commission bill and debit note have
letterhead templates in the app but no TDL equivalent yet. They follow the same
pattern — a new Report/Form plus whatever UDFs that document needs.

---

## Not yet verified on a live install

TDL has no offline compiler, so the layout in this file has been written
against the documented TDL grammar but **not compiled or rendered**. Expect a
round of fixes on first load. The likeliest spots:

- **The `Alt+L` hook.** `[#Form: Voucher]` is the stable attach point across
  releases, which is why it was chosen. If the button doesn't appear on your
  build, the fallback is to attach the report to a menu item instead.
- **Replacing Tally's default print format** (so plain **Alt+P** uses this
  layout, no hotkey) is *not* wired up. It means overriding the built-in sales
  print report, whose internal name has shifted between Tally releases — worth
  doing once the layout itself is confirmed working, on the actual 7.1 install.
- **Column widths.** Eleven columns on A4 portrait is tight. If figures clip,
  trim the `Width : n% Page` values in section 10 — they sum to 100.
- **`$$IsLedOfGrp` group names** in `SpiceIsChargeLedger` (section 10b) assume
  the default group names. If your chart of accounts renames "Duties & Taxes"
  or "Sales Accounts", Transport/Insurance rows may appear or vanish
  incorrectly.
