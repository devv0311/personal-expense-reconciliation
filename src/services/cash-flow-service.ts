/**
 * The cash-flow classification lifecycle (ADR-0017 (cash balance), `lifecycle.md`).
 *
 * ```text
 * IMPORTED -> NORMALIZED -> CASH_FLOW_CLASSIFIED -> APPROVED
 * ```
 *
 * Three deliberately separate, all-visible steps, mirroring how `adjustment-service` keeps
 * recording an adjustment apart from distributing it:
 *
 *  1. {@link markPaymentCashFlowNormalized} — the payment's structure has been read, and it is
 *     now a candidate for classification.
 *  2. {@link classifyPaymentCashFlow} — a validated **proposal** about what the movement is.
 *     It writes the category, and that is all it writes: a proposal never explains a paise.
 *  3. {@link approvePaymentCashFlow} — an explicit decision by a person or an applicable
 *     approved `Rule`, gated on evidence the ledger can actually show. Only after this does
 *     the category explain anything in a cash snapshot.
 *
 * {@link rejectPaymentCashFlow} returns a declined proposal to review with no category, and
 * re-running {@link classifyPaymentCashFlow} against an approved payment is a reclassification
 * — an audited new decision that drops the approval, never a silent edit of one.
 *
 * This lifecycle runs **alongside** `Payment.state` and never touches it. A `linked` payment
 * is not thereby cash-flow approved, and an approved transfer is still `normalized` in the
 * legacy lifecycle, which is a valid terminal state for it (`invariants.md` #7, ADR-0011).
 */

import {
  assertCashFlowTransition,
  validateCashFlowApproval,
  validateCashFlowDirection,
} from '../domain/index.js';
import type { CashFlowCategory, CashFlowState, PaymentId, UserId } from '../domain/index.js';
import {
  countAdjustmentsForPayment,
  countEvidenceForPayment,
  countSettlementsForPayment,
  getPaymentCashFlow,
  isAccountOwnedByUser,
  updatePaymentCashFlow,
} from '../db/index.js';
import type { Database, Executor, PaymentCashFlowRow } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

export interface CashFlowDecisionResult {
  readonly paymentId: PaymentId;
  readonly cashFlowState: CashFlowState;
  readonly cashFlowCategory: CashFlowCategory | null;
}

export interface MarkCashFlowNormalizedInput {
  readonly paymentId: PaymentId;
  readonly audit: AuditMeta;
}

/**
 * Moves a payment from `imported` to `normalized` in the cash-flow lifecycle.
 *
 * Separate from `services.normalizePayments`, which owns the *legacy* `Payment.state` and
 * `counterparty_type`. Folding the two together would make one write imply the other, and
 * ADR-0017 is explicit that this lifecycle is added alongside the existing one rather than
 * replacing or renaming any of its states.
 */
export async function markPaymentCashFlowNormalized(
  db: Database,
  input: MarkCashFlowNormalizedInput,
): Promise<CashFlowDecisionResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const payment = await requireCashFlowPayment(exec, input.paymentId);
    assertCashFlowTransition(payment.cashFlowState, 'normalized');

    await updatePaymentCashFlow(exec, payment.id, {
      cashFlowCategory: null,
      cashFlowState: 'normalized',
      cashFlowApprovedAt: null,
      cashFlowApprovedBy: null,
    });
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: { cashFlowState: payment.cashFlowState },
      newValue: { cashFlowState: 'normalized' },
    });

    return { paymentId: payment.id, cashFlowState: 'normalized', cashFlowCategory: null };
  });
}

export interface ClassifyCashFlowInput {
  readonly paymentId: PaymentId;
  /** The proposed role. Validated against the payment's direction before it is written. */
  readonly category: CashFlowCategory;
  readonly audit: AuditMeta;
}

/**
 * Records a validated cash-flow **proposal**.
 *
 * Only the direction rule applies here, because it is the one that holds absolutely: a debit
 * refund is arithmetically impossible, not a judgement call. The counterparty and evidence
 * requirements are approval gates — ADR-0017 allows "an unresolved counterparty during
 * normalization", and demanding one now would make the rows that most need a proposal the
 * ones that cannot have one.
 *
 * Reclassifying an approved payment is allowed and drops the approval: the role goes back to
 * being a proposal, and someone has to approve it again (`lifecycle.md`).
 */
export async function classifyPaymentCashFlow(
  db: Database,
  input: ClassifyCashFlowInput,
): Promise<CashFlowDecisionResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const payment = await requireCashFlowPayment(exec, input.paymentId);
    assertCashFlowTransition(payment.cashFlowState, 'cash_flow_classified');
    validateCashFlowDirection(input.category, payment.direction);

    await updatePaymentCashFlow(exec, payment.id, {
      cashFlowCategory: input.category,
      cashFlowState: 'cash_flow_classified',
      // Dropped on purpose: a reclassification is a new decision, and carrying the old
      // approval forward would let a category nobody approved keep an approval stamp.
      cashFlowApprovedAt: null,
      cashFlowApprovedBy: null,
    });
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: {
        cashFlowState: payment.cashFlowState,
        cashFlowCategory: payment.cashFlowCategory,
        cashFlowApprovedBy: payment.cashFlowApprovedBy,
      },
      newValue: {
        cashFlowState: 'cash_flow_classified',
        cashFlowCategory: input.category,
        reclassified: payment.cashFlowState === 'approved',
      },
    });

    return {
      paymentId: payment.id,
      cashFlowState: 'cash_flow_classified',
      cashFlowCategory: input.category,
    };
  });
}

