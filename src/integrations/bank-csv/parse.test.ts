import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BANK_STATEMENT_CSV_HEADER, parseBankStatementCsv } from './parse.js';

/**
 * The parser turns source text into source values. It interprets **format** — what a column
 * means, how a date is written, which reference convention this bank uses — and nothing else.
 * It never decides what a payment was *for*; that is Phase 8's job and must not leak here.
 */

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

function ok(text: string) {
  const result = parseBankStatementCsv(text);
  if (!result.ok)
    throw new Error(`expected a successful parse, got ${JSON.stringify(result.errors)}`);
  return result.rows;
}

function errors(text: string) {
  const result = parseBankStatementCsv(text);
  if (result.ok) throw new Error('expected the parse to fail');
  return result.errors;
}

const HEADER = BANK_STATEMENT_CSV_HEADER;

describe('parsing the synthetic bank statement fixture', () => {
  it('reads every data row', () => {
    expect(ok(FIXTURE)).toHaveLength(8);
  });

  it('reads the first row exactly as the source wrote it', () => {
    const [row] = ok(FIXTURE);

    expect(row).toEqual({
      lineNumber: 2,
      occurredAt: new Date('2026-07-01T00:00:00.000Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      amount: 124000n,
      direction: 'debit',
      externalReference: 'UPI/2607011234/BLINKIT',
      referenceType: 'upi_utr',
    });
  });

  it('converts rupees to exact paise, never through a float', () => {
    expect(ok(FIXTURE).map((row) => row.amount)).toEqual([
      124000n,
      1500000n,
      1500000n,
      284000n,
      45000n,
      100000n,
      210000n,
      124000n,
    ]);
  });

  it('reads both debit and credit rows', () => {
    const directions = ok(FIXTURE).map((row) => row.direction);

    expect(directions).toContain('debit');
    expect(directions).toContain('credit');
    expect(directions.filter((d) => d === 'credit')).toHaveLength(2);
  });

  it('dates every row at UTC midnight, so the parse never depends on the local zone', () => {
    for (const row of ok(FIXTURE)) {
      expect(row.occurredAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });

  it('preserves the raw description verbatim, including its noise', () => {
    const descriptions = ok(FIXTURE).map((row) => row.rawDescription);

    expect(descriptions).toContain('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    expect(descriptions).toContain('NEFT TRANSFER TO SELF A/C X4821');
  });

  it('numbers rows by their line in the file, so an error can be pointed at', () => {
    expect(ok(FIXTURE).map((row) => row.lineNumber)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is deterministic — the same text parses identically every time', () => {
    expect(
      JSON.stringify(ok(FIXTURE), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).toBe(
      JSON.stringify(ok(FIXTURE), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  });
});

describe('external reference extraction (ADR-0010)', () => {
  it('keeps the reference verbatim', () => {
    expect(ok(FIXTURE).map((row) => row.externalReference)).toEqual([
      'UPI/2607011234/BLINKIT',
      'NEFT/N072026001',
      'NEFT/N072026001',
      'UPI/2607031122/ZOMATO',
      'ACH/REF9981',
      'UPI/2607071500/P2P',
      'BBPS/EB220711',
      'UPI/2607121234/BLINKIT',
    ]);
  });

  it('classifies the reference by this format’s own prefix convention', () => {
    expect(ok(FIXTURE).map((row) => row.referenceType)).toEqual([
      'upi_utr',
      'bank_reference',
      'bank_reference',
      'upi_utr',
      'bank_reference',
      'upi_utr',
      'bank_reference',
      'upi_utr',
    ]);
  });

  it('falls back to "other" for a prefix it does not recognise, rather than guessing', () => {
    const [row] = ok(`${HEADER}\n2026-07-01,SOMETHING,10.00,DEBIT,WEIRD-FORMAT-99`);

    expect(row?.referenceType).toBe('other');
    expect(row?.externalReference).toBe('WEIRD-FORMAT-99');
  });

  it('records no reference at all when the column is blank', () => {
    const [row] = ok(`${HEADER}\n2026-07-01,SOMETHING,10.00,DEBIT,`);

    expect(row?.externalReference).toBeNull();
    expect(row?.referenceType).toBeNull();
  });
});

describe('malformed rows are reported, never silently dropped', () => {
  it('rejects an unparseable date', () => {
    const [error] = errors(`${HEADER}\n01-07-2026,SOMETHING,10.00,DEBIT,REF`);

    expect(error).toMatchObject({ lineNumber: 2, column: 'date' });
    expect(error?.message).toMatch(/YYYY-MM-DD/);
  });

  it('rejects a calendar date that does not exist', () => {
    expect(errors(`${HEADER}\n2026-02-30,SOMETHING,10.00,DEBIT,REF`)[0]).toMatchObject({
      column: 'date',
    });
  });

  it('rejects an amount with more precision than paise', () => {
    expect(errors(`${HEADER}\n2026-07-01,SOMETHING,10.005,DEBIT,REF`)[0]).toMatchObject({
      column: 'amount_inr',
    });
  });

  it('rejects a non-numeric amount', () => {
    expect(errors(`${HEADER}\n2026-07-01,SOMETHING,abc,DEBIT,REF`)[0]).toMatchObject({
      column: 'amount_inr',
    });
  });

  it('rejects a zero or negative amount — a payment moved money', () => {
    expect(errors(`${HEADER}\n2026-07-01,SOMETHING,0.00,DEBIT,REF`)[0]).toMatchObject({
      column: 'amount_inr',
    });
    expect(errors(`${HEADER}\n2026-07-01,SOMETHING,-10.00,DEBIT,REF`)[0]).toMatchObject({
      column: 'amount_inr',
    });
  });

  it('rejects an unknown direction', () => {
    expect(errors(`${HEADER}\n2026-07-01,SOMETHING,10.00,SIDEWAYS,REF`)[0]).toMatchObject({
      column: 'type',
    });
  });

  it('rejects an empty description — the raw line is the evidence', () => {
    expect(errors(`${HEADER}\n2026-07-01,,10.00,DEBIT,REF`)[0]).toMatchObject({
      column: 'description',
    });
  });

  it('rejects a row with the wrong number of columns', () => {
    expect(errors(`${HEADER}\n2026-07-01,SOMETHING,10.00,DEBIT`)[0]).toMatchObject({
      lineNumber: 2,
    });
  });

  it('reports every bad row, not just the first', () => {
    const found = errors(
      `${HEADER}\n2026-07-01,A,bad,DEBIT,REF\n2026-07-02,B,10.00,SIDEWAYS,REF\n2026-07-03,C,10.00,DEBIT,REF`,
    );

    expect(found).toHaveLength(2);
    expect(found.map((error) => error.lineNumber)).toEqual([2, 3]);
  });

  it('rejects a file whose header is not this format', () => {
    const found = errors('when,what,how much\n2026-07-01,A,10.00');

    expect(found[0]?.lineNumber).toBe(1);
    expect(found[0]?.message).toMatch(/header/i);
  });

  it('rejects a file with no data rows', () => {
    expect(errors(HEADER)[0]?.message).toMatch(/no data rows/i);
  });
});

describe('CSV mechanics', () => {
  it('handles a quoted field containing a comma', () => {
    const [row] = ok(`${HEADER}\n2026-07-01,"SHOP, THE",10.00,DEBIT,REF`);

    expect(row?.rawDescription).toBe('SHOP, THE');
  });

  it('handles an escaped quote inside a quoted field', () => {
    const [row] = ok(`${HEADER}\n2026-07-01,"SAM""S SHOP",10.00,DEBIT,REF`);

    expect(row?.rawDescription).toBe('SAM"S SHOP');
  });

  it('tolerates CRLF line endings', () => {
    expect(ok(`${HEADER}\r\n2026-07-01,SOMETHING,10.00,DEBIT,REF\r\n`)).toHaveLength(1);
  });

  it('ignores a trailing blank line', () => {
    expect(ok(`${HEADER}\n2026-07-01,SOMETHING,10.00,DEBIT,REF\n\n`)).toHaveLength(1);
  });

  it('does not trim meaningful whitespace out of a description', () => {
    const [row] = ok(`${HEADER}\n2026-07-01,"  PADDED  ",10.00,DEBIT,REF`);

    expect(row?.rawDescription).toBe('  PADDED  ');
  });
});

describe('the parser interprets format, never purpose', () => {
  it('assigns no counterparty, category, or classification to any row', () => {
    for (const row of ok(FIXTURE)) {
      expect(row).not.toHaveProperty('counterpartyType');
      expect(row).not.toHaveProperty('category');
      expect(row).not.toHaveProperty('relationshipType');
    }
  });

  it('does not treat a self-transfer description as a transfer', () => {
    // "NEFT TRANSFER TO SELF" is obviously an internal transfer to a human reader. Deciding
    // that is Phase 8's job (counterparty_type = internal_account); the parser must not.
    const rows = ok(FIXTURE);
    const selfTransfer = rows.find((row) => row.rawDescription.includes('TRANSFER TO SELF'));

    expect(selfTransfer).toBeDefined();
    expect(Object.keys(selfTransfer!).sort()).toEqual([
      'amount',
      'direction',
      'externalReference',
      'lineNumber',
      'occurredAt',
      'rawDescription',
      'referenceType',
    ]);
  });
});
