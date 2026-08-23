# Auction Desk — one roof for every auction

*(File keeps its TRADE-DESK.md name; the screen is called Auction Desk — see §7b.)*

Status: **Phases 1-3 complete + two rounds of deployed-build feedback**
(2026-08-23). Catalog, API, hub screen, ZIP bundle and the Lots view are in
and tested. Phase 4 (retiring redundant tabs) and Phase 5 (mobile PWA) are
not started.

## 1. The problem

To produce one trade's paperwork an operator crosses ~12 screens (Exports, Tally,
Spice Board, Lorry, DBF, Journals, Registers, TDS, Invoices, Purchases, Bills,
Debit Notes), re-selects the auction on each, and learns each screen's own
idiom for "pick a format and download". Nothing anywhere answers the two
questions that actually matter:

- **What does this trade still owe me?** (which documents are un-generated)
- **Where is everything?** (66 documents scattered across 12 screens)

## 2. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Sidebar impact | Hub becomes the **default landing screen**; all 30 existing tabs stay reachable and untouched. Retire redundant tabs in Phase 4, not before. |
| 2 | Stateful documents | Hub shows **live status + bulk download + deep-link**; generation stays on the owning screen. |
| 3 | Mobile PWA | **Web first.** Catalog API is built UI-agnostic so `public-mobile/app.html` can render the same manifest in a later phase. |
| 4 | ZIP bundle | **Phase 3**, after the hub proves itself. |

## 3. Guiding principle

> Unify the *description* of documents, not their *implementation*.

All ~80 existing document routes stay byte-for-byte as they are. The hub is a
new **read layer** over them. Nothing about how a Form D is built, numbered, or
rendered changes. This is what keeps the risk near zero and makes Phase 1
shippable without any user-visible change.

## 4. Current state (verified)

### Five server registries, five different shapes

| Registry | Location | Count | Shape |
|---|---|---|---|
| `EXPORT_TYPES` | `exports.js:1745` | 22 | `{fn, name, needsCfg}` |
| `TALLY_EXPORTS` | `server.js:14845` | 14 | `{label, name, builder, generator, isLedger, company, flag}` |
| `DBF_EXPORTS` | `dbf-exports.js:497` | 7 | `{fn, name, auctionWise, dateWise, label}` |
| `REPORTS` (Spice Board) | `spice-board-reports.js:2187` | 5 | `{label, name, json, xlsx, pdf, csv}` |
| `REPORTS` (Lorry) | `lorry-reports.js:1050` | 3 | `{name, xlsx, pdf}` |

Three of them already expose a near-identical `/list` endpoint
(`/api/tally/list`, `/api/dbf-exports/list`, `/api/spice-board-reports/list`) —
the catalog is the generalisation those three are converging on.

### Six stateful document families

`invoices`, `purchases`, `bills`, `debit_notes`, `debit_notes_planter`,
`payments` — each with its own `generate` → number → store → `pdf/:id` →
`pdf-bulk` lifecycle, plus `eligible-*` pickers.

### The endpoint shape is already uniform

Every stateless family is `GET <base>/:type[/:auctionId]?format=<fmt>`:

```
/api/exports/:type/:auctionId?format=xlsx|pdf|csv
/api/lorry-reports/:type/:auctionId?format=xlsx|pdf&inline=1
/api/spice-board-reports/:type/export?format=xlsx|pdf|csv&auctionId=&branch=…
/api/dbf-exports/:type?format=dbf|xlsx&auctionId=|from=&to=
/api/tally/export/:type/:auctionId?sale=L|I|E
/api/master-exports/:type?format=xlsx|dbf
```

This uniformity is what makes a single `endpoint` template field in the
catalog sufficient — no per-item adapter code.

### Client state that already works

- Shared trade context: `getSharedAucId` / `setSharedAucId` (`index.html:22484`),
  `sessionStorage['spice.sharedAucId']`, mirrored into `topbar-trade` and every
  select registered via `_wireAuctionSync`. **The hub piggybacks on this — it
  does not introduce a new selector.**
- Feature flags: `applyFeatureFlags()` (`index.html:9082`) → `body[data-feat-*]`
  + `.feat-*` CSS gates.
- Guided stage: `applyTradeStageLocks()` (`index.html:10327`) → `data-min-stage`
  + `.locked` + a capture-phase click interceptor that toasts the reason.
