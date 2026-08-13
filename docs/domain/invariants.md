# Invariants

These are the rules the system must never violate. Each is stated, justified, and — where it
constrains implementation — pointed at the entity/service responsible for enforcing it. This
list is the primary input to `docs/testing/testing-strategy.md`'s required test coverage.

## Identity and non-collapse

1. **Payment ≠ Expense ≠ Receipt.** No code path may assume a 1:1 relationship between these.
   _Why:_ the single most common real-world case (a Blinkit basket, a deposit-then-balance
   purchase) breaks a 1:1 assumption immediately. _Enforced by:_ `PaymentExpenseLink`,
   `Receipt.evidence_id` (not `Receipt.payment_id` as a hard requirement).

2. **Beneficiaries are not a boolean.** `is_shared = true/false` is not an acceptable
   representation anywhere. _Why:_ it can't express who, how much, or by what method. _Enforced
   by:_ `Allocation` + `AllocationLine` always required once an expense is `APPROVED`, even for
   `relationship_type = personal` (trivial 100%-to-self allocation).

3. **Evidence, inference, and decision are distinct.** A field's classification
   (SOURCE/DERIVED/APPROVED) determines who may write it and whether the write is audited.
   _Enforced by:_ the service layer, not by convention — see
   `docs/architecture/system-architecture.md`.

## Immutability and traceability

4. **Raw imported evidence is never overwritten.** `Payment.amount/occurred_at/raw_description`
   and `Evidence.storage_ref/raw_text` are write-once. Corrections produce new derived records.
   _Why:_ if the source can silently change, nothing built on top of it can be trusted, and
   disputes ("what did the bank actually say") become unanswerable.

5. **Every financial amount is traceable to its source evidence.** An `Expense.amount` must be
   traceable through `PaymentExpenseLink` to `Payment`, and (if evidence exists) through
   `Receipt`/`Evidence`. A dangling, unsourced `Expense` is only valid while explicitly in an
   evidence-pending state (see `lifecycle.md`).

6. **Approved financial decisions do not silently change.** Once `APPROVED`, an `Expense`'s
   `relationship_type`, `amount`, or `Allocation` changes only via a new, audited decision
   (`AuditEvent`), never an in-place overwrite — including by a later, higher-confidence AI
   re-run. _Why:_ scenario `scenario-analysis.md` §24 (a correction made after the fact must be
   visible as a correction, not erase what was previously believed true).

## Money classification

7. **Transfers are not expenses.** A `Payment` with `counterparty_type = internal_account` must
   never be linked to an `Expense`, and must be excluded from all spend totals.

8. **Refunds net against the original expense.** A refund (full or partial) reduces the
   effective amount of the expense it refunds; it is not counted as unrelated income, and the
   original expense's evidence trail is preserved (the refund is a new, linked record, not an
   edit to the original).

9. **Settlement payments discharge balances; they do not create expenses.** A payment
   classified as a settlement (`relationship_type = settlement` or `is_settlement = true`)
   reduces a derived `Balance` and must never simultaneously be counted in
   `ReconciliationRun.ledger_explained_total` as new spend.

10. **Duplicate transactions must not double-count money.** Deduplication is deterministic
    wherever the evidence is conclusive (same account, amount, timestamp, and a matching
    external reference); otherwise it is surfaced as a _possible_ duplicate for human
    confirmation, never silently merged or silently kept as two.

## Allocation arithmetic

11. **Allocation lines sum to the expense amount exactly.** `sum(AllocationLine.amount) ===
Expense.amount`, after rounding. No expense may be `APPROVED` while this fails.

12. **Rounding is deterministic and documented at the point it happens.** When an equal or
    percentage split doesn't divide evenly, the remainder is assigned by a fixed, documented
    rule (e.g. largest-remainder to the payer, or explicit user choice) — never left to
    floating-point drift or silently absorbed. The exact rule is finalized when allocation
    arithmetic is implemented (`docs/roadmap.md` phase 12) and recorded here once decided.

13. **Percentage-method lines still store a resolved amount.** `AllocationLine.amount` is
    always authoritative; `percentage` is informational, so settlement math never re-derives
    from a percentage and a possibly-stale total.

14. **Item/quantity-based allocation sums must reconcile at both levels.** Sum of
    `ExpenseItem.amount` equals `Expense.amount`; sum of `AllocationLine.amount` for
    item-based lines equals the sum of the `ExpenseItem`s they reference.

## AI boundary

15. **No AI output becomes authoritative without an explicit accept/modify transition.** See
    `docs/architecture/ai-boundary.md`. This is enforced at the service layer: there is no
    write path from `AIInference.proposed_output` directly into an APPROVED-classified field.

16. **Confidence never substitutes for approval on financially consequential decisions.** A
    `high`-confidence inference still requires the `AIInference.status` transition; the
    difference confidence makes is _how much friction_ the UI puts in front of that transition
    (auto-suggested vs. blocking review), never whether it's required.

17. **A `Rule`'s auto-application is still an attributable, approved act.** Every
    `AIInference` accepted via a `Rule` records `decided_by = rule:<id>`, so a systematically
    wrong rule is fixable at its source and every transaction it touched is traceable back to
    it.

## Sync and reconciliation

18. **Splitwise is reconciled against, not trusted.** A `SplitwiseExpense` sync is one-
    directional by default (our approved data → Splitwise) until bidirectional sync is
    explicitly implemented (`docs/roadmap.md` LATER); on drift, the discrepancy is surfaced in
    a `ReconciliationRun`, and neither side is auto-corrected from the other.

19. **No Splitwise write from unapproved data.** A `SplitwiseExpense` may only be created from
    an `Expense` whose `Allocation` has reached `APPROVED`.

20. **Unexplained money is always computed, never assumed to be zero.**
    `ledger_unexplained_total = ledger_total_outflow − ledger_transfers_total −
ledger_explained_total`, computed by deterministic application code on every
    `ReconciliationRun`, and surfaced even when non-zero (especially when non-zero).

## Auditability

21. **Every mutation to APPROVED- or DERIVED-and-user-facing data writes an `AuditEvent`.**
    Not opt-in per call site — enforced structurally in the service layer so it can't be
    forgotten (see `docs/architecture/system-architecture.md`).

22. **`AuditEvent` records are append-only.** Never edited, never deleted, including for data
    the user later decides to correct — the correction is a new event, not a rewrite of
    history.
