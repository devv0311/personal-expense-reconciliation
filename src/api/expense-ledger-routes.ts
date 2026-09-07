/**
 * The expense ledger, queryable, and one expense from it.
 *
 * ```
 * GET /api/expenses              the ledger (`docs/roadmap.md` phase 13)
 * GET /api/expenses/:expenseId   one row of it (phase 21)
 * ```
 *
 * Query parameters are all optional: `state` (one of `EXPENSE_STATES`), `paidBy` (a `PersonId`),
 * `limit`. Omitting `state` returns every state, not just `approved` — "querying/reporting over
 * approved expenses" describes the typical read, not a hidden filter a caller cannot override.
 *
 * The single-expense read is the same query with an id filter, deliberately: a detail screen
 * and the ledger row that linked to it must never be able to quote two different `netAmount`s
 * for one expense.
 */

import { EXPENSE_STATES, asId } from '../domain/index.js';
import type { ExpenseState, PersonId } from '../domain/index.js';
import { getExpenseLedgerRow, listExpenses, ServiceError } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  requireParam,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

export async function getExpensesRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = parseState(params.get('state'));
  const paidByPersonId = parsePaidBy(params.get('paidBy'));
  const limit = optionalPositiveInteger(params, 'limit');

  const expenses = await listExpenses(deps.db, {
    ...(state === undefined ? {} : { state }),
    ...(paidByPersonId === undefined ? {} : { paidByPersonId }),
    ...(limit === undefined ? {} : { limit }),
  });

  return jsonResponse(200, { expenses });
}

/** `GET /api/expenses/:expenseId` — one expense, or 404. */
export async function getExpenseRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));

  const expense = await getExpenseLedgerRow(deps.db, expenseId);
  if (expense === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No expense with id ${expenseId}.`, { expenseId });
  }
  return jsonResponse(200, expense);
}

/* ------------------------------------------------------------------------- validation */

function parseState(raw: string | null): ExpenseState | undefined {
  if (raw === null) return undefined;
  if (!(EXPENSE_STATES as readonly string[]).includes(raw)) {
    throw new ApiRequestError(`"state" must be one of ${EXPENSE_STATES.join(', ')}.`, 'state');
  }
  return raw as ExpenseState;
}

function parsePaidBy(raw: string | null): PersonId | undefined {
  if (raw === null) return undefined;
  return asId<'person'>(requireUuid(raw, 'paidBy'));
}