- Generation status: `_genFetchStatus()` → `/api/auctions/:id/generation-status`
  returns `{generated, pending, done}` per family. **This is the hub's status
  chip source — it already exists.**

### Server data the KPI strip needs — also already there

- `/api/reports/trade-summary/:auctionId` → per-branch and aggregate
  `lot_count, total_bags, total_qty, seller_count, sold_lots, sold_qty,
  withdrawn_lots, max_price, min_price, avg` — the entire KPI strip.
- `/api/lots/:id?summary=1` → priced-lot count (drives export unlock).
- `/api/auctions/:id/stage` → `{stage 0-4, signals:{lotsValidated}}`.

## 5. Architecture

Three layers. Only L1 and L2 are new code; L3 is a new screen.

```
                         ┌──────────────────────────────────┐
   L3  public/index.html │  tc-hub  — Trade Desk screen     │
                         │  KPI strip + tile grid, 100%     │
                         │  rendered from the manifest      │
                         └───────────────┬──────────────────┘
                                         │ GET /api/documents/catalog?auctionId=
                         ┌───────────────┴──────────────────┐
   L2  server.js         │  catalog API — resolves flags,   │
                         │  stage, perms, status, counts    │
                         └───────────────┬──────────────────┘
                                         │ requires
                         ┌───────────────┴──────────────────┐
   L1  document-catalog.js  │  DOCUMENTS[] — one manifest   │
                            │  union of 5 registries + 6    │
                            │  doc families = 66 entries    │
                            └───────────────┬───────────────┘
                                            │ endpoint: points at
     ══════════════════════════ UNCHANGED ══╪═══════════════════════════
      exports.js · tally-xml.js · dbf-exports.js · spice-board-reports.js
      lorry-reports.js · invoice-pdf.js · exports-pdf.js · ~80 routes
```

### L1 — `document-catalog.js` (new, ~400 lines, pure data)

A single declarative manifest. Zero logic beyond a couple of status helpers.

```js
{
  id:       'form_d',                      // stable, unique across all families
  label:    'FORM-D (Advance Auction Report)',
  group:    'statutory',                   // drives the UI section
  family:   'spiceboard',                  // which registry it came from
  kind:     'export',                      // 'export' = stateless, compute on demand
                                           // 'document' = generated, numbered, stored
  scope:    'trade',                       // 'trade' | 'dateRange' | 'master'
  formats:  ['pdf', 'xlsx'],               // buttons rendered on the tile
  minStage: 3,                             // guided-flow gate
  perm:     'export',                      // 'view' | 'export'
  filters:  ['branch', 'sellerId'],        // optional extra inputs the tile offers
  note:     'With flag_proforma_invoice ON this reads proforma rows only',

  // Two fields carry the endpoint, and the split is deliberate:
  route:    '/api/spice-board-reports/:type/export',   // the PATTERN, so the
                                                       // test can assert the
                                                       // route is registered
  href:     (ctx, format) => `/api/spice-board-reports/form_d/export?...`,
                                                       // the real URL, built
                                                       // server-side per request
}
```

A single `endpoint` string could not do both jobs: a static pattern can be
checked against the router but can't carry query parameters, and a built URL
carries parameters but can't be matched to a route. Splitting them is what
makes the coverage test possible.

Rules the manifest enforces by construction:

- **One id, one tile.** `eauction_csv` currently appears in both the Spice Board
  registry and the Export Center label table with two different call paths
  (`exportType()` special-cases it — see `index.html:29992`). The catalog gives
  it one entry, one endpoint, and that special case disappears.
- **`label` lives here, not in the client.** `EXP_LABELS`, `LORRY_LABELS`,
  `LORRY_REPORTS` ordering and the three `/list` endpoints all collapse into it.
- **Order in the array is display order.** No separate sort table.

### L2 — Catalog API (new, ~120 lines in `server.js`)

```
GET /api/documents/catalog?auctionId=<id>
```

Returns the manifest **already resolved for this user and this trade** — the
client renders it verbatim and makes no gating decisions of its own:

