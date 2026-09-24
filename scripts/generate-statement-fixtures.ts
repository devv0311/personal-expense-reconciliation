/**
 * Writes the binary statement fixtures — one `.xlsx` workbook and two `.pdf` statements.
 *
 * They are binary, so they cannot be reviewed as text in a diff; this script is how they are
 * reproduced and how a reader can see exactly what is in them. **Both are synthetic**, like
 * everything else in `fixtures/` (`fixtures/README.md`): the amounts, dates and merchant names
 * are illustrative, and no real bank ever produced either file.
 *
 * They are structurally real, though — a genuine ZIP of genuine SpreadsheetML, and a genuine
 * PDF with Flate-compressed content streams and real text operators. That is the point: a
 * reader tested only against bytes it also wrote would prove nothing about the container, so
 * these are written the way the specifications say, not the way the parsers happen to read.
 *
 * Run with `npx tsx scripts/generate-statement-fixtures.ts`.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildTextPdf } from '../tests/support/synthetic-pdf.js';
import { buildWorkbook } from '../tests/support/synthetic-workbook.js';
import type { SheetRows } from '../tests/support/synthetic-workbook.js';

const OUT_DIR = join(process.cwd(), 'fixtures', 'statements');

/* --------------------------------------------------------------------------- xlsx */

/** An SBI-shaped statement, as a workbook — the shape a bank's "Download as Excel" produces. */
const SHEET_ROWS: SheetRows = [
  ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
  [
    '01 Jul 2026',
    '01 Jul 2026',
    'TO TRANSFER UPI/DR/2607011234/BLINKIT',
    'UPI/2607011234/BLINKIT',
    '1240.00',
    '',
    '48120.00',
  ],
  [
    '02 Jul 2026',
    '02 Jul 2026',
    'BY TRANSFER NEFT FROM SELF',
    'NEFT/N072026001',
    '',
    '15000.00',
    '63120.00',
  ],
  [
    '05 Jul 2026',
    '05 Jul 2026',
    'ACH REFUND SAMPLE ELECTRONICS STORE',
    'ACH/REF9981',
    '',
    '450.00',
    '63570.00',
  ],
];

/* ---------------------------------------------------------------------------- pdf */

/** The lines a generated bank statement PDF prints, in the `date narration dr cr bal` layout. */
const PDF_LINES: readonly string[] = [
  'SYNTHETIC BANK — ACCOUNT STATEMENT',
  'Account XXXXXXXX4821   Period 01/07/2026 to 31/07/2026',
  'Date Narration Withdrawal Deposit Balance',
  '01/07/2026 UPI-BLINKIT9821PAYTM UPI/2607011234/BLINKIT 1,240.00 0.00 48,120.00',
  '02/07/2026 NEFT TRANSFER TO SELF NEFT/N072026001 15,000.00 0.00 33,120.00',
  '05/07/2026 ACH REFUND SAMPLE ELECTRONICS ACH/REF9981 0.00 450.00 33,570.00',
  'Closing balance 33,570.00',
];

function buildPdf(): Uint8Array {
  const content =
    'BT /F1 10 Tf 40 780 Td 14 TL\n' +
    PDF_LINES.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
    '\nET\n';
  const stream = deflateSync(Buffer.from(content, 'latin1'));

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `__STREAM__`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;

  objects.forEach((body, index) => {
    offsets.push(position);
    const number = index + 1;
    let buffer: Buffer;
    if (body === '__STREAM__') {
      const header = Buffer.from(
        `${number} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1',
      );
      buffer = Buffer.concat([header, stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      buffer = Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, 'latin1');
    }
    chunks.push(buffer);
    position += buffer.length;
  });

  const xrefStart = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const value of offsets) {
    xref += `${String(value).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return new Uint8Array(Buffer.concat(chunks));
}

/* -------------------------------------------------------------------------- write */

/**
 * An IDFC FIRST credit-card statement's shape, as a two-page PDF.
 *
 * **Synthetic throughout.** The issuer and product names are here because they are what the
 * `idfc_first_credit_card_pdf` layout identifies the *document* by; every card number, date,
 * merchant, narration and amount below is invented. No real statement was read, copied or
 * paraphrased to write this, and none may be.
 *
 * It carries, deliberately, every shape the layout has to survive:
 *
 *  - a preamble and a summary block above the transactions, which must not be read as rows;
 *  - a plain debit, and a `CR` credit, since a card credit is a refund rather than new spend;
 *  - a narration long enough to wrap onto a second physical line, which is the whole reason
 *    the layout is `dated_multiline`;
 *  - a dated line *after* the section's end marker, which must not be read at all.
 *
 * Every transaction in it is **complete**, deliberately. A dated record that never reaches an
 * amount and a direction fails the whole import (all-or-nothing), so it cannot live in the
 * fixture that proves a successful one; that case is built inline by the tests that assert the
 * refusal.
 */
const IDFC_PDF_LINES: readonly string[] = [
  'IDFC FIRST Bank',
  'Credit Card Statement',
  'FIRST WOW! Credit Card',
  'Card Number XXXX XXXX XXXX 0000',
  'Statement Period 01/07/2026 to 31/07/2026',
  'Total Amount Due 3,289.50',
  'Minimum Amount Due 250.00',
  'Payment Due Date 18/08/2026',
  'YOUR TRANSACTIONS',
  'Date Transaction Details Amount (INR)',
  '02/07/2026 UPICC/301234567890/SAMPLE CAFE 1,240.00 DR',
  '04/07/2026 UPICC/301234567891/SYNTHETIC GROCERS ORDER WITH A NARRATION LONG',
  'ENOUGH TO WRAP ONTO THE NEXT PRINTED LINE 2,499.50 DR',
  '07/07/2026 REFUND SAMPLE ELECTRONICS 450.00 CR',
  '12/07/2026 IMPS/507012345678/PAYMENT RECEIVED THANK YOU 1,000.00 CR',
  'Pay via our Mobile App',
  '15/07/2026 THIS FOOTER LINE IS NOT A TRANSACTION 9,999.00 DR',
];

writeFileSync(join(OUT_DIR, 'sbi-bank-statement.xlsx'), buildWorkbook(SHEET_ROWS));
writeFileSync(join(OUT_DIR, 'bank-statement.pdf'), buildPdf());
writeFileSync(
  join(OUT_DIR, 'idfc-first-credit-card-statement.pdf'),
  buildTextPdf(IDFC_PDF_LINES, { pages: 2 }),
);
console.log(
  'Wrote fixtures/statements/sbi-bank-statement.xlsx, bank-statement.pdf and ' +
    'idfc-first-credit-card-statement.pdf',
);
