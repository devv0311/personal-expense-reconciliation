/**
 * Reconciliation surface (`docs/roadmap.md` phase 15, ADR-0041):
 *
 * ```
 * POST /api/reconciliation/runs        run one for a period
 * GET  /api/reconciliation/runs        history, newest first
 * GET  /api/reconciliation/runs/:id    one run in full
 * ```
 *
 * `services.runReconciliation`'s API exposure was deferred by ADR-0038/0039 to this phase, which
 * already owned it per `docs/roadmap.md`.
 */

import { asId } from '../domain/index.js';
import {
  getReconciliationRun,
  listReconciliationRunHistory,
  requireUserPersonId,
  runReconciliation,
} from '../services/index.js';
import { ServiceError } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalString,
  readJsonObject,
  requireParam,
  requireString,
  requireTimestamp,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/reconciliation/runs` — body: `{ periodStart, periodEnd, actor, reason? }`.
 *
 * `userPersonId` is resolved the same way every other route names the user — via
 * `services.requireUserPersonId` — never accepted from the caller.
 */
export async function postReconciliationRun(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const periodStart = requireTimestamp(body, 'periodStart');
  const periodEnd = requireTimestamp(body, 'periodEnd');
  if (periodEnd < periodStart) {
    throw new ApiRequestError('"periodEnd" must not be before "periodStart".', 'periodEnd');
  }
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const userPersonId = await requireUserPersonId(deps.db);

  const result = await runReconciliation(deps.db, {
    userPersonId,
    periodStart,
    periodEnd,
    splitwise: deps.splitwise,
    audit: {
      actor,
      source: 'api POST /api/reconciliation/runs',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(201, result);
}

/** `GET /api/reconciliation/runs` — query: `?limit=`. */
export async function getReconciliationRunsRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = optionalPositiveInteger(params, 'limit');

  const runs = await listReconciliationRunHistory(deps.db, {
    ...(limit === undefined ? {} : { limit }),
  });
  return jsonResponse(200, { runs });
}

/** `GET /api/reconciliation/runs/:id` — one run in full, including its Splitwise snapshot. */
export async function getReconciliationRunRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const reconciliationRunId = asId<'reconciliation_run'>(
    requireUuid(requireParam(params, 'id'), 'id'),
  );

  const run = await getReconciliationRun(deps.db, reconciliationRunId);
  if (run === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No reconciliation run with id ${reconciliationRunId}.`,
      { reconciliationRunId },
    );
  }
  return jsonResponse(200, run);
}

/* ------------------------------------------------------------------------- validation */

function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot run a reconciliation over HTTP. A request here is a person's act, so ` +
        'the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}