```jsonc
{
  "auctionId": 13, "ano": "13", "stage": 4,
  "kpi": { "allocatedLots": 202, "soldLots": 187, "soldWeight": 41300.0,
           "withdrawnLots": 15, "sellers": 131, "buyers": 39,
           "totalValue": 128460834.20 },
  "groups": [
    { "id": "statutory", "label": "Statutory & Spices Board",
      "items": [
        { "id": "form_d", "label": "FORM-D (Advance Auction Report)",
          "formats": ["pdf","xlsx"], "available": true,
          "href": { "pdf":  "/api/spice-board-reports/form_d/export?format=pdf&auctionId=13",
                    "xlsx": "/api/spice-board-reports/form_d/export?format=xlsx&auctionId=13" } },
        { "id": "tds_return", "available": false,
          "lockedBy": "stage", "lockReason": "Generate a transaction document first" }
      ] },
    { "id": "documents", "label": "Trade Documents",
      "items": [
        { "id": "invoices", "kind": "document", "available": true,
          "status": { "generated": 187, "pending": 12, "done": false },
          "deepLink": "invoices",
          "href": { "bulkPdf": "/api/invoices/pdf-bulk" } }
      ] }
  ]
}
```

Implementation is a **join of existing calls**, not new queries:

| Resolution | Source |
|---|---|
| flags | `getSettingsFlat(db)` |
| stage + `lotsValidated` | same logic as `/api/auctions/:id/stage` (extract to a shared fn) |
| permissions | existing `requireView` / `requireExport` predicates |
| doc status | `_generatedCount` / `_countRemainingParties` (already used by `/generation-status`) |
| KPI | `trade-summary` aggregate query (extract to a shared fn) |

**Locked items are returned, not omitted** — with `lockedBy` + `lockReason`, so
the hub can show *why* a document isn't available yet. This is the single
biggest UX gain over the current sidebar, where a locked item is invisible.

`GET /api/documents/catalog` with no `auctionId` returns the master-scope
subset (sellers, buyers, DBF masters) plus every item marked
`lockedBy:"trade"`.

### L3 — `tc-hub` screen (new, ~600 lines in `public/index.html`)

Registered exactly like every other tab: a `.tc` panel with `id="tc-hub"`, a
`side-item` with `data-tab="hub"`, and `hub: loadHub` in the `loaders` map at
`index.html:10229`.

```
┌────────────────────────────────────────────────────────────────────┐
│  Trade Desk          [ Auction 13 — 08-08-2026 (202 lots) ▾ ]      │  ← existing topbar-trade
├────────────────────────────────────────────────────────────────────┤
│  Allocated 202 │ Sold 187 │ Weight 41,300.000 │ WD 15              │  ← trade-summary
│  Sellers 131   │ Buyers 39│ Value ₹12,84,60,834.20                 │
├────────────────────────────────────────────────────────────────────┤
│  [ ] Select all          Filter: [_______]   [ Download selected ] │  ← Phase 3
│                                                                    │
│  TRADE DOCUMENTS                                                   │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐   │
│  │ Sales Invoices   │ │ Purchase Invoices│ │ Bills of Supply  │   │
│  │ ● 187 · 12 pend  │ │ ✓ All generated  │ │ ✓ All generated  │   │
│  │ [PDF] [Open →]   │ │ [PDF] [Open →]   │ │ [PDF] [Open →]   │   │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘   │
│                                                                    │
│  STATUTORY & SPICES BOARD                                          │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐   │
│  │ FORM-C           │ │ FORM-D           │ │ Buyers Statement │   │
│  │ [PDF] [XLSX]     │ │ [PDF] [XLSX]     │ │ [PDF] [XLSX]     │   │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘   │
│                                                                    │
│  ACCOUNTING (Tally · DBF · Journals)                    [collapse] │
│  …                                                                 │
└────────────────────────────────────────────────────────────────────┘
```

**Deliberate departure from the reference screenshot:** group by **purpose**,
not by file type. Form D exists as both PDF and XLSX; DBF modules exist as both
DBF and XLSX. A CSV/PDF/XML top-level split forces those to be listed twice.
File type becomes a *button on the tile* instead — which is also how every
existing screen already behaves.

Tile states:

| State | Render |
|---|---|
| available, `kind:'export'` | format buttons, live |
| available, `kind:'document'` | status chip (`✓ All generated` / `● 187 · 12 pending`) + bulk-PDF + `Open →` deep-link |
| locked | greyed, lock icon, `lockReason` visible on the tile (not just a tooltip) |
| flag-off | **not rendered at all** — a disabled feature should not advertise itself |

Deep-link handler: `hubOpen(tab)` → `setSharedAucId(currentId)` then `go(tab)`.
The trade carries across because the shared-context plumbing already broadcasts
to every wired select.

