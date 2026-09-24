/**
 * Reading a PDF statement drawn as a table, by where each value sits (ADR-0066).
 *
 * A bank-account statement prints a withdrawal and a deposit as two columns, fills one, and
 * leaves the other empty. An empty cell leaves no trace in a PDF's text, so a line reads
 * `… 250.00 9,750.00` whichever column the 250.00 was printed in — the one fact that says which
 * way the money went is **where** it was printed. This reader assigns every word PDF.js returns
 * to a column by its position under the page's own headings, and takes the direction from the
 * column. Nothing is inferred from the narration, and nothing from the balance.
 *
 * The balance is used for something else: proof. After every row is read, the statement's own
 * printed balances must close day by day (`domain.reconcilePrintedBalancesByDay`). A row this
 * reader skipped, read at the wrong size or put in the wrong column makes its day fail to close,
 * and then **nothing** is imported. The printed row numbers must also run without a gap. Together
 * those two checks are what let a PDF import say it is complete rather than "check the count
 * against the statement yourself".
 *
 * Four structural rules come from how such a statement is actually drawn:
 *
 *  - **A row runs from its number to the next row's number**, not to its first amount. A row the
 *    page broke in two carries its tail — sometimes the reference and the money too — onto the
 *    next page, below that page's headings.
 *  - **A continuation line must start where a cell starts.** Page furniture, disclaimers and the
 *    summary are drawn elsewhere on the page; only a line whose first word sits at a description
 *    or reference cell's edge, or a line of money, belongs to the row above it.
 *  - **Money is right-aligned**, so an amount belongs to the money heading whose right edge it
 *    ends nearest — and one that sits between two headings is refused, not assigned.
 *  - **A page may omit the headings**; it is read with the last headings the document printed.
 *
 * Errors name a line and never quote it. A row of a PDF is a line of somebody's statement, and an
 * error message is not a place for it (`security-model.md`, the sixth pillar).
 */

import { paise, reconcilePrintedBalancesByDay } from '../../domain/index.js';
import type { Paise, PaymentDirection } from '../../domain/index.js';

import type { PdfColumnLayout, PdfLinePattern } from './formats.js';
import type { PdfLineLayout, PdfTextItem, PdfTextResult } from './pdf-text.js';
import { parseStatementAmount, parseStatementDate, referenceTypeFromPrefixes } from './table.js';
import type { StatementRow, StatementRowError } from './types.js';

export interface ColumnarReadResult {
  readonly rows: readonly StatementRow[];
  /** Every row this layout recognised and could not read, and every failed check. */
  readonly rowErrors: readonly StatementRowError[];
  /** Whether the document ever printed the headings this layout reads by. */
  readonly headerFound: boolean;
  /**
   * Rows whose printed balance follows the bank's own order within a day rather than the order
   * the rows were printed in. Every day still closed; this is said, not refused.
   */
  readonly rowsOutOfBankOrder: number;
}

type TextColumn = 'serial' | 'date' | 'description' | 'reference';
type MoneyColumn = 'debit' | 'credit' | 'balance';

/** Where one page's headings sit. */
interface Anchors {
  /** Left edge of each text column's heading. */
  readonly textLeft: Readonly<Record<TextColumn, number>>;
  /** Right edge of each money column's heading label. */
  readonly moneyRight: Readonly<Record<MoneyColumn, number>>;
  /** Left edge of the first money heading: money ends to the right of it. */
  readonly moneyStart: number;
  /** How far left of its heading a cell's text starts. */
  readonly cellInset: number;
}

/** How close a word must sit to a cell's edge to be taken as starting that cell. */
const EDGE_TOLERANCE = 3;
/** The least difference, in PDF units, between an amount's two nearest money headings. */
const MONEY_MARGIN = 10;
const AMOUNT_SHAPE = /^-?[\d,]+\.\d{2}$/;
const TEXT_COLUMNS: readonly TextColumn[] = ['serial', 'date', 'description', 'reference'];
const MONEY_COLUMNS: readonly MoneyColumn[] = ['debit', 'credit', 'balance'];

