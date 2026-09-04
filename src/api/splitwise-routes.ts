/**
 * The Splitwise surface (`docs/roadmap.md` phase 14):
 *
 * ```
 * POST /api/integrations/splitwise/connect            connect an ExternalIntegration
 * POST /api/expenses/:expenseId/ready-to-sync          allocated → ready_to_sync
 * POST /api/expenses/:expenseId/splitwise-sync          sync an Expense, once
 * POST /api/settlements/:settlementId/splitwise-sync    sync a Settlement, once
 * ```
 *
 * The last two build the payload and call the port in the same request — there is no separate
 * "propose" route. `data-flow.md` step 8 is explicit that no AI call sits on this path, so
 * there is nothing to review asynchronously the way `decideInference` reviews an `AIInference`
 * (ADR-0040).
 */

import { asId } from '../domain/index.js';
import {
  connectSplitwiseIntegration,
  syncExpenseToSplitwise,
  syncSettlementToSplitwise,
  transitionExpense,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalString,
  readJsonObject,
  requireParam,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/integrations/splitwise/connect` — body: `{ externalAccountRef? }`.
 *
 * No `actor` field: `ExternalIntegration` is SYSTEM-classified configuration, not an APPROVED
 * decision, and carries no `AuditEvent` (`splitwise-service.ts`).
 */
export async function postConnectSplitwiseIntegration(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const externalAccountRef = optionalString(body, 'externalAccountRef') ?? null;

  const result = await connectSplitwiseIntegration(deps.db, { externalAccountRef });
  return jsonResponse(201, result);
}

/**
 * `POST /api/expenses/:expenseId/ready-to-sync` — body: `{ actor, reason? }`.
 *
 * `services.transitionExpense`, reused unchanged: this route is its first `src/api` caller,
 * not new lifecycle logic (ADR-0040).
 */
export async function postReadyToSync(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const result = await transitionExpense(deps.db, {
    expenseId,
    to: 'ready_to_sync',
    audit: {
      actor,
      source: 'api POST /api/expenses/:expenseId/ready-to-sync',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/** `POST /api/expenses/:expenseId/splitwise-sync` — body: `{ actor, reason? }`. */
export async function postSyncExpense(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const result = await syncExpenseToSplitwise(deps.db, {
    expenseId,
    splitwise: deps.splitwise,
    audit: {
      actor,
      source: 'api POST /api/expenses/:expenseId/splitwise-sync',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(201, result);
}

/** `POST /api/settlements/:settlementId/splitwise-sync` — body: `{ actor, reason? }`. */
export async function postSyncSettlement(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const settlementId = asId<'settlement'>(
    requireUuid(requireParam(params, 'settlementId'), 'settlementId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const result = await syncSettlementToSplitwise(deps.db, {
    settlementId,
    splitwise: deps.splitwise,
    audit: {
      actor,
      source: 'api POST /api/settlements/:settlementId/splitwise-sync',
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
      `"${actor}" cannot act over HTTP. A request here is a person's act, so the actor is ` +
        '"user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}
