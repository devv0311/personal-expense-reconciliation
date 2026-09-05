/**
 * Account-level cash reconciliation (ADR-0017 (cash balance), 17.3–17.7).
 *
 * The second of two deliberately independent identities. ADR-0016's outflow identity —
 * `computeUnexplained` in `reconciliation.ts` — asks *"how much of what left the user's
 * accounts has the ledger explained?"*. This one asks *"does the bank statement close?"*:
 *
 * ```text
 * expected_ending_balance = opening_balance + total_credits - total_debits
 * cash_balance_delta      = actual_ending_balance - expected_ending_balance
 * ```
 *
 * They are not two views of one number and neither is derived from the other. Netting a
 * refund against its purchase before totalling bank movements — the obvious way to make the
 * two agree — is exactly what 17.4 forbids: a ₹1,000 purchase followed by a ₹200 refund is
 * ₹1,000 of debit and ₹200 of credit, once each, whatever the expense's net amount is.
 *
 * Three rules shape every function here:
 *
 *  - **Unknown is not zero.** A missing statement balance leaves `null` and makes the
 *    snapshot `incomplete`. Synthesising a closing balance from the movements being checked
 *    would produce a zero delta by construction and prove nothing (17.5).
 *  - **Nothing is clamped.** Deltas are signed and stored as they come out. An overdraft is a
 *    real balance; a negative delta is a real disagreement (17.4).
 *  - **Every distinct movement participates**, including ones excluded from spending, and
 *    including a genuine transfer's second leg. Only a *duplicate representation* of one
 *    movement is dropped (17.6).
 */

import type { CashReconciliationDiscrepancy, ReconciliationAccountSnapshot } from './entities.js';
import { categoryExplainsWholeMovement } from './cash-flow.js';
import { isNonSpendCounterparty } from './enums.js';
import type {
  CashFlowCategory,
  CashFlowState,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentState,
  ReconciliationVerificationStatus,
} from './enums.js';
import { DomainError } from './errors.js';
import type { AccountId, EvidenceId, PaymentId } from './ids.js';
import { parseDuplicateOfReason } from './payment.js';
import { assertNonNegative } from './money.js';
import type { CurrencyCode, Paise } from './money.js';

/**
 * How much of one movement other records already account for.
 *
 * Three independent, non-overlapping sources, matching the three ways a paise can already be
 * spoken for: attributed to an expense, attributed to a settlement, or returned against an
 * expense. They are summed and capped at the movement's own amount so that no paise is
 * explained twice (17.1) even if a caller assembles overlapping inputs.
 */
export interface CashMovementExplanation {
  /** `PaymentExpenseLink` attribution — a debit that funded an expense. */
  readonly expenseLinkTotal: Paise;
  /** `Settlement` attribution carried by this payment, in either direction. */
  readonly settlementTotal: Paise;
  /** `ExpenseAdjustment` attribution against this credit — a refund or reimbursement. */
  readonly adjustmentTotal: Paise;
}

/** One actual posted movement on one account, as cash reconciliation reads it. */
export interface CashMovement {
  readonly paymentId: PaymentId;
  readonly accountId: AccountId;
  readonly direction: PaymentDirection;
  /** Gross, as the statement posted it. Never netted against anything (17.4). */
  readonly amount: Paise;
  readonly currency: CurrencyCode;
  readonly counterpartyType: PaymentCounterpartyType;
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly cashFlowState: CashFlowState;
  /** The legacy movement/link state. Read only to identify duplicate representations. */
  readonly state: PaymentState;
  readonly ignoredReason: string | null;
  /** The deterministic dedup/pairing key (ADR-0010, ADR-0023). */
  readonly externalReference: string | null;
  readonly explanation: CashMovementExplanation;
}

/**
 * The statement boundaries for one account, and the evidence they come from.
 *
 * A balance and its evidence travel together on purpose. 17.5 requires both boundaries to
 * "trace to immutable statement evidence"; a balance with no evidence is a number somebody
 * typed, and this system does not have a field for that.
 */
export interface AccountBoundaryBalances {
  readonly openingBalance: Paise | null;
  readonly openingBalanceEvidenceId: EvidenceId | null;
  readonly closingBalance: Paise | null;
  readonly closingBalanceEvidenceId: EvidenceId | null;
}

