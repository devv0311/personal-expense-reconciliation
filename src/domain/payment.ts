/**
 * Payment-level rules: what a payment is allowed to fund, how much of it is explained,
 * and when two payments are the same real-world transaction seen twice.
 */

import { isNonSpendCounterparty } from './enums.js';
import type { PaymentCounterpartyType, PaymentDirection } from './enums.js';
import { DomainError } from './errors.js';
import { sumPaise } from './money.js';
import type { Paise } from './money.js';

/* ------------------------------------------------------- payment explanation budget */

export interface PaymentExplanationInput {
  readonly paymentAmount: Paise;
  /** `PaymentExpenseLink.amount` for every expense drawing on this payment. */
  readonly linkAmounts: readonly Paise[];
  /** `Settlement.amount` for every settlement drawing on the same payment (ADR-0007). */
  readonly settlementAmounts: readonly Paise[];
}

export interface PaymentExplanation {
  readonly explained: Paise;
  /** Never silently dropped — surfaced as unexplained (`invariants.md` #20). */
  readonly unexplained: Paise;
}

/**
 * Expense links and settlements draw on **one** budget: a payment's own amount.
 *
 * Over-drawing is an error; under-drawing is not — the remainder is explicitly tracked as
 * unexplained rather than assumed to be a rounding artefact
 * (`domain-model.md`, `PaymentExpenseLink`).
 */
export function validatePaymentExplanationBudget(
  input: PaymentExplanationInput,
): PaymentExplanation {
  const explained = sumPaise([...input.linkAmounts, ...input.settlementAmounts]);
  if (explained > input.paymentAmount) {
    throw new DomainError(
      'PAYMENT_BUDGET_EXCEEDED',
      `Expense links and settlements against this payment total ${explained} paise, more than ` +
        `the payment's own ${input.paymentAmount} paise. A payment cannot explain more money ` +
        'than it moved (domain-model.md, PaymentExpenseLink; ADR-0007).',
      { explained: explained.toString(), paymentAmount: input.paymentAmount.toString() },
    );
  }
  return { explained, unexplained: (input.paymentAmount - explained) as Paise };
}

/**
 * Invariant #7: an internal transfer or an investment purchase is never spending and must
 * never be linked to an `Expense`.
 */
export function assertPaymentCanFundExpense(counterpartyType: PaymentCounterpartyType): void {
  if (isNonSpendCounterparty(counterpartyType)) {
    throw new DomainError(
      'NON_SPEND_PAYMENT_LINKED',
      `A payment with counterparty_type "${counterpartyType}" is not spending and must never ` +
        'be linked to an Expense. It is excluded from spend totals by this classification ' +
        'alone, and may remain at state "normalized" indefinitely (invariants.md #7, ADR-0011).',
      { counterpartyType },
    );
  }
}

/* --------------------------------------------------------------- duplicate detection */

/** The fields duplicate detection compares. */
export interface DuplicateCandidate {
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly externalReference: string | null;
  /**
   * Part of the match, and load-bearing.
   *
   * The two legs of a transfer between the user's own accounts share one reference, one
   * amount and one timestamp, differing only in direction — `fixtures/bank-statement.csv`
   * rows 2 and 3 are exactly this. Without direction in the match they collapse into one
   * "duplicate" and half a real transfer is discarded.
   */
  readonly direction: PaymentDirection;
  /**
   * Present for diagnostics only. Deliberately **not** part of the match: the same
   * real-world transaction can legitimately land under two different `Account` rows when
   * two import channels capture it (ADR-0010's amendment, `scenario-analysis.md` §13).
   */
  readonly accountId?: string;
}

export interface DuplicateMatchOptions {
  /** Tolerated clock skew between two captures of one transaction. Default 60 seconds. */
  readonly windowSeconds?: number;
}

const DEFAULT_DUPLICATE_WINDOW_SECONDS = 60;

/**
 * A deterministic duplicate: same **direction**, same amount, matching non-null
 * `external_reference`, and timestamps within a small window (`invariants.md` #10).
 *
 * A UTR/RRN/bank reference already identifies the real-world transaction on its own;
 * amount and timestamp proximity corroborate it. Anything short of this is not
 * deterministic — see {@link isPossibleDuplicate}.
 */
export function isDeterministicDuplicate(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  options: DuplicateMatchOptions = {},
): boolean {
  if (a.direction !== b.direction) return false;
  if (a.externalReference === null || b.externalReference === null) return false;
  if (a.externalReference !== b.externalReference) return false;
  if (a.amount !== b.amount) return false;
  return withinWindow(a, b, options);
}

/**
 * A *possible* duplicate: same amount and close in time, but without a conclusive
 * reference match.
 *
 * Surfaced for human confirmation — never silently merged, and never silently kept as two
 * (`invariants.md` #10).
 */
export function isPossibleDuplicate(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  options: DuplicateMatchOptions = {},
): boolean {
  if (isDeterministicDuplicate(a, b, options)) return false;
  // Money leaving is never a duplicate of money arriving, however alike they otherwise look.
  if (a.direction !== b.direction) return false;
  if (a.amount !== b.amount) return false;
  return withinWindow(a, b, options);
}

function withinWindow(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  options: DuplicateMatchOptions,
): boolean {
  const windowSeconds = options.windowSeconds ?? DEFAULT_DUPLICATE_WINDOW_SECONDS;
  const deltaMs = Math.abs(a.occurredAt.getTime() - b.occurredAt.getTime());
  return deltaMs <= windowSeconds * 1000;
}
