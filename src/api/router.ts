/**
 * A path dispatcher, so the API can be exercised — by tests now, by a server later — without a
 * framework in between.
 *
 * The handlers are the real product here; this is the smallest thing that turns a set of them
 * into something you can send a `Request` to. Next.js does this job from the filesystem when
 * the UI phase arrives, at which point each route becomes a one-line re-export and this file
 * stops being on the path (ADR-0032).
 *
 * Matching is exact-segment with `:name` captures, first match wins. No wildcards, no regex
 * routes, no scoring — a route table this small does not need them, and every one of those
 * features is a way for two routes to disagree about who owns a path. The one ordering rule it
 * does have is written down at `API_ROUTES`.
 */

import type { AiService, Database, EvidenceStore } from '../services/index.js';

import {
  getEvidenceContent,
  getEvidenceMetadata,
  postEvidenceFile,
  postEvidenceLink,
  postEvidenceNote,
} from './evidence-routes.js';
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
  /** Where documents live, which is deliberately not the database (`security-model.md`). */
  readonly evidenceStore: EvidenceStore;
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
  { method: 'GET', path: '/api/evidence/:evidenceId', handler: getEvidenceMetadata },
  { method: 'GET', path: '/api/evidence/:evidenceId/content', handler: getEvidenceContent },
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
export const API_ROUTES: readonly ApiRoute[] = [...REVIEW_ROUTES, ...EVIDENCE_ROUTES];

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
