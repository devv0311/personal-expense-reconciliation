/**
 * The single error type raised by `src/domain`.
 *
 * Every domain rule that can be violated fails loudly through this class rather than
 * returning a coerced or clamped value — see `docs/domain/invariants.md` #12a for the
 * canonical statement of why ("clamping would make the distributed amounts stop summing
 * to the adjustment's amount, silently losing money from the ledger's arithmetic, which
 * is worse than refusing the input").
 */

/**
 * Stable, machine-readable reasons a domain rule was violated. Callers (`src/services`,
 * `src/api`) branch on `code`, never on message text.
 */
export type DomainErrorCode =
  /** A monetary value arrived as something other than a `bigint` count of minor units. */
  | 'MONEY_NOT_BIGINT'
  /** A major-unit string was not an exact decimal with at most two places. */
  | 'MONEY_MALFORMED_MAJOR_UNITS'
  /** A field that must be `>= 0` was negative (`invariants.md` #12a). */
  | 'MONEY_NEGATIVE'
  /** More than one currency, or an unsupported one, entered a single computation. */
  | 'CURRENCY_UNSUPPORTED'
  /** `splitByLargestRemainder` was handed inputs it cannot divide deterministically. */
  | 'SPLIT_INVALID_INPUT'
  /** Percentage numerators did not sum to 100 (`testing-strategy.md` rounding case 5). */
  | 'PERCENTAGES_DO_NOT_SUM'
  /** Allocation lines did not sum to the expense's net amount (`invariants.md` #11). */
  | 'ALLOCATION_SUM_MISMATCH'
  /** Item-based lines did not sum to their referenced item's amount (`invariants.md` #14). */
  | 'ALLOCATION_ITEM_SUM_MISMATCH'
  /** An allocation had no lines at all, or a required line was missing. */
  | 'ALLOCATION_SHAPE_INVALID'
  /** A `group`-typed line had no fully-distributed expansion (`invariants.md` #2b). */
  | 'GROUP_EXPANSION_MISSING'
  /** A group resolved to no members as of the expense date (`ADR-0009`). */
  | 'GROUP_EXPANSION_NO_MEMBERS'
  /** Adjustments for one expense exceeded its gross amount (`invariants.md` #8). */
  | 'ADJUSTMENT_EXCEEDS_EXPENSE'
  /** A custom distribution would drive a line below zero (`invariants.md` #12a). */
  | 'ADJUSTMENT_DISTRIBUTION_NEGATIVE'
  /** Links + settlements would exceed the payment they are drawn from. */
  | 'PAYMENT_BUDGET_EXCEEDED'
  /** A transfer or investment payment was linked to an expense (`invariants.md` #7). */
  | 'NON_SPEND_PAYMENT_LINKED'
  /** A lifecycle transition that the state machine does not permit. */
  | 'INVALID_STATE_TRANSITION'
  /** A write was attempted against an immutable field (`invariants.md` #4, #6). */
  | 'IMMUTABLE_FIELD'
  /** A manual note had no kind, or a non-note claimed one (ADR-0018). */
  | 'EVIDENCE_NOTE_KIND_INVALID'
  /** An `Evidence` row carried no document and no text, or a document it cannot describe. */
  | 'EVIDENCE_PAYLOAD_INVALID'
  /** A document arrived in a format this system does not store (`domain/evidence.ts`). */
  | 'EVIDENCE_MEDIA_TYPE_UNSUPPORTED'
  /** A recorded `Evidence` link was re-pointed or cleared rather than superseded. */
  | 'EVIDENCE_LINK_IMMUTABLE'
  /** An `AIInference` decision named an actor that is neither a person nor a `Rule` (#17). */
  | 'DECISION_ACTOR_INVALID'
  /** A referenced entity was absent from the input set handed to a pure function. */
  | 'UNKNOWN_REFERENCE';

/** Thrown by `src/domain` when an input violates a documented invariant. */
export class DomainError extends Error {
  public readonly code: DomainErrorCode;

  /** Optional structured context, e.g. `{ field: 'allocationLine.amount' }`. */
  public readonly details: Readonly<Record<string, string>>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** Narrowing helper for `catch` blocks and tests. */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
