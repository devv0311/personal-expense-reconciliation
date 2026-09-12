/**
 * `src/integrations/balance-provider` — live bank and card balances (audit row 37, ADR-0054).
 *
 * A real adapter over a configured HTTPS JSON endpoint when credentials are present; a provider
 * that reports every read as **incomplete** when they are not. Never one that resolves empty
 * and complete: "we checked and there was nothing" is a different claim from "we could not
 * check", and only the second one is true of an unconfigured installation.
 *
 * Nothing here is authoritative. A reading is a second opinion about an account, compared
 * against the ledger's own arithmetic and never written into a reconciliation boundary.
 */

export * from './http-provider.js';
export * from './port.js';
export * from './unconfigured.js';
