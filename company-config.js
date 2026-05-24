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

  // ── ADDRESS (Kerala) ───────────────────────────────────────
  { key: 'kl_address1', value: '', category: 'address_kl', label: 'Address Line 1',  type: 'text' },
  { key: 'kl_address2', value: '', category: 'address_kl', label: 'Address Line 2',  type: 'text' },
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
  { key: 'gst_goods',           value: '0', category: 'rates', label: 'GST Goods Rate %',                             type: 'number' },
  { key: 'gst_service',         value: '0', category: 'rates', label: 'GST Service Rate %',                           type: 'number' },
  { key: 'discount_gst',        value: '0', category: 'rates', label: 'Discount GST %',                               type: 'number' },
  { key: 'tcs_tds',             value: '0', category: 'rates', label: 'TCS / TDS Rate %',                             type: 'number' },
  { key: 'tds_purchase_rate',   value: '0', category: 'rates', label: 'TDS on Purchase Rate % (Section 194Q)',        type: 'number' },
  { key: 'tds_threshold',       value: '0', category: 'rates', label: 'TDS / TCS Annual Threshold (₹)',               type: 'number' },
  { key: 'gunny_rate',          value: '0', category: 'rates', label: 'Gunny Rate (₹)',                               type: 'number' },
  { key: 'transport',           value: '0', category: 'rates', label: 'Transport (₹/kg)',                             type: 'number' },
  { key: 'insurance',           value: '0', category: 'rates', label: 'Insurance (₹/kg)',                             type: 'number' },
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
  { key: 'flag_tds_purchase',    value: 'false', category: 'flags', label: 'TDS on Purchase Invoice',         type: 'boolean' },
  { key: 'flag_tds_sales',       value: 'false', category: 'flags', label: 'TDS on Sales Invoice',            type: 'boolean' },
  { key: 'flag_wgst',            value: 'false', category: 'flags', label: 'TDS on Full Invoice Amount',      type: 'boolean' },
  { key: 'flag_debit_note',      value: 'false', category: 'flags', label: 'Debit Note for Discount',         type: 'boolean' },
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
  // Set Buyer Code bulk action on the Lots tab — when ON, a "👤 Set
  // Buyer Code" button appears next to "🗑 Delete Selected" once a
  // lot is ticked, opening a modal where the operator picks a buyer
  // code and applies it to every selected lot (with buyer / buyer1 /
  // sale auto-filled from the buyers master). Default OFF so the
  // button only appears when an admin explicitly enables it.
  { key: 'flag_bulk_set_buyer_code', value: 'false', category: 'flags', label: 'Bulk Set Buyer Code (Lots tab)', type: 'boolean' },

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
  { key: 'show_moisture',      value: 'false', category: 'lot_entry', label: 'Show Moisture Column',               type: 'boolean' },
  { key: 'default_litre',      value: '',      category: 'lot_entry', label: 'Default Litre Weight',               type: 'text'    },
  { key: 'default_crop_type',  value: '',      category: 'lot_entry', label: 'Default Crop Type',                  type: 'text'    },
  { key: 'edit_enabled',       value: 'false', category: 'lot_entry', label: 'Allow Lot Edits (non-admin)',        type: 'boolean' },
  { key: 'edit_timeout_sec',   value: '0',     category: 'lot_entry', label: 'Edit Timeout (sec; 0 = no limit)',    type: 'number'  },
  { key: 'lot_receipt_format', value: '',      category: 'lot_entry', label: 'Lot Receipt Format (compact|detailed)', type: 'text' },

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
  { key: 'tally_dealer_sale_inter', value: '', category: 'tally', label: 'Interstate Dealer-Purch (sales-side)', type: 'text' },
  { key: 'tally_dealer_sale_intra', value: '', category: 'tally', label: 'Local Dealer-Purcha (sales-side)',     type: 'text' },

  // RD Purchase ledgers
  { key: 'tally_purchase_dealer',       value: '', category: 'tally', label: 'Trade Purchase From Dealer (base)',   type: 'text' },
  { key: 'tally_purchase_dealer_inter', value: '', category: 'tally', label: 'Interstate Dealer (purchase-side)',   type: 'text' },
  { key: 'tally_purchase_dealer_intra', value: '', category: 'tally', label: 'Local Dealer (purchase-side)',         type: 'text' },

  // Agriculturist & TDS-on-sales
  { key: 'tally_purchase_auction', value: '', category: 'tally', label: 'Purchase From Agriculturist (URD ledger)', type: 'text' },
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
  { key: 'tally_dn_discount', value: '', category: 'tally', label: 'Discount on Purch (Debit Note ledger)', type: 'text'   },
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
  integrations: { order: 12,   title: 'Integrations',            icon: '🔌' },
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
    'tally_commission', 'tally_cash_handling', 'tally_cash_handling_planter',
    'tally_chc_planter', 'tally_unit_rate',
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
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  }
  return grouped;
}

function updateSettings(db, settings) {
  const upd = db.prepare('UPDATE company_settings SET value = ? WHERE key = ?');
  const batch = db.transaction((items) => {
    let n = 0;
    for (const [k, v] of Object.entries(items)) { upd.run(String(v), k); n++; }
    return n;
  });
  return batch(settings);
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

module.exports = { DEFAULTS, CATEGORIES, initCompanySettings, getSetting, getSettingBool, getSettingNum, getAllSettings, updateSettings, getSettingsFlat, getGSTRates };
