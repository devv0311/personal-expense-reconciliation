/**
 * The context re-attachment surface (phase 17, ADR-0044).
 *
 * ```
 * POST /api/evidence/notifications                  record a bank SMS / UPI push notification
 * POST /api/evidence/:evidenceId/observation        record or correct its structured reading
 * GET  /api/evidence/:evidenceId/observation        the recorded reading, or null
 * POST /api/evidence/:evidenceId/enrich             find the payments it could be about
 * GET  /api/evidence/:evidenceId/matches            the recorded candidates
 * POST /api/evidence/matches/:candidateId/decision  accept | dismiss  (the only way to link)
 * GET  /api/payments/:paymentId/context             what the attached evidence says about it
 * ```
 *
 * Plain `Request → Response` handlers, like every other route in `src/api` (ADR-0032/0042).
 * Nothing here decides anything: it validates a request, calls one service, and serializes the
 * answer. In particular, `POST .../enrich` **never** produces a link — the strongest candidate
 * it can return is still a proposal, and `POST .../decision` with `accept` is the only path to
 * `evidence.linked_payment_id`, which is write-once (ADR-0034).
 *
 * `actor` arrives in the body for the same reason it does on the review routes: there is no
 * session yet (`system-architecture.md`). It is not trusted — `domain.parseDecisionActor`
 * refuses `ai` and `system` inside the service, so a transport cannot manufacture an
 * unattributable decision, and a match decision is exactly that kind of decision because
 * everything extracted from the document inherits the link.
 */

import { asId, PAYMENT_DIRECTIONS, PAYMENT_REFERENCE_TYPES } from '../domain/index.js';
import type {
  EvidenceMatchCandidateId,
  EvidenceId,
  ExpenseId,
  Paise,
  PaymentDirection,
  PaymentId,
  PaymentReferenceType,
} from '../domain/index.js';
import {
  decideEvidenceMatch,
  getEvidenceObservation,
  getPaymentContext,
  listEvidenceMatches,
  matchEvidenceContext,
  recordEvidenceNotification,
  recordEvidenceObservation,
  NOTIFICATION_EVIDENCE_TYPES,
} from '../services/index.js';
import type { ObservedMovementInput } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalMinorUnitsField,
  optionalPositiveInteger,
  optionalString,
  optionalTimestamp,
  readJsonObject,
  requireOneOf,
  requireParam,
  requireString,
  requireTimestamp,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

const MATCH_DECISIONS = ['accept', 'dismiss'] as const;

/* ----------------------------------------------------------------------- ingestion */

/**
 * `POST /api/evidence/notifications` — record a bank SMS or UPI push notification.
 *
 * Body: `{ actor, type, text, capturedAt, observed*?, linkedPaymentId?, linkedExpenseId?,
 * reason? }`. The text is stored verbatim; the structured reading is parsed from it unless the
 * caller supplies fields of its own.
 *
 * 200 rather than 201 when this exact movement was already observed — nothing was created, and
 * saying so is how a client learns its retry was not a second notification.
 */
