# 0004. Fold Beneficiary, Classification, Decision/Approval, and Settlement into fewer tables

**Status:** Accepted

## Context

The brief's candidate entity list (`docs/domain/domain-model.md`'s source instructions)
included `Beneficiary`, `Classification`, `Decision/Approval`, and `Settlement` as entities to
evaluate. Modeling all four as standalone tables was the initial draft.

## Decision

- **Beneficiary** is not a table. It's a role (`person | group`) carried directly on
  `AllocationLine` via `beneficiary_type`/`beneficiary_id`.
- **Classification** is not a table. It's `AIInference` with
  `inference_type = classify_transaction` — one of nine inference types sharing the same
  confidence/audit/approval machinery.
- **Decision/Approval** is not a table. It's the `AIInference.status` transition from
  `pending` to `accepted`/`modified`/`rejected`, paired with the `AuditEvent` the transition
  writes.
- **Settlement** is not a table that records money movement. It's (a) a derived `Balance`,
  always recomputed from `AllocationLine`s and settlement-classified payments, never stored as
  an independently-editable number, and (b) an existing `Payment`/`Expense` viewed through a
  `relationship_type = settlement` lens.

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
  after noticing all nine AI operations in `docs/architecture/ai-boundary.md` need identical
  confidence/status/audit handling; a separate table would duplicate that shape eight more
  times as new AI operations are added.
- **A standalone `Decision` table**, logging every approval as its own row distinct from
  `AuditEvent`. Considered for a while — a `Decision` row would be more specifically typed than
  a generic `AuditEvent`. Rejected because every piece of information a `Decision` row would
  hold (what was approved, by whom, referencing which inference) is already exactly what
  `AuditEvent` plus `AIInference.status`/`decided_by` capture; a separate table would be two
  audit trails that could drift out of sync with each other.
- **A `SettlementTransaction` table** recording each debt repayment as new domain machinery.
  Rejected directly by scenario analysis (`docs/domain/scenario-analysis.md` #15) — a
  settlement repayment _is_ a payment; giving it its own table would create two ways to
  represent "money moved," which is the exact ambiguity `Payment` exists to eliminate.
