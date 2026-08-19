/**
 * The review surface: one read and three actions.
 *
 * ```
 * GET  /api/review                                     the queue
 * POST /api/review/inferences/:inferenceId/decision    accept | modify | reject
 * POST /api/review/payments/:paymentId/reclassify      ask the model again
 * POST /api/review/payments/:paymentId/duplicate       confirm | dismiss
 * ```
 *
 * Each handler is a Web `Request → Response` function — which is exactly what a Next.js App
 * Router route handler is, so mounting these under `app/api/<route>/route.ts` is a re-export rather
 * than a rewrite (ADR-0032). Nothing here decides anything: it validates, calls one service,
 * and serializes. The ordering, the reasons, the state transitions and the audit trail all
 * belong to layers underneath.
 *
 * **`actor` arrives in the request body** because this system has no session yet
 * (`system-architecture.md`: "minimal, single-user session auth (deferred implementation)").
 * It is not trusted: `domain.parseDecisionActor` rejects `ai` and `system` inside the service,
 * so the transport cannot manufacture an unattributable decision. When auth lands, the actor
 * comes from the session and this field goes away.
 */

import { asId } from '../domain/index.js';
import type { AiInferenceId, Paise, PaymentId, ReviewItemKind } from '../domain/index.js';
import { REVIEW_ITEM_KINDS } from '../domain/index.js';
import {
  confirmPossibleDuplicate,
  decideInference,
  dismissPossibleDuplicate,
  listReviewQueue,
  reclassifyPayment,
} from '../services/index.js';
import type { ReviewQueueOptions } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalMinorUnits,
  optionalPositiveInteger,
  optionalString,
  readJsonObject,
  requireOneOf,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/* --------------------------------------------------------------------------- the queue */

/**
 * `GET /api/review` — everything waiting for a human, in the order it should be looked at.
 *
 * Query parameters are all optional: `limit`, `kinds` (comma-separated),
 * `materialityThreshold` (minor units), `duplicateWindowSeconds`.
 */
export async function getReviewQueue(deps: ApiDependencies, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const options: ReviewQueueOptions = {
    ...withOptional('limit', optionalPositiveInteger(params, 'limit')),
    ...withOptional('kinds', parseKinds(params.get('kinds'))),
    ...withOptional(
      'materialityThreshold',
      asPaise(optionalMinorUnits(params, 'materialityThreshold')),
    ),
    ...withOptional(
      'duplicateWindowSeconds',
      optionalPositiveInteger(params, 'duplicateWindowSeconds'),
    ),
  };

  const queue = await listReviewQueue(deps.db, options);
  return jsonResponse(200, queue);
}

/* -------------------------------------------------------------------------- decisions */

const DECISIONS = ['accept', 'modify', 'reject'] as const;

/**
 * `POST /api/review/inferences/:inferenceId/decision` — the one authoritative decision path.
 *
 * Body: `{ actor, decision: "accept" | "modify" | "reject", modifiedOutput?, reason? }`.
 * The route does not interpret `modifiedOutput` at all; it is handed through untouched, and
 * `src/ai`'s validator is what decides whether it is a proposal (`ai-boundary.md`).
 */
export async function postInferenceDecision(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const inferenceId = asId<'ai_inference'>(
    requireUuid(requireParam(params, 'inferenceId'), 'inferenceId'),
  );
  const body = await readJsonObject(request);
  const decision = requireOneOf(body, 'decision', DECISIONS);
  const actor = requireString(body, 'actor');
  const reason = optionalString(body, 'reason');

  const result = await decideInference(deps.db, {
    inferenceId: inferenceId satisfies AiInferenceId,
    decision,
    ...(body['modifiedOutput'] === undefined ? {} : { modifiedOutput: body['modifiedOutput'] }),
    audit: {
      actor,
      source: 'api POST /api/review/inferences/:inferenceId/decision',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/**
 * `POST /api/review/payments/:paymentId/reclassify` — ask the model again (ADR-0030).
 *
 * Body: `{ actor, reason? }`.
 */
export async function postPaymentReclassification(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const body = await readJsonObject(request);
  const actor = requireString(body, 'actor');
  const reason = optionalString(body, 'reason');

  const result = await reclassifyPayment(deps.db, {
    paymentId: paymentId satisfies PaymentId,
    ai: deps.ai,
    audit: {
      actor,
      source: 'api POST /api/review/payments/:paymentId/reclassify',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

const DUPLICATE_DECISIONS = ['confirm', 'dismiss'] as const;

/**
 * `POST /api/review/payments/:paymentId/duplicate` — confirm or dismiss a resemblance.
 *
 * Body: `{ actor, decision: "confirm" | "dismiss", duplicateOfPaymentId, windowSeconds?, reason? }`.
 * Two services rather than one flag deep in a service: confirming discards a payment and
 * dismissing changes nothing, and collapsing them into one call would make the destructive
 * branch reachable by a typo.
 */
export async function postPaymentDuplicateDecision(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const body = await readJsonObject(request);
  const decision = requireOneOf(body, 'decision', DUPLICATE_DECISIONS);
  const actor = requireString(body, 'actor');
  const reason = optionalString(body, 'reason');
  const duplicateOfPaymentId = asId<'payment'>(
    requireUuid(requireString(body, 'duplicateOfPaymentId'), 'duplicateOfPaymentId'),
  );
  const windowSeconds = optionalWindowSeconds(body);

  const input = {
    paymentId: paymentId satisfies PaymentId,
    duplicateOfPaymentId,
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    audit: {
      actor,
      source: 'api POST /api/review/payments/:paymentId/duplicate',
      ...(reason === undefined ? {} : { reason }),
    },
  };

  const result =
    decision === 'confirm'
      ? await confirmPossibleDuplicate(deps.db, input)
      : await dismissPossibleDuplicate(deps.db, input);
  return jsonResponse(200, { decision, ...result });
}

/* ------------------------------------------------------------------------- internals */

/** `exactOptionalPropertyTypes` forbids assigning `undefined`; this omits the key instead. */
function withOptional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

function asPaise(value: bigint | undefined): Paise | undefined {
  return value === undefined ? undefined : (value as Paise);
}

function parseKinds(raw: string | null): readonly ReviewItemKind[] | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const kinds = raw.split(',').map((kind) => kind.trim());
  for (const kind of kinds) {
    if (!(REVIEW_ITEM_KINDS as readonly string[]).includes(kind)) {
      throw new ApiRequestError(
        `"kinds" must be a comma-separated list of ${REVIEW_ITEM_KINDS.join(', ')}.`,
        'kinds',
      );
    }
  }
  return kinds as readonly ReviewItemKind[];
}

function optionalWindowSeconds(body: Record<string, unknown>): number | undefined {
  const value = body['windowSeconds'];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiRequestError(
      '"windowSeconds", when present, must be a non-negative integer.',
      'windowSeconds',
    );
  }
  return value;
}

function requireParam(params: RouteParams, name: string): string {
  const value = params[name];
  if (value === undefined) {
    throw new ApiRequestError(`Missing path parameter "${name}".`, name);
  }
  return value;
}
