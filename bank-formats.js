// ── Bank Payment file formats (per-customer) ─────────────────────────────
//
// The SAME auction codebase is sold to different customers whose banks each
// demand a different bank-payment upload layout (column set / order / headers /
// widths, and occasionally a value transform). The PAYMENT DATA is identical
// across customers — it comes from calculations.js `getBankPaymentData`, which
// emits a rich superset row:
//
//   { transactionType, debitAccount, accountType, ifsc, accountNo,
//     beneficiaryName, address1, address2, pin, amount, remarks, holderName }
//
// A "format" here is PRESENTATION ONLY: which of those fields to emit, in what
// order, under what header. So supporting a new customer's bank = adding one
// entry below — never a code fork.
//
// The active format is chosen by the `bank_format` company setting
// (see company-config.js, category 'bank'). getSettingsFlat() surfaces it as
// cfg.bank_format; exports.js resolves it to a profile here, falling back to
// DEFAULT_BANK_FORMAT when unset/unknown so existing installs are unchanged.
//
// ── Profile shape ────────────────────────────────────────────────────────
//   {
//     label:     string,          // shown in the Settings dropdown option
//     sheetName: string,          // XLSX worksheet name (after variant)
//     title:     string,          // brand-band title (after variant)
//     includeMeta?: boolean,      // default true — false drops the auction
//                                 // meta lines (some bank portals reject them)
//     columns:   [ Column ],      // the "after discount" layout (bank_payment)
//     before?: {                  // optional "before discount" layout
//       sheetName, title, includeMeta?, columns
//     },
//   }
//
// ── Column shape ─────────────────────────────────────────────────────────
//   {
//     header: string,             // column header text
//     key:    string,             // field on the payment row (see superset above)
//     width?: number,             // default 15
//     numFmt?: string,            // ExcelJS number format (e.g. '#,##0.00')
//     align?: 'left'|'center'|'right',
//     format?: (value, row) => any,  // optional per-cell transform. Return a
//                                 // STRING to force text (leave numFmt unset),
//                                 // or a number to keep it numeric.
//   }
//
// NOTE: the `before` variant is a DATA difference (pre-discount puramt), driven
// by exports.js passing { before:true } to getBankPaymentData — it is a
// separate export button, not a dropdown choice. Each profile may carry its own
// `before` columns; profiles without one fall back to the default's.

const BANK_FORMATS = {
  // ── Default (unchanged current behaviour) ──────────────────────────────
  // Reproduces the exact columns the app shipped before formats were
  // configurable, so installs that never set `bank_format` see no change.
  rtgs_neft: {
    label: 'RTGS / NEFT (default)',
    sheetName: 'BankPayment',
    title: 'Bank Payment (RTGS/NEFT)',
    columns: [
      { header: 'PAYSYS ID (RTGS/NEFT)',    key: 'transactionType', width: 18 },
      { header: 'DEBIT ACCOUNT',            key: 'debitAccount',    width: 20 },
      { header: 'TRAN AMOUNT',              key: 'amount',          width: 14 },
      { header: 'BENEFICIARY ACCOUNT',      key: 'accountNo',       width: 20 },
      { header: 'BENEFICIARY ACCOUNT TYPE', key: 'accountType',     width: 16 },
      { header: 'BENEFICIARY NAME',         key: 'beneficiaryName', width: 30 },
      { header: 'BENEFICIARY ADD1',         key: 'address1',        width: 30 },
      { header: 'BENEFICIARY ADD2',         key: 'address2',        width: 20 },
      { header: 'BENEFICIARY IFSC',         key: 'ifsc',            width: 14 },
      { header: 'SENDER TO RECEIVER INFO',  key: 'remarks',         width: 50 },
    ],
    before: {
      sheetName: 'BankPaymentBefore',
      title: 'Bank Payment (Before)',
      columns: [
        { header: 'TransactionType', key: 'transactionType', width: 16 },
        { header: 'BeneIFSCode',     key: 'ifsc',            width: 14 },
        { header: 'BeneAcctNo',      key: 'accountNo',       width: 20 },
        { header: 'BeneName',        key: 'beneficiaryName', width: 30 },
        { header: 'BeneAddLine1',    key: 'address1',        width: 30 },
        { header: 'BeneAddLine2',    key: 'address2',        width: 20 },
        { header: 'BeneAddLine3',    key: 'pin',             width: 10 },
      ],
    },
  },

  // ── Add per-customer bank layouts below ────────────────────────────────
  // Example scaffold — copy, rename the key, and adjust columns to match the
  // customer's bank upload template. Keep the key in sync with the dropdown
  // option list in public/index.html (search: BANK_FORMAT_OPTIONS).
  //
  // hdfc_bulk: {
  //   label: 'HDFC Bulk Upload',
  //   sheetName: 'Payments',
  //   title: 'Bank Payment',
  //   includeMeta: false,                 // portal rejects header/title rows
  //   columns: [
  //     { header: 'Beneficiary Name', key: 'beneficiaryName', width: 30 },
  //     { header: 'Account Number',   key: 'accountNo',       width: 20 },
  //     { header: 'IFSC',             key: 'ifsc',            width: 14 },
  //     { header: 'Amount',           key: 'amount',          width: 14,
  //       format: v => Number(v || 0).toFixed(2) },   // bank wants "1234.00" text
  //     { header: 'Payment Type',     key: 'transactionType', width: 12 },
  //     { header: 'Narration',        key: 'remarks',         width: 50 },
  //   ],
  // },
};

// Falls back to this when cfg.bank_format is empty or names an unknown profile.
const DEFAULT_BANK_FORMAT = 'rtgs_neft';

// Resolve cfg.bank_format → a profile object, always non-null.
function getBankFormat(key) {
  return BANK_FORMATS[key] || BANK_FORMATS[DEFAULT_BANK_FORMAT];
}

module.exports = { BANK_FORMATS, DEFAULT_BANK_FORMAT, getBankFormat };
