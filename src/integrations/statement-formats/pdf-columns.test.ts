/**
 * The columnar bank-account statement layout: a PDF table read by where each value sits
 * (ADR-0066).
 *
 * **Every document here is synthetic.** The statements are drawn by `buildPlacedTextPdf` from
 * invented rows: fictional names, all-zero reference digits, round amounts. Positions are this
 * file's own choice; only the *shape* of the layout — which columns exist, that cells start a
 * little left of their heading, that a page repeats its furniture — follows the kind of
 * statement the layout exists for. No real statement's text, figures or measurements appear
 * here, and none may (`fixtures/README.md`, the sixth pillar).
 *
 * The refusals matter as much as the reads. A row the reader skipped, read the wrong way round
 * or at the wrong size must stop the import, because the alternative is a statement that
 * imports as a quietly different month.
 */

import { describe, expect, it } from 'vitest';

import {
  BANK_HEADER as HEADER,
  SYNTHETIC_BANK_MOVEMENTS as MOVEMENTS,
  bankOpeningRow as openingRow,
  bankRowLines as rowLines,
  bankStatementPdf as statementPdf,
} from '../../../tests/support/synthetic-bank-statement.js';
import type { BankMovement as Movement } from '../../../tests/support/synthetic-bank-statement.js';
import { buildPlacedTextPdf, buildTextPdf } from '../../../tests/support/synthetic-pdf.js';

import { listStatementFormats, parseStatementFile } from './parse.js';

const FORMAT_ID = 'idfc_first_bank_account_pdf';

async function read(bytes: Uint8Array, formatId = 'auto') {
  return parseStatementFile({ bytes, formatId, filename: 'statement.pdf' });
}

async function readOk(bytes: Uint8Array) {
  const result = await read(bytes);
  if (!result.ok) {
    throw new Error(`expected a read, got: ${result.errors.map((e) => e.message).join(' | ')}`);
  }
  return result;
}

describe('reading the layout', () => {
  it('reads every movement, taking its direction from the column it was printed in', async () => {
    const result = await readOk(statementPdf());

    expect(result.formatId).toBe(FORMAT_ID);
    expect(result.rows.map((row) => row.direction)).toEqual([
      'debit',
      'credit',
      'credit',
      'credit',
      'debit',
    ]);
    expect(result.rows.map((row) => row.amount)).toEqual([
      25000n,
      100000n,
      1234n,
      5000000n,
      123456n,
    ]);
    expect(result.rows.map((row) => row.runningBalance)).toEqual([
      975000n,
      1075000n,
      1076234n,
      6076234n,
      5952778n,
    ]);
    expect(result.rows.map((row) => row.occurredAt.toISOString().slice(0, 10))).toEqual([
      '2026-01-02',
      '2026-01-02',
      '2026-01-03',
      '2026-01-05',
      '2026-01-05',
    ]);
  });

  it('joins a description that wraps over several lines, and keeps the reference out of it', async () => {
    const result = await readOk(statementPdf());

    expect(result.rows.map((row) => row.rawDescription)).toEqual([
      'UPI/SYNTHETIC GROCER/000000000001',
      'IMPS/P2A/000000000002/SYNTH PERSON',
      'Int.Pd:SYNTHETIC',
      'NEFT SYNTHETIC EMPLOYER SALARY CREDIT',
      'UPI/SYNTH BILLER/000000000005',
    ]);
  });

  it('takes the reference from the reference column, typed by what it says it is', async () => {
    const result = await readOk(statementPdf());

    expect(result.rows.map((row) => [row.externalReference, row.referenceType])).toEqual([
      ['UPI-000000000001', 'upi_utr'],
      ['IMPS-000000000002', 'bank_reference'],
      // A row with nothing in the reference column has no reference — never one lifted out of
      // its narration, which here would be a merchant handle or an interest note.
      [null, null],
      ['000000000004', 'bank_reference'],
      ['UPI-000000000005', 'upi_utr'],
    ]);
  });

  it('reads a second page that repeats the header, and one that does not', async () => {
    for (const headerOnEveryPage of [true, false]) {
      const result = await readOk(statementPdf({ firstPageRows: 2, headerOnEveryPage }));
      expect(result.rows).toHaveLength(5);
      expect(result.rows[4]?.rawDescription).toBe('UPI/SYNTH BILLER/000000000005');
    }
  });

  it("joins a row the page broke in two, across the next page's furniture", async () => {
    // The fourth row's second description line — and with it the reference and the money — is
    // drawn at the top of the next page, below that page's own headings.
    const result = await readOk(
      statementPdf({ splitRow: { index: 3, afterLines: 1 }, firstPageRows: 3 }),
    );

    expect(result.rows).toHaveLength(5);
    expect(result.rows[3]).toMatchObject({
      rawDescription: 'NEFT SYNTHETIC EMPLOYER SALARY CREDIT',
      externalReference: '000000000004',
      direction: 'credit',
      amount: 5000000n,
    });
  });

  it('stops at the statement summary instead of reading it into the last row', async () => {
    const result = await readOk(statementPdf({ withSummary: true }));

    expect(result.rows).toHaveLength(5);
    expect(result.rows[4]).toMatchObject({
      rawDescription: 'UPI/SYNTH BILLER/000000000005',
      amount: 123456n,
      direction: 'debit',
    });
  });

  it('reads a current account the same way as a savings account', async () => {
    const result = await readOk(statementPdf({ title: 'Current' }));
    expect(result.formatId).toBe(FORMAT_ID);
    expect(result.rows).toHaveLength(5);
  });

  it('accepts a day the bank balanced in a different order from the one it printed, and says so', async () => {
    // A payment and its same-day reversal, printed debit-first while the balance column was
    // worked out credit-first. Row by row that looks backwards; the day closes exactly.
    const movements: Movement[] = [
      ...MOVEMENTS,
      {
        date: '06 Jan 2026',
        description: ['UPI/SYNTH SHOP/000000000006'],
        reference: 'UPI-000000000006',
        debit: '300.00',
        balance: '59,827.78',
      },
      {
        date: '06 Jan 2026',
        description: ['REV-UPI/SYNTH SHOP/000000000006'],
        reference: 'UPI-000000000006',
        credit: '300.00',
        balance: '59,527.78',
      },
    ];
    const result = await readOk(statementPdf({ movements }));

    expect(result.rows.slice(5).map((row) => row.direction)).toEqual(['debit', 'credit']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/2 rows/);
    expect(result.warnings[0]?.message).toMatch(/every day/i);
  });

  it('says nothing when every row follows the row before it', async () => {
    const result = await readOk(statementPdf());
    expect(result.warnings).toEqual([]);
  });

  it('is offered as a bank-account layout, and only as one', () => {
    const format = listStatementFormats().find((candidate) => candidate.id === FORMAT_ID);
    expect(format).toMatchObject({
      container: 'pdf_text',
      accountKind: 'bank',
      carriesRunningBalance: true,
    });
    // Formats that cannot tell what kind of account they came from do not claim one.
    expect(
      listStatementFormats().find((candidate) => candidate.id === 'generic_bank_csv')?.accountKind,
    ).toBeNull();
  });
});

