# Requirements

Scope: this document lists functional and non-functional requirements at the level needed to
drive the domain model and architecture. It intentionally does not specify UI layouts or
implementation details. Requirements are tagged `MUST` (foundation-critical, informs the
domain model now) or `LATER` (real requirement, but implemented in a later roadmap phase per
`docs/roadmap.md`).

## Functional requirements

### Evidence ingestion

- MUST: accept UPI transaction exports, bank/card statements (CSV/XLSX/PDF), receipts
  (image/PDF), screenshots, and manually-entered explanations as evidence.
- MUST: preserve the raw imported evidence unmodified, independent of any interpretation
  derived from it.
- MUST: associate zero, one, or many evidence records with a single payment (e.g. a bank line
  plus a forwarded receipt for the same charge).
- LATER: automatic email/forwarding ingestion for e-receipts.

### Transaction normalization

- MUST: normalize heterogeneous source formats into one consistent payment representation
  without discarding source-specific fields.
- MUST: represent amount, currency, timestamp, direction (inflow/outflow), source account, and
  a raw description field for every payment.

### Classification

- MUST: propose a purpose/category for each payment (personal, shared, paid-on-behalf, gift,
  reimbursement, settlement, transfer, refund, household) with a confidence level.
- MUST: distinguish a transfer between the user's own accounts from an expense.
- MUST: distinguish a refund (full or partial) from a new inflow of income.
- MUST: flag likely duplicate transactions rather than silently deduplicating them when the
  evidence is not conclusively deterministic.

### Human review

- MUST: support an exception-driven review queue — transactions above a confidence/ambiguity
  threshold require human confirmation; the rest do not block on a person.
- MUST: make correcting an AI suggestion strictly faster than entering the same expense from
  scratch (fewer fields to touch, sensible defaults).
- MUST: never let an AI proposal become authoritative state without either explicit user
  approval or a deterministic validation rule the user has previously approved as a standing
  rule.

### Beneficiary allocation

- MUST: support allocating a single expense across multiple beneficiaries using at least:
  equal, exact amount, percentage, item-based, quantity-based, and custom methods.
- MUST: support a single payment producing multiple conceptual expenses (e.g. one Blinkit
  order containing a personal item and a flat item).
- MUST: support a single expense having multiple beneficiaries with different amounts (e.g. an
  unequal restaurant split).
- MUST: support beneficiaries that are individual people, groups, or a mix.

### Expense occasions

- MUST (domain-level; deferred in implementation): support grouping multiple related payments
  (e.g. dinner + dessert + cab home) under one occasion, without requiring every payment to
  belong to an occasion.

### Settlement & Splitwise

- MUST: compute, deterministically, who owes whom and how much, from approved allocations.
- MUST: never create or modify a Splitwise expense from unapproved AI output.
- MUST: store the external Splitwise identifier for any synced expense, for traceability.
- LATER: bidirectional sync (pulling Splitwise-side changes back into the ledger).

### Reconciliation

- MUST: compute, for a period: total outflow, non-expense movements (transfers, investments),
  explained expense total, and the resulting unexplained amount.
- MUST: detect and surface disagreement between the internal ledger and Splitwise balances.
- LATER: reconciliation against live bank/card account balances.

### Auditability

- MUST: record timestamp, actor, old value, new value, source, and reason for changes to
  approved financial data (allocations, settlements, classifications once approved).
- MUST: record AI/model information and confidence alongside any AI-derived field that
  influenced a financial decision.

## Non-functional requirements

- **Correctness over cleverness.** A financial total must always be independently
  recomputable from source evidence and approved decisions; the system must never require
  "trusting" a cached or AI-derived number.
- **Determinism.** Identical inputs (evidence + approved decisions) must always produce
  identical arithmetic outputs. No AI call is on the critical path for arithmetic.
- **Explainability.** Every number the system shows must be traceable, in the UI or API, back
  to the evidence and decisions that produced it.
- **Low operational complexity.** This is a personal project. Prefer a single deployable
  service and a managed/simple database over distributed infrastructure. See
  `docs/architecture/system-architecture.md`.
- **Data privacy.** Real financial data (statements, receipts, account numbers, UPI IDs) never
  enters source control, logs, or third-party AI calls without redaction. See
  `docs/security/security-model.md`.
- **Extensibility without coupling.** New sources (a new bank, a new merchant) or new sync
  targets (something other than Splitwise) must be addable via an adapter, without changes to
  the domain model or to unrelated adapters.
- **Testability.** All financial calculation logic must be unit-testable in isolation from I/O,
  AI calls, and UI.

## Explicitly out of scope for the foundation phase

- Any UI beyond a framework-mandated placeholder.
- Real bank, card, or Splitwise account connections.
- Database migrations (schema is designed and reviewed first; see
  `docs/architecture/database-design.md`).
- Analytics and natural-language interface (both `LATER`, end of roadmap).
