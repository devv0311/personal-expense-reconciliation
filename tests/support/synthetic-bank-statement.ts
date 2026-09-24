/**
 * A synthetic bank-account statement in the columnar layout ADR-0066 reads, drawn as a real PDF.
 *
 * **Everything here is invented.** Fictional names, all-zero reference digits, round amounts,
 * and positions this file chose. Only the *shape* follows the kind of statement the layout
 * exists for: which columns there are, that a cell starts a little left of its heading, that
 * money is right-aligned, that every page repeats its furniture. No real statement's text,
 * figures or measurements may be passed to or added to this file (`fixtures/README.md`).
 *
 * Shared by the reader's own tests and the import tests, so both read the same document.
 */

import { buildPlacedTextPdf, placedTextWidth } from './synthetic-pdf.js';
import type { PlacedText } from './synthetic-pdf.js';

/** Where each column's heading starts. Chosen for these tests; not measured from anything. */
export const BANK_COLUMN_X = {
  serial: 40,
  date: 70,
  description: 150,
  reference: 360,
  debit: 470,
  credit: 575,
  balance: 670,
} as const;
type Column = keyof typeof BANK_COLUMN_X;

const LABEL: Record<Column, string> = {
  serial: '#',
  date: 'Date',
  description: 'Description',
  reference: 'Chq/Ref. No.',
  debit: 'Withdrawal (Dr.)',
  credit: 'Deposit (Cr.)',
  balance: 'Balance',
};

/** A cell's text starts a little left of its heading, as a table renderer pads it. */
const INSET = 5;
/** Money is right-aligned a little past its heading's right edge, by a different amount per column. */
const RIGHT_PAD: Record<'debit' | 'credit' | 'balance', number> = {
  debit: 3,
  credit: 9,
  balance: 20,
};

const cell = (column: Column, text: string): PlacedText => ({
  text,
  x: BANK_COLUMN_X[column] - INSET,
});
const money = (column: 'debit' | 'credit' | 'balance', text: string): PlacedText => ({
  text,
  x: BANK_COLUMN_X[column] + placedTextWidth(LABEL[column]) + RIGHT_PAD[column],
  align: 'right',
});

export const BANK_HEADER: PlacedText[] = (Object.keys(BANK_COLUMN_X) as Column[]).map((column) => ({
  text: LABEL[column],
  x: BANK_COLUMN_X[column],
}));

export type BankLine = PlacedText[];

export interface BankMovement {
  readonly date: string;
  /** One entry per printed line of the description cell. */
  readonly description: readonly string[];
  readonly reference?: string;
  readonly debit?: string;
  readonly credit?: string;
  readonly balance: string;
  /** Printed row number; defaults to the row's position. */
  readonly serial?: string;
}

/** A movement's printed lines: numbers and date first, money on the last line. */
export function bankRowLines(movement: BankMovement, position: number): BankLine[] {
  const lines: BankLine[] = movement.description.map((text) => [cell('description', text)]);
  lines[0]!.unshift(
    cell('serial', movement.serial ?? String(position)),
    cell('date', movement.date),
  );
  const last = lines[lines.length - 1]!;
  if (movement.reference !== undefined) last.push(cell('reference', movement.reference));
  if (movement.debit !== undefined) last.push(money('debit', movement.debit));
  if (movement.credit !== undefined) last.push(money('credit', movement.credit));
  last.push(money('balance', movement.balance));
  return lines;
}

