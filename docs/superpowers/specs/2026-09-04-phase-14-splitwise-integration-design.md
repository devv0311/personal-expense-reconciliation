# Phase 14 — Splitwise integration

**Status:** design + delivery plan for the phase being implemented.
**Date:** 2026-09-04
**Roadmap phase:** 14, following phase 13 (expense ledger, PR #22, merged as `1ec5c59`).

## What already exists — confirmed before writing this spec

Unlike phases 12 and 13, where the real gap was "give an already-complete engine its first
caller," phase 14 is genuinely mixed: the **schema and vocabulary** predate this phase (the
2026-08-14 foundation pass), but the **integration itself does not exist at any layer above the
schema**.

Already complete, confirmed by direct inspection, not re-built:

- `external_integrations`, `splitwise_expenses`, `splitwise_settlements` tables — full columns,
  check constraints, and the `(external_integration_id, splitwise_expense_id)` /
  `(external_integration_id, splitwise_transaction_id)` unique indexes — all in
  `drizzle/0000_initial_financial_schema.sql`. **No new migration this phase.**
- `EXTERNAL_INTEGRATION_TYPES`/`STATUSES`, `SPLITWISE_EXPENSE_SYNC_STATUSES`,
  `SPLITWISE_SETTLEMENT_SYNC_STATUSES` (`domain/enums.ts`) and the branded ids
  (`ExternalIntegrationId`, `SplitwiseExpenseId`, `SplitwiseSettlementId`, `domain/ids.ts`).
- `db.markSplitwiseExpenseStale` (`repositories.ts`), already wired into
  `adjustment-service.ts`'s `distributeAdjustment` — an already-synced `SplitwiseExpense` moves
  to `stale` the moment our own side changes post-sync.
- `people.splitwise_user_id` (nullable) — the person-to-Splitwise-account mapping a payload
  needs.
- `src/integrations/splitwise/README.md` — a full port contract already written down:
  `createExpense`, `recordPayment`, `fetchBalances`; group lines always read through
  `AllocationLineGroupExpansion`; sandbox-only.

Genuinely missing, confirmed by `grep`ing `src/services/`, `src/api/`, and
`src/integrations/splitwise/` (which holds only that README, no `.ts` file at all):

1. **The port itself** — no `SplitwisePort` interface, no adapter of any kind.
2. **Every repository write/read the two junction tables and `external_integrations` need** —
   only `markSplitwiseExpenseStale` exists; nothing inserts a row into any of the three tables,
   and nothing reads `people.splitwise_user_id` back out.
3. **The sync-payload builder and the service that calls the port** — no
   `proposeSplitwiseSync`/equivalent anywhere.
4. **Every route** — no `/api/...splitwise...` path, and no HTTP path to the
   `allocated → ready_to_sync` transition either (`services.transitionExpense` has had zero
   `src/api` callers since it was built).
5. **Behavioral test coverage of sync** — existing tests only assert an expense is _eligible_
   for sync (the lifecycle gate), never that anything actually syncs.

## Scope decisions

Six decisions, each made before writing code and recorded here so a later session does not
re-litigate them from scratch:

1. **No real adapter is built.** `src/integrations/splitwise/` gets the port interface and
   nothing else — the identical shape ADR-0025 chose for `ModelTransport` ("the model transport
   is injected; phase 8 wires no provider"). `.env.example`'s blank `SPLITWISE_CLIENT_ID`/
   `SPLITWISE_CLIENT_SECRET` and the absence of any Splitwise SDK in `package.json` both confirm
   nothing was meant to be wired yet. Tests inject a scripted mock port
   (`tests/support/splitwise.ts`), mirroring `tests/support/ai.ts`.
2. **Propose and confirm collapse into one atomic action**, not two HTTP round trips. Every
   consequential write this codebase already ships (`postAllocation`, `postExpenseAdjustment`,
   `postSettlement`) is a single POST that performs the action and returns the full result — the
   two-step accept/modify/reject shape is specific to `decideInference`'s AI-proposal review
   queue, and data-flow.md's own step 8 note is explicit that "no AI call is on this path at
   all." `services.syncExpenseToSplitwise`/`syncSettlementToSplitwise` build the payload and
   call the port within the same call the human/API-caller triggers; a
   `GET .../splitwise-sync-proposal` preview route is not built, matching the "compute fresh on
   every read, never a separate stored proposal" precedent `receipt-service.ts`'s `getReceipt`
   already established for a comparably shaped preview.
3. **`allocated → ready_to_sync` gets its first HTTP caller this phase.** It has had zero
   callers from `src/api` since it was built (phase 9 era), but it is the sole precondition for
   the surface this phase adds and named by nothing else — without it, the sync routes this
   phase builds would be unreachable end-to-end over HTTP. `services.transitionExpense` is
   reused completely unchanged; no new lifecycle logic is written.
4. **Re-sync of a `stale` `SplitwiseExpense` (amount update, or deletion at net-zero
   `netAmount`) is deferred.** `domain-model.md` specifies what that re-sync _should_ do once it
   exists, but doing it requires `updateExpense`/`deleteExpense` port methods this phase does
   not add, and `markSplitwiseExpenseStale` already correctly marks the state for whichever
   future phase closes that loop — nothing in this phase's actual gap (the first sync,
   end-to-end) requires it. Symmetric with how ADR-0038 deferred `ai.suggestBeneficiaries` and
   ADR-0039 deferred `runReconciliation` exposure: a real, named, adjacent capability, not a
   silent scope cut.
