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
 * Phase 18 completes step 2. `distributeAdjustment` now picks its arithmetic from what the
 * ledger actually recorded rather than from one hard-coded default:
 *
 *  - **No attribution anywhere on the expense** — ADR-0008's whole-expense proportional
 *    distribution over the current lines, byte-for-byte the behaviour that shipped before.
 *  - **Any attribution** — `domain.buildItemAwareAllocationLines`: each item's net cost
 *    lands on that item's own beneficiaries, and any unattributed whole-expense reduction is
 *    applied once, afterwards, over the item-derived lines. An expense whose current
 *    allocation cannot say who owned an item is refused, not guessed at.
 *
 * `getRefundAllocationState` is the read beside it: what came back, per item, what a
 * distribution would write, and what is still pending — so "recorded but not distributed"
 * stays a visible state rather than an invisible one (ADR-0018, "Consequences").
 */

import {
  buildItemAwareAllocationLines,
  deriveItemRefundBases,
  distributeAdjustment as distributeAcrossLines,
  restoreAllocationToNetAmount,
  isDomainError,
  itemAwareAllocationTotal,
  netAmount as computeNetAmount,
  sumPaise,
  undistributedAmount,
  validateAdjustmentTotal,
  validateAllocationLineAmounts,
  validateAllocationSum,
  validateItemNetLineSums,
  validateRefundAttribution,
  netItemAmount,
} from '../domain/index.js';
import type {
  DraftAllocationLine,
  ExpenseAdjustmentId,
  ExpenseAdjustmentKind,
  ExpenseId,
  ExpenseItemId,
  ItemRefundBasis,
  Paise,
  PaymentId,
  PersonId,
  RefundAttributionDraft,
  RefundAttributionItemContext,
} from '../domain/index.js';
import {
  getExpenseAdjustmentById,
  getExpenseItemOwner,
  insertAllocationWithLines,
  insertExpenseAdjustment,
  insertExpenseAdjustmentItems,
  listExpenseAdjustmentSummaries,
  listExpenseItemContexts,
  listExpenseItemsByExpense,
  listGroupMemberships,
  listItemAttributionTotals,
  listExpenseAdjustmentHistory,
  lockExpenseForAdjustment,
  markExpenseAdjustmentReversed,
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
import {
  loadCurrentAllocation,
  requireCurrentAllocation,
  requireExpenseSnapshot,
  requirePayment,
} from './loaders.js';

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

/* --------------------------------------------------------------------------- history */

/** One adjustment as a history screen sees it, reversed ones included. */
export interface ExpenseAdjustmentHistoryEntry {
  readonly adjustmentId: ExpenseAdjustmentId;
  readonly kind: ExpenseAdjustmentKind;
  readonly amount: Paise;
  readonly adjustmentPaymentId: PaymentId | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
  readonly reversedAt: Date | null;
  readonly reversalReason: string | null;
  readonly reversedBy: string | null;
  /** `false` once reversed — the one field a caller needs to know whether it counts. */
  readonly counts: boolean;
}

/**
 * Every adjustment ever recorded against an expense, reversed ones included (ADR-0052).
 *
 * The deliberate counterpart to every other adjustment read: those exclude reversed rows
 * because a reversed refund never reduced anything, and this one includes them because a
 * ledger that hid its own corrections would be rewriting its past rather than recording it
 * (`invariants.md` #22).
 */
export async function listExpenseAdjustments(
  db: Database,
  expenseId: ExpenseId,
): Promise<readonly ExpenseAdjustmentHistoryEntry[]> {
  const rows = await listExpenseAdjustmentHistory(db, expenseId);
  return rows.map((row) => ({
    adjustmentId: row.id,
    kind: row.kind,
    amount: row.amount,
    adjustmentPaymentId: row.adjustmentPaymentId,
    reason: row.reason,
    occurredAt: row.occurredAt,
    reversedAt: row.reversedAt,
    reversalReason: row.reversalReason,
    reversedBy: row.reversedBy,
    counts: row.reversedAt === null,
  }));
}

/* --------------------------------------------------------------------------- reversal */

export interface ReverseExpenseAdjustmentInput {
  readonly adjustmentId: ExpenseAdjustmentId;
  /** Why this adjustment was wrong. Required. */
  readonly reason: string;
  readonly audit: AuditMeta;
}

export interface ReverseExpenseAdjustmentResult {
  readonly adjustmentId: ExpenseAdjustmentId;
  readonly expenseId: ExpenseId;
  /** The amount that stops counting. The row itself keeps it. */
  readonly reversedAmount: Paise;
  /** The expense's net amount once this adjustment stops counting. */
  readonly netAmountAfter: Paise;
  /**
   * True when the current allocation still sums to the figure the reversed adjustment
   * produced, and therefore needs re-distributing.
   *
   * A reversal does **not** rewrite an approved allocation — the same rule
   * `recordExpenseAdjustment` follows. Somebody approved those shares, and a correction to
   * what came back is not permission to silently change what everyone owes
   * (`invariants.md` #6). `distributeAdjustment` is still the deliberate second act.
   */
  readonly pendingRedistribution: boolean;
}

/**
 * Reverses an adjustment recorded in error (audit row 23, ADR-0052).
 *
 * The audit's finding: *"It cannot edit/remove a recorded adjustment."* Nor should it — an
 * adjustment is an authoritative record of an observed event and is append-only at the
 * database (`drizzle/security/immutable-table-grants.sql`). What was missing is the third
 * option between "edit it" and "live with it": **say it was wrong, and stop counting it**.
 *
 * The row is untouched apart from the three reversal columns. Its amount, its kind, its date
 * and the expense it named all stay exactly as written, so the expense timeline still shows
 * the refund somebody recorded by mistake and the reversal that undid it. Every read that
 * *counts* money stops seeing it (`db.ACTIVE_ADJUSTMENT`); the history read still does.
 *
 * What it deliberately does not do: rebuild the allocation. A reversal is new information
 * about what came back, exactly as a new adjustment is, and neither may silently rewrite
 * shares a person approved. The result says redistribution is pending and
 * `distributeAdjustment` remains the explicit act.
 *
 * @throws ServiceError `PRECONDITION_FAILED` when the reason is blank, or when the adjustment
 *   has already been reversed — reversing twice would be a second account of one correction.
 * @throws ServiceError `ENTITY_NOT_FOUND` when no such adjustment exists.
 */
export async function reverseExpenseAdjustment(
  db: Database,
  input: ReverseExpenseAdjustmentInput,
): Promise<ReverseExpenseAdjustmentResult> {
  if (input.reason.trim().length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'Reversing an adjustment records why it was wrong. Without a reason, a net amount ' +
        'changes and the ledger cannot say what changed it.',
      { field: 'reason' },
    );
  }

  const adjustment = await getExpenseAdjustmentById(db, input.adjustmentId);
  if (adjustment === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No adjustment with id ${input.adjustmentId}.`, {
      adjustmentId: input.adjustmentId,
    });
  }
  if (adjustment.reversedAt !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Adjustment ${adjustment.id} was already reversed on ` +
        `${adjustment.reversedAt.toISOString()}. It already counts for nothing; reversing it ` +
        'again would be a second account of one correction.',
      { adjustmentId: adjustment.id },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const reversedAt = new Date();
    await markExpenseAdjustmentReversed(exec, adjustment.id, {
      reason: input.reason,
      actor: input.audit.actor,
      reversedAt,
    });

    await record({
      entityType: 'expense_adjustment',
      entityId: adjustment.id,
      action: 'supersede',
      oldValue: {
        amount: adjustment.amount.toString(),
        kind: adjustment.kind,
        occurredAt: adjustment.occurredAt.toISOString(),
        reversedAt: null,
      },
      newValue: {
        // The record itself is unchanged, and shown unchanged deliberately: what moved is
        // whether it counts, not what it says.
        amount: adjustment.amount.toString(),
        kind: adjustment.kind,
        occurredAt: adjustment.occurredAt.toISOString(),
        reversedAt: reversedAt.toISOString(),
        reversedBy: input.audit.actor,
      },
      reason: input.reason,
    });

    // Read *after* the stamp, inside the same transaction, so these figures are the ones the
    // reversal actually produces rather than the ones it was about to.
    const expense = await requireExpenseSnapshot(exec, adjustment.originalExpenseId);
    const allocation = await loadCurrentAllocation(exec, adjustment.originalExpenseId);
    const allocatedTotal =
      allocation === null
        ? null
        : allocation.lines.reduce<bigint>((sum, line) => sum + line.amount, 0n);

    return {
      adjustmentId: adjustment.id,
      expenseId: adjustment.originalExpenseId,
      reversedAmount: adjustment.amount,
      netAmountAfter: expense.netAmount,
      pendingRedistribution: allocatedTotal !== null && allocatedTotal !== expense.netAmount,
    };
  });
}

