/**
 * One parser for every declared statement format, over every supported container.
 *
 * ```
 * bytes ─▶ container reader (delimited | xlsx | pdf_text) ─▶ StatementTable / lines
 *       ─▶ column map from STATEMENT_FORMATS                ─▶ StatementRow[]
 * ```
 *
 * All-or-nothing, like `integrations/bank-csv`: a file with any unreadable row yields **no**
 * rows and reports every bad one, because a partially imported statement leaves the ledger
 * quietly missing movements — which is the exact condition cash reconciliation exists to
 * detect (`invariants.md` #10, ADR-0019).
 *
 * Auto-detection scores each detectable format by how many of its required columns the header
 * actually has, and refuses rather than picking a winner it is not sure of. Guessing a format
 * is guessing which column held the money.
 */

import { paise } from '../../domain/index.js';
import type { Paise, PaymentDirection, PaymentReferenceType } from '../../domain/index.js';

import { PDF_LINE_PATTERNS, STATEMENT_FORMATS } from './formats.js';
import type { PdfLinePattern, StatementFormat } from './formats.js';
import { extractPdfText } from './pdf-text.js';
import {
  detectDelimiter,
  findColumn,
  parseStatementAmount,
  parseStatementDate,
  splitDelimitedLine,
  splitLines,
} from './table.js';
import type { ParsedAmount, StatementTable } from './table.js';
import type {
  StatementFormatDescriptor,
  StatementParseResult,
  StatementRow,
  StatementRowError,
  StatementWarning,
} from './types.js';
import { readXlsxFirstSheet, XlsxReadError } from './xlsx.js';

/** Bumped when a change here would alter how the same file is read. */
export const STATEMENT_PARSER_VERSION = 'statement-formats@1';

/** Every format this build reads, for an import screen to name rather than a person to guess. */
export function listStatementFormats(): readonly StatementFormatDescriptor[] {
  const tabular = STATEMENT_FORMATS.map((format) => ({
    id: format.id,
    label: format.label,
    container: format.container,
    channel: format.channel,
    headerHint: format.headerHint,
    carriesRunningBalance: format.balanceColumns.length > 0,
    detectable: format.detectable,
  }));
  const pdf = PDF_LINE_PATTERNS.map((pattern) => ({
    id: pattern.id,
    label: pattern.label,
    container: 'pdf_text' as const,
    channel: pattern.channel,
    headerHint: pattern.pattern.source,
    carriesRunningBalance: pattern.pattern.source.includes('balance'),
    detectable: true,
  }));
  return [...tabular, ...pdf];
}

export interface ParseStatementInput {
  /** The file's bytes. Text formats are decoded as UTF-8 here, once. */
  readonly bytes: Uint8Array;
  /** A declared format id, or `'auto'` to detect one. */
  readonly formatId: string;
  /** Used only to choose a container when `formatId` is `'auto'`. */
  readonly filename?: string | null;
}

/**
 * Parses one statement.
 *
 * @throws never. Every failure — an unrecognised format, an unreadable workbook, a scanned
 *   PDF, a bad row — comes back as `{ ok: false, errors }`, because each has the same shape
 *   for the caller (report it, import nothing) and a thrown error would make the honest
 *   "this PDF has no text layer" indistinguishable from a bug.
 */
export function parseStatement(input: ParseStatementInput): StatementParseResult {
  const isZip = input.bytes[0] === 0x50 && input.bytes[1] === 0x4b;
  const isPdf = new TextDecoder('latin1').decode(input.bytes.subarray(0, 5)) === '%PDF-';

  if (isPdf) return parsePdfStatement(input.bytes, input.formatId);

  let table: StatementTable;
  if (isZip) {
    try {
      const sheet = readXlsxFirstSheet(input.bytes);
      table = tableFromSheetRows(sheet.rows);
    } catch (error) {
      return {
        ok: false,
        formatId: input.formatId,
        parserVersion: STATEMENT_PARSER_VERSION,
        errors: [
          {
            lineNumber: 1,
            column: null,
            rawValue: null,
            message:
              error instanceof XlsxReadError
                ? error.message
                : `This workbook could not be read: ${error instanceof Error ? error.message : 'unknown failure'}.`,
          },
        ],
      };
    }
  } else {
    table = tableFromDelimitedText(new TextDecoder('utf-8').decode(input.bytes));
  }

  const format =
    input.formatId === 'auto'
      ? detectTabularFormat(table)
      : (STATEMENT_FORMATS.find((candidate) => candidate.id === input.formatId) ?? null);

  if (format === null) {
    return {
      ok: false,
      formatId: input.formatId,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: table.header.join(', '),
          message:
            input.formatId === 'auto'
              ? "No supported format matched this file's columns, so nothing was imported. " +
                `Its header reads: ${table.header.join(', ') || '(empty)'}. Supported formats: ` +
                `${STATEMENT_FORMATS.filter((candidate) => candidate.detectable)
                  .map((candidate) => candidate.id)
                  .join(', ')}. Choose one explicitly if the file is one of them under a ` +
                'different header.'
              : `"${input.formatId}" is not a statement format this build reads.`,
        },
      ],
    };
  }

  return parseTable(table, format);
}

