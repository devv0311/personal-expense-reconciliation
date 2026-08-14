/**
 * Shared reads used by more than one service.
 *
 * These assemble the inputs the pure functions in `src/domain` expect. They compute
 * nothing financial themselves — `netAmount` below is `domain.netAmount` applied to rows
 * this module fetched, not a second implementation of the same subtraction.
 */

import {
  netAmount as computeNetAmount,
  type DraftAllocationLine,
  type ExpenseId,
  type ExpenseState,
  type Paise,
  type PersonId,
} from '../domain/index.js';
import type { AllocationLineRow, CurrentAllocationRow, Executor, PaymentRow } from '../db/index.js';
import {
  getCurrentAllocation,
  getExpenseById,
  getPaymentById,
  listAdjustmentAmounts,
  listAllocationLines,
  listGroupExpansions,
} from '../db/index.js';

import { ServiceError } from './errors.js';

export interface ExpenseSnapshot {
  readonly id: ExpenseId;
  readonly grossAmount: Paise;
  readonly netAmount: Paise;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly relationshipType: string;
  readonly paidByPersonId: PersonId;
  readonly state: ExpenseState;
  readonly adjustmentAmounts: readonly Paise[];
}

/** Loads an expense together with its derived net amount, or fails loudly. */
export async function requireExpenseSnapshot(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<ExpenseSnapshot> {
  const expense = await getExpenseById(exec, expenseId);
  if (expense === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No expense with id ${expenseId}.`, { expenseId });
  }
  const adjustmentAmounts = await listAdjustmentAmounts(exec, expenseId);
  return {
    id: expense.id,
    grossAmount: expense.amount,
    netAmount: computeNetAmount(expense.amount, adjustmentAmounts),
    currency: expense.currency,
    occurredAt: expense.occurredAt,
    relationshipType: expense.relationshipType,
    paidByPersonId: expense.paidByPersonId,
    state: expense.state,
    adjustmentAmounts,
  };
}

export async function requirePayment(exec: Executor, paymentId: string): Promise<PaymentRow> {
  const payment = await getPaymentById(exec, paymentId as PaymentRow['id']);
  if (payment === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No payment with id ${paymentId}.`, { paymentId });
  }
  return payment;
}

export interface CurrentAllocationSnapshot {
  readonly allocation: CurrentAllocationRow;
  readonly rows: readonly AllocationLineRow[];
  /** The same lines in the shape `src/domain` works with. */
  readonly lines: readonly DraftAllocationLine[];
  /** Expansion rows keyed by the group line they belong to. */
  readonly expansions: ReadonlyMap<string, ReadonlyArray<{ personId: PersonId; amount: Paise }>>;
}

/** Loads the one non-superseded allocation for an expense, if it has one. */
export async function loadCurrentAllocation(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<CurrentAllocationSnapshot | null> {
  const allocation = await getCurrentAllocation(exec, expenseId);
  if (allocation === null) return null;

  const rows = await listAllocationLines(exec, allocation.id);
  const groupLineIds = rows.filter((row) => row.beneficiaryType === 'group').map((row) => row.id);
  const expansionRows = await listGroupExpansions(exec, groupLineIds);

  const expansions = new Map<string, Array<{ personId: PersonId; amount: Paise }>>();
  for (const row of expansionRows) {
    const bucket = expansions.get(row.allocationLineId) ?? [];
    bucket.push({ personId: row.personId, amount: row.amount });
    expansions.set(row.allocationLineId, bucket);
  }

  return {
    allocation,
    rows,
    lines: rows.map((row) => ({
      beneficiary:
        row.beneficiaryType === 'person'
          ? ({ type: 'person', id: row.beneficiaryId } as DraftAllocationLine['beneficiary'])
          : ({ type: 'group', id: row.beneficiaryId } as DraftAllocationLine['beneficiary']),
      amount: row.amount,
      percentage: row.percentage,
      expenseItemId: row.expenseItemId as DraftAllocationLine['expenseItemId'],
    })),
    expansions,
  };
}

/** Loads the current allocation, failing when the expense has none. */
export async function requireCurrentAllocation(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<CurrentAllocationSnapshot> {
  const snapshot = await loadCurrentAllocation(exec, expenseId);
  if (snapshot === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Expense ${expenseId} has no current Allocation. Approve one before distributing an ` +
        'adjustment against it (lifecycle.md, ExpenseAdjustment lifecycle).',
      { expenseId },
    );
  }
  return snapshot;
}
