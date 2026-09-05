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
 *
 * Phase 16 adds a third fact to step 1, from ADR-0018 (item refunds): **which item** came
 * back. When `recordExpenseAdjustment` is given an attribution set, it validates and persists
 * the complete set in the same transaction as the adjustment, under a row lock on the parent
 * expense so two concurrent refunds cannot each spend the same remaining ceiling. Legacy
 * whole-expense refunds keep working exactly as before, with no attribution rows (19.2) — but
 * a refund whose item *is* known must not silently take that path, which is why the caller
 * passes the attributions rather than this service inferring them.
 *
 * Distribution — turning net item costs into a superseding allocation and new obligations —
 * is Phase 18's work and deliberately absent here. `distributeAdjustment` below is still
 * ADR-0008's whole-expense proportional distribution, unchanged.
 */

import {
  distributeAdjustment as distributeAcrossLines,
  netAmount as computeNetAmount,
  sumPaise,
  undistributedAmount,
  validateAdjustmentTotal,
  validateAllocationLineAmounts,
  validateAllocationSum,
  validateRefundAttribution,
  netItemAmount,
} from '../domain/index.js';
import type {
  DraftAllocationLine,
  ExpenseAdjustmentId,
  ExpenseAdjustmentKind,
  ExpenseId,
  ExpenseItemId,
  Paise,
  PaymentId,
  PersonId,
  RefundAttributionDraft,
  RefundAttributionItemContext,
} from '../domain/index.js';
import {
  getExpenseItemOwner,
  insertAllocationWithLines,
  insertExpenseAdjustment,
  insertExpenseAdjustmentItems,
  listExpenseItemContexts,
  listGroupMemberships,
  listItemAttributionTotals,
  lockExpenseForAdjustment,
  markSplitwiseExpenseStale,
  sumAdjustmentsAgainstPayment,
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
  /**
   * Which purchased items this refund gave money back for (ADR-0018 (item refunds)).
   *
   * Omit for a legacy whole-expense refund, which keeps ADR-0008's documented path. Supply
   * the **complete** set when the items are known: attributions must sum exactly to `amount`,
   * and a partial set is refused rather than recorded as a pending remainder, because an
   * unexplained remainder must never become an approved item refund (19.2).
   */
  readonly itemAttributions?: readonly RefundAttributionDraft[];
  readonly audit: AuditMeta;
}

export interface RecordExpenseAdjustmentResult {
  readonly adjustmentId: string;
  /** The expense's net amount once this adjustment is distributed. */
  readonly netAmountAfter: Paise;
  /** True while the current allocation still sums to the pre-adjustment figure. */
  readonly pendingDistribution: boolean;
  /** Attribution rows written, and each affected item's derived net cost after them. */
  readonly itemAttributions: readonly {
    readonly expenseItemId: ExpenseItemId;
    readonly amount: Paise;
    readonly netItemAmount: Paise;
  }[];
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
    // 19.3's concurrency half. Taken before anything is read, so two refunds against one
    // expense cannot both observe the same remaining ceiling and both fit under it.
    await lockExpenseForAdjustment(exec, input.expenseId);

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

    const attributions = input.itemAttributions ?? [];
    // Validated *before* the adjustment row exists, so a rejected attribution set leaves no
    // adjustment behind at all: the item refund and the financial event it attributes are one
    // decision, and half of one is not a smaller version of it (ADR-0018, 19.2).
    if (attributions.length > 0) {
      await validateItemAttributions(exec, {
        expenseId: expense.id,
        expenseGrossAmount: expense.grossAmount,
        otherAdjustmentAmounts: expense.adjustmentAmounts,
        adjustmentAmount: input.amount,
        attributions,
        adjustmentPaymentId,
      });
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
        attributedItemCount: String(attributions.length),
        state: 'recorded',
      },
    });

    let recordedAttributions: RecordExpenseAdjustmentResult['itemAttributions'] = [];
    if (attributions.length > 0) {
      const inserted = await insertExpenseAdjustmentItems(
        exec,
        adjustmentId as ExpenseAdjustmentId,
        attributions.map((attribution) => ({
          expenseItemId: attribution.expenseItemId,
          amount: attribution.amount,
        })),
      );
      recordedAttributions = await describeAttributions(exec, expense.id, attributions);
      const rowIdByItem = new Map(inserted.map((row) => [row.expenseItemId, row.id]));

      // Its own audit entity, not a field on the adjustment's event: an attribution is the
      // decision about *what was returned*, and a reader asking "why does this item now cost
      // less?" must be able to find the answer against the item, not only the refund.
      for (const attribution of recordedAttributions) {
        const rowId = rowIdByItem.get(attribution.expenseItemId);
        if (rowId === undefined) continue;
        await record({
          entityType: 'expense_adjustment_item',
          entityId: rowId,
          action: 'create',
          newValue: {
            expenseAdjustmentId: adjustmentId,
            expenseItemId: attribution.expenseItemId,
            amount: attribution.amount.toString(),
            netItemAmount: attribution.netItemAmount.toString(),
          },
        });
      }
    }

    return {
      adjustmentId,
      netAmountAfter,
      pendingDistribution: true,
      itemAttributions: recordedAttributions,
    };
  });
}

