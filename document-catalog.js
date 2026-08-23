// ── DOCUMENT CATALOG ─────────────────────────────────────────
// One manifest describing every downloadable artefact in the app: the 5
// server registries (EXPORT_TYPES, TALLY_EXPORTS, DBF_EXPORTS, the Spice
// Board REPORTS, the Lorry REPORTS) plus the 6 generated document families
// (invoices, purchases, bills, debit notes, DN-planter, payments).
//
// This file is DESCRIPTION ONLY. It contains no export logic and no SQL —
// every entry points at a route that already exists and is unchanged. The
// catalog exists so that one screen (Trade Desk) can render the whole
// document surface without hard-coding 67 labels, formats and URLs, and so
// tests/catalog.test.js can prove no export has been orphaned.
//
// See TRADE-DESK.md for the architecture this belongs to.
//
// ── ENTRY SHAPE ──────────────────────────────────────────────
//   id        stable unique key across ALL families (the tile's identity)
//   label     human name — the single source of truth, replacing the
//             client-side EXP_LABELS / LORRY_LABELS tables
//   group     which UI section the tile lands in (see GROUPS below)
//   family    which registry/subsystem it came from — diagnostics only
//   kind      'export'   stateless, computed on demand
//             'document' generated, numbered and stored; has status + a
//                        deep-link to the screen that owns generation
//   scope     'trade'     needs an auctionId (the CODE keeps 'trade';
//                         only user-facing wording says "auction")
//             'dateRange' needs from/to instead of a trade
//             'master'    neither — exports the full master table
//   formats   download formats offered as buttons on the tile. A tile that
//             offers 'pdf' also implicitly offers Preview and Print — both
//             just open the same PDF (see exportPreview/exportPrint), so
//             they are NOT separate formats.
//   route     the Express route PATTERN this entry calls. Exists so the
//             catalog test can assert the route is actually registered;
//             the real URL comes from href() below.
//   href      (ctx, format) => url. ctx = { auctionId, ano, from, to, ... }.
//             Resolved server-side so the client never builds a URL.
//   flag      feature flag that must be 'true' for the tile to exist at all.
//             A flagged-off document is NOT rendered (unlike a stage-locked
//             one, which renders greyed with a reason).
//   minStage  guided-flow stage required (see /api/auctions/:id/stage):
//               2 lots imported · 3 at least one priced lot · 4 at least one
//               transaction document generated
//   perm      'view' | 'export' — mirrors requireView / requireExport
//   statusKey key into /api/auctions/:id/generation-status (kind:'document')
//   deepLink  sidebar tab that owns this document's generation UI
//   bulkRoute POST route that renders many of these as one merged PDF, given
//             { ids: [...] }. Payments is deliberately absent: its bulk route
//             takes { auction_id, names[] }, which needs the seller picker
//             that lives on the Payments screen — so its tile deep-links
//             instead of offering a bulk button it could only half-fill.
//   listRoute GET route returning the rows to collect ids from. Responds as a
//             bare array (capped at 500) or { rows, total } when paged.
//   listParam which query param that route filters by — NOT uniform:
//             debit_notes_planter keys off `ano`, the rest off `auction_id`
//   filters   optional extra inputs the tile can offer
//   hidden    kept callable for compatibility but never rendered as a tile
//   alsoCovers registry keys this tile serves through a different route, so
//             the catalog test doesn't flag them as orphaned exports
//   note      operator-facing caveat surfaced on the tile

// Query-string builder — drops empty values so URLs stay clean.
const q = (params) => {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
};

// ── URL builders, one per family ─────────────────────────────
// Each mirrors exactly how the existing screens call these routes today.
const hrefExport = (type) => (ctx, format) =>
  `/api/exports/${type}/${ctx.auctionId}${q({ format, state: ctx.state })}`;

const hrefSpiceBoard = (type) => (ctx, format) =>
  `/api/spice-board-reports/${type}/export${q({
    format, auctionId: ctx.auctionId, branch: ctx.branch,
    sellerId: ctx.sellerId, buyerCode: ctx.buyerCode,
    dateFrom: ctx.dateFrom, dateTo: ctx.dateTo,
  })}`;

const hrefLorry = (type) => (ctx, format) =>
  `/api/lorry-reports/${type}/${ctx.auctionId}${q({ format })}`;

