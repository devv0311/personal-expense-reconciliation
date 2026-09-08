/**
 * The expense ledger, queryable, and one expense from it.
 *
 * ```
 * GET /api/expenses              the ledger (`docs/roadmap.md` phase 13)
 * GET /api/expenses/:expenseId   one row of it (phase 21)
 * ```
 *
 * Query parameters are all optional: `state` (one of `EXPENSE_STATES`), `paidBy`, `search`,
 * `category`, `from`/`to`, `beneficiary`, `withoutAllocation`, `limit`, `offset`. Omitting
 * `state` returns every state, not just `approved` — "querying/reporting over approved
 * expenses" describes the typical read, not a hidden filter a caller cannot override.
 *
 * The response carries `total`: how many expenses match across the whole ledger, not how many
 * were returned. Audit row 32 recorded what its absence cost — a page that loaded the 200
 * newest rows, searched only those in the browser, and showed a count that meant nothing.
 *
 * The single-expense read is the same query with an id filter, deliberately: a detail screen
 * and the ledger row that linked to it must never be able to quote two different `netAmount`s
 * for one expense.
 */

import { EXPENSE_STATES, asId } from '../domain/index.js';
import type { ExpenseState, PersonId } from '../domain/index.js';
import { getExpenseLedgerRow, listExpensePage, ServiceError } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalTimestampParam,
  optionalUuidParam,
  requireParam,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

export async function getExpensesRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = parseState(params.get('state'));
  const paidByPersonId = parsePaidBy(params.get('paidBy'));
  const beneficiary = optionalUuidParam(params, 'beneficiary');
  const search = params.get('search');
  const category = params.get('category');
  const occurredFrom = optionalTimestampParam(params, 'from');
  const occurredTo = optionalTimestampParam(params, 'to');
  const limit = optionalPositiveInteger(params, 'limit');
  const offset = optionalPositiveInteger(params, 'offset');

  const page = await listExpensePage(deps.db, {
    ...(state === undefined ? {} : { state }),
    ...(paidByPersonId === undefined ? {} : { paidByPersonId }),
    ...(beneficiary === undefined ? {} : { beneficiaryPersonId: asId<'person'>(beneficiary) }),
    ...(search === null || search.length === 0 ? {} : { search }),
    ...(category === null || category.length === 0 ? {} : { category }),
    ...(occurredFrom === undefined ? {} : { occurredFrom }),
    ...(occurredTo === undefined ? {} : { occurredTo }),
    ...(params.get('withoutAllocation') === 'true' ? { withoutAllocation: true } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });

  // `expenses` stays the top-level key it has always been, so every existing consumer keeps
  // working; `total`/`limit`/`offset` are additive.
  return jsonResponse(200, page);
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
