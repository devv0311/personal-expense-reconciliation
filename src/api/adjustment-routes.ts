/**
 * The `ExpenseAdjustment` surface: money came back, recorded, then distributed.
 *
 * ```
 * POST /api/expenses/:expenseId/adjustments             record it
 * POST /api/expenses/:expenseId/adjustments/distribute  fold it into a new Allocation version
 * ```
 *
 * Deliberately two calls, not one — `services.recordExpenseAdjustment`/`distributeAdjustment`
 * are separate steps so a recorded-but-not-yet-distributed adjustment is a real, visible state
 * rather than something that happens invisibly inside one request (`lifecycle.md`,
 * `ExpenseAdjustment` lifecycle, ADR-0008).
 */

import { EXPENSE_ADJUSTMENT_KINDS, asId } from '../domain/index.js';
import type { Paise } from '../domain/index.js';
import { distributeAdjustment, recordExpenseAdjustment } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalString,
  optionalTimestamp,
  readJsonObject,
  requireMinorUnitsField,
  requireOneOf,
  requireParam,
  requireString,
  requireTimestamp,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/expenses/:expenseId/adjustments` — record money coming back.
 *
 * Body: `{ actor, reason?, kind, amount, occurredAt, adjustmentPaymentId? }`. Does not touch
 * the current allocation — see `POST .../adjustments/distribute`.
 */
export async function postExpenseAdjustment(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const kind = requireOneOf(body, 'kind', EXPENSE_ADJUSTMENT_KINDS);
  const amount = requireMinorUnitsField(body, 'amount') as Paise;
  const occurredAt = requireTimestamp(body, 'occurredAt');
  const adjustmentPaymentIdRaw = optionalString(body, 'adjustmentPaymentId');

  const result = await recordExpenseAdjustment(deps.db, {
    expenseId,
    kind,
    amount,
    occurredAt,
    ...(adjustmentPaymentIdRaw === undefined
      ? {}
      : {
          adjustmentPaymentId: asId<'payment'>(
            requireUuid(adjustmentPaymentIdRaw, 'adjustmentPaymentId'),
          ),
        }),
    audit: {
      actor,
      source: 'api POST /api/expenses/:expenseId/adjustments',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(201, result);
}

/**
 * `POST /api/expenses/:expenseId/adjustments/distribute` — fold every recorded-but-undistributed
 * adjustment into a new `Allocation` version.
 *
 * Body: `{ actor, reason?, decidedBy?, decidedAt?, customWeights? }`. `customWeights`, when
 * present, is a non-proportional distribution positionally aligned with the current
 * allocation's lines; omit it for the proportional-to-existing-share default.
 */
export async function postDistributeAdjustment(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const decidedBy = optionalString(body, 'decidedBy');
  const decidedAt = optionalTimestamp(body, 'decidedAt');
  const customWeights = parseCustomWeights(body);

  const result = await distributeAdjustment(deps.db, {
    expenseId,
    ...(customWeights === undefined ? {} : { customWeights }),
    ...(decidedBy === undefined ? {} : { decidedBy }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    audit: {
      actor,
      source: 'api POST /api/expenses/:expenseId/adjustments/distribute',
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
      `"${actor}" cannot record or distribute an adjustment over HTTP. A request here is a ` +
        'person\'s act, so the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}

const WEIGHT_PATTERN = /^\d+$/;

function parseCustomWeights(body: Record<string, unknown>): readonly bigint[] | undefined {
  const raw = body['customWeights'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiRequestError(
      '"customWeights", when present, must be a non-empty array.',
      'customWeights',
    );
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || !WEIGHT_PATTERN.test(entry)) {
      throw new ApiRequestError(
        `"customWeights[${index}]" must be a non-negative integer as a decimal string.`,
        `customWeights[${index}]`,
      );
    }
    return BigInt(entry);
  });
}
