# ADR-0018. Item-level refund attribution

**Status:** Accepted (2026-09-05); **fully implemented as of Phase 18 (2026-09-06).**
Phase 16 shipped the schema and validation — `expense_adjustment_items`,
`src/domain/refund-attribution.ts` and `services.recordExpenseAdjustment`'s attribution path,
including the row lock that makes 19.3's cumulative ceilings safe under concurrency. Phase 18
shipped the **allocation engine** — net item cost to superseding allocation to obligation —
as `src/domain/refund-allocation.ts` and `services.distributeAdjustment`'s item-attributed
path, with `services.getRefundAllocationState` as its read.
[ADR-0045](0045-item-refund-allocation-is-rebuilt-not-decremented.md) records how the engine
answers the three questions "Calculation semantics" below leaves to the implementation: the
rebuild-from-recorded-facts shape, the refusal to guess item ownership, and how a legacy
whole-expense reduction coexists with item attribution. No schema change was needed.

**Identity:** Cite this ADR by its full filename or as **ADR-0018 (item refunds)**.
The older [0018 manual-note decision](0018-manual-note-signal-ambiguity.md) remains accepted.
Invariant identifiers **19.1–19.6** are retained as requested; they belong to this ADR and
do not renumber the existing invariant #19 about Splitwise writes.

## Context

[ADR-0008](0008-refunds-and-reimbursements-as-adjustments.md) preserves gross purchase history
using `ExpenseAdjustment` and a superseding allocation. Whole-expense proportional distribution
cannot express which item was returned. On a shared multi-item purchase it can reduce a debt
owed by someone whose item was never refunded. Editing `ExpenseItem.amount` to force the new
allocation to fit would erase the original purchase composition. Partial refunds, multiple
returned items and successive refunds require explicit attribution before beneficiary math.

## Decision and structure

Add `ExpenseAdjustmentItem`, the join between an `ExpenseAdjustment` and an `ExpenseItem`:

| Field                   | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `id`                    | Stable primary key.                                                     |
| `expense_adjustment_id` | Required foreign key to the adjustment recording the financial event.   |
| `expense_item_id`       | Required foreign key to the original purchased item.                    |
| `amount`                | Positive integer minor-unit `bigint` magnitude attributed to this item. |

One adjustment can cover many items, and one item can receive multiple adjustments over time.
Use one row per `(expense_adjustment_id, expense_item_id)` within an adjustment. The parent
adjustment supplies expense identity, kind, event date, approval/audit context and optional
credit Payment; do not duplicate them on each attribution row. These rows describe cost
reductions, not beneficiary shares, new expenses, new payments or new obligations.

Attributions are DERIVED while proposed and APPROVED with the adjustment's distribution
decision. Finalized rows are retained as historical decisions, never silently overwritten.
An incomplete attribution proposal must stay visibly pending and cannot become an approved
item refund or feed settlement/sync as if distribution had completed. Persist the complete
attribution set transactionally; validate aggregate ceilings against other recorded adjustments
under a lock/transaction so concurrent refunds cannot each spend the same remaining ceiling.

Legacy whole-expense refunds/reimbursements without item attribution remain supported under
ADR-0008. New refunds of identified items must use this structure. Do not invent item matches
or silently apply the whole-basket default when the refunded item is known. If legacy
adjustments prevent determining an item's remaining refundable basis, request an explicit
audited attribution decision before approving further item refunds; do not guess a backfill.

## Calculation semantics

**Item refund first, allocation recalculated afterward.** The mandatory pipeline is:

```text
financial event → adjustment → net expense → allocation → obligation

item_refund_i = sum(ExpenseAdjustmentItem.amount for ExpenseItem i)
net_item_amount_i = ExpenseItem.amount_i - item_refund_i
net_expense = Expense.amount - sum(ExpenseAdjustment.amount for the expense)
sum(current AllocationLine.amount) = net_expense
```

