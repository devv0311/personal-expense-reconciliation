/**
 * `services.correctExpenseKind` — correcting an expense that was approved as `personal` into a
 * kind other people share, together with who shared it (ADR-0073).
 *
 * ```
 * api POST /api/expenses/:id/relationship
 *   └─ one transaction:
 *        lock the expense row
 *        domain.checkKindCorrection (against the kind the person saw)
 *        refuse: a Splitwise row exists · a funding payment was discarded as a duplicate
 *        relationship_type  personal → <kind>      (compare-and-set; AuditEvent old → new)
 *        approveAllocationWithin                    (supersedes any current split; never edits it)
 * ```
 *
 * What it never touches: `amount` (`invariants.md` #6 — there is no write path to it here), the
 * evidence, the funding links, the payment, the category, the payer, or any settlement already
 * recorded. What it changes is exactly what the person decided: the kind, and the split that kind
 * needs. Both commit together or not at all, so a correction can never leave an expense shared
 * with nobody named — the partial state the approve-then-split pair has to recover from.
 *
 * It is not a counting act (ADR-0071): the payment behind the expense already counts and goes on
 * counting exactly once; only who benefited from it changes. It therefore takes no payment-class
 * lock, and it refuses outright if a funding payment was discarded as a duplicate — that money did
 * not move twice, and no new debt may be built on it.
 */

import { checkKindCorrection, relationshipTypeWords } from '../domain/index.js';
import type {
  DebtCreatingRelationshipType,
  ExpenseId,
  ExpenseRelationshipType,
} from '../domain/index.js';
import {
  getExpenseById,
  getSplitwiseExpenseByExpenseId,
  listExpensePaymentIds,
  listPaymentsByIds,
  lockExpenseForAdjustment,
  updateExpenseRelationshipTypeIfCurrent,
} from '../db/index.js';
import type { Database } from '../db/index.js';

import {
  approveAllocationWithin,
  type AllocationDecision,
  type ApproveAllocationResult,
  type GroupShareOverride,
} from './allocation-service.js';
import { runAudited, type AuditMeta } from './audit.js';
import { DISCARDED_DUPLICATE_REASON } from './duplicate-guard.js';
import { ServiceError } from './errors.js';

export interface CorrectExpenseKindInput {
  readonly expenseId: ExpenseId;
  /** The kind the person saw when they chose to correct it — always `personal` today. */
  readonly expectedRelationshipType: ExpenseRelationshipType;
  readonly relationshipType: DebtCreatingRelationshipType;
  /** Who shared it. Required: a shared kind with nobody named is not a finished decision. */
  readonly decision: AllocationDecision;
  readonly groupShareOverrides?: readonly GroupShareOverride[];
  /** Why — required, and recorded on every audit event the correction writes. */
  readonly reason: string;
  readonly audit: Omit<AuditMeta, 'reason'>;
  /** Overridable for deterministic tests; defaults to now. */
  readonly decidedAt?: Date;
}

export interface CorrectExpenseKindResult {
  readonly expenseId: ExpenseId;
  readonly from: ExpenseRelationshipType;
  readonly to: DebtCreatingRelationshipType;
  readonly allocation: ApproveAllocationResult;
}

export async function correctExpenseKind(
  db: Database,
  input: CorrectExpenseKindInput,
): Promise<CorrectExpenseKindResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'Say why the kind is being corrected. An approved decision changes only by a new decision ' +
        'somebody can read later (invariants.md #6).',
      { expenseId: input.expenseId, reason: 'reason_required' },
    );
  }

  return runAudited(db, { ...input.audit, reason }, async (ctx) => {
    // The row lock serialises two corrections of one expense, and a correction against a refund
    // being recorded on it (which takes the same lock): the second waits, then reads what the
    // first committed and is told the kind is no longer the one it saw.
    await lockExpenseForAdjustment(ctx.exec, input.expenseId);
    const expense = await getExpenseById(ctx.exec, input.expenseId);
    if (expense === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', `No expense with id ${input.expenseId}.`, {
        expenseId: input.expenseId,
      });
    }

    const refusal = checkKindCorrection({
      currentRelationshipType: expense.relationshipType,
      expectedRelationshipType: input.expectedRelationshipType,
      targetRelationshipType: input.relationshipType,
      state: expense.state,
    });
    if (refusal !== null) {
      throw new ServiceError('PRECONDITION_FAILED', refusal.message, {
        expenseId: expense.id,
        reason: refusal.reason,
        relationshipType: expense.relationshipType,
      });
    }

    // A personal expense is never synced, so a sync row here means the ledger and Splitwise
    // disagree about it already; changing who owes what underneath that is a repair, not this.
    if ((await getSplitwiseExpenseByExpenseId(ctx.exec, expense.id)) !== null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'This expense already has an entry in Splitwise, so correcting it here would leave the two ' +
          'disagreeing. Nothing was changed.',
        { expenseId: expense.id, reason: 'splitwise_entry_exists' },
      );
    }

    const fundedBy = await listPaymentsByIds(
      ctx.exec,
      await listExpensePaymentIds(ctx.exec, expense.id),
    );
    const discarded = fundedBy.find((payment) => payment.state === 'ignored');
    if (discarded !== undefined) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'A payment behind this expense was set aside as a duplicate, so it does not count and no ' +
          'debt may be built on it (invariants.md #10). Nothing was changed.',
        { expenseId: expense.id, paymentId: discarded.id, reason: DISCARDED_DUPLICATE_REASON },
      );
    }

    const changed = await updateExpenseRelationshipTypeIfCurrent(
      ctx.exec,
      expense.id,
      input.expectedRelationshipType,
      input.relationshipType,
    );
    if (!changed) {
      // Unreachable under the lock above; kept so a future caller without it fails closed.
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'This expense changed while it was being corrected, so nothing was changed.',
        { expenseId: expense.id, reason: 'kind_changed_since_read' },
      );
    }
    await ctx.record({
      entityType: 'expense',
      entityId: expense.id,
      action: 'update',
      oldValue: { relationshipType: expense.relationshipType, state: expense.state },
      newValue: { relationshipType: input.relationshipType, correction: 'kind_after_approval' },
      reason:
        `Corrected from ${relationshipTypeWords(expense.relationshipType)} to ` +
        `${relationshipTypeWords(input.relationshipType)} after approval: ${reason}`,
    });

    const allocation = await approveAllocationWithin(ctx, {
      expenseId: expense.id,
      decision: input.decision,
      decidedBy: 'manual',
      ...(input.groupShareOverrides === undefined
        ? {}
        : { groupShareOverrides: input.groupShareOverrides }),
      ...(input.decidedAt === undefined ? {} : { decidedAt: input.decidedAt }),
    });

    // A kind other people share, with nobody but the payer holding a share, is the partial state
    // this transaction exists to prevent under another name: it would say "shared" and create
    // nothing. Refused, and the whole correction rolls back with it.
    const sharedWithSomeone = allocation.lines.some(
      (line) =>
        line.amount > 0n &&
        (line.beneficiary.type === 'group' || line.beneficiary.id !== expense.paidByPersonId),
    );
    if (!sharedWithSomeone) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'Name at least one other person with a share. With only the person who paid named, ' +
          'nobody owes anything, so it would not be shared at all. Nothing was changed.',
        { expenseId: expense.id, reason: 'nobody_else_named' },
      );
    }

    return {
      expenseId: expense.id,
      from: expense.relationshipType as ExpenseRelationshipType,
      to: input.relationshipType,
      allocation,
    };
  });
}
