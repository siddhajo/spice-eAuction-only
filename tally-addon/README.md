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

Only needed for the **Auction No** and **buyer SBL** cells. Vouchers already in
Tally were imported before those two UDFs existed, so they carry no value and
those cells print blank until the auction is re-exported and re-imported.

Lot numbers and bags need none of this — they are native fields that historical
vouchers already carry (see below).

### 4. Print

Open a sales invoice in Tally (display or alter) and press **Alt+L**.

---

## Where each field comes from

Lot number and bag count are **native Tally fields**, read straight off each
inventory entry — no UDF, no re-import:

| Printed column | TDL reads | Emitted by `tally-xml.js` as |
|---|---|---|
| Lot No | `$BasicPackageMarks` | `<BASICPACKAGEMARKS>` inside `ALLINVENTORYENTRIES.LIST` |
| Bags | `$BasicNumPackages` | `<BASICNUMPACKAGES>` inside `ALLINVENTORYENTRIES.LIST` |

This site's other add-on, `BagLot.txt`, already proves those bind per entry —
it sums one of them across the collection in production:

```
numofpack : $$CollNumTotal:InventoryEntries:$$Number:$BasicNumPackages
```

…and retitles the same two fields to "Lot No" / "No. of Bags" on the voucher
entry screen. So invoices **already sitting in Tally** print their lots and bags
correctly with no re-import.

Only two values genuinely have no Tally field, and those travel as UDFs
declared in section 2 of the TDL and emitted by
[`tally-xml.js`](../tally-xml.js) (`UDF_NAMES`):

| UDF | Bound to | Source in the app |
|---|---|---|
| `SpiceAuctionNo` | the voucher | `invoices.ano` |
| `SpiceBuyerSBL` | the voucher | `buyers.sbl` |

**Both halves must spell the name identically.** If you rename one, rename the
other. [`tests/tally-letterhead-udf.unit.js`](../tests/tally-letterhead-udf.unit.js)
pins the names, the object each binds to, that blanks emit no tag, and that lot
and bags stay native rather than drifting back into UDFs.

---

## Known limitations

Read these before comparing the Tally print side by side with the app's PDF.

**Not pixel-identical.** TDL is a fixed row/column layout engine, not CSS. The
structure, banner, column grid and totals block match; things the .hbs does
with absolute positioning — the "Sl.NO" pinned inside the title bar, the
vertically-centred logo — are approximated with right-aligned fields.

**Separators are in.** Every section Part carries `Border : Thin Box` and every
column cell except the leftmost carries `Border : Thin Left`, which together
reproduce the .hbs grid — horizontal rules between sections, vertical rules
between columns, and a divider down the middle of the Billed-To / Shipped-To
block. `Border` is not valid on a `Form`, so the single frame around the whole
document is approximated by boxing each section; stacked, they read as one
continuous bordered document.

**No background fills.** The template tints its band rows a soft green
(`#e8f1e0`) — title strip, party headers, commodity band, column heads. A TDL
print format has no background-fill attribute known to work here, so those rows
render as **bold text in a boxed row**: the emphasis is reproduced, the colour
is not. Text colour *does* print (`Color` is a valid `Style` attribute) and
section 4 of the TDL carries a commented-out `SpiceBandText` style if you would
rather tint the text than leave it black. A true `Background :` fill is untested
and undocumented for print — the comment says so, and says what the failure
looks like if you try it.

**Logo — there is no RNS logo image to use.** The app holds only
`data/branding/logo-ispl.png`, which is Ideal Spices, and the `logo` setting is
the text code `"RNS"`, not a file. So nothing is being dropped: the app's own
RNS letterhead has no logo image either.

To add one, supply an RNS logo file. It must be **JPEG** — Tally will not render
PNG — and it must sit in the TallyPrime program folder, named in
`SpiceLogoFile`. The field itself is still commented out in section 6 because
`Type : Logo` is the least-certain construct in the file and an unrecognised
`Type` fails to compile even with a blank filename; it gets uncommented and
tested in the same round the real file arrives.

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

