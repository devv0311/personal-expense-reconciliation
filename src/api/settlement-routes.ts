/**
 * The manual `Settlement` surface: mark an already-imported payment as discharging an
 * obligation, independently of classification.
 *
 * ```
 * POST /api/payments/:paymentId/settlements
 * ```
 *
 * `services.recordSettlement` already has one caller — `decideInference`, for a payment the
 * model proposed as a settlement. This is a second, independent path: a human explicitly
 * settling a payment classification never flagged, or never ran on. Both write through the
 * same validation (`invariants.md` #9/#9a: a settlement never has an `Allocation`); this route
 * adds no new rule, only a new caller.
 */

import { asId } from '../domain/index.js';
import type { Paise } from '../domain/index.js';
import { listSettlementRegisterEntries, recordSettlement } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalString,
  optionalUuidParam,
  readJsonObject,
  requireMinorUnitsField,
  requireParam,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/payments/:paymentId/settlements` — record that this payment settles an obligation.
 *
 * Body: `{ actor, reason?, counterpartyPersonId, amount }`. `amount` is usually the whole
 * payment, but may be a portion of it for a partial settlement — this boundary requires it
 * explicitly rather than defaulting, since an HTTP request has no surrounding transaction
 * context to imply "the whole payment" from.
 */
export async function postSettlement(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const counterpartyPersonId = asId<'person'>(
    requireUuid(requireString(body, 'counterpartyPersonId'), 'counterpartyPersonId'),
  );
  const amount = requireMinorUnitsField(body, 'amount') as Paise;

  const result = await recordSettlement(deps.db, {
    paymentId,
    counterpartyPersonId,
    amount,
    audit: {
      actor,
      source: 'api POST /api/payments/:paymentId/settlements',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(201, result);
}

/* ------------------------------------------------------------------------- validation */

function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot record a settlement over HTTP. A request here is a person's act, so ` +
        'the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}

/**
 * `GET /api/settlements` — the settlement register (audit row 29).
 *
 * Every repayment on record, newest first, optionally narrowed to one counterparty. A read:
 * what a pair currently owes each other is `GET /api/balances/:a/:b`, which nets these
 * against the obligations they discharge. Two answers to that question would be one too many.
 */
export async function getSettlementsRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const counterpartyPersonId = optionalUuidParam(params, 'counterpartyPersonId');
  const limit = optionalPositiveInteger(params, 'limit');
  const offset = optionalPositiveInteger(params, 'offset');

  const result = await listSettlementRegisterEntries(deps.db, {
    ...(counterpartyPersonId === undefined
      ? {}
      : { counterpartyPersonId: asId<'person'>(counterpartyPersonId) }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
  return jsonResponse(200, result);
}
