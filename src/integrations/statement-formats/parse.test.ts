/**
 * The statement-format adapters, against the synthetic files in `fixtures/statements/`.
 *
 * Every assertion here is about *what the source said* — the date, the narration, the exact
 * paise, the direction, the reference — because that is the whole of what an adapter is
 * allowed to produce. There is deliberately no test that a row was classified, because there
 * is no field on `StatementRow` that could carry a classification.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listStatementFormats, parseStatement } from './parse.js';
import { extractPdfText } from './pdf-text.js';
import { parseStatementAmount, parseStatementDate, splitDelimitedLine } from './table.js';
import { readXlsxFirstSheet, XlsxReadError } from './xlsx.js';

const FIXTURES = join(process.cwd(), 'fixtures', 'statements');

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function parseFixture(name: string, formatId = 'auto') {
  return parseStatement({ bytes: load(name), formatId, filename: name });
}

describe('parseStatementAmount', () => {
  it('reads Indian and Western grouping, symbols and markers into exact paise', () => {
    expect(parseStatementAmount('1,23,456.78')?.magnitude).toBe(12345678n);
    expect(parseStatementAmount('123,456.78')?.magnitude).toBe(12345678n);
    expect(parseStatementAmount('₹ 1,240.00')?.magnitude).toBe(124000n);
    expect(parseStatementAmount('Rs. 860.50')?.magnitude).toBe(86050n);
    expect(parseStatementAmount('INR 12,499')?.magnitude).toBe(1249900n);
  });

  it('never rounds through a float', () => {
    // Number('1234.56') * 100 is 123455.99999999999. Exactness is invariants.md #12.
    expect(parseStatementAmount('1234.56')?.magnitude).toBe(123456n);
    expect(parseStatementAmount('0.07')?.magnitude).toBe(7n);
  });

  it('reads a sign from a minus, brackets or a Dr marker', () => {
    expect(parseStatementAmount('-450.00')).toEqual({ magnitude: 45000n, negative: true });
    expect(parseStatementAmount('(450.00)')).toEqual({ magnitude: 45000n, negative: true });
    expect(parseStatementAmount('450.00 Dr')).toEqual({ magnitude: 45000n, negative: true });
    expect(parseStatementAmount('450.00 Cr')).toEqual({ magnitude: 45000n, negative: false });
  });

  it('returns null for a blank cell, which is how a debit/credit layout says "not this one"', () => {
    expect(parseStatementAmount('')).toBeNull();
    expect(parseStatementAmount('   ')).toBeNull();
    expect(parseStatementAmount('n/a')).toBeNull();
  });
});

describe('parseStatementDate', () => {
  it('reads each declared layout at UTC midnight', () => {
    expect(parseStatementDate('2026-07-01', ['yyyy-mm-dd'])?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(parseStatementDate('01/07/2026', ['dd/mm/yyyy'])?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(parseStatementDate('01/07/26', ['dd/mm/yy'])?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(parseStatementDate('01 Jul 2026', ['dd mon yyyy'])?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(parseStatementDate('01-Jul-26', ['dd-mon-yy'])?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('refuses an impossible date rather than rolling it over', () => {
    expect(parseStatementDate('31/02/2026', ['dd/mm/yyyy'])).toBeNull();
    expect(parseStatementDate('2026-13-01', ['yyyy-mm-dd'])).toBeNull();
  });
});

describe('splitDelimitedLine', () => {
  it('keeps a delimiter that is inside a quoted narration', () => {
    expect(splitDelimitedLine('a,"UPI-SAMPLE CAFE, ANDHERI",c', ',')).toEqual([
      'a',
      'UPI-SAMPLE CAFE, ANDHERI',
      'c',
    ]);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(splitDelimitedLine('"say ""hi""",b', ',')).toEqual(['say "hi"', 'b']);
  });
});

describe('bank CSV formats', () => {
  it('reads an HDFC statement past its preamble, with two-column direction', () => {
    const result = parseFixture('hdfc-bank-statement.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.formatId).toBe('hdfc_bank_csv');
    expect(result.rows).toHaveLength(4);

    const [first] = result.rows;
    expect(first?.occurredAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(first?.rawDescription).toBe('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    expect(first?.amount).toBe(124000n);
    expect(first?.direction).toBe('debit');
    expect(first?.externalReference).toBe('UPI/2607011234/BLINKIT');
    expect(first?.referenceType).toBe('upi_utr');
    expect(first?.runningBalance).toBe(4812000n);

    const refund = result.rows[2];
    expect(refund?.direction).toBe('credit');
    expect(refund?.amount).toBe(45000n);

    // The quoted narration with a comma in it survives intact.
    expect(result.rows[3]?.rawDescription).toBe('UPI-SAMPLE CAFE, ANDHERI-PAYTM');
    expect(result.rows[3]?.amount).toBe(86050n);
  });

  it('reads an ICICI statement, preferring the transaction date over the value date', () => {
    const result = parseFixture('icici-bank-statement.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('icici_bank_csv');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[1]?.direction).toBe('credit');
    expect(result.rows[1]?.amount).toBe(8500000n);
    expect(result.rows[2]?.externalReference).toBe('000117');
    expect(result.rows[2]?.referenceType).toBe('bank_reference');
  });

  it('reads an SBI statement with `dd Mon yyyy` dates', () => {
    const result = parseFixture('sbi-bank-statement.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('sbi_bank_csv');
    expect(result.rows[0]?.occurredAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(result.rows[1]?.direction).toBe('credit');
  });

  it('reads an Axis statement with DR/CR columns', () => {
    const result = parseFixture('axis-bank-statement.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('axis_bank_csv');
    expect(result.rows[0]?.direction).toBe('debit');
    expect(result.rows[1]?.direction).toBe('credit');
    expect(result.rows[1]?.amount).toBe(90000n);
  });

  it('reads a card statement, where a credit is a refund rather than new spend', () => {
    const result = parseFixture('card-statement.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('card_statement_csv');
    expect(result.rows[0]?.amount).toBe(1249900n);
    expect(result.rows[0]?.direction).toBe('debit');
    expect(result.rows[1]?.direction).toBe('credit');
    expect(result.rows[1]?.referenceType).toBe('card_reference');
  });

  it('reads a UPI app export, and treats a UTR column as the reference', () => {
    const result = parseFixture('upi-app-export.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('upi_app_export_csv');
    expect(result.rows[0]?.externalReference).toBe('260701123456');
    expect(result.rows[0]?.referenceType).toBe('upi_utr');
    expect(result.rows[1]?.direction).toBe('credit');
    // "Paid" is one of the debit words this format declares.
    expect(result.rows[2]?.direction).toBe('debit');
  });
});

describe('refusals', () => {
  it('refuses the whole file when one row has an unreadable direction', () => {
    const text =
      'Date,Transaction Details,Type,Amount,UTR\n' +
      '01/07/2026,Paid to X,DEBIT,100.00,260701123456\n' +
      '02/07/2026,Something,MAYBE,200.00,260702123456\n';
    const result = parseStatement({
      bytes: new TextEncoder().encode(text),
      formatId: 'upi_app_export_csv',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.lineNumber).toBe(3);
    expect(result.errors[0]?.message).toContain('not a direction this format recognises');
  });

  it('refuses a row that fills both the debit and the credit column', () => {
    const text =
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n' +
      '01/07/26,BOTH,REF,01/07/26,100.00,200.00,1.00\n';
    const result = parseStatement({
      bytes: new TextEncoder().encode(text),
      formatId: 'hdfc_bank_csv',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('does not say which');
  });

  it('refuses a file whose columns match no format rather than guessing one', () => {
    const result = parseStatement({
      bytes: new TextEncoder().encode('alpha,beta,gamma\n1,2,3\n'),
      formatId: 'auto',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('No supported format matched');
  });

  it('names an unknown format id rather than falling back to a default', () => {
    const result = parseStatement({
      bytes: new TextEncoder().encode('date,description,amount_inr,type,reference\n'),
      formatId: 'not_a_format',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('not a statement format');
  });

  it('skips opening/closing-balance lines as presentation, not movements', () => {
    const text =
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n' +
      '01/07/26,Opening Balance,,01/07/26,0.00,0.00,100.00\n' +
      '02/07/26,REAL MOVEMENT,REF,02/07/26,50.00,0.00,50.00\n' +
      '03/07/26,Closing Balance,,03/07/26,0.00,0.00,50.00\n';
    const result = parseStatement({
      bytes: new TextEncoder().encode(text),
      formatId: 'hdfc_bank_csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rawDescription).toBe('REAL MOVEMENT');
  });
});

describe('xlsx', () => {
  it('reads a workbook statement into the same rows as its CSV twin', () => {
    const result = parseFixture('sbi-bank-statement.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('sbi_bank_csv');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]?.amount).toBe(124000n);
    expect(result.rows[0]?.direction).toBe('debit');
    expect(result.rows[2]?.direction).toBe('credit');
    expect(result.rows[2]?.amount).toBe(45000n);
  });

  it('reads shared strings and blank cells positionally', () => {
    const sheet = readXlsxFirstSheet(load('sbi-bank-statement.xlsx'));
    expect(sheet.rows[0]?.[0]).toBe('Txn Date');
    expect(sheet.rows[0]?.[6]).toBe('Balance');
    // The debit cell on the credit row is genuinely empty, not the previous row's value.
    expect(sheet.rows[2]?.[4]).toBe('');
  });

  it('reports bytes that are not a workbook rather than reading zero rows', () => {
    expect(() => readXlsxFirstSheet(new Uint8Array([1, 2, 3, 4]))).toThrow(XlsxReadError);
  });
});

describe('pdf', () => {
  it('lifts the text layer off a generated statement and reads its movements', () => {
    const result = parseFixture('bank-statement.pdf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('pdf_debit_credit_balance');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]?.amount).toBe(124000n);
    expect(result.rows[0]?.direction).toBe('debit');
    expect(result.rows[0]?.externalReference).toBe('UPI/2607011234/BLINKIT');
    expect(result.rows[2]?.direction).toBe('credit');
    expect(result.rows[2]?.amount).toBe(45000n);
    // A PDF has no columns, so the caller is told the count is what matched, not what exists.
    expect(result.warnings[0]?.message).toContain('check the count against the statement');
  });

  it('says a scanned PDF has no text layer instead of reporting no transactions', () => {
    // A PDF header with no content stream at all — the shape of an image-only scan as far as
    // text extraction is concerned.
    const bytes = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
    const text = extractPdfText(bytes);
    expect(text.hasTextLayer).toBe(false);
    expect(text.reason).toContain('no extractable text layer');

    const result = parseStatement({ bytes, formatId: 'auto' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('no extractable text layer');
  });

  it('is not fooled into reading a header or a footer line as a movement', () => {
    const result = parseFixture('bank-statement.pdf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const row of result.rows) {
      expect(row.rawDescription).not.toContain('SYNTHETIC BANK');
      expect(row.rawDescription).not.toContain('Closing balance');
    }
  });
});

describe('listStatementFormats', () => {
  it('names every format this build reads, including the PDF layouts', () => {
    const ids = listStatementFormats().map((format) => format.id);
    expect(ids).toContain('hdfc_bank_csv');
    expect(ids).toContain('upi_app_export_csv');
    expect(ids).toContain('pdf_debit_credit_balance');
    // The one format detection may not choose on its own is still offered explicitly.
    const signed = listStatementFormats().find((format) => format.id === 'signed_amount_csv');
    expect(signed?.detectable).toBe(false);
  });
});