## Where this stands (2026-08-25)

Section 1 is now **pre-filled from the app's own settings**
(`data/config.db` → `company_settings`) rather than left as placeholders — RNS
SPICES, the Kerala address, FSSAI, GSTIN, SBL, PAN and the HDFC bank block. Each
line names its source key. Re-read them if Settings → Company / Address (Kerala)
/ Bank changes.

Two bugs fixed this round, both visible on yesterday's print:

- **`SpiceCoStateCode` was `33`** (Tamil Nadu) against the app's actual
  `tally_state_code` of `32` (Kerala). Every Kerala buyer was therefore treated
  as inter-state and charged **IGST instead of CGST+SGST**. Now `32`.
- **`SpiceRoundLedger` case.** The app sends `ROUND ON/OFF` uppercase; the
  filter compares it to `$LedgerName` as a string, so the old `Round On/Off`
  risked letting round-off through as a line item.

Still open: `$$InWords` (amount in words) and `$$FullList` (address lines)
remain unverified, and the cosmetic gaps below.

## Earlier state (2026-08-24)

Loads and renders on TallyPrime 7.1. Working: company name, title strip, TAX
INVOICE band, both party blocks, commodity band, lot rows (Lot No, Qty, Rate,
Value, Taxable), Gunny row, tax column headers, IGST and per-line Total,
"For <company>", signature row.

Open, in priority order:

1. **Section 1 has not been filled in yet.** The rendered invoice still shows
   the placeholder `IDEAL SPICES PRIVATE LIMITED` while the voucher number
   reads `RNS/L-30/26-27`, so address, phone, FSSAI, GSTIN, SBL, PAN and bank
   are all `""` and print blank. Set `SpiceCoStateCode` too — a Kerala buyer
   currently falls through to IGST against the default `33`.
2. **Totals row, Round Off and Grand Total print empty**, and amount-in-words
   is absent. `$$Total:SpiceFldITaxable` seems to return nothing, so the
   assumption that `$$Total:` accumulates across parts is suspect.
3. **Bags column blank on every row** although Lot No works — so
   `$BasicPackageMarks` resolves but `$$Number:$BasicNumPackages` does not.
   Compare against BagLot.txt's working usage.
4. Auction No and buyer SBL blank — expected, that voucher predates the UDFs.
5. Cosmetic: no outer box, no green header bands, logo commented out.

## Where the e-invoice data comes from

**Tally generates the e-invoices itself.** IRN, Ack No, Ack Date and the signed
QR are already stored on the voucher, so the layout just reads them — nothing
has to be imported from the app for this to work, and no app-side change is
needed.

One consequence worth knowing: `tally-xml.js` emits
`<IRNACKDATE>${dateval}</IRNACKDATE>` — the **invoice date** — on every sales
voucher, e-invoiced or not. That is not a real acknowledgement date. The layout
gates the printed value on `$IRN` so a fabricated date never reaches a tax
document, but the export tag itself is still wrong and is worth removing:
re-importing a voucher could otherwise overwrite a genuine IRP acknowledgement
date with the invoice date.

## E-invoice block (IRN / Ack No / Ack Date / e-Way Bill No / QR)

Section 6B, directly under the letterhead. **The labels always print; values
fill in only when the voucher carries them**, so a voucher never sent to the IRP
shows the labels bare — which is what a placeholder is for.

**e-Way Bill No is the one field still unconfirmed.** The export sends
`<EWAYBILLDETAILS.LIST>` — consignor, consignee, transport, distance — but no
number: like the IRN, the portal issues it and Tally stores it, so nothing
app-side changes for it to fill in. The number lives inside Tally's
EWayBillDetails sub-object, so the voucher-level spelling is uncertain; the
field tries `$EWayBillNo` then `$EWayBillNumber`. Trying both costs nothing
because an unknown field name yields blank rather than an error. If it stays
blank on a voucher that *has* an e-way bill, neither is right and it needs
reading out of the sub-collection — a change here, not in the app.

