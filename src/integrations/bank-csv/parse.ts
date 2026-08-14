/**
 * Adapter for one synthetic bank-statement CSV format.
 *
 * ```
 * date,description,amount_inr,type,reference
 * 2026-07-01,UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD,1240.00,DEBIT,UPI/2607011234/BLINKIT
 * ```
 *
 * **What this file knows:** how *this format* writes a date, an amount, a direction and a
 * reference. That is format knowledge, and it belongs in an adapter so a second source can be
 * added later without touching the domain or any other adapter (`requirements.md`,
 * "Extensibility without coupling").
 *
 * **What this file must never know:** what a payment was *for*. No counterparty resolution, no
 * merchant matching, no expense/settlement/transfer/investment decision. `NEFT TRANSFER TO
 * SELF A/C X4821` is obviously an internal transfer to a human reader, and this parser still
 * returns it as nothing more than a debit with that description — classifying it is Phase 8's
 * job (`lifecycle.md`; `data-flow.md` steps 2–3). The returned row type has no field that could
 * hold such a decision, so the boundary is structural rather than a matter of discipline.
 *
 * Pure: text in, values out. No I/O, no database, no clock, no locale.
 */

import type { PaymentDirection, PaymentReferenceType } from '../../domain/index.js';
import { DomainError, parseMajorUnitsToPaise } from '../../domain/index.js';
import type { Paise } from '../../domain/index.js';

/** The exact header this adapter accepts. A different header is a different format. */
export const BANK_STATEMENT_CSV_HEADER = 'date,description,amount_inr,type,reference';

const COLUMNS = ['date', 'description', 'amount_inr', 'type', 'reference'] as const;
type ColumnName = (typeof COLUMNS)[number];

/** One source row, carrying only what the source actually said. */
export interface BankStatementCsvRow {
  /** 1-based line in the file, so any later complaint can point at it. */
  readonly lineNumber: number;
  /** Parsed at UTC midnight: this format carries a date, not a time. */
  readonly occurredAt: Date;
  /** Verbatim, including whatever noise the bank put in it. */
  readonly rawDescription: string;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly externalReference: string | null;
  readonly referenceType: PaymentReferenceType | null;
}

/** A row this adapter refused to interpret, and why. */
export interface BankStatementCsvError {
  readonly lineNumber: number;
  readonly column: ColumnName | null;
  readonly rawValue: string | null;
  readonly message: string;
}

export type BankStatementCsvParseResult =
  | { readonly ok: true; readonly rows: readonly BankStatementCsvRow[] }
  | { readonly ok: false; readonly errors: readonly BankStatementCsvError[] };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * How this bank's reference strings map onto `payments.reference_type`.
 *
 * Format knowledge, deliberately local to this adapter — the domain knows nothing about
 * prefixes, and a different bank's adapter is free to map differently. An unrecognised prefix
 * becomes `other` rather than a guess: the reference itself is still stored verbatim, so
 * nothing is lost by declining to categorise it.
 */
const REFERENCE_PREFIXES: ReadonlyArray<readonly [string, PaymentReferenceType]> = [
  ['UPI/', 'upi_utr'],
  ['NEFT/', 'bank_reference'],
  ['IMPS/', 'bank_reference'],
  ['RTGS/', 'bank_reference'],
  ['ACH/', 'bank_reference'],
  ['BBPS/', 'bank_reference'],
  ['CHQ/', 'cheque_number'],
];

/**
 * Parses the whole file, or reports every row it could not.
 *
 * All-or-nothing by design: a partially imported statement leaves the ledger quietly missing
 * rows, and "unexplained money" then measures the importer's gaps rather than the user's
 * spending. The caller gets every bad line at once so one pass fixes the file.
 */
export function parseBankStatementCsv(text: string): BankStatementCsvParseResult {
  const lines = splitLines(text);
  const errors: BankStatementCsvError[] = [];

  const header = lines[0];
  if (header === undefined || normaliseHeader(header) !== BANK_STATEMENT_CSV_HEADER) {
    return {
      ok: false,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: header ?? null,
          message:
            `Unexpected CSV header. This adapter reads "${BANK_STATEMENT_CSV_HEADER}"; a file ` +
            'with a different header is a different format and needs its own adapter.',
        },
      ],
    };
  }

  const rows: BankStatementCsvRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue; // a trailing newline is not a row
    const lineNumber = index + 1;

    const fields = splitCsvLine(line);
    if (fields.length !== COLUMNS.length) {
      errors.push({
        lineNumber,
        column: null,
        rawValue: line,
        message: `Expected ${COLUMNS.length} columns (${COLUMNS.join(', ')}), found ${fields.length}.`,
      });
      continue;
    }

    const parsed = parseRow(lineNumber, fields);
    if ('error' in parsed) {
      errors.push(parsed.error);
      continue;
    }
    rows.push(parsed.row);
  }

  if (errors.length > 0) return { ok: false, errors };
  if (rows.length === 0) {
    return {
      ok: false,
      errors: [
        {
          lineNumber: 1,
          column: null,
          rawValue: null,
          message: 'The file has a valid header but no data rows.',
        },
      ],
    };
  }
  return { ok: true, rows };
}