export interface DistributeAdjustmentInput {
  readonly expenseId: ExpenseId;
  /**
   * An explicit, non-proportional distribution of the **unattributed** reduction,
   * positionally aligned with the current allocation's lines. Omit for the
   * proportional-to-existing-share default.
   *
   * It never redirects an item-attributed refund: which beneficiary a returned item's money
   * comes off is decided by the attribution and the approved item ownership, not by a weight
   * set, so supplying weights for an expense whose whole reduction is item-attributed is
   * refused rather than ignored (ADR-0018 (item refunds)).
   */
  readonly customWeights?: readonly bigint[];
  readonly audit: AuditMeta;
  readonly decidedBy?: string;
  readonly decidedAt?: Date;
}

/** How the reduction reaching a superseding allocation was worked out. */
export type RefundDistributionBasis = 'whole_expense' | 'item_attributed';

export interface DistributeAdjustmentResult {
  readonly allocationId: string;
  readonly supersededAllocationId: string;
  readonly distributedAmount: Paise;
  readonly netAmount: Paise;
  readonly lines: readonly DraftAllocationLine[];
  /** Splitwise rows moved to `stale` because our side changed (ADR-0008). */
  readonly staleSplitwiseExpenseIds: readonly string[];
  /** Which arithmetic produced the lines above (ADR-0008 legacy, or ADR-0018 item-first). */
  readonly basis: RefundDistributionBasis;
  /** Every item's gross cost, cumulative refunds and derived net cost. */
  readonly itemNetCosts: readonly ItemRefundBasis[];
  /** The part of the reduction no item accounts for, kept explicitly separate (ADR-0018). */
  readonly unattributedReduction: Paise;
  /** The part of the reduction item attribution accounts for. */
  readonly attributedReduction: Paise;
}

