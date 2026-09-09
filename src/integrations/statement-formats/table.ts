/**
 * A table of strings, and the value readers every format shares.
 *
 * Real statements differ in three ways that matter and one that does not. The three: which
 * columns exist, how a date is written, and whether direction is a sign, a word, or two
 * separate debit/credit columns. The one that does not: whether the bytes arrived as CSV,
 * as a sheet inside an XLSX, or as lines of a PDF's text layer — all three become the same
 * `StatementTable` before any column has a meaning.
 *
 * Everything here is pure and total: text in, values out, no I/O, no clock, no locale. Amounts
 * are parsed as exact strings into paise and never through `Number` — `Number('1234.56') * 100`
 * is `123455.99999999999`, and this system has no field for "nearly ₹1,234.56"
 * (`invariants.md` #12).
 */

import { parseMajorUnitsToPaise } from '../../domain/index.js';
import type { Paise } from '../../domain/index.js';

/** A header row plus the rows beneath it, each already split into cells. */
export interface StatementTable {
  readonly header: readonly string[];
  /** Body rows, each carrying the source line/row number it came from. */
  readonly rows: readonly { readonly lineNumber: number; readonly cells: readonly string[] }[];
}

/**
 * Normalises a header cell for matching: lowercase, and every run of non-alphanumerics
 * collapsed away.
 *
 * `Withdrawal Amt.`, `withdrawal amt`, and `WITHDRAWAL_AMT` are the same column, and a bank
 * that adds a trailing space or a `(INR )` suffix has not changed its format. Suffixes in
 * brackets are dropped first, because `Deposit Amount (INR )` and `Deposit Amount` are one
 * column under two spellings and matching the bracketed form would need a second alias for
 * every currency a bank might print.
 */
export function normaliseHeaderCell(value: string): string {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Finds a column's index by trying each alias in order.
 *
 * Order matters: `Transaction Date` is preferred over `Value Date` when a format lists both,
 * because the value date is when the bank applied the movement and the transaction date is
 * when it happened. Recording the wrong one puts a payment in the wrong reconciliation period.
 */
export function findColumn(header: readonly string[], aliases: readonly string[]): number | null {
  const normalised = header.map(normaliseHeaderCell);
  for (const alias of aliases) {
    const wanted = normaliseHeaderCell(alias);
    const index = normalised.indexOf(wanted);
    if (index !== -1) return index;
  }
  return null;
}

/**
 * Splits one delimited line, honouring RFC 4180 double quoting.
 *
 * Narrations routinely contain the delimiter (`UPI-BLINKIT, MUMBAI`), so a naive `split` loses
 * money on real files. A doubled quote inside a quoted field is one literal quote.
 */
export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char !== '"') {
        current += char;
        continue;
      }
      if (line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/** Splits on any newline convention, so a CRLF export is not one long line. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * The delimiter a file uses, chosen by which one the header line actually contains most of.
 *
 * Guessing rather than configuring, because "the same bank, exported as TSV" is not a
 * different format — it is the same columns with a different separator, and forcing a person
 * to say which would be asking them to debug their own download.
 */
export function detectDelimiter(headerLine: string): string {
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = splitDelimitedLine(headerLine, candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/* --------------------------------------------------------------------------- values */

/** The date layouts real Indian statements print. Tried in the order a format lists them. */
export type StatementDateLayout =
  | 'yyyy-mm-dd'
  | 'dd/mm/yyyy'
  | 'dd/mm/yy'
  | 'dd-mm-yyyy'
  | 'dd-mm-yy'
  | 'dd-mon-yyyy'
  | 'dd-mon-yy'
  | 'dd mon yyyy';

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Reads a date in one of the layouts a format declares, or `null`.
 *
 * Two-digit years resolve into 2000–2099. That is a real assumption and it is written down
 * here rather than hidden: a personal ledger reconciling 1998 statements is not the case this
 * system is for, and silently reading `98` as 2098 would be worse than saying so.
 *
 * Always UTC midnight for a date-only layout — `payments.occurred_at` is a timestamp, and
 * letting the host's timezone decide would move a movement across a period boundary depending
 * on where the import ran.
 */
export function parseStatementDate(
  value: string,
  layouts: readonly StatementDateLayout[],
): Date | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  for (const layout of layouts) {
    const parsed = parseWithLayout(trimmed, layout);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseWithLayout(value: string, layout: StatementDateLayout): Date | null {
  switch (layout) {
    case 'yyyy-mm-dd': {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      return match === null
        ? null
        : buildUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    case 'dd/mm/yyyy': {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
      return match === null
        ? null
        : buildUtcDate(Number(match[3]), Number(match[2]), Number(match[1]));
    }
    case 'dd/mm/yy': {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(value);
      return match === null
        ? null
        : buildUtcDate(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
    }
    case 'dd-mm-yyyy': {
      const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value);
      return match === null
        ? null
        : buildUtcDate(Number(match[3]), Number(match[2]), Number(match[1]));
    }
    case 'dd-mm-yy': {
      const match = /^(\d{1,2})-(\d{1,2})-(\d{2})$/.exec(value);
      return match === null
        ? null
        : buildUtcDate(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
    }
    case 'dd-mon-yyyy':
    case 'dd-mon-yy':
    case 'dd mon yyyy': {
      const separator = layout === 'dd mon yyyy' ? '\\s+' : '-';
      const yearPattern = layout === 'dd-mon-yy' ? '(\\d{2})' : '(\\d{4})';
      const match = new RegExp(
        `^(\\d{1,2})${separator}([A-Za-z]{3,})${separator}${yearPattern}$`,
      ).exec(value);
      if (match === null) return null;
      const month = MONTHS[match[2]!.slice(0, 3).toLowerCase()];
      if (month === undefined) return null;
      const rawYear = Number(match[3]);
      return buildUtcDate(
        layout === 'dd-mon-yy' ? 2000 + rawYear : rawYear,
        month,
        Number(match[1]),
      );
    }
  }
}

/** Rejects an impossible calendar date rather than letting `Date` roll it over silently. */
function buildUtcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** What an amount cell said, once the presentation is stripped off it. */
export interface ParsedAmount {
  /** Always non-negative. */
  readonly magnitude: Paise;
  /** `true` when the cell itself carried a minus sign or bracketed negative. */
  readonly negative: boolean;
}

/**
 * Reads an amount cell into exact paise.
 *
 * Handles what statements actually print: thousands separators in either the Indian
 * (`1,23,456.78`) or Western (`123,456.78`) grouping, a currency symbol or `INR`/`Rs.` prefix,
 * a trailing `Cr`/`Dr` marker, a leading minus, and accounting brackets. Grouping is stripped
 * rather than validated — a bank's own grouping is not something to fail an import over — but
 * the digits themselves are parsed exactly, through `domain.parseMajorUnitsToPaise`.
 *
 * Returns `null` for a blank cell, which is meaningful: in a two-column debit/credit layout an
 * empty cell is how the format says "not this direction".
 */
export function parseStatementAmount(value: string): ParsedAmount | null {
  let text = value.trim();
  if (text === '') return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  const trailing = /\b(cr|dr)\.?$/i.exec(text);
  if (trailing !== null) {
    if (trailing[1]!.toLowerCase() === 'dr') negative = true;
    text = text.slice(0, trailing.index).trim();
  }

  text = text.replace(/^(?:inr|rs\.?|₹)\s*/i, '').trim();

  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }

  text = text.replace(/,/g, '');
  if (text === '' || !/^\d+(?:\.\d{1,2})?$/.test(text)) return null;

  const magnitude = parseMajorUnitsToPaise(text);
  return { magnitude, negative };
}
