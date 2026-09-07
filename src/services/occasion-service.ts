/**
 * Expense occasions — "the dinner, the dessert and the cab home are one evening"
 * (audit row 47).
 *
 * The schema has carried `expense_occasions` and `expenses.occasion_id` since the foundation
 * pass with nothing to write them. This is the manual flow; AI occasion-grouping remains
 * unbuilt and is a different thing entirely (a proposal a person confirms, not a fact).
 *
 * An occasion is a **label**, and the constraint that keeps it honest is that it carries no
 * money. Grouping three expenses changes no amount, no allocation and no balance — it makes
 * them findable together. Anything that would change a figure is an allocation decision, and
 * belongs to `services.approveAllocation` where a person makes it explicitly.
 */

import type { ExpenseId, ExpenseOccasionId, PersonId } from '../domain/index.js';
import {
  countExpensesPerOccasion,
  getExpenseById,
  getExpenseOccasionById,
  insertExpenseOccasion,
  listExpenseOccasions,
  setExpenseOccasion,
} from '../db/index.js';
import type { Database, Executor, ExpenseOccasionRow } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

export interface OccasionSummary extends ExpenseOccasionRow {
  /** How many expenses this occasion currently groups. A count, never a sum of money. */
  readonly expenseCount: number;
}

export async function listOccasions(db: Executor): Promise<readonly OccasionSummary[]> {
  const [rows, counts] = await Promise.all([
    listExpenseOccasions(db),
    countExpensesPerOccasion(db),
  ]);
  return rows.map((row) => ({ ...row, expenseCount: counts.get(row.id) ?? 0 }));
}

export interface CreateOccasionInput {
  readonly name: string;
  readonly occurredStart: Date;
  /** A range, because a trip spans days (`scenario-analysis.md` §10). */
  readonly occurredEnd?: Date | null;
  readonly defaultParticipants?: readonly PersonId[];
  readonly audit: AuditMeta;
}

export async function createOccasion(
  db: Database,
  input: CreateOccasionInput,
): Promise<{ readonly occasionId: ExpenseOccasionId }> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'An occasion needs a name.');
  }
  if (input.occurredEnd != null && input.occurredEnd < input.occurredStart) {
    throw new ServiceError('PRECONDITION_FAILED', 'An occasion cannot end before it starts.', {
      field: 'occurredEnd',
    });
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const occasionId = await insertExpenseOccasion(exec, {
      name,
      occurredStart: input.occurredStart,
      occurredEnd: input.occurredEnd ?? null,
      ...(input.defaultParticipants === undefined
        ? {}
        : { defaultParticipants: input.defaultParticipants }),
    });
    await record({
      entityType: 'expense_occasion',
      entityId: occasionId,
      action: 'create',
      newValue: {
        name,
        occurredStart: input.occurredStart.toISOString(),
        occurredEnd: input.occurredEnd?.toISOString() ?? null,
      },
    });
    return { occasionId };
  });
}

export interface AssignOccasionInput {
  readonly expenseId: ExpenseId;
  /** `null` detaches the expense from whatever occasion it was on. */
  readonly occasionId: ExpenseOccasionId | null;
  readonly audit: AuditMeta;
}

/**
 * Puts an expense on an occasion, or takes it off one.
 *
 * Audited like any other change to a financial record — not because it moves money (it does
 * not) but because it changes how a past expense reads, and "why is this dinner filed under
 * the Goa trip?" deserves an answer with a name and a time on it.
 */
export async function assignExpenseToOccasion(
  db: Database,
  input: AssignOccasionInput,
): Promise<void> {
  await runAudited(db, input.audit, async ({ exec, record }) => {
    const expense = await getExpenseById(exec, input.expenseId);
    if (expense === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such expense.', {
        expenseId: input.expenseId,
      });
    }
    if (input.occasionId !== null) {
      const occasion = await getExpenseOccasionById(exec, input.occasionId);
      if (occasion === null) {
        throw new ServiceError('ENTITY_NOT_FOUND', 'No such occasion.', {
          occasionId: input.occasionId,
        });
      }
    }

    await setExpenseOccasion(exec, input.expenseId, input.occasionId);
    await record({
      entityType: 'expense',
      entityId: input.expenseId,
      action: 'update',
      newValue: { occasionId: input.occasionId },
    });
  });
}
