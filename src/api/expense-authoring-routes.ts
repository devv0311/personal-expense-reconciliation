/**
 * Authoring an expense by hand, and saying which payments funded it.
 *
 * ```
 * POST /api/expenses                              create one (self- or externally-funded)
 * GET  /api/expenses/:expenseId/payment-links     which payments fund it, and for how much
 * POST /api/expenses/:expenseId/payment-links     attribute part of a payment to it
 * POST /api/expenses/:expenseId/items/correct     replace a wrong item breakdown
 * ```
 *
 * `POST /api/expenses` sits beside the existing `GET /api/expenses` on the same path; the two
 * verbs are two routes, exactly as they are for `/api/payments`.
 */

import { EXPENSE_RELATIONSHIP_TYPES, asId } from '../domain/index.js';
import type { Paise } from '../domain/index.js';
import {
  correctExpenseItems,
  createExpense,
  linkPaymentToExpense,
  listExpenseFunding,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalObjectArray,
  optionalOneOf,
  optionalString,
  readJsonObject,
  requireMinorUnitsField,
  requireOneOf,
  requireParam,
  requirePersonActor,
  requireString,
  requireTimestamp,
  requireUuid,
  requireUuidField,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/expenses` — record an expense a person entered.
 *
 * Body: `{ actor, description, amount, occurredAt, relationshipType, category?,
 * paidByPersonId, funding?: [{ paymentId, amount }], evidenceId?, state? }`.
 *
 * Omitting `funding` is how the externally-funded shape is expressed — a flatmate paid, so
 * this ledger has no payment for it and must not invent one (ADR-0006). `evidenceId` is then
 * required: with no payment behind it, the evidence record is the trail back to what happened.
 */
export async function postExpense(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'record an expense');
  const reason = optionalString(body, 'reason');
  const category = optionalString(body, 'category');
  const evidenceId = optionalString(body, 'evidenceId');
  const state = optionalOneOf(body, 'state', ['proposed', 'approved'] as const);

  const result = await createExpense(deps.db, {
    description: requireString(body, 'description'),
    amount: requireMinorUnitsField(body, 'amount') as Paise,
    occurredAt: requireTimestamp(body, 'occurredAt'),
    relationshipType: requireOneOf(body, 'relationshipType', EXPENSE_RELATIONSHIP_TYPES),
    ...(category === undefined ? {} : { category }),
    paidByPersonId: asId<'person'>(requireUuidField(body, 'paidByPersonId')),
    ...(evidenceId === undefined
      ? {}
      : { evidenceId: asId<'evidence'>(requireUuid(evidenceId, 'evidenceId')) }),
    ...parseFunding(body),
    ...(state === undefined ? {} : { state }),
    audit: {
      actor,
      source: 'api POST /api/expenses',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(201, result);
}

export async function getExpenseFundingRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const links = await listExpenseFunding(deps.db, expenseId);
  return jsonResponse(200, { links });
}

/**
 * `POST /api/expenses/:expenseId/payment-links` — attribute part of a payment to this expense.
 *
 * Body: `{ actor, paymentId, amount, reason? }`. Both many-to-many shapes fall out of repeated
 * calls: one payment across several expenses, several payments onto one expense. The domain
 * refuses a set of links that would explain more money than the payment moved.
 */
export async function postExpenseFunding(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'link a payment to an expense');
  const reason = optionalString(body, 'reason');

  const result = await linkPaymentToExpense(deps.db, {
    expenseId,
    paymentId: asId<'payment'>(requireUuidField(body, 'paymentId')),
    amount: requireMinorUnitsField(body, 'amount') as Paise,
    audit: {
      actor,
      source: 'api POST /api/expenses/:expenseId/payment-links',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(201, result);
}

/**
 * `POST /api/expenses/:expenseId/items/correct` — replace a wrong item breakdown.
 *
 * Body: `{ actor, reason, items: [{ description, amount, quantity? }] }`. The corrected set
 * still sums to the expense's immutable gross amount; the old rows are superseded, never
 * deleted; and the correction is refused outright once an item refund has been attributed to
 * any of them (ADR-0045).
 */
export async function postExpenseItemsCorrection(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'correct an item breakdown');
  const reason = requireString(body, 'reason');
  const rawItems = optionalObjectArray(body, 'items');
  if (rawItems === undefined || rawItems.length === 0) {
    throw new ApiRequestError('"items" is required and must be a non-empty array.', 'items');
  }

  const result = await correctExpenseItems(deps.db, {
    expenseId,
    reason,
    items: rawItems.map((raw) => {
      const quantity = optionalString(raw, 'quantity');
      return {
        description: requireString(raw, 'description'),
        amount: requireMinorUnitsField(raw, 'amount') as Paise,
        ...(quantity === undefined ? {} : { quantity }),
      };
    }),
    audit: { actor, source: 'api POST /api/expenses/:expenseId/items/correct', reason },
  });
  return jsonResponse(200, result);
}

/* ------------------------------------------------------------------------- validation */

function parseFunding(body: Record<string, unknown>): {
  funding?: readonly {
    readonly paymentId: ReturnType<typeof asId<'payment'>>;
    readonly amount: Paise;
  }[];
} {
  const raw = optionalObjectArray(body, 'funding');
  if (raw === undefined) return {};
  return {
    funding: raw.map((entry, index) => ({
      paymentId: asId<'payment'>(
        requireUuid(requireString(entry, 'paymentId'), `funding[${index}].paymentId`),
      ),
      amount: requireMinorUnitsField(entry, 'amount') as Paise,
    })),
  };
}
