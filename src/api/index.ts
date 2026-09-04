/**
 * `src/api` — the thin HTTP layer.
 *
 * Handlers are Web `Request → Response` functions, which is precisely a Next.js App Router
 * route handler's signature: when the UI phase arrives, mounting these is a re-export, not a
 * rewrite, and no framework is installed to serve nine routes in the meantime (ADR-0032).
 *
 * Depends on `src/services`. No business logic, no database access, no AI call — see
 * `src/api/README.md`.
 */

export * from './adjustment-routes.js';
export * from './allocation-routes.js';
export * from './balance-routes.js';
export * from './evidence-routes.js';
export * from './expense-item-routes.js';
export * from './expense-ledger-routes.js';
export * from './http.js';
export * from './people-routes.js';
export * from './receipt-routes.js';
export * from './reconciliation-routes.js';
export * from './review-routes.js';
export * from './router.js';
export * from './settlement-routes.js';
export * from './splitwise-routes.js';