**Field names are confirmed.** `$IRN` and `$IRNAckNo` both printed real values
on an e-invoiced voucher (RNS/I-10), and dad's IRP tag list corroborates the
set: `<IRN>`, `<IRNACKNO>`, `<IRNACKDATE>`, `<IRNQRCODE>`, `<QRCODECRC>`.

**The QR and the logo are drawn by PARTS, not by fields.** This came from two
TDLs already loaded on the site's machine — `Customized Invoice.txt` and
`Invoice With Logo.txt`:

```
[Part: LWeInvoice QRC Title2]     [Part :LearnWellLOGO]
    QRCode: @@eInvoiceQRCValue : Yes  Graph Type: ##SALogoPath
    Width: 20% page                   Height : 12% page
    Height: 10% Page                  Width : 15% Page
```

In both cases the **Part** carries the image and holds one Line with one Field
set to `""` — the field exists only to give the part something to lay out.
`Type : Logo` / `Type : QR Code` on a *Field* is not a thing, and `Height` on a
Field is what raised T0014. On a **Part**, `Height` is valid.

Two deliberate departures from the reference:

- The logo path is `@@SpiceLogoPath` (`$LogoPath:Company:##SVCurrentCompany`)
  rather than the reference's `##SALogoPath`. That variable belongs to Tally's
  own sales-print report and may not be set inside this custom report; the
  company-master lookup is known to resolve here because the diagnostic strip
  returned the real path with it.
- The QR payload prefers `@@eInvoiceQRCValue` and falls back to `$IRNQRCode`.
  The reference's Ack No line reads
  `If ##IseInvPSPrintAfterSave Then ##eInvPSAckNo Else $IRNAckNo` — a session
  value during print-after-save, the stored field otherwise. Taking both means
  not depending on that print-session variable.

The QR part hides itself entirely when the payload is empty, so a
non-e-invoiced voucher gets no empty frame. The diagnostic strip prints the
same expression the QR renders, which separates "attribute not drawing" from
"voucher has no e-invoice" at a glance.

> A blank QR candidate proves nothing on a voucher with no IRN. The first
> diagnostic run used RNS/I-4, which was never e-invoiced, so all five QR
> candidates came back empty regardless of whether the name was right. Only the
> control line — which printed the company name — showed the mechanism worked.
> Test e-invoice fields on an e-invoiced voucher.

## Coexistence with `BagLot.txt`

Checked — **no clash**. `BagLot.txt` declares no UDFs at all; it only retitles
existing fields and adds a bag-count total to the Export Invoice print format.
Indices 20003/20004 are free, and the two add-ons touch different print
formats, so both can stay loaded.

Worth re-checking if a third local TDL is ever added: UDF indices are a shared
numbering space per company, and a collision corrupts values silently rather
than raising an error.

## Not yet verified on a live install

TDL has no offline compiler, so the layout in this file has been written
against the documented TDL grammar but **not compiled or rendered**. Expect a
round of fixes on first load — each reload reports the next error with a line
number, so it converges quickly.

**Fixed after load attempts 1 and 3, both T0051:** never put an attribute on
the same line as its `[Definition]` header. Not
`[Style: X] : Font : "Arial" : Height : 13` (several attributes), and not
`[Line: X] : Field : Y` either (just one) — both are rejected. Every attribute
goes on its own indented line.

> The first fix only corrected the multi-attribute cases, on the assumption
> that a single attribute was legal. It isn't, and the remaining 14 caused a
> second failed load. `tests/tally-letterhead-udf.unit.js` now fails the build
> if any compact form is reintroduced anywhere in the file, so this class of
> error cannot reach the Tally machine again.

**Fixed after the second load attempt (T0014):** `Border` is not a valid `Form`
attribute — it belongs on a Part, Line or Field. Removed from the Form. The
same pass confirmed `Space Top/Bottom/Left/Right` **are** valid on Form, since
the parser reached the `Border` line before complaining.