/** No boundary evidence at all — the honest default when nothing has been confirmed yet. */
export const NO_BOUNDARY_BALANCES: AccountBoundaryBalances = {
  openingBalance: null,
  openingBalanceEvidenceId: null,
  closingBalance: null,
  closingBalanceEvidenceId: null,
};

export interface AccountCashSnapshotInput {
  readonly accountId: AccountId;
  readonly currency: CurrencyCode;
  readonly periodStart: Date;
  /** Exclusive: `[start, end)`, so consecutive periods neither overlap nor leave a gap. */
  readonly periodEnd: Date;
  /** Every movement posted to this account in the interval, already de-duplicated. */
  readonly movements: readonly CashMovement[];
  readonly boundaries: AccountBoundaryBalances;
  /**
   * Internal-transfer legs on this account whose counter-leg this run could not see.
   *
   * Supplied by {@link pairInternalTransfers} over the whole run rather than derived here,
   * because a leg's counter-leg lives on a *different* account and a per-account computation
   * cannot see it.
   */
  readonly unpairedTransferPaymentIds?: readonly PaymentId[];
}

/** The computed totals of one account snapshot, before it is given an id and persisted. */
export type AccountCashSnapshotDraft = Omit<
  ReconciliationAccountSnapshot,
  'id' | 'reconciliationRunId' | 'createdAt'
>;

/**
 * True when this row is a second copy of a movement already counted, rather than a second
 * movement (17.6).
 *
 * The distinction is the whole of 17.6. A confirmed duplicate carries `duplicate_of:<id>` and
 * must be dropped, or the same money is counted twice. Everything else — including a payment
 * ignored as `out_of_scope`, and including the second leg of a genuine transfer — is a real
 * bank movement and participates, however it was scoped for *spending*.
 */
export function isDuplicateRepresentation(movement: {
  readonly state: PaymentState;
  readonly ignoredReason: string | null;
}): boolean {
  return movement.state === 'ignored' && parseDuplicateOfReason(movement.ignoredReason) !== null;
}

/**
 * How much of this movement is explained, in paise.
 *
 * Whole-movement categorical explanations come first and stand alone:
 *
 *  - an **approved** `INTERNAL_TRANSFER` or `EXTERNAL_INFLOW` is its own explanation
 *    ({@link categoryExplainsWholeMovement}), and
 *  - a payment whose `counterparty_type` is `internal_account` or `investment_instrument` is
 *    explained by that resolution alone. Both are deterministic conclusions, not inferences —
 *    ADR-0023 established the first from two rows' own fields, and ADR-0011 the second — and
 *    neither can carry a `PaymentExpenseLink` to be explained by (`invariants.md` #7).
 *
 * Everything else is explained by the records that reference it, capped at its own amount so
 * that a partially-attributed movement leaves a visible remainder rather than an over-explained
 * total (17.1, 17.6).
 */
export function explainedAmount(movement: CashMovement): Paise {
  if (
    categoryExplainsWholeMovement(movement.cashFlowCategory, movement.cashFlowState) ||
    isNonSpendCounterparty(movement.counterpartyType)
  ) {
    return movement.amount;
  }
  const attributed =
    movement.explanation.expenseLinkTotal +
    movement.explanation.settlementTotal +
    movement.explanation.adjustmentTotal;
  return (attributed > movement.amount ? movement.amount : attributed) as Paise;
}

/**
 * True when this movement is one leg of a transfer between the user's own accounts.
 *
 * Reads both signals, because they arrive at different times: `counterparty_type` is written
 * by phase 8's deterministic pairing (ADR-0023), and an approved `INTERNAL_TRANSFER` category
 * is this ADR's own classification. Either one makes the leg a transfer for the purposes of
 * the internal-transfer subtotals.
 */
export function isInternalTransferLeg(movement: {
  readonly counterpartyType: PaymentCounterpartyType;
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly cashFlowState: CashFlowState;
}): boolean {
  if (movement.counterpartyType === 'internal_account') return true;
  return movement.cashFlowCategory === 'INTERNAL_TRANSFER' && movement.cashFlowState === 'approved';
}

/**
 * Computes one account's snapshot for one period.
 *
 * Pure arithmetic over `bigint` paise plus the verification rule; no I/O, no clamping, no
 * tolerance. The caller supplies the movements (already filtered to the account and the
 * interval) and whatever boundary evidence exists.
 */