## 6. Catalog inventory (as built — 58 tiles + 8 hidden)

| Group | Tiles | Sources | Stage |
|---|---|---|---|
| Pre-auction | 7 | `EXPORT_TYPES` (lot_slip, lot_buyer, lot_name, price_list_before, dealer_list, planter_list) + `eauction_csv` | 2 |
| Trade Documents | 6 | invoices, purchases, bills, debit_notes, debit_notes_planter, payments | 2–3 |
| Trade Reports | 12 | the rest of `EXPORT_TYPES` | 3–4 |
| Statutory | 5 | Spice Board ×4 + TDS return | 2–4 |
| Banking & Payments | 4 | bank_payment(_before), payment, payment_party_wise | 2–3 |
| Logistics | 3 | `LORRY_REPORTS` | 4 |
| Accounting — Tally | 9 (+3 hidden) | `TALLY_EXPORTS`, each as XML + JSON; two also as e-Invoice JSON | 4 |
| ~~Accounting — DBF~~ | 0 (5 hidden) | removed from the screen — see §7b | — |
| Journals & Registers | 9 | 3 journals, 2 registers, 3 individual registers, pooler certificate | 4 |
| Masters | 2 | sellers, buyers (xlsx + dbf) | — |

Reconciliations worth knowing:

- `EXPORT_TYPES`' 22 entries split across Pre-auction, Trade Reports and
  Banking — it is a registry, not a group.
- `eauction_csv` sits in Pre-auction, not Statutory: it is a snapshot the
  office pulls *before* prices land.
- Three Tally keys are `hidden: true` — callable, never rendered: the
  `sales` alias for `sales_isp`, plus `sales_asp` and `isp_purchase` from
  the retired dual-company flow (see §7a).
- DBF's `traders` / `buyers` modules are reached through the two Masters
  tiles via `/api/master-exports`, which serves both the XLSX and the DBF
  form. The manifest declares this with `alsoCovers` so the coverage test
  doesn't mistake them for orphans.

## 7. Phasing

### Phase 1 — Catalog + API — **DONE** (no user-visible change)

- `document-catalog.js` — the 66-entry manifest. Pure data.
- `GET /api/documents/catalog` in `server.js`.
- `computeTradeStage(db, aid)` extracted from the `/api/auctions/:id/stage`
  route body so the catalog gates on exactly the numbers the sidebar does.
  The route is now a thin wrapper; its response is unchanged.
- `computeTradeKpi(db, aid)` — **written fresh, not extracted.** The plan said
  to extract it from `/api/reports/trade-summary`, but that route runs seven
  aggregate queries to build branch/seller/user/hourly/grade breakdowns the
  KPI strip never shows; extracting it would have made every catalog request
  pay for all of them. The new function is one query using trade-summary's own
  predicates (`amount > 0` = sold, `COALESCE(amount,0) <= 0` = withdrawn), so
  the two always agree on the figures they share.
- `tests/catalog.http.js` — 48 checks in two halves. Static: every `route`
  is registered in `server.js`, every `flag` is a real setting, every `href`
  builds a clean URL, and **every key of all five registries is reachable
  from some tile**. Live: boots a server, walks a fixture trade through
  stages 2 → 3 → 4 and asserts the gating, the status chips, the KPI figures,
  flag absence, and that every advertised URL is accepted by its route.

**Shippable on its own.** Nothing in the UI changes.

#### Defects the coverage check found on its first run

All four pre-date the catalog, 500 for every trade and every user, and are
recorded in `KNOWN_BROKEN` in the test — a **self-cleaning** list: if one
starts working the test fails and tells you to delete its entry.

| Export | Cause |
|---|---|
| Sales Taxes | `exports.js:1043` selects `bags as bag` from `invoices`, whose column is `bag` (`db.js:386`) → *no such column: bags* |
| Tally Purchase | `exports.js:1263` aliases `padd as add`; `ADD` is a SQLite keyword and needs quoting → *syntax error* |
| Tally · Sales Vouchers — ASP | `tally-xml.js` defines `buildSalesAspRows` at line 3685 but never exports it, so `server.js:37` destructures `undefined` → *def.builder is not a function* |
| Tally · ISP Purchase Vouchers | same missing export — it reuses `buildSalesAspRows` |

Not fixed here: out of scope for a phase that promised to change no
behaviour. Each is a one- or two-line fix.

