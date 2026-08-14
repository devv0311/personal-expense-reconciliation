# src/integrations/splitwise

Adapter to the external Splitwise API. See `docs/product/overview.md` (Splitwise section) and
`docs/domain/domain-model.md` (`ExternalIntegration`, `SplitwiseExpense`, `SplitwiseSettlement`).

**Owns:** authenticating against Splitwise (via a configured `ExternalIntegration`), creating
Splitwise expenses from already-`APPROVED`+`ALLOCATED` local expenses (producing a
`SplitwiseExpense`, always built from `AllocationLineGroupExpansion` rows — never from a raw
`group`-typed allocation line, ADR-0009), recording Splitwise payments from local `Settlement`
rows (producing a `SplitwiseSettlement` — a `Settlement` never becomes a `SplitwiseExpense`,
ADR-0007), and fetching Splitwise balances for reconciliation.

**Depends on:** `src/domain` types only; called from `src/services`, never calls back into
`src/services` or `src/db` itself.

**Rule:** never called from `src/ai`. Never creates a Splitwise expense or Splitwise payment
except via `src/services`, and only from data that has already passed the approval gate
(`docs/domain/invariants.md` #19) — for expenses, only once every `group`-typed allocation line
has an `AllocationLineGroupExpansion` (`docs/architecture/data-flow.md` step 8); for settlements,
only from an already-recorded `Settlement`. Built and tested against Splitwise's sandbox/test
mode only until deliberately pointed at a real account — see `docs/security/security-model.md`.

Not yet implemented — see `docs/roadmap.md` phase 14.
