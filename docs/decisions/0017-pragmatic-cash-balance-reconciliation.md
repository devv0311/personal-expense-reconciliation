# ADR-0017. Pragmatic cash-balance reconciliation

**Status:** Accepted (2026-09-05); **implemented in Phase 16 (2026-09-06)** — persistence, the
classification lifecycle, direction/evidence validation and per-account snapshots all ship in
migration `0007_phase16_cash_flow_and_item_refunds.sql`, `src/domain/cash-flow.ts`,
`src/domain/cash-balance.ts`, `src/services/cash-flow-service.ts` and `runReconciliation`.
Phase 17 supplies richer evidence matching; Phase 21 exposes the account waterfall and the way a
human supplies evidenced statement boundaries, so a run given none produces honestly
`incomplete` snapshots today.

**Identity:** Cite this ADR by its full filename or as **ADR-0017 (cash balance)**.
The older [0017 integration-test decision](0017-integration-test-database.md) remains accepted
and unchanged. The requested decision number is retained without replacing that history.

## Context

[ADR-0015](0015-inflow-reconciliation-out-of-scope-v1.md) deliberately excluded ordinary
credits, and [ADR-0016](0016-reconciliation-outflow-scoping.md) correctly scoped the existing
identity to the user's observed outflow. That answers how outflow was explained, but cannot
prove that a complete bank statement reconciles from its opening balance to its closing
balance. Salary, interest, received settlements, refunds and transfers all affect cash even
when they are not new spending. A verified **₹0 Unaccounted Delta** needs both bank arithmetic
and an evidence-backed explanation of the movements; merely subtracting imported totals from
each other cannot establish completeness.

## Decision

Introduce pragmatic cash-balance reconciliation alongside the existing outflow report.
Partially supersede ADR-0015's exclusion of ordinary credits and extend ADR-0016 without
changing its formula, field meanings, historical snapshots or callers. ADR-0027's debit-only
classification remains a description of Phase 8, not a restriction on the new classification
path. General budgeting, tax calculation/filing, income analytics and investment valuation
remain outside the core. No `Income` entity or general accounting subsystem is required.

### Payment classification

Add nullable `Payment.cash_flow_category` with the following exact enum values. It describes
the movement's role; `counterparty_type` continues to describe who is on the other side.
Neither field replaces `Expense`, `Settlement`, `ExpenseAdjustment`, or evidence of ownership.

