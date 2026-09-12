/**
 * The statement formats this build actually reads, as declarations rather than code.
 *
 * The audit's row 02: *"Bank-specific CSV mapping, UPI exports, XLSX/PDF transaction
 * extraction, cash/manual movement entry and email forwarding are unbuilt."* Everything except
 * the last two is here; those two are `services.recordManualPayment` and
 * `services.ingestForwardedMessage` respectively.
 *
 * A format is a **description of columns**, not a parser: which header names carry the date,
 * the narration, the money and the reference, how the date is written, and how direction is
 * expressed. `parseStatement` reads all of them with one code path, which is what makes adding
 * the next bank a five-line declaration rather than a new file to keep in step.
 *
 * Two rules hold for every entry:
 *
 *  - **A format may not say what a payment was for.** There is no field for it here and none on
 *    {@link StatementRow}. `NEFT TRANSFER TO SELF` is a debit with that narration until
 *    classification says otherwise (`data-flow.md` steps 2–3).
 *  - **A format names its own institution, never guesses one.** `sourceSystem` still comes from
 *    the caller, because the same column shape is exported by more than one bank and inventing
 *    a provenance is worse than asking.
 */

import type { PaymentChannel, PaymentReferenceType } from '../../domain/index.js';

import type { StatementDateLayout } from './table.js';
import type { StatementContainer } from './types.js';

/** How a format expresses which way the money went. */
export type DirectionStyle =
  /** Two columns; whichever is non-blank names the direction. */
  | { readonly kind: 'debit_credit_columns' }
  /** One amount column plus a column holding a word like `DEBIT`/`CR`/`Money Out`. */
  | {
      readonly kind: 'type_column';
      readonly debitWords: readonly string[];
      readonly creditWords: readonly string[];
    }
  /** One signed amount column: negative is a debit. */
  | { readonly kind: 'signed_amount' };

export interface StatementFormat {
  readonly id: string;
  readonly label: string;
  readonly container: StatementContainer;
  readonly channel: PaymentChannel;
  /** What a person choosing between two formats sees. */
  readonly headerHint: string;
  /** Header aliases, most-preferred first. */
  readonly dateColumns: readonly string[];
  readonly descriptionColumns: readonly string[];
  readonly amountColumns: readonly string[];
  readonly debitColumns: readonly string[];
  readonly creditColumns: readonly string[];
  readonly typeColumns: readonly string[];
  readonly referenceColumns: readonly string[];
  readonly balanceColumns: readonly string[];
  readonly direction: DirectionStyle;
  readonly dateLayouts: readonly StatementDateLayout[];
  /**
   * How this source's reference strings map onto `payments.reference_type`.
   *
   * Format knowledge, local to the declaration. An unrecognised prefix becomes the format's
   * `defaultReferenceType` rather than a guess; the reference itself is stored verbatim
   * either way, so nothing is lost by declining to categorise it.
   */
  readonly referencePrefixes: ReadonlyArray<readonly [string, PaymentReferenceType]>;
  readonly defaultReferenceType: PaymentReferenceType | null;
  /**
   * Rows whose *description* matches are skipped as presentation rather than movements —
   * an opening-balance line, a carried-forward line, a page footer.
   */
  readonly skipDescriptionPatterns: readonly RegExp[];
  /** `true` when auto-detection may pick this format from content alone. */
  readonly detectable: boolean;
}

const UPI_PREFIXES: ReadonlyArray<readonly [string, PaymentReferenceType]> = [
  ['UPI/', 'upi_utr'],
  ['UPI-', 'upi_utr'],
];

const BANK_PREFIXES: ReadonlyArray<readonly [string, PaymentReferenceType]> = [
  ['UPI/', 'upi_utr'],
  ['UPI-', 'upi_utr'],
  ['NEFT/', 'bank_reference'],
  ['NEFT-', 'bank_reference'],
  ['IMPS/', 'bank_reference'],
  ['IMPS-', 'bank_reference'],
  ['RTGS/', 'bank_reference'],
  ['ACH/', 'bank_reference'],
  ['BBPS/', 'bank_reference'],
  ['MMT/', 'bank_reference'],
  ['CHQ/', 'cheque_number'],
];

