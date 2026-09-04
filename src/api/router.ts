/**
 * A path dispatcher, so the API can be exercised by a `Request` — from a test, or from
 * `src/server.ts`, the process that actually runs this dispatcher now (phase 15, ADR-0042) —
 * without a framework in between.
 *
 * The handlers are the real product here; this is the smallest thing that turns a set of them
 * into something you can send a `Request` to. ADR-0032 predicted mounting these directly as
 * Next.js App Router route handlers once a UI phase arrived; ADR-0042 chose instead to give
 * `createApi` a real process of its own (`src/server.ts`, no framework) and have the Next.js
 * app (`web/`) call it over `fetch` like any other client — so this table remains the one place
 * every route is listed, and stays on the path rather than being replaced by one.
 *
 * Matching is exact-segment with `:name` captures, first match wins. No wildcards, no regex
 * routes, no scoring — a route table this small does not need them, and every one of those
 * features is a way for two routes to disagree about who owns a path. The one ordering rule it
 * does have is written down at `API_ROUTES`.
 */

import type { AiService, Database, EvidenceStore, SplitwisePort } from '../services/index.js';

import { postDistributeAdjustment, postExpenseAdjustment } from './adjustment-routes.js';
import { postAllocation } from './allocation-routes.js';
import { getBalanceRoute } from './balance-routes.js';
import {
  getEvidenceContent,
  getEvidenceMetadata,
  postEvidenceFile,
  postEvidenceLink,
  postEvidenceNote,
} from './evidence-routes.js';
import { getExpenseItemsRoute, postExpenseItems } from './expense-item-routes.js';
import { getExpensesRoute } from './expense-ledger-routes.js';
import { jsonResponse, toErrorResponse } from './http.js';
import {
  getReceiptRoute,
  postReceiptConfirmation,
  postReceiptCorrection,
  postReceiptExtraction,
} from './receipt-routes.js';
import {
  getReconciliationRunRoute,
  getReconciliationRunsRoute,
  postReconciliationRun,
} from './reconciliation-routes.js';
import {
  getReviewQueue,
  postInferenceDecision,
  postPaymentDuplicateDecision,
  postPaymentReclassification,
} from './review-routes.js';
import { postSettlement } from './settlement-routes.js';
import {
  postConnectSplitwiseIntegration,
  postReadyToSync,
  postSyncExpense,
  postSyncSettlement,
} from './splitwise-routes.js';

/** What the handlers need. Injected, so nothing in `src/api` reaches for a connection. */
export interface ApiDependencies {
  readonly db: Database;
  /** Used by re-classification only; every other route is a read or a decision. */
  readonly ai: AiService;
  /** Where documents live, which is deliberately not the database (`security-model.md`). */
  readonly evidenceStore: EvidenceStore;
  /** No concrete adapter is wired yet (ADR-0025's precedent) — a test injects a mock. */
  readonly splitwise: SplitwisePort;
}

export type RouteParams = Readonly<Record<string, string>>;

export type RouteHandler = (
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
) => Promise<Response>;

export interface ApiRoute {
  readonly method: 'GET' | 'POST';
  /** e.g. `/api/review/payments/:paymentId/duplicate` */
  readonly path: string;
  readonly handler: RouteHandler;
}

export const REVIEW_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/review', handler: getReviewQueue },
  {
    method: 'POST',
    path: '/api/review/inferences/:inferenceId/decision',
    handler: postInferenceDecision,
  },
  {
    method: 'POST',
    path: '/api/review/payments/:paymentId/reclassify',
    handler: postPaymentReclassification,
  },
  {
    method: 'POST',
    path: '/api/review/payments/:paymentId/duplicate',
    handler: postPaymentDuplicateDecision,
  },
];

/** Ingesting a document, placing it, and reading it back (`docs/roadmap.md` phase 10). */
export const EVIDENCE_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/evidence/files', handler: postEvidenceFile },
  { method: 'POST', path: '/api/evidence/notes', handler: postEvidenceNote },
  { method: 'POST', path: '/api/evidence/:evidenceId/link', handler: postEvidenceLink },
  { method: 'POST', path: '/api/evidence/:evidenceId/receipt', handler: postReceiptExtraction },
  { method: 'GET', path: '/api/evidence/:evidenceId', handler: getEvidenceMetadata },
  { method: 'GET', path: '/api/evidence/:evidenceId/content', handler: getEvidenceContent },
];

/** Confirming, correcting and reading the `Receipt` extraction produced (`docs/roadmap.md` phase 11). */
export const RECEIPT_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/receipts/:receiptId/confirm', handler: postReceiptConfirmation },
  { method: 'POST', path: '/api/receipts/:receiptId/correct', handler: postReceiptCorrection },
  { method: 'GET', path: '/api/receipts/:receiptId', handler: getReceiptRoute },
];

/**
 * Items, allocation and adjustments over one expense — deciding who benefited from it and by
 * how much (`docs/roadmap.md` phase 12).
 */
