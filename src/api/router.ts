/**
 * A path dispatcher, so the review surface can be exercised — by tests now, by a server later
 * — without a framework in between.
 *
 * The handlers are the real product here; this is the smallest thing that turns a set of them
 * into something you can send a `Request` to. Next.js does this job from the filesystem when
 * the UI phase arrives, at which point each route becomes a one-line re-export and this file
 * stops being on the path (ADR-0032).
 *
 * Matching is exact-segment with `:name` captures. No wildcards, no regex routes, no
 * precedence rules — a route table this small does not need them, and every one of those
 * features is a way for two routes to disagree about who owns a path.
 */

import type { AiService } from '../ai/index.js';
import type { Database } from '../db/index.js';

import { jsonResponse, toErrorResponse } from './http.js';
import {
  getReviewQueue,
  postInferenceDecision,
  postPaymentDuplicateDecision,
  postPaymentReclassification,
} from './review-routes.js';

/** What the handlers need. Injected, so nothing in `src/api` reaches for a connection. */
export interface ApiDependencies {
  readonly db: Database;
  /** Used by re-classification only; every other route is a read or a decision. */
  readonly ai: AiService;
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

export interface ReviewApi {
  readonly routes: readonly ApiRoute[];
  handle(request: Request): Promise<Response>;
}

/**
 * Builds the review API over its dependencies.
 *
 * Errors are caught here rather than in each handler, so every route maps failures the same
 * way and no handler can accidentally return a stack trace (`security-model.md`).
 */
export function createReviewApi(deps: ApiDependencies): ReviewApi {
  return {
    routes: REVIEW_ROUTES,
    handle: async (request: Request): Promise<Response> => {
      try {
        const { pathname } = new URL(request.url);
        const segments = splitPath(pathname);

        let pathMatched = false;
        for (const route of REVIEW_ROUTES) {
          const params = matchPath(splitPath(route.path), segments);
          if (params === null) continue;
          pathMatched = true;
          if (route.method !== request.method) continue;
          return await route.handler(deps, request, params);
        }

        // A known path with the wrong verb is a different mistake from an unknown path, and
        // saying so is the difference between a usable API and a guessing game.
        return pathMatched
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
