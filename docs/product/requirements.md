# Requirements

Scope: this document lists functional and non-functional requirements at the level needed to
drive the domain model and architecture. It intentionally does not specify UI layouts or
implementation details. Requirements are tagged `MUST` (foundation-critical, informs the
domain model now) or `LATER` (real requirement, but implemented in a later roadmap phase per
`docs/roadmap.md`).

> **Revision note (2026-08).** Several requirements below were added or corrected following a
> pre-implementation architecture review. See `docs/domain/domain-model.md`'s revision note and
> ADRs 0006–0011 in `docs/decisions/`.

## Functional requirements

### Evidence ingestion

- MUST: accept UPI transaction exports, bank/card statements (CSV/XLSX/PDF), receipts
  (image/PDF), screenshots, and manually-entered explanations as evidence.
- MUST: preserve the raw imported evidence unmodified, independent of any interpretation
  derived from it.
- MUST: associate zero, one, or many evidence records with a single payment (e.g. a bank line
  plus a forwarded receipt for the same charge).
- MUST: support an expense backed only by evidence, with no payment in the user's own accounts
  at all — the case where someone else paid (**added, ADR-0006**; see "Bidirectional payer"
  below).
- LATER: automatic email/forwarding ingestion for e-receipts.

### Transaction normalization

- MUST: normalize heterogeneous source formats into one consistent payment representation
  without discarding source-specific fields.
- MUST: represent amount, currency, timestamp, direction (inflow/outflow), source account, and
  a raw description field for every payment.
- MUST: extract and store a structured external reference (UPI UTR/RRN, bank reference, card
  reference, merchant order ID, cheque number) where the source format provides one, distinct
  from the raw description (**added, ADR-0010**).

### Bidirectional payer

- MUST: represent, for every expense, who actually fronted the money (`paid_by_person_id`) —
  the user in the common case, but explicitly representable as someone else (a flatmate, a
  friend) without fabricating a payment record that never happened (**added, ADR-0006**).
- MUST: compute obligations and balances as a general function between any two people, not only
  "the user vs. someone else" — required so that an obligation between two people other than the
  user (e.g. two flatmates) is still representable, even though it can never be *settled* via a
  `Payment` this system observes — a deliberate observability boundary, not a gap
  (`invariants.md` #9b, `docs/domain/scenario-analysis.md` §34). MUST additionally surface,
  read-only, whether ledger-confirmed settlement evidence exists for such a pair
  (`domain.obligationEvidenceStatus`, **added this revision**) rather than only showing a bare
  balance figure.

### Classification

- MUST: propose, for each payment, whether it represents a new expense or the settlement of an
  existing debt, before proposing what kind of expense it is (**revised, ADR-0007** — the
  original requirement treated `settlement` as one of several expense-purpose values; it no
  longer is).
- MUST: propose a purpose/category for each new expense (personal, shared, paid-on-behalf,
  gift, household) with a confidence level.
- MUST: distinguish a transfer between the user's own accounts from an expense.
- MUST: distinguish an investment payment (e.g. a mutual fund purchase) from an expense
  (**added, ADR-0011**).
- MUST: distinguish a refund or third-party reimbursement, applied against an existing expense,
  from a new inflow of income, and from a settlement of a person-to-person debt (**revised,
  ADR-0008** — refund and reimbursement are now the same mechanism, distinct from settlement).
- MUST: flag likely duplicate transactions rather than silently deduplicating them when the
  evidence is not conclusively deterministic; a matching, non-null external reference on both
  sides plus matching amount/timestamp *is* conclusive, **without also requiring the two
  payments to be on the same account** — the same real-world transaction can be captured under
  two different `Account` rows by two different import channels (e.g. a bank CSV vs. a UPI
  export) (**revised, ADR-0010; account-match requirement removed in the implementation-
  readiness pass**).

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
- MUST: support a single expense funded across more than one payment (e.g. a deposit paid
  first, the balance paid later) — the symmetric case to the one above, equally required by the
  `PaymentExpenseLink` many-to-many design (`domain-model.md`).
- MUST: support a single expense having multiple beneficiaries with different amounts (e.g. an
  unequal restaurant split).
- MUST: support beneficiaries that are individual people, groups, or a mix — but a group
  beneficiary must always be resolvable to individual people's shares before it can be settled
  or synced to Splitwise, snapshotted as of the expense's date so a later membership change
  never retroactively alters it (**added, ADR-0009**).

### Expense occasions

- MUST (domain-level; deferred in implementation): support grouping multiple related payments
  (e.g. dinner + dessert + cab home) under one occasion, without requiring every payment to
  belong to an occasion.

### Settlement & Splitwise

- MUST: record a settlement (a payment that discharges an existing obligation) without treating
  it as new spending or requiring it to have beneficiaries of its own (**revised, ADR-0007**).
- MUST: compute, deterministically, who owes whom and how much, from approved allocations, in
  either direction.
- MUST: never create or modify a Splitwise expense or settlement from unapproved AI output.
- MUST: store the external Splitwise identifier for any synced expense or settlement, for
  traceability.
- MUST: never send a `Group` as the debtor/creditor in a Splitwise sync call — always the
  resolved individual people (**added, ADR-0009**).
- LATER: bidirectional sync (pulling Splitwise-side changes back into the ledger).

### Reconciliation

- MUST: compute, for a period: total outflow, non-expense movements (transfers, investments,
  settlements), explained expense total (net of any refunds/reimbursements), and the resulting
  unexplained amount (**revised, ADR-0007, ADR-0008, ADR-0011** — the original formula omitted
  investments and settlements entirely and summed gross rather than net expense amounts).
- MUST: detect and surface disagreement between the internal ledger and Splitwise balances, and
  distinguish "Splitwise's side changed" (`drifted`) from "our own side changed since the last
  sync" (`stale`) (**added, ADR-0008**).
- LATER: reconciliation against live bank/card account balances.
- OUT OF SCOPE FOR V1, explicit boundary (not an open question — **resolved this revision**):
  symmetric inflow-side reconciliation — was every credit explained (refund, reimbursement,
  settlement received, or genuinely unexplained income)? The current formula is deliberately
  outflow-scoped only; nothing in the schema blocks adding this later
  (`docs/domain/domain-model.md`'s `ReconciliationRun` "V1 scope, explicit", `docs/roadmap.md`).

### Auditability

- MUST: record timestamp, actor, old value, new value, source, and reason for changes to
  approved financial data (allocations, settlements, adjustments, classifications once
  approved).
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
- Investment *performance* tracking (valuation, gains/losses) — only the outflow-classification
  side of investments is in scope (**clarified, ADR-0011**).
- A settlement record for a debt between two people, neither of whom is the user — an
  observability boundary, not a modeling gap (`invariants.md` #9b): structurally unobservable by
  this system's own `Payment` data, with `domain.obligationEvidenceStatus` (added this revision)
  as the documented, read-only mitigation; see `docs/domain/scenario-analysis.md` §34.
- A general income/inflow accounting system (classifying and reconciling ordinary, untracked
  credits) — see the Reconciliation section above.
