# Terminology

A glossary. When these words are used elsewhere in the codebase or docs, they mean exactly
this — see `docs/domain/domain-model.md` for full entity definitions.

> **Revision note (2026-08).** Several entries below were added, corrected, or removed following
> a pre-implementation architecture review. See `docs/domain/domain-model.md`'s revision note and
> ADRs 0006–0011.

**Payment** — What actually caused money to leave or enter an `Account` the user owns. The
bank/UPI-level fact. Never assumed to equal an expense or a receipt, and never able by itself to
represent money someone *else* spent — see **Payer**, below.

**Payer** — The `Person` who actually fronted the money for an `Expense`
(`Expense.paid_by_person_id`). Usually the user, but not always — a flatmate or friend can be
the payer of an expense the user is only a beneficiary of. **Added this revision (ADR-0006)** to
close a gap where the model could only represent the user paying, never the reverse.

**Expense** — What the money was actually for. A **spend event**: something bought or paid for,
with beneficiaries, requiring an `Allocation`. Derived from, and linked to, one or more payments
when self-funded (paid by the user); linked only to `Evidence`, never a `Payment`, when
externally-funded (paid by someone else).

**Evidence** — Any document or information supporting the interpretation of a payment or
expense (statement line, receipt, screenshot, manual note). Immutable once captured.

**Receipt** — The structured interpretation (subtotal/tax/total/items) of a piece of
receipt-type evidence. Derived, not source. Linked to a `Payment`/`Expense` only indirectly, via
its `Evidence` record (or, when split across expenses, via its items) — it has no direct
Payment/Expense reference of its own. See `domain-model.md`.

**Beneficiary** — Whoever benefited from an expense: a `Person` or a `Group`. Not a standalone
entity; a role played on an `AllocationLine`. The payer's own beneficiary line (if they're also a
beneficiary) creates no obligation; every other beneficiary line creates one, owed to the payer —
see **Obligation**.

**Allocation** — How an expense is divided among its beneficiaries: method + one line per
beneficiary. Sums to the expense's **net** amount (gross minus any adjustments — see
**Adjustment**), not its gross amount. Only ever exists for an `Expense`; a `Settlement` never
has one.

**Occasion** — An optional grouping of related expenses that happened together (e.g. one
evening out, or a multi-day trip).

**Obligation** — A debt one `Person` owes another, created by a non-payer beneficiary line on a
`shared`, `paid_on_behalf`, or `household_shared_flat` expense (never by `personal` or `gift`).
**Not** a table — always derived from `AllocationLine` (and, for a `group` beneficiary, its
`AllocationLineGroupExpansion`) data. Generalized this revision (ADR-0006) to hold between any
two people, not just "the user and someone else."

**Balance** — The net, pairwise obligation between two specific people, after netting out
`Settlement`s already made between them in either direction. Always derived from allocations and
settlements, never stored as an independently-editable number. See `domain-model.md`'s
Obligation/Balance/Settlement section for the exact formula.

**Settlement** — A record that a specific `Payment` discharges (part of) an existing `Obligation`
between the user and a `counterparty_person`. **Not** an `Expense` and never has an `Allocation`
(ADR-0007, revised this pass — previously described as either an Expense-relationship-type or an
ambiguous, never-implemented flag directly on `Payment`). Does not create new spend and is
excluded from `ledger_explained_total`.

**Adjustment** (`ExpenseAdjustment`) — Money returned against an **existing** `Expense`, without
changing that expense's original recorded amount. Two kinds: `merchant_refund` (money back from
the same counterparty as the original expense) and `third_party_reimbursement` (money back from
someone outside the original transaction — see **Reimbursement**). Replaces the original
`refund_of_expense_id`-based design (ADR-0008).

**Refund** — An `Adjustment` of kind `merchant_refund`: money returned against a prior expense,
full or partial, by the same counterparty that was originally paid. Nets against that expense's
**net** amount (`domain.netAmount`); the original expense's gross `amount` and evidence trail are
never touched.

**Reimbursement** — An `Adjustment` of kind `third_party_reimbursement`: money returned against a
prior expense by someone who was **not** the original counterparty — an employer, an insurer, a
cashback program. Mechanically identical to a refund (same net-amount computation, same
Allocation-supersession mechanism); only the source differs. **Redefined this revision
(ADR-0008)** — previously an undefined `Expense.relationship_type` value with no worked example
and no clear distinction from `paid_on_behalf` or `settlement`. It is **not** a way of
classifying a new expense, and it is **not** the same as a `Settlement`: a settlement discharges
a debt between two people already tracked in the ledger's beneficiary graph; a reimbursement
reduces the net cost of a specific prior expense from a source that was never a beneficiary of
it.