describe('refusing rather than importing a different month', () => {
  function withRow(index: number, change: Partial<Movement>): Movement[] {
    return MOVEMENTS.map((movement, position) =>
      position === index ? { ...movement, ...change } : movement,
    );
  }

  async function refusal(bytes: Uint8Array) {
    const result = await read(bytes);
    if (result.ok) throw new Error('expected a refusal');
    return result;
  }

  it('refuses a statement whose printed balance does not close a day', async () => {
    // One paisa off: the day it sits on cannot close, so something on it was misread.
    const result = await refusal(statementPdf({ movements: withRow(2, { balance: '10,762.35' }) }));
    expect(result.formatId).toBe(FORMAT_ID);
    expect(result.errors[0]?.message).toMatch(/balance/i);
  });

  it('refuses a row with money in both the withdrawal and the deposit column', async () => {
    const result = await refusal(statementPdf({ movements: withRow(0, { credit: '250.00' }) }));
    expect(result.errors[0]?.message).toMatch(/both/i);
  });

  it('refuses a row with no amount at all', async () => {
    // The third row keeps its date, description and balance; only the money is gone.
    const movements = MOVEMENTS.map((movement, index): Movement =>
      index === 2
        ? { date: movement.date, description: movement.description, balance: movement.balance }
        : movement,
    );
    const result = await refusal(statementPdf({ movements }));
    expect(result.errors[0]?.message).toMatch(/amount/i);
  });

  it('refuses a date the calendar does not have', async () => {
    const result = await refusal(statementPdf({ movements: withRow(2, { date: '31 Feb 2026' }) }));
    expect(result.errors[0]?.message).toMatch(/date/i);
  });

  it('refuses a statement whose row numbers skip one', async () => {
    const result = await refusal(statementPdf({ movements: withRow(3, { serial: '5' }) }));
    expect(result.errors[0]?.message).toMatch(/row/i);
  });

  it('refuses a statement with no opening balance to check its first day against', async () => {
    const result = await refusal(statementPdf({ opening: null }));
    expect(result.errors[0]?.message).toMatch(/opening balance/i);
  });

  it('refuses a negative amount rather than guessing which way it went', async () => {
    const result = await refusal(statementPdf({ movements: withRow(0, { debit: '-250.00' }) }));
    expect(result.errors[0]?.message).toMatch(/negative/i);
  });

  it('never quotes the statement in an error', async () => {
    const result = await refusal(statementPdf({ movements: withRow(0, { credit: '250.00' }) }));
    for (const error of result.errors) {
      expect(error.message).not.toMatch(/SYNTH/);
      expect(error.rawValue).toBeNull();
    }
  });
});

describe('recognising the layout', () => {
  it('does not claim a card statement', async () => {
    const card = buildTextPdf([
      'IDFC FIRST Bank',
      'Credit Card Statement',
      'FIRST WOW! Credit Card',
      'YOUR TRANSACTIONS',
      '01/07/2026 SYNTHETIC CAFE 250.00 DR',
      'Pay via our Mobile App',
    ]);
    const result = await read(card);
    expect(result.formatId).toBe('idfc_first_credit_card_pdf');
  });

  it('does not read a table that never names itself an account statement', async () => {
    // The same columns without the section title are some other document: nothing here may
    // decide it is this bank's account statement on the strength of a table header alone.
    const bytes = buildPlacedTextPdf([
      [HEADER, openingRow('10,000.00'), ...rowLines(MOVEMENTS[0]!, 1)],
    ]);
    const result = await read(bytes);
    expect(result.ok).toBe(false);
    expect(result.formatId).not.toBe(FORMAT_ID);
  });

  it('can be named explicitly instead of detected', async () => {
    const result = await read(statementPdf(), FORMAT_ID);
    expect(result.ok).toBe(true);
    expect(result.formatId).toBe(FORMAT_ID);
  });
});