**Fixed after the first successful load ("Could not find the Repeated Line!"):**
two rules about `Repeat`. A line named in `Repeat` must also appear in that
part's `Lines` list, and a Part may carry only ONE `Repeat` — two do not stack.
Goods and charges therefore live in separate parts (`SpiceLHItems`,
`SpiceLHCharges`) with separate field names, and the totals block sums both.

**Idioms adopted from `BagLot.txt`**, since that file demonstrably compiles on
this install: `@@IsSales` as a bare system formula (not `$$IsSales:<arg>`), and
`$BasicPackageMarks` / `$BasicNumPackages` read per inventory entry.

**Fixed after the second render attempt ("Cannot understand. Bad formula!"):**
a continued line must not begin with a colon. TDL continues a line with a
trailing `+`; a leading `:` on the next line gets read as part of the
expression. The party and bank blocks were rebuilt as one Line per detail,
which removes the continuations and `$$NewLine` entirely and isolates each
expression so one bad detail no longer takes out a whole block.

**Fixed after the first successful RENDER — the big one.** A `[System: Formula]`
value is referenced with `@@`, never `##` (`##` is variable syntax). 84
references were wrong. Nothing errors — the values silently come back empty, so
the invoice printed with no company letterhead, no tax columns, no totals, no
grand total and no amount in words. `@@SpiceIsChargeLedger` was the one
reference written correctly, and the only thing on that page that worked.

Two more from the same render:
- A Part takes `Lines`, plural. The singular `Line :` is ignored, so the
  commodity band rendered as nothing.
- `Invisible` on a repeated line does NOT suppress it — the party ledger, CGST,
  SGST and Round On/Off all printed as line items. The charge repeat now runs
  over a filtered `[Collection: SpiceChargeLedgers]` instead, and every charge
  field (including the ledger NAME) is guarded as a second line of defence.

### The lint

`tests/tally-letterhead-udf.unit.js` checks the TDL for every trap hit so far:

1. compact `[Definition] : attr` forms (T0051)
2. `Border` on a `Form` (T0014)
3. undeclared repeated lines / stacked `Repeat`s ("Could not find the Repeated Line!")
4. continuation lines beginning with a colon ("Bad formula!")
5. dangling Line/Field/Part references
6. totals covering only one of the two repeat parts
7. unguarded charge fields (party ledger leaking into the totals)
8. `[System: Formula]` values referenced with `##` instead of `@@` — silent
9. `Line :` singular on a Part — silent

Each rule was verified by reintroducing the real bug and confirming the test
fails. Add to it rather than fixing one line at a time when a new class turns
up — a round trip here costs a visit to the Tally machine.

Remaining likely spots:

- **The `Alt+L` hook.** `[#Form: Voucher]` is the stable attach point across
  releases, which is why it was chosen. If the button doesn't appear on your
  build, the fallback is to attach the report to a menu item instead.
- **Replacing Tally's default print format** (so plain **Alt+P** uses this
  layout, no hotkey) is *not* wired up. It means overriding the built-in sales
  print report, whose internal name has shifted between Tally releases — worth
  doing once the layout itself is confirmed working, on the actual 7.1 install.
- **Built-in function names.** `$$Round`, `$$InWords`, `$$FullList`,
  `$$IsLedOfGrp`, `$$IsSales`, `$$StringPart` are the constructs most likely to
  raise the next error. Each one is isolated to a single line, so a T-error
  pointing at one is a one-line swap.
- **Column widths.** Eleven columns on A4 portrait is tight. If figures clip,
  trim the `Width : n% Page` values in section 10 — they sum to 100.
- **`$$IsLedOfGrp` group names** in `SpiceIsChargeLedger` (section 10b) assume
  the default group names. If your chart of accounts renames "Duties & Taxes"
  or "Sales Accounts", Transport/Insurance rows may appear or vanish
  incorrectly.

**The logo is commented out** (section 6). Tally prints images via a Field with
`Type : Logo`, the least-certain construct in the file, and an unrecognised
`Type` fails to compile even with a blank filename. Re-enable it once the rest
renders.