/* --------------------------------------------------------------------------- tabular */

function tableFromDelimitedText(text: string): StatementTable {
  const lines = splitLines(text);
  // A bank's CSV often carries preamble lines (account holder, period) before the header.
  // The header is the first line that looks like one: several fields, at least one of them a
  // column name some format knows. Anything before it is skipped as presentation.
  let headerIndex = 0;
  let delimiter = ',';
  for (let index = 0; index < Math.min(lines.length, 40); index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const candidateDelimiter = detectDelimiter(line);
    const cells = splitDelimitedLine(line, candidateDelimiter);
    if (cells.length >= 3 && looksLikeHeader(cells)) {
      headerIndex = index;
      delimiter = candidateDelimiter;
      break;
    }
  }

  const header = splitDelimitedLine(lines[headerIndex] ?? '', delimiter);
  const rows: { lineNumber: number; cells: readonly string[] }[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    rows.push({ lineNumber: index + 1, cells: splitDelimitedLine(line, delimiter) });
  }
  return { header, rows };
}

function tableFromSheetRows(sheetRows: readonly (readonly string[])[]): StatementTable {
  let headerIndex = 0;
  for (let index = 0; index < Math.min(sheetRows.length, 40); index += 1) {
    const cells = sheetRows[index] ?? [];
    if (cells.filter((cell) => cell.trim() !== '').length >= 3 && looksLikeHeader(cells)) {
      headerIndex = index;
      break;
    }
  }
  const header = [...(sheetRows[headerIndex] ?? [])];
  const rows = sheetRows.slice(headerIndex + 1).map((cells, offset) => ({
    lineNumber: headerIndex + offset + 2,
    cells,
  }));
  return { header, rows };
}

/** True when these cells name at least two columns some declared format asks for. */
function looksLikeHeader(cells: readonly string[]): boolean {
  const known = new Set<string>();
  for (const format of STATEMENT_FORMATS) {
    for (const alias of [
      ...format.dateColumns,
      ...format.descriptionColumns,
      ...format.amountColumns,
      ...format.debitColumns,
      ...format.creditColumns,
      ...format.typeColumns,
      ...format.referenceColumns,
      ...format.balanceColumns,
    ]) {
      known.add(alias.toLowerCase().replace(/[^a-z0-9]+/g, ''));
    }
  }
  const matches = cells.filter((cell) =>
    known.has(
      cell
        .replace(/\([^)]*\)/g, ' ')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ''),
    ),
  );
  return matches.length >= 2;
}

/**
 * Picks the declared format whose columns this header best satisfies.
 *
 * A format only qualifies when every column it *needs* is present — the date, the description,
 * and whichever money columns its direction style requires. Among those, the one matching the
 * most declared columns wins; a tie is refused rather than resolved, because two formats that
 * fit equally well disagree about something and importing under either is a coin flip with
 * somebody's money.
 */
