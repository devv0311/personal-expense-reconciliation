# 0038. Phase 12 is an API surface and an ExpenseItem write path, not a new allocation engine

**Status:** Accepted

## Context

`docs/roadmap.md` described phase 12 ("Beneficiary allocation") as "Not started," listing the
`Allocation`/`AllocationLine` write path, group expansion, `ExpenseAdjustment` recording/
distribution and `Settlement` recording as work still to build.

Before starting implementation, reading the actual code found that description stale:
`services/allocation-service.ts` (`approveAllocation`, all six methods, group-line expansion),
`services/adjustment-service.ts` (`recordExpenseAdjustment`, `distributeAdjustment`),
`services/settlement-service.ts` (`recordSettlement`) and `services/balance-service.ts`
(`getBalance`, `runReconciliation`) all already existed, complete, from the 2026-08-14
"deterministic foundation" pass — and were covered by 2172 lines of scenario-level integration
tests (`tests/scenarios/spend-and-allocation.test.ts`,
`adjustments-settlements-and-exclusions.test.ts`). None of it had a caller from `src/api`, and
`db.repositories.ts` had no insert path for `ExpenseItem` at all — only a read used internally
by `approveAllocation`'s item-based sum validation.

This mirrors what phases 9, 10 and 11 each found and closed for their own layer: domain/service
logic built ahead of its caller by the foundation pass, waiting for the phase that gives it one.

## Decision

**Phase 12's actual scope is an API surface plus one new write path**, confirmed with Dev
directly once the stale roadmap description was caught (rather than either re-building
already-complete code or silently narrowing scope without saying so):

1. **`services.recordExpenseItems`** — the one genuinely new piece. Writes an expense's
   complete item breakdown once, enforcing `domain-model.md`'s `ExpenseItem` invariant (items
   must sum to exactly the expense's gross amount — no partial itemization) via
   `domain.validateExpenseItemsSum`. This also closes phase 11's deferred "manual (no-AI)
   receipt/item entry": the caller supplies final description/amount/quantity directly,
   optionally naming the `ReceiptItem` an item derives from, which was never an inference to
   begin with.
2. **Six route handlers** wiring the existing services to HTTP: items (record + read),
   allocation approval, adjustment record + distribute, and settlement.
3. **A second, independent path to `recordSettlement`.** It already had one caller
   (`decideInference`, for a payment the model proposed as a settlement); this phase adds
   `POST /api/payments/:paymentId/settlements` for a human explicitly settling a payment
   classification never flagged, or never ran on. Same validation either way — no new rule.

**Deferred, explicitly:**

- `ai.suggestBeneficiaries`/`ai.suggestAllocation` — `ai-boundary.md` flagged these as arriving
  in phase 12, but building them is a second gated AI operation pair with its own decision
  shape, not an extension of "wire an existing write path to HTTP." Deferred the same way phase
  11 deferred `ai.normalizeMerchant()` (ADR-0036).
- `getBalance`/`runReconciliation` API exposure. `roadmap.md` assigns these to phase 13
  (expense ledger) and phase 15 (reconciliation) respectively, and nothing in this phase's
  actual gap requires touching either. Exposing them here because the service function happens
  to already exist would be jumping ahead of `CLAUDE.md`'s own phase-ordering discipline in the
  other direction — building the _later_ phase's surface early, rather than building the
  current one's from scratch.

## Consequences

- No new financial logic was written in `src/domain` for allocation, adjustment or settlement —
  only for `ExpenseItem`. The risk profile of this phase is therefore mostly in the API
  boundary (request validation, error mapping), not in new arithmetic.
- `roadmap.md`'s phase 12 status and "Recommended next phase" section needed correcting in the
  same pass, per `CLAUDE.md`'s "correct a document that turns out to be wrong" instruction —
  done alongside this ADR.
- A future reader checking "is allocation built yet?" against `roadmap.md` before this phase
  would have been told no, incorrectly, for however long the stale entry had stood. Reading the
  code before trusting the roadmap description is the concrete habit this incident argues for.

## Alternatives considered

1. **Re-implement the allocation/adjustment/settlement write paths from scratch**, following
   `roadmap.md`'s literal description without checking the existing code first. Rejected once
   the existing implementation was found — it would have produced a second, competing
   implementation of already-correct, already-tested logic, doubling maintenance surface for no
   benefit.
2. **Silently treat the smaller scope as "the whole phase" without flagging it.** Rejected:
   the user authorized "the entire phase" under the roadmap's (stale) description of what that
   meant, and delivering a materially smaller phase without saying why would misrepresent what
   was actually built and skip a decision that was genuinely theirs to make (defer or build the
   AI suggestion operations, given the freed-up scope).
3. **Expose `getBalance`/`runReconciliation` anyway**, since the code is already there and
   "more surface" seems strictly additive. Rejected: it would pre-empt phase 13/15's own design
   decisions about what that surface should look like (query parameters, response shape,
   whether reconciliation runs are triggered by a route at all vs. a scheduled job), decided by
   whoever scopes those phases, not as a side effect of phase 12's own work.
