/**
 * The expense ledger — a read-only listing over `Expense` (`docs/roadmap.md` phase 13).
 *
 * Filtering and `netAmount` computation both happen in `db.listExpenses`, mirroring
 * `loadReconciliationInput`'s "gather gross amount + adjustments, let `domain.netAmount`
 * subtract" split for the identical figure. This module is a thin pass-through so `src/api`
 * depends on `src/services`, never `src/db`, directly (`system-architecture.md`, Layering).
 */

import {
  DEFAULT_EXPENSE_LEDGER_LIMIT,
  countExpenses,
  listExpenses as dbListExpenses,
} from '../db/index.js';
import type { Executor, ExpenseLedgerRow, ListExpensesFilter } from '../db/index.js';
import type { ExpenseId } from '../domain/index.js';

export type { ExpenseLedgerRow, ListExpensesFilter } from '../db/index.js';

export async function listExpenses(
  db: Executor,
  filter: ListExpensesFilter = {},
): Promise<readonly ExpenseLedgerRow[]> {
  return dbListExpenses(db, filter);
}

export interface ExpenseLedgerPage {
  readonly expenses: readonly ExpenseLedgerRow[];
  /**
   * How many expenses match the filter across the whole ledger.
   *
   * Audit row 32: *"The displayed count is the loaded subset, not a guaranteed full-ledger
   * count."* A surface that shows "12 of 480" is telling the truth; one that shows "12" over
   * a 200-row window is not.
   */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** One page of the ledger, with the full-ledger total beside it. */
export async function listExpensePage(
  db: Executor,
  filter: ListExpensesFilter = {},
): Promise<ExpenseLedgerPage> {
  // The same bound `db.listExpenses` has always applied when no caller states one, so adding
  // paging changes what a page *says* about itself, never how much it returns by default.
  const limit = filter.limit ?? DEFAULT_EXPENSE_LEDGER_LIMIT;
  const offset = filter.offset ?? 0;
  const [expenses, total] = await Promise.all([
    dbListExpenses(db, { ...filter, limit, offset }),
    countExpenses(db, filter),
  ]);
  return { expenses, total, limit, offset };
}

/**
 * One expense, in the same row shape the listing produces, or `null` (`docs/roadmap.md`
 * phase 21).
 *
 * The listing's own `expenseId` filter rather than a second query, so a detail screen and the
 * ledger row that linked to it can never quote two different `netAmount`s for one expense.
 */
export async function getExpenseLedgerRow(
  db: Executor,
  expenseId: ExpenseId,
): Promise<ExpenseLedgerRow | null> {
  const [row] = await dbListExpenses(db, { expenseId, limit: 1 });
  return row ?? null;
}