function detectTabularFormat(table: StatementTable): StatementFormat | null {
  const scored: { format: StatementFormat; score: number }[] = [];

  for (const format of STATEMENT_FORMATS) {
    if (!format.detectable) continue;
    const columns = resolveColumns(table.header, format);
    if (columns === null) continue;
    let score = 2; // date + description, both required to get here
    if (columns.debit !== null) score += 1;
    if (columns.credit !== null) score += 1;
    if (columns.amount !== null) score += 1;
    if (columns.type !== null) score += 1;
    if (columns.reference !== null) score += 1;
    if (columns.balance !== null) score += 1;
    scored.push({ format, score });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const runnerUp = scored[1];
  if (runnerUp !== undefined && runnerUp.score === best.score) return null;
  return best.format;
}

interface ResolvedColumns {
  readonly date: number;
  readonly description: number;
  readonly amount: number | null;
  readonly debit: number | null;
  readonly credit: number | null;
  readonly type: number | null;
  readonly reference: number | null;
  readonly balance: number | null;
}

/** The column indices a format needs, or `null` when the header cannot satisfy it. */
function resolveColumns(
  header: readonly string[],
  format: StatementFormat,
): ResolvedColumns | null {
  const date = findColumn(header, format.dateColumns);
  const description = findColumn(header, format.descriptionColumns);
  if (date === null || description === null) return null;

  const amount = findColumn(header, format.amountColumns);
  const debit = findColumn(header, format.debitColumns);
  const credit = findColumn(header, format.creditColumns);
  const type = findColumn(header, format.typeColumns);

  switch (format.direction.kind) {
    case 'debit_credit_columns':
      if (debit === null || credit === null) return null;
      break;
    case 'type_column':
      if (amount === null || type === null) return null;
      break;
    case 'signed_amount':
      if (amount === null) return null;
      break;
  }

  return {
    date,
    description,
    amount,
    debit,
    credit,
    type,
    reference: findColumn(header, format.referenceColumns),
    balance: findColumn(header, format.balanceColumns),
  };
}

function parseTable(table: StatementTable, format: StatementFormat): StatementParseResult {
  const columns = resolveColumns(table.header, format);
  if (columns === null) {
    return {
      ok: false,
      formatId: format.id,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: table.header.join(', '),
          message:
            `This file does not have the columns "${format.label}" needs. Its header reads: ` +
            `${table.header.join(', ') || '(empty)'}. Expected something like: ${format.headerHint}.`,
        },
      ],
    };
  }

  const rows: StatementRow[] = [];
  const errors: StatementRowError[] = [];
  const warnings: StatementWarning[] = [];

  for (const { lineNumber, cells } of table.rows) {
    const description = (cells[columns.description] ?? '').trim();
    if (format.skipDescriptionPatterns.some((pattern) => pattern.test(description))) continue;

    const rawDate = (cells[columns.date] ?? '').trim();
    // A wholly blank row is spacing, not a movement — but a row with *some* content and no
    // date is a row this parser could not read, and is reported.
    if (rawDate === '' && description === '') continue;

    const occurredAt = parseStatementDate(rawDate, format.dateLayouts);
    if (occurredAt === null) {
      errors.push({
        lineNumber,
        column: table.header[columns.date] ?? 'date',
        rawValue: rawDate,
        message: `Could not read a date. "${format.label}" writes dates as ${format.dateLayouts.join(' or ')}.`,
      });
      continue;
    }
    if (description === '') {
      errors.push({
        lineNumber,
        column: table.header[columns.description] ?? 'description',
        rawValue: '',
        message:
          'This row has no narration. The original description is kept verbatim and never ' +
          'reconstructed, so a row without one cannot be imported.',
      });
      continue;
    }

    const money = readDirectionAndAmount(cells, columns, format);
    if (money.error !== null) {
      errors.push({
        lineNumber,
        column: money.error.column,
        rawValue: money.error.rawValue,
        message: money.error.message,
      });
      continue;
    }
    if (money.amount === null) continue; // a zero/blank row: nothing moved

    const reference =
      columns.reference === null ? null : normaliseReference(cells[columns.reference] ?? '');
    const balanceCell = columns.balance === null ? '' : (cells[columns.balance] ?? '');
    const balance = parseStatementAmount(balanceCell);

    rows.push({
      lineNumber,
      occurredAt,
      rawDescription: description,
      amount: money.amount,
      direction: money.direction!,
      externalReference: reference,
      referenceType: reference === null ? null : referenceTypeFor(reference, format),
      runningBalance: signedBalance(balance),
    });
  }

  if (errors.length > 0) {
    return { ok: false, formatId: format.id, parserVersion: STATEMENT_PARSER_VERSION, errors };
  }
  if (rows.length === 0) {
    warnings.push({
      lineNumber: null,
      message:
        'This file matched the format but contained no movements. Nothing was imported, and ' +
        'that is a statement about the file rather than about the account.',
    });
  }
  return { ok: true, formatId: format.id, parserVersion: STATEMENT_PARSER_VERSION, rows, warnings };
}

interface MoneyReading {
  readonly amount: Paise | null;
  readonly direction: PaymentDirection | null;
  readonly error: {
    readonly column: string | null;
    readonly rawValue: string | null;
    readonly message: string;
  } | null;
}