`Expense.amount` and `ExpenseItem.amount` are historical gross-of-refund amounts. The refund
changes derived net costs. Recompute beneficiary shares from those costs and the approved
allocation method/item ownership; create a superseding `Allocation`, then derive obligations
to the original payer. The item cost reduction must be computed even if no allocation exists
yet. Never start with a desired person-to-person balance and reverse-engineer a refund.

For item/quantity allocation, only beneficiaries of the affected item receive its reduction,
using the approved item shares. For a genuinely shared item, apportion its net cost with the
existing Largest Remainder Method and stable tie-break keys. Equal/percentage/custom methods
retain their approved semantics; if item ownership is absent or conflicts with the intended
allocation, a human must approve the item mapping or method change before distribution.
Neither the AI nor the refund engine may invent beneficiary ownership.

Where all adjustments have complete item attribution and the items cover gross expense,
`sum(net_item_amount) = net_expense`. If legacy whole-expense adjustments coexist, show their
unattributed reduction separately and apply their recorded distribution once; do not pretend
item net totals include them or distribute the same reduction twice. Preserve the expense-wide
ceiling and any prior beneficiary reductions when recalculating.

Recording and distribution remain two explicit steps under ADR-0008: a pending adjustment is
visible, but stale allocation-based obligations are not represented as current/verified.
Approval of the new allocation validates sums, writes an audit trail and marks already-synced
Splitwise data `stale`. Earlier allocations and real settlements remain unchanged. If someone
already settled and a refund now creates money owed back to them, expose the resulting reverse
balance; never erase their settlement or fabricate a payout Payment.

### Worked shared-purchase example

The user pays ₹1,000: an item costing ₹600 belongs to the user, and an item costing ₹400
belongs to a friend. A ₹150 partial refund attributed to the friend's item creates one
`ExpenseAdjustment` for ₹150 and one `ExpenseAdjustmentItem` for ₹150. Net item costs become
₹600 and ₹250; the replacement allocation totals ₹850; the friend's obligation to the payer
becomes ₹250. The original ₹1,000 debit, ₹600/₹400 items and original allocation survive.
The ₹150 credit is a separate source Payment, if observed. If the friend already settled
₹400, the balance now shows ₹150 owed back to the friend, without rewriting that settlement.

### Invariants 19.1–19.6

1. **19.1 — Same expense.** The referenced item's `expense_id` must equal its adjustment's
   `original_expense_id`. Reject cross-expense attribution even if the merchant, receipt or
   payer is the same. Foreign keys alone do not prove this; validate the relationship.
2. **19.2 — Complete attribution sum.** For an item-attributed adjustment,
   `sum(ExpenseAdjustmentItem.amount) = ExpenseAdjustment.amount` exactly. Partial proposals
   remain pending; no unexplained remainder may become an approved item refund. Legacy
   whole-expense adjustments have no item rows and keep their explicitly documented path.
3. **19.3 — Cumulative item ceiling.** Across all recorded refunds/reimbursements attributed
   to an item, their sum must be **≤ its original gross `ExpenseItem.amount`**; never check
   only the newest row. Also preserve the parent expense's cumulative adjustment ceiling.
   Net item costs and final allocation lines cannot be negative. Duplicate event detection and
   concurrency protection must prevent repeat imports/requests from consuming the ceiling twice.
4. **19.4 — Positive magnitude.** Every attribution amount and parent adjustment amount is
   strictly positive integer paise; no zero, negative, float or signed reversal row. A refund
   clawback remains new spend under ADR-0008, not a negative refund attribution.
5. **19.5 — Immutable purchase composition.** A refund never changes original approved
   `ExpenseItem.amount`, quantity, identity or `Expense.amount`. Original items continue to
   sum to gross expense. Net amounts are derived and allocation versions are append-only;
   full refunds retain all original beneficiaries with zero current shares (ADR-0013).
