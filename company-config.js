/**
 * company-config.js — Replaces TOOL.DBF + DEPOTS.PRG + COMPANY.PRG
 * All company configuration stored as key-value pairs in SQLite.
 *
 * This build:
 *   - e-Auction only (business_mode locked).
 *   - Business state is a dropdown: TAMIL NADU or KERALA.
 *   - Every default value is BLANK; the user fills them in fresh.
 *     Numbers default to '0', strings to ''. No legacy seeded values.
 *   - Removed entirely: deduction1/deduction2/refund (Sample Refund Kgs),
 *     flag_disc_gst, tally_optional, tally_dispatch_from, tally_eway_enabled,
 *     tally_ship_to, tally_amazing_mode, tally_state_code_amazing,
 *     tally_ainv_prefix, tally_inv_prefix_sister, dispatched_through_asp,
 *     inv_prefix_sister, flag_sister.
 */

// Setting keys that must NEVER surface in the Settings UI, even if rows
// for them exist in the company_settings table (e.g. carried in via a
// settings import from another build). This app doesn't support the
// Grade-1 discount-into-P_Rate workflow or the legacy "Set Buyer bulk
// action" toggle, so the corresponding flags + the discount-inclusive
// pooler deduction rate are hidden from getAllSettings(). Filtering here
// (rather than deleting rows) is durable — re-importing those settings
// won't bring the controls back.
const HIDDEN_SETTING_KEYS = new Set([
  'flag_lot_set_buyer',      // Flags: "Lots → Set Buyer bulk action"
  'flag_discount_in_prate',  // Flags: "Roll Discount into P_Rate (Grade 1 only)"
  'deduction1_inclusive',    // Rates: "Deduction (Pooler) — discount-inclusive (Grade 1 only)"
  'default_auction_id',      // Internal: the admin-chosen default trade (set via the Auctions tab ⭐, not a typed setting)
]);