function readDirectionAndAmount(
  cells: readonly string[],
  columns: ResolvedColumns,
  format: StatementFormat,
): MoneyReading {
  switch (format.direction.kind) {
    case 'debit_credit_columns': {
      const debit = parseStatementAmount(cells[columns.debit!] ?? '');
      const credit = parseStatementAmount(cells[columns.credit!] ?? '');
      const debitAmount = debit === null || debit.magnitude === 0n ? null : debit.magnitude;
      const creditAmount = credit === null || credit.magnitude === 0n ? null : credit.magnitude;
      if (debitAmount !== null && creditAmount !== null) {
        return {
          amount: null,
          direction: null,
          error: {
            column: null,
            rawValue: `${cells[columns.debit!] ?? ''} / ${cells[columns.credit!] ?? ''}`,
            message:
              'This row fills both the debit and the credit column, so it does not say which ' +
              'way the money went. Nothing was imported from it.',
          },
        };
      }
      if (debitAmount !== null) return { amount: debitAmount, direction: 'debit', error: null };
      if (creditAmount !== null) return { amount: creditAmount, direction: 'credit', error: null };
      return { amount: null, direction: null, error: null };
    }
    case 'type_column': {
      const parsed = parseStatementAmount(cells[columns.amount!] ?? '');
      if (parsed === null) {
        return {
          amount: null,
          direction: null,
          error: {
            column: 'amount',
            rawValue: cells[columns.amount!] ?? '',
            message: 'Could not read an amount from this row.',
          },
        };
      }
      if (parsed.magnitude === 0n) return { amount: null, direction: null, error: null };

      const marker = (cells[columns.type!] ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, '');
      const isDebit = format.direction.debitWords.some(
        (word) => marker === word.replace(/[^a-z]/g, ''),
      );
      const isCredit = format.direction.creditWords.some(
        (word) => marker === word.replace(/[^a-z]/g, ''),
      );
      if (isDebit === isCredit) {
        return {
          amount: null,
          direction: null,
          error: {
            column: 'type',
            rawValue: cells[columns.type!] ?? '',
            message:
              `"${cells[columns.type!] ?? ''}" is not a direction this format recognises ` +
              `(expected one of ${[...format.direction.debitWords, ...format.direction.creditWords].join(', ')}). ` +
              'A movement whose direction is unknown is not imported as a guess.',
          },
        };
      }
      return { amount: parsed.magnitude, direction: isDebit ? 'debit' : 'credit', error: null };
    }
    case 'signed_amount': {
      const parsed = parseStatementAmount(cells[columns.amount!] ?? '');
      if (parsed === null) {
        return {
          amount: null,
          direction: null,
          error: {
            column: 'amount',
            rawValue: cells[columns.amount!] ?? '',
            message: 'Could not read an amount from this row.',
          },
        };
      }
      if (parsed.magnitude === 0n) return { amount: null, direction: null, error: null };
      return {
        amount: parsed.magnitude,
        direction: parsed.negative ? 'debit' : 'credit',
        error: null,
      };
    }
  }
}

/**
 * A running balance, signed.
 *
 * An overdrawn account is a real balance and a real number, so this is one of the few places
 * a negative `Paise` is legitimate — `payments.amount` is always positive with the direction
 * carrying the sign, but a *balance* has its own sign.
 */
function signedBalance(parsed: ParsedAmount | null): Paise | null {
  if (parsed === null) return null;
  return paise(parsed.negative ? -(parsed.magnitude as bigint) : parsed.magnitude);
}

function normaliseReference(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-' || trimmed.toLowerCase() === 'na') return null;
  return trimmed;
}

function referenceTypeFor(
  reference: string,
  format: {
    readonly referencePrefixes: ReadonlyArray<readonly [string, PaymentReferenceType]>;
    readonly defaultReferenceType: PaymentReferenceType | null;
  },
): PaymentReferenceType | null {
  const upper = reference.toUpperCase();
  for (const [prefix, type] of format.referencePrefixes) {
    if (upper.startsWith(prefix)) return type;
  }
  return format.defaultReferenceType;
}

/* ------------------------------------------------------------------------------- PDF */

