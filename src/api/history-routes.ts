/**
 * Browsing what was recorded: the evidence library, and the audit trail over a record.
 *
 * ```
 * GET /api/evidence                     the library, filtered and paged
 * GET /api/expenses/:expenseId/history  allocation versions + the whole chronological trail
 * GET /api/payments/:paymentId/history  every decision recorded against one movement
 * GET /api/audit/:entityType/:entityId  the trail over any auditable record
 * ```
 *
 * `GET /api/evidence` is registered **before** `/api/evidence/:evidenceId` for the ordering
 * rule `router.ts` states — though in this case they differ in segment count, so nothing could
 * have been swallowed either way.
 *
 * Every route here is a read over the append-only log. None of them can write, and there is no
 * corresponding write path anywhere in this repository (`invariants.md` #22).
 */

import {
  AUDITABLE_ENTITY_TYPES,
  EVIDENCE_NOTE_KINDS,
  EVIDENCE_TYPES,
  asId,
} from '../domain/index.js';
import { getAuditHistory, getExpenseHistory, listEvidenceCatalog } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalOneOfParam,
  optionalPositiveInteger,
  optionalTimestampParam,
  optionalUuidParam,
  requireParam,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `GET /api/evidence` — every stored document and note (audit row 10).
 *
 * Query: `type`, `noteKind`, `linkage` (`linked`/`unlinked`), `linkedPaymentId`,
 * `linkedExpenseId`, `search`, `from`/`to`, `limit`, `offset`.
 *
 * `unlinked` is the useful one: a document nobody has attached to anything is a piece of
 * evidence the ledger is not yet using, and until now the only way to see one was to wait for
 * it to surface in the review queue.
 */
export async function getEvidenceLibraryRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const type = optionalOneOfParam(params, 'type', EVIDENCE_TYPES);
  const noteKind = optionalOneOfParam(params, 'noteKind', EVIDENCE_NOTE_KINDS);
  const linkage = optionalOneOfParam(params, 'linkage', ['linked', 'unlinked'] as const);
  const linkedPaymentId = optionalUuidParam(params, 'linkedPaymentId');
  const linkedExpenseId = optionalUuidParam(params, 'linkedExpenseId');
  const search = params.get('search');
  const capturedFrom = optionalTimestampParam(params, 'from');
  const capturedTo = optionalTimestampParam(params, 'to');
  const limit = optionalPositiveInteger(params, 'limit');
  const offset = optionalPositiveInteger(params, 'offset');

  const result = await listEvidenceCatalog(deps.db, {
    ...(type === undefined ? {} : { type }),
    ...(noteKind === undefined ? {} : { noteKind }),
    ...(linkage === undefined ? {} : { linkage }),
    ...(linkedPaymentId === undefined ? {} : { linkedPaymentId: asId<'payment'>(linkedPaymentId) }),
    ...(linkedExpenseId === undefined ? {} : { linkedExpenseId: asId<'expense'>(linkedExpenseId) }),
    ...(search === null || search.length === 0 ? {} : { search }),
    ...(capturedFrom === undefined ? {} : { capturedFrom }),
    ...(capturedTo === undefined ? {} : { capturedTo }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
  return jsonResponse(200, result);
}

/**
 * `GET /api/expenses/:expenseId/history` — one expense's whole story (audit row 26).
 *
 * Every allocation version it has ever had, with the lines each was approved with, plus the
 * chronological audit trail of the expense, its adjustments, its allocations and its
 * documents. Quoted from the log, never recomputed: what an old split *would* be today is a
 * different question, and answering it here would relabel it as history.
 */
export async function getExpenseHistoryRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const history = await getExpenseHistory(deps.db, expenseId);
  return jsonResponse(200, history);
}

/** `GET /api/payments/:paymentId/history` — every decision recorded against one movement. */
export async function getPaymentHistoryRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const history = await getAuditHistory(deps.db, 'payment', paymentId);
  return jsonResponse(200, history);
}

/**
 * `GET /api/audit/:entityType/:entityId` — the trail over any auditable record.
 *
 * The general form of the two above, for the records that have no screen of their own yet —
 * a settlement, a group membership, an evidence match candidate. `entityType` is checked
 * against `AUDITABLE_ENTITY_TYPES` rather than passed through, so a typo is a 400 naming the
 * permitted set instead of an empty list that reads like "nothing ever happened".
 */
export async function getAuditTrailRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const rawType = requireParam(params, 'entityType');
  if (!(AUDITABLE_ENTITY_TYPES as readonly string[]).includes(rawType)) {
    throw new ApiRequestError(
      `"${rawType}" is not an auditable entity type. One of: ${AUDITABLE_ENTITY_TYPES.join(', ')}.`,
      'entityType',
    );
  }
  const entityId = requireUuid(requireParam(params, 'entityId'), 'entityId');
  const history = await getAuditHistory(
    deps.db,
    rawType as (typeof AUDITABLE_ENTITY_TYPES)[number],
    entityId,
  );
  return jsonResponse(200, history);
}
