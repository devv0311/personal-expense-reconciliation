/**
 * The Splitwise drift & ghost-debt auditing surface (`docs/roadmap.md` phase 19, ADR-0046):
 *
 * ```
 * POST /api/splitwise/audits                        run one audit
 * GET  /api/splitwise/audits                        audit history, newest first
 * GET  /api/splitwise/audits/:id                    one run and the findings it produced
 * GET  /api/splitwise/audit-findings                findings, filtered
 * GET  /api/splitwise/audit-findings/:id            one finding, with its review history
 * POST /api/splitwise/audit-findings/:id/review     record a person's decision about one
 * ```
 *
 * Every route here reads or reviews. **None of them writes to Splitwise**, and the review
 * route in particular does not: accepting a finding records what a person concluded, never an
 * instruction to correct either ledger. Re-syncing a `stale` row remains a separate, explicitly
 * approved operation (ADR-0040/0041), and is deliberately not reachable from this surface.
 */

import { asId } from '../domain/index.js';
import type {
  SplitwiseAuditFindingClass,
  SplitwiseAuditFindingKind,
  SplitwiseAuditReviewDecision,
  SplitwiseAuditReviewStatus,
} from '../domain/index.js';
import {
  SPLITWISE_AUDIT_FINDING_CLASSES,
  SPLITWISE_AUDIT_FINDING_KINDS,
  SPLITWISE_AUDIT_REVIEW_DECISIONS,
  SPLITWISE_AUDIT_REVIEW_STATUSES,
} from '../domain/index.js';
import {
  getAuditFinding,
  getSplitwiseAuditRun,
  listAuditFindings,
  listSplitwiseAuditRunHistory,
  requireUserPersonId,
  reviewSplitwiseAuditFinding,
  runSplitwiseAudit,
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
 * `POST /api/splitwise/audits` — body: `{ actor, reason? }`.
 *
 * Runs a fresh comparison. Deterministic and idempotent: an unchanged rerun re-observes the
 * findings already on record rather than duplicating them, so this is safe to call repeatedly.
 */
export async function postSplitwiseAudit(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const userPersonId = await requireUserPersonId(deps.db);

  const result = await runSplitwiseAudit(deps.db, {
    userPersonId,
    splitwise: deps.splitwise,
    audit: {
      actor,
      source: 'api POST /api/splitwise/audits',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(201, result);
}

/** `GET /api/splitwise/audits` — query: `?limit=`. */
export async function getSplitwiseAuditsRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = optionalPositiveInteger(params, 'limit');

  const runs = await listSplitwiseAuditRunHistory(deps.db, {
    ...(limit === undefined ? {} : { limit }),
  });
  return jsonResponse(200, { runs });
}

/** `GET /api/splitwise/audits/:id` — the run, plus every finding it first produced. */
export async function getSplitwiseAuditRunRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const auditRunId = asId<'splitwise_audit_run'>(requireUuid(requireParam(params, 'id'), 'id'));

  const detail = await getSplitwiseAuditRun(deps.db, auditRunId);
  if (detail === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No Splitwise audit run with id ${auditRunId}.`, {
      auditRunId,
    });
  }
  return jsonResponse(200, detail);
}

/**
 * `GET /api/splitwise/audit-findings` — query:
 * `?reviewStatus=&kind=&findingClass=&personId=&includeSuperseded=&limit=`.
 *
 * Superseded rows are history and stay out unless `includeSuperseded=true` asks for them —
 * they are preserved, not hidden, and reading them back is how the record of what an earlier
 * comparison said stays available after a later one replaced it.
 */
export async function getSplitwiseAuditFindingsRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const reviewStatus = optionalEnumParam<SplitwiseAuditReviewStatus>(
    params,
    'reviewStatus',
    SPLITWISE_AUDIT_REVIEW_STATUSES,
  );
  const kind = optionalEnumParam<SplitwiseAuditFindingKind>(
    params,
    'kind',
    SPLITWISE_AUDIT_FINDING_KINDS,
  );
  const findingClass = optionalEnumParam<SplitwiseAuditFindingClass>(
    params,
    'findingClass',
    SPLITWISE_AUDIT_FINDING_CLASSES,
  );
  const rawPersonId = params.get('personId');
  const personId =
    rawPersonId === null ? undefined : asId<'person'>(requireUuid(rawPersonId, 'personId'));
  const includeSuperseded = optionalBooleanParam(params, 'includeSuperseded');
  const limit = optionalPositiveInteger(params, 'limit');

  const findings = await listAuditFindings(deps.db, {
    ...(reviewStatus === undefined ? {} : { reviewStatus }),
    ...(kind === undefined ? {} : { kind }),
    ...(findingClass === undefined ? {} : { findingClass }),
    ...(personId === undefined ? {} : { personId }),
    ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    ...(limit === undefined ? {} : { limit }),
  });
  return jsonResponse(200, { findings });
}

/** `GET /api/splitwise/audit-findings/:id` — one finding and its append-only review history. */
export async function getSplitwiseAuditFindingRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const findingId = asId<'splitwise_audit_finding'>(requireUuid(requireParam(params, 'id'), 'id'));

  const detail = await getAuditFinding(deps.db, findingId);
  if (detail === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No Splitwise audit finding with id ${findingId}.`, {
      findingId,
    });
  }
  return jsonResponse(200, detail);
}

/**
 * `POST /api/splitwise/audit-findings/:id/review` — body:
 * `{ decision, actor, reason? }`, where `decision` is `acknowledged | resolved | dismissed`.
 *
 * `reason` is required for `resolved` and `dismissed`. Nothing about this call reaches
 * Splitwise.
 */
export async function postSplitwiseAuditFindingReview(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const findingId = asId<'splitwise_audit_finding'>(requireUuid(requireParam(params, 'id'), 'id'));
  const body = await readJsonObject(request);
  const decision = requireOneOf<SplitwiseAuditReviewDecision>(
    body,
    'decision',
    SPLITWISE_AUDIT_REVIEW_DECISIONS,
  );
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const result = await reviewSplitwiseAuditFinding(deps.db, {
    findingId,
    decision,
    ...(reason === undefined ? {} : { reason }),
    audit: {
      actor,
      source: 'api POST /api/splitwise/audit-findings/:id/review',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/* ------------------------------------------------------------------------- validation */

function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot audit or review over HTTP. A request here is a person's act, so the ` +
        'actor is "user" or "user:<id>".',
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
