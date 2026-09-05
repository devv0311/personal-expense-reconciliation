# Architecture Decision Records

> **Numbering exception (2026-09-05).** The product decisions requested as ADR-0017
> (cash balance) and ADR-0018 (item refunds) share numbers with two older accepted records.
> Both older files and their historical references remain valid. New references must use
> the title or full linked filename; a bare 0017/0018 in older code/docs means integration
> tests/manual-note semantics respectively. Do not substitute one for the other or overwrite
> either file. Future new ADRs continue after the highest existing number (currently 0045).

This directory records non-trivial technical and domain decisions and why they were made, so
future sessions (human or Claude) don't silently re-litigate or accidentally reverse them.

## When to add one

Add an ADR when a decision:

- Chooses between two or more real alternatives that both would have worked (naming a class is
  not an ADR; choosing Drizzle over Prisma is).
- Would be expensive or risky to reverse later (schema shape, entity boundaries, sync
  direction with an external system).
- Rejects an approach the brief or an obvious instinct would suggest, and future readers need
  to know it was considered, not missed.

## Format

Copy `0001-record-architecture-decisions.md` as a template. Each ADR has: `Status`
(`proposed | accepted | superseded by NNNN`), `Context`, `Decision`, `Consequences`, and
`Alternatives considered`.

## Current product extensions

| ADR                                                                  | Decision                                                    | Status                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [0017 (cash balance)](0017-pragmatic-cash-balance-reconciliation.md) | Pragmatic cash-balance reconciliation, invariants 17.1–17.7 | Accepted; implemented in Phase 16; partially supersedes 0015, preserves 0016    |
| [0018 (item refunds)](0018-item-level-refund-attribution.md)         | Item-level refund attribution, invariants 19.1–19.6         | Accepted; schema/attribution shipped in Phase 16, allocation engine in Phase 18 |

## Historical and implementation index

