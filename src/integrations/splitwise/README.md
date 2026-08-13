# src/integrations/splitwise

Adapter to the external Splitwise API. See `docs/product/overview.md` (Splitwise section) and
`docs/domain/domain-model.md` (`ExternalIntegration`, `SplitwiseExpense`).

**Owns:** authenticating against Splitwise (via a configured `ExternalIntegration`), creating
Splitwise expenses from already-`APPROVED`+`ALLOCATED` local expenses, and fetching Splitwise
balances for reconciliation.

**Depends on:** `src/domain` types only; called from `src/services`, never calls back into
`src/services` or `src/db` itself.

**Rule:** never called from `src/ai`. Never creates a Splitwise expense except via
`src/services`, and only from data that has already passed the approval gate
(`docs/domain/invariants.md` #19). Built and tested against Splitwise's sandbox/test mode only
until deliberately pointed at a real account — see `docs/security/security-model.md`.

Not yet implemented — see `docs/roadmap.md` phase 14.