**Paid on behalf** (`paid_on_behalf`) — A **new** expense where the payer pays the full amount but
100% (or some portion) of the benefit belongs to someone else, who owes it back — distinct from a
`shared` expense (payer also benefits) and distinct from a `Settlement` (discharges a debt rather
than creating one).

**Investment** — A `Payment` classified `counterparty_type = investment_instrument` (a mutual
fund, brokerage, or similar) — excluded from spend the same way an internal transfer is, and
never linked to an `Expense`. Has its own reconciliation bucket, `ledger_investments_total`.
**Added this revision (ADR-0011)** — the term appeared in product docs before this without a
backing mechanism; it now has one, and is explicitly scoped to the outflow side only (not
performance/valuation tracking — out of scope).

**Transfer** — Movement of money between the user's own accounts
(`counterparty_type = internal_account`). Not an expense; excluded from spend totals.

**Reconciliation** — Checking whether the ledger agrees with itself (totals sum correctly) and
with external systems (Splitwise). Produces a `ReconciliationRun` snapshot.

**Unexplained money** — `total outflow − transfers − investments − settlements − explained
expenses` (**corrected this revision** — the formula previously named "investments" here without
either investments or settlements actually appearing in the schema or in `invariants.md` #20;
both are now real, modeled terms — see `domain-model.md`'s `ReconciliationRun` and
`invariants.md` #20), always visible, never hidden by an optimistic default. Scoped to outflow
only, an explicit V1 boundary rather than an unmodeled gap (**resolved this revision** — see
`domain-model.md`'s `ReconciliationRun` "V1 scope, explicit" and `docs/roadmap.md`); a symmetric
inflow-side "unexplained credit" concept is a plausible later addition the schema doesn't block.

**Minor unit (paise)** — The only unit any monetary column is ever stored in: an integer
`bigint`, never a float, never a `numeric`/`decimal` column. 1 INR = 100 paise. **Finalized this
revision** — see `invariants.md` #12 for the exact rule and the **Largest Remainder Method**,
below.

**Largest Remainder Method** — The one deterministic algorithm used everywhere a total amount
must be divided across multiple `AllocationLine`/`AllocationLineGroupExpansion` rows (equal
splits, percentage splits, group expansion, `ExpenseAdjustment` distribution): take each line's
integer floor share, then hand out the leftover minor units one at a time to the lines with the
largest fractional remainder, tie-broken by ID. Guarantees the parts always sum to the whole,
with no floating point involved anywhere. Does **not** apply to item/quantity-based lines, whose
`amount` is copied directly from an already-exact `ExpenseItem.amount`. **Finalized this
revision** — see `invariants.md` #12/#12a.

**`ObligationEvidenceStatus`** — A derived, read-only, three-value status
(`open, unconfirmed | believed_settled, unconfirmed_by_ledger | settled, confirmed`) computed
for any pair of people with a nonzero `Balance`, so the product can show "an obligation is
expected here, but this ledger has no settlement evidence for it" rather than a bare number.
Computed from existing `Settlement`/`Evidence`/`ReconciliationRun` data only — never a new
`Payment`, never an `AIInference`, never a mutation of `Balance` itself. **Added this revision**
— see `domain-model.md`'s Obligation/Balance/Settlement section and `invariants.md` #9b.

**Evidence / Inference / Decision** — Three distinct layers that must never be collapsed:
_evidence_ is what the source says, _inference_ is what the system believes it means (always
AI/derived, always carries confidence), _decision_ is what the user (or a rule they approved)
has explicitly confirmed.

**Confidence** — `high | medium | low | unknown`, attached to every `AIInference`. Never a
substitute for approval on a financially consequential decision.

**Source data** — Immutable, as-imported evidence. Never overwritten.

**Derived data** — Computed or AI-inferred. Re-derivable, corrected in place, but a correction
never rewrites source data or silently overwrites a user's prior approval.

**Approved data** — Authoritative financial fact the user has confirmed (directly, or via a
rule they previously approved). Changes are audited. `Expense.amount` is a stronger case: once
approved, it is never changed again, by any mechanism (see **Adjustment** for how corrections are
represented instead).

**Rule** — A user-approved pattern that pre-classifies future matching transactions, reducing
review burden without weakening the approval invariant (the rule itself was approved).

**Splitwise** — An external, non-canonical synchronization target for shared-expense tracking.
This system's own ledger is authoritative; Splitwise is reconciled against. Has native concepts
for both an "expense" (→ `SplitwiseExpense`) and a "payment"/settlement (→
`SplitwiseSettlement`) — the two are synced separately, matching this system's own `Expense`/
`Settlement` split.
