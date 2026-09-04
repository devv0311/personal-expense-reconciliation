# 0039. Phase 13 is `getBalance` exposure plus a new expense-ledger listing, not a new engine

**Status:** Accepted

## Context

`docs/roadmap.md` described phase 13 ("Expense ledger") as "Not started. Querying/reporting
over approved expenses; pairwise `Balance` computation (ADR-0006)." Phase 12's own ADR-0038
already warned this description might be partly stale in the same way phase 12's own
description was: it explicitly deferred `services.getBalance` exposure to this phase, noting
the service function already existed, complete, from the 2026-08-14 "deterministic foundation"
pass.

Before starting implementation, both halves of that warning were checked directly rather than
assumed:

- `src/services/balance-service.ts` (`getBalance`, `runReconciliation`) — both complete, both
  covered by `tests/scenarios/spend-and-allocation.test.ts` and
  `adjustments-settlements-and-exclusions.test.ts`. `git grep getBalance src/api` returns
  nothing — no caller from this layer.
- `src/services/expense-service.ts` — `transitionExpense`/`approveExpense`/
  `assertAmountChangeAllowed`, all mutations, none of them a read. `db.repositories.ts` has
  `getExpenseById` (single row, and a narrow one — no `description`/`category`) but no listing
  query over `expenses` at all.

This mirrors what phases 9–12 each found and closed for their own layer: domain/service logic
built ahead of its caller by the foundation pass, or — for the ledger listing specifically — a
read that was never built at all because nothing needed it before this phase.

## Decision

**Phase 13's actual scope is two pieces**, confirmed against the code before writing any:

1. **`GET /api/balances/:personAId/:personBId`** — wires the already-complete `getBalance` to
   HTTP. `userPersonId` is resolved via `services.requireUserPersonId` (already exists,
   `loaders.ts`, the same pattern `classification-service.ts` already uses), not accepted as a
   request parameter — "the user" is a fact this ledger already knows, not something a caller
   should assert.
2. **A genuinely new expense-ledger read**: `db.listExpenses` (filterable by `state`,
   `paidByPersonId`, and a bounded `limit`, newest-first), a thin
   `services/expense-ledger-service.ts` pass-through (`src/api` depends on `src/services`, never
   `src/db`, directly — `system-architecture.md`), and `GET /api/expenses`. `netAmount` per row
   is computed the same way `loadReconciliationInput` already computes it for the identical
   figure: gross amounts and `ExpenseAdjustment` amounts are batch-selected and handed to
   `domain.netAmount`, never re-subtracted in SQL or re-implemented in the service.

**Deferred, explicitly:**

- `runReconciliation` API exposure — `roadmap.md` and ADR-0038 both assign this to phase 15.
  Nothing in this phase's actual gap requires it, and exposing it here would be building a later
  phase's surface early merely because the service function happens to exist — the same
  over-reach ADR-0038 already declined for this exact function.
- Date-range/cursor pagination on the ledger listing. The roadmap's phase-13 description says
  "querying/reporting over approved expenses," not "a paginated report builder" — `state`,
  `paidByPersonId` and a bounded `limit` cover what was asked; a future phase can add range
  filtering against a real caller's need.
- A forced default `state` filter on the ledger listing. "Approved expenses" describes the
  typical read, not every read; a caller who wants `rejected` or `proposed` rows can ask for
  them explicitly, and a hidden default would silently exclude what they asked for.

## Consequences

- No new financial logic was written in `src/domain` this phase. `domain.netAmount` is reused
  exactly as `loadReconciliationInput` already calls it — the risk profile of this phase is in
  the new listing query and the HTTP boundary, not in new arithmetic.
- `roadmap.md`'s phase-13 status and "Recommended next phase" section are corrected in the same
  pass, per `CLAUDE.md`'s "correct a document that turns out to be wrong" instruction.
- A future reader checking "is the ledger listing built yet?" against `roadmap.md` before this
  phase would have been told "not started," which was accurate this time — unlike phase 12's
  stale entry, phase 13's roadmap description turned out to name a real, if partial, gap.

## Alternatives considered

1. **Re-verify `getBalance` from scratch by re-deriving its arithmetic in a new function.**
   Rejected immediately — the existing implementation is complete and already covered by 2172
   lines of scenario tests; re-deriving it would be a second, competing implementation of
   already-correct logic.
2. **Expose `runReconciliation` alongside `getBalance` anyway**, since both live in the same
   service file and "already built" applies to both. Rejected for the same reason ADR-0038
   declined to expose `getBalance` during phase 12: `roadmap.md` assigns it to phase 15, and
   nothing in this phase's actual gap touches reconciliation.
3. **Compute `netAmount` per expense with an N+1 query per row** (call
   `listAdjustmentAmounts`/`domain.netAmount` once per expense, as `requireExpenseSnapshot`
   already does for a single expense). Rejected for a listing: `loadReconciliationInput`
   already established the batched-select-then-map pattern for the identical computation over
   many expenses at once, and departing from it for no reason would just be a slower version of
   the same code.
4. **Add offset/cursor pagination to the ledger listing now.** Rejected as scope not requested
   by the roadmap's phase-13 wording or by any existing caller — a bounded `limit` is the
   smallest safe behavior for a listing that could otherwise return every expense ever recorded.
