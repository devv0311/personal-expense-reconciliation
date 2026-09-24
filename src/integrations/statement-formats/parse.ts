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
import type {
  AccountType,
  Paise,
  PaymentDirection,
  PaymentReferenceType,
} from '../../domain/index.js';

import { PDF_LINE_PATTERNS, STATEMENT_FORMATS } from './formats.js';
import type { PdfLinePattern, StatementFormat } from './formats.js';
import { readColumnarPdfRows } from './pdf-columns.js';
import { extractPdfTextWithPdfJs } from './pdf-text.js';
import {
  detectDelimiter,
  findColumn,
  parseStatementAmount,
  parseStatementDate,
  referenceTypeFromPrefixes,
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
export const STATEMENT_PARSER_VERSION = 'statement-formats@2';

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
    // A column map cannot tell a savings account's export from a card's: it does not claim one.
    accountKind: null,
    checksPrintedBalances: false,
  }));
  const pdf = PDF_LINE_PATTERNS.map((pattern) => ({
    id: pattern.id,
    label: pattern.label,
    container: 'pdf_text' as const,
    channel: pattern.channel,
    headerHint: pattern.headerHint ?? pattern.pattern.source,
    carriesRunningBalance:
      pattern.columns !== undefined || pattern.pattern.source.includes('balance'),
    detectable: true,
    accountKind: pattern.accountKind ?? null,
    checksPrintedBalances: pattern.columns !== undefined,
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
 * Parses one **text or workbook** statement: CSV, a delimited export, or an XLSX sheet.
 *
 * **It does not read PDFs, and will not pretend to.** Reading a real PDF needs PDF.js, which
 * loads asynchronously, so there is exactly one PDF entry point — `parseStatementFile` — and
 * this function refuses one by name rather than falling back to a weaker reader.
 *
 * That refusal is the whole point. This function used to route a PDF through the
 * dependency-free reader while `services.importStatement` routed the same bytes through
 * PDF.js, so the same document could be read two different ways depending on which function a
 * caller reached for: one of them answering "no text layer" about a statement the other read
 * in full. Two answers to one document is not a fallback, it is a fork, and a financial
 * parser cannot have one.
 *
 * @throws never. Every failure — an unrecognised format, an unreadable workbook, a bad row,
 *   or a PDF arriving here — comes back as `{ ok: false, errors }`, because each has the same
 *   shape for the caller (report it, import nothing) and a thrown error would make an honest
 *   refusal indistinguishable from a bug.
 */
export function parseStatement(input: ParseStatementInput): StatementParseResult {
  const isZip = input.bytes[0] === 0x50 && input.bytes[1] === 0x4b;

  if (looksLikePdf(input.bytes)) {
    return {
      ok: false,
      formatId: input.formatId,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: null,
          // Addressed to whoever wired the call, not to a person holding a statement: reaching
          // here at all is a programming mistake, and naming the right function is the fix.
          message:
            'These bytes are a PDF, and parseStatement() reads only text and workbook ' +
            'statements. Call parseStatementFile() instead — PDF text extraction is ' +
            'asynchronous, and it is the one path that reads a PDF.',
        },
      ],
    };
  }

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

  let format: StatementFormat | null;
  if (input.formatId === 'auto') {
    const detected = detectTabularFormat(table);
    if (detected.kind === 'tied') return tiedLayoutsRefusal(table, detected.formats);
    format = detected.kind === 'matched' ? detected.format : null;
  } else {
    format = STATEMENT_FORMATS.find((candidate) => candidate.id === input.formatId) ?? null;
  }

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

/**
 * Parses one statement in any container this build reads. **The entry point for every caller.**
 *
 * `services.importStatement` calls this, and so should anything else that might be handed a
 * file rather than a known-text one. CSV and XLSX are handed straight to `parseStatement`; a
 * PDF is read with PDF.js, which is the only reader that sees the embedded font maps and
 * object streams a real issuer's statement uses.
 *
 * It is `async` because PDF.js is, and that is the reason `parseStatement` exists separately
 * rather than being replaced: a caller that already knows it holds CSV text should not have to
 * await a dynamic import it will never use. What neither may do is read the same PDF
 * differently, which is why the synchronous one refuses PDFs outright.
 */
export async function parseStatementFile(
  input: ParseStatementInput,
): Promise<StatementParseResult> {
  if (!looksLikePdf(input.bytes)) return parseStatement(input);
  const text = await extractPdfTextWithPdfJs(input.bytes);
  return parsePdfText(text, input.formatId);
}

/** The `%PDF-` header, which is what makes a file a PDF as far as either entry point cares. */
function looksLikePdf(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes.subarray(0, 5)) === '%PDF-';
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
 * What auto-detection made of a header: one layout, several that fit it equally well, or none.
 *
 * A tie is its own answer rather than "none", because the two call for different things from
 * whoever holds the file. "No layout fits" means this build does not read it; "two layouts fit
 * equally" means it reads it two different ways and will not pick one — and a refusal that
 * reported the second as the first would send somebody looking for the wrong problem.
 */
type TabularDetection =
  | { readonly kind: 'matched'; readonly format: StatementFormat }
  | { readonly kind: 'tied'; readonly formats: readonly StatementFormat[] }
  | { readonly kind: 'none' };

/**
 * Picks the declared format whose columns this header best satisfies.
 *
 * A format only qualifies when every column it *needs* is present — the date, the description,
 * and whichever money columns its direction style requires. Among those, the one matching the
 * most declared columns wins; a tie is refused rather than resolved, because two formats that
 * fit equally well disagree about something and importing under either is a coin flip with
 * somebody's money.
 */
function detectTabularFormat(table: StatementTable): TabularDetection {
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
  if (scored.length === 0) return { kind: 'none' };

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const tied = scored.filter((candidate) => candidate.score === best.score);
  if (tied.length > 1) return { kind: 'tied', formats: tied.map((candidate) => candidate.format) };
  return { kind: 'matched', format: best.format };
}

/** Auto-detection's refusal of a header that several layouts fit equally well. */
function tiedLayoutsRefusal(
  table: StatementTable,
  formats: readonly StatementFormat[],
): StatementParseResult {
  const header = table.header.join(', ');
  return {
    ok: false,
    formatId: 'auto',
    parserVersion: STATEMENT_PARSER_VERSION,
    errors: [
      {
        lineNumber: 1,
        column: null,
        rawValue: header,
        // Shown verbatim by the import screen, which cannot name a layout — so the way forward
        // offered is one a person holding the file can take. A caller of the API can still name
        // one with `formatId`; the labels here are the ones `GET /api/imports/formats` lists.
        message:
          "This file's columns fit more than one layout this build reads equally well — " +
          `${formats.map((format) => format.label).join('; ')} — and those layouts read some ` +
          'rows differently, for example which way money went, so none was chosen for you. ' +
          `Nothing was imported. Its header reads: ${header}. Try another format of the same ` +
          'statement.',
      },
    ],
  };
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
  return {
    ok: true,
    formatId: format.id,
    parserVersion: STATEMENT_PARSER_VERSION,
    // A column map cannot tell a savings account's export from a card's: it does not claim one.
    accountKind: null,
    rows,
    warnings,
  };
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

function parsePdfText(
  text: Awaited<ReturnType<typeof extractPdfTextWithPdfJs>>,
  formatId: string,
): StatementParseResult {
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

  const documentText = text.lines.join('\n');
  const patterns = (
    formatId === 'auto'
      ? PDF_LINE_PATTERNS
      : PDF_LINE_PATTERNS.filter((pattern) => pattern.id === formatId)
  ).filter(
    (pattern) =>
      pattern.documentPattern === undefined || pattern.documentPattern.test(documentText),
  );
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

  // Whichever declared layout matches the most lines wins, *except* that a layout which
  // identified the document by name outranks a generic one. Both parts matter: a statement is
  // one layout throughout, so "matched three lines" against "matched sixty" is not a close
  // call — but a generic date/amount shape can also match a named issuer's lines by accident,
  // and when an issuer's own layout has recognised the document there is nothing to weigh.
  let best: { pattern: PdfLinePattern; read: PdfReadResult } | null = null;
  for (const pattern of patterns) {
    const read =
      pattern.columns === undefined
        ? readPdfRows(text.lines, pattern)
        : fromColumnarRead(readColumnarPdfRows(text, { ...pattern, columns: pattern.columns }));
    if (best === null || beats(pattern, read, best)) best = { pattern, read };
  }

  /** No declared layout recognised anything in this document. */
  const unrecognised = (): StatementParseResult => ({
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
  });

  if (best === null || recognitionEvidence(best.read) === 0) return unrecognised();

  // **All-or-nothing, for a PDF too.** Two different ways a record can go unread, and both
  // fail the whole file rather than reducing the count:
  //
  //  - a dated line that began a transaction and never reached an amount and a direction, so
  //    the layout never even matched it (`incompleteLineNumbers`);
  //  - a record the layout *did* match whose date, narration, amount, direction or balance
  //    would not convert (`rowErrors`) — an impossible calendar date being the clearest case.
  //
  // Either way the statement printed a movement this build could not read, and importing the
  // rows around it would leave the ledger quietly short by exactly that movement — the
  // condition cash reconciliation exists to detect — while the screen said the import
  // succeeded. That is not what the import screen and `POST /api/imports/statement` promise.
  //
  // Checked *after* the layout is chosen, deliberately: falling back to a layout that reads
  // fewer lines cleanly would be the same silent shortfall by another route.
  const unreadable = [
    // One error per unreadable record, so one pass over the document fixes the file. Only the
    // line number is reported; the line's own text is the statement's content and has no
    // business in an error (`security-model.md`, the sixth pillar).
    ...best.read.incompleteLineNumbers.map((lineNumber) => ({
      lineNumber,
      column: null,
      rawValue: null,
      message:
        'This line begins a transaction that never reaches an amount and a direction, so it ' +
        'could not be read. Nothing was imported — importing the rest would leave the ledger ' +
        'short by exactly this movement while appearing to have succeeded.',
    })),
    ...best.read.rowErrors,
  ].sort((left, right) => left.lineNumber - right.lineNumber);

  // Reported **before** the "nothing matched" refusal below, because a layout that recognised
  // records and could not convert any of them has not failed to recognise the document — it
  // has read it and found every transaction in it unreadable. Answering that with the generic
  // "none of its lines matched" at line 1 would hide a real, locatable defect behind a message
  // about an unsupported format, and send somebody looking for the wrong problem.
  if (unreadable.length > 0) {
    return {
      ok: false,
      formatId: best.pattern.id,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: unreadable,
    };
  }

  // Recognition evidence with no rows and no errors is not reachable — evidence is exactly
  // rows plus errors — but the guard keeps the success branch honest about what it returns.
  if (best.read.rows.length === 0) return unrecognised();

  const kinds = namedAccountKinds(documentText, best.pattern);
  if (kinds.length > 1) {
    // Choosing one would decide which account a statement's movements are written onto, and a
    // document that contradicts itself about that is not a file this build can decide it for.
    return {
      ok: false,
      formatId: best.pattern.id,
      parserVersion: STATEMENT_PARSER_VERSION,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: null,
          message:
            `This document says it is the statement of ${kinds.map(kindWords).join(' and of ')}, ` +
            'so which account it belongs to cannot be read from it. Nothing was imported.',
        },
      ],
    };
  }

  return {
    ok: true,
    formatId: best.pattern.id,
    parserVersion: STATEMENT_PARSER_VERSION,
    accountKind: kinds[0] ?? null,
    rows: best.read.rows,
    warnings:
      best.pattern.columns === undefined
        ? pdfWarnings(best.pattern, best.read, text.lines.length)
        : columnarWarnings(best.read),
  };
}

/**
 * The kinds of account this document says it is a statement of (ADR-0067).
 *
 * A layout that declares a kind and read the document settles it: it recognised the document by
 * name before it read a line. Otherwise every layout that declares a kind is asked whether this
 * is its document, because what a statement is does not change with the reader a caller chose —
 * a card statement read by a generic line shape is still a card's, and must not become an
 * unclaimed file that any account will accept. More than one answer means the document
 * contradicts itself, which the caller refuses rather than resolves.
 */
function namedAccountKinds(documentText: string, reader: PdfLinePattern): readonly AccountType[] {
  if (reader.accountKind !== undefined) return [reader.accountKind];
  const kinds = new Set<AccountType>();
  for (const pattern of PDF_LINE_PATTERNS) {
    if (pattern.accountKind === undefined || pattern.documentPattern === undefined) continue;
    if (pattern.documentPattern.test(documentText)) kinds.add(pattern.accountKind);
  }
  return [...kinds];
}

function kindWords(kind: AccountType): string {
  switch (kind) {
    case 'bank':
      return 'a bank account';
    case 'card':
      return 'a card';
    case 'upi':
      return 'a UPI account';
    case 'wallet':
      return 'a wallet';
    case 'cash':
      return 'cash';
  }
}

/** The columnar reader's result, in the shape layout selection compares. */
function fromColumnarRead(read: ReturnType<typeof readColumnarPdfRows>): PdfReadResult {
  return {
    rows: read.rows,
    rowErrors: read.rowErrors,
    incompleteLineNumbers: [],
    sectionFound: read.headerFound,
    rowsOutOfBankOrder: read.rowsOutOfBankOrder,
  };
}

/**
 * What a columnar statement that *succeeded* still wants said.
 *
 * Not the line reader's count caveat: every row here was accounted for by the statement's own
 * row numbers and printed balances, so there is nothing for a person to recount. What is worth
 * saying is when the bank's balance column followed a different order within a day than the
 * rows were printed in — each day still closed, and each row's direction was read from its
 * column, but a person reading the running balances row by row would otherwise think one was
 * printed backwards.
 */
function columnarWarnings(read: PdfReadResult): readonly StatementWarning[] {
  const reordered = read.rowsOutOfBankOrder ?? 0;
  if (reordered === 0) return [];
  return [
    {
      lineNumber: null,
      message:
        `${String(reordered)} rows show a running balance in the bank's own order within the day ` +
        'rather than the order they were printed in. Every day still closes exactly on the ' +
        'balance the statement printed, and every row was read from the column it sits in.',
    },
  ];
}

/**
 * How much of this document one layout recognised as transaction records.
 *
 * **Successfully converted rows are not the measure.** A record the layout matched and could
 * not convert — an impossible date, an amount that is not money — is still proof that the
 * layout recognised the document; so is a dated line that began a record and never finished
 * one. Scoring on successful rows alone made a statement whose every transaction is invalid
 * look like a statement in a format this build does not read, which is a different fact with
 * a different fix.
 */
function recognitionEvidence(read: PdfReadResult): number {
  return read.rows.length + read.rowErrors.length + read.incompleteLineNumbers.length;
}

/** Whether `pattern` should displace the layout currently winning. */
function beats(
  pattern: PdfLinePattern,
  read: PdfReadResult,
  best: { pattern: PdfLinePattern; read: PdfReadResult },
): boolean {
  const evidence = recognitionEvidence(read);
  const bestEvidence = recognitionEvidence(best.read);

  // A layout that identified the document by name still outranks a generic one, provided it
  // recognised something — otherwise a named layout that found nothing would displace a
  // generic one that read the file.
  const identified = pattern.documentPattern !== undefined && evidence > 0;
  const bestIdentified = best.pattern.documentPattern !== undefined && bestEvidence > 0;
  if (identified !== bestIdentified) return identified;

  if (evidence !== bestEvidence) return evidence > bestEvidence;
  // Equal recognition: prefer the layout that actually converted more of it.
  return read.rows.length > best.read.rows.length;
}

/**
 * What the caller still has to check after a PDF import that *succeeded*.
 *
 * A record this layout could not read is no longer one of these — it fails the whole file
 * (see `parsePdfText`). What remains is the irreducible caveat of the container: a PDF has no
 * column structure, so a line the layout did not match cannot be told apart from a
 * presentation footer, and the count is therefore what matched rather than what the statement
 * printed. That is a fact about PDFs, not a defect, so it is a warning and not a refusal.
 */
function pdfWarnings(
  pattern: PdfLinePattern,
  read: PdfReadResult,
  lineCount: number,
): readonly StatementWarning[] {
  const warnings: StatementWarning[] = [
    {
      lineNumber: null,
      message:
        `Read ${read.rows.length} movement(s) from ${lineCount} lines of PDF text. A ` +
        'PDF has no column structure, so anything this layout did not match was skipped ' +
        'rather than reported as a bad row — check the count against the statement itself ' +
        'before treating this import as complete.',
    },
  ];

  if (!read.sectionFound) {
    warnings.push({
      lineNumber: null,
      message:
        `The "${pattern.label}" layout expects a transactions section this document never ` +
        'printed, so every line was considered instead of only that section. Check that no ' +
        'summary or rewards row was read as a movement.',
    });
  }

  return warnings;
}

interface PreparedPdfLine {
  readonly lineNumber: number;
  readonly text: string;
}

/**
 * What one declared layout made of a document, including what it could *not* make of it.
 *
 * `incompleteLineNumbers` is the part worth carrying: a dated line that never completed into
 * an amount and a direction is a movement the statement printed and this build did not read.
 * A non-empty list **fails the whole file** rather than reducing the count — importing the
 * rows around an unread movement is the silent shortfall `invariants.md` #10 and the cash
 * waterfall exist to prevent, and it is exactly what the import screen promises will not
 * happen.
 */
interface PdfReadResult {
  readonly rows: readonly StatementRow[];
  readonly incompleteLineNumbers: readonly number[];
  /**
   * Records that matched the layout and then failed to convert into a movement.
   *
   * A line that does not match the layout at all is presentation text and is skipped. A line
   * that *does* match and then yields an impossible date, an empty narration, no amount, no
   * direction or an unreadable balance is a different thing entirely: the layout recognised a
   * transaction and this build could not read it. Skipping one of those is how a statement
   * imports as a shorter month.
   */
  readonly rowErrors: readonly StatementRowError[];
  /** `false` when a layout declares a section marker that the document never printed. */
  readonly sectionFound: boolean;
  /** Columnar layouts only: rows whose balance followed the bank's own order within a day. */
  readonly rowsOutOfBankOrder?: number;
}

/**
 * A rejected PDF record, naming the field that failed and nothing else.
 *
 * `rawValue` is deliberately `null` and the message never quotes the line. A delimited format
 * can afford to echo the offending *cell* back, because a cell is a bounded value; a PDF
 * record is a whole line of somebody's statement, and an error is not a place for it
 * (`security-model.md`, the sixth pillar).
 */
function pdfRowError(lineNumber: number, problem: string): StatementRowError {
  return {
    lineNumber,
    column: null,
    rawValue: null,
    message:
      `This line matches the statement layout but ${problem}, so it could not be read. ` +
      'Nothing was imported — importing the rest would leave the ledger short by exactly this ' +
      'movement while appearing to have succeeded.',
  };
}

function readPdfRows(lines: readonly string[], pattern: PdfLinePattern): PdfReadResult {
  const rows: StatementRow[] = [];
  const rowErrors: StatementRowError[] = [];
  const prepared = preparePdfLines(lines, pattern);

  for (const entry of prepared.records) {
    const match = pattern.pattern.exec(entry.text);
    // A line that does not match the layout is presentation text — a header, a footer, an
    // address. That is a skip, and the count warning is what tells the caller skipping
    // happened. Everything below this point is a record the layout *claimed*.
    if (match === null || match.groups === undefined) continue;

    const occurredAt = parseStatementDate(match.groups['date'] ?? '', pattern.dateLayouts);
    if (occurredAt === null) {
      rowErrors.push(pdfRowError(entry.lineNumber, 'its date is not a real calendar date'));
      continue;
    }

    const description = (match.groups['description'] ?? '').trim();
    if (description === '') {
      rowErrors.push(pdfRowError(entry.lineNumber, 'it carries no narration at all'));
      continue;
    }

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
    if (amount === null || direction === null) {
      rowErrors.push(
        pdfRowError(entry.lineNumber, 'its amount or direction could not be read as money'),
      );
      continue;
    }

    const balanceGroup = match.groups['balance'];
    const balance = balanceGroup === undefined ? null : parseStatementAmount(balanceGroup);
    if (balanceGroup !== undefined && balance === null) {
      rowErrors.push(pdfRowError(entry.lineNumber, 'its running balance could not be read'));
      continue;
    }

    const reference = extractReferenceFromNarration(description);
    rows.push({
      lineNumber: entry.lineNumber,
      occurredAt,
      rawDescription: description,
      amount,
      direction,
      externalReference: reference,
      referenceType:
        reference === null ? null : pdfReferenceTypeFor(reference, description, pattern),
      runningBalance: signedBalance(balance),
    });
  }

  return {
    rows,
    rowErrors,
    incompleteLineNumbers: prepared.incompleteLineNumbers,
    sectionFound: prepared.sectionFound,
  };
}

/**
 * What kind of identifier a PDF narration carried, given that the prefix is not on the value.
 *
 * A delimited format has a reference *column*, so its `referencePrefixes` match the cell. A PDF
 * does not: `extractReferenceFromNarration` lifts the identifier out of prose, and the prefix
 * that says what kind of identifier it is stays behind in the narration. `UPICC/301234567890/…`
 * on a card statement yields the bare UTR `301234567890`, which starts with none of the
 * declared prefixes and would otherwise fall through to the format's default — typing a
 * genuine UPI UTR as a card reference and making a declared prefix rule dead configuration.
 *
 * So the value is tried first, exactly as a column would be, and the narration only after it.
 */
function pdfReferenceTypeFor(
  reference: string,
  narration: string,
  pattern: PdfLinePattern,
): PaymentReferenceType | null {
  return referenceTypeFromPrefixes(
    reference,
    narration,
    pattern.referencePrefixes,
    pattern.defaultReferenceType,
  );
}

/**
 * How many physical lines one wrapped transaction may occupy before it is abandoned.
 *
 * An IDFC narration wraps once, occasionally twice. The bound exists so a dated line that
 * never completes cannot absorb the rest of the section into one enormous candidate string
 * and then match something by accident at the far end of it.
 */
const MAX_WRAPPED_LINES = 8;

interface PreparedPdfLines {
  readonly records: readonly PreparedPdfLine[];
  readonly incompleteLineNumbers: readonly number[];
  readonly sectionFound: boolean;
}

/**
 * Joins an IDFC-style wrapped transaction without joining presentation text into it.
 *
 * Three properties are deliberate:
 *
 * - **An incomplete record is never guessed into existence.** A dated line that never reaches
 *   an amount and a `DR`/`CR` marker is dropped and its line number reported, because a
 *   half-read movement is worse than an unread one.
 * - **A section end is an exit, not a stop.** A statement that prints its transactions in more
 *   than one block — a second card, a second holder — re-enters on the next start marker.
 *   Stopping at the first end marker would silently import only the first block.
 * - **A missing start marker is reported rather than assumed.** `sectionFound` is how the
 *   caller can say the layout matched lines it was never scoped to.
 */
function preparePdfLines(lines: readonly string[], pattern: PdfLinePattern): PreparedPdfLines {
  if (pattern.recordMode !== 'dated_multiline') {
    return {
      records: lines.map((text, index) => ({ lineNumber: index + 1, text })),
      incompleteLineNumbers: [],
      sectionFound: true,
    };
  }

  const records: PreparedPdfLine[] = [];
  const incompleteLineNumbers: number[] = [];
  // A start marker the document never prints must not mean "no transactions". The whole
  // document is scanned instead and the caller is told the layout ran unscoped, because the
  // alternative — refusing a statement whose heading an issuer reworded — reads to the person
  // holding it as "this build cannot import my statement" when it very nearly can.
  const start = pattern.sectionStartPattern;
  const sectionFound = start === undefined || lines.some((line) => start.test(line));
  let insideSection = !sectionFound || start === undefined;
  let pending: { lineNumber: number; parts: string[] } | null = null;

  const abandonPending = (): void => {
    if (pending === null) return;
    incompleteLineNumbers.push(pending.lineNumber);
    pending = null;
  };

  const finishIfComplete = (): void => {
    if (pending === null) return;
    const text = pending.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!pattern.pattern.test(text)) {
      if (pending.parts.length >= MAX_WRAPPED_LINES) abandonPending();
      return;
    }
    records.push({ lineNumber: pending.lineNumber, text });
    pending = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (sectionFound && start?.test(line) === true) {
      abandonPending();
      insideSection = true;
      continue;
    }
    if (!insideSection) continue;
    if (sectionFound && pattern.sectionEndPattern?.test(line) === true) {
      abandonPending();
      insideSection = false;
      continue;
    }

    if (DATED_PDF_LINE.test(line)) {
      // The next dated row starts a new source claim, so whatever the previous one was
      // missing, it is not going to arrive.
      abandonPending();
      pending = { lineNumber: index + 1, parts: [line] };
      finishIfComplete();
      continue;
    }
    if (pending !== null) {
      pending.parts.push(line);
      finishIfComplete();
    }
  }
  abandonPending();

  return { records, incompleteLineNumbers, sectionFound };
}

/** The shape that starts a transaction record in a `dated_multiline` layout. */
const DATED_PDF_LINE = /^\d{1,2}\/\d{1,2}\/\d{4}\b/;

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
