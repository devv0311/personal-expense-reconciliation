/**
 * The `ExpenseAdjustment` surface: money came back, recorded, then distributed.
 *
 * ```
 * POST /api/expenses/:expenseId/adjustments             record it
 * POST /api/expenses/:expenseId/adjustments/distribute  fold it into a new Allocation version
 * GET  /api/expenses/:expenseId/adjustments             every one ever recorded, reversed ones
 *                                                       included
 * POST /api/adjustments/:adjustmentId/reverse           say one was wrong; stop counting it
 * GET  /api/expenses/:expenseId/refund-allocation       what came back, per item, and what is
 *                                                       still pending
 * ```
 *
 * Deliberately two calls, not one — `services.recordExpenseAdjustment`/`distributeAdjustment`
 * are separate steps so a recorded-but-not-yet-distributed adjustment is a real, visible state
 * rather than something that happens invisibly inside one request (`lifecycle.md`,
 * `ExpenseAdjustment` lifecycle, ADR-0008). The `GET` is the third, and a read: it shows what a
 * distribution would write before anyone approves it, and why it could not when the ledger
 * cannot say who owned a refunded item (ADR-0018 (item refunds), ADR-0045).
 */

import { EXPENSE_ADJUSTMENT_KINDS, asId } from '../domain/index.js';
import type { Paise, RefundAttributionDraft } from '../domain/index.js';
import {
  distributeAdjustment,
  getRefundAllocationState,
  listExpenseAdjustments,
  recordExpenseAdjustment,
  reverseExpenseAdjustment,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalString,
  optionalTimestamp,
  readJsonObject,
  requirePersonActor,
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
 * Body: `{ actor, reason?, kind, amount, occurredAt, adjustmentPaymentId?, itemAttributions? }`.
 * Does not touch the current allocation — see `POST .../adjustments/distribute`.
 *
 * `itemAttributions` is the **complete** set of `{ expenseItemId, amount }` rows for a refund
 * whose items are known: it must sum exactly to `amount`, and a partial set is refused rather
 * than recorded as a pending remainder (ADR-0018 (item refunds), 19.2). Omitting it records
 * ADR-0008's legacy whole-expense refund — a different fact, not a shorter way of stating the
 * same one, which is why the caller says which it is instead of the server guessing.
 */
export async function postExpenseAdjustment(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'record an adjustment');
  const reason = optionalString(body, 'reason');
  const kind = requireOneOf(body, 'kind', EXPENSE_ADJUSTMENT_KINDS);
  const amount = requireMinorUnitsField(body, 'amount') as Paise;
  const occurredAt = requireTimestamp(body, 'occurredAt');
  const adjustmentPaymentIdRaw = optionalString(body, 'adjustmentPaymentId');
  const itemAttributions = parseItemAttributions(body);

  const result = await recordExpenseAdjustment(deps.db, {
    expenseId,
    kind,
    amount,
    occurredAt,
    ...(itemAttributions === undefined ? {} : { itemAttributions }),
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
 * allocation's lines; omit it for the proportional-to-existing-share default. It describes the
 * **unattributed** whole-expense reduction only — where an item refund lands is decided by its
 * attribution and the approved item ownership, so weights sent for an expense whose whole
 * reduction is item-attributed come back 422, not silently ignored (ADR-0018 (item refunds)).
 */
export async function postDistributeAdjustment(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'record or distribute an adjustment');
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

/**
 * `GET /api/expenses/:expenseId/refund-allocation` — the item-refund picture, as a read.
 *
 * Gross and net expense amounts side by side, every item's gross/refunded/net cost, the
 * attributed and unattributed halves of the reduction kept apart, the current allocation, the
 * lines a distribution would write, and whether one is still owed. Nothing here changes state:
 * seeing what a refund implies and approving it are two acts, exactly as recording and
 * distributing are (ADR-0008, ADR-0018 (item refunds)).
 */
export async function getRefundAllocationRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  return jsonResponse(200, await getRefundAllocationState(deps.db, expenseId));
}

/* ------------------------------------------------------------------------- validation */

/**
 * Parses the complete item attribution set, or `undefined` for a legacy whole-expense refund.
 *
 * An empty array is rejected rather than read as "no attribution": the two are different
 * statements — "this refund covers these items" with none named is a malformed proposal,
 * while omitting the field is a deliberate whole-expense refund (ADR-0018, 19.2). Amounts are
 * decimal-string minor units for the same reason every other money field is: a JSON number
 * cannot carry paise exactly (`invariants.md` #12).
 */
function parseItemAttributions(
  body: Record<string, unknown>,
): readonly RefundAttributionDraft[] | undefined {
  const raw = body['itemAttributions'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiRequestError(
      '"itemAttributions", when present, must be a non-empty array of ' +
        '{ expenseItemId, amount } objects. Omit it entirely for a whole-expense refund.',
      'itemAttributions',
    );
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiRequestError(
        `"itemAttributions[${index}]" must be an object.`,
        `itemAttributions[${index}]`,
      );
    }
    const attribution = entry as Record<string, unknown>;
    const expenseItemId = requireUuid(
      requireString(attribution, 'expenseItemId'),
      `itemAttributions[${index}].expenseItemId`,
    );
    return {
      expenseItemId: asId<'expense_item'>(expenseItemId),
      amount: requireMinorUnitsField(attribution, 'amount') as Paise,
    };
  });
}

/**
 * `GET /api/expenses/:expenseId/adjustments` — every adjustment ever recorded against it.
 *
 * Includes reversed ones, deliberately and uniquely: every other adjustment read excludes them
 * because a reversed refund never reduced anything, and this one includes them because a
 * ledger that hid its own corrections would be rewriting its past (ADR-0052). Each entry
 * carries `counts`, so a screen never has to work out for itself whether a row is money.
 */
export async function getExpenseAdjustmentsRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const adjustments = await listExpenseAdjustments(deps.db, expenseId);
  return jsonResponse(200, {
    adjustments: adjustments.map((entry) => ({
      ...entry,
      amount: entry.amount.toString(),
      occurredAt: entry.occurredAt.toISOString(),
      reversedAt: entry.reversedAt?.toISOString() ?? null,
    })),
  });
}

/**
 * `POST /api/adjustments/:adjustmentId/reverse` — say an adjustment was recorded in error.
 *
 * Body: `{ actor, reason }`. The reason is **required** by the service, not merely encouraged:
 * a net amount that changes with no account of why is the one thing an append-only financial
 * record must not allow.
 *
 * This is not a delete and not an edit. The row keeps its amount, its kind and its date; what
 * changes is whether it counts. The expense's timeline still shows it, with its reversal
 * beside it, and the allocation is **not** rebuilt — somebody approved those shares, and
 * `POST /api/expenses/:expenseId/adjustments/distribute` stays the deliberate second act.
 */
export async function postAdjustmentReversal(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const adjustmentId = asId<'expense_adjustment'>(
    requireUuid(requireParam(params, 'adjustmentId'), 'adjustmentId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'reverse an adjustment');
  const reason = requireString(body, 'reason');

  const result = await reverseExpenseAdjustment(deps.db, {
    adjustmentId,
    reason,
    audit: { actor, source: 'api POST /api/adjustments/:adjustmentId/reverse', reason },
  });

  return jsonResponse(200, {
    ...result,
    reversedAmount: result.reversedAmount.toString(),
    netAmountAfter: result.netAmountAfter.toString(),
  });
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
