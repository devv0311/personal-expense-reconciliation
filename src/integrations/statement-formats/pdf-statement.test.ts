/**
 * The PDF.js statement reader and the IDFC FIRST credit-card layout it exists for.
 *
 * `parse.test.ts` covers the declared formats through the synchronous `parseStatement`, which
 * reads a PDF with the dependency-free reader. This file covers the asynchronous
 * `parseStatementFile` that `services.importStatement` actually calls, because that one reads
 * a PDF with PDF.js — the reader that can decode the embedded font maps and object streams a
 * real issuer's generated statement uses.
 *
 * **Every document here is synthetic**, built by `tests/support/synthetic-pdf.ts`. No real
 * statement, card number, merchant or amount appears in this file, and none may
 * (`fixtures/README.md`, the sixth pillar).
 *
 * The assertions are about what the *source said* and, just as deliberately, about what it did
 * not say: a dated line that never reached an amount is reported as unread rather than turned
 * into a movement, and a decode failure is a stated reason rather than an empty statement.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTextPdf } from '../../../tests/support/synthetic-pdf.js';

import { parseStatementFile } from './parse.js';
import { extractPdfTextWithPdfJs } from './pdf-text.js';

const FIXTURES = join(process.cwd(), 'fixtures', 'statements');

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** The shape of an IDFC statement's own lines, without committing another binary fixture. */
const IDFC_PREAMBLE = [
  'IDFC FIRST Bank',
  'Credit Card Statement',
  'FIRST WOW! Credit Card',
  'Statement Period 01/07/2026 to 31/07/2026',
];

function idfcPdf(...transactionLines: string[]): Uint8Array {
  return buildTextPdf([
    ...IDFC_PREAMBLE,
    'YOUR TRANSACTIONS',
    ...transactionLines,
    'Pay via our Mobile App',
  ]);
}

async function parsePdf(bytes: Uint8Array, formatId = 'auto') {
  return parseStatementFile({ bytes, formatId, filename: 'statement.pdf' });
}

describe('extractPdfTextWithPdfJs', () => {
  it('lifts a generated PDF text layer, in document order, across pages', async () => {
    const result = await extractPdfTextWithPdfJs(
      buildTextPdf(['first line', 'second line', 'third line', 'fourth line'], { pages: 2 }),
    );
    expect(result.hasTextLayer).toBe(true);
    expect(result.lines).toEqual(['first line', 'second line', 'third line', 'fourth line']);
  });

  it('reads the encodings the dependency-free reader exists beside', async () => {
    // The whole reason PDF.js was added: the fixture the bounded reader already reads must
    // read identically here, so the two are not two different answers to the same document.
    const result = await extractPdfTextWithPdfJs(fixture('bank-statement.pdf'));
    expect(result.hasTextLayer).toBe(true);
    expect(result.lines.some((line) => line.startsWith('01/07/2026'))).toBe(true);
  });

  it('says bytes that are not a PDF are not a PDF, without trying to decode them', async () => {
    const result = await extractPdfTextWithPdfJs(new TextEncoder().encode('date,amount\n1,2\n'));
    expect(result.hasTextLayer).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.reason).toContain('%PDF-');
  });

  it('reports a PDF with no text layer as unreadable, never as a statement with no rows', async () => {
    const result = await extractPdfTextWithPdfJs(
      buildTextPdf(['drawn as an image'], { withoutTextLayer: true }),
    );
    expect(result.hasTextLayer).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.reason).toContain('no extractable text layer');
  });

  it('refuses a malformed PDF with a reason instead of throwing', async () => {
    const truncated = fixture('bank-statement.pdf').slice(0, 200);
    const result = await extractPdfTextWithPdfJs(truncated);
    expect(result.hasTextLayer).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.reason).not.toBe(undefined);
  });

  it('never quotes the document into the reason it reports', async () => {
    // A decode error can carry a fragment of the content it failed on, and that fragment is
    // somebody's statement. The reasons are fixed sentences for exactly that reason.
    const result = await extractPdfTextWithPdfJs(
      new Uint8Array([
        ...new TextEncoder().encode('%PDF-1.4\n'),
        ...new TextEncoder().encode('MERCHANT SECRET 4821'),
      ]),
    );
    expect(result.hasTextLayer).toBe(false);
    expect(result.reason).not.toContain('MERCHANT');
    expect(result.reason).not.toContain('4821');
  });

  it('refuses a file larger than the local reader permits, before decoding any of it', async () => {
    const oversized = new Uint8Array(65 * 1024 * 1024);
    oversized.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
    const result = await extractPdfTextWithPdfJs(oversized);
    expect(result.hasTextLayer).toBe(false);
    expect(result.reason).toContain('limited to 64 MB');
  });

  it('makes no network request while reading a document', async () => {
    // ADR-0051's ordering is a privacy decision: a document that can be read locally never
    // reaches a provider. PDF.js is configured with nothing to fetch — no `cMapUrl`, no
    // `standardFontDataUrl`, `useWorkerFetch: false` — and this asserts the configuration
    // rather than trusting it, because a default that changed in a future release would
    // otherwise send a statement's font requests off the machine silently.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await extractPdfTextWithPdfJs(fixture('idfc-first-credit-card-statement.pdf'));
    expect(result.hasTextLayer).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves the caller’s evidence bytes untouched', async () => {
    // PDF.js may transfer the buffer it is given to its worker. Evidence is immutable, so the
    // reader copies rather than handing over the array it was called with.
    const bytes = buildTextPdf(['a line']);
    const before = bytes.slice();
    await extractPdfTextWithPdfJs(bytes);
    expect(bytes).toEqual(before);
  });
});

