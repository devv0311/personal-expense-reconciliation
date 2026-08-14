/**
 * Expense lifecycle transitions.
 *
 * Every state change goes through here, so an invalid transition is impossible rather than
 * merely discouraged, and every change is audited. `Expense.amount` has no write path in
 * this module at all — once approved it never changes, and the correction mechanism is an
 * `ExpenseAdjustment` (`invariants.md` #6, ADR-0008).
 */

import {
  assertExpenseTransition,
  assertExpenseAmountImmutable,
  canEnterReadyToSync,
} from '../domain/index.js';
import type {
  ExpenseId,
  ExpenseRelationshipType,
  ExpenseState,
  Paise,
  PersonId,
  ResolvedShare,
} from '../domain/index.js';
import { updateExpenseState } from '../db/index.js';
import type { Database, Executor } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { loadCurrentAllocation, requireExpenseSnapshot, type ExpenseSnapshot } from './loaders.js';

export interface TransitionExpenseInput {
  readonly expenseId: ExpenseId;
  readonly to: ExpenseState;
  readonly audit: AuditMeta;
}

/**
 * Moves an expense to a new lifecycle state, refusing any transition
 * `docs/domain/lifecycle.md` does not draw.
 */
export async function transitionExpense(
  db: Database,
  input: TransitionExpenseInput,
): Promise<{ readonly from: ExpenseState; readonly to: ExpenseState }> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const expense = await requireExpenseSnapshot(exec, input.expenseId);
    assertExpenseTransition(expense.state, input.to);
    if (input.to === 'ready_to_sync') {
      await assertReadyToSync(exec, expense);
    }

    await updateExpenseState(exec, expense.id, input.to);
    await record({
      entityType: 'expense',
      entityId: expense.id,
      action: 'update',
      oldValue: { state: expense.state },
      newValue: { state: input.to },
    });

    return { from: expense.state, to: input.to };
  });
}

/**
 * Approves an expense: `relationship_type`, `paid_by_person_id` and `amount` are confirmed,
 * and `amount` becomes permanently immutable from this point on (`lifecycle.md`, APPROVED).
 */
export async function approveExpense(
  db: Database,
  input: { readonly expenseId: ExpenseId; readonly audit: AuditMeta },
): Promise<{ readonly from: ExpenseState; readonly to: ExpenseState }> {
  return transitionExpense(db, { ...input, to: 'approved' });
}

/**
 * Guards a proposed change to an expense's amount.
 *
 * There is deliberately no "update the amount" service. This exists so a caller that tries
 * gets a precise, actionable failure naming `ExpenseAdjustment` as the correction path,
 * rather than a missing-function error that invites someone to add one.
 */
export async function assertAmountChangeAllowed(
  db: Database,
  expenseId: ExpenseId,
  proposedAmount: Paise,
): Promise<void> {
  const expense = await requireExpenseSnapshot(db, expenseId);
  assertExpenseAmountImmutable(expense.state, expense.grossAmount, proposedAmount);
}

/* ------------------------------------------------------------------------- internals */

/**
 * The corrected `READY_TO_SYNC` gate (`lifecycle.md` revision note, `scenario-analysis.md` §8).
 *
 * Both conditions must hold: a debt-creating `relationship_type`, **and** at least one
 * obligation-creating line in the current allocation. Checking only the second — the
 * original wording — would let a `gift` through, and syncing a gift tells the recipient
 * they owe the giver for their own present.
 *
 * Group lines are read through their expansion, never raw: Splitwise has no group debtor.
 */
async function assertReadyToSync(exec: Executor, expense: ExpenseSnapshot): Promise<void> {
  const current = await loadCurrentAllocation(exec, expense.id);
  if (current === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Expense ${expense.id} has no current Allocation, so it cannot be ready to sync ` +
        '(lifecycle.md, ALLOCATED precedes READY_TO_SYNC).',
      { expenseId: expense.id },
    );
  }

  const resolvedShares: ResolvedShare[] = current.rows.flatMap((row) =>
    row.beneficiaryType === 'group'
      ? (current.expansions.get(row.id) ?? []).map((expansion) => ({
          beneficiaryId: expansion.personId,
          amount: expansion.amount,
        }))
      : [{ beneficiaryId: row.beneficiaryId as PersonId, amount: row.amount }],
  );

  const eligible = canEnterReadyToSync({
    relationshipType: expense.relationshipType as ExpenseRelationshipType,
    paidByPersonId: expense.paidByPersonId,
    resolvedShares,
  });

  if (!eligible) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Expense ${expense.id} is "${expense.relationshipType}" and creates no obligation, so it ` +
        'never reaches READY_TO_SYNC. A gift routinely has a non-payer beneficiary but must ' +
        'never sync — that would tell the recipient they owe the giver for their own gift ' +
        '(lifecycle.md, scenario-analysis.md §8).',
      { expenseId: expense.id, relationshipType: expense.relationshipType },
    );
  }
}