| Category            | Valid direction     | Required interpretation before approval                                                                                                                                                   |
| ------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PEER_SETTLEMENT`   | `debit` or `credit` | A person repaying an existing obligation; references approved `Settlement` attribution, never a new allocation. A person counterparty alone is insufficient.                              |
| `REFUND`            | `credit`            | Money returned against an existing expense, linked to `ExpenseAdjustment`; covers merchant refunds and third-party reimbursements, whose distinction remains in `ExpenseAdjustment.kind`. |
| `INTERNAL_TRANSFER` | `debit` or `credit` | Movement between the user's own accounts; `counterparty_type = internal_account`, with explicit account ownership and transfer evidence.                                                  |
| `EXTERNAL_INFLOW`   | `credit`            | An approved external credit not explained by settlement, refund/reimbursement or own-account transfer; salary and interest need no budgeting or tax taxonomy.                             |

This enum is deliberately not a replacement expense taxonomy. Ordinary purchase debits and
investment-purchase debits retain their existing classification and links, with this field
null. Null is also allowed during import/review, but **an unclassified credit is unexplained**.
`EXTERNAL_INFLOW` must never be an automatic catch-all used to close a discrepancy. An
unresolved counterparty is allowed during normalization; approval requires enough evidence to
validate the chosen role, without inventing a `Person` for a merchant or employer.

The conceptual cash-flow classification lifecycle is:

```text
IMPORTED → NORMALIZED → CASH_FLOW_CLASSIFIED → APPROVED
```

This is an additional interpretation lifecycle, not a rewrite of immutable payment facts or
the legacy `Payment.state` (`imported | normalized | linked | ignored`). Phase 16 must model
the classification state explicitly alongside that state, with audited proposal/approval
transitions. `CASH_FLOW_CLASSIFIED` is a validated proposal; only an explicit human decision
or an applicable previously approved rule makes it `APPROVED`. Rejection returns it to review;
reclassification creates an audited new decision. Backfill must not guess approvals from
`linked` or from model confidence. Ordinary debits can complete this lifecycle with null
category and their approved existing spend/investment explanation.

Existing mixed expense/settlement payments remain valid under their existing amount ceilings.
A single category cannot prove that the whole payment is a settlement: retain the underlying
portion links and expose any remainder. Mixed or ambiguous movements require explicit review;
never split or alter the source `Payment` merely to fit an enum.

### ReconciliationAccountSnapshot

Add one immutable `ReconciliationAccountSnapshot` per `(reconciliation_run_id, account_id)`.
It belongs to an `Account` and a `ReconciliationRun`; it is a SYSTEM report derived from
SOURCE evidence and approved interpretations, not an editable balance authority.

| Field                                                                                | Meaning                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `reconciliation_run_id`, `account_id`, `currency`                              | Identity, parent run, owned account and INR currency.                                                                                                                           |
| `period_start`, `period_end`                                                         | Same bounded interval as the parent run; use an explicit timezone and half-open interval `[start, end)` for posted movements.                                                   |
| `opening_balance`, `closing_balance`                                                 | Actual statement balances at the interval boundaries; `closing_balance` is the identity's `actual_ending_balance`. Nullable when evidence is missing, never fabricated as zero. |
| `opening_balance_evidence_id`, `closing_balance_evidence_id`                         | References to immutable `Evidence`, with source page/row or boundary locator in the retained provenance. A single statement may support both.                                   |
| `total_debits`, `total_credits`                                                      | Positive-magnitude totals of distinct actual posted account movements in the interval, including transfers, investments, refunds and settlements.                               |
| `internal_transfer_debits`, `internal_transfer_credits`                              | Subsets of the above totals, with retained pairing/payment provenance; not additional amounts to subtract or add.                                                               |
| `explained_debits`, `unexplained_debits`, `explained_credits`, `unexplained_credits` | Direction-specific coverage of the movement totals by approved, non-overlapping explanations; partial attribution leaves a visible remainder.                                   |
| `expected_ending_balance`, `cash_balance_delta`                                      | Deterministically derived identity values, nullable until both boundary balances are evidenced. Store as the historical calculation, never user-edit.                           |
| `verification_status`, `discrepancies`, `created_at`                                 | `incomplete`, `unreconciled`, or `verified`; reasons, missing evidence, unpaired transfers and calculation/approval provenance.                                                 |

Retain the run's input payment IDs, classification decisions and transfer pair references in
its discrepancy/provenance payload so a later classification cannot reinterpret a past run.
Balances and the signed delta may be negative (e.g. overdraft); movement and explanation totals
are non-negative integer paise. Do not apply a non-negative money constraint to balances.

Missing statement pages, ambiguous period boundaries or unreliable extraction make the snapshot
`incomplete`. When inputs are complete but arithmetic or explanations disagree, it is
`unreconciled`. Only the verification conditions below permit `verified`.

### Dual reconciliation identities

Keep ADR-0016's identity and scope exactly:

```text
ledger_unexplained_total = ledger_total_outflow - ledger_transfers_total
                         - ledger_investments_total - ledger_settlements_total
                         - ledger_explained_total
```

The legacy report excludes ignored payments; explained expenses are self-funded and net of
adjustments; settlement totals contain debit-carried settlements only. Store negative results
as integrity signals, never clamp them. This figure is not the new cash-balance delta.

Add the second identity independently for each account:

```text
expected_ending_balance = opening_balance + credits - debits
cash_balance_delta = actual_ending_balance - expected_ending_balance
verified bank arithmetic requires cash_balance_delta = 0