const DEFAULTS = [
  // ── COMPANY (Primary - ISP) ────────────────────────────────
  { key: 'logo',             value: '', category: 'company',     label: 'Logo Code',                type: 'text' },
  { key: 'trade_name',       value: '', category: 'company',     label: 'Trade Name',               type: 'text' },
  { key: 'legal_name',       value: '', category: 'company',     label: 'Legal Name Suffix',        type: 'text' },
  { key: 'short_name',       value: '', category: 'company',     label: 'Short Name',               type: 'text' },
  { key: 'pan',              value: '', category: 'company',     label: 'PAN',                      type: 'text' },
  { key: 'is_partnership',   value: 'false', category: 'company', label: 'Partnership Firm',        type: 'boolean' },
  { key: 'partnership_name', value: '', category: 'company',     label: 'Partnership Name / No.',   type: 'text' },
  { key: 'cin',              value: '', category: 'company',     label: 'CIN',                      type: 'text' },
  { key: 'fssai',            value: '', category: 'company',     label: 'FSSAI No.',                type: 'text' },
  { key: 'sbl',              value: '', category: 'company',     label: 'SBL No.',                  type: 'text' },
  { key: 'msme',             value: '', category: 'company',     label: 'MSME / Udyam No.',         type: 'text' },

  // ── ADDRESS (Kerala) ───────────────────────────────────────
  { key: 'kl_address1', value: '', category: 'address_kl', label: 'Address Line 1',  type: 'text' },
  { key: 'kl_address2', value: '', category: 'address_kl', label: 'Address Line 2',  type: 'text' },
  { key: 'kl_dispatch', value: '', category: 'address_kl', label: 'Dispatch Address', type: 'text' },
  // Dedicated dispatch-from PLACE / PIN / STATE for the Tally Sales-invoice
  // DISPATCHFROM* tags (e-invoice / e-way bill consignor). Kept separate from
  // the company's own Place / PIN / State below so the dispatch origin can
  // differ from the registered address.
  { key: 'kl_dispatch_place', value: '',       category: 'address_kl', label: 'Dispatch Place',  type: 'text' },
  { key: 'kl_dispatch_pin',   value: '',       category: 'address_kl', label: 'Dispatch PIN',    type: 'text' },
  { key: 'kl_dispatch_state', value: 'Kerala', category: 'address_kl', label: 'Dispatch State',  type: 'text' },
  { key: 'kl_place',    value: '', category: 'address_kl', label: 'Place / City',    type: 'text' },
  { key: 'kl_pin',      value: '', category: 'address_kl', label: 'PIN Code',        type: 'text' },
  { key: 'kl_state',    value: 'Kerala', category: 'address_kl', label: 'State',     type: 'text' },
  { key: 'kl_phone',    value: '', category: 'address_kl', label: 'Phone',           type: 'text' },
  { key: 'kl_email',    value: '', category: 'address_kl', label: 'Email',           type: 'text' },
  { key: 'kl_gstin',    value: '', category: 'address_kl', label: 'GSTIN',           type: 'text' },
  { key: 'kl_branch',   value: '', category: 'address_kl', label: 'Office Branch',   type: 'text' },

  // ── ADDRESS (Tamil Nadu) ───────────────────────────────────
  { key: 'tn_address1', value: '', category: 'address_tn', label: 'Address Line 1',   type: 'text' },
  { key: 'tn_address2', value: '', category: 'address_tn', label: 'Address Line 2',   type: 'text' },
  { key: 'tn_dispatch', value: '', category: 'address_tn', label: 'Dispatch Address', type: 'text' },
  { key: 'tn_place',    value: '', category: 'address_tn', label: 'Place / City',     type: 'text' },
  { key: 'tn_pin',      value: '', category: 'address_tn', label: 'PIN Code',         type: 'text' },
  { key: 'tn_state',    value: 'Tamil Nadu', category: 'address_tn', label: 'State',  type: 'text' },
  { key: 'tn_phone',    value: '', category: 'address_tn', label: 'Phone',            type: 'text' },
  { key: 'tn_email',    value: '', category: 'address_tn', label: 'Email',            type: 'text' },
  { key: 'tn_gstin',    value: '', category: 'address_tn', label: 'GSTIN',            type: 'text' },
  { key: 'tn_branch',   value: '', category: 'address_tn', label: 'Office Branch',    type: 'text' },

  // ── BRANCHES ───────────────────────────────────────────────
  { key: 'br1',      value: '', category: 'branches', label: 'Branch 1',        type: 'text' },
  { key: 'br2',      value: '', category: 'branches', label: 'Branch 2',        type: 'text' },
  { key: 'br3',      value: '', category: 'branches', label: 'Branch 3',        type: 'text' },
  { key: 'br4',      value: '', category: 'branches', label: 'Branch 4',        type: 'text' },
  { key: 'br5',      value: '', category: 'branches', label: 'Branch 5',        type: 'text' },
  { key: 'br6',      value: '', category: 'branches', label: 'Branch 6',        type: 'text' },
  { key: 'br7',      value: '', category: 'branches', label: 'Branch 7',        type: 'text' },
  { key: 'br8',      value: '', category: 'branches', label: 'Branch 8',        type: 'text' },
  { key: 'br9',      value: '', category: 'branches', label: 'Branch 9',        type: 'text' },
  { key: 'br1_tel',  value: '', category: 'branches', label: 'Branch 1 Mobile', type: 'text' },
  { key: 'br2_tel',  value: '', category: 'branches', label: 'Branch 2 Mobile', type: 'text' },
  { key: 'br3_tel',  value: '', category: 'branches', label: 'Branch 3 Mobile', type: 'text' },
  { key: 'br4_tel',  value: '', category: 'branches', label: 'Branch 4 Mobile', type: 'text' },
  { key: 'br5_tel',  value: '', category: 'branches', label: 'Branch 5 Mobile', type: 'text' },
  { key: 'br6_tel',  value: '', category: 'branches', label: 'Branch 6 Mobile', type: 'text' },
  { key: 'br7_tel',  value: '', category: 'branches', label: 'Branch 7 Mobile', type: 'text' },
  { key: 'br8_tel',  value: '', category: 'branches', label: 'Branch 8 Mobile', type: 'text' },

  // ── RATES ──────────────────────────────────────────────────
  // deduction1 / deduction2 / refund (Sample Refund Kgs) intentionally REMOVED.
  // sb_refund retained — distinct from removed `refund` field.
  { key: 'commission',          value: '0', category: 'rates', label: 'Commission %',                                 type: 'number' },
  { key: 'hpc',                 value: '0', category: 'rates', label: 'Handling %',                                   type: 'number' },
  { key: 'sb_refund',           value: '0', category: 'rates', label: 'SB Sample Refund (Kgs)',                       type: 'number' },
  // Trader-sample deduction (Kgs) shown on the Commission Bill and subtracted
  // from the seller's NETT. 0 = feature off (no row, no effect).
  { key: 'sb_trader_sample',    value: '0', category: 'rates', label: 'Trader Sample (Kgs)',                          type: 'number' },
  // Extra grams added PER LOT to the Sample Refund stock line's ACTUALQTY (not
  // BILLEDQTY) in the RD purchase ("Sample Refund to Dealer") and URD purchase
  // ("Sample Refund to Planter") Tally vouchers. Lets the physically-received
  // quantity carry a small per-lot sample allowance over the billed quantity.
  // Entered in grams; converted to Kgs internally. Blank/0 = no adjustment.
  { key: 'sb_refund_actual_extra_g', value: '50', category: 'rates', label: 'Sample Refund ACTUALQTY Extra (grams per lot — RD/URD purchase XML)', type: 'number' },
  { key: 'gst_goods',           value: '0', category: 'rates', label: 'GST Goods Rate %',                             type: 'number' },
  { key: 'gst_service',         value: '0', category: 'rates', label: 'GST Service Rate %',                           type: 'number' },
  { key: 'discount_gst',        value: '0', category: 'rates', label: 'Discount GST %',                               type: 'number' },
  { key: 'tcs_tds',             value: '0', category: 'rates', label: 'TCS / TDS Rate %',                             type: 'number' },
  { key: 'tds_purchase_rate',   value: '0', category: 'rates', label: 'TDS on Purchase Rate % (Section 194Q)',        type: 'number' },
  { key: 'tds_threshold',       value: '0', category: 'rates', label: 'TDS / TCS Annual Threshold (₹)',               type: 'number' },
  { key: 'gunny_rate',          value: '0', category: 'rates', label: 'Gunny Rate (₹)',                               type: 'number' },
  { key: 'transport',           value: '0', category: 'rates', label: 'Transport (₹/kg)',                             type: 'number' },
  { key: 'insurance',           value: '0', category: 'rates', label: 'Insurance Rate (₹/₹1000)',                     type: 'number' },
  { key: 'local_transport',     value: '0', category: 'rates', label: 'Local Transport (₹/kg)',                       type: 'number' },
  { key: 'local_insurance',     value: '0', category: 'rates', label: 'Local Insurance (₹/kg)',                       type: 'number' },
  { key: 'discount_pct',        value: '0', category: 'rates', label: 'Discount %',                                   type: 'number' },
  { key: 'discount_days',       value: '0', category: 'rates', label: 'No. of Days for Discount',                     type: 'number' },
  { key: 'dealer_days',         value: '0', category: 'rates', label: 'No. of Days for Dealer',                       type: 'number' },
  { key: 'addl_charge_name',    value: '',  category: 'rates', label: 'Additional Charge — Name',                     type: 'text'   },
  { key: 'addl_charge_value',   value: '0', category: 'rates', label: 'Additional Charge — % of cardamom amount',     type: 'number' },

  // ── HSN / SAC CODES ────────────────────────────────────────
  { key: 'hsn_cardamom',  value: '', category: 'hsn', label: 'Cardamom HSN', type: 'text' },
  { key: 'hsn_gunny',     value: '', category: 'hsn', label: 'Gunny HSN',    type: 'text' },
  { key: 'sac_transport', value: '', category: 'hsn', label: 'Transport SAC', type: 'text' },
  { key: 'sac_insurance', value: '', category: 'hsn', label: 'Insurance SAC', type: 'text' },
  { key: 'sac_service',   value: '', category: 'hsn', label: 'Service SAC',   type: 'text' },

  // ── BANK DETAILS ───────────────────────────────────────────
  { key: 'bank_kl_name', value: '', category: 'bank', label: 'Kerala Bank Name',  type: 'text' },
  { key: 'bank_kl_acct', value: '', category: 'bank', label: 'Kerala Account No.', type: 'text' },
  { key: 'bank_kl_ifsc', value: '', category: 'bank', label: 'Kerala IFSC Code',   type: 'text' },
  { key: 'bank_tn_name', value: '', category: 'bank', label: 'TN Bank Name',       type: 'text' },
  { key: 'bank_tn_acct', value: '', category: 'bank', label: 'TN Account No.',     type: 'text' },
  { key: 'bank_tn_ifsc', value: '', category: 'bank', label: 'TN IFSC Code',       type: 'text' },
  // Bank Payment upload layout for THIS install's bank. Options map to the
  // profile keys in bank-formats.js; rendered as a dropdown (see the
  // bank_format special-case in public/index.html renderSettingsPanel).
  // Default 'rtgs_neft' reproduces the original hard-coded layout, so existing
  // installs are unaffected.
  { key: 'bank_format', value: 'rtgs_neft', category: 'bank', label: 'Bank Payment File Format', type: 'select' },

  // ── INVOICE PDF TEMPLATES (per-customer layout) ────────────
  // Each picks an HTML template under templates/<docType>/<key>.hbs, resolved
  // by pdf/invoice-templates.js. Default 'classic' reproduces the current
  // PDFKit layout, so installs that never change these are unaffected.
  // Engine: 'pdfkit' = existing hard-coded layout (default, unchanged for all
  // installs); 'html' = render via the HTML template selected below. Flip to
  // 'html' to serve the template-based PDF from the download button; revert
  // instantly by setting it back to 'pdfkit'.
  // Proforma-invoice series prefix, shown ONLY in the Collection report, the
  // Spices Board Buyer Statement and the Merchant (Tally) XML — never on the
  // actual invoice. Leads the whole token, ahead of the sale type, so "PI"
  // renders invoice 2009 as "PI/I-2009" (local: "PI/L-2009"). Applies to
  // every sale type. Blank = no prefix, reports read as before ("I 2009").
  // Renamed from `interstate_invoice_prefix` (was inter-state only) — see the
  // migration in ensureSettings() which carries the old value across.
  { key: 'proforma_invoice_prefix', value: '',          category: 'invoice', label: 'Proforma Invoice No Prefix (Collection / Buyer Stmt / Merchant XML)', type: 'text' },
  // Debit-note numbering — what prints on the DN PDF and goes out in the Tally
  // XML / e-invoice JSON, wrapped around the stored note number:
  //     <prefix><note_no><suffix>
  // Dealer and planter notes are configured separately since they're distinct
  // series. Leave BOTH blank (default) to keep the historical formats:
  // "111/26-27" on the PDF, "111/26-27/SE" (dealer) or "111/26-27/URD"
  // (planter) in Tally. Setting either field replaces that automatic tail
  // entirely, so the operator's format is what appears — {season} and {ano}
  // expand to the short season and the auction no, e.g. a suffix of
  // "/{season}/SE" reproduces the old Tally shape without retyping it yearly.
  { key: 'debit_note_prefix',          value: '', category: 'invoice', label: 'Debit Note No Prefix — Dealer (PDF / Tally XML)',  type: 'text' },
  { key: 'debit_note_suffix',          value: '', category: 'invoice', label: 'Debit Note No Suffix — Dealer (PDF / Tally XML)',  type: 'text' },
  { key: 'debit_note_planter_prefix',  value: '', category: 'invoice', label: 'Debit Note No Prefix — Planter (PDF / Tally XML)', type: 'text' },
  { key: 'debit_note_planter_suffix',  value: '', category: 'invoice', label: 'Debit Note No Suffix — Planter (PDF / Tally XML)', type: 'text' },
  // Bill-of-supply numbering — wraps the stored bill number (bills.bil) on the
  // three surfaces that quote it: the Bill of Supply PDF, the Commission Bill
  // PDF, and the URD (agriculturist) purchase voucher in the Tally XML:
  //     <prefix><bills.bil><suffix>
  // Both blank (the default) prints the bare number exactly as today. {season}
  // and {ano} expand the same way they do in the debit-note affixes, so a
  // prefix of "BOS/{season}/" renders bill 1748 as "BOS/26-27/1748".
  //
  // Unlike the debit-note affixes these ONLY wrap — each surface keeps the tail
  // it already builds. In particular the URD voucher still appends the season
  // AFTER the suffix ("1748/26-27" → "BOS-1748-A/26-27"), so putting {season}
  // in either affix makes the Tally number carry it twice. Multi-lot commission
  // bills likewise keep their per-page /1, /2 tail after the suffix.
  { key: 'bill_of_supply_prefix',      value: '', category: 'invoice', label: 'Bill of Supply No Prefix (BoS PDF / Commission Bill / URD Tally XML)', type: 'text' },
  { key: 'bill_of_supply_suffix',      value: '', category: 'invoice', label: 'Bill of Supply No Suffix (BoS PDF / Commission Bill / URD Tally XML)', type: 'text' },
  { key: 'sales_invoice_engine',      value: 'pdfkit',  category: 'invoice', label: 'Sales Invoice Engine (pdfkit/html)',    type: 'select' },
  { key: 'purchase_invoice_engine',   value: 'pdfkit',  category: 'invoice', label: 'Purchase Invoice Engine (pdfkit/html)', type: 'select' },
  { key: 'agri_bill_engine',          value: 'pdfkit',  category: 'invoice', label: 'Bill of Supply Engine (pdfkit/html)',   type: 'select' },
  { key: 'commission_bill_engine',    value: 'pdfkit',  category: 'invoice', label: 'Commission Bill Engine (pdfkit/html)',  type: 'select' },
  { key: 'debit_note_engine',         value: 'pdfkit',  category: 'invoice', label: 'Debit Note Engine (pdfkit/html)',       type: 'select' },
  { key: 'sales_invoice_template',    value: 'classic', category: 'invoice', label: 'Sales Invoice Layout',    type: 'select' },
  { key: 'purchase_invoice_template', value: 'classic', category: 'invoice', label: 'Purchase Invoice Layout', type: 'select' },
  { key: 'agri_bill_template',        value: 'classic', category: 'invoice', label: 'Bill of Supply Layout',   type: 'select' },
  { key: 'commission_bill_template',  value: 'classic', category: 'invoice', label: 'Commission Bill Layout',  type: 'select' },
  { key: 'debit_note_template',       value: 'letterhead', category: 'invoice', label: 'Debit Note Layout',    type: 'select' },

  // ── SEASON ─────────────────────────────────────────────────
  { key: 'season',            value: '', category: 'season', label: 'Season Name',           type: 'text' },
  { key: 'season_short',      value: '', category: 'season', label: 'Season Short',          type: 'text' },
  { key: 'season_start',      value: '', category: 'season', label: 'FY Start Date',         type: 'date' },
  { key: 'season_end',        value: '', category: 'season', label: 'FY End Date',           type: 'date' },

  // ── INVOICE SETTINGS ───────────────────────────────────────
  // Sister Invoice Prefix (Other Ref.) and Dispatched Through (ASP) intentionally REMOVED.
  { key: 'inv_prefix',             value: '', category: 'invoice', label: 'Invoice Prefix',         type: 'text' },
  { key: 'separator',              value: '', category: 'invoice', label: 'Separator Symbol',       type: 'text' },
  { key: 'dispatched_through_isp', value: '', category: 'invoice', label: 'Dispatched Through',     type: 'text' },
  { key: 'dispatch_destination',   value: '', category: 'invoice', label: 'Dispatch Destination',   type: 'text' },
  // Dispatch From — the warehouse / godown address printed in the
  // "Dispatch From" cell on Sales Invoice PDFs and the Tally
  // DISPATCHFROMADDRESS block. Blank → invoice falls back to the
  // company's primary address (kl_address1 / tn_address1).
  { key: 'dispatch_from',          value: '', category: 'invoice', label: 'Dispatch From (Address)', type: 'text' },
  { key: 'duplicate_text',         value: '', category: 'invoice', label: 'Dummy Invoice Text',     type: 'text' },
  { key: 'signature_text',         value: '', category: 'invoice', label: 'Signature Label',        type: 'text' },

  // ── FEATURE FLAGS ──────────────────────────────────────────
  // Discount includes GST (flag_disc_gst) intentionally REMOVED.
  // Sister concern active (flag_sister) intentionally REMOVED.
  { key: 'flag_pooling',         value: 'false', category: 'flags', label: 'Pooling (Single State)',          type: 'boolean' },
  { key: 'flag_sample',          value: 'false', category: 'flags', label: 'Discount in Invoice',             type: 'boolean' },
  // Toggles visibility of Local Transport / Local Insurance rate fields under
  // Settings → Rates & Charges. Off = the rate fields are hidden in the UI.
  { key: 'flag_local_ti',        value: 'false', category: 'flags', label: 'Local Transport / Insurance',     type: 'boolean' },
  // Toggles visibility of Additional Charge — Name / % fields under Rates & Charges.
  { key: 'flag_addl_charges',    value: 'false', category: 'flags', label: 'Additional Charges',              type: 'boolean' },
  { key: 'flag_dispatch',        value: 'false', category: 'flags', label: 'Show Dispatch Address',           type: 'boolean' },
  { key: 'flag_ship',            value: 'false', category: 'flags', label: 'Show Ship To Address',            type: 'boolean' },
  { key: 'flag_hsn',             value: 'false', category: 'flags', label: 'Show HSN Codes',                  type: 'boolean' },
  { key: 'flag_bank',             value: 'false', category: 'flags', label: 'Bank Details in Invoice',         type: 'boolean' },
  // Show the seller's phone + bank account number on the Commission Bill
  // (Letterhead layout only). Off by default — some growers don't want their bank
  // details printed. Consumed by pdf/render-commission-html.js.
  { key: 'flag_commission_bank',  value: 'false', category: 'flags', label: 'Seller Phone & A/C on Commission Bill', type: 'boolean' },
  { key: 'flag_tds_purchase',    value: 'false', category: 'flags', label: 'TDS on Purchase Invoice',         type: 'boolean' },
  { key: 'flag_tds_sales',       value: 'false', category: 'flags', label: 'TDS on Sales Invoice',            type: 'boolean' },
  { key: 'flag_wgst',            value: 'false', category: 'flags', label: 'TDS on Full Invoice Amount',      type: 'boolean' },
  { key: 'flag_debit_note',      value: 'false', category: 'flags', label: 'Debit Note for Discount',         type: 'boolean' },
  { key: 'flag_debit_note_planter', value: 'false', category: 'flags', label: 'Debit Note for Discount — Planter', type: 'boolean' },
  // Merchants — adds a "Merchants" widget under Vouchers in the To Tally menu
  // that exports a consolidated Journal (debit each buyer, credit the
  // "Merchants" control ledger). Hidden via .feat-merchants when OFF; the
  // export endpoints also 403 while disabled.
  { key: 'flag_merchants',       value: 'false', category: 'flags', label: 'Merchants (Tally Journal)',       type: 'boolean' },
  // Lot-wise Payments screen — swaps the Payments tab from the seller-wise
  // roll-up to a lot-level worklist (search by seller / lot numbers, set the
  // bank account per lot, export the bank payment for exactly those lots).
  // OFF = the classic seller-wise screen, untouched. The two screens are
  // alternatives, not additions: the Payments sidebar entry stays a single
  // item and this flag decides which one it opens.
  { key: 'flag_lotwise_payments', value: 'false', category: 'flags', label: 'Lot-wise Payments Screen', type: 'boolean' },
  { key: 'flag_invoice_stripe',  value: 'false', category: 'flags', label: 'Alternate Row Stripe in Invoice', type: 'boolean' },
  { key: 'flag_dummy',           value: 'false', category: 'flags', label: 'Allow Dummy Invoices',            type: 'boolean' },
  { key: 'flag_round',           value: 'false', category: 'flags', label: 'Round Invoice Amounts',           type: 'boolean' },
  { key: 'flag_export',          value: 'false', category: 'flags', label: 'Export Invoices',                 type: 'boolean' },
  { key: 'flag_whatsapp',        value: 'false', category: 'flags', label: 'WhatsApp Share Buttons',          type: 'boolean' },
  // Price List Mapping — sister tool of the Lots → Price Import button.
  // When ON, a "Price List Mapping" item appears in the sidebar (under
  // Lots) and a quick-access "🗺 Price List Mapping" button shows up on
  // the Lots toolbar next to Price Import. When OFF, both surfaces are
  // hidden via the .feat-price-list-mapping CSS hide rule. Default ON
  // because most operators use the mapping flow; turning it OFF is for
  // installs that only ever generate prices from the original Praman
  // sheet without re-importing.
  { key: 'flag_price_list_mapping', value: 'true',  category: 'flags', label: 'Price List Mapping',           type: 'boolean' },
  // Print Selected Purchase — the purchase-side mirror PDF button on the
  // Sales tab toolbar. Default OFF because it only makes sense for the
  // ASP→ISP transfer flow; admins enable it explicitly when they need it.
  // The existing "ASP context" check (Kerala + e-Auction) stays as a
  // secondary gate on top of this flag.
  { key: 'flag_print_selected_purchase', value: 'false', category: 'flags', label: 'Print Selected Purchase (Sales tab)', type: 'boolean' },
  // Tally Purchase XML detail level — separate from the sales-side
  // `tally_detailed` flag so the user can toggle purchase / URD / debit
  // note vouchers independently. ON (default) emits one bill allocation
  // per lot ("ano/lotno/season") AND one inventory entry per lot. OFF
  // emits a single consolidated bill allocation ("ano/invno/season")
  // AND a single aggregate inventory entry. Same flag covers RD
  // purchase, URD purchase, and Debit Note vouchers.
  { key: 'tally_purchase_detailed', value: 'true', category: 'flags', label: 'Tally Purchase XML — Detailed (per-lot)', type: 'boolean' },
  // Purchase XML — leave <VOUCHERNUMBER> and <REFERENCE> EMPTY on the purchase
  // vouchers so the operator types them in Tally after the import. Everything
  // else about the voucher is unchanged, and the per-lot bill allocations keep
  // their own <ano>/<lot>/<season> refs. OFF (default) keeps the generated
  // numbers exactly as they are today.
  //
  // RD (registered dealer) and URD (agriculturist) are SEPARATE toggles: the
  // two vouchers post to different books and a site commonly hand-numbers one
  // series while keeping the other generated. They were a single flag until
  // this revision — see the carry-over migration in initCompanySettings().
  { key: 'tally_purchase_manual_voucherno_rd',  value: 'false', category: 'flags', label: 'Purchase XML (RD / Dealer) — Blank Voucher No / Reference (type in Tally)',      type: 'boolean' },
  { key: 'tally_purchase_manual_voucherno_urd', value: 'false', category: 'flags', label: 'Purchase XML (URD / Planter) — Blank Voucher No / Reference (type in Tally)',    type: 'boolean' },
  // Set Buyer Code bulk action on the Lots tab — when ON, a "👤 Set
  // Buyer Code" button appears next to "🗑 Delete Selected" once a
  // lot is ticked, opening a modal where the operator picks a buyer
  // code and applies it to every selected lot (with buyer / buyer1 /
  // sale auto-filled from the buyers master). Default OFF so the
  // button only appears when an admin explicitly enables it.
  { key: 'flag_bulk_set_buyer_code', value: 'false', category: 'flags', label: 'Bulk Set Buyer Code (Lots tab)', type: 'boolean' },

  // Bills of Supply — which document the tab works with: the agriculturist
  // Purchase Bill (Bill of Supply) or the Commission Bill. Picks the bulk +
  // per-row actions to match:
  //   ON  (Purchase Bill)   → toolbar shows "🖨 Print Selected"; each row's
  //                           Actions column shows the PDF (View/Print) icon
  //                           for the Bill of Supply purchase bill.
  //   OFF (Commission Bill) → toolbar shows "🧾 Commission Bill Selected";
  //                           the PDF icon is hidden and replaced by a
  //                           Commission-Bill download icon on each row.
  // Default ON so the standard Bill of Supply purchase-bill flow is the
  // out-of-the-box behaviour; admins switch to commission bills explicitly.
  { key: 'flag_bos_purchase_bill', value: 'true', category: 'flags', label: 'Bills of Supply: Purchase Bill (off = Commission Bill)', type: 'boolean' },

  // ── LOT-WISE DOCUMENT MODE ────────────────────────────────────────
  // Chooses the GRANULARITY of a generated document, per module:
  //
  //   OFF (default) — SELLER-WISE. One document per seller per trade,
  //                   carrying every one of that seller's lots as line
  //                   items. This is the historical behaviour and is what
  //                   every already-generated document is.
  //   ON            — LOT-WISE. One document per LOT, each taking its own
  //                   number from the trade's series. The Generate modal
  //                   lists lots instead of sellers.
  //
  // These are generation-time switches only: flipping one never rewrites,
  // renumbers or reinterprets an existing document. Each row records the
  // mode it was created in (a non-empty `lot_no` column), so reprints and
  // reports stay correct across a toggle in either direction — a trade
  // invoiced seller-wise last month still reprints seller-wise after the
  // flag goes on.
  //
  // Deliberately four independent flags rather than one master switch, so
  // a site can adopt lot-wise one module at a time and roll a single
  // module back without disturbing the other three.
  { key: 'flag_lotwise_purchase',   value: 'false', category: 'flags', label: 'Lot-wise Purchase Invoices (off = Seller-wise)',   type: 'boolean' },
  { key: 'flag_lotwise_bills',      value: 'false', category: 'flags', label: 'Lot-wise Bills of Supply (off = Seller-wise)',     type: 'boolean' },
  { key: 'flag_lotwise_dn_planter', value: 'false', category: 'flags', label: 'Lot-wise Debit Notes — Planter (off = Seller-wise)', type: 'boolean' },

  // Price Check tab + transaction gate. When ON the operator gets the
  // Reports → Price Check tab, the gate banner, and a hard server-side
  // block on Calculate / Invoice / Purchase / Bill / Debit-Note
  // generation until verify clears for the active auction. When OFF
  // the tab is hidden, buttons are never disabled, and the gate is a
  // no-op (writes still happen). Default OFF so existing installs are
  // unaffected on upgrade.
  { key: 'flag_price_check',     value: 'false', category: 'flags', label: 'Price Check + transaction gate',  type: 'boolean' },

  // Lot record-lock. When ON: any user with lot_write can lock ticked
  // lots (badge appears, row tints amber); admin-only unlock. Locked
  // lots reject edit/delete/calculate by non-admins and cascade-block
  // edits on dependent sales invoices / purchases / debit notes whose
  // lots are locked. When OFF: every lock UI surface disappears, the
  // lock/unlock endpoints refuse with 404, and lock state on existing
  // rows is ignored so legacy locked rows don't silently freeze.
  // Default OFF so existing installs are unaffected on upgrade.
  { key: 'flag_lot_lock',        value: 'false', category: 'flags', label: 'Lot record lock',                 type: 'boolean' },

  // Reserved price — when ON, the Reserved Price input appears in Lot
  // Entry (desktop + mobile). User types the value per-lot; no auto-
  // increment (the field flows into column L of the e-Auction Spices
  // Board CSV). When OFF the input is hidden everywhere; the database
  // column always exists so toggling on later doesn't lose data.
  { key: 'flag_reserved_price',  value: 'false', category: 'flags', label: 'Reserved Price (Lot Entry)',      type: 'boolean' },
  // Immediate Payment + Reserve this Lot — the two Lot Entry checkboxes
  // (desktop + mobile). When OFF both controls are hidden everywhere; the
  // lots.immediate_payment / lots.reserved columns always exist so toggling
  // on later doesn't lose data, and existing reserved lots still render.
  { key: 'flag_immediate_reserve', value: 'false', category: 'flags', label: 'Immediate Payment & Reserve Lot (Lot Entry)', type: 'boolean' },

  // TAN (Tax Deduction & Collection Account No) on sellers + buyers. When ON,
  // a TAN input shows in the Seller and Buyer add/edit forms and the value is
  // saved to traders.tan / buyers.tan. When OFF the input is hidden; the DB
  // column always exists so toggling on later doesn't lose data. Default OFF.
  { key: 'flag_tan',             value: 'false', category: 'flags', label: 'TAN field (Sellers + Buyers)',    type: 'boolean' },

  // Validate entered lots before price import — when ON, the "Validate
  // Lots" button shows in Lot Entry and price import is blocked until the
  // trade's entered lots are validated (no duplicate lots, every lot has a
  // seller; missing GSTIN/bank/PAN/phone are acknowledge-able warnings).
  // When OFF the button is hidden and the server-side import gate is a
  // no-op. Default OFF so existing installs are unaffected on upgrade.
  { key: 'flag_lot_validation',  value: 'false', category: 'flags', label: 'Validate lots before price import', type: 'boolean' },

  // Proforma sales invoices — the two-step "draft then raise" flow. When ON,
  // the Generate Invoice / Generate All modals grow a Document Type selector
  // (Original vs Proforma), proforma drafts get their own number series, the
  // Sales list gains an Original/Proforma/All filter plus the ⬆ Raise Original
  // action, and drafts are excluded from every statutory/analytical reader.
  // When OFF the app follows the OLD flow: every generated sales invoice is an
  // original tax invoice, no draft UI is shown anywhere, and the server refuses
  // proforma writes (403) + the raise-original endpoint (404). Existing
  // is_proforma rows stay in the DB and remain excluded from GST/Tally/reports
  // by the COALESCE(is_proforma,0)=0 filters, which are NOT flag-dependent — so
  // toggling off never leaks a draft into statutory output, and toggling back on
  // restores the drafts untouched. Default OFF so existing installs are
  // unaffected on upgrade.
  { key: 'flag_proforma_invoice', value: 'false', category: 'flags', label: 'Proforma Sales Invoice (draft → raise original)', type: 'boolean' },

  // ── BACKUPS ────────────────────────────────────────────────
  // Per-install database backup settings. The scheduler is driven by
  // backup_auto_enabled + backup_interval_hours; the keep-count caps
  // how many .db.gz snapshots are retained on disk (older are pruned).
  // Manual snapshots can always be triggered via POST /api/system/backup-now
  // regardless of these flags.
  { key: 'backup_auto_enabled',   value: 'false', category: 'backups', label: 'Auto-backup enabled',         type: 'boolean' },
  { key: 'backup_interval_hours', value: '24',    category: 'backups', label: 'Auto-backup interval (hours)', type: 'number'  },
  { key: 'backup_keep_count',     value: '14',    category: 'backups', label: 'Max snapshots to retain',     type: 'number'  },

  // ── LOT ENTRY DEFAULTS ──────────────────────────────────────
  { key: 'sample_weight',      value: '0',     category: 'lot_entry', label: 'Default Sample Weight (kg)',         type: 'number'  },
  // Per-lot sample rates behind the dashboard trade-snapshot Stock tile:
  //   Stock = (lots × Sample Collection) − (lots × Free Sample).
  { key: 'sample_collection',  value: '0',     category: 'lot_entry', label: 'Default Sample Collection (kg)',     type: 'number'  },
  { key: 'free_sample',        value: '0',     category: 'lot_entry', label: 'Default Free Sample (kg)',           type: 'number'  },
  // Per-bag empty gunny weight. When > 0, Lot Entry surfaces the
  // "Weight w/ Gunny" + "Gunny Weight" fields and derives net weight as
  // weight_with_gunny − (bags × this value). 0/blank keeps the classic
  // direct net-weight entry.
  { key: 'default_gunny_weight', value: '0',   category: 'lot_entry', label: 'Default Gunny Weight (kg)',          type: 'number'  },
  // When ON, the mobile operator picks the Gunny Wt/Bag per lot (editable,
  // carried forward to consecutive lots, and stored on the lot so editing
  // reuses the saved value). When OFF, the global Default Gunny Weight above
  // is used for every lot.
  { key: 'user_gunny_weight',  value: 'false', category: 'lot_entry', label: 'User-driven Gunny Wt/Bag (mobile)',   type: 'boolean' },
  { key: 'show_moisture',      value: 'false', category: 'lot_entry', label: 'Show Moisture Column',               type: 'boolean' },
  { key: 'default_litre',      value: '',      category: 'lot_entry', label: 'Default Litre Weight',               type: 'text'    },
  { key: 'default_crop_type',  value: '',      category: 'lot_entry', label: 'Default Crop Type',                  type: 'text'    },
  // Crop Receipt No on the mobile Lot Entry form. When ON the CROP RCPT field
  // is shown; the first lot seeds from "Starting Crop Receipt No" (or the next
  // number after the highest already recorded), and each subsequent lot
  // auto-increments (+1, preserving zero-pad width). TEXT so leading zeros
  // like "01208" survive.
  { key: 'show_crop_receipt',     value: 'false', category: 'lot_entry', label: 'Show Crop Receipt No (mobile Lot Entry)', type: 'boolean' },
  { key: 'crop_receipt_start_no', value: '',      category: 'lot_entry', label: 'Starting Crop Receipt No',               type: 'text'    },
  // Seller field placement on the Lot Entry form (mobile + desktop). OFF =
  // seller search sits at the TOP of the form (default); ON = it drops below
  // the "Reserve this lot" section.
  { key: 'lot_entry_seller_at_bottom', value: 'false', category: 'lot_entry', label: 'Seller field at bottom of Lot Entry', type: 'boolean' },
  // Per-field visibility for the auto-calculated (read-only) weight fields on
  // the mobile Lot Entry form. Both default ON.
  { key: 'mobile_show_sample_field', value: 'true', category: 'lot_entry', label: 'Mobile Lot Entry: show Sample field', type: 'boolean' },
  { key: 'mobile_show_gross_field',  value: 'true', category: 'lot_entry', label: 'Mobile Lot Entry: show Gross field',  type: 'boolean' },
  // Lot Receipt columns — the operator decides which columns print on the
  // lot receipt slip (both Full and Compact formats). Lot# always prints;
  // everything else is toggled here. Moisture is driven by "Show Moisture
  // Column" above so it isn't duplicated.
  { key: 'lot_receipt_show_grade',  value: 'false', category: 'lot_entry', label: 'Lot Receipt: Grade column',     type: 'boolean' },
  { key: 'lot_receipt_show_bags',   value: 'true',  category: 'lot_entry', label: 'Lot Receipt: Bags column',      type: 'boolean' },
  { key: 'lot_receipt_show_litre',  value: 'false', category: 'lot_entry', label: 'Lot Receipt: Litre column',     type: 'boolean' },
  { key: 'lot_receipt_show_net',    value: 'true',  category: 'lot_entry', label: 'Lot Receipt: Net Wt column',    type: 'boolean' },
  { key: 'lot_receipt_show_sample', value: 'true',  category: 'lot_entry', label: 'Lot Receipt: Sample Wt column', type: 'boolean' },
  { key: 'lot_receipt_show_gross',  value: 'true',  category: 'lot_entry', label: 'Lot Receipt: Gross Wt column',  type: 'boolean' },
  { key: 'lot_receipt_show_crpt',   value: 'false', category: 'lot_entry', label: 'Lot Receipt: Crop Receipt column', type: 'boolean' },
  // How the receipt's footer totals are laid out. Both styles carry exactly
  // the same figures — only the arrangement differs, and which one reads
  // better depends on the roll width and on the operator's eye:
  //   inline  — one wrapped line:  13 lot(s) | 66 Bag | Qty: 2930.800 kg | …
  //   stacked — label left / value right, one figure per line:
  //               24 lot(s)
  //               Total Bags            152
  //               Total Net     7004.900 kg
  // 'inline' is the default because it is what the desktop slip and the PDF
  // receipt already printed; 'stacked' is what the thermal ESC/POS path used,
  // and it is easier to read at a glance on a narrow roll.
  { key: 'lot_receipt_totals_style', value: 'inline', category: 'lot_entry', label: 'Lot Receipt: Totals layout (inline | stacked)', type: 'text' },
  // Mobile Lot Entry permissions. Both are UI gates on the operator's own
  // lots in the PWA ("My Lots"): edit shows the ✎ button, delete shows the
  // 🗑 row button AND the "Delete Selected" bulk action. They used to be one
  // switch (`edit_enabled` gated both) — split so a depot can be allowed to
  // correct a lot without being able to remove it.
  { key: 'edit_enabled',       value: 'false', category: 'lot_entry', label: 'Allow Lot Edits (non-admin)',        type: 'boolean' },
  { key: 'delete_enabled',     value: 'false', category: 'lot_entry', label: 'Allow Lot Deletes (non-admin)',      type: 'boolean' },
  { key: 'edit_timeout_sec',   value: '0',     category: 'lot_entry', label: 'Edit Timeout (sec; 0 = no limit)',    type: 'number'  },
  { key: 'lot_receipt_format', value: '',      category: 'lot_entry', label: 'Lot Receipt Format (compact|detailed)', type: 'text' },
  // Physical paper width of the lot-receipt slip, in millimetres. Thermal
  // receipt printers come in fixed roll widths (e.g. the HOP-HL58 is a 58mm
  // roll, common alternatives are 80mm and 76mm). When blank / 0 the slip
  // uses its built-in default page size (80mm for the compact slip, ~63mm
  // for the mobile thermal PDF) — which on a narrower 58mm printer overflows
  // the paper and the driver silently scales the slip onto an A4 sheet. Set
  // this to the printer's roll width (58 for the HOP-HL58) so both the
  // desktop print @page size and the mobile receipt PDF match the paper.
  // Height is always automatic — receipts grow down the continuous roll.
  { key: 'lot_receipt_width_mm', value: '',    category: 'lot_entry', label: 'Lot Receipt Paper Width (mm; blank = default. e.g. 58 for HOP-HL58 thermal)', type: 'number' },
  // The admin-designated default trade (auction id). Set via the ⭐ on the
  // Auctions tab; the mobile app pre-selects + highlights it. Hidden from
  // the Settings UI (see HIDDEN_SETTING_KEYS); blank = no default.
  { key: 'default_auction_id', value: '',      category: 'lot_entry', label: 'Default Trade (auction id)', type: 'text' },

  // ── BOOKING ALERTS (grade-2 concentration) ─────────────────
  // When grade-2 booked weight crosses `threshold_pct` of the TOTAL weight
  // booked so far in an auction, the depot manager gets a soft alert; any
  // further grade-2 booking after that escalates to the immediate superior.
  // Each level fires at most once per auction. See grade2-alerts.js for the
  // evaluation logic and POST /api/lots for the hook point.
  { key: 'grade2_alert_enabled',       value: 'false', category: 'alerts', label: 'Enable Grade-2 Booking Alerts',          type: 'boolean' },
  { key: 'grade2_alert_threshold_pct', value: '25',    category: 'alerts', label: 'Grade-2 Threshold (% of booked weight)', type: 'number'  },
  // Noise guard: don't evaluate until at least this many lots are booked, so
  // the very first grade-2 lot doesn't read as 100%. 0 = evaluate from lot 1.
  { key: 'grade2_alert_min_lots',      value: '4',     category: 'alerts', label: 'Minimum Lots Before Alerting',          type: 'number'  },
  // Depot manager — notified first (soft alert).
  { key: 'grade2_manager_name',        value: '',      category: 'alerts', label: 'Depot Manager — Name',                  type: 'text' },
  { key: 'grade2_manager_whatsapp',    value: '',      category: 'alerts', label: 'Depot Manager — WhatsApp (with country code)', type: 'text' },
  { key: 'grade2_manager_email',       value: '',      category: 'alerts', label: 'Depot Manager — Email',                 type: 'text' },
  // Immediate superior — notified on escalation.
  { key: 'grade2_superior_name',       value: '',      category: 'alerts', label: 'Immediate Superior — Name',             type: 'text' },
  { key: 'grade2_superior_whatsapp',   value: '',      category: 'alerts', label: 'Immediate Superior — WhatsApp (with country code)', type: 'text' },
  { key: 'grade2_superior_email',      value: '',      category: 'alerts', label: 'Immediate Superior — Email',            type: 'text' },

  // ── LOT-REASSIGN REQUEST ALERTS (mobile operator → admin) ──
  // When an operator requests a lot-range reassignment, a WhatsApp
  // template with Approve/Deny quick-reply buttons is sent to each
  // number below (comma-separated, with country code). Tapping a button
  // fires the Meta webhook, which approves/denies the request. Only
  // messages FROM one of these numbers are honoured.
  { key: 'reassign_alert_whatsapp',    value: '',      category: 'alerts', label: 'Reassign Requests — Admin WhatsApp number(s), comma-separated (with country code)', type: 'text' },
  { key: 'reassign_alert_tpl',         value: 'lot_reassign_approval', category: 'alerts', label: 'Reassign Requests — WhatsApp template name', type: 'text' },
  { key: 'reassign_alert_tpl_lang',    value: 'en',    category: 'alerts', label: 'Reassign Requests — WhatsApp template language code', type: 'text' },

  // ── LOGINS & SESSIONS ──────────────────────────────────────
  // `single_session` blocks a second sign-in while the same username is
  // already active anywhere (desktop or mobile). "Active" is judged by
  // `session_idle_minutes` — a session whose last request is older than
  // that no longer blocks, so a browser closed without logging out never
  // locks its own user out permanently. Admins can always clear a stuck
  // session immediately from Users → Sign out.
  { key: 'single_session',        value: 'true', category: 'security', label: 'Block a second login with the same username', type: 'boolean' },
  { key: 'session_idle_minutes',  value: '15',   category: 'security', label: 'Treat a session as inactive after (minutes)', type: 'number'  },
  // Cross-notify concurrent admins: when an admin signs in while another
  // admin is already online, both are told. The one signing in sees it on
  // the login screen; the one already online gets a banner from the
  // /api/session-alerts poll.
  { key: 'admin_login_alert',     value: 'true', category: 'security', label: 'Notify admins when another admin signs in', type: 'boolean' },

  // ── SPICE BOARD REPORTS ────────────────────────────────────
  // Newline-separated list of Form-D "Place of auction" options. The
  // operator picks one from a dropdown when generating Form-D in the
  // Spice Board menu — that value overrides the branch-derived default.
  // Edit / add entries from Settings → Spice Board Reports (one place
  // per line; blank lines and surrounding whitespace are ignored).
  { key: 'formd_places',
    value: 'e-Auction Spices Park Puttady\ne-Auction Spices Board Bodinayakanur',
    category: 'spice_board',
    label: 'Form-D Place of Auction (one per line)',
    type: 'textarea' },

  // ── BUSINESS MODE ──────────────────────────────────────────
  // e-Auction only build. State is a dropdown: TAMIL NADU or KERALA.
  { key: 'business_mode',  value: 'e-Auction',  category: 'mode', label: 'Business Mode',  type: 'readonly' },
  { key: 'business_state', value: 'TAMIL NADU', category: 'mode', label: 'Business State', type: 'select'   },
  // Display-only date format. Stored in dd/mm/yyyy by default — the
  // canonical DB storage stays ISO yyyy-mm-dd regardless. Picking a
  // different value re-renders every date in the UI, exports, and PDFs.
  { key: 'date_format',    value: 'dd/mm/yyyy', category: 'mode', label: 'Date Format',    type: 'select'   },

  // ── INTEGRATIONS ───────────────────────────────────────────
  { key: 'gst_api_key',    value: '', category: 'integrations', label: 'GST Lookup API Key (gstincheck.co.in)',   type: 'text' },
  // Config-driven external link buttons shown in the top-right of the Lots
  // and To Tally screens. The button only appears when its URL has a value;
  // the optional label overrides the default "Open Link" caption.
  { key: 'link_lots_url',    value: '', category: 'integrations', label: 'Lots Screen — Top-right Link URL',       type: 'text' },
  { key: 'link_lots_label',  value: '', category: 'integrations', label: 'Lots Screen — Link Button Label',         type: 'text' },
  { key: 'link_tally_url',   value: '', category: 'integrations', label: 'To Tally Screen — Top-right Link URL',    type: 'text' },
  { key: 'link_tally_label', value: '', category: 'integrations', label: 'To Tally Screen — Link Button Label',     type: 'text' },

  // ── TALLY EXPORT ──────────────────────────────────────────
  // REMOVED tally toggles per spec: tally_optional, tally_dispatch_from,
  // tally_eway_enabled, tally_ship_to, tally_amazing_mode,
  // tally_state_code_amazing, tally_ainv_prefix.
  { key: 'tally_company_name', value: '', category: 'tally', label: 'Tally Company Name',                 type: 'text' },
  { key: 'tally_season',       value: '', category: 'tally', label: 'Season Suffix',                      type: 'text' },
  { key: 'tally_separator',    value: '', category: 'tally', label: 'Voucher Separator',                  type: 'text' },
  { key: 'tally_inv_prefix',   value: '', category: 'tally', label: 'Voucher Prefix',                     type: 'text' },
  { key: 'tally_state_code',   value: '', category: 'tally', label: 'Home GSTIN State Code (intra)',      type: 'text' },
  { key: 'tally_home_state',   value: '', category: 'tally', label: 'Home Place of Supply',               type: 'text' },
  { key: 'tally_urd_state',    value: '', category: 'tally', label: 'URD Purchase State (agriculturist)', type: 'text' },
  // Voucher type (VCHTYPE) for the purchase XML exports. Defaults to Tally's
  // built-in "Purchase"; set to a custom Tally voucher-type name (e.g.
  // "RD Purchase" / "URD Purchase") to import under that type instead.
  { key: 'tally_rd_purchase_vchtype',  value: 'Purchase', category: 'tally', label: 'RD Purchase Voucher Type (VCHTYPE)',  type: 'text' },
  { key: 'tally_urd_purchase_vchtype', value: 'Purchase', category: 'tally', label: 'URD Purchase Voucher Type (VCHTYPE)', type: 'text' },

  // Purchase-side party ledger-name suffixes. The purchase voucher, debit
  // note, and LEDGER master all derive the party name the same way (see
  // _rdPurchaseLedgerName / _urdPurchaseLedgerName in tally-xml.js), so these
  // MUST stay in sync — change them here, not in one place. The URD template
  // supports a {PAN} placeholder (replaced with the planter's PAN); when a
  // planter has no PAN on file, the RD suffix is used as the fallback.
  { key: 'tally_rd_ledger_suffix',  value: '-PURCHASE', category: 'tally', label: 'RD Party Ledger Suffix',           type: 'text' },
  { key: 'tally_urd_ledger_suffix', value: '-[{PAN}]',  category: 'tally', label: 'URD Party Ledger Suffix ({PAN})',  type: 'text' },

  // ── Voucher-REFERENCE tails ──────────────────────────────────────────
  // The trailing token welded onto a Tally voucher number / bill reference
  // AFTER the season, marking which series the document belongs to:
  //
  //     <doc no>/<season-short>/<tail>        e.g. "1748/26-27/URD"
  //
  // These used to be literals in tally-xml.js. Blank = no tail at all, so the
  // ref stops at the season ("1748/26-27"). A leading "/" is added for you —
  // enter just the token ("URD"), not "/URD".
  //
  // IMPORTANT: the value is part of the bill reference Tally ages against, so
  // changing it mid-season orphans every reference already sitting in Tally
  // under the old spelling. Change it at a season boundary.
  //
  // Defaults reproduce this build's existing output exactly: the URD PURCHASE
  // voucher carries no tail, while the debit notes keep their historical
  // URD (planter) / SE (dealer) tokens.
  { key: 'tally_urd_purchase_ref_suffix', value: '',    category: 'tally', label: 'URD Purchase Ref Tail (after season, e.g. "URD" — blank = none)', type: 'text' },
  // Leads the per-lot bill reference on the RD + URD purchase vouchers
  // (BILLALLOCATIONS NAME): blank → "14/093/26-27" (existing output); "A" →
  // "A14/093/26-27". Literal text, prepended as-is.
  { key: 'tally_purchase_bill_ref_prefix', value: '',   category: 'tally', label: 'Purchase Bill Ref Prefix — RD/URD (before the trade no, e.g. "A")', type: 'text' },
  { key: 'tally_dn_planter_ref_suffix',   value: 'URD', category: 'tally', label: 'Debit Note Ref Tail — Planter (after season)', type: 'text' },
  { key: 'tally_dn_dealer_ref_suffix',    value: 'SE',  category: 'tally', label: 'Debit Note Ref Tail — Dealer (after season)',  type: 'text' },

  // Mode toggles
  { key: 'tally_detailed',        value: 'false', category: 'tally', label: 'Detailed Inv (one inventory entry per lot)', type: 'boolean' },
  { key: 'tally_round_enabled',   value: 'false', category: 'tally', label: 'Round (Round On/Off ledger)',                 type: 'boolean' },
  { key: 'tally_tcs_enabled',     value: 'false', category: 'tally', label: 'TCS (apply on Sales when applicable)',        type: 'boolean' },
  { key: 'tally_tds_enabled',     value: 'false', category: 'tally', label: 'TDS (apply 194Q on RD Purchases)',            type: 'boolean' },
  { key: 'tally_dn_exempt',       value: 'false', category: 'tally', label: 'Exempted (Debit Note: skip GST tax ledgers)', type: 'boolean' },
  { key: 'tally_local_transport', value: 'false', category: 'tally', label: 'Local Transport (use local transport rate)',  type: 'boolean' },
  { key: 'tally_local_insurance', value: 'false', category: 'tally', label: 'Local Insurance (use local insurance rate)',  type: 'boolean' },

  // Sales Account Ledgers (Cardamom)
  { key: 'tally_sales_inter',  value: '', category: 'tally', label: 'Cardamom Inter-State Sales',     type: 'text' },
  { key: 'tally_sales_intra',  value: '', category: 'tally', label: 'Cardamom Local Sales',           type: 'text' },
  { key: 'tally_sales_export', value: '', category: 'tally', label: 'Cardamom Export Sales (Deemed)', type: 'text' },

  // Sales Account Ledgers (Gunny)
  { key: 'tally_gunny_inter',  value: '', category: 'tally', label: 'Gunny Interstate Sales', type: 'text' },
  { key: 'tally_gunny_intra',  value: '', category: 'tally', label: 'Gunny Local Sales',      type: 'text' },
  { key: 'tally_gunny_export', value: '', category: 'tally', label: 'Gunny Export Sales',     type: 'text' },

  // Dealer-Side Sales
  { key: 'tally_dealer_sale_inter', value: '', category: 'tally', label: 'Interstate Dealer (sales-side)', type: 'text' },
  { key: 'tally_dealer_sale_intra', value: '', category: 'tally', label: 'Local Dealer (sales-side)',     type: 'text' },

  // RD Purchase ledgers
  { key: 'tally_purchase_dealer',            value: '', category: 'tally', label: 'Trade Purchase From Dealer (base)',            type: 'text' },
  // Interstate counterpart of the base purchase ledger above. Used in the RD
  // purchase voucher when the party GSTIN's state ≠ the company state; blank
  // falls back to the local base ledger.
  { key: 'tally_purchase_dealer_interstate', value: '', category: 'tally', label: 'Interstate Trade Purchase From Dealer (base)', type: 'text' },
  { key: 'tally_purchase_dealer_inter', value: '', category: 'tally', label: 'Interstate Dealer-Pur (purchase-side)',   type: 'text' },
  { key: 'tally_purchase_dealer_intra', value: '', category: 'tally', label: 'Local Dealer-Pur (purchase-side)',         type: 'text' },

  // Agriculturist & TDS-on-sales
  { key: 'tally_purchase_auction', value: '', category: 'tally', label: 'Purchase From Agriculturist (URD ledger)', type: 'text' },
  // Tally GROUP every agriculturist party ledger is created under. Distinct
  // from `tally_purchase_auction` above, which is the accounting ledger posted
  // INSIDE the URD voucher — this one is the party's parent group. The RD side
  // picks its parent per dealer (intra vs inter, from the GSTIN); planters are
  // flat, so one value covers them all. Blank → 'Planters', the value this
  // was hardcoded to before it became configurable.
  { key: 'tally_purchase_planter_parent', value: '', category: 'tally', label: 'Planter Party Ledger Parent (URD)', type: 'text' },
  { key: 'tally_tds_paid_sales',   value: '', category: 'tally', label: 'TDS Paid on Sales',                         type: 'text' },

  // Tax Ledger Names
  { key: 'tally_cgst',       value: '', category: 'tally', label: 'CGST 2.5% (output)',         type: 'text' },
  { key: 'tally_sgst',       value: '', category: 'tally', label: 'SGST 2.5% (output)',         type: 'text' },
  { key: 'tally_igst',       value: '', category: 'tally', label: 'IGST 5% (output)',           type: 'text' },
  { key: 'tally_cgst_input', value: '', category: 'tally', label: 'INPUT CGST 2.5%',            type: 'text' },
  { key: 'tally_sgst_input', value: '', category: 'tally', label: 'INPUT SGST 2.5%',            type: 'text' },
  { key: 'tally_igst_input', value: '', category: 'tally', label: 'INPUT IGST 5%',              type: 'text' },
  { key: 'tally_tcs',        value: '', category: 'tally', label: 'TCS on Sale of Goods',       type: 'text' },
  { key: 'tally_tds_ledger', value: '', category: 'tally', label: 'TDS on Purchase of Goods',   type: 'text' },

  // Debit Note ledgers
  { key: 'tally_dn_discount',  value: '', category: 'tally', label: 'Commission (Debit Note ledger)',                type: 'text'   },
  { key: 'tally_dnp_discount', value: '', category: 'tally', label: 'Commission-Planter (Debit Note-Planter ledger)', type: 'text'   },
  { key: 'tally_dn_cgst',     value: '', category: 'tally', label: 'CGST 2.5% (Debit Note)',                type: 'text'   },
  { key: 'tally_dn_sgst',     value: '', category: 'tally', label: 'SGST 2.5% (Debit Note)',                type: 'text'   },
  { key: 'tally_dn_igst',     value: '', category: 'tally', label: 'IGST 5% (Debit Note)',                  type: 'text'   },
  { key: 'tally_dn_gst_rate', value: '0', category: 'tally', label: 'Debit Note GST Rate %',                type: 'number' },

  // Other operational ledgers
  { key: 'tally_sample_planter', value: '',     category: 'tally', label: 'Sample Refund to Planter', type: 'text'   },
  { key: 'tally_sample_dealer',  value: '',     category: 'tally', label: 'Sample Refund to Dealer',  type: 'text'   },
  { key: 'tally_sample_stock',   value: 'false',category: 'tally', label: 'Stock (sample refund)',    type: 'boolean'},
  { key: 'tally_round',          value: '',     category: 'tally', label: 'Round On/Off Ledger',      type: 'text'   },
  { key: 'tally_transport',      value: '',     category: 'tally', label: 'Transport Charges Ledger', type: 'text'   },
  { key: 'tally_insurance',      value: '',     category: 'tally', label: 'Insurance Charges Ledger', type: 'text'   },
  { key: 'tally_commission',            value: '', category: 'tally', label: 'Commission Ledger',                       type: 'text' },
  { key: 'tally_commission_interstate', value: '', category: 'tally', label: 'Commission Ledger InterState',             type: 'text' },
  { key: 'tally_commission_planter',    value: '', category: 'tally', label: 'Commission-Planter Ledger',               type: 'text' },
  { key: 'tally_cash_handling',         value: '', category: 'tally', label: 'Cash Handling Charges Ledger',            type: 'text' },
  { key: 'tally_cash_handling_planter', value: '', category: 'tally', label: 'Cash Handling Charges Ledger-Planter',     type: 'text' },

  // Tax / commercial rates
  { key: 'tally_gst_rate',         value: '0', category: 'tally', label: 'GST Goods Rate %',                type: 'number' },
  { key: 'tally_service_rate',     value: '0', category: 'tally', label: 'Service Rate % (DN/Discount)',    type: 'number' },
  { key: 'tally_tcs_rate',         value: '0', category: 'tally', label: 'TCS / TDS Rate %',                type: 'number' },
  { key: 'tally_export_rate',      value: '0', category: 'tally', label: 'Export GST Rate %',               type: 'number' },
  { key: 'tally_sample_kgs',       value: '0', category: 'tally', label: 'Sample Refund (Kgs)',             type: 'number' },
  { key: 'tally_gunny_rate',       value: '0', category: 'tally', label: 'Gunny Rate (₹ per bag)',          type: 'number' },
  { key: 'tally_transport_rate',   value: '0', category: 'tally', label: 'Transport Rate (₹/Kg)',           type: 'number' },
  { key: 'tally_local_trans_rate', value: '0', category: 'tally', label: 'Local Transport Rate (₹/Kg)',     type: 'number' },
  { key: 'tally_insurance_rate',   value: '0', category: 'tally', label: 'Insurance Rate (₹/₹1000)',        type: 'number' },
  { key: 'tally_local_ins_rate',   value: '0', category: 'tally', label: 'Local Insurance Rate (₹/₹1000)',  type: 'number' },

  // Stock Item Names + HSN
  { key: 'tally_item_cardamom', value: '', category: 'tally', label: 'Stock Item — Cardamom', type: 'text' },
  { key: 'tally_item_gunny',    value: '', category: 'tally', label: 'Stock Item — Gunny',    type: 'text' },
  // Unit symbols emitted in the Tally XML (RATE / ACTUALQTY / BILLEDQTY). Must
  // match the unit defined on the stock item in Tally. Blank keeps the defaults
  // (cardamom "Kgs.", gunny "Nos.").
  { key: 'tally_unit_cardamom', value: '', category: 'tally', label: 'Unit — Cardamom (default Kgs.)', type: 'text' },
  { key: 'tally_unit_gunny',    value: '', category: 'tally', label: 'Unit — Gunny (default Nos.)',    type: 'text' },
  { key: 'tally_hsn_cardamom',  value: '', category: 'tally', label: 'HSN — Cardamom',        type: 'text' },
  { key: 'tally_hsn_gunny',     value: '', category: 'tally', label: 'HSN — Gunny',           type: 'text' },
  { key: 'tally_hsn_service',   value: '', category: 'tally', label: 'SAC — Service',         type: 'text' },
  { key: 'tally_hsn_transport', value: '', category: 'tally', label: 'SAC — Transport',       type: 'text' },
  { key: 'tally_hsn_insurance', value: '', category: 'tally', label: 'SAC — Insurance',       type: 'text' },

  // E-way bill DISTANCE estimation
  { key: 'distance_auto_enabled',    value: 'false', category: 'tally', label: 'Auto-fill <DISTANCE> from PIN coordinates', type: 'check'  },
  { key: 'distance_road_multiplier', value: '0',     category: 'tally', label: 'Road-distance multiplier',                  type: 'number' },
];

