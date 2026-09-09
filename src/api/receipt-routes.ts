/**
 * The receipt surface: extract, confirm, correct, read.
 *
 * ```
 * POST /api/evidence/:evidenceId/receipt    extract a Receipt from an eligible document
 * POST /api/receipts/:receiptId/confirm     accept it as extracted
 * POST /api/receipts/:receiptId/correct     overwrite fields and/or replace the item set
 * GET  /api/receipts/:receiptId             the Receipt, its items, and what is surfaced about it
 * ```
 *
 * Same shape as `evidence-routes.ts`: **`actor` arrives in the request body**, checked against
 * the person forms, because there is no session yet (`system-architecture.md`). Confirming or
 * correcting a `Receipt` is a decision `domain.parseDecisionActor` re-checks inside the service
 * — the same rule `decideInference` applies — so a request claiming to be `system` or `ai` is
 * refused there even if it slipped past this layer.
 */

import { asId } from '../domain/index.js';
import type { MerchantId, Paise } from '../domain/index.js';
import type { ReceiptItemDraft } from '../ai/index.js';
import { confirmReceipt, correctReceipt, extractReceipt, getReceipt } from '../services/index.js';
import type { ReceiptCorrection } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalMinorUnitsField,
  optionalString,
  readJsonObject,
  requireParam,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/evidence/:evidenceId/receipt` — extract a `Receipt` from one piece of evidence.
 *
 * Body: `{ actor, reason? }`. A rejected proposal (the model's answer was not usable) is a
 * 422 naming its `code`; an ineligible or already-extracted evidence row is a `ServiceError`,
 * mapped by `toErrorResponse` the same way every other precondition failure is.
 */
export async function postReceiptExtraction(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const outcome = await extractReceipt(deps.db, {
    evidenceId,
    ai: deps.ai,
    evidenceStore: deps.evidenceStore,
    ...(deps.documentText === undefined ? {} : { documentText: deps.documentText }),
    audit: {
      actor,
      source: 'api POST /api/evidence/:evidenceId/receipt',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  if (outcome.outcome === 'rejected') {
    return jsonResponse(422, { error: { code: outcome.code, message: outcome.reason } });
  }
  return jsonResponse(201, outcome.view);
}

/**
 * `POST /api/receipts/:receiptId/confirm` — accept a `Receipt` as extracted.
 *
 * Body: `{ actor, reason? }`.
 */
export async function postReceiptConfirmation(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const receiptId = asId<'receipt'>(requireUuid(requireParam(params, 'receiptId'), 'receiptId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const view = await confirmReceipt(deps.db, {
    receiptId,
    audit: {
      actor,
      source: 'api POST /api/receipts/:receiptId/confirm',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(200, view);
}

/**
 * `POST /api/receipts/:receiptId/correct` — overwrite fields and/or replace the item set.
 *
 * Body: `{ actor, reason?, merchantId?, subtotal?, tax?, total?, currency?, items? }`. Each
 * money field is `null` to clear it, an exact minor-units decimal string to set it, or absent
 * to leave it as extraction left it — `optionalMinorUnitsField` is what tells those three
 * apart. `items`, when present, replaces the whole set.
 */
export async function postReceiptCorrection(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const receiptId = asId<'receipt'>(requireUuid(requireParam(params, 'receiptId'), 'receiptId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const correction = parseCorrectionBody(body);

  const view = await correctReceipt(deps.db, {
    receiptId,
    correction,
    audit: {
      actor,
      source: 'api POST /api/receipts/:receiptId/correct',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(200, view);
}

/** `GET /api/receipts/:receiptId` — the Receipt, its items, and what is surfaced about it. */
export async function getReceiptRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const receiptId = asId<'receipt'>(requireUuid(requireParam(params, 'receiptId'), 'receiptId'));
  return jsonResponse(200, await getReceipt(deps.db, receiptId));
}

/* ------------------------------------------------------------------------- validation */

/**
 * An actor this correction/confirmation can be attributed to.
 *
 * The same rule `evidence-routes.ts` applies to an upload: a request over HTTP is a person's
 * act, so `system`/`ai` are refused here rather than left for `domain.parseDecisionActor` to
 * catch three layers down.
 */
function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot confirm or correct a receipt over HTTP. A request here is a person's ` +
        'act, so the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}

function parseCorrectionBody(body: Record<string, unknown>): ReceiptCorrection {
  const merchantId = optionalNullableUuid(body, 'merchantId');
  const subtotal = optionalMinorUnitsField(body, 'subtotal');
  const tax = optionalMinorUnitsField(body, 'tax');
  const total = optionalMinorUnitsField(body, 'total');
  const currency = optionalString(body, 'currency');
  const items = optionalItems(body);

  const correction: {
    merchantId?: MerchantId | null;
    subtotal?: Paise | null;
    tax?: Paise | null;
    total?: Paise | null;
    currency?: string;
    items?: readonly ReceiptItemDraft[];
  } = {};
  if (merchantId !== undefined) correction.merchantId = merchantId as MerchantId | null;
  if (subtotal !== undefined) correction.subtotal = subtotal as Paise | null;
  if (tax !== undefined) correction.tax = tax as Paise | null;
  if (total !== undefined) correction.total = total as Paise | null;
  if (currency !== undefined) correction.currency = currency;
  if (items !== undefined) correction.items = items;
  return correction;
}

/** Distinguishes "absent" from "explicitly null", the same way `optionalMinorUnitsField` does. */
function optionalNullableUuid(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ApiRequestError(`"${field}", when present, must be a UUID string or null.`, field);
  }
  return requireUuid(value, field);
}

function optionalItems(body: Record<string, unknown>): readonly ReceiptItemDraft[] | undefined {
  const raw = body['items'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ApiRequestError('"items", when present, must be an array.', 'items');
  }
  return raw.map((entry, index) => parseCorrectionItem(entry, `items[${index}]`));
}

function parseCorrectionItem(raw: unknown, field: string): ReceiptItemDraft {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiRequestError(`"${field}" must be an object.`, field);
  }
  const item = raw as Record<string, unknown>;
  const description = requireString(item, 'description');
  const quantity = requireString(item, 'quantity');
  const unitPrice = optionalMinorUnitsField(item, 'unitPrice');
  const lineTotal = optionalMinorUnitsField(item, 'lineTotal');
  if (lineTotal === undefined || lineTotal === null) {
    throw new ApiRequestError(`"${field}.lineTotal" is required.`, `${field}.lineTotal`);
  }
  const suggestedCategory = optionalString(item, 'suggestedCategory');

  return {
    description,
    quantity,
    unitPrice: (unitPrice ?? null) as Paise | null,
    lineTotal: lineTotal as Paise,
    suggestedCategory: suggestedCategory ?? null,
  };
}