export function computeAccountCashSnapshot(
  input: AccountCashSnapshotInput,
): AccountCashSnapshotDraft {
  if (input.periodEnd <= input.periodStart) {
    throw new DomainError(
      'CASH_SNAPSHOT_SHAPE_INVALID',
      `A snapshot's period must be a non-empty half-open interval, but ${input.periodEnd.toISOString()} ` +
        `is not after ${input.periodStart.toISOString()} (ADR-0017 (cash balance)).`,
      { periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString() },
    );
  }
  assertBoundaryShape(input.boundaries);

  let totalDebits = 0n;
  let totalCredits = 0n;
  let explainedDebits = 0n;
  let explainedCredits = 0n;
  let internalTransferDebits = 0n;
  let internalTransferCredits = 0n;
  const countedPaymentIds: string[] = [];

  for (const movement of input.movements) {
    if (movement.accountId !== input.accountId) {
      throw new DomainError(
        'CASH_SNAPSHOT_SHAPE_INVALID',
        `Movement ${movement.paymentId} belongs to account ${movement.accountId}, not to this ` +
          `snapshot's account ${input.accountId}. Each account is verified independently (17.6).`,
        { paymentId: movement.paymentId, accountId: movement.accountId },
      );
    }
    // A confirmed duplicate is the same money written down twice; every other row — including
    // an `out_of_scope` one — is a real movement the statement made (17.6).
    if (isDuplicateRepresentation(movement)) continue;

    assertNonNegative(movement.amount, `cashMovement[${movement.paymentId}].amount`);
    const explained = explainedAmount(movement);
    const transferLeg = isInternalTransferLeg(movement);
    countedPaymentIds.push(movement.paymentId);

    if (movement.direction === 'debit') {
      totalDebits += movement.amount;
      explainedDebits += explained;
      if (transferLeg) internalTransferDebits += movement.amount;
    } else {
      totalCredits += movement.amount;
      explainedCredits += explained;
      if (transferLeg) internalTransferCredits += movement.amount;
    }
  }

  const unexplainedDebits = totalDebits - explainedDebits;
  const unexplainedCredits = totalCredits - explainedCredits;

  // Both derived values stay null until *both* boundaries are evidenced. `expected` alone
  // would be computable from the opening balance, but publishing it without a closing balance
  // to check it against invites reading it as the account's actual cash (17.5).
  const bothBoundaries =
    input.boundaries.openingBalance !== null && input.boundaries.closingBalance !== null;
  const expectedEndingBalance = bothBoundaries
    ? ((input.boundaries.openingBalance + totalCredits - totalDebits) as Paise)
    : null;
  const cashBalanceDelta =
    expectedEndingBalance === null
      ? null
      : (((input.boundaries.closingBalance as Paise) - expectedEndingBalance) as Paise);

  const unpaired = input.unpairedTransferPaymentIds ?? [];
  const discrepancies = collectDiscrepancies({
    boundaries: input.boundaries,
    cashBalanceDelta,
    unexplainedDebits: unexplainedDebits as Paise,
    unexplainedCredits: unexplainedCredits as Paise,
    unpaired,
  });

  return {
    accountId: input.accountId,
    currency: input.currency,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    openingBalance: input.boundaries.openingBalance,
    closingBalance: input.boundaries.closingBalance,
    openingBalanceEvidenceId: input.boundaries.openingBalanceEvidenceId,
    closingBalanceEvidenceId: input.boundaries.closingBalanceEvidenceId,
    totalDebits: totalDebits as Paise,
    totalCredits: totalCredits as Paise,
    internalTransferDebits: internalTransferDebits as Paise,
    internalTransferCredits: internalTransferCredits as Paise,
    explainedDebits: explainedDebits as Paise,
    unexplainedDebits: unexplainedDebits as Paise,
    explainedCredits: explainedCredits as Paise,
    unexplainedCredits: unexplainedCredits as Paise,
    expectedEndingBalance,
    cashBalanceDelta,
    verificationStatus: verificationStatus({
      openingBalance: input.boundaries.openingBalance,
      closingBalance: input.boundaries.closingBalance,
      cashBalanceDelta,
      unexplainedDebits: unexplainedDebits as Paise,
      unexplainedCredits: unexplainedCredits as Paise,
      discrepancies,
    }),
    discrepancies,
    provenance: {
      countedPaymentIds,
      unpairedTransferPaymentIds: [...unpaired],
    },
  };
}

