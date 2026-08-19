/**
 * Explicit state machines for the lifecycles in `docs/domain/lifecycle.md`.
 *
 * States are modelled as data with an explicit allowed-transition table, not inferred
 * from a combination of flags (`CLAUDE.md`, "Explicit state transitions"). Anything the
 * lifecycle document does not draw is rejected: a transition that turns out to be needed
 * is a documented decision to make, not a gap to paper over at a call site.
 */

import { createsObligation, isNonSpendCounterparty } from './enums.js';
import type {
  AiInferenceStatus,
  ExpenseAdjustmentState,
  ExpenseRelationshipType,
  ExpenseState,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentState,
  SplitwiseExpenseSyncStatus,
} from './enums.js';
import { DomainError } from './errors.js';
import type { PersonId } from './ids.js';
import type { Paise } from './money.js';

/** A transition table: for each state, the states it may move to. */
type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

/* ------------------------------------------------------------------------- payments */

/**
 * `IMPORTED → NORMALIZED → (LINKED | IGNORED)`, plus `IMPORTED → IGNORED` (ADR-0019).
 *
 * Deliberately strict. A payment cannot skip normalization on the way to `linked`, cannot
 * regress once linked (a linked payment whose expense is later un-approved is handled at the
 * `Expense` level, not by regressing the payment — `lifecycle.md`), and cannot be revived
 * once ignored.
 *
 * `imported → ignored` is the one addition, for a duplicate the importer confirms
 * deterministically against an existing payment (`invariants.md` #10). Being *explained*
 * requires knowing what a payment is, so `linked` still demands normalization first; being
 * *discarded* does not. Routing a row through `normalized` on its way to the bin would mean
 * claiming a counterparty was resolved for a row nobody will ever look at again.
 */
const PAYMENT_TRANSITIONS: Transitions<PaymentState> = {
  imported: ['normalized', 'ignored'],
  normalized: ['linked', 'ignored'],
  linked: [],
  ignored: [],
};

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: PaymentState, to: PaymentState): void {
  assertTransition('Payment', from, to, canTransitionPayment(from, to));
}

/**
 * Whether staying at this state forever is a valid outcome rather than unfinished work.
 *
 * True for internal transfers and investment purchases, which are excluded from spend by
 * `counterparty_type` alone (`invariants.md` #7, ADR-0011), and for a plain credit that is
 * neither a refund/reimbursement nor a received settlement — V1 deliberately does not
 * classify general inflow (ADR-0015).
 */
export function isPaymentTerminalWithoutLinking(
  state: PaymentState,
  counterpartyType: PaymentCounterpartyType,
  direction: PaymentDirection,
): boolean {
  if (state !== 'normalized') return false;
  if (isNonSpendCounterparty(counterpartyType)) return true;
  return direction === 'credit';
}

/* ------------------------------------------------------------------------- expenses */

/**
 * The brief's chain, adapted per `lifecycle.md`:
 *
 * `PROPOSED → CLASSIFIED → REVIEW_REQUIRED → APPROVED → ALLOCATED → READY_TO_SYNC →
 *  SYNCED → RECONCILED`
 *
 * With three documented deviations from a straight line:
 *
 *  - `classified → approved` for a high-confidence, low-stakes expense. `lifecycle.md`
 *    prefers passing *through* `review_required` near-instantly so the audit trail stays
 *    uniform, but its own diagram draws the skip, so the machine permits it; either way an
 *    explicit approval act is still required (`invariants.md` #15, #16).
 *  - `allocated → reconciled`, for `personal`/`gift` expenses, which create no obligation
 *    and so skip `ready_to_sync`/`synced` entirely.
 *  - regression to `review_required` from `allocated` onwards, for an expense found to
 *    have drifted from Splitwise or that received a later `ExpenseAdjustment`. Always via
 *    an `AuditEvent`, never silently.
 *
 * And one off-ramp, added in phase 9 (ADR-0028): `classified`/`review_required` → `rejected`,
 * for the DERIVED expense a classification proposal created when that proposal is declined or
 * superseded. Terminal, and reachable from nowhere else — an expense that was ever `approved`
 * can never be rejected, because `approved` does not list it. That asymmetry is the point:
 * declining a *proposal* is cheap, and unwinding an approved financial record is not something
 * this transition is allowed to pretend to do.
 */
const EXPENSE_TRANSITIONS: Transitions<ExpenseState> = {
  proposed: ['classified'],
  classified: ['review_required', 'approved', 'rejected'],
  review_required: ['approved', 'rejected'],
  approved: ['allocated', 'review_required'],
  allocated: ['ready_to_sync', 'reconciled', 'review_required'],
  ready_to_sync: ['synced', 'review_required'],
  synced: ['reconciled', 'review_required'],
  reconciled: ['review_required'],
  rejected: [],
};

