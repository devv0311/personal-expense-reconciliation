# Terminology

A glossary. When these words are used elsewhere in the codebase or docs, they mean exactly
this — see `docs/domain/domain-model.md` for full entity definitions.

**Payment** — What actually caused money to leave or enter an `Account`. The bank/UPI-level
fact. Never assumed to equal an expense or a receipt.

**Expense** — What the money was actually for. Derived from, and linked to, one or more
payments.

**Evidence** — Any document or information supporting the interpretation of a payment or
expense (statement line, receipt, screenshot, manual note). Immutable once captured.

**Receipt** — The structured interpretation (subtotal/tax/total/items) of a piece of
receipt-type evidence. Derived, not source — see `domain-model.md`.

**Beneficiary** — Whoever benefited from an expense: a `Person` or a `Group`. Not a standalone
entity; a role played on an `AllocationLine`.

**Allocation** — How an expense is divided among its beneficiaries: method + one line per
beneficiary.

**Occasion** — An optional grouping of related expenses that happened together (e.g. one
evening out).

**Settlement** — The state of who owes whom. Always derived from allocations and settlement
payments, never stored as an independently-editable balance.

**Reconciliation** — Checking whether the ledger agrees with itself (totals sum correctly) and
with external systems (Splitwise). Produces a `ReconciliationRun` snapshot.

**Unexplained money** — `total outflow − transfers − investments − explained expenses`, always
visible, never hidden by an optimistic default.

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
rule they previously approved). Changes are audited.

**Transfer** — Movement of money between the user's own accounts. Not an expense; excluded
from spend totals.

**Refund** — Money returned against a prior expense, full or partial. Nets against that
expense; not counted as new income.

**Paid on behalf** — The user pays the full amount, but 100% (or some portion) of the benefit
belongs to someone else, who owes it back — distinct from a `shared` expense where the user
also benefits from a portion.

**Settlement payment** — A payment (often a transfer, sometimes via Splitwise) whose purpose is
to discharge an existing balance, not to create a new expense.

**Rule** — A user-approved pattern that pre-classifies future matching transactions, reducing
review burden without weakening the approval invariant (the rule itself was approved).

**Splitwise** — An external, non-canonical synchronization target for shared-expense tracking.
This system's own ledger is authoritative; Splitwise is reconciled against.