interface PendingRow {
  readonly lineNumber: number;
  readonly lines: { readonly items: readonly PdfTextItem[]; readonly anchors: Anchors }[];
}

/**
 * Reads every row of a columnar statement, or explains which could not be read.
 *
 * Returns rows and errors together, like the line reader it sits beside; the caller refuses the
 * whole file when `rowErrors` is non-empty.
 */
export function readColumnarPdfRows(
  text: PdfTextResult,
  pattern: PdfLinePattern & { readonly columns: PdfColumnLayout },
): ColumnarReadResult {
  const layout = pattern.columns;
  const positions = text.layout ?? [];
  // Positions are what this reader reads. A document without them was read by a reader that
  // does not know where anything was, and nothing here can stand in for that.
  if (positions.length !== text.lines.length) {
    return { rows: [], rowErrors: [], headerFound: false, rowsOutOfBankOrder: 0 };
  }

  let anchors: Anchors | null = null;
  let headerFound = false;
  let opening: Paise | null = null;
  const pending: PendingRow[] = [];

  for (let index = 0; index < text.lines.length; index += 1) {
    const line = text.lines[index]!;
    const place = positions[index]!;

    const heading = readHeading(place, layout);
    if (heading !== null) {
      anchors = heading;
      headerFound = true;
      continue;
    }
    if (layout.furniture.some((furniture) => furniture.test(line))) continue;
    if (anchors === null) continue;

    const cells = assign(place.items, anchors);
    if (startsRow(place.items, cells, anchors, layout)) {
      pending.push({ lineNumber: index + 1, lines: [{ items: place.items, anchors }] });
      continue;
    }

    if (pending.length === 0) {
      // Before the first row, the one line worth reading is the opening balance.
      if (opening === null && layout.openingBalance.test(cells.text.description.join(' '))) {
        const balances = cells.money.filter((entry) => entry.column === 'balance');
        const parsed = balances.length === 1 ? parseStatementAmount(balances[0]!.item.text) : null;
        if (parsed !== null) opening = signed(parsed.magnitude, parsed.negative);
      }
      continue;
    }

    if (continuesRow(place.items, cells, anchors, layout)) {
      pending[pending.length - 1]!.lines.push({ items: place.items, anchors });
      continue;
    }

    // Only a line that belongs to no row can end the table: a row whose description happens to
    // mention a closing balance is still a row.
    if (layout.tableEnd.test(line)) {
      const late = rowAfterTheEnd(text, positions, index + 1, anchors, layout);
      if (late !== null) {
        return {
          rows: [],
          rowErrors: [
            error(
              late,
              'This statement prints a row after its own summary, so where its table ends ' +
                'cannot be told apart from where this reader stopped.',
            ),
          ],
          headerFound,
          rowsOutOfBankOrder: 0,
        };
      }
      break;
    }
  }

  return finish(pending, opening, headerFound, pattern);
}

/**
 * The first row printed after the summary, if any, as a 1-based line number.
 *
 * A summary is the end of the table only if nothing after it is a row. Otherwise stopping there
 * would drop the rest of the statement without a single failed check — the rows it never read
 * would simply not exist — so it is refused instead.
 */
function rowAfterTheEnd(
  text: PdfTextResult,
  positions: readonly PdfLineLayout[],
  from: number,
  anchors: Anchors,
  layout: PdfColumnLayout,
): number | null {
  let current = anchors;
  for (let index = from; index < text.lines.length; index += 1) {
    const place = positions[index]!;
    const heading = readHeading(place, layout);
    if (heading !== null) {
      current = heading;
      continue;
    }
    if (startsRow(place.items, assign(place.items, current), current, layout)) return index + 1;
  }
  return null;
}

/* ------------------------------------------------------------------------------ rows */