One manifest correction came out of the same run: `bank_payment_before` is
XLSX-only — `exports-pdf.js` has no `COLS` entry for it, so `?format=pdf`
500s. The tile no longer offers a PDF button.

### Phase 2 — Hub screen — **DONE**

- `tc-hub` panel + `side-item` (first in Overview) + `hub: loadHub` in the
  `loaders` map. Old tabs untouched.
- `loadHub()` → one catalog fetch → `renderHubKpi` + `renderHubGroups`. The
  screen names no document anywhere: add a row to `document-catalog.js` and a
  correctly-gated tile appears with no change to `index.html`.
- Default landing tab, via `_landingTab()` replacing the two hard-coded
  `go('dash')` call sites (fresh sign-in and session restore). A footer link
  on the hub pins Dashboard as home instead; `lot_entry` users still land on
  Lot Entry as before.
- Group collapse persists in `localStorage.hubCollapsed`, seeded from the
  manifest's `collapsed` hint on first visit (Accounting, Journals and
  Masters start shut).
- Filter box searches label + id + family across all groups, hides groups
  with no match, and opens a collapsed group to reveal what it found.
- Deep links go through `hubOpen()` → `setSharedAucId()` → `go(tab)`, so the
  target screen is already pointed at the same trade before its loader runs.
- Bulk PDF (`All PDFs`) fetches ids from the family's `listUrl`, then POSTs
  to `bulkRoute`. The list routes cap at 500 rows, so when the catalog's
  `status.generated` exceeds what came back the hub says so and offers the
  partial rather than silently printing a subset.
- `tests/hub.browser.js` — 27 checks in headless Chrome: landing (both entry
  paths + the preference), tiles matching the API item-for-item, locked tiles
  visible with a reason, flagged-off tiles absent, filter behaviour, shared
  trade context in both directions, deep-link carrying the trade, and a real
  file landing on disk from a format button.

#### Two KPI defects found by looking at the rendered screen

Both were in the KPI query written in Phase 1, and neither would have shown
up in the API tests as written — they needed a fixture with realistic lots:

- **Sellers read 0** on a trade with 42 lots. `COUNT(DISTINCT trader_id)`
  counts nothing when lots carry a seller *name* but no master link yet. Now
  `COUNT(DISTINCT COALESCE(trader_id, NULLIF(name,'')))` — the same COALESCE
  trade-summary's own per-seller breakdown groups by.
- **Buyers read 1** on a trade with no buyers set: the empty string counted
  as a distinct buyer. Now wrapped in `NULLIF(buyer,'')`.

Both are now pinned by assertions in `tests/catalog.http.js`.

### Phase 3 — Bundle — **DONE**

Three endpoints, because a bundle is a job rather than a download — PDF items
render through Puppeteer and a 20-item bundle outlives any sane timeout:

```
POST /api/documents/bundle          → { jobId, total }
GET  /api/documents/bundle/:id      → { status, done, total, current, skipped }
GET  /api/documents/bundle/:id/file → the ZIP, then discarded
```

**The bundler knows nothing about any document type.** It takes the URLs the
catalog already resolved, fetches each over the server's own loopback
interface, and zips what comes back. So a document added to the manifest is
bundleable the same day, and there is no second rendering path that could
drift from what a single download produces.

- `buildDocumentCatalog()` extracted so the GET and the bundle share one
  resolution. **This is the security boundary**: the POST re-resolves the
  catalog server-side rather than trusting the URLs the client sent, so a
  caller cannot bundle anything their role, the trade's stage, or a feature
  flag denies them. Tested with a stage-locked id, an unknown id, an empty
  selection and an oversized one.
- Items are fetched **sequentially** — several render through Puppeteer, and
  running those concurrently turns a slow bundle into an out-of-memory one.
- A document with no rows does not sink the bundle: it is recorded, the rest
  still ships, and the ZIP carries a `_skipped.txt` saying what was left out
  and why.
- Filenames come from each response's `Content-Disposition`; collisions get
  the document id appended rather than one file silently winning.
- Jobs and their zips expire after an hour, are swept on each new bundle,
  and a zip is deleted the moment it is collected. A restart loses the job
  map but the on-disk sweep still cleans up.
- `archiver` was only transitively present — now an explicit dependency.
- UI: a checkbox on every bundleable tile, a selection bar that stays hidden
  until something is ticked, `Pick all N` per group, and a `Bundle as`
  choice (each document's usual format / PDF where available / Excel where
  available) so changing your mind about format costs no re-ticking.

