/**
 * Reconciliation surface (`docs/roadmap.md` phase 15, ADR-0041; phase 21 for the account
 * boundaries and snapshots):
 *
 * ```
 * POST /api/reconciliation/runs                        run one for a period
 * GET  /api/reconciliation/runs                        history, newest first
 * GET  /api/reconciliation/runs/:id                    one run in full
 * GET  /api/reconciliation/runs/:id/account-snapshots  ADR-0017's per-account cash identity
 * ```
 *
 * `services.runReconciliation`'s API exposure was deferred by ADR-0038/0039 to phase 15, which
 * already owned it per `docs/roadmap.md`. Phase 16 then shipped ADR-0017 (cash balance)'s
 * `ReconciliationAccountSnapshot` with **no** API surface, deliberately — "collecting evidenced
 * statement balances and displaying the account waterfall are Phase 21's" — so this file gains
 * exactly two things here and nothing else: an optional `accountBoundaries` on the POST body,
 * and a read of the snapshots a run wrote.
 *
 * Neither invents a balance. An account whose boundaries a caller omits still produces an
 * honestly `incomplete` snapshot, because 17.5's "unknown is not zero" is enforced in the
 * domain and as a row `CHECK`, not by anything this transport does or does not send.
 */

import { asId } from '../domain/index.js';
import type { AccountId, EvidenceId, Paise } from '../domain/index.js';
import {
  getReconciliationAccountSnapshots,
  getReconciliationRun,
  listReconciliationRunHistory,
  requireUserPersonId,
  runReconciliation,
} from '../services/index.js';
import type { AccountBoundaryInput } from '../services/index.js';
import { ServiceError } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalSignedMinorUnitsField,
  optionalString,
  readJsonObject,
  requireParam,
  requireString,
  requireTimestamp,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/reconciliation/runs` — body:
 * `{ periodStart, periodEnd, actor, reason?, accountBoundaries? }`.
 *
 * `userPersonId` is resolved the same way every other route names the user — via
 * `services.requireUserPersonId` — never accepted from the caller.
 *
 * `accountBoundaries` is the evidenced statement opening/closing balance per account
 * (ADR-0017 (cash balance), 17.5): `[{ accountId, openingBalance?, openingBalanceEvidenceId?,
 * closingBalance?, closingBalanceEvidenceId? }]`. Balances are **signed** minor-unit decimal
 * strings, because an overdraft is a real balance. Omit an account, or the whole field, and
 * that account's snapshot comes back `incomplete` rather than closing at a cosmetic zero.
 */
export async function postReconciliationRun(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const periodStart = requireTimestamp(body, 'periodStart');
  const periodEnd = requireTimestamp(body, 'periodEnd');
  if (periodEnd < periodStart) {
    throw new ApiRequestError('"periodEnd" must not be before "periodStart".', 'periodEnd');
  }
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const accountBoundaries = parseAccountBoundaries(body);
  const userPersonId = await requireUserPersonId(deps.db);

  const result = await runReconciliation(deps.db, {
    userPersonId,
    periodStart,
    periodEnd,
    splitwise: deps.splitwise,
    ...(accountBoundaries === undefined ? {} : { accountBoundaries }),
    audit: {
      actor,
      source: 'api POST /api/reconciliation/runs',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(201, result);
}

/** `GET /api/reconciliation/runs` — query: `?limit=`. */
export async function getReconciliationRunsRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = optionalPositiveInteger(params, 'limit');

  const runs = await listReconciliationRunHistory(deps.db, {
    ...(limit === undefined ? {} : { limit }),
  });
  return jsonResponse(200, { runs });
}

/** `GET /api/reconciliation/runs/:id` — one run in full, including its Splitwise snapshot. */
export async function getReconciliationRunRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const reconciliationRunId = asId<'reconciliation_run'>(
    requireUuid(requireParam(params, 'id'), 'id'),
  );

  const run = await getReconciliationRun(deps.db, reconciliationRunId);
  if (run === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No reconciliation run with id ${reconciliationRunId}.`,
      { reconciliationRunId },
    );
  }
  return jsonResponse(200, run);
}