function finish(
  pending: readonly PendingRow[],
  opening: Paise | null,
  headerFound: boolean,
  pattern: PdfLinePattern & { readonly columns: PdfColumnLayout },
): ColumnarReadResult {
  const rows: StatementRow[] = [];
  const rowErrors: StatementRowError[] = [];
  let expectedSerial = 1;

  for (const row of pending) {
    const cells = collect(row);
    const serial = Number(cells.serial);
    if (!Number.isInteger(serial) || serial !== expectedSerial) {
      rowErrors.push(
        error(
          row.lineNumber,
          `The statement numbers its rows, and row ${String(expectedSerial)} is not where it ` +
            'should be, so at least one movement was not read.',
        ),
      );
      // Keep counting from what was printed, so one gap is reported once, not on every row after.
      expectedSerial = Number.isInteger(serial) ? serial + 1 : expectedSerial + 1;
      continue;
    }
    expectedSerial += 1;

    const read = readRow(row.lineNumber, cells, pattern);
    if ('error' in read) rowErrors.push(read.error);
    else rows.push(read.row);
  }

  if (rowErrors.length > 0 || rows.length === 0) {
    return { rows, rowErrors, headerFound, rowsOutOfBankOrder: 0 };
  }

  if (opening === null) {
    return {
      rows,
      rowErrors: [
        error(
          pending[0]!.lineNumber,
          'This statement prints no opening balance row, so its first day cannot be checked ' +
            'against the balances it printed.',
        ),
      ],
      headerFound,
      rowsOutOfBankOrder: 0,
    };
  }

  const verdict = reconcilePrintedBalancesByDay(
    opening,
    rows.map((row) => ({
      occurredAt: row.occurredAt,
      amount: row.amount,
      direction: row.direction,
      printedBalance: row.runningBalance!,
    })),
  );
  if (!verdict.ok) {
    return {
      rows,
      rowErrors: [
        error(
          rows[verdict.failingRun.firstRowIndex]!.lineNumber,
          'The balance this statement printed at the end of the day this line begins does not ' +
            'follow from that day’s movements, so at least one of them was not read correctly.',
        ),
      ],
      headerFound,
      rowsOutOfBankOrder: 0,
    };
  }

  return { rows, rowErrors, headerFound, rowsOutOfBankOrder: verdict.rowsOutOfBankOrder };
}

interface RowCells {
  readonly serial: string;
  readonly date: string;
  readonly description: string;
  readonly reference: string;
  readonly money: readonly MoneyEntry[];
  readonly strayText: boolean;
}

function collect(row: PendingRow): RowCells {
  const text: Record<TextColumn, string[]> = {
    serial: [],
    date: [],
    description: [],
    reference: [],
  };
  const money: MoneyEntry[] = [];
  let strayText = false;
  for (const line of row.lines) {
    const cells = assign(line.items, line.anchors);
    // Words on one line are joined by a space; so are the lines of a wrapped description.
    for (const column of TEXT_COLUMNS) {
      if (cells.text[column].length > 0) text[column].push(cells.text[column].join(' '));
    }
    money.push(...cells.money);
    strayText ||= cells.strayText;
  }
  return {
    serial: text.serial.join(' '),
    date: text.date.join(' '),
    description: text.description.join(' '),
    // An identifier has no spaces; one that wrapped is one identifier.
    reference: text.reference.join('').replace(/\s+/g, ''),
    money,
    strayText,
  };
}