// Tally speaks three formats off one route:
//   xml   Tally import XML — the default, sent with no format param at all
//   json  the same voucher rows as JSON
//   irp   GST e-Invoice (IRP / NIC) JSON for the portal. Only sales_isp and
//         debit_note carry the buyer GSTIN/address that schema needs; the
//         route rejects every other type, so only those two declare it.
const hrefTally = (type) => (ctx, format) =>
  `/api/tally/export/${type}/${ctx.auctionId}${q({
    format: format === 'xml' ? '' : format, sale: ctx.sale })}`;

const hrefDbf = (type) => (ctx, format) =>
  `/api/dbf-exports/${type}${q({ format, auctionId: ctx.auctionId, from: ctx.from, to: ctx.to })}`;

const hrefMaster = (type) => (ctx, format) =>
  `/api/master-exports/${type}${q({ format })}`;

// ── GROUPS ───────────────────────────────────────────────────
// Declaration order is display order. Grouped by PURPOSE, not by file
// type: Form D is both PDF and XLSX, every DBF module is both DBF and
// XLSX, so a CSV/PDF/XML split would list several documents twice.
// Format is a button on the tile instead.
const GROUPS = [
  { id: 'preauction', label: 'Pre-auction',
    hint: 'Snapshots of the lot list before prices land' },
  { id: 'documents',  label: 'Auction Documents',
    hint: 'Generated and numbered — open the owning screen to create them' },
  { id: 'reports',    label: 'Auction Reports',
    hint: 'Post-pricing views of the auction' },
  { id: 'statutory',  label: 'Statutory & Spices Board' },
  { id: 'banking',    label: 'Banking & Payments' },
  { id: 'logistics',  label: 'Logistics' },
  { id: 'tally',      label: 'Accounting — Tally',      collapsed: true,
    hint: 'XML to import · JSON rows · e-Invoice JSON for the GST portal' },
  { id: 'dbf',        label: 'Accounting — DBF',        collapsed: true },
  { id: 'books',      label: 'Journals & Registers',    collapsed: true },
  { id: 'masters',    label: 'Masters',                 collapsed: true,
    hint: 'Not auction-specific — exports the full master table' },
];

