/**
 * The shape every statement adapter produces, whatever container it read.
 *
 * One row type for a CSV from a bank, a sheet inside an XLSX, or a line lifted off a PDF's
 * text layer. The container is the adapter's problem; everything downstream —
 * `services.importStatement`, deduplication, the payment workspace — sees this and only this.
 *
 * What a row may say is deliberately narrow: when it happened, what the statement printed,
 * how much, which way, and whatever identifier the source carried. **What it was for is not
 * on this type**, and cannot be added by a format. A statement that says
 * `NEFT TRANSFER TO SELF A/C X4821` still yields a debit with that description; deciding it
 * is an internal transfer is classification's job (`data-flow.md` steps 2–3), and the absence
 * of a field for it is what keeps that boundary structural rather than a matter of discipline.
 */

import type {
  Paise,
  PaymentChannel,
  PaymentDirection,
  PaymentReferenceType,
} from '../../domain/index.js';

/** One movement a statement printed, carrying only what the source actually said. */
export interface StatementRow {
  /**
   * Where in the source this came from — a 1-based line for a delimited file or a PDF, a
   * 1-based sheet row for an XLSX. Any later complaint can point at it.
   */
  readonly lineNumber: number;
  /** Parsed at UTC midnight when the format carries a date rather than a time. */
  readonly occurredAt: Date;
  /** Verbatim, including whatever noise the institution put in it. */
  readonly rawDescription: string;
  /** Always positive. Direction carries the sign, exactly as `payments.amount` does. */
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly externalReference: string | null;
  readonly referenceType: PaymentReferenceType | null;
  /**
   * The running balance printed beside this row, when the format prints one.
   *
   * Recorded because it is genuinely part of what the statement said, and because the last
   * row's balance is a **candidate** evidenced closing boundary for ADR-0017's cash waterfall.
   * A candidate, never an automatic boundary: nothing here writes a boundary, and a person
   * still confirms one against the document (`account-balance-service.ts`).
   */
  readonly runningBalance: Paise | null;
}

/** A row an adapter refused to interpret, and why. */
export interface StatementRowError {
  readonly lineNumber: number;
  /** The column that could not be read, when the failure is attributable to one. */
  readonly column: string | null;
  readonly rawValue: string | null;
  readonly message: string;
}

/** Something the adapter read but wants the caller to know about. Never silently swallowed. */
export interface StatementWarning {
  readonly lineNumber: number | null;
  readonly message: string;
}

export type StatementParseResult =
  | {
      readonly ok: true;
      readonly formatId: string;
      readonly parserVersion: string;
      readonly rows: readonly StatementRow[];
      readonly warnings: readonly StatementWarning[];
    }
  | {
      readonly ok: false;
      readonly formatId: string;
      readonly parserVersion: string;
      readonly errors: readonly StatementRowError[];
    };

/** How a format's bytes are laid out before any column has a meaning. */
export type StatementContainer = 'delimited' | 'xlsx' | 'pdf_text';

/**
 * One supported statement format, as the registry describes it to a caller.
 *
 * Returned by `listStatementFormats()` so an import screen can name what it accepts rather
 * than asking a person to guess, and so "which formats does this build actually read?" has a
 * single answer that cannot drift from the parsers.
 */
export interface StatementFormatDescriptor {
  readonly id: string;
  readonly label: string;
  readonly container: StatementContainer;
  /** The transport a movement captured by this source travelled over. */
  readonly channel: PaymentChannel;
  /** What the format's own header/lines look like, for a person choosing between two. */
  readonly headerHint: string;
  /** Whether the format prints a running balance this parser can read. */
  readonly carriesRunningBalance: boolean;
  /** `true` when auto-detection can recognise the format from its content alone. */
  readonly detectable: boolean;
}
