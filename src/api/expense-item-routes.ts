/**
 * The `ExpenseItem` surface: record an expense's full item breakdown, once, and read it back.
 *
 * ```
 * POST /api/expenses/:expenseId/items    record the complete item set
 * GET  /api/expenses/:expenseId/items    read it back
 * ```
 *
 * Same shape as every other route file: `actor` arrives in the body, checked against the
 * person forms, because there is no session yet.
 */

import { asId } from '../domain/index.js';
import { getExpenseItems, recordExpenseItems } from '../services/index.js';
import type { ExpenseItemDraft } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalString,
  readJsonObject,
  requireMinorUnitsField,
  requireParam,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/expenses/:expenseId/items` — record the complete item breakdown.
 *
 * Body: `{ actor, reason?, items: [{ description, amount, quantity?, receiptItemId? }] }`.
 * `amount` is a minor-units decimal string; the items must sum to the expense's gross amount
 * or the request fails with `EXPENSE_ITEMS_SUM_MISMATCH`.
 */
export async function postExpenseItems(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const items = parseItems(body);

  const result = await recordExpenseItems(deps.db, {
    expenseId,
    items,
    audit: {
      actor,
      source: 'api POST /api/expenses/:expenseId/items',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(201, result);
}

/** `GET /api/expenses/:expenseId/items` — an expense's item breakdown, or an empty list. */
export async function getExpenseItemsRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const items = await getExpenseItems(deps.db, expenseId);
  return jsonResponse(200, { items });
}

/* ------------------------------------------------------------------------- validation */

function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot record expense items over HTTP. A request here is a person's act, so ` +
        'the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}

function parseItems(body: Record<string, unknown>): readonly ExpenseItemDraft[] {
  const raw = body['items'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiRequestError('"items" is required and must be a non-empty array.', 'items');
  }
  return raw.map((entry, index) => parseItem(entry, `items[${index}]`));
}

function parseItem(raw: unknown, field: string): ExpenseItemDraft {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiRequestError(`"${field}" must be an object.`, field);
  }
  const item = raw as Record<string, unknown>;
  const description = requireString(item, 'description');
  const amount = requireMinorUnitsField(item, 'amount');
  const quantity = optionalString(item, 'quantity');
  const receiptItemIdRaw = optionalString(item, 'receiptItemId');

  return {
    description,
    amount: amount as ExpenseItemDraft['amount'],
    ...(quantity === undefined ? {} : { quantity }),
    ...(receiptItemIdRaw === undefined
      ? {}
      : {
          receiptItemId: asId<'receipt_item'>(
            requireUuid(receiptItemIdRaw, `${field}.receiptItemId`),
          ),
        }),
  };
}