export function canTransitionExpense(from: ExpenseState, to: ExpenseState): boolean {
  return EXPENSE_TRANSITIONS[from].includes(to);
}

export function assertExpenseTransition(from: ExpenseState, to: ExpenseState): void {
  assertTransition('Expense', from, to, canTransitionExpense(from, to));
}

/** True once an expense's `amount` is permanently frozen (`invariants.md` #6). */
export function isExpenseAmountFrozen(state: ExpenseState): boolean {
  return (
    state === 'approved' ||
    state === 'allocated' ||
    state === 'ready_to_sync' ||
    state === 'synced' ||
    state === 'reconciled'
  );
}

/** One resolved individual share — an allocation line, or a group expansion row. */
export interface ResolvedShare {
  readonly beneficiaryId: PersonId;
  readonly amount: Paise;
}

/** True when someone other than the payer holds a non-zero share (`invariants.md` #2a). */
export function hasObligationCreatingLine(
  paidByPersonId: PersonId,
  resolvedShares: readonly ResolvedShare[],
): boolean {
  return resolvedShares.some(
    (share) => share.beneficiaryId !== paidByPersonId && share.amount > 0n,
  );
}

export interface ReadyToSyncInput {
  readonly relationshipType: ExpenseRelationshipType;
  readonly paidByPersonId: PersonId;
  /**
   * Individual shares from the **current** allocation — group lines already expanded,
   * since a `Group` can never be a Splitwise debtor (ADR-0009).
   */
  readonly resolvedShares: readonly ResolvedShare[];
}

/**
 * The corrected `READY_TO_SYNC` gate (`lifecycle.md` revision note).
 *
 * Both conditions must hold: the relationship type is in the debt-creating set, **and**
 * the current allocation has at least one obligation-creating line. The original wording
 * ("allocation involves a non-self beneficiary") checked only the second, which admits a
 * `gift` — and syncing a gift would tell the recipient they owe the giver for their own
 * present (`scenario-analysis.md` §8).
 */
export function canEnterReadyToSync(input: ReadyToSyncInput): boolean {
  if (!createsObligation(input.relationshipType)) return false;
  return hasObligationCreatingLine(input.paidByPersonId, input.resolvedShares);
}

/* ---------------------------------------------------------------------- adjustments */

const ADJUSTMENT_TRANSITIONS: Transitions<ExpenseAdjustmentState> = {
  recorded: ['distributed'],
  distributed: [],
};

export function canTransitionAdjustment(
  from: ExpenseAdjustmentState,
  to: ExpenseAdjustmentState,
): boolean {
  return ADJUSTMENT_TRANSITIONS[from].includes(to);
}

export function assertAdjustmentTransition(
  from: ExpenseAdjustmentState,
  to: ExpenseAdjustmentState,
): void {
  assertTransition('ExpenseAdjustment', from, to, canTransitionAdjustment(from, to));
}

/* --------------------------------------------------------------------- AI inference */

/** A decided inference is never re-opened; a re-run supersedes it instead. */
const AI_INFERENCE_TRANSITIONS: Transitions<AiInferenceStatus> = {
  pending: ['accepted', 'modified', 'rejected', 'superseded'],
  accepted: [],
  modified: [],
  rejected: [],
  superseded: [],
};

export function canTransitionAiInference(from: AiInferenceStatus, to: AiInferenceStatus): boolean {
  return AI_INFERENCE_TRANSITIONS[from].includes(to);
}

export function assertAiInferenceTransition(from: AiInferenceStatus, to: AiInferenceStatus): void {
  assertTransition('AIInference', from, to, canTransitionAiInference(from, to));
}

/* ------------------------------------------------------------------- Splitwise sync */

/**
 * `drifted` and `stale` are terminal-until-addressed, and addressing them means a **fresh
 * proposal a human re-confirms** — modelled as a required trip back through `pending`.
 * Allowing `drifted → synced` directly would be exactly the auto-resolution invariant #18
 * forbids.
 */
const SPLITWISE_EXPENSE_SYNC_TRANSITIONS: Transitions<SplitwiseExpenseSyncStatus> = {
  pending: ['synced', 'sync_failed'],
  synced: ['drifted', 'stale', 'sync_failed'],
  drifted: ['pending'],
  stale: ['pending'],
  sync_failed: ['pending', 'synced'],
};

export function canTransitionSplitwiseExpenseSync(
  from: SplitwiseExpenseSyncStatus,
  to: SplitwiseExpenseSyncStatus,
): boolean {
  return SPLITWISE_EXPENSE_SYNC_TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------------- internals */

function assertTransition(entity: string, from: string, to: string, allowed: boolean): void {
  if (allowed) return;
  throw new DomainError(
    'INVALID_STATE_TRANSITION',
    `${entity} cannot move from "${from}" to "${to}". See docs/domain/lifecycle.md for the ` +
      'transitions this entity supports.',
    { entity, from, to },
  );
}