/** Lines that are layout, not money. Shared by every bank format. */
const LEDGER_NOISE: readonly RegExp[] = [
  /^opening\s+balance/i,
  /^closing\s+balance/i,
  /^balance\s+(?:b\/f|c\/f|brought|carried)/i,
  /^total\b/i,
  /^statement\s+summary/i,
  /^\*+/,
];

const BASE = {
  amountColumns: [] as readonly string[],
  debitColumns: [] as readonly string[],
  creditColumns: [] as readonly string[],
  typeColumns: [] as readonly string[],
  referenceColumns: [] as readonly string[],
  balanceColumns: [] as readonly string[],
  skipDescriptionPatterns: LEDGER_NOISE,
  detectable: true,
} as const;

/**
 * Every format, in detection order.
 *
 * Order is only consulted by auto-detection, and only ever as a tiebreak between two formats
 * whose columns both match: the more specific declaration is listed first. A file that matches
 * none is refused with the list of what is supported, never imported under a guess.
 */
export const STATEMENT_FORMATS: readonly StatementFormat[] = [
  {
    ...BASE,
    id: 'generic_bank_csv',
    label: 'Generic bank CSV (date, description, amount, type, reference)',
    container: 'delimited',
    channel: 'bank_transfer',
    headerHint: 'date,description,amount_inr,type,reference',
    dateColumns: ['date', 'txn date', 'transaction date'],
    descriptionColumns: ['description', 'narration', 'particulars'],
    amountColumns: ['amount_inr', 'amount', 'amount inr'],
    typeColumns: ['type', 'dr/cr', 'debit/credit'],
    referenceColumns: ['reference', 'ref no', 'reference number'],
    direction: {
      kind: 'type_column',
      debitWords: ['debit', 'dr', 'withdrawal', 'w'],
      creditWords: ['credit', 'cr', 'deposit', 'd'],
    },
    dateLayouts: ['yyyy-mm-dd', 'dd/mm/yyyy', 'dd-mm-yyyy'],
    referencePrefixes: BANK_PREFIXES,
    defaultReferenceType: 'other',
  },
  {
    ...BASE,
    id: 'hdfc_bank_csv',
    label: 'HDFC Bank — account statement (CSV/XLSX)',
    container: 'delimited',
    channel: 'bank_transfer',
    headerHint:
      'Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance',
    dateColumns: ['date', 'txn date'],
    descriptionColumns: ['narration'],
    debitColumns: ['withdrawal amt', 'withdrawal amt.', 'withdrawal'],
    creditColumns: ['deposit amt', 'deposit amt.', 'deposit'],
    referenceColumns: ['chq./ref.no.', 'chq/ref no', 'ref no'],
    balanceColumns: ['closing balance', 'balance'],
    direction: { kind: 'debit_credit_columns' },
    dateLayouts: ['dd/mm/yy', 'dd/mm/yyyy'],
    referencePrefixes: BANK_PREFIXES,
    defaultReferenceType: 'bank_reference',
  },
  {
    ...BASE,
    id: 'icici_bank_csv',
    label: 'ICICI Bank — account statement (CSV/XLSX)',
    container: 'delimited',
    channel: 'bank_transfer',
    headerHint:
      'S No., Value Date, Transaction Date, Cheque Number, Transaction Remarks, Withdrawal Amount (INR ), Deposit Amount (INR ), Balance (INR )',
    dateColumns: ['transaction date', 'txn date', 'value date'],
    descriptionColumns: ['transaction remarks', 'remarks', 'narration'],
    debitColumns: ['withdrawal amount', 'withdrawal amount inr', 'withdrawal'],
    creditColumns: ['deposit amount', 'deposit amount inr', 'deposit'],
    referenceColumns: ['cheque number', 'chequeno', 'ref no'],
    balanceColumns: ['balance', 'balance inr'],
    direction: { kind: 'debit_credit_columns' },
    dateLayouts: ['dd/mm/yyyy', 'dd-mm-yyyy', 'dd-mon-yyyy'],
    referencePrefixes: BANK_PREFIXES,
    defaultReferenceType: 'bank_reference',
  },
  {
    ...BASE,
    id: 'sbi_bank_csv',
    label: 'State Bank of India — account statement (CSV/XLSX)',
    container: 'delimited',
    channel: 'bank_transfer',
    headerHint: 'Txn Date, Value Date, Description, Ref No./Cheque No., Debit, Credit, Balance',
    dateColumns: ['txn date', 'transaction date', 'date'],
    descriptionColumns: ['description', 'narration'],
    debitColumns: ['debit', 'withdrawal'],
    creditColumns: ['credit', 'deposit'],
    referenceColumns: ['ref no./cheque no.', 'ref no cheque no', 'ref no'],
    balanceColumns: ['balance'],
    direction: { kind: 'debit_credit_columns' },
    dateLayouts: ['dd mon yyyy', 'dd-mon-yyyy', 'dd/mm/yyyy'],
    referencePrefixes: BANK_PREFIXES,
    defaultReferenceType: 'bank_reference',
  },
  {
    ...BASE,
    id: 'axis_bank_csv',
    label: 'Axis Bank — account statement (CSV/XLSX)',
    container: 'delimited',
    channel: 'bank_transfer',
    headerHint: 'Tran Date, CHQNO, PARTICULARS, DR, CR, BAL, SOL',
    dateColumns: ['tran date', 'transaction date', 'date'],
    descriptionColumns: ['particulars', 'narration', 'description'],
    debitColumns: ['dr', 'debit'],
    creditColumns: ['cr', 'credit'],
    referenceColumns: ['chqno', 'cheque no', 'ref no'],
    balanceColumns: ['bal', 'balance'],
    direction: { kind: 'debit_credit_columns' },
    dateLayouts: ['dd-mm-yyyy', 'dd/mm/yyyy', 'dd-mon-yyyy'],
    referencePrefixes: BANK_PREFIXES,
    defaultReferenceType: 'bank_reference',
  },
  {
    ...BASE,
    id: 'card_statement_csv',
    label: 'Credit/debit card statement (CSV)',
    container: 'delimited',
    channel: 'card',
    headerHint: 'Transaction Date, Transaction Description, Amount, Debit/Credit',
    dateColumns: ['transaction date', 'date', 'txn date'],
    descriptionColumns: ['transaction description', 'description', 'merchant', 'particulars'],
    amountColumns: ['amount', 'amount inr', 'transaction amount'],
    typeColumns: ['debit/credit', 'dr/cr', 'type'],
    referenceColumns: ['reference', 'ref no', 'transaction id'],
    direction: {
      kind: 'type_column',
      // A card statement's "credit" is a refund or a payment to the card, never new spend.
      debitWords: ['debit', 'dr', 'purchase', 'd'],
      creditWords: ['credit', 'cr', 'refund', 'payment', 'c'],
    },
    dateLayouts: ['dd/mm/yyyy', 'dd-mm-yyyy', 'dd-mon-yyyy', 'yyyy-mm-dd'],
    referencePrefixes: [['CARD/', 'card_reference']],
    defaultReferenceType: 'card_reference',
  },
  {
    ...BASE,
    id: 'upi_app_export_csv',
    label: 'UPI app export (PhonePe / Google Pay / Paytm history CSV)',
    container: 'delimited',
    channel: 'upi',
    headerHint: 'Date, Transaction Details, Type, Amount, UTR',
    dateColumns: ['date', 'transaction date', 'txn date'],
    descriptionColumns: ['transaction details', 'details', 'description', 'to/from', 'name'],
    amountColumns: ['amount', 'amount inr'],
    typeColumns: ['type', 'transaction type', 'debit/credit'],
    referenceColumns: ['utr', 'upi transaction id', 'transaction id', 'rrn'],
    direction: {
      kind: 'type_column',
      debitWords: ['debit', 'dr', 'paid', 'sent', 'money out', 'payment'],
      creditWords: ['credit', 'cr', 'received', 'money in', 'refund'],
    },
    dateLayouts: ['dd/mm/yyyy', 'dd-mm-yyyy', 'yyyy-mm-dd', 'dd mon yyyy'],
    referencePrefixes: UPI_PREFIXES,
    // A UPI app's own export identifies a transaction by its UTR, whatever it labels the
    // column. `upi_rrn` is deliberately not assumed: a 12-digit RRN and a UTR are different
    // identifiers, and ADR-0020 makes the reference type evidence rather than decoration.
    defaultReferenceType: 'upi_utr',
  },
  {
    ...BASE,
    id: 'signed_amount_csv',
    label: 'Single signed-amount CSV (negative is a debit)',
    container: 'delimited',
    channel: 'bank_transfer',
    headerHint: 'Date, Description, Amount, Reference — amount negative for money out',
    dateColumns: ['date', 'transaction date', 'txn date', 'posted date'],
    descriptionColumns: ['description', 'narration', 'details', 'particulars'],
    amountColumns: ['amount', 'amount inr', 'value'],
    referenceColumns: ['reference', 'ref no', 'transaction id'],
    balanceColumns: ['balance', 'running balance'],
    direction: { kind: 'signed_amount' },
    dateLayouts: ['yyyy-mm-dd', 'dd/mm/yyyy', 'dd-mm-yyyy', 'dd-mon-yyyy'],
    referencePrefixes: BANK_PREFIXES,
    defaultReferenceType: 'other',
    // Listed last and not auto-detected: "date, description, amount" matches almost anything,
    // so choosing it is a person's explicit statement about their file rather than a guess
    // this module makes on their behalf.
    detectable: false,
  },
];