const CATEGORIES = {
  mode:         { order: 0,    title: 'Business Mode',          icon: '⚙' },
  company:      { order: 1,    title: 'Company Details',         icon: '🏢' },
  address_kl:   { order: 2,    title: 'Address (Kerala)',        icon: '📍' },
  address_tn:   { order: 3,    title: 'Address (Tamil Nadu)',    icon: '📍' },
  branches:     { order: 5,    title: 'Branches & Contacts',     icon: '🏪' },
  rates:        { order: 6,    title: 'Rates & Charges',         icon: '💰' },
  hsn:          { order: 7,    title: 'HSN / SAC Codes',         icon: '🏷' },
  bank:         { order: 8,    title: 'Bank Details',            icon: '🏦' },
  season:       { order: 9,    title: 'Season / Financial Year', icon: '📅' },
  spice_board:  { order: 9.5,  title: 'Spice Board Reports',     icon: '📋' },
  invoice:      { order: 10,   title: 'Invoice Settings',        icon: '📄' },
  flags:        { order: 11,   title: 'Feature Flags',           icon: '🔧' },
  lot_entry:    { order: 11.5, title: 'Lot Entry Defaults',      icon: '📝' },
  alerts:       { order: 11.7, title: 'Booking Alerts',          icon: '🚨', description: 'Soft alerts when grade-2 bookings dominate an auction. When grade-2 weight exceeds the threshold percentage of the total weight booked so far, the depot manager is notified (in-app + WhatsApp); any further grade-2 booking after that escalates to the immediate superior. Each level fires once per auction.' },
  security:     { order: 11.8, title: 'Logins & Sessions',       icon: '🔐', description: 'Controls concurrent sign-ins. With the block on, a username that is already active anywhere cannot be signed in again — the second person is told who holds the session. A session counts as active only while it has made a request within the idle window, so a browser closed without logging out frees the username by itself. Admins can also clear a stuck session at once from Users → Sign out.' },
  integrations: { order: 12,   title: 'Integrations',            icon: '🔌', description: 'Optional third-party services. The GST API key enables auto-fetching trade name and address when you enter a GSTIN (get a free key at gstincheck.co.in). The WhatsApp Business card lets you send invoices/notices straight from the app via Meta’s Cloud API.' },
  tally:        { order: 13,   title: 'To Tally',                icon: '📤' },
};

function initCompanySettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'company',
      label TEXT NOT NULL DEFAULT '',
      field_type TEXT NOT NULL DEFAULT 'text'
    );
  `);

  const insert = db.prepare(
    'INSERT OR IGNORE INTO company_settings (key, value, category, label, field_type) VALUES (?, ?, ?, ?, ?)'
  );
  // `delete_enabled` was split out of `edit_enabled` (one switch used to gate
  // both edit and delete in the mobile app). Seed it from the current
  // `edit_enabled` BEFORE the defaults land, so an install that already
  // allowed edits keeps allowing deletes exactly as it did — the split
  // changes what the operator can configure, not what they can do today.
  const _delRow  = db.prepare("SELECT value FROM company_settings WHERE key = 'delete_enabled'").get();
  const _editRow = db.prepare("SELECT value FROM company_settings WHERE key = 'edit_enabled'").get();
  if (!_delRow && _editRow) {
    insert.run('delete_enabled', String(_editRow.value || 'false'), 'lot_entry',
      'Allow Lot Deletes (non-admin)', 'boolean');
  }

  const seed = db.transaction(() => {
    for (const d of DEFAULTS) insert.run(d.key, d.value, d.category, d.label, d.type);
  });
  seed();

  // Also refresh label/category for existing rows so renames in DEFAULTS
  // (e.g. shorter labels) propagate to installs that already seeded earlier.
  const refresh = db.prepare(
    'UPDATE company_settings SET category = ?, label = ?, field_type = ? WHERE key = ?'
  );
  const refreshAll = db.transaction(() => {
    for (const d of DEFAULTS) refresh.run(d.category, d.label, d.type, d.key);
  });
  refreshAll();

  // Drop every key that is no longer permitted by this build. Includes
  // the legacy sister/ASP carryovers AND the new removals from this rev:
  // deduction1/deduction2/refund, flag_disc_gst, tally_optional,
  // tally_dispatch_from, tally_eway_enabled, tally_ship_to,
  // tally_amazing_mode, tally_state_code_amazing, tally_ainv_prefix.
  const REMOVED_KEYS = [
    // Removed in this revision
    'deduction1', 'deduction2', 'refund',
    'flag_disc_gst',
    'tally_optional', 'tally_dispatch_from', 'tally_eway_enabled',
    'tally_ship_to', 'tally_amazing_mode',
    'tally_state_code_amazing', 'tally_ainv_prefix',
    'inv_prefix_sister', 'flag_sister',
    // Spice Board licence + place — dropped; Form C / D / Buyers
    // Statement now use the company's SBL No. and the active state's
    // Office Branch for the licence / place fields respectively. The
    // season_start_year / season_end_year keys were briefly seeded
    // alongside; reverted too.
    'eauction_licence', 'spice_board_licence', 'auction_place', 'business_place',
    'season_start_year', 'season_end_year',
    // Praman Lot Code — removed in this revision. The fallback chain
    // (short_name → first word of trade_name) was always good enough,
    // and the user-facing field added clutter to the Tally panel
    // without any operational benefit.
    'praman_company',
    // Default Rows Per Page — briefly seeded as a server-side default
    // for the pager. Reverted; the per-browser localStorage dropdown
    // in the pager footer is the only control now.
    'default_page_size',
    // Renamed to flag_reserved_price in the same dev cycle.
    'flag_control_price',
    // Inherited from earlier cleanups
    'asp_profit', 'isp_profit',
    'asp_profit_pooler', 'asp_profit_dealer',
    'isp_profit_pooler', 'isp_profit_dealer',
    'dispatched_through', 'dispatched_through_asp',
    'commission_bill', 'memorandum_text',
    'flag_tnpa', 'flag_rtds_inv', 'flag_eway',
    's_logo', 's_company', 's_short_name', 's_address1', 's_address2',
    's_phone', 's_email', 's_gstin', 's_cin', 's_pan', 's_fssai', 's_sbl',
    'tally_asp_company_name',
    'tally_amazing_mode',
    // NOTE: tally_commission / tally_cash_handling / tally_cash_handling_planter
    // were previously removed but are now ACTIVE service ledgers (see DEFAULTS).
    'tally_chc_planter', 'tally_unit_rate',
    // Commission/handling GST settings — added when these ledgers posted into
    // the purchase vouchers, then dropped when that voucher wiring was removed.
    'tally_commission_gst_rate', 'tally_service_cgst', 'tally_service_sgst', 'tally_service_igst',
    'tally_dispatch_company', 'tally_dispatch_address', 'tally_dispatch_place',
    'tally_dispatch_pin', 'tally_dispatch_state', 'tally_dispatch_gstin',
  ];
  const drop = db.prepare('DELETE FROM company_settings WHERE key = ?');
  for (const k of REMOVED_KEYS) drop.run(k);

  // Drop legacy preset tables.
  try { db.exec('DROP TABLE IF EXISTS company_presets'); } catch (e) {}
  try { db.exec('DROP TABLE IF EXISTS company_preset_meta'); } catch (e) {}

  // Force business_mode to 'e-Auction' regardless of any stale value.
  db.prepare("UPDATE company_settings SET value = 'e-Auction' WHERE key = 'business_mode'").run();
  // Migrate any stale 'BOTH' value left over from the previous revision.
  // A valid TAMIL NADU or KERALA value is preserved as-is.
  db.prepare(
    "UPDATE company_settings SET value = 'TAMIL NADU' WHERE key = 'business_state' AND value = 'BOTH'"
  ).run();
  // Also normalise any blank/unknown business_state to 'TAMIL NADU' so
  // the dropdown always opens on a valid option.
  db.prepare(
    "UPDATE company_settings SET value = 'TAMIL NADU' WHERE key = 'business_state' AND value NOT IN ('TAMIL NADU','KERALA')"
  ).run();

  // One-time migration for the new flag-gated fields. The flag defaults to
  // 'false' for fresh installs, but existing installs may already have
  // non-zero values configured for these fields — auto-flip the flag ON in
  // that case so the UI doesn't suddenly hide a value the user is using.
  // Only runs when the flag is still at its 'false' default.
  function autoEnableFlagIfAnyValue(flagKey, valueKeys) {
    const flag = db.prepare('SELECT value FROM company_settings WHERE key = ?').get(flagKey);
    if (!flag || String(flag.value).toLowerCase() === 'true') return;
    const hasValue = valueKeys.some(k => {
      const r = db.prepare('SELECT value FROM company_settings WHERE key = ?').get(k);
      if (!r) return false;
      const v = String(r.value || '').trim();
      return v && v !== '0' && v !== '0.0' && v !== '0.00';
    });
    if (hasValue) {
      db.prepare("UPDATE company_settings SET value = 'true' WHERE key = ?").run(flagKey);
    }
  }
  autoEnableFlagIfAnyValue('flag_local_ti',     ['local_transport', 'local_insurance']);
  autoEnableFlagIfAnyValue('flag_addl_charges', ['addl_charge_name', 'addl_charge_value']);

  // The 'rns' layout id was renamed to the generic 'letterhead' (RNS is a
  // specific company name). Rewrite any stored *_template setting still pointing
  // at 'rns' so those installs keep the same layout instead of silently
  // falling back to their doc-type default.
  db.prepare(
    "UPDATE company_settings SET value = 'letterhead' WHERE value = 'rns' AND key IN " +
    "('sales_invoice_template','purchase_invoice_template','agri_bill_template'," +
    "'commission_bill_template','debit_note_template')"
  ).run();

  // `interstate_invoice_prefix` → `proforma_invoice_prefix`. The prefix now
  // applies to every sale type (not just inter-state) and leads the token
  // ("PI/I-2009"), so the key was renamed to match. Carry a configured old
  // value across — but never clobber a value already set on the new key —
  // then drop the stale row so Settings shows only the new field.
  const _oldPfx = db.prepare("SELECT value FROM company_settings WHERE key = 'interstate_invoice_prefix'").get();
  if (_oldPfx && String(_oldPfx.value || '').trim()) {
    db.prepare(
      "UPDATE company_settings SET value = ? WHERE key = 'proforma_invoice_prefix' AND TRIM(COALESCE(value,'')) = ''"
    ).run(String(_oldPfx.value).trim());
  }
  db.prepare("DELETE FROM company_settings WHERE key = 'interstate_invoice_prefix'").run();

  // `tally_purchase_manual_voucherno` (one switch over BOTH purchase vouchers)
  // → `_rd` + `_urd`. An install that had the single flag ON was blanking the
  // voucher number on both exports, so carry the value onto both new keys —
  // never clobbering one an operator has already set — then drop the stale row
  // so Settings shows only the two new toggles.
  const _oldMvn = db.prepare("SELECT value FROM company_settings WHERE key = 'tally_purchase_manual_voucherno'").get();
  if (_oldMvn && String(_oldMvn.value).toLowerCase() === 'true') {
    db.prepare(
      "UPDATE company_settings SET value = 'true' WHERE value = 'false' AND key IN " +
      "('tally_purchase_manual_voucherno_rd','tally_purchase_manual_voucherno_urd')"
    ).run();
  }
  db.prepare("DELETE FROM company_settings WHERE key = 'tally_purchase_manual_voucherno'").run();

  console.log('Company settings ready (%d defaults)', DEFAULTS.length);
}

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM company_settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function getSettingBool(db, key) {
  const v = getSetting(db, key);
  return v === 'true' || v === '1';
}

function getSettingNum(db, key) {
  return parseFloat(getSetting(db, key)) || 0;
}

function getAllSettings(db) {
  const rows = db.prepare('SELECT key, value, category, label, field_type FROM company_settings ORDER BY rowid').all();
  const grouped = {};
  for (const r of rows) {
    // Suppress retired/unsupported settings so they never render in the
    // Settings UI even when present in the DB (e.g. via a settings import).
    if (HIDDEN_SETTING_KEYS.has(r.key)) continue;
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  }
  return grouped;
}

// Rates & Charges settings whose every value change is recorded in the
// settings_history table so the Settings UI can show a per-field history.
const TRACKED_HISTORY_KEYS = new Set([
  'gunny_rate', 'transport', 'insurance',
  'discount_pct', 'discount_days', 'dealer_days',
]);

function updateSettings(db, settings, opts = {}) {
  const username = opts.username || '';
  const upd = db.prepare('UPDATE company_settings SET value = ? WHERE key = ?');
  const sel = db.prepare('SELECT value FROM company_settings WHERE key = ?');
  const hist = db.prepare(
    'INSERT INTO settings_history (key, old_value, new_value, username) VALUES (?,?,?,?)'
  );
  const batch = db.transaction((items) => {
    let n = 0;
    for (const [k, v] of Object.entries(items)) {
      const nv = String(v);
      // Record a history row only when a tracked rate actually changes.
      if (TRACKED_HISTORY_KEYS.has(k)) {
        const row = sel.get(k);
        const ov = row ? String(row.value) : null;
        if (ov !== nv) hist.run(k, ov, nv, username);
      }
      upd.run(nv, k);
      n++;
    }
    return n;
  });
  return batch(settings);
}

function getSettingHistory(db, key, limit = 20) {
  if (!TRACKED_HISTORY_KEYS.has(key)) return [];
  return db.prepare(
    `SELECT key, old_value, new_value, username, created_at
       FROM settings_history WHERE key = ? ORDER BY id DESC LIMIT ?`
  ).all(key, limit);
}

function getSettingsFlat(db) {
  const rows = db.prepare('SELECT key, value, field_type FROM company_settings').all();
  const flat = {};
  for (const r of rows) {
    if (r.field_type === 'boolean') flat[r.key] = r.value === 'true';
    else if (r.field_type === 'number') flat[r.key] = parseFloat(r.value) || 0;
    else flat[r.key] = r.value;
  }
  return flat;
}

function getGSTRates(db) {
  const g = getSettingNum(db, 'gst_goods');
  return { cgst: g / 2, sgst: g / 2, igst: g, service: getSettingNum(db, 'gst_service'), tcs: getSettingNum(db, 'tcs_tds') };
}

module.exports = { DEFAULTS, CATEGORIES, initCompanySettings, getSetting, getSettingBool, getSettingNum, getAllSettings, updateSettings, getSettingHistory, getSettingsFlat, getGSTRates };