**No "Trade Pack" preset.** The plan proposed one, but it would have meant
inventing which documents this office files every trade — a business
decision I have no basis for. `Pick all N` per group covers the same ground
without guessing, and a real preset can be added once someone says what
belongs in it.

Generated-document tiles (invoices, bills, …) are deliberately **not**
selectable: their PDFs come from a bulk route keyed on ids, not from an
href, so they carry a bulk button and a deep-link instead. `Pick all` counts
selectable tiles rather than ready ones, so no group offers a button that
would do nothing.

### Phase 4 — Consolidation

Retire tabs whose entire content is now reachable from the hub: Exports, Tally,
Spice Board, Lorry, DBF, Journals, Registers, TDS. Keep every tab that owns a
*workflow* (Invoices, Purchases, Bills, Debit Notes, Payments, Lots, Lot Entry).
Only after the hub has been in real use for a full trade cycle.

### Phase 5 — Mobile

Render the same catalog in `public-mobile/app.html`. Cheap because labels,
formats, gating and status all arrive pre-resolved from L2.

## 7a. Post-deploy corrections

Four things a real deployment surfaced that no test had, because three of
them were questions about the *content* of the manifest rather than its
mechanics:

**Total Value overflowed its KPI tile.** `₹20,70,44,630.00` is twelve
characters and the KPI grid gives every figure the same lot-count-sized
column. It now takes a double-width tinted cell and drops the paise —
nobody reads a trade total to two decimals, and `.00` is what tipped it
over.

**The Tally JSONs were missing.** Every Tally export also answers
`?format=json`, and `?format=irp` returns GST e-Invoice JSON for the portal
— but only for `sales_isp` and `debit_note`, the two row shapes carrying the
buyer GSTIN and address that schema needs. The manifest declared `['xml']`
throughout, so two thirds of Tally's output was invisible. Now every Tally
tile offers XML + JSON, and those two additionally offer e-Invoice JSON.
`hrefTally` sends no `format` param at all for XML, matching how the Tally
screen has always called it.

**Two exports were advertised that the app no longer offers.**
`sales_asp` and `isp_purchase` belong to the old ASP→ISP sister-concern
flow. They sit in `TALLY_EXPORTS`, but the Tally screen's `TALLY_LABELS`
lists neither, `applyTallyCompanyVisibility()` calls the ISP/ASP split
"vestigial", and `flag_sister` was *intentionally removed* from the settings
schema. The hub was surfacing them purely because the registry still held
them — the failure mode of building a catalog from registries rather than
from what the app actually offers. Both are now `hidden: true`: callable
over the API for anyone still running that flow, never advertised.

**The screen read as dull.** It was structurally right and visually flat:
sixty-five near-identical grey tiles in ten unlabelled sections. Fixed with
a per-group accent colour (ten distinct hues, not ten tints of the theme
green — the point is to make a long scroll navigable at a glance), an icon
chip per group, accent-coloured count pills and tile hover edges, and the
primary format button in the group's colour. The primary button is now the
*first declared format* rather than always PDF, which makes it the same
choice the bundle makes by default — one rule in two places. Preview and
Print became icon buttons: spelled out, the four-button row wrapped onto a
second line and made every tile in the grid taller. A test now asserts that
row stays on one line.

## 7b. Second round of deployed-build feedback

**Accounting — DBF removed from the screen.** The five entries stay in the
manifest as `hidden: true` rather than being deleted: deleting them would
make the coverage test report five orphaned `DBF_EXPORTS`, and the Exports
tab's DBF section still serves anyone who needs them. Drop `hidden` from the
five to bring the group back.

**"Find a document" is now a combobox.** The plain filter box only worked if
you already knew what you were looking for. It now carries a dropdown of
every document, grouped, searchable, with each one's formats shown — picking
a name shows just that document and scrolls to it, opening its group on the
way. Locked documents still list, for the same reason locked tiles still
render: knowing a document exists beats it being invisible. Free-text typing
still narrows the whole grid as before.

**"Trade" → "Auction" throughout this screen.** The topbar already said
AUCTION; the hub was the odd one out. Renamed: the sidebar entry (Trade Desk
→ **Auction Desk**), the picker label, the group labels (Auction Documents,
Auction Reports), every lock reason, the bundle filename
(`Auction_13_Documents.zip`) and the hub's own copy. Two things deliberately
kept: the manifest's `scope: 'trade'` and the internal `_trade*` variables —
renaming those touches the guided-stage machinery shared with every other
screen, for no user-visible gain. This document keeps its filename.