const furniture: BankLine[] = [
  [{ text: 'Account Statement 01 Jan 2026 - 31 Jan 2026', x: 300 }],
  [{ text: 'Account No. XXXXXXXX0000', x: 30 }],
];
const section = (title: string): BankLine[] => [
  [{ text: `${title} Account Transactions`, x: 350 }],
  BANK_HEADER,
];
const pageBottom = (page: number, of: number): BankLine[] => [
  // Left-margin furniture that matches no declared pattern: skipped because it is not a row
  // and does not start where a cell starts.
  [{ text: 'This is a computer generated statement.', x: 30 }],
  [{ text: `Statement Generated on 01 Feb 2026, 10:00 Page ${page} of ${of}`, x: 300 }],
];
const accountBlock: BankLine[] = [
  [{ text: 'Customer Name SYNTHETIC HOLDER', x: 30 }],
  [{ text: 'Account Type Savings', x: 30 }],
  [{ text: 'Branch SYNTHETIC BRANCH', x: 30 }],
];
export const bankOpeningRow = (balance: string): BankLine => [
  cell('serial', '-'),
  cell('date', '-'),
  cell('description', 'Opening Balance'),
  cell('reference', '-'),
  money('debit', '-'),
  money('credit', '-'),
  money('balance', balance),
];
/** The statement's own summary, drawn with money exactly where the table's money sits. */
const summaryPage: BankLine[] = [
  [{ text: 'End of Statement', x: 380 }],
  [{ text: 'Account Summary', x: 360 }],
  [
    { text: 'Account', x: 30 },
    { text: 'Opening Balance', x: 300 },
    { text: 'Closing Balance', x: 500 },
  ],
  [
    { text: 'Savings Account XXXX0000', x: 30 },
    money('debit', '1,000.00'),
    money('credit', '9,999.99'),
  ],
];

/** The ordinary statement every test starts from. Its balances close day by day. */
export const SYNTHETIC_BANK_MOVEMENTS: readonly BankMovement[] = [
  {
    date: '02 Jan 2026',
    description: ['UPI/SYNTHETIC GROCER/000000000001'],
    reference: 'UPI-000000000001',
    debit: '250.00',
    balance: '9,750.00',
  },
  {
    date: '02 Jan 2026',
    description: ['IMPS/P2A/000000000002/SYNTH', 'PERSON'],
    reference: 'IMPS-000000000002',
    credit: '1,000.00',
    balance: '10,750.00',
  },
  {
    date: '03 Jan 2026',
    description: ['Int.Pd:SYNTHETIC'],
    credit: '12.34',
    balance: '10,762.34',
  },
  {
    date: '05 Jan 2026',
    description: ['NEFT SYNTHETIC EMPLOYER', 'SALARY CREDIT'],
    reference: '000000000004',
    credit: '50,000.00',
    balance: '60,762.34',
  },
  {
    date: '05 Jan 2026',
    description: ['UPI/SYNTH BILLER/000000000005'],
    reference: 'UPI-000000000005',
    debit: '1,234.56',
    balance: '59,527.78',
  },
];

export interface BankStatementOptions {
  readonly movements?: readonly BankMovement[];
  readonly opening?: string | null;
  readonly title?: string;
  /** Rows on the first page; the rest go on the second. */
  readonly firstPageRows?: number;
  /** Repeat the column header on the second page. */
  readonly headerOnEveryPage?: boolean;
  /** Break the page after this many printed lines of the given row. */
  readonly splitRow?: { readonly index: number; readonly afterLines: number };
  readonly withSummary?: boolean;
}

export function bankStatementPdf(options: BankStatementOptions = {}): Uint8Array {
  const movements = options.movements ?? SYNTHETIC_BANK_MOVEMENTS;
  const title = options.title ?? 'Savings';
  const firstPageRows = options.firstPageRows ?? movements.length;
  const rows = movements.map((movement, index) => bankRowLines(movement, index + 1));

  const first: BankLine[] = [...furniture, ...accountBlock, ...section(title)];
  const firstBody: BankLine[] = [];
  if (options.opening !== null) firstBody.push(bankOpeningRow(options.opening ?? '10,000.00'));
  const second: BankLine[] =
    options.headerOnEveryPage === false ? [...furniture] : [...furniture, ...section(title)];
  const secondBody: BankLine[] = [];

  rows.forEach((lines, index) => {
    if (options.splitRow?.index === index) {
      firstBody.push(...lines.slice(0, options.splitRow.afterLines));
      secondBody.push(...lines.slice(options.splitRow.afterLines));
      return;
    }
    (index < firstPageRows ? firstBody : secondBody).push(...lines);
  });

  const pages: BankLine[][] = [[...first, ...firstBody, ...pageBottom(1, 2)]];
  if (secondBody.length > 0 || options.withSummary === true) {
    pages.push([...second, ...secondBody, ...pageBottom(2, 2)]);
  }
  if (options.withSummary === true) pages.push(summaryPage);
  return buildPlacedTextPdf(pages);
}
