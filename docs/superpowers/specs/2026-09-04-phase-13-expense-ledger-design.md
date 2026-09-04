# Phase 13 — Expense ledger

**Status:** design + delivery plan for the phase being implemented.
**Date:** 2026-09-04
**Roadmap phase:** 13, following phase 12 (beneficiary allocation, PR #21, merged as `f20eb05`).

## What this phase actually delivers — confirming, not re-deriving, phase 12's own warning

`docs/roadmap.md`'s "Recommended next phase" section already named the likely gap before this
phase started — written by phase 12's own ADR-0038, which explicitly deferred `getBalance`/
`runReconciliation` exposure here rather than building it early. That note said, in full: check
`src/services/balance-service.ts` and grep `src/api/` for `getBalance` before assuming phase 13
starts from zero, and confirm — rather than assume — that there is no `db.repositories.ts`
listing query and no service for reading back approved expenses as a ledger view.

Both checks were done before writing this spec:

- **`services.getBalance`** (`src/services/balance-service.ts:67-96`) — pairwise `Balance`
  between any two people, in either direction (ADR-0006), including
  `ObligationEvidenceStatus` (`domain-model.md`'s "confirmed vs. believed-settled" distinction,
  computed inline via `obligationEvidenceStatus`). **Complete**, from the 2026-08-14
  foundation pass, covered by `tests/scenarios/spend-and-allocation.test.ts` and
  `adjustments-settlements-and-exclusions.test.ts`. `git grep getBalance src/api` returns
  nothing — no caller.
- **`services.runReconciliation`** — also complete, also uncalled from `src/api`, but
  `roadmap.md` and ADR-0038 both assign its exposure to phase 15, not 13. Left untouched.
- **No expense-ledger read exists.** `src/services/expense-service.ts` exports only
  `transitionExpense`/`approveExpense`/`assertAmountChangeAllowed` — all mutations. `getExpenseById`
  (`db/repositories.ts:173`) reads a single row (and not even `description`/`category`). There is
  no `db.repositories.ts` listing query over `expenses` at all, and no service to call it.

**What is actually missing, confirmed before implementation:**

1. **`GET /api/balances/:personAId/:personBId`** — the phase-13 half that was already fully
   built and only needed a route.
2. **A genuinely new expense-ledger read**: a `db.repositories.ts` listing query
   (`listExpenses`, filterable by `state`/`paidByPersonId`/`limit`), a thin
   `expense-ledger-service.ts` (`src/api` must depend on `src/services`, never `src/db`,
   directly — `system-architecture.md`, Layering), and `GET /api/expenses`.

This matches `roadmap.md`'s own phase-13 description verbatim: "Querying/reporting over
approved expenses; pairwise `Balance` computation (ADR-0006)." Nothing else in that description
is unaccounted for.

**Explicitly out of scope, confirmed by direct evidence, not roadmap wording alone:**

- `runReconciliation` API exposure — phase 15 (`roadmap.md`, `src/api/README.md`, ADR-0038).
- `ai.suggestBeneficiaries`/`ai.suggestAllocation` — deferred by ADR-0038, unrelated to this
  phase.
- Any migration — no schema gap; `expenses`, `expense_adjustments` already carry every column
  needed. `netAmount` is derived, never stored (`domain-model.md`, `Expense`).
- Any UI — no framework installed (ADR-0032), and none of this phase's actual gap needs one.
- Date-range / cursor pagination on the ledger listing — not named by the roadmap's phase-13
  description, and nothing downstream needs it yet. `limit` (bounded, newest-first) is enough
  for the vertical slice; a future phase can add range filtering against a real need rather than
  a speculative one.

## The read path this phase adds

```
GET /api/expenses?state=&paidBy=&limit=
   │
   └─ services.listExpenses ─▶ db.listExpenses
        │                        ├─ selects matching `expenses` rows, newest first
        │                        └─ batches their ExpenseAdjustment amounts and calls
        │                           domain.netAmount per row — the same "gather inputs, let
        │                           domain subtract" split `loadReconciliationInput` already
        │                           uses for the identical figure (never a second
        │                           implementation of the subtraction, invariants.md #6/#8)

GET /api/balances/:personAId/:personBId
   │
   └─ services.requireUserPersonId  (already exists, loaders.ts — resolves "the user" the same
   │                                 way classification-service.ts already does)
   └─ services.getBalance           (already exists, unchanged)
```

## Scope decisions

Determined from the code, per the task's standing instruction not to trust `roadmap.md`'s
phase-13 wording without checking, and not to ask before executing once the gap is confirmed:

1. **`netAmount` computation lives in `db.listExpenses`, not in the service.** Mirrors
   `loadReconciliationInput` (`repositories.ts:1677-1719`) exactly: gross amounts and
   `ExpenseAdjustment` amounts are batch-selected (avoiding N+1 across a whole listing), grouped
   by expense id, and handed to `domain.netAmount` row by row. `expense-ledger-service.ts` is a
   thin pass-through preserving `src/api → src/services → src/db` layering
   (`system-architecture.md`).
2. **No forced default `state` filter.** The roadmap phrase "approved expenses" describes the
   typical use, not a hard requirement — `state` is one of `EXPENSE_STATES` when given, and
   omitted entirely returns every state. A hidden default would surprise a caller who explicitly
   wants to see `rejected` or `proposed` rows.
3. **`limit` is optional with a bounded default (200), no offset/cursor pagination.** The
   existing `listReviewQueue` precedent (`optionalPositiveInteger`, no clamp) has no built-in
   cap because a review queue is small by construction; a ledger listing is not, so this phase
   adds one default cap to avoid an unbounded query — the smallest safe behavior, not a paging
   API nobody asked for yet.
4. **`getBalance`'s `userPersonId` is resolved via `services.requireUserPersonId`, not accepted
   as a request parameter.** It already exists (`loaders.ts:542-552`) for exactly this purpose
   and is the established pattern (`classification-service.ts:533`) — "the user" is a fact about
   this ledger's single `User` row, not something a caller should be trusted to assert over
   HTTP.

## Testing plan

- `tests/integration/expense-ledger.test.ts` — service-level: filtering by `state` and
  `paidByPersonId`, `netAmount` reflecting recorded `ExpenseAdjustment`s, ordering (newest
  `occurredAt` first, tie-broken by id), the `limit` default and an explicit override, an empty
  ledger.
- `tests/integration/ledger-api.test.ts` — HTTP-level: `GET /api/expenses` (default, filtered,
  limited, an invalid `state`/`paidBy` value each refused as 400) and
  `GET /api/balances/:personAId/:personBId` (a real balance, the same pair reversed, an
  unknown/malformed id refused). `getBalance`'s own arithmetic is not re-tested here — it is
  already covered by the scenario suite; this file only proves the HTTP wiring.
- No new `src/domain` tests: no new domain logic was written this phase (`domain.netAmount`
  is reused unchanged).