## 7c. Lots view (§4 of the same feedback)

Selecting an auction now shows what is *in* it, not just what it produces.

**Two tabs, Lots first.** A segmented control under the KPI strip switches
between Lots and Documents; the choice sticks per browser. Lots leads
because that is what an operator wants the moment they pick an auction. Each
view has its own toolbar — lot search and branch filter on one side, the
document combobox and date range on the other — so neither screen carries
the other's controls.

- The lot list uses `/api/lots/:id`'s **un-paginated** path, which returns
  the auction in ascending lot order — how the office reads a lot list. The
  paginated path sorts descending, so paging happens in the browser (60 rows
  at a time) instead.
- Search and branch filter run server-side; branch options are built from
  the lots actually present, so the filter never offers an empty branch.
- Withdrawn lots are greyed and marked WD/NA rather than showing a bare
  zero, and a seller with no bank account on file carries a badge — that lot
  cannot be paid, and it is the one warning the row can't otherwise show.

**Row click opens a right-hand drawer** with the full field set — seller,
lot, sale and computed figures — over a list that stays visible behind it.
Escape or the scrim closes it.

**Edit hands off to the app's existing `openLotEdit` modal.** One editor in
the codebase, not two. The only integration needed was teaching `saveLot()`
and `delLot()` to refresh the Auction Desk's list as well as the Lots
screen's, since each keeps its own copy of the rows. The drawer also offers
"Open in Lots →" for the things that screen owns — price import, bulk
actions, Calculate All.

## 7d. Third round of feedback

**Raw Tally JSON dropped.** `?format=json` returns the same vouchers the XML
carries, in a form nobody in the office imports — and it manufactured a
whole "JSON" heading in the file-type view. Tally tiles now offer XML, plus
**e-Invoice JSON** on the two types the GST portal schema supports.

**Jargon removed from labels.** "Sales Vouchers — ISP" → Sales Vouchers;
"Debit Notes (Discount)" → Debit Notes; likewise the planter one. The ISP/ASP
distinction is meaningless in a single-company build (§7b) and "Discount"
described the accounting treatment, not the document.

**Subgroups.** Ten groups of a dozen tiles is still a wall. Every entry now
carries a `sub`, so Journals & Registers reads as Journals / Registers /
Individual registers / Certificates, Tally as Ledger masters / Vouchers, and
so on. Order follows first appearance in the manifest. A group with one
subgroup renders as a plain grid — no heading that just repeats the group
name. The file-type view suppresses subgroups: there, format *is* the split.

**Per-document filters.** The manifest's `filters` field finally does
something. A funnel button on each tile that supports them opens a panel
with real pickers — branches, sellers and buyers sourced from
`/api/spice-board-reports/filters`, sale types L/I/E — and the chosen values
append to the URL the server built. Applied filters show on the tile in
words, so a narrowed document can't be mistaken for the whole one. Download,
Preview, Print and the ZIP bundle all honour them.

Two things this deliberately does NOT do:

- **It does not invent filters.** The declarations were rewritten against
  the routes: every `EXPORT_TYPES` export reads `branch` / `saleType` /
  `sellers` (server.js:14782); Spice Board reads `branch` / `sellerId` /
  `buyerCode`; Tally reads `sale` but only for `SALE_FILTERABLE_TYPES`. A
  test asserts each declared filter is accepted on the wire.
- **The bundler will not forward an undeclared key.** Filters sent with a
  bundle item are intersected with that document's declared set, so the
  bundle endpoint cannot become a way to bolt arbitrary query params onto
  an export route.

Row-level selection — tick these six invoices, print those — stays on the
owning screens, which have the tick columns and the context for it. The hub
scopes a document by attribute, not by hand-picked rows.

## 7e. Plain mode and the role gate

**Plain mode.** One user reads the colour as noise. `body[data-hub-plain="1"]`
re-skins the desk in neutrals — white cards with a `#E2E8F0` border, a
`#334155` graphite action colour, `#94A3B8` accent bars, greyscale icon
chips, and no gradients or glows. It is a pure CSS override layered on top
of the coloured build, not a second stylesheet: every tile, KPI card, widget
and modal keeps its markup and its class names, so the two modes cannot drift
apart. The preference is per-browser (`localStorage`), toggled from a button
beside the auction picker, and scoped strictly to the desk — no other screen
changes. Legibility, not blandness, is the target: contrast is *higher* in
plain mode than in colour, and a test asserts nothing renders same-on-same.

