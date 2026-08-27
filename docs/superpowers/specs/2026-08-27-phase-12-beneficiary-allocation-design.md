# Phase 12 — Beneficiary allocation

**Status:** design + delivery plan for the phase being implemented.
**Date:** 2026-08-27
**Roadmap phase:** 12, following phase 11 (receipt item extraction, PR #20, merged as `58a24be`).

## What this phase actually delivers — a scope correction

`docs/roadmap.md` described phase 12 as "Not started," with `Allocation`/`AllocationLine`,
group expansion, `ExpenseAdjustment` and `Settlement` all listed as work to build. That
description is stale. Reading the actual code before starting this phase found:

- `services/allocation-service.ts` — `approveAllocation`, all six methods, group-line
  expansion via `domain.expandGroupAllocationLine`, sum validation against `domain.netAmount`,
  supersession, the `approved → allocated` transition. **Complete.**
- `services/adjustment-service.ts` — `recordExpenseAdjustment` and `distributeAdjustment`,
  including the Splitwise-staleness side effect (ADR-0008). **Complete.**
- `services/settlement-service.ts` — `recordSettlement` / `recordSettlementWithin`.
  **Complete**, and already has one caller: `decideInference`'s settlement path.
- `services/balance-service.ts` — `getBalance`, `runReconciliation`. **Complete.**
- `tests/scenarios/spend-and-allocation.test.ts` and
  `adjustments-settlements-and-exclusions.test.ts` — **2172 lines** of scenario-level
  integration tests already exercising all of the above against a real database.

All of it was built in the 2026-08-14 "deterministic foundation" pass, which cut across the
phase numbering deliberately (`roadmap.md`'s own implementation note says so) and has had **no
caller from `src/api`** since — the exact shape phase 11 found `receipts`/`receipt_items` in,
and phase 9 found the review-queue domain logic in.

**What is actually missing**, confirmed before writing this spec:

1. **No API surface.** `grep`ing `src/api/` for `approveAllocation`, `recordSettlement`,
   `recordExpenseAdjustment`, `distributeAdjustment` returns nothing. Every other completed
   phase (9, 10, 11) closed exactly this gap for its own layer; phase 12 closes it for
   allocation/adjustment/settlement.
2. **No `ExpenseItem` write path.** `db.repositories.ts` had a read (`listExpenseItems`, for
   item-based sum validation) but no insert — confirmed by grep. Item-based/quantity-based
   allocation, and `ExpenseItem.receipt_item_id` linkage back to phase 11's `ReceiptItem`, have
   no way to produce data to run against.

This was put to Dev directly before implementation started (see "Scope decisions" below), who
confirmed the corrected, smaller scope: **API surface + `ExpenseItem` write path**, deferring
`ai.suggestBeneficiaries`/`ai.suggestAllocation` (flagged in `ai-boundary.md` as arriving in
phase 12) the same way phase 11 deferred `ai.normalizeMerchant()`.

`getBalance`/`runReconciliation` are **not** exposed this phase either — `roadmap.md` assigns
them to phase 13 (expense ledger) and phase 15 (reconciliation) respectively, and nothing in
this phase's actual gap (no caller for allocation/adjustment/settlement) requires touching them.
Respecting that boundary, rather than exposing everything that happens to already have a
service function, is this phase's own "do not jump ahead" discipline.

## The pipeline this phase completes

```
Expense (approved)
   │
   ├─ services.recordExpenseItems  ─▶ domain.validateExpenseItemsSum (sum = gross, once)
   │                                ─▶ db.insertExpenseItems (+ per-item AuditEvent)
   │                                   optionally: item.receiptItemId → an existing ReceiptItem
   │
   ├─ services.approveAllocation   ─▶ domain.buildAllocationLines (all six methods)
   │                                ─▶ domain.expandGroupAllocationLine (group lines)
   │                                ─▶ db (Allocation + AllocationLines, versioned)
   │                                ─▶ expense: approved → allocated
   │
   ├─ services.recordExpenseAdjustment  ─▶ money came back, recorded, not yet distributed
   ├─ services.distributeAdjustment     ─▶ new Allocation version, Splitwise rows → stale
   │
   └─ services.recordSettlement    ─▶ Payment discharges an obligation, no Allocation involved
```

Everything left of the arrows above already existed. This phase adds `recordExpenseItems` and
wires the whole column into `src/api`.

## Scope decisions

### 1. `ExpenseItem` write path closes phase 11's deferred manual-entry question

Phase 11 deferred "manual (no-AI) receipt/item entry," reasoning that it was "closer to phase
12's `ExpenseItem` work." `services.recordExpenseItems` **is** that entry path: the caller
(a human, via the API, with no UI in this project yet per `CLAUDE.md`) supplies the final
description/amount/quantity for each item directly, optionally naming a `ReceiptItem` it derives
from. No AI is involved and none is needed — this was never an inference, only a place to type
numbers.

`domain-model.md`'s `ExpenseItem` invariant — "sum of `ExpenseItem.amount` for an expense must
equal `Expense.amount` (gross)" — means the whole set is written together, once, exactly the
way `services.extractReceipt` refuses a second extraction over the same evidence: a partial
itemization is not a smaller version of a valid state, it is a different, disallowed one.

### 2. `Settlement` gets a manual API path, distinct from its classification path

`recordSettlement` already has a caller — `decideInference`, for a payment the model proposed
as a settlement. This phase adds `POST /api/payments/:paymentId/settlements`, a **second**,
independent path: a human explicitly marking an already-imported payment as settling an
obligation, for a payment classification never flagged as one (classified as something else, or
never classified at all). Both paths write through the same `recordSettlementWithin`/
`recordSettlement` validation — no new rule, only a new caller.

## Delivery plan

Four slices, each independently green (`typecheck`, `lint`, `format:check`, `db:check`, `test`).
No new migration: `expense_items` was already migrated by the foundation pass; this phase is
its first writer.

| #   | Slice                | Delivers                                                                                          |
| --- | --------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `ExpenseItem` write path | `domain.validateExpenseItemsSum`, `db.insertExpenseItems`/`listExpenseItemsByExpense`/`getReceiptItemById`, `services.recordExpenseItems`/`getExpenseItems` |
| 2   | API surface            | Route handlers for items, allocation, adjustments (record + distribute), settlements             |
| 3   | Documentation           | Roadmap correction, module READMEs, one ADR recording the scope-boundary decisions above           |

## Definition of done

- `services.recordExpenseItems` writes a complete item set once, refusing a partial one
  (`EXPENSE_ITEMS_SUM_MISMATCH`) and a second call (`PRECONDITION_FAILED`).
- Every one of `approveAllocation`, `recordExpenseAdjustment`, `distributeAdjustment`,
  `recordSettlement`, `recordExpenseItems` is reachable over HTTP, following the existing
  route-handler shape (actor in the body, `ServiceError`/`DomainError` mapped by
  `toErrorResponse`).
- `npm run typecheck && npm run lint && npm run format:check && npm run db:check && npm test`
  all green on every slice.