5. **`fetchBalances`/drift detection is not built.** `data-flow.md` step 9 assigns it to
   `services.runReconciliation` (phase 15) explicitly; the port interface omits the method
   entirely rather than adding an unused stub.
6. **A new `ServiceError` code, `SPLITWISE_SYNC_FAILED` (→ 502).** The port throwing must not
   leave a partial `SplitwiseExpense`/`SplitwiseSettlement` row — both tables' `splitwise_*_id`
   and `synced_at` columns are `NOT NULL`, so a row can only be inserted **after** the port
   already returned an external id; a failed call therefore writes nothing at all, and the
   expense stays `ready_to_sync` (never transitioned), making a retry just "call the route
   again." The new code exists so that failure is distinguishable at the HTTP boundary from
   every other precondition failure, the same way `EVIDENCE_STORE_UNAVAILABLE` already is for
   the document store.

## The pipeline this phase adds

```
POST /api/integrations/splitwise/connect
   └─ services.connectSplitwiseIntegration ─▶ db.insertExternalIntegration

POST /api/expenses/:expenseId/ready-to-sync
   └─ services.transitionExpense (existing, unchanged) — approved/allocated → ready_to_sync

POST /api/expenses/:expenseId/splitwise-sync
   └─ services.syncExpenseToSplitwise
        ├─ requires expense.state === 'ready_to_sync' (domain-model.md's SplitwiseExpense
        │  Lifecycle) and no existing SplitwiseExpense row for it (duplicate-sync guard)
        ├─ loaders.resolveAllocationShares — the SAME group-expansion resolution
        │  expense-service.ts's assertReadyToSync already uses, extracted so it is never
        │  re-implemented a second time; a group line always reads its
        │  AllocationLineGroupExpansion rows, never the raw line (invariant #19, ADR-0009)
        ├─ every payer/beneficiary must carry people.splitwise_user_id, or the sync refuses
        │  with a precondition failure naming who is unlinked
        ├─ integrations.splitwise.createExpense(payload) — the injected port
        ├─ db.insertSplitwiseExpense (only reachable once the port already returned an id)
        └─ updateExpenseState → synced (domain.assertExpenseTransition, reused, not duplicated)

POST /api/settlements/:settlementId/splitwise-sync
   └─ services.syncSettlementToSplitwise
        ├─ requires no existing SplitwiseSettlement row for this settlement
        ├─ domain.settlementParties (existing, unchanged) resolves from/to from the
        │  Settlement's linked Payment direction — never re-derived
        ├─ integrations.splitwise.recordPayment(payload)
        └─ db.insertSplitwiseSettlement
```

## Testing plan

- `tests/integration/splitwise-sync.test.ts` — service-level: connecting an integration,
  syncing an equal-split expense, syncing a **group**-beneficiary expense and asserting the
  payload/`our_snapshot` contains only expanded individual shares (never a group id), the
  missing-`splitwise_user_id` refusal, the duplicate-sync refusal for both expense and
  settlement, a `ready_to_sync` precondition refusal, a settlement sync in each payment
  direction (proving `fromPersonId`/`toPersonId` come out right both ways), and a port failure
  leaving no row behind and the expense still `ready_to_sync` (the retry guarantee).
- `tests/integration/splitwise-api.test.ts` — HTTP-level: the four routes, malformed-id 400s,
  the route table, and `review-api.test.ts`'s master route-table assertion extended.
- No new `src/domain` tests: no new domain logic this phase (`domain.assertExpenseTransition`,
  `domain.settlementParties` are reused unchanged).

## What remains for Phase 15

- `services.runReconciliation`'s API exposure (already deferred by ADR-0039).
- `integrations.splitwise.fetchBalances()` and drift detection — the `drifted` sync-status has
  no writer until this exists.
- Re-sync of a `stale` `SplitwiseExpense` (deferred by this phase, decision 4 above) is a
  reasonable candidate to fold into phase 15 alongside drift handling, since both are
  "reconciliation noticed something changed" flows, but that is phase 15's call to make.