export interface ApproveCashFlowInput {
  readonly paymentId: PaymentId;
  /** Whose accounts count as the user's own, for the internal-transfer gate. */
  readonly ownerUserId: UserId;
  /** The counter-leg of a transfer, when the caller has already found one (ADR-0023). */
  readonly counterLegPaymentId?: PaymentId | null;
  /** `'user'` or `'rule:<rule_id>'` — never a model (`ai-boundary.md`, `invariants.md` #17). */
  readonly decidedBy: string;
  readonly decidedAt?: Date;
  readonly audit: AuditMeta;
}

/**
 * Approves a payment's cash-flow role, or refuses for want of evidence.
 *
 * The evidence handed to `domain.validateCashFlowApproval` is counted from the ledger's own
 * rows — settlements, adjustments, attached evidence, account ownership — never supplied by
 * the caller and never a confidence score. High confidence does not waive approval, and a
 * category label on its own never creates the `Settlement` or `ExpenseAdjustment` that would
 * justify it (17.1, 17.2).
 *
 * A debit with no category can be approved: it keeps whatever spend or investment explanation
 * it already had. A credit with no category cannot, because an unclassified credit is
 * unexplained.
 */
export async function approvePaymentCashFlow(
  db: Database,
  input: ApproveCashFlowInput,
): Promise<CashFlowDecisionResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const payment = await requireCashFlowPayment(exec, input.paymentId);
    assertCashFlowTransition(payment.cashFlowState, 'approved');
    assertDecisionActor(input.decidedBy);

    const [settlementCount, expenseAdjustmentCount, linkedEvidenceCount, ownedAccount] =
      await Promise.all([
        countSettlementsForPayment(exec, payment.id),
        countAdjustmentsForPayment(exec, payment.id),
        countEvidenceForPayment(exec, payment.id),
        isAccountOwnedByUser(exec, payment.accountId, input.ownerUserId),
      ]);

    validateCashFlowApproval({
      direction: payment.direction,
      counterpartyType: payment.counterpartyType,
      category: payment.cashFlowCategory,
      evidence: {
        settlementCount,
        expenseAdjustmentCount,
        linkedEvidenceCount,
        counterLegPaymentId: input.counterLegPaymentId ?? null,
        ownedAccount,
      },
    });

    const decidedAt = input.decidedAt ?? new Date();
    await updatePaymentCashFlow(exec, payment.id, {
      cashFlowCategory: payment.cashFlowCategory,
      cashFlowState: 'approved',
      cashFlowApprovedAt: decidedAt,
      cashFlowApprovedBy: input.decidedBy,
    });
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: { cashFlowState: payment.cashFlowState },
      newValue: {
        cashFlowState: 'approved',
        cashFlowCategory: payment.cashFlowCategory,
        cashFlowApprovedAt: decidedAt.toISOString(),
        cashFlowApprovedBy: input.decidedBy,
        settlementCount: String(settlementCount),
        expenseAdjustmentCount: String(expenseAdjustmentCount),
        linkedEvidenceCount: String(linkedEvidenceCount),
      },
    });

    return {
      paymentId: payment.id,
      cashFlowState: 'approved',
      cashFlowCategory: payment.cashFlowCategory,
    };
  });
}

export interface RejectCashFlowInput {
  readonly paymentId: PaymentId;
  readonly reason: string;
  readonly audit: AuditMeta;
}

/**
 * Declines a proposed classification, returning the payment to review with **no** category.
 *
 * Clearing the category is the point. Leaving a declined proposal's label on the row would
 * mean a credit nobody agreed about still reads as classified, and the whole reason an
 * unclassified credit stays unexplained is that nobody has vouched for what it is.
 */
export async function rejectPaymentCashFlow(
  db: Database,
  input: RejectCashFlowInput,
): Promise<CashFlowDecisionResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const payment = await requireCashFlowPayment(exec, input.paymentId);
    assertCashFlowTransition(payment.cashFlowState, 'normalized');

    await updatePaymentCashFlow(exec, payment.id, {
      cashFlowCategory: null,
      cashFlowState: 'normalized',
      cashFlowApprovedAt: null,
      cashFlowApprovedBy: null,
    });
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: {
        cashFlowState: payment.cashFlowState,
        cashFlowCategory: payment.cashFlowCategory,
      },
      newValue: { cashFlowState: 'normalized', cashFlowCategory: null },
      reason: input.reason,
    });

    return { paymentId: payment.id, cashFlowState: 'normalized', cashFlowCategory: null };
  });
}

/* ------------------------------------------------------------------------- internals */

async function requireCashFlowPayment(
  exec: Executor,
  paymentId: PaymentId,
): Promise<PaymentCashFlowRow> {
  const payment = await getPaymentCashFlow(exec, paymentId);
  if (payment === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `Payment ${paymentId} does not exist.`, {
      paymentId,
    });
  }
  return payment;
}

/**
 * `'user'` or `'rule:<rule_id>'`, and nothing else (`invariants.md` #17, `ai-boundary.md`).
 *
 * `'system'` is a valid `AuditEvent.actor` for a mechanical write, but it is not a valid
 * approver of a financial interpretation: something has to have decided, and "the system"
 * deciding what a credit was is the auto-approval this ADR exists to prevent.
 */
function assertDecisionActor(decidedBy: string): void {
  if (decidedBy === 'user' || decidedBy.startsWith('rule:')) return;
  throw new ServiceError(
    'PRECONDITION_FAILED',
    `"${decidedBy}" cannot approve a cash-flow classification. Approval is an explicit human ` +
      'decision or an applicable previously approved Rule; a model, a confidence level and ' +
      '"system" are all deliberately absent (ADR-0017 (cash balance), invariants.md #17).',
    { decidedBy },
  );
}