// ── THE MANIFEST ─────────────────────────────────────────────
const DOCUMENTS = [

  // ══ Pre-auction ══════════════════════════════════════════
  // Available from stage 2 (lots imported) — these are the pre-import
  // safety net, so they must NOT wait for prices. Mirrors EXP_PREAUCTION
  // in public/index.html, same declared order.
  { id: 'lot_slip', label: 'Lot Slip', group: 'preauction', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 2, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('lot_slip') },

  { id: 'lot_buyer', label: 'Lot Buyer', group: 'preauction', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 2, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('lot_buyer') },

  { id: 'lot_name', label: 'Lot Name', group: 'preauction', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 2, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('lot_name') },

  // Lives in the Spice Board registry (fixed portal schema, per-lot rows)
  // but has always been surfaced in the Export Center too. Today that
  // costs a special case in exportType() — index.html:29992. One entry
  // here, one endpoint, and that special case goes away.
  { id: 'eauction_csv', label: 'e-Auction (Spices Board) CSV', group: 'preauction',
    family: 'spiceboard', kind: 'export', scope: 'trade', formats: ['csv'],
    minStage: 2, perm: 'export',
    route: '/api/spice-board-reports/:type/export', href: hrefSpiceBoard('eauction_csv'),
    note: 'Fixed Spices Board portal schema — CSV only' },

  { id: 'price_list_before', label: 'Price List (Before)', group: 'preauction', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 2, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('price_list_before') },

  { id: 'dealer_list', label: 'Dealer List', group: 'preauction', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 2, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('dealer_list') },

  { id: 'planter_list', label: 'Planter List (Grade 1)', group: 'preauction', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 2, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('planter_list') },

  // ══ Trade Documents (generated + numbered) ═══════════════
  // kind:'document' — the hub shows live status and offers bulk PDF, but
  // generation stays on the owning screen (deepLink). See TRADE-DESK.md §2.
  { id: 'invoices', label: 'Sales Invoices', group: 'documents', family: 'invoices',
    kind: 'document', scope: 'trade', formats: ['pdf'], minStage: 3, perm: 'view',
    statusKey: 'invoices', deepLink: 'invoices',
    route: '/api/invoices/pdf-bulk', bulkRoute: '/api/invoices/pdf-bulk',
    listRoute: '/api/invoices', listParam: 'auction_id' },

  { id: 'purchases', label: 'Purchase Invoices', group: 'documents', family: 'purchases',
    kind: 'document', scope: 'trade', formats: ['pdf'], minStage: 3, perm: 'view',
    statusKey: 'purchases', deepLink: 'purchases',
    route: '/api/invoices/purchase-pdf-bulk', bulkRoute: '/api/invoices/purchase-pdf-bulk',
    listRoute: '/api/purchases', listParam: 'auction_id' },

  { id: 'bills', label: 'Bills of Supply', group: 'documents', family: 'bills',
    kind: 'document', scope: 'trade', formats: ['pdf'], minStage: 3, perm: 'view',
    statusKey: 'bills', deepLink: 'bills',
    route: '/api/bills/pdf-bulk', bulkRoute: '/api/bills/pdf-bulk',
    listRoute: '/api/bills', listParam: 'auction_id' },

  { id: 'debit_notes', label: 'Debit Notes', group: 'documents', family: 'debit_notes',
    kind: 'document', scope: 'trade', formats: ['pdf'], minStage: 3, perm: 'view',
    flag: 'flag_debit_note', statusKey: 'debit_notes', deepLink: 'debit',
    route: '/api/debit-notes/pdf-bulk', bulkRoute: '/api/debit-notes/pdf-bulk',
    listRoute: '/api/debit-notes', listParam: 'auction_id' },

  // The one family whose list route does NOT accept auction_id — planter
  // debit notes are keyed by `ano` (server.js:12597). The catalog carries
  // the difference so the hub doesn't have to special-case it.
  { id: 'debit_notes_planter', label: 'Debit Notes — Planter', group: 'documents',
    family: 'debit_notes_planter', kind: 'document', scope: 'trade', formats: ['pdf'],
    minStage: 3, perm: 'view', flag: 'flag_debit_note_planter',
    statusKey: 'debit_notes_planter', deepLink: 'debitplanter',
    route: '/api/debit-notes-planter/pdf-bulk', bulkRoute: '/api/debit-notes-planter/pdf-bulk',
    listRoute: '/api/debit-notes-planter', listParam: 'ano' },

  // Two things set Payments apart from its neighbours, and both are
  // deliberate rather than oversights:
  //   - no statusKey: nothing here is numbered, so there is no
  //     generated/pending count to show
  //   - no bulkRoute: /api/payments/pdf-bulk wants { auction_id, names[] },
  //     and choosing those names is the Payments screen's whole job. A hub
  //     button could only ever send an arbitrary subset, so the tile
  //     deep-links instead.
  { id: 'payments', label: 'Payment Advice', group: 'documents', family: 'payments',
    kind: 'document', scope: 'trade', formats: ['pdf'], minStage: 2, perm: 'view',
    deepLink: 'payments',
    route: '/api/payments/pdf-bulk' },

  // ══ Trade Reports ════════════════════════════════════════
  // Export Center members. minStage 3 — not 2 — because the Center is
  // hidden until at least one lot carries a price (see
  // updateExportCenterVisibility, index.html:29906). The sidebar's Exports
  // item says stage 2, but at stage 2 only the pre-auction group is live.
  { id: 'trade_report', label: 'Auction Report', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('trade_report') },

  { id: 'collection', label: 'Collection', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('collection') },

  { id: 'checklist', label: 'Checklist', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('checklist') },

  { id: 'full_file', label: 'Full File', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('full_file'),
    note: 'Too many columns for any printable page — XLSX only' },

  { id: 'pooler_register', label: 'Pooler Register', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('pooler_register') },

  { id: 'price_list', label: 'Price List', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('price_list') },

  { id: 'lot_payment', label: 'Lot Payment', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('lot_payment') },

  { id: 'lot_slip_after', label: 'Lot Slip (After)', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('lot_slip_after') },

  { id: 'sales_taxes', label: 'Sales Taxes', group: 'reports', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('sales_taxes') },

  { id: 'dealer_list_party_wise', label: 'Dealer List (Party-wise)', group: 'reports',
    family: 'exports', kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'],
    minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('dealer_list_party_wise') },

  { id: 'pooler_list_consolidated', label: 'Pooler List consolidated (Party-wise)',
    group: 'reports', family: 'exports', kind: 'export', scope: 'trade',
    formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('pooler_list_consolidated') },

  { id: 'tally_purchase', label: 'Tally Purchase (spreadsheet)', group: 'reports',
    family: 'exports', kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'],
    minStage: 4, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('tally_purchase'),
    note: 'Spreadsheet form — the XML import lives under Accounting — Tally' },

  // ══ Statutory & Spices Board ═════════════════════════════
  { id: 'form_c', label: 'FORM-C (Auction Report)', group: 'statutory', family: 'spiceboard',
    kind: 'export', scope: 'trade', formats: ['pdf', 'xlsx'], minStage: 3, perm: 'export',
    filters: ['branch', 'sellerId', 'buyerCode'],
    route: '/api/spice-board-reports/:type/export', href: hrefSpiceBoard('form_c') },

  { id: 'form_d', label: 'FORM-D (Advance Auction Report)', group: 'statutory',
    family: 'spiceboard', kind: 'export', scope: 'trade', formats: ['pdf', 'xlsx'],
    minStage: 3, perm: 'export', filters: ['branch', 'sellerId', 'buyerCode'],
    route: '/api/spice-board-reports/:type/export', href: hrefSpiceBoard('form_d'),
    note: 'With flag_proforma_invoice ON this reads proforma rows only — never mixed with originals' },

  { id: 'buyers_statement', label: 'Buyers Statement', group: 'statutory', family: 'spiceboard',
    kind: 'export', scope: 'trade', formats: ['pdf', 'xlsx'], minStage: 4, perm: 'export',
    filters: ['branch', 'buyerCode'],
    route: '/api/spice-board-reports/:type/export', href: hrefSpiceBoard('buyers_statement') },

  { id: 'litre_weight', label: 'Litre Weight', group: 'statutory', family: 'spiceboard',
    kind: 'export', scope: 'trade', formats: ['pdf', 'xlsx'], minStage: 2, perm: 'export',
    filters: ['branch', 'sellerId'],
    route: '/api/spice-board-reports/:type/export', href: hrefSpiceBoard('litre_weight') },

  // Date-range scoped, not trade scoped — the tile asks for from/to.
  { id: 'tds_return', label: 'TDS Return', group: 'statutory', family: 'exports',
    kind: 'export', scope: 'dateRange', formats: ['xlsx', 'pdf'], minStage: 4, perm: 'export',
    route: '/api/exports/tds-return',
    href: (ctx, format) => `/api/exports/tds-return${q({ format, from: ctx.from, to: ctx.to })}` },

  // ══ Banking & Payments ═══════════════════════════════════
  // XLSX only — exports-pdf.js carries no COLS entry for this type, so
  // ?format=pdf 500s. The sibling bank_payment does have one.
  { id: 'bank_payment_before', label: 'Bank Payment (Before)', group: 'banking',
    family: 'exports', kind: 'export', scope: 'trade', formats: ['xlsx'],
    minStage: 2, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('bank_payment_before') },

  { id: 'bank_payment', label: 'Bank Payment (RTGS/NEFT)', group: 'banking', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('bank_payment') },

  { id: 'payment', label: 'Payment Summary', group: 'banking', family: 'exports',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('payment') },

  { id: 'payment_party_wise', label: 'Payment Summary — Party-wise', group: 'banking',
    family: 'exports', kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'],
    minStage: 3, perm: 'export',
    route: '/api/exports/:type/:auctionId', href: hrefExport('payment_party_wise') },

  // ══ Logistics ════════════════════════════════════════════
  { id: 'lot_slip_code', label: 'Lot Slip (Code)', group: 'logistics', family: 'lorry',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 4, perm: 'export',
    route: '/api/lorry-reports/:type/:auctionId', href: hrefLorry('lot_slip_code') },

  { id: 'truck_list', label: 'Truck List', group: 'logistics', family: 'lorry',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 4, perm: 'export',
    route: '/api/lorry-reports/:type/:auctionId', href: hrefLorry('truck_list') },

  { id: 'buyer_lot_lorry', label: 'Buyer Lot Lorry', group: 'logistics', family: 'lorry',
    kind: 'export', scope: 'trade', formats: ['xlsx', 'pdf'], minStage: 4, perm: 'export',
    route: '/api/lorry-reports/:type/:auctionId', href: hrefLorry('buyer_lot_lorry') },

  // ══ Accounting — Tally XML ═══════════════════════════════
  // Labels copied verbatim from TALLY_EXPORTS (server.js:14845).
  { id: 'tally_ledger_sales', label: 'Sales Party Ledgers', group: 'tally', family: 'tally',
    kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4, perm: 'export',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('ledger_sales') },

  { id: 'tally_ledger_rd_purchase', label: 'RD Purchase Party Ledgers', group: 'tally',
    family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4, perm: 'export',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('ledger_rd_purchase') },

  { id: 'tally_ledger_urd_purchase', label: 'URD Purchase Party Ledgers (Agriculturist)',
    group: 'tally', family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'],
    minStage: 4, perm: 'export',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('ledger_urd_purchase') },

  { id: 'tally_ledger', label: 'All Ledger Masters (parties + tax + sales + purchase)',
    group: 'tally', family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'],
    minStage: 4, perm: 'export',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('ledger') },

  { id: 'tally_sales_isp', label: 'Sales Vouchers — ISP', group: 'tally', family: 'tally',
    kind: 'export', scope: 'trade', formats: ['xml', 'json', 'irp'], minStage: 4, perm: 'export',
    filters: ['sale'],
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('sales_isp'),
    note: 'Filter by sale type (Local / Inter-state / Export) to import one batch at a time' },

  // ── Dual-company leftovers, hidden on purpose ──────────────
  // sales_asp and isp_purchase belong to the old ASP→ISP sister-concern
  // flow. This is a single-company build now: the Tally screen's own
  // TALLY_LABELS (index.html:31992) lists neither, applyTallyCompanyVisibility
  // calls the ISP/ASP split "vestigial", and flag_sister was intentionally
  // removed from the settings schema (company-config.js:227). They stay
  // callable over the API for anyone still running that flow, but the hub
  // must not advertise exports the app itself no longer offers.
  { id: 'tally_sales_asp', label: 'Sales Vouchers — ASP', group: 'tally', family: 'tally',
    kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4, perm: 'export',
    filters: ['sale'], hidden: true,
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('sales_asp') },

  // Legacy alias for sales_isp. Kept callable so old bookmarks and API
  // callers keep working; never rendered as a tile.
  { id: 'tally_sales', label: 'Sales Vouchers (legacy alias for ISP)', group: 'tally',
    family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4,
    perm: 'export', hidden: true,
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('sales') },

  { id: 'tally_isp_purchase', label: 'ISP Purchase Vouchers (mirror of ASP→ISP)', group: 'tally',
    family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4,
    perm: 'export', hidden: true,
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('isp_purchase') },

  { id: 'tally_rd_purchase', label: 'RD Purchase Vouchers', group: 'tally', family: 'tally',
    kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4, perm: 'export',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('rd_purchase') },

  { id: 'tally_urd_purchase', label: 'URD Purchase Vouchers (Agriculturist)', group: 'tally',
    family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4, perm: 'export',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('urd_purchase') },

  { id: 'tally_debit_note', label: 'Debit Notes (Discount)', group: 'tally', family: 'tally',
    kind: 'export', scope: 'trade', formats: ['xml', 'json', 'irp'], minStage: 4, perm: 'export',
    flag: 'flag_debit_note',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('debit_note') },

  { id: 'tally_debit_note_planter', label: 'Debit Notes — Planter (Discount)', group: 'tally',
    family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4, perm: 'export',
    flag: 'flag_debit_note_planter',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('debit_note_planter') },

  { id: 'tally_merchants', label: 'Merchants (Consolidated Journal)', group: 'tally',
    family: 'tally', kind: 'export', scope: 'trade', formats: ['xml', 'json'], minStage: 4,
    perm: 'export', flag: 'flag_merchants',
    route: '/api/tally/export/:type/:auctionId', href: hrefTally('merchants'),
    note: 'Includes pending proformas — stays consistent with Collection and the Buyers Statement' },

  // ══ Accounting — DBF ═════════════════════════════════════
  // HIDDEN as a group — removed from the hub on request. The entries stay
  // in the manifest rather than being deleted: they keep DBF_EXPORTS
  // reachable for the coverage test (which would otherwise report five
  // orphaned exports), and the DBF section on the Exports tab still
  // serves anyone who needs them. Drop `hidden` from all five to bring
  // the group back.
  // Transactional modules only; the two master modules (NAM/SBL) live in
  // the Masters group, reached through /api/master-exports so one tile
  // covers both the DBF and the XLSX form.
  { id: 'dbf_lots', label: 'Lots (CPA1.DBF)', group: 'dbf', family: 'dbf',
    kind: 'export', scope: 'trade', formats: ['dbf', 'xlsx'], minStage: 4, perm: 'export', hidden: true,
    filters: ['dateRange'],
    route: '/api/dbf-exports/:type', href: hrefDbf('lots') },

  { id: 'dbf_invoices', label: 'Sales Invoices (INV.DBF)', group: 'dbf', family: 'dbf',
    kind: 'export', scope: 'trade', formats: ['dbf', 'xlsx'], minStage: 4, perm: 'export', hidden: true,
    filters: ['dateRange'],
    route: '/api/dbf-exports/:type', href: hrefDbf('invoices') },

  { id: 'dbf_purchases', label: 'Purchases (PURCHASE.DBF)', group: 'dbf', family: 'dbf',
    kind: 'export', scope: 'trade', formats: ['dbf', 'xlsx'], minStage: 4, perm: 'export', hidden: true,
    filters: ['dateRange'],
    route: '/api/dbf-exports/:type', href: hrefDbf('purchases') },

  { id: 'dbf_bills', label: 'Bills of Supply (BILL.DBF)', group: 'dbf', family: 'dbf',
    kind: 'export', scope: 'trade', formats: ['dbf', 'xlsx'], minStage: 4, perm: 'export', hidden: true,
    filters: ['dateRange'],
    route: '/api/dbf-exports/:type', href: hrefDbf('bills') },

  { id: 'dbf_debit_notes', label: 'Debit Notes (DEBIT.DBF)', group: 'dbf', family: 'dbf',
    kind: 'export', scope: 'trade', formats: ['dbf', 'xlsx'], minStage: 4, perm: 'export', hidden: true,
    flag: 'flag_debit_note', filters: ['dateRange'],
    route: '/api/dbf-exports/:type', href: hrefDbf('debit_notes') },

  // ══ Journals & Registers ═════════════════════════════════
  { id: 'sales_journal', label: 'Sales Journal', group: 'books', family: 'journals',
    kind: 'export', scope: 'trade', formats: ['xlsx'], minStage: 4, perm: 'export',
    filters: ['saleType'],
    route: '/api/exports/sales-journal',
    href: (ctx) => `/api/exports/sales-journal${q({ auctionId: ctx.auctionId, saleType: ctx.saleType })}` },

  { id: 'purchase_journal_dealer', label: 'Purchase Journal (Dealer)', group: 'books',
    family: 'journals', kind: 'export', scope: 'trade', formats: ['xlsx'],
    minStage: 4, perm: 'export',
    route: '/api/exports/purchase-journal',
    href: (ctx) => `/api/exports/purchase-journal${q({ auctionId: ctx.auctionId, type: 'dealer' })}` },

  { id: 'purchase_journal_agri', label: 'Agri Bill Journal (Agriculturist)', group: 'books',
    family: 'journals', kind: 'export', scope: 'trade', formats: ['xlsx'],
    minStage: 4, perm: 'export',
    route: '/api/exports/purchase-journal',
    href: (ctx) => `/api/exports/purchase-journal${q({ auctionId: ctx.auctionId, type: 'agri' })}` },

  { id: 'purchase_register', label: 'Purchase Register', group: 'books', family: 'registers',
    kind: 'export', scope: 'dateRange', formats: ['xlsx', 'pdf'], minStage: 4, perm: 'export',
    route: '/api/exports/purchase-register',
    href: (ctx, format) => `/api/exports/purchase-register${q({
      format, auctionId: ctx.auctionId, from: ctx.from, to: ctx.to })}` },

  { id: 'sales_register', label: 'Sales Register', group: 'books', family: 'registers',
    kind: 'export', scope: 'dateRange', formats: ['xlsx', 'pdf'], minStage: 4, perm: 'export',
    filters: ['saleType'],
    route: '/api/exports/sales-register',
    href: (ctx, format) => `/api/exports/sales-register${q({
      format, auctionId: ctx.auctionId, from: ctx.from, to: ctx.to, saleType: ctx.saleType })}` },

  { id: 'register_pooler', label: 'Pooler Register (individual)', group: 'books',
    family: 'registers', kind: 'export', scope: 'dateRange', formats: ['xlsx', 'pdf'],
    minStage: 4, perm: 'export', filters: ['party'],
    route: '/api/exports/individual-register',
    href: (ctx, format) => `/api/exports/individual-register${q({
      kind: 'pooler', format, from: ctx.from, to: ctx.to, party: ctx.party })}` },

  { id: 'register_seller', label: 'Seller Register (individual)', group: 'books',
    family: 'registers', kind: 'export', scope: 'dateRange', formats: ['xlsx', 'pdf'],
    minStage: 4, perm: 'export', filters: ['party'],
    route: '/api/exports/individual-register',
    href: (ctx, format) => `/api/exports/individual-register${q({
      kind: 'seller', format, from: ctx.from, to: ctx.to, party: ctx.party })}` },

  { id: 'register_merchant', label: 'Merchant Register (individual)', group: 'books',
    family: 'registers', kind: 'export', scope: 'dateRange', formats: ['xlsx', 'pdf'],
    minStage: 4, perm: 'export', filters: ['party'],
    route: '/api/exports/individual-register',
    href: (ctx, format) => `/api/exports/individual-register${q({
      kind: 'merchant', format, from: ctx.from, to: ctx.to, party: ctx.party })}` },

  { id: 'pooler_certificate', label: 'Pooler Certificate', group: 'books', family: 'registers',
    kind: 'export', scope: 'dateRange', formats: ['pdf'], minStage: 4, perm: 'export',
    filters: ['party', 'traderId'],
    route: '/api/exports/pooler-certificate',
    href: (ctx) => `/api/exports/pooler-certificate${q({
      from: ctx.from, to: ctx.to, party: ctx.party, traderId: ctx.traderId })}`,
    note: 'Names repeat — pick the pooler by id so a namesake\'s lots are never certified' },

  // ══ Masters ══════════════════════════════════════════════
  // scope:'master' — no trade, no date range. One tile each covers both
  // the XLSX and the DBF (NAM/SBL) form via /api/master-exports.
  // `alsoCovers` records a registry key this tile serves through a DIFFERENT
  // route. /api/master-exports/sellers delegates to DBF_EXPORTS.traders for
  // the .dbf form, so one tile offers both formats — but without this
  // declaration the catalog test would correctly report DBF_EXPORTS.traders
  // as an orphaned export nobody can reach.
  // XLSX only. These tiles used to offer the .dbf form too, but with the
  // DBF group removed from the hub that lone format rebuilt a whole "DBF"
  // section in the file-type view. `alsoCovers` still keeps the two DBF
  // master modules accounted for, so the coverage test stays honest —
  // they remain reachable from the Exports tab.
  { id: 'master_sellers', label: 'Sellers', group: 'masters', family: 'masters',
    kind: 'export', scope: 'master', formats: ['xlsx'], perm: 'export',
    route: '/api/master-exports/:type', href: hrefMaster('sellers'),
    alsoCovers: ['/api/dbf-exports/traders'] },

  { id: 'master_buyers', label: 'Buyers', group: 'masters', family: 'masters',
    kind: 'export', scope: 'master', formats: ['xlsx'], perm: 'export',
    route: '/api/master-exports/:type', href: hrefMaster('buyers'),
    alsoCovers: ['/api/dbf-exports/buyers'] },
];

// ── Lookup helpers ───────────────────────────────────────────
const _byId = new Map(DOCUMENTS.map(d => [d.id, d]));
const byId = (id) => _byId.get(id) || null;

// Every group that actually has at least one entry, in declared order.
const groupsInOrder = () => GROUPS.filter(g => DOCUMENTS.some(d => d.group === g.id));

// Entries in a group, declared order preserved. `includeHidden` is for the
// catalog test — the UI never wants hidden entries.
const inGroup = (groupId, includeHidden) =>
  DOCUMENTS.filter(d => d.group === groupId && (includeHidden || !d.hidden));

module.exports = { DOCUMENTS, GROUPS, byId, groupsInOrder, inGroup };
