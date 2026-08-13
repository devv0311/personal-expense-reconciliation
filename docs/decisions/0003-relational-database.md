# 0003. Relational database over document/NoSQL

**Status:** Accepted

## Context

The domain model (`docs/domain/domain-model.md`) is dense with real referential relationships:
payments link to expenses (many-to-many), expenses link to allocations and beneficiaries,
groups have time-ranged membership, and multiple invariants are sum/consistency checks across
rows (allocation lines summing to an expense amount, payment-expense links not exceeding a
payment's amount).

## Decision

PostgreSQL, accessed via transactions that enforce cross-row invariants at the point of write
(`docs/architecture/database-design.md`).

## Consequences

Referential integrity, transactional consistency, and constraint enforcement are available
"for free" at the database layer instead of being reimplemented in application code with the
risk of drift between multiple write paths. Query flexibility (joins across payments,
expenses, people, groups) is native rather than requiring denormalization or application-side
joins. Cost: schema changes require migrations (mitigated by keeping the domain model stable
before writing them — see `docs/roadmap.md` ordering) and horizontal scaling is less trivial
than a document store's (irrelevant at personal-project data volume).

## Alternatives considered

- **MongoDB / a document store.** Would require enforcing cross-document consistency
  (allocation sums, payment-expense apportionment) entirely in application code, with no
  transactional backstop across the equivalent of multiple "tables." Rejected: this is exactly
  the class of bug (double-counted or unbalanced money) the project cannot afford.
- **Event-sourced ledger (append-only event log, state derived by replay).** Genuinely
  attractive for the audit trail requirement (`invariants.md` #21–22) and considered
  seriously. Rejected for the _foundation_ phase as more machinery than justified before the
  simpler `audit_events` table (`database-design.md`) proves insufficient — revisit if
  point-in-time reconstruction needs outgrow a snapshot-plus-audit-log approach.
