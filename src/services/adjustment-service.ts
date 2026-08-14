/**
 * Refunds and reimbursements (ADR-0008).
 *
 * Two deliberately separate, both-visible steps (`lifecycle.md`, ExpenseAdjustment):
 *
 *  1. `recordExpenseAdjustment` — the money-came-back fact exists. The original expense's
 *     current `Allocation` still sums to the pre-adjustment net amount, and that is a real,
 *     valid, visible state rather than an error.
 *  2. `distributeAdjustment` — a new `Allocation` version supersedes the old one, summing to
 *     the new net amount, with the reduction distributed by an explicit decision.
 *
 * Neither ever mutates `Expense.amount`. The gross, historical figure is untouched forever;
 * only the derived `netAmount` and the current allocation move (`invariants.md` #6, #8).
 */

import {
  distributeAdjustment as distributeAcrossLines,
  netAmount as computeNetAmount,
  sumPaise,
  undistributedAmount,
  validateAdjustmentTotal,
  validateAllocationLineAmounts,
  validateAllocationSum,
} from '../domain/index.js';
import type {
  DraftAllocationLine,
  ExpenseAdjustmentKind,
  ExpenseId,
  Paise,
  PaymentId,
  PersonId,
} from '../domain/index.js';
import {
  insertAllocationWithLines,
  insertExpenseAdjustment,
  listGroupMemberships,
  markSplitwiseExpenseStale,
  supersedeAllocation,
} from '../db/index.js';
import type { AllocationLineDraft, Database, Executor } from '../db/index.js';
import {
  expandGroupAllocationLine,
  resolveGroupMembersAsOf,
  validateGroupExpansionSum,
} from '../domain/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { requireCurrentAllocation, requireExpenseSnapshot, requirePayment } from './loaders.js';

/** States in which an expense's cost is settled enough to be adjusted against. */
const ADJUSTABLE_STATES = new Set([
  'approved',
  'allocated',
  'ready_to_sync',
  'synced',
  'reconciled',
]);

export interface RecordExpenseAdjustmentInput {
  readonly expenseId: ExpenseId;
  readonly kind: ExpenseAdjustmentKind;
  /** Always a positive magnitude — there is no signed adjustment (`invariants.md` #12a). */
  readonly amount: Paise;
  /** The credit payment documenting the money coming back; null when evidence-first. */
  readonly adjustmentPaymentId?: PaymentId | null;
  readonly reason?: string | null;
  readonly occurredAt: Date;
  readonly audit: AuditMeta;
}

export interface RecordExpenseAdjustmentResult {
  readonly adjustmentId: string;
  /** The expense's net amount once this adjustment is distributed. */
  readonly netAmountAfter: Paise;
  /** True while the current allocation still sums to the pre-adjustment figure. */
  readonly pendingDistribution: boolean;
}

/**
 * Records money coming back against an existing expense.
 *
 * Does **not** touch the current allocation — that is `distributeAdjustment`'s job, kept
 * separate so a recorded-but-not-yet-distributed adjustment is never silently invisible.
 */
export async function recordExpenseAdjustment(
  db: Database,
  input: RecordExpenseAdjustmentInput,
): Promise<RecordExpenseAdjustmentResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const expense = await requireExpenseSnapshot(exec, input.expenseId);
    if (!ADJUSTABLE_STATES.has(expense.state)) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `Expense ${expense.id} is "${expense.state}". An ExpenseAdjustment records money ` +
          'returned against an already-approved expense; correct an unapproved expense by ' +
          'setting its amount instead (ADR-0008).',
        { expenseId: expense.id, state: expense.state },
      );
    }

    // Invariant #8: an expense cannot be refunded or reimbursed for more than it cost.
    validateAdjustmentTotal(expense.grossAmount, [...expense.adjustmentAmounts, input.amount]);

    const adjustmentPaymentId = input.adjustmentPaymentId ?? null;
    if (adjustmentPaymentId !== null) {
      const payment = await requirePayment(exec, adjustmentPaymentId);
      if (payment.direction !== 'credit') {
        throw new ServiceError(
          'PRECONDITION_FAILED',
          `Payment ${payment.id} is a ${payment.direction}. An ExpenseAdjustment documents ` +
            'money coming *back*, so its payment is a credit (domain-model.md, ' +
            'ExpenseAdjustment).',
          { paymentId: payment.id, direction: payment.direction },
        );
      }
    }

    const adjustmentId = await insertExpenseAdjustment(exec, {
      originalExpenseId: expense.id,
      kind: input.kind,
      amount: input.amount,
      adjustmentPaymentId,
      reason: input.reason ?? null,
      occurredAt: input.occurredAt,
    });

    const netAmountAfter = computeNetAmount(expense.grossAmount, [
      ...expense.adjustmentAmounts,
      input.amount,
    ]);

    await record({
      entityType: 'expense_adjustment',
      entityId: adjustmentId,
      action: 'create',
      newValue: {
        originalExpenseId: expense.id,
        kind: input.kind,
        amount: input.amount.toString(),
        adjustmentPaymentId,
        // The gross amount is deliberately echoed here, unchanged, so the audit trail shows
        // what the expense cost before and after without implying it was edited.
        expenseGrossAmount: expense.grossAmount.toString(),
        netAmountAfter: netAmountAfter.toString(),
        state: 'recorded',
      },
    });

    return { adjustmentId, netAmountAfter, pendingDistribution: true };
  });
}

export interface DistributeAdjustmentInput {
  readonly expenseId: ExpenseId;
  /**
   * An explicit, non-proportional distribution, positionally aligned with the current
   * allocation's lines. Omit for the proportional-to-existing-share default.
   */
  readonly customWeights?: readonly bigint[];
  readonly audit: AuditMeta;
  readonly decidedBy?: string;
  readonly decidedAt?: Date;
}