/**
 * The verification rule (17.6), stated once.
 *
 * `verified` requires *all* of: both boundaries evidenced, a zero cash delta, zero unexplained
 * debits, zero unexplained credits, and no unresolved discrepancy. Anything short of that is
 * `unreconciled` when the inputs are complete and `incomplete` when they are not — because
 * "the arithmetic came out to zero" over transactions nobody has identified is not a verified
 * ₹0 Unaccounted Delta, and saying so would be the single most misleading thing this system
 * could report.
 */
export function verificationStatus(input: {
  readonly openingBalance: Paise | null;
  readonly closingBalance: Paise | null;
  readonly cashBalanceDelta: Paise | null;
  readonly unexplainedDebits: Paise;
  readonly unexplainedCredits: Paise;
  readonly discrepancies: readonly CashReconciliationDiscrepancy[];
}): ReconciliationVerificationStatus {
  if (
    input.openingBalance === null ||
    input.closingBalance === null ||
    input.cashBalanceDelta === null
  ) {
    return 'incomplete';
  }
  if (
    input.cashBalanceDelta !== 0n ||
    input.unexplainedDebits !== 0n ||
    input.unexplainedCredits !== 0n ||
    input.discrepancies.length > 0
  ) {
    return 'unreconciled';
  }
  return 'verified';
}

/**
 * Re-checks a snapshot's stored arithmetic (17.4, 17.7).
 *
 * Called before a row is written, so a snapshot assembled by any path other than
 * {@link computeAccountCashSnapshot} still cannot persist an inconsistent report. The database
 * carries the same identities as row-local `CHECK`s; this is the layer that produces a domain
 * error naming the term that disagrees rather than a constraint violation.
 */
export function validateAccountCashSnapshot(snapshot: AccountCashSnapshotDraft): void {
  assertBoundaryShape(snapshot);

  for (const [field, value] of [
    ['totalDebits', snapshot.totalDebits],
    ['totalCredits', snapshot.totalCredits],
    ['explainedDebits', snapshot.explainedDebits],
    ['unexplainedDebits', snapshot.unexplainedDebits],
    ['explainedCredits', snapshot.explainedCredits],
    ['unexplainedCredits', snapshot.unexplainedCredits],
    ['internalTransferDebits', snapshot.internalTransferDebits],
    ['internalTransferCredits', snapshot.internalTransferCredits],
  ] as const) {
    assertNonNegative(value, `reconciliationAccountSnapshot.${field}`);
  }

  requireIdentity(
    snapshot.explainedDebits + snapshot.unexplainedDebits === snapshot.totalDebits,
    `total_debits (${snapshot.totalDebits}) must equal explained_debits (${snapshot.explainedDebits}) ` +
      `+ unexplained_debits (${snapshot.unexplainedDebits})`,
  );
  requireIdentity(
    snapshot.explainedCredits + snapshot.unexplainedCredits === snapshot.totalCredits,
    `total_credits (${snapshot.totalCredits}) must equal explained_credits (${snapshot.explainedCredits}) ` +
      `+ unexplained_credits (${snapshot.unexplainedCredits})`,
  );
  requireIdentity(
    snapshot.internalTransferDebits <= snapshot.totalDebits &&
      snapshot.internalTransferCredits <= snapshot.totalCredits,
    'internal-transfer totals are subsets of the movement totals, not additional terms (17.3)',
  );

  const bothBoundaries = snapshot.openingBalance !== null && snapshot.closingBalance !== null;
  if (!bothBoundaries) {
    requireIdentity(
      snapshot.expectedEndingBalance === null && snapshot.cashBalanceDelta === null,
      'expected_ending_balance and cash_balance_delta stay null until both boundary balances ' +
        'are evidenced — a derived balance over a missing boundary is not a fact (17.5)',
    );
  } else {
    requireIdentity(
      snapshot.expectedEndingBalance ===
        snapshot.openingBalance + snapshot.totalCredits - snapshot.totalDebits,
      `expected_ending_balance (${String(snapshot.expectedEndingBalance)}) must equal ` +
        `opening_balance + total_credits - total_debits`,
    );
    requireIdentity(
      snapshot.cashBalanceDelta ===
        snapshot.closingBalance - (snapshot.expectedEndingBalance as Paise),
      `cash_balance_delta (${String(snapshot.cashBalanceDelta)}) must equal ` +
        `closing_balance - expected_ending_balance`,
    );
  }

  const expectedStatus = verificationStatus(snapshot);
  requireIdentity(
    snapshot.verificationStatus === expectedStatus,
    `verification_status is "${snapshot.verificationStatus}" but the snapshot's own figures ` +
      `make it "${expectedStatus}" (17.6)`,
  );
}