function parsePdfStatement(bytes: Uint8Array, formatId: string): StatementParseResult {
  const text = extractPdfText(bytes);
  if (!text.hasTextLayer) {
    return {
      ok: false,
      formatId,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: null,
          message:
            text.reason ??
            'This PDF has no extractable text layer, so no transaction was read from it.',
        },
      ],
    };
  }

  const patterns =
    formatId === 'auto'
      ? PDF_LINE_PATTERNS
      : PDF_LINE_PATTERNS.filter((pattern) => pattern.id === formatId);
  if (patterns.length === 0) {
    return {
      ok: false,
      formatId,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: null,
          message: `"${formatId}" is not a PDF statement layout this build reads.`,
        },
      ],
    };
  }

  // Whichever declared layout matches the most lines wins. A statement is one layout
  // throughout, so "matched three lines" against "matched sixty" is not a close call.
  let best: { pattern: PdfLinePattern; rows: StatementRow[] } | null = null;
  for (const pattern of patterns) {
    const rows = readPdfRows(text.lines, pattern);
    if (best === null || rows.length > best.rows.length) best = { pattern, rows };
  }

  if (best === null || best.rows.length === 0) {
    return {
      ok: false,
      formatId,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: null,
          message:
            'This PDF has a text layer, but none of its lines matched a statement layout this ' +
            'build reads. Nothing was imported. Export the statement as CSV or XLSX, or add ' +
            'its layout to PDF_LINE_PATTERNS.',
        },
      ],
    };
  }

  return {
    ok: true,
    formatId: best.pattern.id,
    parserVersion: STATEMENT_PARSER_VERSION,
    rows: best.rows,
    warnings: [
      {
        lineNumber: null,
        message:
          `Read ${best.rows.length} movement(s) from ${text.lines.length} lines of PDF text. A ` +
          'PDF has no column structure, so anything this layout did not match was skipped ' +
          'rather than reported as a bad row — check the count against the statement itself ' +
          'before treating this import as complete.',
      },
    ],
  };
}

function readPdfRows(lines: readonly string[], pattern: PdfLinePattern): StatementRow[] {
  const rows: StatementRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = pattern.pattern.exec(line);
    if (match === null || match.groups === undefined) continue;

    const occurredAt = parseStatementDate(match.groups['date'] ?? '', pattern.dateLayouts);
    if (occurredAt === null) continue;

    const description = (match.groups['description'] ?? '').trim();
    if (description === '') continue;

    let amount: Paise | null = null;
    let direction: PaymentDirection | null = null;

    if (match.groups['debit'] !== undefined && match.groups['credit'] !== undefined) {
      const debit = parseStatementAmount(match.groups['debit']);
      const credit = parseStatementAmount(match.groups['credit']);
      if (debit !== null && debit.magnitude > 0n) {
        amount = debit.magnitude;
        direction = 'debit';
      } else if (credit !== null && credit.magnitude > 0n) {
        amount = credit.magnitude;
        direction = 'credit';
      }
    } else if (match.groups['amount'] !== undefined) {
      const parsed = parseStatementAmount(match.groups['amount']);
      const marker = (match.groups['type'] ?? '').toLowerCase();
      if (parsed !== null && parsed.magnitude > 0n && (marker === 'dr' || marker === 'cr')) {
        amount = parsed.magnitude;
        direction = marker === 'dr' ? 'debit' : 'credit';
      }
    }
    if (amount === null || direction === null) continue;

    const reference = extractReferenceFromNarration(description);
    const balanceGroup = match.groups['balance'];
    const balance = balanceGroup === undefined ? null : parseStatementAmount(balanceGroup);

    rows.push({
      lineNumber: index + 1,
      occurredAt,
      rawDescription: description,
      amount,
      direction,
      externalReference: reference,
      referenceType: reference === null ? null : referenceTypeFor(reference, pattern),
      runningBalance: signedBalance(balance),
    });
  }
  return rows;
}

/**
 * The reference a PDF narration carries inline, since a PDF has no reference column.
 *
 * Only recognises the shapes a bank actually prints, and in a deliberate order, because a UPI
 * narration contains two things that look alike: `UPI-BLINKIT9821PAYTM` is the *merchant
 * handle* and `UPI/2607011234/BLINKIT` is the *reference*. Taking the first match found reads
 * the handle as the identifier, which would then fail to deduplicate the same transaction
 * captured from the bank's CSV — so the slash form is preferred, a bare UTR next, and the
 * hyphen form only when its tail is a long enough digit run to be an identifier at all.
 *
 * Anything else yields `null`. That costs a deterministic duplicate check on the row and is
 * far better than inventing an identifier that would match the wrong payment.
 */
function extractReferenceFromNarration(description: string): string | null {
  const slashForm = /\b((?:UPI|NEFT|IMPS|RTGS|ACH|BBPS|MMT)\/[A-Za-z0-9/_-]{4,})/i.exec(
    description,
  );
  if (slashForm !== null) return slashForm[1]!;

  const utr = /\b(\d{12})\b/.exec(description);
  if (utr !== null) return utr[1]!;

  const hyphenForm =
    /\b((?:UPI|NEFT|IMPS|RTGS|ACH|BBPS|MMT)-[A-Za-z0-9_-]*\d{6,}[A-Za-z0-9_-]*)/i.exec(description);
  return hyphenForm === null ? null : hyphenForm[1]!;
}