credits = total_credits
debits = total_debits
actual_ending_balance = closing_balance
total_debits = explained_debits + unexplained_debits
total_credits = explained_credits + unexplained_credits
```

A ₹1,000 purchase followed by a ₹200 refund contributes ₹1,000 debit and ₹200 credit,
once each. Explain the debit from its gross payment funding links, and the credit from its
adjustment links; do not net the purchase in cash arithmetic and then count its refund again.
The legacy net-expense report remains independently visible, including any non-zero residual.
An externally funded expense has no user-account movement; do not fabricate a Payment for it
or for an evidence-first adjustment whose cash has not been observed.

### Invariants 17.1–17.7

1. **17.1 — Orthogonal, exclusive interpretation.** `cash_flow_category` and
   `counterparty_type` answer different questions. Each attributed paise is explained once,
   not once per evidence record or classification. Existing expense/settlement/refund entities
   and amount ceilings remain authoritative; a category label alone never creates them.
2. **17.2 — Direction/category validation.** Enforce the category table above before approval.
   Debit refunds/external inflows are invalid; peer settlements require person/obligation
   attribution; internal transfers require owned-account evidence. Unclassified credits and
   unsupported proposals remain reviewable and unexplained. Enforce row-local constraints in
   the database and cross-record validations in deterministic transactional services.
3. **17.3 — Cash-neutral internal transfers.** Count both genuine legs once in their respective
   accounts. For matched same-currency legs within the same consolidated account/period scope,
   internal-transfer credits minus debits equals zero. Never count them as expenses, income,
   peer debt or twice in the balance equation. If a leg is missing, outside scope, or posts in
   another period, surface an unmatched/in-transit transfer; never invent a balancing leg or
   force a period-neutral total. Fees are separately evidenced debits, not hidden in the pair.
4. **17.4 — Both identities remain distinct.** Preserve ADR-0016 and its backward-compatible
   fields. Derive account cash balances from actual gross debits/credits, not net expenses,
   allocations or Splitwise balances. Display signed deltas without tolerance or clamping;
   never alter a statement balance to make either identity zero.
5. **17.5 — Evidence-backed statement boundaries.** Opening and closing balances must trace
   to immutable statement evidence for the same account, currency and interval. Missing or
   inferred boundaries are not verified facts. Human confirmation must cite evidence; AI
   extraction alone is a proposal. Never derive the actual closing balance from the same
   transaction total it is meant to independently check.
6. **17.6 — Completeness and no hidden residuals.** Include every distinct statement movement,
   even when unclassified or excluded from spending. Exclude duplicate representations, not a
   genuine transfer's second leg. Legacy `ignored`/`out_of_scope` does not justify dropping a
   real bank movement from cash reconciliation. Verify only when every included account has
   evidenced boundaries, `cash_balance_delta = 0`, both unexplained amounts zero, and no
   unresolved coverage/transfer discrepancy. Opposite account deltas cannot cancel into a
   verified consolidated result. A numeric zero with unknown transactions is not verified
   **₹0 Unaccounted Delta**; the legacy outflow and Splitwise checks remain separately visible.
7. **17.7 — Deterministic, auditable snapshots.** Compute in integer minor-unit `bigint`, using
   the existing single financial engine. Preserve source Payments and evidence; deduplicate
   deterministically. Snapshot creation and classification decisions are audited. Later data
   produces a new run, never edits historical totals. Enforce arithmetic identities as
   persistence constraints and verify membership, provenance and completeness in services.

## Consequences

Phase 16 adds Drizzle migrations, enums/types, snapshot persistence, classification transitions,
deterministic cash reconciliation and tests. Phase 17 supplies richer evidence matching;
Phase 21 exposes the account waterfall with drill-through from every number to its evidence.
Existing outflow functions and callers must retain their current behavior. Backfill preserves
unknowns and existing ignored reasons for explicit cash-scope review; it cannot certify old
runs retroactively.

Required coverage includes exact closure, missing and duplicate movements, unknown credits,
partial explanation, missing statement balances, refunds across periods, negative deltas and
overdrafts, matched and unpaired transfers, fees, mixed payment portions and offsetting errors
across accounts. No implementation is claimed by acceptance of this document.

## Alternatives considered

- Keep outflow-only reconciliation: insufficient to verify statement closing cash.
- Build general budgeting/income/tax accounting: expands the product beyond its reconciliation
  purpose without making the cash identity more reliable.
- Replace the legacy identity or net refunds before totaling bank movements: breaks existing
  semantics and can double-count credits.
- Default all unknown credits to external inflow or synthesize closing balances: produces a
  cosmetic zero instead of an evidence-backed result.