/**
 * The line shape a generated PDF statement prints, and how to read it.
 *
 * A PDF has no header row to match columns against, so this is the one format family that is
 * a pattern rather than a column map. Each capture group is named in {@link PDF_LINE_FIELDS}.
 */
export interface PdfLinePattern {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
  readonly dateLayouts: readonly StatementDateLayout[];
  readonly channel: PaymentChannel;
  readonly defaultReferenceType: PaymentReferenceType | null;
  readonly referencePrefixes: ReadonlyArray<readonly [string, PaymentReferenceType]>;
}

export const PDF_LINE_FIELDS = [
  'date',
  'description',
  'debit',
  'credit',
  'amount',
  'type',
  'balance',
] as const;

/**
 * The two layouts a generated Indian bank statement PDF actually prints.
 *
 * Both are anchored at a date at the start of the line and an amount at the end, which is what
 * makes them safe to apply line by line: a header, a footer or an address never matches.
 */
export const PDF_LINE_PATTERNS: readonly PdfLinePattern[] = [
  {
    id: 'pdf_debit_credit_balance',
    label: 'PDF statement — date, narration, debit, credit, balance',
    // e.g. `01/07/2026 UPI-BLINKIT INDIA PVT LTD 1,240.00 0.00 48,120.00`
    pattern:
      /^(?<date>\d{1,2}[/-][A-Za-z0-9]{2,3}[/-]\d{2,4})\s+(?<description>.+?)\s+(?<debit>[\d,]+\.\d{2})\s+(?<credit>[\d,]+\.\d{2})\s+(?<balance>[\d,]+\.\d{2})$/,
    dateLayouts: ['dd/mm/yyyy', 'dd/mm/yy', 'dd-mm-yyyy', 'dd-mon-yyyy', 'dd-mon-yy'],
    channel: 'bank_transfer',
    defaultReferenceType: 'bank_reference',
    referencePrefixes: BANK_PREFIXES,
  },
  {
    id: 'pdf_amount_with_marker',
    label: 'PDF statement — date, narration, amount with Dr/Cr marker',
    // e.g. `01-Jul-2026 UPI/2607011234/BLINKIT 1,240.00 Dr`
    pattern:
      /^(?<date>\d{1,2}[/-][A-Za-z0-9]{2,3}[/-]\d{2,4})\s+(?<description>.+?)\s+(?<amount>[\d,]+\.\d{2})\s*(?<type>Dr|Cr|DR|CR)\.?$/,
    dateLayouts: ['dd-mon-yyyy', 'dd-mon-yy', 'dd/mm/yyyy', 'dd-mm-yyyy'],
    channel: 'bank_transfer',
    defaultReferenceType: 'bank_reference',
    referencePrefixes: BANK_PREFIXES,
  },
];
