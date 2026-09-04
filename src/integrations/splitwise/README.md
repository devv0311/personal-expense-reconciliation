# src/integrations/splitwise

The port to the external Splitwise API. See `docs/product/overview.md` (Splitwise section) and
`docs/domain/domain-model.md` (`ExternalIntegration`, `SplitwiseExpense`, `SplitwiseSettlement`).

**Owns:** `port.ts`'s `SplitwisePort` interface — `createExpense`, `recordPayment`. No concrete
adapter is shipped (ADR-0025's "model transport is injected, no provider wired" precedent): no
Splitwise credentials exist in this repository, and `CLAUDE.md` forbids connecting a real
account during development. `services.syncExpenseToSplitwise`/`syncSettlementToSplitwise`
(phase 14, ADR-0040) build the payload from an already-`APPROVED` `Expense`/`Settlement` —
always from `AllocationLineGroupExpansion` rows for a `group`-typed line, never the raw line
(ADR-0009) — and call this port; `tests/support/splitwise.ts` provides the in-memory mock every
test injects.

**Depends on:** `src/domain` types only; called from `src/services`, never calls back into
`src/services` or `src/db` itself.

**Rule:** never called from `src/ai`. Never creates a Splitwise expense or Splitwise payment
except via `src/services`, and only from data that has already passed the approval gate
(`docs/domain/invariants.md` #19) — for expenses, only once every `group`-typed allocation line
has an `AllocationLineGroupExpansion` (`docs/architecture/data-flow.md` step 8); for settlements,
only from an already-recorded `Settlement`. Built and tested against a mock only until
deliberately pointed at a real Splitwise account — see `docs/security/security-model.md`.

**Not yet implemented:** `fetchBalances` (drift detection, phase 15, `data-flow.md` step 9) and
any concrete adapter — see `docs/roadmap.md` phase 15.