/**
 * Creates the superseding allocation that reflects every recorded-but-undistributed
 * adjustment.
 *
 * The amount to distribute is derived — the current lines' total minus the expense's
 * current net amount — rather than tracked per adjustment, so recording two refunds and
 * distributing once produces exactly the same result as distributing after each.
 *
 * On the item-attributed path the lines are rebuilt from the ledger's own recorded facts
 * (immutable gross item costs, every attribution, the unattributed remainder) rather than
 * decremented from where they happen to stand. That is what makes the outcome independent of
 * the order refunds arrived in and of how many times distribution was invoked along the way —
 * and it is why a second call with nothing new recorded is refused outright below rather than
 * quietly rewriting the same numbers.
 */
export async function distributeAdjustment(
  db: Database,
  input: DistributeAdjustmentInput,
): Promise<DistributeAdjustmentResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    // The same lock `recordExpenseAdjustment` takes. Without it a refund recorded between
    // reading the attributions and writing the allocation would leave a superseding version
    // that already fails invariant #11 the moment it is committed.
    await lockExpenseForAdjustment(exec, input.expenseId);

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

    const basis = await loadRefundBasis(exec, expense.id);
    const distributionBasis: RefundDistributionBasis =
      basis.attributedReduction === 0n ? 'whole_expense' : 'item_attributed';

    // `pending < 0` means the net amount *rose* — an adjustment was reversed as erroneous
    // (ADR-0052) — so there is no reduction to apportion and the lines are re-split to the
    // new, higher target instead. The item-aware engine already rebuilds from recorded facts
    // rather than decrementing (ADR-0045), so it needs no special case; only ADR-0008's
    // subtract-a-reduction path does.
    const newLines =
      distributionBasis === 'item_attributed'
        ? buildItemAwareAllocationLines({
            lines: current.lines,
            itemBases: basis.itemBases,
            legacyReduction: basis.unattributedReduction,
            ...(input.customWeights === undefined ? {} : { legacyWeights: input.customWeights }),
          })
        : pending > 0n
          ? // ADR-0008's whole-expense path, untouched: no item ever came back, so there is
            // no item cost to reduce and the reduction is the current lines' to share.
            distributeAcrossLines({
              lines: current.lines,
              adjustmentAmount: pending,
              ...(input.customWeights === undefined ? {} : { customWeights: input.customWeights }),
            })
          : restoreAllocationToNetAmount({
              lines: current.lines,
              netAmount: expense.netAmount,
              ...(input.customWeights === undefined ? {} : { customWeights: input.customWeights }),
            });

    validateAllocationLineAmounts(newLines);
    // Invariant #14's tightened form, checkable only while no unattributed reduction is also
    // in play: with one, a line's share is its item's net cost *less* that item's part of the
    // whole-expense refund, and the two reductions stay deliberately distinguishable.
    if (distributionBasis === 'item_attributed' && basis.unattributedReduction === 0n) {
      validateItemNetLineSums(newLines, basis.itemBases);
    }
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
        // The whole pipeline, in one event: what came back per item, what no item accounts
        // for, and the lines that follow from both (ADR-0018 (item refunds), 19.6).
        basis: distributionBasis,
        attributedReduction: basis.attributedReduction.toString(),
        unattributedReduction: basis.unattributedReduction.toString(),
        itemNetCosts: basis.itemBases.map((item) => ({
          expenseItemId: item.expenseItemId,
          grossAmount: item.grossAmount.toString(),
          refundedAmount: item.refundedAmount.toString(),
          netAmount: item.netAmount.toString(),
        })),
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
      basis: distributionBasis,
      itemNetCosts: basis.itemBases,
      unattributedReduction: basis.unattributedReduction,
      attributedReduction: basis.attributedReduction,
    };
  });
}

