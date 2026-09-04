/**
 * `GET /api/expenses` — the expense ledger, queryable (`docs/roadmap.md` phase 13).
 *
 * Query parameters are all optional: `state` (one of `EXPENSE_STATES`), `paidBy` (a `PersonId`),
 * `limit`. Omitting `state` returns every state, not just `approved` — "querying/reporting over
 * approved expenses" describes the typical read, not a hidden filter a caller cannot override.
 */

import { EXPENSE_STATES, asId } from '../domain/index.js';
import type { ExpenseState, PersonId } from '../domain/index.js';
import { listExpenses } from '../services/index.js';

import { ApiRequestError, jsonResponse, optionalPositiveInteger, requireUuid } from './http.js';
import type { ApiDependencies } from './router.js';

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
