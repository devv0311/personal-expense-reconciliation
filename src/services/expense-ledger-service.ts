/**
 * The expense ledger — a read-only listing over `Expense` (`docs/roadmap.md` phase 13).
 *
 * Filtering and `netAmount` computation both happen in `db.listExpenses`, mirroring
 * `loadReconciliationInput`'s "gather gross amount + adjustments, let `domain.netAmount`
 * subtract" split for the identical figure. This module is a thin pass-through so `src/api`
 * depends on `src/services`, never `src/db`, directly (`system-architecture.md`, Layering).
 */

import { listExpenses as dbListExpenses } from '../db/index.js';
import type { Executor, ExpenseLedgerRow, ListExpensesFilter } from '../db/index.js';
import type { ExpenseId } from '../domain/index.js';

export type { ExpenseLedgerRow, ListExpensesFilter } from '../db/index.js';

export async function listExpenses(
  db: Executor,
  filter: ListExpensesFilter = {},
): Promise<readonly ExpenseLedgerRow[]> {
  return dbListExpenses(db, filter);
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
