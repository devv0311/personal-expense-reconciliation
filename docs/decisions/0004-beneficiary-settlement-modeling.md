# 0004. Fold Beneficiary, Classification, Decision/Approval, and Settlement into fewer tables

**Status:** Accepted. The Settlement paragraph below is **partially superseded by ADR-0007**
(2026-08 architecture review) — see the note at the end of this ADR. The Beneficiary,
Classification, and Decision/Approval decisions are untouched and remain in effect.

## Context

The brief's candidate entity list (`docs/domain/domain-model.md`'s source instructions)
included `Beneficiary`, `Classification`, `Decision/Approval`, and `Settlement` as entities to
evaluate. Modeling all four as standalone tables was the initial draft.

## Decision

- **Beneficiary** is not a table. It's a role (`person | group`) carried directly on
  `AllocationLine` via `beneficiary_type`/`beneficiary_id`.
- **Classification** is not a table. It's `AIInference` with
  `inference_type = classify_transaction` — one of the inference types sharing the same
  confidence/audit/approval machinery.
- **Decision/Approval** is not a table. It's the `AIInference.status` transition from
  `pending` to `accepted`/`modified`/`rejected`, paired with the `AuditEvent` the transition
  writes.
- ~~**Settlement** is not a table that records money movement. It's (a) a derived `Balance`,
  always recomputed from `AllocationLine`s and settlement-classified payments, never stored as
  an independently-editable number, and (b) an existing `Payment`/`Expense` viewed through a
  `relationship_type = settlement` lens.~~ **Superseded by ADR-0007** — see note below. Part (a)
  (Balance is always derived, never stored) is still correct and still in effect, now generalized
  to a pairwise function over any two people. Part (b) (settlement routed through an `Expense`
  shell) is what changed.

## Consequences

Four fewer tables, four fewer places the "AI proposes, human decides" and
"money movement always goes through `Payment`" invariants would need to be independently
re-enforced. The risk is that a future contributor reads the brief's original entity list and
"fixes" this by adding the tables back without reading this ADR — mitigated by
`docs/domain/domain-model.md` explicitly calling out each fold at the point where the entity
would have appeared.

## Alternatives considered

- **A standalone `Beneficiary` table** referenced by `AllocationLine.beneficiary_id`, itself
  wrapping a `Person` or `Group`. Rejected: it would carry no fields or behavior of its own
  beyond the polymorphic reference `AllocationLine` already needs directly — pure indirection.
- **A standalone `Classification` table**, separate from other AI proposal types. Rejected
  after noticing all AI operations in `docs/architecture/ai-boundary.md` need identical
  confidence/status/audit handling; a separate table would duplicate that shape with every new
  AI operation added.
- **A standalone `Decision` table**, logging every approval as its own row distinct from
  `AuditEvent`. Considered for a while — a `Decision` row would be more specifically typed than
  a generic `AuditEvent`. Rejected because every piece of information a `Decision` row would
  hold (what was approved, by whom, referencing which inference) is already exactly what
  `AuditEvent` plus `AIInference.status`/`decided_by` capture; a separate table would be two
  audit trails that could drift out of sync with each other.
- **A `SettlementTransaction` table** recording each debt repayment as new domain machinery.
  Rejected directly by scenario analysis (`docs/domain/scenario-analysis.md` #15) — a
  settlement repayment _is_ a payment; giving it its own table would create two ways to
  represent "money moved," which is the exact ambiguity `Payment` exists to eliminate. **This
  reasoning still holds after ADR-0007** — ADR-0007's `Settlement` table does not record an
  amount independent of `Payment`; it classifies and links an existing `Payment`, the same way
  `PaymentExpenseLink` classifies and links one without duplicating `Payment.amount`.

## Note — 2026-08 partial supersession (ADR-0007)

The original settlement decision (routing a settlement through `Expense.relationship_type =
settlement`, requiring the same `Allocation` machinery as any other expense) turned out to
contradict invariant #2 in practice — see ADR-0007 for the full analysis. Settlement is now its
own entity (`Settlement`, referencing `Payment` + a counterparty `Person`), never an `Expense`.
This ADR is kept, not deleted, per the project's own stated ADR philosophy
(`docs/decisions/0001-record-architecture-decisions.md`): the history of what was tried and why
it changed is as valuable as the current state.
