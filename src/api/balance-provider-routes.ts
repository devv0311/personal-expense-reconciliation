/**
 * Live bank and card balances (audit row 37, ADR-0054).
 *
 * ```
 * GET  /api/balance-provider/status                  what is configured, and how many accounts are linked
 * GET  /api/balance-provider/links                   the account ↔ provider mapping
 * POST /api/balance-provider/links                   map one account
 * POST /api/balance-provider/links/:linkId/unlink    stop asking about one account
 * POST /api/balance-provider/refresh                 read every linked account now
 * GET  /api/balance-provider/comparison              latest readings vs. a run's evidenced closings
 * GET  /api/accounts/:accountId/balance-readings     one account's reading history
 * ```
 *
 * There is deliberately **no route that writes a boundary from a reading**. A reconciliation
 * snapshot's opening and closing balances come from a statement somebody evidenced, and
 * `POST /api/reconciliation/runs` remains the only thing that sets them. A route here that
 * could fill one in would be a way to manufacture a `verified` ₹0 delta out of an HTTP call.
 *
 * `GET /api/balance-provider/comparison` takes a `runId` and answers with each account's
 * latest reading beside the closing balance that run evidenced — a second opinion, with its
 * own timestamp, staleness and read-completeness attached.
 */

import { asId } from '../domain/index.js';
import type { AccountId, Paise } from '../domain/index.js';
import {
  compareAccountBalances,
  getBalanceProviderStatus,
  getReconciliationAccountSnapshots,
  linkAccountToProvider,
  listAccountReadingHistory,
  listProviderLinks,
  refreshAccountBalances,
  unlinkAccountFromProvider,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalString,
  readJsonObject,
  requirePersonActor,
  requireParam,
  requireString,
  requireUuid,
  requireUuidField,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/** `GET /api/balance-provider/status` — is anything configured, and how much is mapped. */
export async function getBalanceProviderStatusRoute(deps: ApiDependencies): Promise<Response> {
  return jsonResponse(200, await getBalanceProviderStatus(deps.db, requireProvider(deps)));
}

/** `GET /api/balance-provider/links` — the mapping, with the ledger account each ref names. */
export async function getBalanceProviderLinksRoute(deps: ApiDependencies): Promise<Response> {
  return jsonResponse(200, { links: await listProviderLinks(deps.db) });
}

/**
 * `POST /api/balance-provider/links` — map one account to one provider account.
 *
 * Body: `{ actor, reason?, accountId, externalAccountRef, providerLabel? }`. The provider is
 * the configured one; a caller cannot name a different provider than the one this process
 * actually has an adapter for.
 */
export async function postBalanceProviderLink(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'link an account to a balance provider');
  const reason = optionalString(body, 'reason');
  const accountId = asId<'account'>(requireUuidField(body, 'accountId'));
  const externalAccountRef = requireString(body, 'externalAccountRef');
  const providerLabel = optionalString(body, 'providerLabel');
  const provider = requireProvider(deps);

  const link = await linkAccountToProvider(deps.db, {
    accountId,
    providerId: provider.describe().providerId,
    externalAccountRef,
    ...(providerLabel === undefined ? {} : { providerLabel }),
    audit: {
      actor,
      source: 'api POST /api/balance-provider/links',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(201, link);
}

/** `POST /api/balance-provider/links/:linkId/unlink` — an archive, never a delete. */
export async function postBalanceProviderUnlink(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const linkId = asId<'account_provider_link'>(
    requireUuid(requireParam(params, 'linkId'), 'linkId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'unlink an account from a balance provider');
  const reason = optionalString(body, 'reason');

  await unlinkAccountFromProvider(deps.db, {
    linkId,
    audit: {
      actor,
      source: 'api POST /api/balance-provider/links/:linkId/unlink',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, { unlinked: true });
}

/**
 * `POST /api/balance-provider/refresh` — read every linked account now.
 *
 * A write, because it records what the provider said — including that it said nothing. Never
 * a failure response for a provider-side problem: an unreachable provider produces a full set
 * of `unavailable` readings and an incomplete read, which is the answer a person needs.
 */
export async function postBalanceProviderRefresh(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'read live balances');
  const reason = optionalString(body, 'reason');

  const result = await refreshAccountBalances(deps.db, {
    provider: requireProvider(deps),
    audit: {
      actor,
      source: 'api POST /api/balance-provider/refresh',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/**
 * `GET /api/balance-provider/comparison?runId=…` — readings beside a run's evidenced closings.
 *
 * The one read that puts the two figures next to each other, and the one place the rule is
 * visible in the response: a reading that agrees does not make anything verified, and one that
 * is missing does not make anything wrong.
 */
export async function getBalanceComparisonRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const runId = params.get('runId');
  if (runId === null) {
    throw new ApiRequestError(
      '"runId" is required: a live balance is only meaningful beside the period it is being ' +
        'compared to.',
      'runId',
    );
  }
  const snapshots = await getReconciliationAccountSnapshots(
    deps.db,
    asId<'reconciliation_run'>(requireUuid(runId, 'runId')),
  );

  const ledgerFigures = new Map<AccountId, Paise | null>();
  let comparedTo = new Date();
  for (const snapshot of snapshots) {
    ledgerFigures.set(snapshot.accountId, snapshot.closingBalance);
    comparedTo = snapshot.periodEnd;
  }

  const comparisons = await compareAccountBalances(deps.db, { ledgerFigures, comparedTo });
  return jsonResponse(200, {
    comparedTo: comparedTo.toISOString(),
    provider: requireProvider(deps).describe(),
    comparisons,
    // Restated in the payload rather than only in a screen: the rule belongs to the API.
    note:
      'A provider reading is a second opinion, never a period boundary. It cannot make an ' +
      'unaccounted delta verified, and its absence cannot make one wrong (ADR-0054).',
  });
}

/** `GET /api/accounts/:accountId/balance-readings` — one account's reading history. */
export async function getAccountBalanceReadingsRoute(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const accountId = asId<'account'>(requireUuid(requireParam(params, 'accountId'), 'accountId'));
  const limit = optionalPositiveInteger(new URL(request.url).searchParams, 'limit');
  const readings = await listAccountReadingHistory(deps.db, accountId, limit);
  return jsonResponse(200, { readings });
}

/* ------------------------------------------------------------------------- validation */

function requireProvider(deps: ApiDependencies) {
  if (deps.balanceProvider === undefined) {
    throw new ApiRequestError(
      'This API was composed without a balance provider, so nothing can be read. That is a ' +
        'wiring mistake rather than a configuration state: an installation with no ' +
        'credentials still gets a provider that reports every read as incomplete.',
    );
  }
  return deps.balanceProvider;
}
