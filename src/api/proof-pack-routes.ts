/**
 * `GET /api/proof-packs/:recipientPersonId` — the recipient-specific derived proof pack
 * (`docs/roadmap.md` Phase 20, ADR-0047).
 *
 * A read, and only a read: it derives a preview from approved ledger state and returns it.
 * Nothing is sent, no settlement is recorded, and no row anywhere is written — which is why
 * this is a `GET`, like `/api/balances/:a/:b` and `/api/expenses/:id/refund-allocation`.
 *
 * `userPersonId` is resolved from the single `User` row via `services.requireUserPersonId`,
 * never taken from the request. `?asOf=<ISO-8601>` pins the pack's explicit as-of label;
 * omitted, it is the moment the request was served.
 */

import { asId } from '../domain/index.js';
import { buildProofPackPreview, requireUserPersonId } from '../services/index.js';

import { ApiRequestError, jsonResponse, requireParam, requireUuid } from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

export async function getProofPackRoute(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const recipientPersonId = asId<'person'>(
    requireUuid(requireParam(params, 'recipientPersonId'), 'recipientPersonId'),
  );
  const asOf = parseAsOf(new URL(request.url).searchParams.get('asOf'));
  const userPersonId = await requireUserPersonId(deps.db);

  const preview = await buildProofPackPreview(deps.db, {
    userPersonId,
    recipientPersonId,
    ...(asOf === undefined ? {} : { asOf }),
  });

  return jsonResponse(200, preview);
}

/* ------------------------------------------------------------------------- validation */

function parseAsOf(raw: string | null): Date | undefined {
  if (raw === null) return undefined;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new ApiRequestError('"asOf" must be an ISO-8601 timestamp.', 'asOf');
  }
  return value;
}