export interface DistributeAdjustmentResult {
  readonly allocationId: string;
  readonly supersededAllocationId: string;
  readonly distributedAmount: Paise;
  readonly netAmount: Paise;
  readonly lines: readonly DraftAllocationLine[];
  /** Splitwise rows moved to `stale` because our side changed (ADR-0008). */
  readonly staleSplitwiseExpenseIds: readonly string[];
}

/**
 * Creates the superseding allocation that reflects every recorded-but-undistributed
 * adjustment.
 *
 * The amount to distribute is derived — the current lines' total minus the expense's
 * current net amount — rather than tracked per adjustment, so recording two refunds and
 * distributing once produces exactly the same result as distributing after each.
 */
export async function distributeAdjustment(
  db: Database,
  input: DistributeAdjustmentInput,
): Promise<DistributeAdjustmentResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const expense = await requireExpenseSnapshot(exec, input.expenseId);
    const current = await requireCurrentAllocation(exec, expense.id);

    const currentTotal = sumPaise(current.lines.map((line) => line.amount));
    const pending = undistributedAmount(currentTotal, expense.netAmount);
    if (pending === 0n) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `Expense ${expense.id} has no undistributed adjustment: its current allocation already ` +
          `sums to its net amount of ${expense.netAmount} paise.`,
        { expenseId: expense.id, netAmount: expense.netAmount.toString() },
      );
    }

    const newLines = distributeAcrossLines({
      lines: current.lines,
      adjustmentAmount: pending,
      ...(input.customWeights === undefined ? {} : { customWeights: input.customWeights }),
    });
    validateAllocationLineAmounts(newLines);
    validateAllocationSum(newLines, expense.netAmount);

    const decidedAt = input.decidedAt ?? new Date();
    await supersedeAllocation(exec, current.allocation.id, decidedAt);
    await record({
      entityType: 'allocation',
      entityId: current.allocation.id,
      action: 'supersede',
      oldValue: { lines: serialise(current.lines) },
      newValue: { supersededAt: decidedAt.toISOString(), reason: 'expense_adjustment_distributed' },
    });

    const drafts: AllocationLineDraft[] = [];
    for (const line of newLines) {
      drafts.push(await toDraft(exec, expense.occurredAt, line));
    }

    const inserted = await insertAllocationWithLines(exec, {
      expenseId: expense.id,
      // The superseding version keeps the method the user originally decided on; the
      // adjustment changed the amounts, not how the expense was divided.
      method: current.allocation.method,
      decidedBy: input.decidedBy ?? current.allocation.decidedBy,
      decidedAt,
      lines: drafts,
    });

    await record({
      entityType: 'allocation',
      entityId: inserted.allocationId,
      action: 'create',
      newValue: {
        expenseId: expense.id,
        distributedAmount: pending.toString(),
        netAmount: expense.netAmount.toString(),
        distribution: input.customWeights === undefined ? 'proportional' : 'custom',
        lines: serialise(newLines),
      },
    });

    // Our side changed, so an already-synced Splitwise expense is stale — distinct from
    // drifted, and never auto-resolved (ADR-0008, invariant #18).
    const staleSplitwiseExpenseIds = await markSplitwiseExpenseStale(exec, expense.id);
    for (const splitwiseExpenseId of staleSplitwiseExpenseIds) {
      await record({
        entityType: 'splitwise_expense',
        entityId: splitwiseExpenseId,
        action: 'update',
        oldValue: { syncStatus: 'synced' },
        newValue: {
          syncStatus: 'stale',
          // At netAmount 0 the fresh proposal is a deletion, not a zero-amount push
          // (ADR-0013). Acting on it is Phase 14; recording which it will be is not.
          freshProposal: expense.netAmount === 0n ? 'delete' : 'amount_update',
        },
      });
    }

    return {
      allocationId: inserted.allocationId,
      supersededAllocationId: current.allocation.id,
      distributedAmount: pending,
      netAmount: expense.netAmount,
      lines: newLines,
      staleSplitwiseExpenseIds,
    };
  });
}

/* ------------------------------------------------------------------------- internals */

/**
 * Re-resolves a group line's expansion for the **new** allocation version.
 *
 * Resolution uses the same `Expense.occurredAt` as the original, so it yields the same
 * member set; the previous version's rows are left exactly as written. "Never recomputed"
 * (ADR-0009) is a promise about existing rows, not a bar on a new allocation version having
 * its own.
 */
async function toDraft(
  exec: Executor,
  occurredAt: Date,
  line: DraftAllocationLine,
): Promise<AllocationLineDraft> {
  const base = {
    beneficiaryType: line.beneficiary.type,
    beneficiaryId: line.beneficiary.id,
    amount: line.amount,
    percentage: line.percentage,
    expenseItemId: line.expenseItemId,
  } satisfies Omit<AllocationLineDraft, 'groupExpansion'>;

  if (line.beneficiary.type !== 'group') return base;

  const memberships = await listGroupMemberships(exec, line.beneficiary.id);
  const members: readonly PersonId[] = resolveGroupMembersAsOf(
    memberships,
    line.beneficiary.id,
    occurredAt,
  );
  const expansion = expandGroupAllocationLine({ lineAmount: line.amount, members });
  validateGroupExpansionSum(line.amount, expansion);
  return { ...base, groupExpansion: expansion };
}

function serialise(lines: readonly DraftAllocationLine[]): unknown {
  return lines.map((line) => ({
    beneficiaryType: line.beneficiary.type,
    beneficiaryId: line.beneficiary.id,
    amount: line.amount.toString(),
  }));
}