describe('the IDFC FIRST credit-card PDF layout', () => {
  it('reads the committed synthetic statement, wrapped narration and all', async () => {
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.formatId).toBe('idfc_first_credit_card_pdf');
    expect(result.rows).toHaveLength(4);

    const [first, wrapped, refund, payment] = result.rows;

    expect(first?.occurredAt.toISOString()).toBe('2026-07-02T00:00:00.000Z');
    expect(first?.rawDescription).toBe('UPICC/301234567890/SAMPLE CAFE');
    expect(first?.amount).toBe(124000n);
    expect(first?.direction).toBe('debit');

    // The narration the issuer wrapped over two printed lines is one movement, not two, and
    // not a truncated one.
    expect(wrapped?.rawDescription).toBe(
      'UPICC/301234567891/SYNTHETIC GROCERS ORDER WITH A NARRATION LONG ENOUGH TO WRAP ONTO THE NEXT PRINTED LINE',
    );
    expect(wrapped?.amount).toBe(249950n);
    expect(wrapped?.direction).toBe('debit');

    // A card statement's CR is a refund or a payment to the card, never new spend.
    expect(refund?.direction).toBe('credit');
    expect(refund?.amount).toBe(45000n);
    expect(payment?.direction).toBe('credit');
    expect(payment?.amount).toBe(100000n);

    // No PDF layout prints a running balance this parser reads.
    expect(result.rows.every((row) => row.runningBalance === null)).toBe(true);
  });

  it('types a UPI UTR carried by a UPICC narration as a UPI UTR, not the format default', async () => {
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    if (!result.ok) return;
    const [first] = result.rows;
    expect(first?.externalReference).toBe('301234567890');
    expect(first?.referenceType).toBe('upi_utr');
  });

  it('refuses the whole file when a dated line never reaches an amount', async () => {
    // All-or-nothing. Reading the four complete records around this one would leave the ledger
    // short by exactly the unread movement, while the screen reported a successful import.
    const result = await parsePdf(
      idfcPdf(
        '02/07/2026 A COMPLETE PURCHASE 1,240.00 DR',
        '09/07/2026 EMI CONVERSION SAMPLE APPLIANCE',
        '12/07/2026 ANOTHER COMPLETE PURCHASE 1,000.00 DR',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('never reaches an amount and a direction');
    expect(result.errors[0]?.message).toContain('Nothing was imported');
  });

  it('refuses the whole file when a matched record carries an impossible calendar date', async () => {
    // The layout matches `99/99/2026 … 200.00 DR` perfectly well — it is the *conversion* that
    // fails. Skipping it would import one row and report success for a two-transaction file.
    const result = await parsePdf(
      idfcPdf('02/07/2026 A GOOD PURCHASE 100.00 DR', '99/99/2026 BAD DATE PURCHASE 200.00 DR'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('not a real calendar date');
  });

  it('refuses a document whose every transaction is invalid, by row, not by format', async () => {
    // The layout recognised this document and read one record in it; the record happens to be
    // unreadable. "None of its lines matched a statement layout" would be a claim about the
    // *format* — a different fact with a different fix, and it would hide a locatable defect
    // behind a message about an unsupported bank.
    const result = await parsePdf(idfcPdf('99/99/2026 BAD DATE PURCHASE 200.00 DR'));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.formatId).toBe('idfc_first_credit_card_pdf');
    expect(result.errors).toHaveLength(1);
    // Line 6: four preamble lines, the section heading, then the record itself.
    expect(result.errors[0]?.lineNumber).toBe(6);
    expect(result.errors[0]?.message).toContain('not a real calendar date');
    expect(result.errors[0]?.message).not.toContain('none of its lines matched');
  });

  it('refuses a document whose only record never completes, by row, not by format', async () => {
    const result = await parsePdf(idfcPdf('02/07/2026 A RECORD THAT NEVER COMPLETES'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.formatId).toBe('idfc_first_credit_card_pdf');
    expect(result.errors[0]?.message).toContain('never reaches an amount and a direction');
  });

  it('still says "no layout matched" when nothing in the document was recognised', async () => {
    // The generic refusal keeps its job: a transactions section with no record-shaped line in
    // it at all is a format this build does not read, not a file with unreadable rows.
    const result = await parsePdf(idfcPdf('No transactions were posted this period'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.lineNumber).toBe(1);
    expect(result.errors[0]?.message).toContain('none of its lines matched');
  });

  it('does not let a generic layout outrank an identified one that only found bad records', async () => {
    // `pdf_amount_with_marker` matches this line's shape too. Recognition evidence must not
    // hand it the document just because the identified layout converted nothing.
    const result = await parsePdf(idfcPdf('99/99/2026 BAD DATE PURCHASE 200.00 DR'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.formatId).toBe('idfc_first_credit_card_pdf');
    expect(result.formatId).not.toBe('pdf_amount_with_marker');
  });

  it('refuses a matched record whose amount will not read as money', async () => {
    const result = await parsePdf(
      idfcPdf('02/07/2026 A GOOD PURCHASE 100.00 DR', '03/07/2026 A ZERO PURCHASE 0.00 DR'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('amount or direction');
  });

  it('reports unreadable records in line order, whichever way they failed', async () => {
    const result = await parsePdf(
      idfcPdf(
        '99/99/2026 BAD DATE PURCHASE 200.00 DR',
        '03/07/2026 A GOOD PURCHASE 100.00 DR',
        '04/07/2026 A RECORD THAT NEVER COMPLETES',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
    const lines = result.errors.map((error) => error.lineNumber);
    expect(lines).toEqual([...lines].sort((left, right) => (left ?? 0) - (right ?? 0)));
  });

  it('never quotes a rejected record’s own text back, in any failure mode', async () => {
    const result = await parsePdf(idfcPdf('99/99/2026 SECRET MERCHANT 4821 CARDHOLDER 200.00 DR'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialized = JSON.stringify(result.errors);
    expect(serialized).not.toContain('SECRET MERCHANT');
    expect(serialized).not.toContain('4821');
    expect(serialized).not.toContain('CARDHOLDER');
    expect(result.errors.every((error) => error.rawValue === null)).toBe(true);
  });

  it('still skips a line that is not a transaction at all, rather than failing the file', async () => {
    // The distinction that makes the rule usable: presentation text never matched the layout,
    // so it is not a record this build failed to read.
    const result = await parsePdf(
      idfcPdf(
        'Transaction summary for this period',
        '02/07/2026 A GOOD PURCHASE 100.00 DR',
        'Reward points earned 240',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
  });

  it('points at the unreadable line by number, and never quotes what it said', async () => {
    const result = await parsePdf(
      idfcPdf(
        '02/07/2026 A COMPLETE PURCHASE 1,240.00 DR',
        '09/07/2026 EMI CONVERSION SECRET MERCHANT 4821',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.lineNumber).toBe(7);
    expect(result.errors[0]?.rawValue).toBeNull();
    expect(JSON.stringify(result.errors)).not.toContain('SECRET MERCHANT');
    expect(JSON.stringify(result.errors)).not.toContain('4821');
  });

  it('reports every unreadable record at once, so one pass over the file fixes it', async () => {
    const result = await parsePdf(
      idfcPdf(
        '02/07/2026 FIRST INCOMPLETE RECORD',
        '03/07/2026 SECOND INCOMPLETE RECORD',
        '04/07/2026 A COMPLETE PURCHASE 100.00 DR',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
  });

  it('carries no unread-record warning on a file that succeeded, because there cannot be one', async () => {
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.warnings.some((warning) => warning.message.includes('never reached an amount')),
    ).toBe(false);
  });

  it('never reads a dated line printed after the transactions section ended', async () => {
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    if (!result.ok) return;
    expect(result.rows.some((row) => row.amount === 999900n)).toBe(false);
  });

  it('never reads the summary block above the transactions as movements', async () => {
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    if (!result.ok) return;
    expect(result.rows.some((row) => row.rawDescription.includes('Statement Period'))).toBe(false);
    expect(result.rows.some((row) => row.amount === 328950n)).toBe(false);
  });

  it('always says the count is what matched rather than what the statement contains', async () => {
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    if (!result.ok) return;
    expect(result.warnings.some((warning) => warning.message.includes('check the count'))).toBe(
      true,
    );
  });

  it('reads a second transactions block rather than stopping at the first end marker', async () => {
    // A statement that prints per-card sections would otherwise import only the first card.
    const bytes = buildTextPdf([
      ...IDFC_PREAMBLE,
      'YOUR TRANSACTIONS',
      '02/07/2026 FIRST CARD PURCHASE 100.00 DR',
      'Pay via our Mobile App',
      'YOUR TRANSACTIONS',
      '03/07/2026 SECOND CARD PURCHASE 200.00 DR',
      'Pay via our Mobile App',
    ]);
    const result = await parsePdf(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.amount)).toEqual([10000n, 20000n]);
  });

  it('scans the whole document, and says so, when the section heading is absent', async () => {
    const bytes = buildTextPdf([
      ...IDFC_PREAMBLE,
      'TRANSACTION DETAILS FOR THIS PERIOD',
      '02/07/2026 A PURCHASE 100.00 DR',
    ]);
    const result = await parsePdf(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.message.includes('never printed'))).toBe(true);
  });

  it('does not claim an IDFC layout for a PDF that is not an IDFC statement', async () => {
    // The layout identifies the *document* before its line shape is considered. Another issuer
    // printing `date narration amount DR` is still read — by the generic layout that shape
    // already had — but it is never labelled IDFC, because the label is what a later reader
    // would trust when deciding the section markers and wrapping rules applied.
    const bytes = buildTextPdf([
      'SOME OTHER BANK — CARD STATEMENT',
      'YOUR TRANSACTIONS',
      '02/07/2026 A PURCHASE 100.00 DR',
    ]);
    const result = await parsePdf(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).not.toBe('idfc_first_credit_card_pdf');
    expect(result.formatId).toBe('pdf_amount_with_marker');
  });

  it('prefers the layout that identified the document over a generic one matching as many lines', async () => {
    // Both layouts match this document's transaction lines. The generic one would also match
    // the footer line printed *after* the section ended, so "most lines wins" alone would
    // import a movement the statement does not contain.
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const generic = await parseStatementFile({
      bytes: fixture('idfc-first-credit-card-statement.pdf'),
      formatId: 'pdf_amount_with_marker',
      filename: 'statement.pdf',
    });
    expect(generic.ok).toBe(true);
    if (!generic.ok) return;
    expect(generic.rows.some((row) => row.amount === 999900n)).toBe(true);

    // Auto-detection chose the identified layout, and with it the section the issuer scoped.
    expect(result.formatId).toBe('idfc_first_credit_card_pdf');
    expect(result.rows.some((row) => row.amount === 999900n)).toBe(false);
  });

  it('refuses when a named format is asked for and the document is not that document', async () => {
    const bytes = buildTextPdf(['SOME OTHER BANK', '02/07/2026 A PURCHASE 100.00 DR']);
    const result = await parsePdf(bytes, 'idfc_first_credit_card_pdf');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('idfc_first_credit_card_pdf');
  });

  it('joins a narration wrapped over two continuation lines', async () => {
    const result = await parsePdf(
      idfcPdf(
        '02/07/2026 A NARRATION THAT KEEPS',
        'GOING ACROSS A SECOND LINE AND THEN',
        'A THIRD BEFORE ITS AMOUNT 1,500.00 DR',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rawDescription).toBe(
      'A NARRATION THAT KEEPS GOING ACROSS A SECOND LINE AND THEN A THIRD BEFORE ITS AMOUNT',
    );
    expect(result.rows[0]?.amount).toBe(150000n);
  });

  it('abandons a dated line rather than absorbing an unbounded run of following lines', async () => {
    // The bound stops one unfinished record swallowing the rest of the section and matching
    // something by accident at the far end of it. Having abandoned it, the file is refused,
    // because an abandoned record is a movement that was not read.
    const result = await parsePdf(
      idfcPdf(
        '02/07/2026 A NARRATION THAT NEVER COMPLETES',
        ...Array.from({ length: 10 }, (_, index) => `CONTINUATION LINE ${index + 1}`),
        'AND ONLY NOW AN AMOUNT 1,500.00 DR',
        '03/07/2026 A REAL PURCHASE 250.00 DR',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('never reaches an amount');
  });

  it('reads both directions from the marker the issuer prints, in exact paise', async () => {
    const result = await parsePdf(
      idfcPdf(
        '02/07/2026 A DEBIT 1,234.56 DR',
        '03/07/2026 A CREDIT 78,901.07 CR',
        '04/07/2026 A SMALL DEBIT 0.07 DR',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => [row.amount, row.direction])).toEqual([
      [123456n, 'debit'],
      [7890107n, 'credit'],
      [7n, 'debit'],
    ]);
  });

  it('refuses a statement whose transactions section printed nothing it could read', async () => {
    const result = await parsePdf(idfcPdf('No transactions this period'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('Nothing was imported');
  });

  it('refuses a scanned IDFC statement by name instead of importing an empty month', async () => {
    const result = await parsePdf(
      buildTextPdf([...IDFC_PREAMBLE, 'YOUR TRANSACTIONS'], { withoutTextLayer: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('no extractable text layer');
  });
});

describe('one PDF entry point', () => {
  it('refuses a PDF from the synchronous entry point, naming the one that reads it', async () => {
    // Two readers answering differently about one document is a fork, not a fallback. The
    // synchronous path refuses rather than reaching for the weaker reader.
    const { parseStatement } = await import('./parse.js');
    const result = parseStatement({
      bytes: fixture('idfc-first-credit-card-statement.pdf'),
      formatId: 'auto',
      filename: 'statement.pdf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('parseStatementFile()');
  });

  it('reads that same PDF in full through the asynchronous entry point', async () => {
    const result = await parsePdf(fixture('idfc-first-credit-card-statement.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(4);
  });
});

describe('parseStatementFile', () => {
  it('reads a CSV exactly as the synchronous entry point does', async () => {
    const result = await parseStatementFile({
      bytes: fixture('hdfc-bank-statement.csv'),
      formatId: 'auto',
      filename: 'hdfc-bank-statement.csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('hdfc_bank_csv');
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]?.amount).toBe(124000n);
    expect(result.rows[0]?.externalReference).toBe('UPI/2607011234/BLINKIT');
  });

  it('reads an XLSX workbook exactly as the synchronous entry point does', async () => {
    const result = await parseStatementFile({
      bytes: fixture('sbi-bank-statement.xlsx'),
      formatId: 'auto',
      filename: 'sbi-bank-statement.xlsx',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('sbi_bank_csv');
    expect(result.rows).toHaveLength(3);
  });

  it('still reads the generic PDF layout PDF import already supported', async () => {
    const result = await parsePdf(fixture('bank-statement.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formatId).toBe('pdf_debit_credit_balance');
    expect(result.rows).toHaveLength(3);
  });

  it('refuses bytes that are neither a PDF nor a layout it reads, without writing anything', async () => {
    const result = await parseStatementFile({
      bytes: new TextEncoder().encode('nothing,resembling,a,statement\n'),
      formatId: 'auto',
      filename: 'notes.csv',
    });
    expect(result.ok).toBe(false);
  });
});