/* ------------------------------------------------------------------------- internals */

function parseRow(
  lineNumber: number,
  fields: readonly string[],
): { row: BankStatementCsvRow } | { error: BankStatementCsvError } {
  const [rawDate = '', rawDescription = '', rawAmount = '', rawType = '', rawReference = ''] =
    fields;

  const occurredAt = parseIsoDateAtUtcMidnight(rawDate);
  if (occurredAt === null) {
    return {
      error: {
        lineNumber,
        column: 'date',
        rawValue: rawDate,
        message: `"${rawDate}" is not a calendar date in YYYY-MM-DD form.`,
      },
    };
  }

  if (rawDescription.trim() === '') {
    return {
      error: {
        lineNumber,
        column: 'description',
        rawValue: rawDescription,
        message: 'The description is empty; the raw statement line is the evidence for this row.',
      },
    };
  }

  let amount: Paise;
  try {
    amount = parseMajorUnitsToPaise(rawAmount.trim());
  } catch (error) {
    return {
      error: {
        lineNumber,
        column: 'amount_inr',
        rawValue: rawAmount,
        message: error instanceof DomainError ? error.message : 'Unparseable amount.',
      },
    };
  }
  if (amount <= 0n) {
    return {
      error: {
        lineNumber,
        column: 'amount_inr',
        rawValue: rawAmount,
        message: `Amount must be greater than zero; a payment moved money. Got ${amount} paise.`,
      },
    };
  }

  const direction = parseDirection(rawType.trim());
  if (direction === null) {
    return {
      error: {
        lineNumber,
        column: 'type',
        rawValue: rawType,
        message: `"${rawType}" is not a direction; this format writes DEBIT or CREDIT.`,
      },
    };
  }

  const reference = rawReference.trim();
  const externalReference = reference === '' ? null : reference;

  return {
    row: {
      lineNumber,
      occurredAt,
      rawDescription,
      amount,
      direction,
      externalReference,
      referenceType: externalReference === null ? null : classifyReference(externalReference),
    },
  };
}

/**
 * Parses `YYYY-MM-DD` at UTC midnight.
 *
 * Explicitly UTC, never the host's zone: a statement imported in Kolkata and the same statement
 * imported on a CI runner in UTC must produce byte-identical `occurred_at` values, or
 * "identical inputs produce identical outputs" (`requirements.md`) is false for imports.
 * Round-tripping the components also rejects a date like `2026-02-30`, which `Date` would
 * otherwise silently roll forward.
 */
function parseIsoDateAtUtcMidnight(value: string): Date | null {
  const match = DATE_PATTERN.exec(value.trim());
  if (match === null) return null;

  const [, year = '', month = '', day = ''] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return parsed;
}

function parseDirection(value: string): PaymentDirection | null {
  if (value.toUpperCase() === 'DEBIT') return 'debit';
  if (value.toUpperCase() === 'CREDIT') return 'credit';
  return null;
}

function classifyReference(reference: string): PaymentReferenceType {
  const upper = reference.toUpperCase();
  for (const [prefix, type] of REFERENCE_PREFIXES) {
    if (upper.startsWith(prefix)) return type;
  }
  return 'other';
}

function normaliseHeader(line: string): string {
  return splitCsvLine(line)
    .map((field) => field.trim().toLowerCase())
    .join(',');
}

function splitLines(text: string): string[] {
  // Strip a UTF-8 BOM, which spreadsheet exports routinely prepend.
  const withoutBom = text.startsWith('﻿') ? text.slice(1) : text;
  return withoutBom.split(/\r\n|\n|\r/);
}

/**
 * Splits one CSV line, honouring RFC 4180 quoting.
 *
 * Hand-rolled rather than pulled from a dependency: the grammar is small enough to read in
 * one screen, and a financial importer's parsing rules are worth being able to see.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'; // an escaped quote
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' && current === '') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char ?? '';
    }
  }
  fields.push(current);
  return fields;
}