6. **19.6 — Immutable cash evidence.** Never mutate, resize or fabricate the original purchase
   Payment or any refund Payment to match item or allocation math. A refund credit remains
   separate immutable evidence; evidence-first adjustments may have no Payment yet. Combined
   adjustment attributions against one refund Payment cannot exceed its credit amount, and
   any remainder stays unexplained. Attribution, allocation approval and obligation derivation
   must be auditable and deterministic, in the pipeline order above.

## Taxes and discounts

Tax and discount amounts come from receipt/refund evidence, not a tax engine. Keep the receipt's
base item price, discount and tax breakdown as evidence/derived receipt detail. At original
itemization approval, reconcile payable item costs to gross `Expense.amount`: an item's
`ExpenseItem.amount` is its agreed paid-cost basis **before later refunds**, not necessarily
the catalog price before purchase-time discounts. Never overwrite the receipt's base price
to disguise a discount or tax allocation.

Apply a line-specific discount to that line's paid-cost basis. Allocate order-level discounts
only across eligible items using documented weights and exact Largest Remainder rounding;
allocate shared tax/charges on the evidenced applicable basis, with human confirmation if
ambiguous. An independently itemized positive tax/fee component can instead be its own original
`ExpenseItem` with an explicit description and allocation policy. A discount is not a negative
`ExpenseAdjustmentItem` and is not a second post-purchase refund when already present in the
original payable total.

Use the merchant's actual refunded breakdown. A refund of an item's embedded tax is attributed
within that item's original paid-cost ceiling; a separately modeled refundable tax/fee is
attributed to its own original component item. Non-refunded delivery fees remain in net cost.
All item/component attribution rows still sum exactly to the credit's adjustment portion.
Do not push a tax remainder into an unrelated item, refund a pre-discount catalog price above
the paid basis, add fictitious items after the refund, or change approved purchase composition
to make the sum fit. Missing breakdown evidence remains a pending review decision. Receipt-level
display of base/tax/discount components is explanatory, never a second counted financial amount.

## Consequences and acceptance scenarios

Phase 16 adds the join table, domain types, foreign keys, uniqueness/positive constraints and
transactional aggregate validation. Phase 18 extends allocation services and their scenario
tests; it must not reuse the whole-expense proportional default for item-specific refunds.
The existing historical and whole-expense scenarios must continue to pass.

**Delivered (Phase 18, 2026-09-06).** `domain.buildItemAwareAllocationLines` places each item's
net cost on that item's own beneficiaries and applies any unattributed whole-expense reduction
once, afterwards; `services.distributeAdjustment` branches to it whenever any attribution
exists and keeps ADR-0008's path byte-for-byte otherwise. An allocation that cannot express
item ownership is refused with `REFUND_ITEM_OWNERSHIP_REQUIRED` rather than falling back to the
whole-basket default. `services.approveAllocation` allocates item-based lines against net item
costs. The scenario matrix below is `tests/scenarios/item-refund-allocation.test.ts`; the
whole-expense scenarios in `tests/scenarios/adjustments-settlements-and-exclusions.test.ts` are
unchanged and still pass.

The scenario matrix must cover one-item partial refund, multiple refunded items, successive
refunds and cumulative ceilings, concurrent/duplicate refunds, shared quantities and paise
rounding, a fully refunded item and full expense, missing/cross-expense attribution, zero and
negative rejection, taxes/discounts/non-refunded fees, mixed legacy and item adjustments,
evidence-first credits, externally funded expenses, already-settled reverse balances and
synced expenses becoming stale. Assert unchanged source Payments, gross items and old
allocations as well as final net sums and obligations.

## Alternatives considered

- Mutate item costs or create negative purchase items: erases original composition and mixes
  financial events with historical purchase evidence.
- Proportion every refund over the entire current allocation: penalizes unrelated items'
  beneficiaries and cannot faithfully explain partial returns.
- Store only beneficiary-level refund amounts: loses item attribution and makes the refund
  impossible to derive independently of the current allocation.