/* ---------------------------------------------------------------- internal transfers */

/** Two legs of one transfer, matched deterministically across two owned accounts. */
export interface InternalTransferPair {
  readonly debitPaymentId: PaymentId;
  readonly creditPaymentId: PaymentId;
  readonly amount: Paise;
  readonly externalReference: string;
}

export interface InternalTransferPairing {
  readonly pairs: readonly InternalTransferPair[];
  /** Legs with no counter-leg in scope: missing, out of scope, or posting in another period. */
  readonly unpaired: readonly PaymentId[];
}

/**
 * Matches internal-transfer legs across every account in one run (17.3).
 *
 * The rule mirrors `domain.isSelfTransferPair` (ADR-0023) rather than inventing a second,
 * looser one: the same non-null `external_reference`, equal amounts, opposite directions, and
 * — added here, because this function sees more than one account at a time — two *different*
 * accounts. Same-reference legs on one account are the same money written down twice, not a
 * transfer between the user's own accounts.
 *
 * Deterministic: candidates are consumed in `paymentId` order, so the same input always yields
 * the same pairs. A leg left over is reported, never invented a partner for — "never invent a
 * balancing leg or force a period-neutral total" (17.3).
 */
export function pairInternalTransfers(movements: readonly CashMovement[]): InternalTransferPairing {
  const legs = movements
    .filter((movement) => !isDuplicateRepresentation(movement) && isInternalTransferLeg(movement))
    .slice()
    .sort((a, b) => (a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : 0));

  const pairs: InternalTransferPair[] = [];
  const unpaired: PaymentId[] = [];
  const consumed = new Set<PaymentId>();

  for (const leg of legs) {
    if (consumed.has(leg.paymentId)) continue;
    if (leg.externalReference === null) {
      unpaired.push(leg.paymentId);
      continue;
    }
    const counter = legs.find(
      (candidate) =>
        !consumed.has(candidate.paymentId) &&
        candidate.paymentId !== leg.paymentId &&
        candidate.externalReference === leg.externalReference &&
        candidate.amount === leg.amount &&
        candidate.direction !== leg.direction &&
        candidate.accountId !== leg.accountId,
    );
    if (counter === undefined) {
      unpaired.push(leg.paymentId);
      continue;
    }
    consumed.add(leg.paymentId);
    consumed.add(counter.paymentId);
    const debitLeg = leg.direction === 'debit' ? leg : counter;
    const creditLeg = leg.direction === 'debit' ? counter : leg;
    pairs.push({
      debitPaymentId: debitLeg.paymentId,
      creditPaymentId: creditLeg.paymentId,
      amount: leg.amount,
      externalReference: leg.externalReference,
    });
  }

  return { pairs, unpaired };
}

/**
 * `internal-transfer credits - internal-transfer debits` across a consolidated set of
 * snapshots.
 *
 * Zero when every leg in scope is matched, which is what "cash-neutral" means: the money never
 * left the user's accounts, so it cannot change consolidated cash. A non-zero result is a real
 * signal — an unmatched or cross-period leg — and is returned rather than corrected.
 */
export function consolidatedInternalTransferNet(
  snapshots: readonly Pick<
    AccountCashSnapshotDraft,
    'internalTransferCredits' | 'internalTransferDebits'
  >[],
): Paise {
  let net = 0n;
  for (const snapshot of snapshots) {
    net += snapshot.internalTransferCredits - snapshot.internalTransferDebits;
  }
  return net as Paise;
}

/**
 * Asserts 17.3's neutrality over a fully paired scope.
 *
 * Only meaningful when there are no unpaired legs, which is why the pairing is an argument: an
 * unpaired leg makes a non-zero net *correct*, and asserting neutrality anyway would push
 * callers toward inventing the missing leg to satisfy the check.
 */
