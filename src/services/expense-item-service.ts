/**
 * `ExpenseItem` — the allocateable unit an item-based/quantity-based `AllocationLine` runs
 * against (`domain-model.md`, `ExpenseItem`).
 *
 * A `ReceiptItem` is what the evidence says was bought; an `ExpenseItem` is what allocation
 * actually runs against, and the two are not always 1:1 — a person may merge two receipt lines
 * into one item, split one line into two, or define an item with no receipt behind it at all
 * (`receiptItemId: null`). This module is the one write path for either shape: the caller
 * always supplies the final description/amount/quantity, whether or not it traces back to a
 * `ReceiptItem` — which is what closes out phase 11's deferred "manual (no-AI) item entry"
 * without needing a second code path for it.
 */

import { validateExpenseItemsSum } from '../domain/index.js';
import type { ExpenseId, Paise, ReceiptItemId } from '../domain/index.js';
import { getReceiptItemById, insertExpenseItems, listExpenseItemsByExpense } from '../db/index.js';
import type { Database, ExpenseItemRow } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { requireExpenseSnapshot } from './loaders.js';

export interface ExpenseItemDraft {
  readonly description: string;
  readonly amount: Paise;
  /** A count/measure, not money. Defaults to `'1'`. */
  readonly quantity?: string;
  /** Set when this item derives from a receipt line; `null`/omitted for a manually defined one. */
  readonly receiptItemId?: ReceiptItemId | null;
}

export interface RecordExpenseItemsInput {
  readonly expenseId: ExpenseId;
  readonly items: readonly ExpenseItemDraft[];
  readonly audit: AuditMeta;
}

export interface RecordExpenseItemsResult {
  readonly items: readonly ExpenseItemRow[];
}

/**
 * Records the complete item breakdown of an expense, once.
 *
 * The whole set is written together because the invariant it must satisfy — items sum to
 * exactly the expense's **gross** amount — is a fact about the complete set, never a partial
 * one (`domain.validateExpenseItemsSum`). There is no update or per-item path: an expense is
 * itemized once; a second call is refused, matching `services.extractReceipt`'s "already
 * exists, this is not a re-run" shape.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when the expense, or a referenced `ReceiptItem`,
 *   does not exist.
 * @throws ServiceError `PRECONDITION_FAILED` when the expense is `rejected`, or already has
 *   items.
 * @throws DomainError `EXPENSE_ITEMS_SUM_MISMATCH` when the items do not sum to the gross
 *   amount.
 */
export async function recordExpenseItems(
  db: Database,
  input: RecordExpenseItemsInput,
): Promise<RecordExpenseItemsResult> {
  return runAudited(db, input.audit, async (ctx) => {
    const expense = await requireExpenseSnapshot(ctx.exec, input.expenseId);
    if (expense.state === 'rejected') {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `Expense ${expense.id} is "rejected" and will never be approved; recording items ` +
          'against it describes a purchase this ledger has already decided did not happen.',
        { expenseId: expense.id, state: expense.state },
      );
    }

    const existing = await listExpenseItemsByExpense(ctx.exec, expense.id);
    if (existing.length > 0) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `Expense ${expense.id} already has ${existing.length} item(s). There is no correction ` +
          'path in this phase; an expense is itemized once.',
        { expenseId: expense.id },
      );
    }

    for (const [index, item] of input.items.entries()) {
      if (item.receiptItemId === null || item.receiptItemId === undefined) continue;
      const receiptItem = await getReceiptItemById(ctx.exec, item.receiptItemId);
      if (receiptItem === null) {
        throw new ServiceError(
          'ENTITY_NOT_FOUND',
          `Item ${index}: no ReceiptItem with id ${item.receiptItemId}.`,
          { index: String(index), receiptItemId: item.receiptItemId },
        );
      }
    }

    validateExpenseItemsSum(
      input.items.map((item) => item.amount),
      expense.grossAmount,
    );

    const ids = await insertExpenseItems(
      ctx.exec,
      input.items.map((item) => ({
        expenseId: expense.id,
        description: item.description,
        amount: item.amount,
        quantity: item.quantity ?? '1',
        receiptItemId: item.receiptItemId ?? null,
      })),
    );

    const items: ExpenseItemRow[] = ids.map((id, index) => ({
      id,
      expenseId: expense.id,
      description: input.items[index]!.description,
      amount: input.items[index]!.amount,
      quantity: input.items[index]!.quantity ?? '1',
      receiptItemId: input.items[index]!.receiptItemId ?? null,
    }));

    for (const item of items) {
      await ctx.record({
        entityType: 'expense_item',
        entityId: item.id,
        action: 'create',
        newValue: {
          expenseId: expense.id,
          description: item.description,
          amount: item.amount.toString(),
          quantity: item.quantity,
          receiptItemId: item.receiptItemId,
        },
      });
    }

    return { items };
  });
}

export async function getExpenseItems(
  db: Database,
  expenseId: ExpenseId,
): Promise<readonly ExpenseItemRow[]> {
  await requireExpenseSnapshot(db, expenseId);
  return listExpenseItemsByExpense(db, expenseId);
}
