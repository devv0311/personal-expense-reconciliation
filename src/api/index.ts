/**
 * `src/api` — the thin HTTP layer.
 *
 * Handlers are Web `Request → Response` functions, which is precisely a Next.js App Router
 * route handler's signature: when the UI phase arrives, mounting these is a re-export, not a
 * rewrite, and no framework is installed to serve four routes in the meantime (ADR-0032).
 *
 * Depends on `src/services`. No business logic, no database access, no AI call — see
 * `src/api/README.md`.
 */

export * from './http.js';
export * from './review-routes.js';
export * from './router.js';