| ADR                                                                   | Title                                                                          | Status                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| [0001](0001-record-architecture-decisions.md)                         | Record architecture decisions                                                  | Accepted                                                     |
| [0002](0002-technology-stack.md)                                      | Technology stack                                                               | Accepted                                                     |
| [0003](0003-relational-database.md)                                   | Relational database over document/NoSQL                                        | Accepted                                                     |
| [0004](0004-beneficiary-settlement-modeling.md)                       | Fold Beneficiary/Classification/Decision/Settlement into fewer tables          | Accepted — settlement paragraph partially superseded by 0007 |
| [0005](0005-single-repo-no-microservices.md)                          | Single deployable service, no microservices                                    | Accepted                                                     |
| [0006](0006-bidirectional-payer-model.md)                             | Explicit `paid_by_person_id` — bidirectional payer model                       | Accepted                                                     |
| [0007](0007-settlements-as-events-not-expenses.md)                    | Settlements are Payment-linked events, not Expenses                            | Accepted                                                     |
| [0008](0008-refunds-and-reimbursements-as-adjustments.md)             | Refunds and reimbursements are linked adjustment events                        | Accepted                                                     |
| [0009](0009-group-allocation-expansion-snapshot.md)                   | Group-beneficiary allocation lines get a per-member expansion snapshot         | Accepted                                                     |
| [0010](0010-payment-external-reference-fields.md)                     | Payment external-reference fields for deduplication                            | Accepted                                                     |
| [0011](0011-investments-in-scope-as-non-expense-payments.md)          | Investments in scope as a non-expense payment classification                   | Accepted                                                     |
| [0012](0012-deterministic-money-rounding.md)                          | Deterministic money rounding — Largest Remainder Method                        | Accepted                                                     |
| [0013](0013-full-refund-preserves-allocation-shape.md)                | Full refund's current allocation keeps zero-amount lines, not an empty set     | Accepted                                                     |
| [0014](0014-obligation-evidence-status.md)                            | Non-user settlement observability — `ObligationEvidenceStatus`                 | Accepted                                                     |
| [0015](0015-inflow-reconciliation-out-of-scope-v1.md)                 | Inflow/income reconciliation explicitly out of scope for V1                    | Partially superseded by 0017 (cash balance)                  |
| [0016](0016-reconciliation-outflow-scoping.md)                        | `ledger_explained_total`/`ledger_settlements_total` scoped to outflow          | Accepted                                                     |
| [0017](0017-integration-test-database.md)                             | Integration tests: real Postgres in CI, PGlite locally                         | Accepted                                                     |
| [0018](0018-manual-note-signal-ambiguity.md)                          | `evidence.note_kind` distinguishes documentation from a settlement claim       | Accepted                                                     |
| [0019](0019-import-time-duplicate-handling.md)                        | Dedup matches on direction; a confirmed duplicate ignores from `imported`      | Accepted                                                     |
| [0020](0020-reference-type-as-channel-evidence.md)                    | `reference_type`, not the description, is the evidence for `channel`           | Accepted                                                     |
| [0021](0021-normalization-acts-only-on-imported-payments.md)          | Normalization acts only on `imported` payments, so a re-run is a no-op         | Accepted                                                     |
| [0022](0022-phase-7-deterministic-only-scope.md)                      | Phase 7 ships normalization's deterministic leg only; the AI leg is phase 8    | Accepted                                                     |
| [0023](0023-self-transfer-recognition-is-deterministic.md)            | Recognising a self-transfer is deterministic, not an AI proposal               | Accepted                                                     |
| [0024](0024-confidence-routes-review-never-approves.md)               | Confidence routes a proposal to review; nothing in phase 8 auto-approves       | Accepted                                                     |
| [0025](0025-injected-model-transport.md)                              | The model transport is injected; phase 8 wires no provider                     | Accepted                                                     |
| [0026](0026-classification-writes-a-derived-expense.md)               | A classification proposal writes a DERIVED Expense; a settlement waits         | Accepted                                                     |
| [0027](0027-classification-covers-debits-only.md)                     | Phase 8 classifies debits; a credit is deliberately left unclassified          | Accepted                                                     |
| [0028](0028-rejected-proposal-expense-state.md)                       | A declined or superseded proposal's Expense becomes `rejected`, terminal       | Accepted                                                     |
| [0029](0029-review-queue-ordering.md)                                 | The review queue is ordered by a pure function, and carries every reason       | Accepted                                                     |
| [0030](0030-reclassification-is-an-explicit-review-action.md)         | Re-classification is an explicit review action; a re-run stays a no-op         | Accepted                                                     |
| [0031](0031-possible-duplicate-review.md)                             | A possible duplicate is confirmed or dismissed by a human, both recorded       | Accepted                                                     |
| [0032](0032-web-standard-route-handlers-without-nextjs.md)            | The API ships as Web-standard route handlers, without installing Next.js       | Accepted                                                     |
| [0033](0033-content-addressed-evidence-storage.md)                    | Evidence documents are content-addressed, behind a port with one adapter       | Accepted                                                     |
| [0034](0034-evidence-linkage-is-write-once.md)                        | Evidence linkage may be filled in once, and never rewritten                    | Accepted                                                     |
| [0035](0035-unmatched-evidence-is-a-review-kind.md)                   | An unmatched document is a review kind ranked last, carrying no proposal       | Accepted                                                     |
| [0036](0036-receipt-extraction-writes-derived-rows-directly.md)       | Receipt extraction writes DERIVED rows directly, confirmation is a boolean     | Accepted                                                     |
| [0037](0037-receipt-payment-matching-surfaces-candidates-only.md)     | Receipt-to-payment matching surfaces candidates only, never auto-links         | Accepted                                                     |
| [0038](0038-phase-12-scope-is-api-surface-and-expenseitem.md)         | Phase 12 is an API surface + ExpenseItem write path, not a new engine          | Accepted                                                     |
| [0039](0039-phase-13-scope-is-balance-exposure-and-ledger-listing.md) | Phase 13 is `getBalance` exposure + a new ledger listing, not a new engine     | Accepted                                                     |
| [0040](0040-phase-14-scope-is-first-sync-not-full-lifecycle.md)       | Phase 14 delivers the first Splitwise sync, not the full sync lifecycle        | Accepted                                                     |
| [0041](0041-reconciliation-drift-detection-scope.md)                  | Reconciliation drift detection: `fetchBalances`, comparison, `drifted`         | Accepted                                                     |
| [0042](0042-frontend-stack-and-server-bridge.md)                      | Frontend stack (Next.js), and a real process to run the API behind it          | Accepted                                                     |
| [0043](0043-frontend-design-system-and-component-primitives.md)       | A frontend design system, and hand-owned component primitives without Radix    | Accepted                                                     |
| [0044](0044-evidence-observations-and-match-candidates.md)            | Context re-attachment records a reading and explained candidates, never a link | Accepted                                                     |
| [0045](0045-item-refund-allocation-is-rebuilt-not-decremented.md)     | The item-refund allocation is rebuilt from recorded facts, never decremented   | Accepted                                                     |
