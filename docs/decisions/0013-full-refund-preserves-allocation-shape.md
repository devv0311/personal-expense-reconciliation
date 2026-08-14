# 0013. A full refund's current allocation keeps one zero-amount line per beneficiary, never an empty set

**Status:** Accepted

## Context

`ExpenseAdjustment` (ADR-0008) supersedes an `Expense`'s `Allocation` to sum to the new
`netAmount` after a refund/reimbursement. For a **partial** refund this was already
well-specified: the reduction is distributed across the existing beneficiaries (ADR-0012's
Largest Remainder Method), producing the same beneficiaries at smaller amounts. For a **full**
refund/reimbursement (`netAmount` reaches exactly 0), the original design left the shape of the
resulting `Allocation` an open implementation choice — either an empty `lines: []` set, or a
single zero-amount line to the payer — "valid either way," deferred to Phase 12.

This ambiguity was a real risk to the stated goal of preserving historical truth: an empty
`lines: []` set on the *current* allocation reads, to any code or person inspecting it later, as
"this expense has no beneficiaries," which is not true — it had beneficiaries; the refund made
their net cost zero, not their existence disappear. It also complicates "who benefited from a
fully-refunded expense" queries, which would have to fall back to a superseded `Allocation`
version instead of reading the current one directly.

## Decision

Applying the same Largest Remainder Method used everywhere else (ADR-0012) with a total of 0
against the existing beneficiary set (the proportional-to-existing-share default) deterministically
yields a floor share of 0 for every line and a remainder of 0 — so the natural, algorithm-driven
output is **one `AllocationLine` per original beneficiary, each at `amount = 0`**. This is not a
new special case; it falls directly out of applying the existing algorithm uniformly, including
at its degenerate boundary. `AllocationLine.amount >= 0` (ADR-0012) makes this a valid row.

This means a full refund never erases: what was purchased (`Expense.description`, untouched),
the original amount (`Expense.amount`, immutable), who originally benefited (present in both the
superseded and the current `Allocation`), or how it was originally split (the superseded
`Allocation` version's `method` and per-line amounts are kept, never deleted). Only the derived
`netAmount` and the current line amounts reflect the net-zero outcome.

**Splitwise implication, decided alongside this.** If the original expense had already synced
before the adjustment that zeroes it out, the resulting `stale` `SplitwiseExpense` status implies
a **deletion** proposal, not a $0-amount update push — Splitwise has no meaningful zero-value
expense concept.

**Analytics implication.** A net-zero expense contributes exactly 0 to `ledger_explained_total`
(correctly, not by omission) but remains queryable as "purchased, then fully refunded/reimbursed
on `<date>`" via `Expense` + its `ExpenseAdjustment`(s) — worth its own analytics category later,
not a disappearing act.

## Consequences

`fixtures/refund-full.json` and `fixtures/reimbursement-third-party.json` updated: `lines: []` →
one zero-amount line per original beneficiary. `roadmap.md`'s "net-zero allocation shape" open
question is resolved, not deferred. `domain-model.md`'s `ExpenseAdjustment` and `Allocation`
sections, and `invariants.md` #12a, carry the full rule. `integrations/splitwise` (Phase 14) must
branch on `netAmount = 0` when building a re-sync proposal for a `stale` expense, rather than
assuming every `stale` row implies an amount update.

## Alternatives considered

- **Empty `lines: []` for the net-zero case.** The original "valid either way" framing. Rejected
  because it reads as "no beneficiaries," actively working against the "preserve historical
  truth" requirement this was meant to satisfy, and because it required a special case in the
  distribution algorithm (an explicit "if total is 0, write no lines" branch) rather than falling
  out of the general rule.
- **A single collapsed line to the original payer, regardless of how many beneficiaries there
  were.** Rejected for the same reason as the empty-set option: it silently drops every
  beneficiary except the payer from the *current* view, even though all of them are still
  factually the people who benefited from ₹0 of net cost.