/* ------------------------------------------- the refund allocation state, as a read */

/** One purchased item, its immutable gross cost, and what it now costs after refunds. */
export interface RefundAllocationItemState extends ItemRefundBasis {
  readonly description: string;
  readonly quantity: string;
}

/** One line of an allocation, as this read renders it. */
export interface RefundAllocationLineState {
  readonly beneficiaryType: 'person' | 'group';
  readonly beneficiaryId: string;
  readonly expenseItemId: string | null;
  readonly amount: Paise;
}

export interface RefundAllocationState {
  readonly expenseId: ExpenseId;
  /** Immutable, gross, historical — shown beside the net figure, never replaced by it. */
  readonly grossAmount: Paise;
  readonly netAmount: Paise;
  /** `none` until an adjustment exists; `mixed` when both kinds have been recorded. */
  readonly basis: 'none' | 'whole_expense' | 'item_attributed' | 'mixed';
  readonly attributedReduction: Paise;
  readonly unattributedReduction: Paise;
  /** What a distribution would still have to absorb: current lines' total minus net amount. */
  readonly pendingReduction: Paise;
  readonly pendingDistribution: boolean;
  /**
   * False while a recorded adjustment has not reached the current allocation.
   *
   * The flag ADR-0018 asks for in as many words: *"a pending adjustment is visible, but stale
   * allocation-based obligations are not represented as current/verified"*.
   */
  readonly obligationsReflectAdjustments: boolean;
  readonly items: readonly RefundAllocationItemState[];
  readonly currentAllocation: {
    readonly id: string;
    readonly method: string;
    readonly total: Paise;
    readonly lines: readonly RefundAllocationLineState[];
  } | null;
  /** The lines a distribution would write right now, or `null` when it cannot be computed. */
  readonly projectedLines: readonly RefundAllocationLineState[] | null;
  /** Why distribution would be refused — a decision waiting on a human, never a guess. */
  readonly reviewRequired: { readonly code: string; readonly message: string } | null;
}

/**
 * Reads the whole item-refund picture for one expense without changing anything.
 *
 * Deliberately a pure read that runs the *same* engine a distribution would: the projected
 * lines below are not an approximation of what approval will do, they are what it will do.
 * When the engine refuses — an item nobody is recorded as having benefited from, an
 * allocation whose method cannot express item ownership — the refusal is reported here as a
 * pending review decision rather than thrown, because "this cannot be distributed yet" is
 * exactly the state this read exists to make visible.
 */
