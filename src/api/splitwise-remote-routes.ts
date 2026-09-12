/**
 * Reading changes made in Splitwise, and deciding about them (audit row 40, ADR-0056):
 *
 * ```
 * POST /api/splitwise/remote-changes/discover      read their side and record what differs
 * GET  /api/splitwise/remote-changes               proposals, filtered
 * GET  /api/splitwise/remote-changes/:id           one, with both snapshots and its provenance
 * POST /api/splitwise/remote-changes/:id/decision  accept or reject one
 * GET  /api/splitwise/remote-reads                 discovery history, newest first
 * ```
 *
 * Discovery writes no financial state, and accepting writes only what the change declared — a
 * sync row's status, a link between two ids, a person's Splitwise mapping. Nothing on this
 * surface can change an amount, an allocation or a balance, and there is deliberately no route
 * that would: making a remote figure true here is a person recording an `ExpenseAdjustment`,
 * with evidence, through the adjustment surface.
 */

import { asId } from '../domain/index.js';
import type { SplitwiseRemoteChangeDecision, SplitwiseRemoteChangeKind } from '../domain/index.js';
import {
  SPLITWISE_REMOTE_CHANGE_DECISIONS,
  SPLITWISE_REMOTE_CHANGE_KINDS,
  SPLITWISE_REMOTE_CHANGE_STATUSES,
} from '../domain/index.js';
import type { SplitwiseRemoteChangeStatus } from '../domain/index.js';
import {
  decideSplitwiseRemoteChange,
  discoverSplitwiseRemoteChanges,
  getRemoteChange,
  listRemoteChanges,
  listSplitwiseRemoteReadHistory,
  requireUserPersonId,
  ServiceError,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalString,
  readJsonObject,
  requireOneOf,
  requireParam,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/splitwise/remote-changes/discover` — body: `{ actor, reason? }`.
 *
 * Safe to call repeatedly, and repeating it is the retry: an unchanged re-run re-observes the
 * changes already on record rather than duplicating them, and never reopens one somebody has
 * already decided about.
 */
export async function postDiscoverRemoteChanges(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const userPersonId = await requireUserPersonId(deps.db);

  const result = await discoverSplitwiseRemoteChanges(deps.db, {
    userPersonId,
    splitwise: deps.splitwise,
    audit: {
      actor,
      source: 'api POST /api/splitwise/remote-changes/discover',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(201, result);
}

/**
 * `GET /api/splitwise/remote-changes` — query:
 * `?status=&kind=&personId=&includeSuperseded=&limit=`.
 */
export async function getRemoteChangesRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const status = optionalEnumParam<SplitwiseRemoteChangeStatus>(
    params,
    'status',
    SPLITWISE_REMOTE_CHANGE_STATUSES,
  );
  const kind = optionalEnumParam<SplitwiseRemoteChangeKind>(
    params,
    'kind',
    SPLITWISE_REMOTE_CHANGE_KINDS,
  );
  const rawPersonId = params.get('personId');
  const personId =
    rawPersonId === null ? undefined : asId<'person'>(requireUuid(rawPersonId, 'personId'));
  const includeSuperseded = optionalBooleanParam(params, 'includeSuperseded');
  const limit = optionalPositiveInteger(params, 'limit');

  const changes = await listRemoteChanges(deps.db, {
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
    ...(personId === undefined ? {} : { personId }),
    ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    ...(limit === undefined ? {} : { limit }),
  });
  return jsonResponse(200, { changes });
}

/** `GET /api/splitwise/remote-changes/:id` — both snapshots, the consequence, the provenance. */
export async function getRemoteChangeRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const changeId = asId<'splitwise_remote_change'>(requireUuid(requireParam(params, 'id'), 'id'));

  const detail = await getRemoteChange(deps.db, changeId);
  if (detail === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No Splitwise remote change with id ${changeId}.`, {
      changeId,
    });
  }
  return jsonResponse(200, detail);
}

/**
 * `POST /api/splitwise/remote-changes/:id/decision` — body:
 * `{ decision, actor, reason, targetId? }`, where `decision` is `accept | reject`.
 *
 * `reason` is required for both: accepting applies a change to this ledger's record of
 * somebody else's edit, and rejecting closes it — neither is a decision worth having without
 * an account of why. `targetId` names the local record an adoption or a mapping joins to, and
 * is refused for every other kind.
 */
export async function postRemoteChangeDecision(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const changeId = asId<'splitwise_remote_change'>(requireUuid(requireParam(params, 'id'), 'id'));
  const body = await readJsonObject(request);
  const decision = requireOneOf<SplitwiseRemoteChangeDecision>(
    body,
    'decision',
    SPLITWISE_REMOTE_CHANGE_DECISIONS,
  );
  const actor = requirePersonActor(body);
  const reason = requireString(body, 'reason');
  const rawTarget = optionalString(body, 'targetId');
  const targetId = rawTarget === undefined ? undefined : requireUuid(rawTarget, 'targetId');

  const result = await decideSplitwiseRemoteChange(deps.db, {
    changeId,
    decision,
    reason,
    ...(targetId === undefined ? {} : { targetId }),
    audit: {
      actor,
      source: 'api POST /api/splitwise/remote-changes/:id/decision',
      reason,
    },
  });
  return jsonResponse(200, result);
}

/** `GET /api/splitwise/remote-reads` — query: `?limit=`. */
export async function getRemoteReadsRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = optionalPositiveInteger(params, 'limit');

  const reads = await listSplitwiseRemoteReadHistory(deps.db, {
    ...(limit === undefined ? {} : { limit }),
  });
  return jsonResponse(200, { reads });
}

/* ------------------------------------------------------------------------- validation */

function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot read or decide about somebody else's edits over HTTP. A request here ` +
        'is a person\'s act, so the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}

function optionalEnumParam<T extends string>(
  params: URLSearchParams,
  field: string,
  permitted: readonly T[],
): T | undefined {
  const raw = params.get(field);
  if (raw === null) return undefined;
  if (!(permitted as readonly string[]).includes(raw)) {
    throw new ApiRequestError(`"${field}" must be one of ${permitted.join(', ')}.`, field);
  }
  return raw as T;
}

function optionalBooleanParam(params: URLSearchParams, field: string): boolean | undefined {
  const raw = params.get(field);
  if (raw === null) return undefined;
  if (raw !== 'true' && raw !== 'false') {
    throw new ApiRequestError(`"${field}" must be "true" or "false".`, field);
  }
  return raw === 'true';
}