function readRow(
  lineNumber: number,
  cells: RowCells,
  pattern: PdfLinePattern,
): { readonly row: StatementRow } | { readonly error: StatementRowError } {
  const occurredAt = parseStatementDate(cells.date, pattern.dateLayouts);
  if (occurredAt === null)
    return { error: rowError(lineNumber, 'its date is not a real calendar date') };
  if (cells.description === '') return { error: rowError(lineNumber, 'it carries no description') };
  if (cells.strayText) {
    return { error: rowError(lineNumber, 'it has words where an amount belongs') };
  }
  if (cells.money.some((entry) => entry.column === null)) {
    return { error: rowError(lineNumber, 'an amount sits between two columns') };
  }

  const moves = cells.money.filter(
    (entry) => entry.column === 'debit' || entry.column === 'credit',
  );
  const balances = cells.money.filter((entry) => entry.column === 'balance');
  if (moves.length === 0) {
    return {
      error: rowError(
        lineNumber,
        'it has no amount in either the withdrawal or the deposit column',
      ),
    };
  }
  if (moves.length > 1) {
    return {
      error: rowError(lineNumber, 'it has amounts in both the withdrawal and the deposit columns'),
    };
  }
  if (balances.length !== 1) {
    return { error: rowError(lineNumber, 'it does not print exactly one balance') };
  }

  const move = moves[0]!;
  const amount = parseStatementAmount(move.item.text);
  if (amount === null)
    return { error: rowError(lineNumber, 'its amount could not be read as money') };
  if (amount.negative) {
    return {
      error: rowError(
        lineNumber,
        'it prints a negative amount, so which way the money went cannot be read from its column',
      ),
    };
  }
  if (amount.magnitude === 0n) return { error: rowError(lineNumber, 'its amount is zero') };

  const balance = parseStatementAmount(balances[0]!.item.text);
  if (balance === null) return { error: rowError(lineNumber, 'its balance could not be read') };

  const direction: PaymentDirection = move.column === 'debit' ? 'debit' : 'credit';
  const reference = cells.reference === '' || cells.reference === '-' ? null : cells.reference;
  return {
    row: {
      lineNumber,
      occurredAt,
      rawDescription: cells.description,
      amount: amount.magnitude,
      direction,
      externalReference: reference,
      referenceType:
        reference === null
          ? null
          : referenceTypeFromPrefixes(
              reference,
              cells.description,
              pattern.referencePrefixes,
              pattern.defaultReferenceType,
            ),
      runningBalance: signed(balance.magnitude, balance.negative),
    },
  };
}

/* ------------------------------------------------------------------------- geometry */

/** Recognises a heading row and measures it, or returns `null`. */
function readHeading(place: PdfLineLayout, layout: PdfColumnLayout): Anchors | null {
  const items = place.items;
  const indexes: Record<TextColumn | MoneyColumn, number> = {
    serial: -1,
    date: -1,
    description: -1,
    reference: -1,
    debit: -1,
    credit: -1,
    balance: -1,
  };
  const order = [...TEXT_COLUMNS, ...MONEY_COLUMNS];
  let from = 0;
  for (const column of order) {
    const found = items.findIndex(
      (item, index) => index >= from && layout.headers[column].test(item.text.trim()),
    );
    if (found < 0) return null;
    indexes[column] = found;
    from = found + 1;
  }

  // A heading label may be several words; its right edge is that of its last word before the
  // next heading begins (or the end of the line, for the last heading).
  const labelRight = (column: MoneyColumn): number => {
    const position = order.indexOf(column);
    const end = position + 1 < order.length ? indexes[order[position + 1]!] : items.length;
    return Math.max(...items.slice(indexes[column], end).map((item) => item.right));
  };

  return {
    textLeft: {
      serial: items[indexes.serial]!.left,
      date: items[indexes.date]!.left,
      description: items[indexes.description]!.left,
      reference: items[indexes.reference]!.left,
    },
    moneyRight: {
      debit: labelRight('debit'),
      credit: labelRight('credit'),
      balance: labelRight('balance'),
    },
    moneyStart: items[indexes.debit]!.left,
    cellInset: layout.cellInset,
  };
}

interface MoneyEntry {
  readonly item: PdfTextItem;
  /** `null` when the amount sits too near two headings to say which it belongs to. */
  readonly column: MoneyColumn | null;
}

