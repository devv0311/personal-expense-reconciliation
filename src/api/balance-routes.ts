/**
 * `GET /api/balances/:personAId/:personBId` — the pairwise `Balance` between any two people, in
 * either direction (`docs/roadmap.md` phase 13, ADR-0006).
 *
 * Neither person needs to be the user; `userPersonId` itself is resolved via
 * `services.requireUserPersonId` rather than accepted from the caller — it names a fact this
 * ledger already knows (its single `User` row), not something a request should assert.
 */

import { asId } from '../domain/index.js';
import { getBalance, requireUserPersonId } from '../services/index.js';

import { jsonResponse, requireParam, requireUuid } from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

export async function getBalanceRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const personAId = asId<'person'>(requireUuid(requireParam(params, 'personAId'), 'personAId'));
  const personBId = asId<'person'>(requireUuid(requireParam(params, 'personBId'), 'personBId'));
  const userPersonId = await requireUserPersonId(deps.db);

  const result = await getBalance(deps.db, userPersonId, personAId, personBId);
  return jsonResponse(200, result);
}