export const ALLOCATION_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/expenses/:expenseId/items', handler: postExpenseItems },
  { method: 'GET', path: '/api/expenses/:expenseId/items', handler: getExpenseItemsRoute },
  { method: 'POST', path: '/api/expenses/:expenseId/allocation', handler: postAllocation },
  {
    method: 'POST',
    path: '/api/expenses/:expenseId/adjustments/distribute',
    handler: postDistributeAdjustment,
  },
  {
    method: 'POST',
    path: '/api/expenses/:expenseId/adjustments',
    handler: postExpenseAdjustment,
  },
];

/** A manual settlement over a payment, independent of classification (phase 12). */
export const SETTLEMENT_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/payments/:paymentId/settlements', handler: postSettlement },
];

/** The expense ledger, queryable — `services.listExpenses` (`docs/roadmap.md` phase 13). */
export const EXPENSE_LEDGER_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/expenses', handler: getExpensesRoute },
];

/** The pairwise `Balance` between any two people — `services.getBalance` (phase 13, ADR-0006). */
export const BALANCE_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/balances/:personAId/:personBId', handler: getBalanceRoute },
];

/**
 * Running a reconciliation and reading its history — `services.runReconciliation`
 * (phase 15, ADR-0041).
 */
export const RECONCILIATION_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/reconciliation/runs', handler: postReconciliationRun },
  { method: 'GET', path: '/api/reconciliation/runs', handler: getReconciliationRunsRoute },
  { method: 'GET', path: '/api/reconciliation/runs/:id', handler: getReconciliationRunRoute },
];

/** Connecting to, and syncing with, Splitwise for the first time (phase 14, ADR-0040). */
export const SPLITWISE_ROUTES: readonly ApiRoute[] = [
  {
    method: 'POST',
    path: '/api/integrations/splitwise/connect',
    handler: postConnectSplitwiseIntegration,
  },
  { method: 'POST', path: '/api/expenses/:expenseId/ready-to-sync', handler: postReadyToSync },
  { method: 'POST', path: '/api/expenses/:expenseId/splitwise-sync', handler: postSyncExpense },
  {
    method: 'POST',
    path: '/api/settlements/:settlementId/splitwise-sync',
    handler: postSyncSettlement,
  },
];

/**
 * Every route, in match order.
 *
 * Order carries one rule: a literal segment is listed before the capture that would swallow
 * it. `/api/evidence/files` and `/api/evidence/notes` come before `/api/evidence/:evidenceId`,
 * which would otherwise read both as ids. That is the whole precedence story — one line of
 * ordering rather than a scoring algorithm — and `handle` below is what makes it hold for
 * every verb rather than only for the ones that happen to be registered first.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  ...REVIEW_ROUTES,
  ...EVIDENCE_ROUTES,
  ...RECEIPT_ROUTES,
  ...ALLOCATION_ROUTES,
  ...SETTLEMENT_ROUTES,
  ...EXPENSE_LEDGER_ROUTES,
  ...BALANCE_ROUTES,
  ...SPLITWISE_ROUTES,
  ...RECONCILIATION_ROUTES,
];

export interface Api {
  readonly routes: readonly ApiRoute[];
  handle(request: Request): Promise<Response>;
}

/**
 * Builds the API over its dependencies.
 *
 * Errors are caught here rather than in each handler, so every route maps failures the same
 * way and no handler can accidentally return a stack trace (`security-model.md`).
 */
export function createApi(deps: ApiDependencies): Api {
  return {
    routes: API_ROUTES,
    handle: async (request: Request): Promise<Response> => {
      try {
        const { pathname } = new URL(request.url);
        const segments = splitPath(pathname);

        // The first pattern that matches **owns** the path; the routes sharing that pattern
        // are its methods. Without that, a GET of `/api/evidence/files` would fall past the
        // POST it belongs to and into `/api/evidence/:evidenceId`, which would then complain
        // that "files" is not a UUID — a 400 about an id the caller never sent, for what is
        // plainly a wrong verb on a known path.
        const matches = API_ROUTES.map((route) => ({
          route,
          params: matchPath(splitPath(route.path), segments),
        })).filter(
          (match): match is { route: ApiRoute; params: RouteParams } => match.params !== null,
        );

        const owner = matches[0]?.route.path;
        const match = matches.find(
          (candidate) =>
            candidate.route.path === owner && candidate.route.method === request.method,
        );
        if (match !== undefined) {
          return await match.route.handler(deps, request, match.params);
        }

        // A known path with the wrong verb is a different mistake from an unknown path, and
        // saying so is the difference between a usable API and a guessing game.
        return owner !== undefined
          ? jsonResponse(405, {
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: `${request.method} is not allowed here.`,
              },
            })
          : jsonResponse(404, {
              error: { code: 'NOT_FOUND', message: `No route for ${pathname}.` },
            });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  };
}

/* ------------------------------------------------------------------------- internals */

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** Returns the captured params, or `null` when this route does not match. */
function matchPath(pattern: string[], actual: string[]): RouteParams | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    const segment = actual[i]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(segment);
      continue;
    }
    if (expected !== segment) return null;
  }
  return params;
}
