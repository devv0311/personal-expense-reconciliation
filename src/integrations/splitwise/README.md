# src/integrations/splitwise

The port to the external Splitwise API. See `docs/product/overview.md` (Splitwise section) and
`docs/domain/domain-model.md` (`ExternalIntegration`, `SplitwiseExpense`, `SplitwiseSettlement`).

**Owns:** `port.ts`'s `SplitwisePort` interface — `createExpense`, `recordPayment`,
`fetchBalances` (phase 15, ADR-0041). No concrete adapter is shipped (ADR-0025's "model
transport is injected, no provider wired" precedent): no Splitwise credentials exist in this
repository, and `CLAUDE.md` forbids connecting a real account during development.
`services.syncExpenseToSplitwise`/`syncSettlementToSplitwise` (phase 14, ADR-0040) build the
payload from an already-`APPROVED` `Expense`/`Settlement` — always from
`AllocationLineGroupExpansion` rows for a `group`-typed line, never the raw line (ADR-0009) —
and call this port. `fetchBalances` is read-only, called by `services.runReconciliation`
(phase 15): one entry per Splitwise friend of the connected account, scoped to that account
because that's what Splitwise's real "get friends" call actually returns. A failure there is
non-fatal to its caller — surfaced as a discrepancy, not a thrown request failure the caller
must special-case. `tests/support/splitwise.ts` provides the in-memory mock every test injects.

**Depends on:** `src/domain` types only; called from `src/services`, never calls back into
`src/services` or `src/db` itself.

**Rule:** never called from `src/ai`. Never creates a Splitwise expense or Splitwise payment
except via `src/services`, and only from data that has already passed the approval gate
(`docs/domain/invariants.md` #19) — for expenses, only once every `group`-typed allocation line
has an `AllocationLineGroupExpansion` (`docs/architecture/data-flow.md` step 8); for settlements,
only from an already-recorded `Settlement`. Built and tested against a mock only until
deliberately pointed at a real Splitwise account — see `docs/security/security-model.md`.

**Not yet implemented:** any concrete adapter, and a write path back to Splitwise for a `stale`
expense (an amount update or a deletion) — see `docs/roadmap.md` phase 15's implementation note.