export async function postEvidenceNotification(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const type = requireOneOf(body, 'type', NOTIFICATION_EVIDENCE_TYPES);
  const text = requireString(body, 'text');
  const capturedAt = requireTimestamp(body, 'capturedAt');
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const result = await recordEvidenceNotification(deps.db, {
    type,
    text,
    capturedAt,
    ...observedFields(body),
    ...links(body),
    audit: {
      actor,
      source: 'api POST /api/evidence/notifications',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(result.outcome === 'recorded' ? 201 : 200, result);
}

/**
 * `POST /api/evidence/:evidenceId/observation` — record or correct the structured reading.
 *
 * Body: `{ actor, observed*?, reason? }`. This is how a person fixes a parse the grammar got
 * wrong. It replaces the reading; it never touches the `Evidence` row, which is SOURCE.
 */
export async function postEvidenceObservation(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  ) satisfies EvidenceId;
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const result = await recordEvidenceObservation(deps.db, {
    evidenceId,
    ...observedFields(body),
    audit: {
      actor,
      source: 'api POST /api/evidence/:evidenceId/observation',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(result.outcome === 'recorded' ? 201 : 200, result);
}

/* ------------------------------------------------------------------------ matching */

/**
 * `POST /api/evidence/:evidenceId/enrich` — find the payments this evidence could be about.
 *
 * Body: `{ actor, reason?, captureWindowDays?, instantSkewHours? }`. Idempotent: a second call
 * over an unchanged ledger returns `outcome: "unchanged"` having written nothing at all, which
 * is why it is safe to call on a schedule.
 */
export async function postEvidenceEnrichment(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  ) satisfies EvidenceId;
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const search = new URL(request.url).searchParams;
  const captureWindowDays = optionalPositiveInteger(search, 'captureWindowDays');
  const instantSkewHours = optionalPositiveInteger(search, 'instantSkewHours');

  const result = await matchEvidenceContext(deps.db, {
    evidenceId,
    ...(captureWindowDays === undefined ? {} : { captureWindowDays }),
    ...(instantSkewHours === undefined ? {} : { instantSkewHours }),
    audit: {
      actor,
      source: 'api POST /api/evidence/:evidenceId/enrich',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/**
 * `GET /api/evidence/:evidenceId/observation` — the recorded structured reading, or `null`.
 *
 * A read, so an inspector can show what was read off a document without re-running the matcher
 * (`docs/roadmap.md` phase 21). `null` is a real answer: a stored photograph nobody has read
 * has no observation, and that is not an error.
 */
export async function getEvidenceObservationRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  ) satisfies EvidenceId;
  const observation = await getEvidenceObservation(deps.db, evidenceId);
  return jsonResponse(200, { evidenceId, observation });
}

/** `GET /api/evidence/:evidenceId/matches` — the recorded candidates, strongest first. */
export async function getEvidenceMatchesRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  ) satisfies EvidenceId;
  const candidates = await listEvidenceMatches(deps.db, evidenceId);
  return jsonResponse(200, { evidenceId, candidates });
}

/**
 * `POST /api/evidence/matches/:candidateId/decision` — accept or dismiss one candidate.
 *
 * Body: `{ actor, decision: "accept" | "dismiss", reason? }`.
 *
 * `accept` is the only route in this system that turns a match into a link, and it goes
 * through the same write-once rule as `POST /api/evidence/:evidenceId/link`: attaching evidence
 * that is already attached elsewhere is refused with `EVIDENCE_LINK_IMMUTABLE` (422), not
 * silently re-pointed.
 */
export async function postEvidenceMatchDecision(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const candidateId = asId<'evidence_match_candidate'>(
    requireUuid(requireParam(params, 'candidateId'), 'candidateId'),
  ) satisfies EvidenceMatchCandidateId;
  const body = await readJsonObject(request);
  const decision = requireOneOf(body, 'decision', MATCH_DECISIONS);
  const actor = requireString(body, 'actor');
  const reason = optionalString(body, 'reason');

  const result = await decideEvidenceMatch(deps.db, {
    candidateId,
    decision,
    audit: {
      actor,
      source: 'api POST /api/evidence/matches/:candidateId/decision',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/* ------------------------------------------------------------------------- context */

/**
 * `GET /api/payments/:paymentId/context` — the re-attached context of one payment.
 *
 * A read. The payment's own narration comes back verbatim in `narration`, and everything the
 * attached evidence adds sits in its own fields beside it — including disagreements, which are
 * reported rather than resolved.
 */
export async function getPaymentContextRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(
    requireUuid(requireParam(params, 'paymentId'), 'paymentId'),
  ) satisfies PaymentId;
  const result = await getPaymentContext(deps.db, paymentId);
  return jsonResponse(200, result);
}

/* ----------------------------------------------------------------------- internals */

/**
 * The observed-movement fields, present only when the caller sent them.
 *
 * "Absent" and "explicitly null" mean different things here: absent leaves the parse in place,
 * and `null` overrides it with "the text does not say this". `optionalMinorUnitsField` already
 * draws that distinction for money, and the rest follow it.
 */
function observedFields(body: Record<string, unknown>): ObservedMovementInput {
  const fields: {
    observedAmount?: Paise | null;
    observedDirection?: PaymentDirection | null;
    observedReference?: string | null;
    observedReferenceType?: PaymentReferenceType | null;
    observedAccountHint?: string | null;
    observedMerchantText?: string | null;
    observedOccurredAt?: Date | null;
  } = {};

  if ('observedAmount' in body) {
    const amount = optionalMinorUnitsField(body, 'observedAmount');
    fields.observedAmount = amount === undefined || amount === null ? null : (amount as Paise);
  }
  if ('observedDirection' in body) {
    fields.observedDirection =
      body['observedDirection'] === null
        ? null
        : requireOneOf(body, 'observedDirection', PAYMENT_DIRECTIONS);
  }
  if ('observedReference' in body) {
    fields.observedReference = optionalString(body, 'observedReference') ?? null;
  }
  if ('observedReferenceType' in body) {
    fields.observedReferenceType =
      body['observedReferenceType'] === null
        ? null
        : requireOneOf(body, 'observedReferenceType', PAYMENT_REFERENCE_TYPES);
  }
  if ('observedAccountHint' in body) {
    fields.observedAccountHint = optionalString(body, 'observedAccountHint') ?? null;
  }
  if ('observedMerchantText' in body) {
    fields.observedMerchantText = optionalString(body, 'observedMerchantText') ?? null;
  }
  if ('observedOccurredAt' in body) {
    fields.observedOccurredAt = optionalTimestamp(body, 'observedOccurredAt') ?? null;
  }
  return fields;
}

/** The two optional link fields, present only when the caller supplied them. */
function links(body: Record<string, unknown>): {
  linkedPaymentId?: PaymentId;
  linkedExpenseId?: ExpenseId;
} {
  const paymentId = optionalString(body, 'linkedPaymentId');
  const expenseId = optionalString(body, 'linkedExpenseId');
  return {
    ...(paymentId === undefined
      ? {}
      : { linkedPaymentId: asId<'payment'>(requireUuid(paymentId, 'linkedPaymentId')) }),
    ...(expenseId === undefined
      ? {}
      : { linkedExpenseId: asId<'expense'>(requireUuid(expenseId, 'linkedExpenseId')) }),
  };
}

/**
 * A request over HTTP is a person's act.
 *
 * The same rule the evidence upload routes apply, and for the same reason: an ingestion or an
 * enrichment run attributed to `system` is one the audit trail could never trace to anyone. A
 * background job calls the service directly and records itself honestly.
 */
function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot record or enrich evidence over HTTP. A request here is a person's ` +
        'act, so the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}