/**
 * `GET /api/reconciliation/runs/:id/account-snapshots` — ADR-0017's second identity, per
 * account.
 *
 * Each snapshot carries its own evidenced boundaries, the gross debit/credit totals, the
 * internal-transfer and explained/unexplained subsets of those totals, `expectedEndingBalance`,
 * the signed `cashBalanceDelta`, its `verificationStatus` and its discrepancies — everything a
 * waterfall renders, already computed and already stored. A run with no snapshots (no accounts
 * existed) returns an empty list, which is not the same as a zero delta.
 */
export async function getReconciliationAccountSnapshotsRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const reconciliationRunId = asId<'reconciliation_run'>(
    requireUuid(requireParam(params, 'id'), 'id'),
  );

  const run = await getReconciliationRun(deps.db, reconciliationRunId);
  if (run === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No reconciliation run with id ${reconciliationRunId}.`,
      { reconciliationRunId },
    );
  }

  const snapshots = await getReconciliationAccountSnapshots(deps.db, reconciliationRunId);
  return jsonResponse(200, { reconciliationRunId, snapshots });
}

/* ------------------------------------------------------------------------- validation */

function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot run a reconciliation over HTTP. A request here is a person's act, so ` +
        'the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}

/**
 * Parses `accountBoundaries`, or `undefined` when the caller sent none.
 *
 * An empty array is refused rather than read as "no boundaries": the two are different
 * statements, and the difference is exactly the one 17.5 cares about — omitting the field says
 * nothing has been confirmed, while sending `[]` reads like a claim about accounts it does not
 * name. A balance without its evidence is likewise refused: "a balance with no evidence is a
 * number somebody typed, and this system does not have a field for that"
 * (`domain/cash-balance.ts`).
 */
function parseAccountBoundaries(
  body: Record<string, unknown>,
): readonly AccountBoundaryInput[] | undefined {
  const raw = body['accountBoundaries'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiRequestError(
      '"accountBoundaries", when present, must be a non-empty array of { accountId, ' +
        'openingBalance?, openingBalanceEvidenceId?, closingBalance?, closingBalanceEvidenceId? } ' +
        'objects. Omit it entirely when no statement balance has been confirmed.',
      'accountBoundaries',
    );
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `accountBoundaries[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiRequestError(`"${field}" must be an object.`, field);
    }
    const boundary = entry as Record<string, unknown>;
    const accountId = requireUuid(requireString(boundary, 'accountId'), `${field}.accountId`);
    if (seen.has(accountId)) {
      throw new ApiRequestError(
        `"${field}.accountId" names an account already given boundaries in this request.`,
        `${field}.accountId`,
      );
    }
    seen.add(accountId);

    const openingBalance = optionalSignedMinorUnitsField(boundary, 'openingBalance') ?? null;
    const closingBalance = optionalSignedMinorUnitsField(boundary, 'closingBalance') ?? null;
    const openingBalanceEvidenceId = optionalEvidenceId(
      boundary,
      'openingBalanceEvidenceId',
      field,
    );
    const closingBalanceEvidenceId = optionalEvidenceId(
      boundary,
      'closingBalanceEvidenceId',
      field,
    );

    requireEvidenceForBalance(openingBalance, openingBalanceEvidenceId, `${field}.openingBalance`);
    requireEvidenceForBalance(closingBalance, closingBalanceEvidenceId, `${field}.closingBalance`);

    return {
      accountId: asId<'account'>(accountId) satisfies AccountId,
      openingBalance: openingBalance === null ? null : (openingBalance as Paise),
      openingBalanceEvidenceId,
      closingBalance: closingBalance === null ? null : (closingBalance as Paise),
      closingBalanceEvidenceId,
    };
  });
}

function optionalEvidenceId(
  boundary: Record<string, unknown>,
  key: string,
  field: string,
): EvidenceId | null {
  const raw = optionalString(boundary, key);
  if (raw === undefined) return null;
  return asId<'evidence'>(requireUuid(raw, `${field}.${key}`)) satisfies EvidenceId;
}

function requireEvidenceForBalance(
  balance: bigint | null,
  evidenceId: EvidenceId | null,
  field: string,
): void {
  if (balance !== null && evidenceId === null) {
    throw new ApiRequestError(
      `"${field}" needs the immutable statement evidence it came from ` +
        '(ADR-0017 (cash balance), 17.5). Send the matching evidence id, or omit the balance ' +
        'and let the snapshot report itself incomplete.',
      field,
    );
  }
}