Note this is **not** the dark-mode fix. The app-wide dark defect — derived
tokens baked at `:root` while the overrides land on `body` — is untouched, by
explicit decision.

**Role gate.** The desk is a manager-and-admin tool: it puts every document
in the business, for every party, one click from a ZIP. Access is a real
capability, `auction_desk`, granted to `manager` and `admin` in
`ROLE_PERMISSIONS`, and enforced in both places that matter:

- **Server.** `requireAuctionDesk` guards all four `/api/documents/*` routes
  — catalog, bundle create, bundle poll, bundle download. This is the actual
  boundary. `catalog.http.js` signs in as viewer, operator and lot_entry and
  asserts 403 on catalog *and* bundle for each, then 200 for manager and
  admin.
- **Client.** The sidebar button carries `.needs-auction-desk`, hidden unless
  `body[data-perm-auction-desk="1"]`. `go('hub')` refuses and falls back to
  the dashboard with a toast, and `_landingTab()` returns `dash` so a user
  whose saved home is the desk still lands somewhere they can use. This is
  courtesy, not security — it stops a stale preference or a bookmarked hash
  from dropping someone on an empty screen.

## 7f. Tally party & document-number pickers

The Tally filter asked the operator to **type** a party name and an invoice
number. Both match exactly server-side, so one extra space or a raw bill
number instead of the formatted one returned an empty file with no
explanation. Both are now search-and-pick, same control as everywhere else.

**Where the options come from is the point.** The register pickers read a
master (`/api/traders`, `/api/buyers`). Tally must not: its filter runs over
the *built voucher rows*, so a master would offer parties that aren't in this
auction's vouchers. `GET /api/tally/filter-options/:type/:auctionId` runs the
export's own `def.builder` and returns the distinct parties and document
numbers actually present — every value offered is guaranteed to select
something. A test asserts the strong form: picking **every** offered party
reproduces the unfiltered export byte-for-byte.

The client learns which export a tile is via `tallyType`, stamped onto the
catalog item from `hrefTally`'s closure (`fn.tallyType = type`) rather than
repeated on thirteen entries where it could drift.

**Sale type feeds the lists.** Options are gathered *after* `filterRowsBySale`,
so choosing Local and then opening the party list must not offer inter-state
buyers. Changing the sale type re-opens the dialog on the current draft —
carrying the other choices forward, dropping the party/invoice picks that
were made against the previous list.

**A pre-existing bug fell out of this.** `filterRowsByDoc` read `invo` then
`note_no`. Every voucher builder normalises to `voucherNum`, and on Bills of
Supply that is the *formatted* number (`formatBillOfSupplyNo`) — the only
form that appears on the document or the Bills screen. So the `invoice`
filter on URD Purchase Vouchers matched nothing and always 404'd. Both the
filter and the options endpoint now read one shared `tallyDocNo()` accessor,
so they cannot drift apart.

Two smaller fixes alongside: the number field is labelled **Invoice / Note
no** (it covers `invo` on sales/purchases and `note_no` on debit notes, so
calling it "Invoice" was half true), and opening one picker now closes the
others — with two pickers in one dialog, the upper list covered the field
the operator had just clicked into.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Manifest drifts from the real routes | Phase 1 test asserts every endpoint resolves; runs in CI. |
| 65 tiles is its own kind of overwhelming | Purpose grouping + collapsible sections + a filter box. Accounting and Masters collapsed by default. |
| Catalog request becomes slow (status + KPI + flags per load) | All three sources are already single-query aggregates. Cache per `(auctionId, userId)` for the request only; no cross-request cache — status must stay live. |
| Default-tab change disorients existing users | Settings toggle to restore `dash` as landing. |
| ~~Phase 3 bundle timeouts~~ | Resolved: job + poll, items fetched sequentially. |

## 9. Non-goals

- Rewriting any export, report, or PDF builder.
- Changing document numbering, proforma logic, lot-wise mode, or seller-grade
  rules. The hub is strictly read-and-route.
- Moving generation into the hub (decision 2).
- Touching the Electron or mobile-native shells.