export function validateInternalTransferNeutrality(
  snapshots: readonly Pick<
    AccountCashSnapshotDraft,
    'internalTransferCredits' | 'internalTransferDebits'
  >[],
  pairing: InternalTransferPairing,
): void {
  if (pairing.unpaired.length > 0) return;
  const net = consolidatedInternalTransferNet(snapshots);
  if (net === 0n) return;
  throw new DomainError(
    'INTERNAL_TRANSFER_NOT_NEUTRAL',
    `Internal-transfer credits minus debits is ${net} paise across a fully paired scope, but ` +
      "matched legs move the user's own money between the user's own accounts and must " +
      'cancel (ADR-0017 (cash balance), 17.3).',
    { net: net.toString(), pairs: String(pairing.pairs.length) },
  );
}

/* ------------------------------------------------------------------------- internals */

function collectDiscrepancies(input: {
  readonly boundaries: AccountBoundaryBalances;
  readonly cashBalanceDelta: Paise | null;
  readonly unexplainedDebits: Paise;
  readonly unexplainedCredits: Paise;
  readonly unpaired: readonly PaymentId[];
}): readonly CashReconciliationDiscrepancy[] {
  const discrepancies: CashReconciliationDiscrepancy[] = [];

  if (input.boundaries.openingBalance === null) {
    discrepancies.push({
      kind: 'missing_opening_balance',
      detail:
        'No evidenced opening balance for this account and period, so the cash identity cannot ' +
        'be computed. Unknown is not zero (ADR-0017 (cash balance), 17.5).',
    });
  }
  if (input.boundaries.closingBalance === null) {
    discrepancies.push({
      kind: 'missing_closing_balance',
      detail:
        'No evidenced closing balance for this account and period. The actual ending balance ' +
        'must come from statement evidence, never from the movements it is meant to check ' +
        '(ADR-0017 (cash balance), 17.5).',
    });
  }
  if (input.cashBalanceDelta !== null && input.cashBalanceDelta !== 0n) {
    discrepancies.push({
      kind: 'cash_balance_delta_nonzero',
      detail:
        `The statement's closing balance differs from opening + credits - debits by ` +
        `${input.cashBalanceDelta} paise. Displayed signed, with no tolerance and no clamping ` +
        '(ADR-0017 (cash balance), 17.4).',
      amount: input.cashBalanceDelta,
    });
  }
  if (input.unexplainedDebits !== 0n) {
    discrepancies.push({
      kind: 'unexplained_debits',
      detail:
        `${input.unexplainedDebits} paise of debits on this account are not covered by an ` +
        'approved expense link, settlement or cash-flow category.',
      amount: input.unexplainedDebits,
    });
  }
  if (input.unexplainedCredits !== 0n) {
    discrepancies.push({
      kind: 'unexplained_credits',
      detail:
        `${input.unexplainedCredits} paise of credits on this account are not explained. An ` +
        'unclassified credit is unexplained, never automatic income (ADR-0017 (cash balance), 17.2).',
      amount: input.unexplainedCredits,
    });
  }
  for (const paymentId of input.unpaired) {
    discrepancies.push({
      kind: 'unpaired_internal_transfer',
      detail:
        'This internal-transfer leg has no counter-leg in scope. It may post in another period ' +
        'or through an account outside this run; the leg stays visible rather than having a ' +
        'balancing leg invented for it (ADR-0017 (cash balance), 17.3).',
      paymentId,
    });
  }

  return discrepancies;
}

/** A balance and its evidence are present together, or neither is (17.5). */
function assertBoundaryShape(boundaries: AccountBoundaryBalances): void {
  if ((boundaries.openingBalance === null) !== (boundaries.openingBalanceEvidenceId === null)) {
    throw boundaryShapeError('opening');
  }
  if ((boundaries.closingBalance === null) !== (boundaries.closingBalanceEvidenceId === null)) {
    throw boundaryShapeError('closing');
  }
}

function boundaryShapeError(boundary: 'opening' | 'closing'): DomainError {
  return new DomainError(
    'CASH_SNAPSHOT_SHAPE_INVALID',
    `A ${boundary} balance and the Evidence it comes from are present together or not at all. ` +
      'A balance with no evidence is a number somebody typed, and an evidence reference with ' +
      'no balance describes nothing (ADR-0017 (cash balance), 17.5).',
    { boundary },
  );
}

function requireIdentity(holds: boolean, description: string): void {
  if (holds) return;
  throw new DomainError(
    'CASH_BALANCE_IDENTITY_MISMATCH',
    `${description} (ADR-0017 (cash balance), 17.4/17.7).`,
    { identity: description },
  );
}
