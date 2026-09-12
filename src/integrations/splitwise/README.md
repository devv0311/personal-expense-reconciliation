# src/integrations/splitwise

The port to the external Splitwise API. See `docs/product/overview.md` (Splitwise section) and
`docs/domain/domain-model.md` (`ExternalIntegration`, `SplitwiseExpense`, `SplitwiseSettlement`).

**Owns:** `port.ts`'s `SplitwisePort` interface — `createExpense`, `recordPayment`,
`fetchBalances` (phase 15, ADR-0041), the optional `fetchLedgerEntries` (ADR-0046) and the
optional repair writes `updateExpense`/`deleteEntry`/`updatePayment` (ADR-0055) — plus
`adapter.ts`, a dependency-free implementation over Splitwise's v3 REST API. The adapter is
**injected, never imported** by a caller, and `server.ts` supplies it only when
`SPLITWISE_API_KEY` and `SPLITWISE_USER_ID` are both set; otherwise every method rejects with a
message saying so. No Splitwise credentials exist in this repository, and `CLAUDE.md` forbids
connecting a real account during development.
`services.syncExpenseToSplitwise`/`syncSettlementToSplitwise` (phase 14, ADR-0040) build the
payload from an already-`APPROVED` `Expense`/`Settlement` — always from
`AllocationLineGroupExpansion` rows for a `group`-typed line, never the raw line (ADR-0009) —
and call this port. `fetchBalances` is read-only, called by `services.runReconciliation`
(phase 15): one entry per Splitwise friend of the connected account, scoped to that account
because that's what Splitwise's real "get friends" call actually returns. A failure there is
non-fatal to its caller — surfaced as a discrepancy, not a thrown request failure the caller
must special-case. `fetchLedgerEntries` (phase 19, ADR-0046) is the finer read beside it, and is
**optional on the interface by design**: it is the read that lets `services.runSplitwiseAudit`
name a specific external record as the cause of drift, and an adapter that cannot list a pair's
entries omits it so the audit records `unsupported` rather than mistaking a missing capability
for a Splitwise holding nothing. Each entry carries a `pairNetBalance` — its own contribution to
the pair balance, in `fetchBalances`' sign convention — so a listing that claims to be complete
can be checked against the balance Splitwise itself reported, and downgraded to `partial` when
it does not add up. `tests/support/splitwise.ts` provides the in-memory mock every test injects,
plus `createAggregateOnlySplitwisePort` for the no-`fetchLedgerEntries` case and
`createFirstSyncOnlySplitwisePort` for the no-repair-writes case.

`updateExpense`, `deleteEntry` and `updatePayment` (ADR-0055) are the write half of the same
idea and optional for the same reason. A correction goes to the id this ledger already recorded
and that id must come back unchanged — an answer carrying a new one is refused as a duplicate
rather than recorded as a correction. An adapter without them makes
`services.resyncExpenseToSplitwise` refuse **by name**; it never falls back to `createExpense`,
which is what the first version of the repair did and what left the counterparty holding two
records for one expense. `deleteEntry` exists for exactly one case — an expense whose net has
reached zero, which Splitwise cannot hold — and never to make an audit come out clean.

**Depends on:** `src/domain` types only; called from `src/services`, never calls back into
`src/services` or `src/db` itself.

**Rule:** never called from `src/ai`. Never creates a Splitwise expense or Splitwise payment
except via `src/services`, and only from data that has already passed the approval gate
(`docs/domain/invariants.md` #19) — for expenses, only once every `group`-typed allocation line
has an `AllocationLineGroupExpansion` (`docs/architecture/data-flow.md` step 8); for settlements,
only from an already-recorded `Settlement`. Built and tested against a mock only until
deliberately pointed at a real Splitwise account — see `docs/security/security-model.md`.

**Reading their side back (ADR-0056).** `fetchLedgerEntries` now has a second caller:
`services.discoverSplitwiseRemoteChanges` compares what Splitwise holds against the sync rows
and records the differences as **proposals**. Nothing about that path makes their number ours.
Accepting one records what they hold on the sync row, closes the row as `externally_deleted`,
joins an external entry to a local record a person names, or maps a Splitwise account to an
existing `Person` — and never writes an amount, an allocation or a balance. A deletion is only
ever reported from a `complete` listing, because an entry missing from a page is an entry
nobody looked for.

Reviewing an audit finding remains explicitly not authorization to write; the repair is still a
separate act a person asks for, one row at a time, with a written reason.

**Not implemented, deliberately:** a remote figure becoming a local one. Making Splitwise's
₹500 true in this ledger is a person recording an `ExpenseAdjustment` with evidence
(`CLAUDE.md`, principle 9; `invariants.md` #6).
