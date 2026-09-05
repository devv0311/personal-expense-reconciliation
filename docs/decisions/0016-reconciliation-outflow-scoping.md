# 0016. `ledger_explained_total` and `ledger_settlements_total` are scoped to observed outflow

> **Extension (2026-09-05).** [ADR-0017 (cash balance)](0017-pragmatic-cash-balance-reconciliation.md)
> adds an independent bank-balance identity. This ADR's outflow formula, field meanings and
> historical snapshots remain intact. References below to inflows being future/out of scope
> describe the original release; the new cash path is now accepted for Phase 16.

**Status:** Accepted (2026-08-15). Raised by the Phase 1 implementation and confirmed against
`invariants.md` #20, `domain-model.md`'s `ReconciliationRun`, and `scenario-analysis.md` §26,
§29 and the stress-test coverage matrix before acceptance.

## Context

`invariants.md` #20 states the reconciliation identity:

```
ledger_unexplained_total = ledger_total_outflow − ledger_transfers_total
                         − ledger_investments_total − ledger_settlements_total
                         − ledger_explained_total
```

and defines two of its terms loosely enough that a literal reading breaks the arithmetic once
ADR-0006 and ADR-0007 are both in play. Implementing `domain.computeUnexplained()` forced the
question, because there is no way to write the function without answering it.

**1. `ledger_explained_total` "sums `domain.netAmount(expense)` per `APPROVED`+ expense."**
Read literally, that includes an **externally-funded** expense — one where
`paid_by_person_id` is not the user (ADR-0006). Such an expense is real, approved, and by
design has no `PaymentExpenseLink` and no debit through any `Account` the user owns. It
therefore contributes nothing to `ledger_total_outflow`, but would be subtracted from it.

Concretely, `scenario-analysis.md` §26: Flatmate A pays the electrician ₹3,000. With no other
activity in the period, the identity yields
`0 − 0 − 0 − 0 − 300000 = −300000` — the ledger reports ₹3,000 of _negative_ unexplained
money purely because somebody else paid for something.

**2. `ledger_settlements_total` "gets its own bucket."** Read literally, that includes a
settlement the user _received_ (`scenario-analysis.md` §29), which is carried by a **credit**
payment. A credit never entered `ledger_total_outflow`, so subtracting it understates
unexplained money by its full amount. §28 (a settlement the user _paid_, a debit) is the case
the term was written for.

Both problems come from the same place: `invariants.md` #20 says the formula is "scoped to
outflow" in prose, but its per-term definitions do not restate that scope.

## Decision

Apply the formula's own stated outflow scope to both terms, explicitly:

- **`ledger_explained_total` counts self-funded expenses only** — those whose
  `paid_by_person_id` is the user's `Person`. An externally-funded expense contributes 0. It
  is not being hidden: it remains fully visible in `Balance`, in obligation queries, and in
  its own `Expense`/`Allocation` rows. It simply is not _explained outflow_, because no
  outflow of the user's occurred.
- **`ledger_settlements_total` counts settlements carried by a `debit` payment only.** A
  received settlement is a credit and never entered the outflow total, so it is not subtracted
  from it.

`ledger_total_outflow` additionally excludes payments in state `ignored` — a confirmed
duplicate is not more money (`invariants.md` #10).

`ledger_unexplained_total` is stored **whatever it comes to, including negative**. An
over-explained ledger means a real problem (a double-linked payment, a mis-scoped period) and
clamping it to zero would hide exactly what the run exists to surface. A `CHECK` constraint on
`reconciliation_runs` enforces the identity per row so no inconsistent snapshot can persist.

## Consequences

`domain.computeUnexplained()` takes `selfFunded` on each expense and `direction` on each
settlement. Both are already available — `expenses.paid_by_person_id` and the settlement's
linked `payments.direction` — so no schema change is needed and no new column is introduced.

On acceptance, three reviewed documents gained the scope explicitly rather than by implication:

- `invariants.md` #20 — each term now states its own outflow scope, and the negative-total
  integrity signal is stated rather than left to the implementation.
- `domain-model.md`'s `ReconciliationRun` field list — same two clauses, at the point the
  columns are defined.
- `scenario-analysis.md`'s coverage matrix — rows 8, 10 and 19 said "Explained spend" and
  "Excluded — `ledger_settlements_total`" for cases that are explained _expenses_ but not
  explained _outflow_, and for a credit-carried settlement. That phrasing is the same
  conflation this ADR exists to remove, one document further out, so it was disambiguated too.

**The naming is the heart of it:** `ledger_explained_total` means _explained outflow_, not
_explained expenses_. Everything else follows from reading it that way.

An inflow-side reconciliation (ADR-0015, explicitly out of scope for V1) is where a
received settlement and an externally-funded expense would eventually be accounted for, if
they ever need to be. Nothing here blocks that.

## Alternatives considered

- **Take #20 literally and let `ledger_unexplained_total` go negative in normal use.**
  Rejected: "unexplained money" would stop meaning anything, and the number the product exists
  to surface would be routinely wrong in a way no user could interpret.
- **Widen `ledger_total_outflow` to include externally-funded expenses**, so the subtraction
  balances. Rejected: `ledger_total_outflow` means "money that left the user's accounts", and
  inflating it with money that never did would corrupt a simpler, more load-bearing figure to
  protect a derived one. It would also make the total disagree with the sum of the user's own
  debit payments, which is the one thing about it that is directly checkable against a bank
  statement.
- **Add an `is_self_funded` column to `expenses`.** Rejected as redundant: it is exactly
  `paid_by_person_id = <the user's person>`, and a stored duplicate of a derivable fact is a
  drift risk for no benefit.
