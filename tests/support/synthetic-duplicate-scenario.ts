/**
 * A bank account, a credit card and a UPI app over the same weeks, for the duplicate policy
 * (ADR-0070), each drawn in the layout the importer reads.
 *
 * **Everything here is invented** — every name, amount, date and reference, with all-zero
 * reference digits. The statements follow only the *shape* of the kinds of statement the
 * layouts exist for. No real statement's text, figures or measurements may be passed to or
 * added to this file (`fixtures/README.md`).
 *
 * Two things live here. `DUPLICATE_CASES` is a small ledger in which every case has an amount of
 * its own, so any question the queue raises names its case by its amount alone. `ordinaryMonth`
 * is a larger month of ordinary lines on a bank account and a card, drawn from a seeded
 * generator, in which no movement was captured twice.
 */

import { bankStatementPdf } from './synthetic-bank-statement.js';
import type { BankMovement } from './synthetic-bank-statement.js';
import { buildTextPdf } from './synthetic-pdf.js';
import { buildWorkbook } from './synthetic-workbook.js';

/* ------------------------------------------------------------------------------ drawing */

/** `123456` paise as `1,234.56`. */
export function rupees(paise: number): string {
  const whole = Math.floor(paise / 100);
  const fraction = String(paise % 100).padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${fraction}`;
}

/** A bank line without its balance: the statement prints the running balance for it. */
export interface BankLine {
  /** As the bank layout prints it: `05 Jan 2026`. */
  readonly date: string;
  /** One printed line, or several when a long narration wraps inside its cell. */
  readonly description: string | readonly string[];
  readonly reference?: string;
  readonly debit?: number;
  readonly credit?: number;
}

/** A bank-account statement whose printed balances close, from an opening balance in paise. */
export function bankStatement(lines: readonly BankLine[], openingPaise: number): Uint8Array {
  let balance = openingPaise;
  const movements: BankMovement[] = lines.map((line) => {
    balance += (line.credit ?? 0) - (line.debit ?? 0);
    return {
      date: line.date,
      description: typeof line.description === 'string' ? [line.description] : line.description,
      ...(line.reference === undefined ? {} : { reference: line.reference }),
      ...(line.debit === undefined ? {} : { debit: rupees(line.debit) }),
      ...(line.credit === undefined ? {} : { credit: rupees(line.credit) }),
      balance: rupees(balance),
    };
  });
  return bankStatementPdf({ movements, opening: rupees(openingPaise) });
}

/** A card line as the card layout prints it: `05/01/2026 NARRATION 1,234.56 DR`. */
export interface CardLine {
  readonly date: string;
  readonly description: string;
  readonly amount: number;
  readonly type: 'DR' | 'CR';
}

/**
 * A credit-card statement in the card layout's shape.
 *
 * `generatedOn` prints the day it was downloaded in the header, which is how the same statement
 * downloaded twice arrives: the same lines, in a file whose bytes are not the same.
 */
export function cardStatement(
  lines: readonly CardLine[],
  options: { readonly generatedOn?: string } = {},
): Uint8Array {
  const rows = lines.map(
    (line) => `${line.date} ${line.description} ${rupees(line.amount)} ${line.type}`,
  );
  const all = [
    'IDFC FIRST Bank',
    'Credit Card Statement',
    ...(options.generatedOn === undefined ? [] : [`Generated on ${options.generatedOn}`]),
    'FIRST WOW! Credit Card',
    'Card Number XXXX XXXX XXXX 0000',
    'Statement Period 01/01/2026 to 31/01/2026',
    'Total Amount Due 0.00',
    'Minimum Amount Due 0.00',
    'Payment Due Date 18/02/2026',
    'YOUR TRANSACTIONS',
    'Date Transaction Details Amount (INR)',
    ...rows,
    'Pay via our Mobile App',
  ];
  return buildTextPdf(all, { pages: Math.max(1, Math.ceil(all.length / 40)) });
}

/** One row of a UPI app's history export. */
export interface UpiLine {
  /** `12/01/2026`. */
  readonly date: string;
  readonly details: string;
  readonly type: 'DEBIT' | 'CREDIT';
  readonly amount: number;
  readonly utr: string;
}

/** A UPI app's history export, as the CSV its "download" produces. */
export function upiAppExport(lines: readonly UpiLine[]): Uint8Array {
  const rows = lines.map(
    (line) =>
      `${line.date},${line.details},${line.type},${(line.amount / 100).toFixed(2)},${line.utr}`,
  );
  return new TextEncoder().encode(
    ['Date,Transaction Details,Type,Amount,UTR', ...rows].join('\n') + '\n',
  );
}

/* ------------------------------------------------------------------------- the cases */

/**
 * What a case is, which is what the rule should do with it.
 *
 * - `genuine` — one movement captured twice: a person must be asked.
 * - `policy` — the same day, the same amount and the same name, with nothing to tell them apart.
 *   The owner asked for these to be asked about whichever accounts they came from.
 * - `noise` — two movements that merely look alike: asking about them is the defect.
 * - `quiet` — never a question under any rule, kept so a regression that starts asking shows.
 */
export type CaseKind = 'genuine' | 'policy' | 'noise' | 'quiet';

export interface DuplicateCase {
  readonly id: string;
  readonly kind: CaseKind;
  readonly what: string;
  /** Every line of this case moves this amount, and no other case uses it (paise). */
  readonly amount: number;
}

export const DUPLICATE_CASES: readonly DuplicateCase[] = [
  {
    id: 'N1',
    kind: 'noise',
    what: 'card and bank, same day, same amount, unrelated names',
    amount: 2_100,
  },
  {
    id: 'N2',
    kind: 'noise',
    what: 'card and bank, consecutive days, unrelated names',
    amount: 6_200,
  },
  {
    id: 'N3',
    kind: 'noise',
    what: 'card and bank, same day, same name, two different UPI references',
    amount: 25_300,
  },
  {
    id: 'N4',
    kind: 'noise',
    what: 'card and bank, same day, a transfer and an unrelated card purchase',
    amount: 150_400,
  },
  {
    id: 'N5',
    kind: 'noise',
    what: 'card and bank, same day, names sharing only a word',
    amount: 3_300,
  },
  {
    id: 'N6',
    kind: 'noise',
    what: 'one card, two statements, an instalment’s principal and its interest',
    amount: 50_500,
  },
  {
    id: 'N7',
    kind: 'noise',
    what: 'one bank account, two statements, a same-day repeat with its own reference',
    amount: 8_400,
  },
  {
    id: 'G1',
    kind: 'genuine',
    what: 'a UPI app’s copy of a bank line, the same reference in different packaging',
    amount: 34_600,
  },
  {
    id: 'G2',
    kind: 'genuine',
    what: 'a UPI app’s copy of a bank line, a second payee',
    amount: 18_100,
  },
  {
    id: 'G3',
    kind: 'genuine',
    what: 'an overlapping bank statement reprinting a line with no reference',
    amount: 1_234,
  },
  {
    id: 'G4',
    kind: 'genuine',
    what: 'an overlapping card statement reprinting a nameless instalment line',
    amount: 9_900,
  },
  {
    id: 'P1',
    kind: 'policy',
    what: 'card and bank, same day, same name, neither printing a reference',
    amount: 99_900,
  },
  {
    id: 'Q1',
    kind: 'quiet',
    what: 'two lines of one statement, same payee, two references',
    amount: 2_200,
  },
  {
    id: 'Q2',
    kind: 'quiet',
    what: 'card and bank, same name, amounts a rupee apart',
    amount: 15_000,
  },
  { id: 'Q3', kind: 'quiet', what: 'card and bank, same name, two days apart', amount: 40_200 },
];

/**
 * The cases behind the owner's decision of 22 September 2026: the same or a *sufficiently
 * similar* name, a statement downloaded again with its tax lines, and tables arriving beside
 * PDFs. Each has an amount no other case in this file uses.
 */
export const DECISION_CASES: readonly DuplicateCase[] = [
  {
    id: 'S1',
    kind: 'policy',
    what: 'card and bank, one payee, the bank narration carrying a note after it',
    amount: 64_000,
  },
  {
    id: 'S2',
    kind: 'policy',
    what: 'card and bank, one payee, the card descriptor cut short',
    amount: 72_500,
  },
  {
    id: 'S3',
    kind: 'policy',
    what: 'card and bank, a one-word payee, a city on one side and a note on the other',
    amount: 45_600,
  },
  {
    id: 'S4',
    kind: 'noise',
    what: 'card and bank, same day, a note sharing a word with another shop',
    amount: 33_300,
  },
  {
    id: 'T1',
    kind: 'genuine',
    what: 'a card statement downloaded again: its annual fee',
    amount: 99_000,
  },
  {
    id: 'T2',
    kind: 'genuine',
    what: 'a card statement downloaded again: each tax line, beside the same tax',
    amount: 8_910,
  },
  {
    id: 'T3',
    kind: 'genuine',
    what: 'a card statement downloaded again: its purchase',
    amount: 21_000,
  },
  {
    id: 'X1',
    kind: 'policy',
    what: 'a card export and a bank PDF, one payee, a card number and a UPI number',
    amount: 12_300,
  },
  {
    id: 'X2',
    kind: 'genuine',
    what: 'a bank export reprinting a PDF line that has no reference',
    amount: 200_000,
  },
  {
    id: 'X3',
    kind: 'genuine',
    what: 'a line only a generic layout can read, with no reference, printed again',
    amount: 5_500,
  },
  {
    id: 'H1',
    kind: 'genuine',
    what: 'a payment typed by hand with the exact number of one already imported',
    amount: 7_700,
  },
];

/** The case a question belongs to, by the amount both of its payments move. */
export function caseForAmount(amount: bigint | number | string): DuplicateCase | undefined {
  const paise = Number(amount);
  return [...DUPLICATE_CASES, ...DECISION_CASES].find((entry) => entry.amount === paise);
}

/** Bank statement A: the month's first statement. */
export const BANK_A: readonly BankLine[] = [
  {
    date: '05 Jan 2026',
    description: 'UPI/SYNTH TEA STALL/000000000101',
    reference: 'UPI-000000000101',
    debit: 2_100,
  },
  {
    date: '06 Jan 2026',
    description: 'UPI/SYNTH METRO/000000000102',
    reference: 'UPI-000000000102',
    debit: 6_200,
  },
  {
    date: '08 Jan 2026',
    description: 'UPI/SYNTH PHARMACY/000000000103',
    reference: 'UPI-000000000103',
    debit: 25_300,
  },
  {
    date: '09 Jan 2026',
    description: 'IMPS/P2A/000000000104/SYNTH LANDLORD',
    reference: 'IMPS-000000000104',
    debit: 150_400,
  },
  { date: '10 Jan 2026', description: 'POS SYNTH SHOE STORE', debit: 99_900 },
  {
    date: '12 Jan 2026',
    description: 'UPI/SYNTH GROCER/000000000105',
    reference: 'UPI-000000000105',
    debit: 34_600,
  },
  {
    date: '13 Jan 2026',
    description: 'UPI/SYNTH BAKERY/000000000106',
    reference: 'UPI-000000000106',
    debit: 18_100,
  },
  {
    date: '15 Jan 2026',
    description: 'UPI/SYNTH TEA STALL/000000000107',
    reference: 'UPI-000000000107',
    debit: 2_200,
  },
  {
    date: '15 Jan 2026',
    description: 'UPI/SYNTH TEA STALL/000000000108',
    reference: 'UPI-000000000108',
    debit: 2_200,
  },
  {
    date: '20 Jan 2026',
    description: 'UPI/SYNTH JUICE BAR/000000000109',
    reference: 'UPI-000000000109',
    debit: 8_400,
  },
  { date: '21 Jan 2026', description: 'Int.Pd:SYNTHETIC', credit: 1_234 },
  {
    date: '22 Jan 2026',
    description: 'UPI/SYNTH TEA STALL/000000000112',
    reference: 'UPI-000000000112',
    debit: 3_300,
  },
  {
    date: '23 Jan 2026',
    description: 'UPI/SYNTH CAFE/000000000113',
    reference: 'UPI-000000000113',
    debit: 15_000,
  },
  { date: '24 Jan 2026', description: 'POS SYNTH BOOKS', debit: 40_200 },
];
export const BANK_A_OPENING = 10_000_000;

/**
 * Bank statement D, downloaded later: it reprints 20 and 21 January and adds a second juice on
 * the 20th that A was downloaded too early to show.
 */
export const BANK_D: readonly BankLine[] = [
  {
    date: '20 Jan 2026',
    description: 'UPI/SYNTH JUICE BAR/000000000109',
    reference: 'UPI-000000000109',
    debit: 8_400,
  },
  {
    date: '20 Jan 2026',
    description: 'UPI/SYNTH JUICE BAR/000000000110',
    reference: 'UPI-000000000110',
    debit: 8_400,
  },
  { date: '21 Jan 2026', description: 'Int.Pd:SYNTHETIC', credit: 1_234 },
  {
    date: '28 Jan 2026',
    description: 'UPI/SYNTH DAIRY/000000000114',
    reference: 'UPI-000000000114',
    debit: 4_500,
  },
];
export const BANK_D_OPENING = 5_000_000;

/** Card statement B. */
export const CARD_B: readonly CardLine[] = [
  { date: '05/01/2026', description: 'SYNTH BOOK DEPOT MUMBAI', amount: 2_100, type: 'DR' },
  { date: '07/01/2026', description: 'SYNTH CINEMA HALL PUNE', amount: 6_200, type: 'DR' },
  {
    date: '08/01/2026',
    description: 'UPICC/300000000201/SYNTH PHARMACY',
    amount: 25_300,
    type: 'DR',
  },
  { date: '09/01/2026', description: 'SYNTH FUEL STATION DELHI', amount: 150_400, type: 'DR' },
  { date: '10/01/2026', description: 'SYNTH SHOE STORE BANGALORE', amount: 99_900, type: 'DR' },
  { date: '22/01/2026', description: 'SYNTH AUTO STAND PUNE', amount: 3_300, type: 'DR' },
  { date: '23/01/2026', description: 'SYNTH CAFE BANGALORE', amount: 15_100, type: 'DR' },
  { date: '25/01/2026', description: 'EMI INTEREST 3/6', amount: 9_900, type: 'DR' },
  {
    date: '26/01/2026',
    description: 'SYNTH GADGET HUB - PRINCIPAL 2/6',
    amount: 50_500,
    type: 'DR',
  },
  { date: '26/01/2026', description: 'SYNTH BOOKS KOCHI', amount: 40_200, type: 'DR' },
];

/** Card statement E, overlapping B: the instalment interest again, and the plan's interest line. */
export const CARD_E: readonly CardLine[] = [
  { date: '25/01/2026', description: 'EMI INTEREST 3/6', amount: 9_900, type: 'DR' },
  {
    date: '26/01/2026',
    description: 'SYNTH GADGET HUB - INTEREST 2/6',
    amount: 50_500,
    type: 'DR',
  },
  { date: '30/01/2026', description: 'SYNTH HOTEL GOA', amount: 700_000, type: 'DR' },
];

/** The UPI app's history: two of the bank's UPI payments, captured a second time. */
export const UPI_C: readonly UpiLine[] = [
  {
    date: '12/01/2026',
    details: 'Paid to SYNTH GROCER',
    type: 'DEBIT',
    amount: 34_600,
    utr: '000000000105',
  },
  {
    date: '13/01/2026',
    details: 'Paid to SYNTH BAKERY',
    type: 'DEBIT',
    amount: 18_100,
    utr: '000000000106',
  },
];

/* ------------------------------------------------- the owner's decision, 22 September 2026 */

/**
 * A bank statement for mid-January whose UPI narrations carry what a real one does after the
 * payee: the UTR and, often, the payer's own note. The long ones wrap inside their cell.
 */
export const BANK_S: readonly BankLine[] = [
  {
    date: '16 Jan 2026',
    description: ['UPI/SYNTH CAFE/000000000115/', 'Payment from Phone'],
    reference: 'UPI-000000000115',
    debit: 64_000,
  },
  {
    date: '17 Jan 2026',
    description: 'UPI/SYNTH SUPERMARKET/000000000116',
    reference: 'UPI-000000000116',
    debit: 72_500,
  },
  {
    date: '18 Jan 2026',
    description: ['UPI/SAMPLEEATS/000000000117/', 'Payment from Phone'],
    reference: 'UPI-000000000117',
    debit: 45_600,
  },
  {
    date: '19 Jan 2026',
    description: ['UPI/SYNTH TAILOR/000000000120/', 'Payment from Phone'],
    reference: 'UPI-000000000120',
    debit: 33_300,
  },
];
export const BANK_S_OPENING = 20_000_000;

/** The card for the same days: a city after each name, and one descriptor cut short. */
export const CARD_S: readonly CardLine[] = [
  { date: '16/01/2026', description: 'SYNTH CAFE BANGALORE', amount: 64_000, type: 'DR' },
  { date: '17/01/2026', description: 'SYNTH SUPERMARKE MUMBAI', amount: 72_500, type: 'DR' },
  { date: '18/01/2026', description: 'SAMPLEEATS BANGALORE', amount: 45_600, type: 'DR' },
  { date: '19/01/2026', description: 'SYNTH PHONE REPAIR PUNE', amount: 33_300, type: 'DR' },
];

/** Card statement F: an annual fee, the two halves of its tax, and a purchase. */
export const CARD_F: readonly CardLine[] = [
  { date: '05/02/2026', description: 'ANNUAL FEE', amount: 99_000, type: 'DR' },
  { date: '05/02/2026', description: 'CGST', amount: 8_910, type: 'DR' },
  { date: '05/02/2026', description: 'SGST', amount: 8_910, type: 'DR' },
  { date: '06/02/2026', description: 'SYNTH TRAVELS DELHI', amount: 21_000, type: 'DR' },
];

/** The bank's own statement for 2 February, as a PDF. */
export const BANK_G: readonly BankLine[] = [
  {
    date: '02 Feb 2026',
    description: 'UPI/SYNTH CHEMIST/000000000401',
    reference: 'UPI-000000000401',
    debit: 12_300,
  },
  { date: '02 Feb 2026', description: 'ATM WDL SYNTH BRANCH', debit: 200_000 },
  { date: '02 Feb 2026', description: 'UPI/000000000403', debit: 5_500 },
];
export const BANK_G_OPENING = 1_000_000;

/** A bank statement with one UPI payment, which somebody later also types in by hand. */
export const BANK_H: readonly BankLine[] = [
  {
    date: '03 Feb 2026',
    description: 'UPI/SYNTH NEWSAGENT/000000000501',
    reference: 'UPI-000000000501',
    debit: 7_700,
  },
];
export const BANK_H_OPENING = 500_000;

/**
 * The same day downloaded from the bank's website as a table, in a layout with withdrawal and
 * deposit columns. `lineEnding` re-saves the same rows as different bytes.
 */
export function bankExportCsv(lineEnding = '\n'): Uint8Array {
  const rows = [
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    '02/02/26,UPI/SYNTH CHEMIST/000000000401,UPI-000000000401,02/02/26,123.00,0.00,"9,877.00"',
    '02/02/26,ATM WDL SYNTH BRANCH,,02/02/26,"2,000.00",0.00,"7,877.00"',
  ];
  return new TextEncoder().encode(rows.join(lineEnding) + lineEnding);
}

/** The card's export for the same day, as a workbook: the chemist, paid on the card. */
export function cardExportXlsx(): Uint8Array {
  return buildWorkbook([
    ['Transaction Date', 'Transaction Description', 'Amount', 'Debit/Credit', 'Reference'],
    ['02/02/2026', 'SYNTH CHEMIST PUNE', '123.00', 'Debit', 'CARD/000000000402'],
  ]);
}

/**
 * A table in the one layout nothing can recognise on its own — a date, a description and one
 * signed amount — so the person importing it has to choose the layout as well as the kind of
 * account. It carries no reference column.
 */
export function signedAmountCsv(): Uint8Array {
  return new TextEncoder().encode(
    ['Date,Description,Amount', '2026-02-02,UPI/000000000403,-55.00'].join('\n') + '\n',
  );
}

/* --------------------------------------------------------------------- an ordinary month */

/** mulberry32: a small seeded generator, so the month is the same month every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Everyday amounts, in paise — few enough that one day repeats them, which is the point. */
const EVERYDAY = [2_000, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 12_000, 15_000, 20_000, 25_000];

const BANK_PAYEES = [
  'SYNTH TEA STALL',
  'SYNTH AUTO RIDE',
  'SYNTH METRO',
  'SYNTH GROCER',
  'SYNTH PHARMACY',
  'SYNTH JUICE BAR',
  'SYNTH BAKERY',
  'SYNTH DAIRY',
  'SYNTH PAN SHOP',
  'SYNTH LAUNDRY',
];
const CARD_MERCHANTS = [
  'SYNTH BOOK DEPOT',
  'SYNTH CINEMA HALL',
  'SYNTH FUEL STATION',
  'SYNTH SHOE STORE',
  'SYNTH ELECTRONICS',
  'SYNTH HOTEL',
  'SYNTH GROCER',
  'SYNTH PHARMACY',
];
const CITIES = ['MUMBAI', 'PUNE', 'BANGALORE', 'DELHI'];
const MONTHS = ['Jan'];

/**
 * The shop an ordinary month's line was drawn for, recovered from the way this file printed it:
 * `UPI/<shop>/<number>`, `UPICC/<number>/<shop>`, or `<shop> <CITY>`.
 */
export function shopOf(description: string): string {
  const bankUpi = /^UPI\/([^/]+)\//.exec(description);
  if (bankUpi !== null) return bankUpi[1]!;
  const cardUpi = /^UPICC\/\d+\/(.+)$/.exec(description);
  if (cardUpi !== null) return cardUpi[1]!;
  return description.replace(new RegExp(` (?:${CITIES.join('|')})$`), '');
}

export interface OrdinaryMonth {
  readonly bank: readonly BankLine[];
  readonly card: readonly CardLine[];
}

/**
 * A month in which nothing was captured twice: `bankPerDay` UPI payments a day on the bank
 * account, and `cardPerDay` purchases a day on the card — half of them card-rail UPI payments,
 * half plain descriptors with a city. Two of the card's merchants share a name with a bank payee,
 * so the same shop does turn up on both on some days.
 */
export function ordinaryMonth(seed = 7, bankPerDay = 6, cardPerDay = 2): OrdinaryMonth {
  const next = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const bank: BankLine[] = [];
  const card: CardLine[] = [];
  let bankRef = 0;
  let cardRef = 0;
  for (let day = 1; day <= 31; day += 1) {
    const dd = String(day).padStart(2, '0');
    for (let index = 0; index < bankPerDay; index += 1) {
      bankRef += 1;
      const ref = String(bankRef).padStart(12, '0');
      bank.push({
        date: `${dd} ${MONTHS[0]} 2026`,
        description: `UPI/${pick(BANK_PAYEES)}/${ref}`,
        reference: `UPI-${ref}`,
        debit: pick(EVERYDAY),
      });
    }
    for (let index = 0; index < cardPerDay; index += 1) {
      const merchant = pick(CARD_MERCHANTS);
      const amount = pick(EVERYDAY);
      if (next() < 0.5) {
        cardRef += 1;
        card.push({
          date: `${dd}/01/2026`,
          description: `UPICC/3${String(cardRef).padStart(11, '0')}/${merchant}`,
          amount,
          type: 'DR',
        });
      } else {
        card.push({
          date: `${dd}/01/2026`,
          description: `${merchant} ${pick(CITIES)}`,
          amount,
          type: 'DR',
        });
      }
    }
  }
  return { bank, card };
}