export async function getRefundAllocationState(
  db: Database,
  expenseId: ExpenseId,
): Promise<RefundAllocationState> {
  const expense = await requireExpenseSnapshot(db, expenseId);
  const basis = await loadRefundBasis(db, expense.id);
  const itemRows = await listExpenseItemsByExpense(db, expense.id);
  const describedById = new Map(itemRows.map((row) => [row.id, row]));

  const current = await loadCurrentAllocation(db, expense.id);
  const currentTotal =
    current === null ? (0n as Paise) : sumPaise(current.lines.map((line) => line.amount));
  const pendingReduction =
    current === null ? (0n as Paise) : undistributedAmount(currentTotal, expense.netAmount);

  let projectedLines: readonly RefundAllocationLineState[] | null = null;
  let reviewRequired: RefundAllocationState['reviewRequired'] = null;
  if (current !== null && basis.attributedReduction > 0n) {
    try {
      projectedLines = renderLines(
        buildItemAwareAllocationLines({
          lines: current.lines,
          itemBases: basis.itemBases,
          legacyReduction: basis.unattributedReduction,
        }),
      );
    } catch (error) {
      if (!isDomainError(error)) throw error;
      reviewRequired = { code: error.code, message: error.message };
    }
  }

  // A last cross-check, reported rather than thrown: the items are supposed to account for
  // the expense's gross amount, so an item-first rebuild should land exactly on the net
  // amount. If it would not, the purchase composition and the adjustments disagree about
  // what was bought, and that is a human's question to answer.
  if (projectedLines !== null) {
    const projectedTotal = itemAwareAllocationTotal(basis.itemBases, basis.unattributedReduction);
    if (projectedTotal !== expense.netAmount) {
      projectedLines = null;
      reviewRequired = {
        code: 'ALLOCATION_SUM_MISMATCH',
        message:
          `Net item costs less the unattributed reduction come to ${projectedTotal} paise, but ` +
          `the expense's net amount is ${expense.netAmount} paise. The recorded items do not ` +
          'account for this purchase, so its refunds cannot be allocated item-first ' +
          '(invariants.md #11, #14).',
      };
    }
  }

  return {
    expenseId: expense.id,
    grossAmount: expense.grossAmount,
    netAmount: expense.netAmount,
    basis: describeBasis(basis),
    attributedReduction: basis.attributedReduction,
    unattributedReduction: basis.unattributedReduction,
    pendingReduction,
    // Signed since ADR-0052: an expense whose shares are short because a refund was
    // reversed is exactly as out of date as one ahead because a refund was recorded.
    pendingDistribution: pendingReduction !== 0n,
    obligationsReflectAdjustments: current !== null && pendingReduction === 0n,
    items: basis.itemBases.map((item) => ({
      ...item,
      description: describedById.get(item.expenseItemId)?.description ?? '',
      quantity: describedById.get(item.expenseItemId)?.quantity ?? '1',
    })),
    currentAllocation:
      current === null
        ? null
        : {
            id: current.allocation.id,
            method: current.allocation.method,
            total: currentTotal,
            lines: renderLines(current.lines),
          },
    projectedLines,
    reviewRequired,
  };
}

/* ------------------------------------------------------------------------- internals */

/** Everything the allocation engine needs to know about what came back, and against what. */
interface RefundBasis {
  /** Σ of adjustments that carry item attribution rows. */
  readonly attributedReduction: Paise;
  /** Σ of adjustments that carry none — ADR-0008's legacy whole-expense path (19.2). */
  readonly unattributedReduction: Paise;
  /** Every item of the expense, with gross cost, cumulative refunds and derived net cost. */
  readonly itemBases: readonly ItemRefundBasis[];
}

/**
 * Reads the two reductions apart, and every item's derived net cost.
 *
 * Splitting the adjustments by whether they name items is the whole point: an amount alone
 * cannot say whether it belongs to one returned item or to the basket, and answering that
 * wrongly is precisely how a refund ends up reducing a debt owed by someone whose item was
 * never refunded (ADR-0018 (item refunds), "Context").
 */
async function loadRefundBasis(exec: Executor, expenseId: ExpenseId): Promise<RefundBasis> {
  const summaries = await listExpenseAdjustmentSummaries(exec, expenseId);
  let attributedReduction = 0n as Paise;
  let unattributedReduction = 0n as Paise;
  for (const summary of summaries) {
    if (summary.attributionCount > 0) {
      attributedReduction = (attributedReduction + summary.amount) as Paise;
    } else {
      unattributedReduction = (unattributedReduction + summary.amount) as Paise;
    }
  }

  // Read in the same order `GET /api/expenses/:id/items` uses, so the refund view and the
  // purchase view list a basket's contents the same way round rather than each picking their
  // own; nothing in the arithmetic depends on it, but a human comparing the two does.
  const items = await listExpenseItemsByExpense(exec, expenseId);
  const refundedByItem = await listItemAttributionTotals(exec, expenseId);
  return {
    attributedReduction,
    unattributedReduction,
    itemBases: deriveItemRefundBases(
      items.map((item) => ({ expenseItemId: item.id, grossAmount: item.amount })),
      refundedByItem,
    ),
  };
}

function describeBasis(basis: RefundBasis): RefundAllocationState['basis'] {
  if (basis.attributedReduction > 0n && basis.unattributedReduction > 0n) return 'mixed';
  if (basis.attributedReduction > 0n) return 'item_attributed';
  if (basis.unattributedReduction > 0n) return 'whole_expense';
  return 'none';
}

function renderLines(lines: readonly DraftAllocationLine[]): readonly RefundAllocationLineState[] {
  return lines.map((line) => ({
    beneficiaryType: line.beneficiary.type,
    beneficiaryId: line.beneficiary.id,
    expenseItemId: line.expenseItemId,
    amount: line.amount,
  }));
}

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
