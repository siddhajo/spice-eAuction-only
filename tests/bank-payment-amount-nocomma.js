// Bank Payment XLSX (hdfc_ac): the Amount DATA cells must carry NO thousands
// separator, while the TOTAL row keeps the comma. Renders the real workbook and
// inspects the cell number formats.
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bankpay-'));
process.env.SPICE_DATA_DIR = TMP;

const { initDb, getDb, closeDb } = require(path.join(__dirname, '..', 'db.js'));
const { initCompanySettings } = require(path.join(__dirname, '..', 'company-config.js'));
const { getBankFormat } = require(path.join(__dirname, '..', 'bank-formats.js'));
const exportsMod = require(path.join(__dirname, '..', 'exports.js'));
const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

(async () => {
  await initDb();
  const db = getDb();
  initCompanySettings(db);

  // The renderer is not exported directly, but exportBankPayment routes through
  // it. Simpler: drive renderBankPaymentView via a crafted payments array by
  // calling the exported buffer builder the same way. We reach it through the
  // module's createExcelBuffer + the hdfc_ac profile to keep the test hermetic.
  const view = getBankFormat('hdfc_ac');
  check('hdfc_ac Amount column format is plain "0" (no comma)',
        view.columns.find(c => c.key === 'amount').numFmt === '0');
  check('hdfc_ac declares a comma format for the total', view.totalAmountFmt === '#,##0');

  // Build the sheet exactly as renderBankPaymentView does (total + numFmts).
  const payments = [
    { particulars: '14 001', beneficiaryName: 'A', amount: 161127, accountNo: '1', ifsc: 'X', phone: '9' },
    { particulars: '14 002', beneficiaryName: 'B', amount: 1070191, accountNo: '2', ifsc: 'X', phone: '9' },
  ];
  const cleanCols = view.columns.map(({ format, ...rest }) => rest);
  const buf = await exportsMod.createExcelBuffer(view.sheetName, cleanCols, payments, {
    db, title: view.title, skipCompanyHeader: true,
    grandTotal: { label: 'Total', values: { amount: 161127 + 1070191 }, numFmts: { amount: view.totalAmountFmt } },
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];

  // Find the Amount column index + the data / total rows.
  let hdrRow = null, amtCol = null;
  ws.eachRow((row, n) => {
    if (hdrRow) return;
    row.eachCell((c, ci) => { if (String(c.value).trim().toUpperCase() === 'AMOUNT') { hdrRow = n; amtCol = ci; } });
  });
  check('Amount header located', hdrRow != null && amtCol != null);

  const dataCell = ws.getRow(hdrRow + 1).getCell(amtCol);
  check('Amount data cell is numeric (comma-stripped, not text)', typeof dataCell.value === 'number',
        `type ${typeof dataCell.value}`);
  check('Amount DATA cell format has NO comma (fmt "0")', dataCell.numFmt === '0',
        `numFmt ${JSON.stringify(dataCell.numFmt)}`);

  // Total row: last row whose first cell (or any cell) says "Total".
  let totalRow = null;
  ws.eachRow((row) => { row.eachCell((c) => { if (String(c.value).trim().toUpperCase() === 'TOTAL') totalRow = row; }); });
  check('Total row present', !!totalRow);
  const totalAmt = totalRow.getCell(amtCol);
  check('TOTAL amount keeps the comma format (#,##0)', totalAmt.numFmt === '#,##0',
        `numFmt ${JSON.stringify(totalAmt.numFmt)}`);
  check('TOTAL amount value = 1,231,318', Number(totalAmt.value) === 1231318, `got ${totalAmt.value}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  closeDb && closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
