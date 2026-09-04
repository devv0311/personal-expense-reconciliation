# 0040. Phase 14 delivers the first Splitwise sync, not the full sync lifecycle

**Status:** Accepted

## Context

`docs/roadmap.md` described phase 14 as: _"`ExternalIntegration` + `SplitwiseExpense` +
`SplitwiseSettlement` (ADR-0007), sandbox-only until deliberately switched to a real account.
Group-line expansion (ADR-0009) is enforced here as the only path into the sync payload
builder."_ Phases 12 and 13 both found their own roadmap descriptions stale in the same
direction — logic already built ahead of its caller. Phase 14 turned out stale in the
**opposite** direction: unlike `getBalance`/`approveAllocation`, no Splitwise-facing service or
integration code exists at all above the schema.

Confirmed by direct inspection before implementation (full detail in the design spec,
`docs/superpowers/specs/2026-09-04-phase-14-splitwise-integration-design.md`):

- **Already built** (2026-08-14 foundation pass): the three tables and their constraints, every
  relevant enum and branded id, `people.splitwise_user_id`, and
  `db.markSplitwiseExpenseStale` (already wired into `distributeAdjustment`).
- **Not built at all**: the port, every insert/read for the three tables except staleness,
  the sync-payload builder, every route — including a route for the
  `allocated → ready_to_sync` transition, which has had no `src/api` caller since it was built.

## Decision

Phase 14 delivers **one full sync, end to end, for the first time an `Expense` or `Settlement`
is pushed to Splitwise** — not the complete sync lifecycle a mature integration would have:

1. **`src/integrations/splitwise/port.ts`** — a `SplitwisePort` interface
   (`createExpense`, `recordPayment`) with no concrete adapter shipped, the identical shape
   ADR-0025 chose for `ModelTransport` ("the model transport is injected; phase 8 wires no
   provider"). `fetchBalances` is not in the interface at all — `data-flow.md` step 9 assigns it
   to phase 15's `runReconciliation`, and an unused stub method would just be surface nothing
   calls.
2. **The missing repository functions** for `external_integrations`, `splitwise_expenses`,
   `splitwise_settlements`, plus `getSettlementById` (needed to resolve a settlement's payment
   direction) and a widened `getPersonById`/`getPrimaryUserPerson` (adding
   `splitwise_user_id`/`users.id` to their existing selects, not new functions).
3. **`services/splitwise-service.ts`** — `connectSplitwiseIntegration`,
   `syncExpenseToSplitwise`, `syncSettlementToSplitwise`. Group-line resolution is extracted
   from `expense-service.ts`'s private `assertReadyToSync` helper into
   `loaders.resolveAllocationShares` so both call sites share one implementation rather than a
   second copy of the same `AllocationLineGroupExpansion` walk (invariant #19, ADR-0009).
4. **Four routes**: `POST /api/integrations/splitwise/connect`,
   `POST /api/expenses/:expenseId/ready-to-sync` (the first HTTP caller for
   `services.transitionExpense`, reused unchanged — not new lifecycle logic),
   `POST /api/expenses/:expenseId/splitwise-sync`, `POST /api/settlements/:settlementId/
splitwise-sync`.
5. **One new `ServiceError` code, `SPLITWISE_SYNC_FAILED` → 502**, mirroring
   `EVIDENCE_STORE_UNAVAILABLE`'s precedent for a failing external dependency.

**Deferred, explicitly:**

- **Re-sync of a `stale` `SplitwiseExpense`** — an amount update, or a deletion when
  `netAmount` reaches 0 (`domain-model.md`'s `SplitwiseExpense` Lifecycle spells out which).
  `markSplitwiseExpenseStale` already marks the state correctly; acting on it needs
  `updateExpense`/`deleteExpense` port methods this phase does not add.
- **`fetchBalances`/drift detection** — phase 15, per `data-flow.md` step 9.
- **A separate "propose" preview route.** `services.syncExpenseToSplitwise`/
  `syncSettlementToSplitwise` build the payload and call the port in one action, matching every
  other consequential write this codebase ships (`postAllocation`, `postExpenseAdjustment`,
  `postSettlement` are all single POSTs, not a stored-proposal-then-confirm pair) rather than
  inventing a new two-step shape nothing else uses. `decideInference`'s accept/modify/reject
  precedent is for an AI proposal specifically, and `data-flow.md` step 8 says plainly "no AI
  call is on this path at all."

## Consequences

- No new financial logic was written in `src/domain`. `domain.assertExpenseTransition` and
  `domain.settlementParties` are reused exactly as they already existed; the sync payload is
  data marshalling of already-computed, already-invariant-checked figures (`netAmount`,
  resolved shares), never a second computation of either.
- A `SplitwiseExpense`/`SplitwiseSettlement` row can only exist once the external write already
  succeeded, because `splitwise_expense_id`/`splitwise_transaction_id`/`synced_at` are all
  `NOT NULL` in the schema this phase did not touch — a failed sync therefore leaves nothing to
  clean up, and a retry is simply calling the route again.
- `roadmap.md`'s phase-14 status and "Recommended next phase" section are corrected in the same
  pass.
- The `stale`→re-sync gap this phase leaves open is a real, user-visible limitation once an
  already-synced expense is adjusted: the `SplitwiseExpense` row sits at `sync_status = stale`
  with no route to act on it yet. Documented here and in `roadmap.md` rather than silently
  left for someone to rediscover.
- **Discovered during implementation:** `audit_events_entity_type_check`
  (`drizzle/0000_initial_financial_schema.sql`) already includes `splitwise_expense`/
  `splitwise_settlement` but never `external_integration` — the foundation pass classified
  `ExternalIntegration` as SYSTEM configuration data, the same tier as `people`/`accounts`/
  `users`, none of which get an `AuditEvent` entity type either. `connectSplitwiseIntegration`
  therefore does not use `runAudited`; adding `external_integration` to the constraint to make
  it auditable would need a migration this phase's own scope decision (#2 above) already ruled
  out, and invariant #21's audit requirement is scoped to APPROVED/user-facing DERIVED data,
  which `ExternalIntegration` is not (`domain-model.md`: "Classification. SYSTEM.").

## Alternatives considered

1. **Build a full adapter against a real Splitwise sandbox account.** Rejected — `CLAUDE.md`
   forbids connecting real accounts/credentials during development, and no Splitwise SDK is
   installed. Mirrors ADR-0025's identical call for the model transport.
2. **A two-step propose/confirm HTTP flow**, matching `decideInference`'s shape. Rejected: every
   non-AI consequential write in this codebase is already a single POST, and `data-flow.md`
   explicitly says no AI proposal sits on this path, so there is nothing to review asynchronously
   the way an `AIInference` is reviewed.
3. **Build `updateExpense`/`deleteExpense` and the stale re-sync flow now**, since
   `markSplitwiseExpenseStale` already exists and "the pieces are right there." Rejected for the
   same reason ADR-0038/0039 declined similar temptations: it is a real, separately-scoped
   capability (acting on drift/staleness) adjacent to this phase's actual gap (the first sync),
   not required to deliver a complete, testable vertical slice on its own.
4. **Skip the `ready_to_sync` route and require tests/callers to reach it by calling
   `services.transitionExpense` directly**, leaving the sync routes unreachable end-to-end over
   HTTP. Rejected: it would ship a phase whose own headline feature cannot be exercised through
   the API surface the phase itself builds.
