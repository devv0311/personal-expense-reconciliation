/**
 * Sending a reviewed proof pack, and reading the record of what was sent (audit row 42).
 *
 * ```
 * GET  /api/messaging/status                              what this installation can send, if anything
 * POST /api/proof-packs/:recipientPersonId/deliveries      send one reviewed pack
 * GET  /api/proof-packs/:recipientPersonId/deliveries      this recipient's sharing history
 * GET  /api/deliveries                                     every delivery, newest first
 * POST /api/deliveries/:deliveryId/retry                   attempt a failed one again
 * POST /api/deliveries/status                              a provider's own delivery callback
 * ```
 *
 * The send route takes **no message body from the caller**. It takes a recipient, an address,
 * the three review confirmations and an optional list of evidence to attach; the text is
 * derived server-side from the ledger at the moment of sending. A route that accepted a body
 * would let a browser send any figure it liked over the user's own WhatsApp account, which is
 * ADR-0048's rule at the point where it matters most.
 *
 * `GET /api/messaging/status` exists so a screen can say "sending is not configured here"
 * before anybody types a phone number, rather than after a failed attempt.
 */

import { asId, MESSAGE_CHANNELS } from '../domain/index.js';
import type { EvidenceId } from '../domain/index.js';
import {
  applyProviderDeliveryStatus,
  getMessagingStatus,
  listProofPackDeliveryHistory,
  requireUserPersonId,
  retryProofPackDelivery,
  sendProofPack,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalString,
  readJsonObject,
  requireOneOf,
  requirePersonActor,
  requireParam,
  requireString,
  requireTimestamp,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/** `GET /api/messaging/status` — whether a pack can be sent from here, and by what. */
export function getMessagingStatusRoute(deps: ApiDependencies): Promise<Response> {
  return Promise.resolve(jsonResponse(200, getMessagingStatus(requireTransport(deps))));
}

/**
 * `POST /api/proof-packs/:recipientPersonId/deliveries` — send one.
 *
 * Body: `{ actor, reason?, channel, address, asOf, review: {recipient, content, evidence},
 * attachEvidenceIds?, contentDigestSeen? }`.
 *
 * Returns 201 with the delivery when a message was sent, and **200** when an identical one
 * had already been sent and nothing happened a second time — two different facts, given two
 * different statuses rather than one ambiguous success.
 */
export async function postProofPackDelivery(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const recipientPersonId = asId<'person'>(
    requireUuid(requireParam(params, 'recipientPersonId'), 'recipientPersonId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'send a proof pack');
  const reason = optionalString(body, 'reason');
  const channel = requireOneOf(body, 'channel', MESSAGE_CHANNELS);
  const address = requireString(body, 'address');
  const asOf = requireTimestamp(body, 'asOf');
  const review = readReview(body);
  const attachEvidenceIds = readEvidenceIds(body);
  const contentDigestSeen = optionalString(body, 'contentDigestSeen');

  const userPersonId = await requireUserPersonId(deps.db);
  const store = requireStore(deps);

  const result = await sendProofPack(deps.db, {
    userPersonId,
    recipientPersonId,
    channel,
    address,
    asOf,
    review,
    ...(attachEvidenceIds === undefined ? {} : { attachEvidenceIds }),
    ...(contentDigestSeen === undefined ? {} : { contentDigestSeen }),
    transport: requireTransport(deps),
    store,
    audit: {
      actor,
      source: 'api POST /api/proof-packs/:recipientPersonId/deliveries',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(result.sentNow ? 201 : 200, result);
}

/** `GET /api/proof-packs/:recipientPersonId/deliveries` — what this person has been sent. */
export async function getRecipientDeliveriesRoute(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const recipientPersonId = asId<'person'>(
    requireUuid(requireParam(params, 'recipientPersonId'), 'recipientPersonId'),
  );
  const limit = optionalPositiveInteger(new URL(request.url).searchParams, 'limit');
  const deliveries = await listProofPackDeliveryHistory(deps.db, {
    recipientPersonId,
    ...(limit === undefined ? {} : { limit }),
  });
  return jsonResponse(200, { deliveries });
}

/** `GET /api/deliveries` — the whole sharing record, newest first. */
export async function getDeliveriesRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const limit = optionalPositiveInteger(new URL(request.url).searchParams, 'limit');
  const deliveries = await listProofPackDeliveryHistory(
    deps.db,
    limit === undefined ? {} : { limit },
  );
  return jsonResponse(200, { deliveries });
}

/** `POST /api/deliveries/:deliveryId/retry` — attempt a failed delivery again. */
export async function postDeliveryRetry(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const deliveryId = asId<'proof_pack_delivery'>(
    requireUuid(requireParam(params, 'deliveryId'), 'deliveryId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'retry a proof-pack delivery');
  const reason = optionalString(body, 'reason');

  const result = await retryProofPackDelivery(deps.db, {
    deliveryId,
    transport: requireTransport(deps),
    store: requireStore(deps),
    audit: {
      actor,
      source: 'api POST /api/deliveries/:deliveryId/retry',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/**
 * `POST /api/deliveries/status` — a provider saying what became of a message it accepted.
 *
 * Body: `{ transportId, providerMessageId, status, detail? }`. Deliberately narrow: it can
 * only advance a delivery this ledger already handed over, and an unknown provider id is a
 * 404 rather than a new row. Authenticated like every other route — a provider's webhook
 * reaches it through whatever forwards to this API, not by standing open.
 */
export async function postDeliveryStatus(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const transportId = requireString(body, 'transportId');
  const providerMessageId = requireString(body, 'providerMessageId');
  const status = requireOneOf(body, 'status', ['delivered', 'failed'] as const);
  const detail = optionalString(body, 'detail');

  const delivery = await applyProviderDeliveryStatus(deps.db, {
    transportId,
    providerMessageId,
    status,
    ...(detail === undefined ? {} : { detail }),
    audit: { actor: 'system', source: 'api POST /api/deliveries/status' },
  });
  return jsonResponse(200, delivery);
}

/* ------------------------------------------------------------------------- validation */

function readReview(body: Record<string, unknown>): {
  readonly recipientConfirmed: boolean;
  readonly contentConfirmed: boolean;
  readonly evidenceConfirmed: boolean;
} {
  const raw = body['review'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiRequestError(
      '"review" is required: sending a pack confirms who it is for, what it says and which ' +
        'evidence it cites.',
      'review',
    );
  }
  const review = raw as Record<string, unknown>;
  return {
    recipientConfirmed: review['recipientConfirmed'] === true,
    contentConfirmed: review['contentConfirmed'] === true,
    evidenceConfirmed: review['evidenceConfirmed'] === true,
  };
}

function readEvidenceIds(body: Record<string, unknown>): readonly EvidenceId[] | undefined {
  if (!('attachEvidenceIds' in body) || body['attachEvidenceIds'] === null) return undefined;
  const raw = body['attachEvidenceIds'];
  if (!Array.isArray(raw)) {
    throw new ApiRequestError(
      '"attachEvidenceIds", when present, must be an array.',
      'attachEvidenceIds',
    );
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ApiRequestError(
        `"attachEvidenceIds[${index}]" must be a UUID.`,
        'attachEvidenceIds',
      );
    }
    return asId<'evidence'>(requireUuid(entry, `attachEvidenceIds[${index}]`));
  });
}

/**
 * The transport, or a 500-shaped refusal that names the missing wiring.
 *
 * `src/server.ts` always composes one — the unconfigured transport refuses by name rather
 * than being absent — so this only fires for a test that built an API without one, which is
 * a wiring mistake rather than a configuration state.
 */
function requireTransport(deps: ApiDependencies) {
  if (deps.messageTransport === undefined) {
    throw new ApiRequestError(
      'This API was composed without a message transport, so nothing can be sent. That is a ' +
        'wiring mistake rather than a configuration state: an installation with no ' +
        'credentials still gets a transport that refuses by name.',
    );
  }
  return deps.messageTransport;
}

function requireStore(deps: ApiDependencies) {
  return deps.evidenceStore;
}
