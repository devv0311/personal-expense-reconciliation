# 0008. Refunds and reimbursements are linked adjustment events, not new Expenses or mutations

> **Extension (2026-09-05).** [ADR-0018 (item refunds)](0018-item-level-refund-attribution.md)
> adds `ExpenseAdjustmentItem` and requires item cost reduction before allocation recalculation
> for item-attributed refunds. The whole-expense proportional default below remains the legacy
> path, not the rule for a known item refund. Gross history, positive adjustments, full-refund
> allocation shape and audit requirements remain unchanged.

**Status:** Accepted

## Context

The original refund design created a _second_ `Expense` for every refund
(`refund_of_expense_id` self-reference) and left unresolved how that second Expense's existence
squared with invariant #11 ("sum of `AllocationLine.amount` must equal `Expense.amount`
exactly"). The reference fixture for a partial refund showed a new Allocation on the _original_
Expense summing to the post-refund net amount (750) while never showing `Expense.amount` itself
change from its original value (900) — leaving it genuinely ambiguous whether invariant #11 was
satisfied (review finding #3). Separately, `reimbursement` existed as an `Expense.relationship_type`
value in every layer of the design but was never defined in `terminology.md` and never exercised
by any scenario (review finding #10) — and turns out, on inspection, to be structurally the same
problem as refund: money coming back against a prior expense, just from a different source.

The user's explicit direction for this pass: preserve the original Expense as historically true;
model the refund as a separate linked event; don't silently mutate history.

## Decision

`Expense.amount` is the gross, historical amount and is **never changed** after the expense
reaches `APPROVED` — full stop, no exception, matching how the rest of the model treats
approved financial facts.

A new entity, `ExpenseAdjustment`, represents money that came back against an existing expense
after the fact:

- `original_expense_id` — the expense being adjusted (never mutated).
- `kind`: `merchant_refund` (money back from the _same_ counterparty as the original expense) or
  `third_party_reimbursement` (money back from someone outside that transaction entirely — an
  employer, insurer, cashback program; **this is what `reimbursement` means now** — see
  "Reimbursement, defined" below).
- `amount` — the portion of the original expense's cost being returned. Application-level check:
  `sum(ExpenseAdjustment.amount for one original_expense_id) ≤ that expense's gross amount`.
- `adjustment_payment_id` — the credit `Payment` that documents the money coming back (nullable;
  evidence-first is valid here exactly as it is for a normal Expense).

`domain.netAmount(expense)` is a pure, always-recomputed function:
`expense.amount − sum(ExpenseAdjustment.amount where original_expense_id = expense.id)`. It is
never stored.

**Invariant #11, corrected:** the sum of the expense's _current_ `Allocation`'s
`AllocationLine.amount`s must equal `netAmount(expense)`, not the gross `Expense.amount`. A
refund/reimbursement is only "applied" once a new `Allocation` version is created (per invariant
#6 — superseding, never mutating, the previous one) whose lines sum to the new net amount, with
an explicit, user-decided distribution of the reduction (proportional by default, but not
silently assumed — matching the original scenario #12 finding that this needs a decision, not a
default). Until that new Allocation exists, the `ExpenseAdjustment` is recorded but "pending
distribution" — a real, named state, not an error.

**Reimbursement, defined.** `reimbursement` is removed as an `Expense.relationship_type` value.
It was never well-defined as a way of classifying a _new_ expense, because it isn't one — like a
refund, it's a fact about money returning against an expense that already exists and was already
classified (as `personal`, `shared`, etc. — whatever it actually was). The distinction the user
asked to be made explicit:

| Concept                                       | What it is                                                                                                                 | Creates a new Expense?   | Creates/discharges an obligation?            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------- |
| `paid_on_behalf`                              | A **new** expense; payer fronts 100% for someone else's benefit                                                            | Yes                      | Creates one                                  |
| `merchant_refund`                             | Money back from the **original merchant/counterparty** of an expense                                                       | No — `ExpenseAdjustment` | Neither — reduces the expense's own net cost |
| `third_party_reimbursement` (`reimbursement`) | Money back from **someone outside** the original transaction (employer, insurer, cashback) for an expense already recorded | No — `ExpenseAdjustment` | Neither — reduces the expense's own net cost |
| `Settlement` (ADR-0007)                       | Repayment of an **existing obligation** between two people                                                                 | No — separate entity     | Discharges one                               |

**Spend analytics / reconciliation.** `ledger_explained_total` sums `netAmount(expense)` for
`APPROVED`+ expenses, not gross `Expense.amount` — a fully-refunded expense contributes 0, not its
original amount, matching "net spending" the way a human would expect it, while the gross ₹900
purchase remains visible and auditable forever in `Expense.amount` and its original `Allocation`
history.

## Consequences

`expenses.refund_of_expense_id` is removed from the schema (no migration exists yet, so this is a
design-doc edit). One new table, `expense_adjustments`. Invariant #11 and the reconciliation
formula (#20) both change. `scenario-analysis.md` #11 and #12 are rewritten against the new
mechanism; the two refund fixtures are rewritten to show the full before/after state (gross
amount unchanged, adjustment recorded, Allocation superseded to net amount) so the ambiguity that
prompted this ADR can't recur. A synced `SplitwiseExpense` whose expense later receives an
adjustment moves to a new `stale` sync status (distinct from `drifted`, which means _Splitwise's_
side changed) — see `lifecycle.md` and `scenario-analysis.md` §30. The shape of the _fully_-
refunded case (`netAmount = 0`) was left an open implementation choice at the time this ADR was
written; it was resolved in a later pass — see ADR-0013.

## Alternatives considered

- **Mutate `Expense.amount` in place on refund, audited via invariant #6's "new decision"
  mechanism.** Rejected per explicit user direction: even an audited mutation of `amount` means
  "what did this cost" no longer has one stable answer across time without replaying the audit
  log — worse for explainability than a derived net-amount function that always agrees with the
  full adjustment history.
- **Keep refund as a second `Expense` (status quo) and just fix the arithmetic ambiguity by adding
  a rule that `Expense.amount` on the original gets reduced.** Rejected: this still leaves two
  `Expense` rows for one real-world purchase, doubles the audit surface, and doesn't resolve the
  `reimbursement` definition problem at all — reimbursement would still be a same-shaped but
  undefined sibling case.
- **Keep refund and reimbursement as separate tables.** Considered, since the user asked for a
  clear conceptual distinction between them. Rejected in favor of one table with a `kind`
  discriminator: the arithmetic (net-amount computation, Allocation supersession, reconciliation
  exclusion) is identical for both; only the _source_ of the money differs, which a `kind` column
  already captures without duplicating the surrounding machinery twice.