/**
 * Assembles the ledger's own view of the items and the refund credit, then hands it to
 * `domain.validateRefundAttribution`.
 *
 * Every ceiling input is read here rather than trusted from the caller: an item's gross cost,
 * what other adjustments have already attributed to it, and what other adjustments already
 * draw from the same credit. An attribution naming an item of a *different* expense is looked
 * up on its own, so 19.1 can say "belongs to expense X" rather than the much less useful "no
 * such item".
 */
async function validateItemAttributions(
  exec: Executor,
  input: {
    readonly expenseId: ExpenseId;
    readonly expenseGrossAmount: Paise;
    readonly otherAdjustmentAmounts: readonly Paise[];
    readonly adjustmentAmount: Paise;
    readonly attributions: readonly RefundAttributionDraft[];
    readonly adjustmentPaymentId: PaymentId | null;
  },
): Promise<void> {
  const ownItems = await listExpenseItemContexts(exec, input.expenseId);
  if (ownItems.length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Expense ${input.expenseId} has no ExpenseItems, so a refund cannot be attributed to one. ` +
        'Itemize the purchase first, or record this as a legacy whole-expense adjustment ' +
        '(ADR-0018 (item refunds), 19.2).',
      { expenseId: input.expenseId },
    );
  }

  const attributedSoFar = await listItemAttributionTotals(exec, input.expenseId);
  const items: RefundAttributionItemContext[] = ownItems.map((item) => ({
    expenseItemId: item.expenseItemId,
    expenseId: item.expenseId,
    grossAmount: item.grossAmount,
    alreadyAttributed: attributedSoFar.get(item.expenseItemId) ?? (0n as Paise),
  }));

  // Foreign items, added so the domain reports a cross-expense attribution as exactly that.
  const known = new Set(items.map((item) => item.expenseItemId));
  for (const attribution of input.attributions) {
    if (known.has(attribution.expenseItemId)) continue;
    const owner = await getExpenseItemOwner(exec, attribution.expenseItemId);
    if (owner === null) continue;
    known.add(attribution.expenseItemId);
    items.push({
      expenseItemId: attribution.expenseItemId,
      expenseId: owner.expenseId,
      grossAmount: owner.grossAmount,
      alreadyAttributed: 0n as Paise,
    });
  }

  const refundPayment =
    input.adjustmentPaymentId === null
      ? undefined
      : {
          amount: (await requirePayment(exec, input.adjustmentPaymentId)).amount,
          alreadyAttributed: await sumAdjustmentsAgainstPayment(exec, input.adjustmentPaymentId),
        };

  validateRefundAttribution({
    expenseId: input.expenseId,
    adjustmentAmount: input.adjustmentAmount,
    attributions: input.attributions,
    items,
    expenseGrossAmount: input.expenseGrossAmount,
    otherAdjustmentAmounts: input.otherAdjustmentAmounts,
    ...(refundPayment === undefined ? {} : { refundPayment }),
  });
}

/** Each written attribution with the item's derived net cost, read back after the insert. */
async function describeAttributions(
  exec: Executor,
  expenseId: ExpenseId,
  attributions: readonly RefundAttributionDraft[],
): Promise<RecordExpenseAdjustmentResult['itemAttributions']> {
  const items = await listExpenseItemContexts(exec, expenseId);
  const grossById = new Map(items.map((item) => [item.expenseItemId, item.grossAmount]));
  const attributedNow = await listItemAttributionTotals(exec, expenseId);

  return attributions.map((attribution) => ({
    expenseItemId: attribution.expenseItemId,
    amount: attribution.amount,
    netItemAmount: netItemAmount(grossById.get(attribution.expenseItemId) ?? (0n as Paise), [
      attributedNow.get(attribution.expenseItemId) ?? (0n as Paise),
    ]),
  }));
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