interface AssignedCells {
  readonly text: Record<TextColumn, string[]>;
  readonly money: MoneyEntry[];
  /** Words, other than an empty-cell dash, printed where only money belongs. */
  readonly strayText: boolean;
}

function assign(items: readonly PdfTextItem[], anchors: Anchors): AssignedCells {
  const text: Record<TextColumn, string[]> = {
    serial: [],
    date: [],
    description: [],
    reference: [],
  };
  const money: MoneyEntry[] = [];
  let strayText = false;

  for (const item of items) {
    const word = item.text.trim();
    // Money is right-aligned, so it is judged by where it ends: a long amount can start left of
    // its own heading. A word is judged by where it starts.
    if ((AMOUNT_SHAPE.test(word) || word === '-') && item.right > anchors.moneyStart) {
      if (word !== '-') money.push({ item, column: moneyColumn(item, anchors) });
      continue;
    }
    if (item.left >= cellStart(anchors.moneyStart, anchors) - EDGE_TOLERANCE) {
      strayText = true;
      continue;
    }
    text[textColumn(item, anchors)].push(word);
  }
  return { text, money, strayText };
}

function textColumn(item: PdfTextItem, anchors: Anchors): TextColumn {
  let column: TextColumn = 'serial';
  for (const candidate of TEXT_COLUMNS) {
    if (item.left >= cellStart(anchors.textLeft[candidate], anchors) - EDGE_TOLERANCE) {
      column = candidate;
    }
  }
  return column;
}

/** Where a cell's text starts, given its heading's left edge. */
function cellStart(headingLeft: number, anchors: Anchors): number {
  return headingLeft - anchors.cellInset;
}

function moneyColumn(item: PdfTextItem, anchors: Anchors): MoneyColumn | null {
  const ranked = MONEY_COLUMNS.map((column) => ({
    column,
    distance: Math.abs(item.right - anchors.moneyRight[column]),
  })).sort((left, right) => left.distance - right.distance);
  const [nearest, second] = ranked;
  return second!.distance - nearest!.distance >= MONEY_MARGIN ? nearest!.column : null;
}

/** A row starts with its number at the number column's edge and a date beside it. */
function startsRow(
  items: readonly PdfTextItem[],
  cells: AssignedCells,
  anchors: Anchors,
  layout: PdfColumnLayout,
): boolean {
  const first = items[0];
  if (first === undefined || !atCellEdge(first, anchors.textLeft.serial, layout)) return false;
  return /^\d{1,6}$/.test(cells.text.serial.join(' ')) && cells.text.date.length > 0;
}

/** A continuation starts where a description or reference cell starts, or is a line of money. */
function continuesRow(
  items: readonly PdfTextItem[],
  cells: AssignedCells,
  anchors: Anchors,
  layout: PdfColumnLayout,
): boolean {
  const first = items[0];
  if (first === undefined) return false;
  if (atCellEdge(first, anchors.textLeft.description, layout)) return true;
  if (atCellEdge(first, anchors.textLeft.reference, layout)) return true;
  return first.right > anchors.moneyStart && cells.money.length > 0 && !cells.strayText;
}

function atCellEdge(item: PdfTextItem, headingLeft: number, layout: PdfColumnLayout): boolean {
  return Math.abs(item.left - (headingLeft - layout.cellInset)) <= EDGE_TOLERANCE;
}

/* ---------------------------------------------------------------------------- values */

function signed(magnitude: Paise, negative: boolean): Paise {
  return paise(negative ? -(magnitude as bigint) : magnitude);
}

function rowError(lineNumber: number, problem: string): StatementRowError {
  return error(
    lineNumber,
    `This line begins a statement row, but ${problem}, so it could not be read.`,
  );
}

function error(lineNumber: number, message: string): StatementRowError {
  return {
    lineNumber,
    column: null,
    rawValue: null,
    message:
      `${message} Nothing was imported — importing the rest would leave the ledger short by ` +
      'exactly this movement while appearing to have succeeded.',
  };
}
