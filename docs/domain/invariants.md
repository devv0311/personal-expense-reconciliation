# Invariants

> **Current extensions (2026-09-06).** Read the additional cash-balance invariants 17.1–17.7
> and item-refund invariants 19.1–19.6 at the end of this document. These are ADR-scoped
> identifiers, not replacements for existing integer-numbered invariants #17 or #19.
> New item refunds use net item costs before allocation; legacy whole-expense adjustment
> distribution and ADR-0016's outflow identity remain supported.
>
> Phase 16 (2026-09-06) enforces all thirteen: the row-local halves as `CHECK` constraints in
> `src/db/schema.ts`, the cross-record halves in `src/domain/cash-flow.ts`,
> `src/domain/cash-balance.ts` and `src/domain/refund-attribution.ts`, called from
> `services.approvePaymentCashFlow`, `runReconciliation` and `recordExpenseAdjustment`. The one
> part deferred by design is 19.5's _allocation_ consequence — recomputing beneficiary shares
> from net item costs is Phase 18's engine; 19.5's immutability half (original items and gross
> expense never change) holds today.

These are the rules the system must never violate. Each is stated, justified, and — where it
constrains implementation — pointed at the entity/service responsible for enforcing it. This
list is the primary input to `docs/testing/testing-strategy.md`'s required test coverage.

> **Revision note (2026-08).** Several invariants below were corrected during a pre-implementation
> architecture review that found them contradicting each other or the reference fixtures. Changed
> invariants are marked **(revised)** with a pointer to the relevant ADR. See
> `docs/domain/domain-model.md`'s revision note for the full context.
>
> **Further revision note (2026-08, implementation-readiness pass).** Invariant #10 corrected to
> drop a same-`account_id` requirement that made it unbuildable for its own cited scenario
> (ADR-0010's amendment) — found while auditing `fixtures/duplicate-transaction.json` against it.
> Invariant #12 is now the fully finalized rounding rule (ADR-0012), no longer "to be decided at
> implementation." New: #9b (non-user settlement observability boundary, ADR-0014), #12a
> (negative-line protection, the full-refund shape, ADR-0013).

## Identity and non-collapse

1. **Payment ≠ Expense ≠ Receipt.** No code path may assume a 1:1 relationship between these.
   _Why:_ the single most common real-world case (a Blinkit basket, a deposit-then-balance
   purchase) breaks a 1:1 assumption immediately. _Enforced by:_ `PaymentExpenseLink`,
   `Receipt.evidence_id` (not a direct `Receipt.payment_id` — see `domain-model.md`'s `Receipt`
   section for the corrected relationship description).

2. **Beneficiaries are not a boolean.** `is_shared = true/false` is not an acceptable
   representation anywhere. _Why:_ it can't express who, how much, or by what method. _Enforced
   by:_ `Allocation` + `AllocationLine` always required once an **Expense** reaches `APPROVED`,
   even for `relationship_type = personal` (trivial 100%-to-payer allocation). **(Scope narrowed,
   ADR-0007):** this invariant applies to `Expense` only. `Settlement` is not an `Expense` and
   never has an `Allocation` — see invariant #9a. This removes the contradiction the original,
   unscoped wording created against the settlement fixture.

2a. **A non-payer beneficiary line is an obligation; the payer's own line is not.** On a
debt-creating `Expense` (`relationship_type ∈ {shared, paid_on_behalf,
    household_shared_flat}`), an `AllocationLine` (or, for a group line, an
`AllocationLineGroupExpansion` row — see #2b) whose beneficiary is `Expense.paid_by_person_id`
represents that person's own share and creates no obligation; every other line's beneficiary
owes `paid_by_person_id` — not necessarily the user — the line's amount. _Why:_ added per
ADR-0006 so the model can represent someone other than the user fronting money.
_Enforced by:_ `domain.computeBalance()`.

2b. **A `group`-typed `AllocationLine` is not itself an obligation; its expansion is.** Before an
`Expense` with a `group`-typed line can be considered `ALLOCATED`, a corresponding
`AllocationLineGroupExpansion` must exist, resolving `GroupMembership` as of
`Expense.occurred_at` into individual per-person shares summing to the line's amount. `Balance`
and Splitwise sync always read the expansion, never the raw group line — a `Group` can never
be a debtor or creditor. _Why:_ added per ADR-0009; real settlement and Splitwise sync both
require an individual person, not a group, on the other end. _Enforced by:_
`services.approveAllocation()` (writes the expansion), `domain.computeBalance()` and
`services.proposeSplitwiseSync()` (read only the expansion for group lines).

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
   traceable through `PaymentExpenseLink` to `Payment` for a **self-funded** expense, or through
   `Evidence` alone for an **externally-funded** expense (`paid_by_person_id != ` the user — added
   per ADR-0006; this is not a gap, it's the expected shape for money the user never personally
   moved), and (if evidence exists) through `Receipt`/`Evidence`. A dangling, unsourced `Expense`
   with no `Evidence` at all is only valid while explicitly in an evidence-pending state (see
   `lifecycle.md`).

6. **Approved financial decisions do not silently change.** Once `APPROVED`, an `Expense`'s
   `relationship_type` or `Allocation` changes only via a new, audited decision (`AuditEvent`),
   never an in-place overwrite — including by a later, higher-confidence AI re-run. **`amount` is
   stronger than this: it never changes at all, full stop, by any mechanism, once `APPROVED`
   (revised per ADR-0008)** — a correction to what something actually cost is a new
   `ExpenseAdjustment` referencing the expense, not a mutated `amount`, so the original historical
   fact stays intact even under audit. _Why:_ `scenario-analysis.md` §24 (a correction made after
   the fact must be visible as a correction, not erase what was previously believed true) plus the
   explicit "preserve the original financial event" requirement behind ADR-0008.

## Money classification

7. **Transfers and investments are not expenses.** A `Payment` with `counterparty_type =
internal_account` or `counterparty_type = investment_instrument` (added per ADR-0011) must
   never be linked to an `Expense`, and must be excluded from all spend totals. Neither is
   required to ever reach `Payment.state = linked` or `ignored` — staying at `normalized` is a
   valid terminal state for both, since exclusion is driven by `counterparty_type` directly, not
   by `state` (clarified per ADR-0011).

8. **Refunds and reimbursements net against the original expense, without mutating it.** A
   refund or reimbursement (full or partial) is recorded as an `ExpenseAdjustment` referencing
   the original `Expense` (**revised per ADR-0008** — the original design created a second
   `Expense` via `refund_of_expense_id`, which is removed). `domain.netAmount(expense)` —
   `expense.amount` minus the sum of its `ExpenseAdjustment`s — is what spend totals and the
   current `Allocation` must agree on (invariant #11); it is not counted as unrelated income, and
   the original expense's `amount` and evidence trail are preserved exactly, unmutated
   (invariant #6). A **full** refund/reimbursement (`netAmount` reaches exactly 0) does not
   collapse the current `Allocation` to zero lines or erase who originally benefited — see
   invariant #12a and `domain-model.md`'s "Full refunds, resolved" for the deterministic shape
   (one zero-amount line per original beneficiary) and what it preserves. `ExpenseAdjustment`
   is always a positive magnitude; it is never used to represent a post-approval price increase
   — see invariant #12a's "Negative adjustments" note for why that's a new `Expense` instead.

9. **Settlement payments discharge balances; they are not Expenses and do not create them.** A
   `Settlement` (its own entity as of ADR-0007, always referencing a `Payment` and a
   `counterparty_person_id`) reduces the derived `NetBalance` between the two people involved and
   must never be counted in `ReconciliationRun.ledger_explained_total` — it has its own bucket,
   `ledger_settlements_total` (invariant #20).

9a. **A `Settlement` never has an `Allocation`.** _Why:_ `Allocation` divides a spend event among
beneficiaries; a settlement isn't a spend event, it discharges an obligation a prior spend
event's `Allocation` already created. Giving it one risks double-counting the same debt (once
as the discharge, once as if it were new debt) — this is exactly what the pre-revision design
got wrong. _Enforced by:_ `Settlement` has no `allocation_id` column at all
(`database-design.md`); there is no code path that could attach one.

9b. **A `Payment` is never fabricated to make a settlement observable.** (**Added this
revision.**) When neither party to a real-world settling transaction is the user, no
`Payment` row exists for it and none may be created to paper over that fact — this is a
permanent observability boundary (`domain-model.md`'s "An observability boundary, not a
modeling failure"), not a bug to be worked around at the data layer. `Balance`,
`ReconciliationRun`, Splitwise reconciliation, and `services.recordSettlement()` must all
continue to function correctly with this boundary in place — none of them may assume every
real-world settlement is observable, none may throw or silently zero out `NetBalance` when
one isn't, and none may substitute a synthetic `Payment`/`Settlement` for a transaction this
ledger never actually saw. Where a human wants to record their _belief_ that such a debt was
cleared, that belief is captured as an `Evidence` row (`type = manual_note`,
**`note_kind = 'settlement_claim'`** — the discriminator added per ADR-0018, without which this
was indistinguishable from the documenting note ADR-0006 gives every externally-funded expense,
and every such obligation reported itself believed-settled on creation),
`linked_expense_id` set — or surfaces via a `ReconciliationRun` discrepancy against Splitwise
— both read-only signals, computed into `domain.obligationEvidenceStatus(X, Y)` (`open,
    unconfirmed | believed_settled, unconfirmed_by_ledger | settled, confirmed`) for display —
never a mutation of `NetBalance` itself, and never treated as equivalent to a real
`Settlement`.

10. **Duplicate transactions must not double-count money.** Deduplication is deterministic when
    two payments share `direction` (**added during Phase 6 — see below**), `amount`, a matching
    non-null `external_reference` (**added per ADR-0010** — the original wording promised this
    without a field to back it), and timestamps within a small window; otherwise it is surfaced
    as a _possible_ duplicate for human confirmation, never silently merged or silently kept as
    two.

    **`direction` is part of the match (added, ADR-0019).** Building the bank-statement importer
    against `fixtures/bank-statement.csv` surfaced the omission: the two legs of a transfer
    between the user's own accounts appear as two rows sharing one `external_reference`, one
    `amount` and one date, differing **only** in direction (rows 2 and 3, `NEFT/N072026001`).
    Without direction in the criteria the rule matched them and discarded half a real transfer —
    the precise opposite of "must not double-count money". Money leaving is never a duplicate of
    money arriving, so direction gates both the deterministic and the possible-duplicate paths. **`account_id` is deliberately
    not part of the match (corrected this revision — see ADR-0010's amendment)**: the same
    real-world transaction can legitimately land under two different `Account` rows in this
    schema (e.g. a bank CSV import captures a UPI payment under a `bank`-typed `Account`, while
    a UPI export captures the identical transaction under a `upi`-typed `Account` — exactly the
    case `scenario-analysis.md` §13 was written to describe). Requiring a matching `account_id`
    would have made the deterministic path structurally unreachable for that exact scenario. An
    `external_reference` (UTR/RRN/bank reference/etc.) is already a strong enough real-world
    identifier on its own, corroborated by amount and timestamp proximity, without also
    requiring the two payments to share a schema-level `Account` row.

    **`duplicate_of` names the _canonical_ payment (added, ADR-0019's amendment).** A third
    statement restating one transaction matches the original _and_ every copy already ignored
    against it, since all of them carry the same `external_reference`. The recorded
    `duplicate_of` is the head of that chain — never another ignored copy. Two reasons this is
    a rule and not a preference: a chain makes the trail from a discarded row to the surviving
    one indirect, and the copies tie on `occurred_at` (a bank CSV carries a date, not a
    timestamp), so "whichever matched first" resolves to a random UUID comparison — the same
    non-determinism that produced the audit-ordering defect fixed in ADR-0018's wake.

    **The _possible_-duplicate half is built as of phase 9 (ADR-0031).** It was the older half
    of this invariant and the unbuilt one: `domain.isPossibleDuplicate` sat with no caller from
    the foundation pass until the review queue arrived. A pair that resembles another without a
    conclusive reference match is now surfaced (`services.listReviewQueue`) and resolved by a
    human — `services.confirmPossibleDuplicate`, which moves the copy to `ignored` with the same
    `duplicate_of:<canonical>` reason the deterministic path writes, or
    `services.dismissPossibleDuplicate`, which changes neither payment and records the decision.
    Confirming re-checks the pair against the rule first: a reviewer's say-so is not evidence
    that two unrelated payments are the same money. Import-time behaviour is untouched.

    **A candidate that is itself `ignored` is still a match.** It is tempting to exclude
    ignored rows from the candidate set instead; that is wrong. A payment ignored for a
    non-duplicate reason (`out_of_scope`) is still the first copy this ledger saw, and skipping
    it would leave the restatement at `imported`, where `domain.computeUnexplained` counts it —
    turning a discarded transaction back into fresh spend, the exact double-count this
    invariant exists to prevent.

## Allocation arithmetic

11. **Allocation lines sum to the expense's net amount exactly.** `sum(AllocationLine.amount) ===
domain.netAmount(Expense)` (**revised per ADR-0008** — was `Expense.amount`; since `amount` is
    now immutable gross history, the figure the current allocation must match is the net figure
    after any `ExpenseAdjustment`s, which for an expense with no adjustments is simply
    `Expense.amount`, so this is a strict generalization, not a breaking change for the common
    case). No expense may be `APPROVED` while this fails against its current net amount.

12. **Money is always an integer minor-unit `bigint`; every split uses the Largest Remainder
    Method, with no exceptions.** (**Finalized this revision — no longer "to be determined at
    implementation."**) `payments.amount`, `expenses.amount`, `allocation_lines.amount`,
    `allocation_line_group_expansions.amount`, `expense_adjustments.amount`, `settlements.amount`,
    `receipts.subtotal/tax/total`, `receipt_items.line_total`, and every `reconciliation_runs`
    ledger total are stored as `bigint` **paise** (1 INR = 100 paise) — never a float, never a
    `numeric`/`decimal` column, anywhere in `src/domain`, at rest, or in transit. Floating-point
    arithmetic is never used to compute a monetary value at any layer.

    **The Largest Remainder Method** is the one algorithm used, everywhere a total amount `A`
    (an integer number of paise) must be divided across `N` lines by integer weights
    `w_1..w_N` (equal split: every `w_i = 1`; percentage split: `w_i` = the line's stored
    integer percentage numerator; group expansion: every `w_i = 1` across resolved members
    unless the user overrides individual shares, in which case the override values are the
    weights):

    1. `W = Σ w_i`.
    2. Each line's base share: `base_i = floor(A × w_i ÷ W)`, computed with `bigint` integer
       division — never `A × w_i / W` as a float.
    3. `remainder = A − Σ base_i` (always `0 ≤ remainder < N`).
    4. Rank lines by their fractional remainder `(A × w_i) mod W`, descending. Break exact ties
       by the line's `beneficiary_id` (or, for group expansion, `person_id`) sorted ascending as
       plain UUID text — a fixed rule that needs no extra column and depends on nothing but the
       IDs already present.
    5. Add 1 paisa each to the top `remainder`-ranked lines from step 4. Every line's final
       `amount = base_i`, plus 1 for the lines selected in step 5.

    This guarantees `Σ amount === A` exactly on every run, is fully deterministic (identical
    inputs always produce byte-identical output — no dependence on iteration order, hashing, or
    anything not listed above), and never touches a float. Implemented once as
    `domain.splitByLargestRemainder(total, weights)` and called from every site listed below —
    never re-implemented ad hoc per call site.

    **Where it applies:**
    - Equal-method `AllocationLine`s (`w_i = 1` each).
    - Percentage-method `AllocationLine`s (`w_i` = the stored percentage numerator;
      `AllocationLine.amount` is still the authoritative, stored result — invariant #13 —
      computed by this algorithm once at decision time, never re-derived from `percentage`
      later).
    - `AllocationLineGroupExpansion` rows (`w_i = 1` per resolved member, or the user's override
      shares).
    - Legacy whole-expense `ExpenseAdjustment` distribution — the adjustment amount is the `A` being divided across
      the _current_ `Allocation`'s lines; the default weight set is each line's own pre-
      adjustment `amount` (proportional-to-existing-share); a user may instead choose an
      explicit, non-proportional weight set (e.g. "this refund benefits only Dev" —
      `scenario-analysis.md` §12), subject to invariant #12a below.

    **Item refunds (ADR-0018, item refunds).** Compute the item's net cost by subtracting
    item attribution before deriving allocation. Do not apportion its refund across unrelated
    items' beneficiaries. An individually owned item supplies an exact net amount without
    division; a genuinely shared item uses this same Largest Remainder Method with its approved
    shares. Preserve the original gross `ExpenseItem.amount` and the exact net total.

    **Currency scope for V1 (also see `roadmap.md`):** the algorithm and every `domain` function
    built on it assume a single fixed minor-unit exponent (2 decimal places — 100 minor units
    per major unit) and a single currency, INR, for V1. The `currency` column already exists on
    `payments`/`expenses`/`accounts` (schema-ready for later), but `domain` does not yet branch
    on it, and mixing currencies within one `Allocation`, `Settlement`, or `Balance` computation
    is unsupported and must be rejected at the service layer, not silently coerced. A future
    multi-currency phase needs a minor-unit-exponent lookup per currency (INR/USD/EUR = 2, JPY =
    0, etc.) before this algorithm can generalize — noted as a roadmap boundary, not implemented
    now.

12a. **No `AllocationLine`/`AllocationLineGroupExpansion` amount is ever negative.** `amount >=
    0` (weakened from `> 0` this revision — see below for why zero is valid) is enforced at the
DB (`check`) and service level. The proportional-to-existing-share default distribution for
an `ExpenseAdjustment` can never violate this: its weights are the lines' own existing
non-negative shares, and `Σ ExpenseAdjustment.amount ≤ Expense.amount` (existing invariant,
see #8) guarantees the total being divided never exceeds the total being divided _from_, so
every `base_i ≥ 0` by construction. A **custom, non-proportional** distribution the user
picks explicitly (e.g. "only Dev absorbs this refund") is not automatically safe this way —
if it would drive any line below zero, the service layer **rejects it outright** with a
validation error. It never silently clamps a would-be-negative line to zero — clamping would
make the distributed amounts stop summing to the adjustment's amount, silently losing money
from the ledger's arithmetic, which is worse than refusing the input.

    **The full-refund / net-zero case, resolved (see also #6 and #11):** applying the Largest
    Remainder Method with `A = 0` against the existing beneficiary set (the proportional
    default) yields `base_i = 0` for every line and `remainder = 0` — so the deterministic,
    algorithm-driven result is **one `AllocationLine` per original beneficiary, each at `amount =
    0`**, never zero lines and never a single collapsed line. This is why `amount >= 0` replaces
    `amount > 0` this revision: a net-zero current allocation is a normal, expected output of the
    same algorithm applied everywhere else, not a special case requiring its own rule. See the
    "Full refunds" resolution in `domain-model.md`'s `ExpenseAdjustment` section for the
    complete picture, including what this means for Splitwise and analytics.

    **Negative adjustments — resolved.** `ExpenseAdjustment.amount` is always stored as a
    positive magnitude (`check (amount > 0)`, unchanged); there is no signed/negative
    `ExpenseAdjustment`. "Negative," where it matters, describes what happens to individual
    `AllocationLine` amounts during redistribution (covered above), not the adjustment record
    itself. A scenario where a merchant claws back a previously-issued refund, or bills
    *additional* money for something already `APPROVED`, is deliberately **not** modeled as a
    negative-signed `ExpenseAdjustment` — `ExpenseAdjustment` exists specifically for money
    coming back (`merchant_refund`/`third_party_reimbursement`), and `Expense.amount` is
    permanently immutable once `APPROVED` (invariant #6), so there is no field a clawback could
    write to even if it were modeled as a negative amount. A genuine post-approval additional
    charge for the same purchase is new spend and is recorded as its own new `Expense`
    (optionally linked via the same `ExpenseOccasion` or cross-referenced in `Evidence`/`reason`
    text for narrative continuity), never as an adjustment with a negative sign. This was
    evaluated and rejected as a design (signed `ExpenseAdjustment.amount`) because it would
    require every downstream consumer (`netAmount`, the Largest Remainder Method inputs,
    `ledger_explained_total`) to branch on sign, for a case (post-approval price increases on
    the same purchase) that is adequately, and more simply, represented as ordinary new spend.

13. **Percentage-method lines still store a resolved amount.** `AllocationLine.amount` is
always authoritative; `percentage` is informational, so settlement math never re-derives
from a percentage and a possibly-stale total.

14. **Item/quantity-based allocation sums must reconcile at both the whole-expense and per-item
    level.** Sum of `ExpenseItem.amount` equals `Expense.amount` (gross). Sum of
    `AllocationLine.amount` for item-based lines equals their items' derived net costs
    **in aggregate and per item**: the sum referencing any single item equals its gross amount
    less cumulative item refunds (ADR-0018, item refunds). With no adjustments this is the
    original `ExpenseItem.amount`. Separately recorded legacy whole-expense reductions require
    their explicit approved distribution and must not be silently omitted or counted twice. _Why
    tightened:_ the aggregate-only version of this invariant would pass even if allocation lines
    were attached to the wrong item (e.g. all lines pointing at a ₹1,160 item while an ₹80 item
    has none, yet the grand total still matches) — a real misallocation the aggregate check
    can't catch. _Enforced by:_ `domain.validateItemBasedLineSums()` against each item's currently
    allocatable cost, and `domain.validateItemNetLineSums()` against its net cost after item
    refunds — both checked per `expense_item_id` group, not just once for the whole expense. The
    per-item form applies while no unattributed whole-expense reduction is in play; with one, a
    line's share is its item's net cost _less_ that item's part of that reduction, which is why
    the two reductions stay separately recorded (ADR-0045).

## AI boundary

15. **No AI output becomes authoritative without an explicit accept/modify transition.** See
    `docs/architecture/ai-boundary.md`. This is enforced at the service layer: there is no
    write path from `AIInference.proposed_output` directly into an APPROVED-classified field —
    including the `expense`-vs-`settlement` `proposedKind` field added to `classifyTransaction`'s
    output per ADR-0007.

16. **Confidence never substitutes for approval on financially consequential decisions.** A
    `high`-confidence inference still requires the `AIInference.status` transition; the
    difference confidence makes is _how much friction_ the UI puts in front of that transition
    (auto-suggested vs. blocking review), never whether it's required.

17. **A `Rule`'s auto-application is still an attributable, approved act.** Every
    `AIInference` accepted via a `Rule` records `decided_by = rule:<id>`, so a systematically
    wrong rule is fixable at its source and every transaction it touched is traceable back to
    it.

## Sync and reconciliation

18. **Splitwise is reconciled against, not trusted.** A `SplitwiseExpense`/`SplitwiseSettlement`
    sync is one-directional by default (our approved data → Splitwise) until bidirectional sync is
    explicitly implemented (`docs/roadmap.md` LATER); on drift, the discrepancy is surfaced in
    a `ReconciliationRun`, and neither side is auto-corrected from the other. If **our own** side
    changes after a sync (e.g. an `ExpenseAdjustment` reduces `netAmount`), the sync moves to
    `stale`, not `drifted` — the two are surfaced and handled distinctly (added per ADR-0008; see
    `SplitwiseExpense`/`SplitwiseSettlement` in `domain-model.md`).

19. **No Splitwise write from unapproved data, and never a `Group` as the debtor.** A
    `SplitwiseExpense` may only be created from an `Expense` whose `Allocation` has reached
    `APPROVED`. A `SplitwiseSettlement` may only be created from an `APPROVED` `Settlement`. Any
    `group`-typed `AllocationLine` involved is always expanded to its individual
    `AllocationLineGroupExpansion` rows before being sent to Splitwise — Splitwise's API has no
    concept of a group debtor, so a raw group line must never reach `integrations/splitwise`
    (added per ADR-0009).

20. **Unexplained money is always computed, never assumed to be zero.**
    `ledger_unexplained_total = ledger_total_outflow − ledger_transfers_total −
ledger_investments_total − ledger_settlements_total − ledger_explained_total`
    (**revised per ADR-0007 and ADR-0011** — added the investments and settlements terms, which
    the original formula omitted entirely, meaning a settlement or investment payment would have
    inflated `ledger_unexplained_total` by mistake), where `ledger_explained_total` sums
    `domain.netAmount(expense)` per `APPROVED`+ expense, not gross `Expense.amount` (ADR-0008).
    Computed by deterministic application code on every `ReconciliationRun`, and surfaced even
    when non-zero (especially when non-zero). This formula is scoped to outflow; an independent
    cash-balance identity and explanation coverage are now specified separately by
    [ADR-0017 (cash balance)](../decisions/0017-pragmatic-cash-balance-reconciliation.md).

    **What "scoped to outflow" means for each term (made explicit per ADR-0016 — this was
    previously stated once, in prose, and then not restated in the term definitions, which
    made two of them read as broader than the formula can support):**

    - `ledger_total_outflow` sums `debit` payments only, and **excludes payments in state
      `ignored`** — a confirmed duplicate is not more money (invariant #10).
    - `ledger_explained_total` means **explained _outflow_**, not "explained expenses". It sums
      `domain.netAmount(expense)` over `APPROVED`+ expenses **that the user funded** — those
      whose `paid_by_person_id` is the user's `Person`. An **externally-funded** expense
      (ADR-0006 — a flatmate or friend fronted the money, so there is no `PaymentExpenseLink`
      and no debit through any `Account` the user owns) contributes **0**. It is a fully
      explained expense in every other sense — visible in `Balance`, in obligation queries and
      in its own `Expense`/`Allocation` rows — it simply explains none of _this_ ledger's
      outflow, because none occurred. Counting it would subtract money from a total it never
      entered, driving `ledger_unexplained_total` negative by construction the moment such an
      expense exists (`scenario-analysis.md` §26: a ₹3,000 electrician bill a flatmate paid
      would report −₹3,000 of "unexplained" money).
    - `ledger_settlements_total` counts settlements carried by a **`debit`** payment only. A
      settlement the user _received_ (§29) rides a `credit` payment, never entered
      `ledger_total_outflow`, and so is not subtracted from it. Both directions are equally
      "not new spend" (invariant #9) — the direction decides only which one participates in
      _this_ subtraction. A period total of received settlements is an inflow-side figure and
      belongs to ADR-0017 (cash balance)'s new credit totals, not this legacy subtraction.

    `ledger_unexplained_total` is stored **whatever it comes to, including negative**. A
    negative figure means the ledger has over-explained its own outflow — a double-linked
    payment, a mis-scoped period — and is an integrity signal worth surfacing, not an error to
    clamp away. `reconciliation_runs` carries this identity as a row-level `CHECK`, so an
    inconsistent snapshot cannot persist.

## Auditability

21. **Every mutation to APPROVED- or DERIVED-and-user-facing data writes an `AuditEvent`.**
    Not opt-in per call site — enforced structurally in the service layer so it can't be
    forgotten (see `docs/architecture/system-architecture.md`). This includes `Settlement`
    creation and `ExpenseAdjustment` distribution, both of which write authoritative state exactly
    as `Allocation` approval does.

22. **`AuditEvent` records are append-only.** Never edited, never deleted, including for data
    the user later decides to correct — the correction is a new event, not a rewrite of
    history.

## Cash-balance reconciliation — ADR-0017 (cash balance), 17.1–17.7

These requirements extend, rather than replace, existing invariants. Full field definitions,
direction matrix and verification semantics are in
[ADR-0017 (cash balance)](../decisions/0017-pragmatic-cash-balance-reconciliation.md).

| ID   | Permanent requirement                                                                                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17.1 | Cash-flow role is orthogonal to counterparty identity. Each attributed paise is explained once, with actual expense/settlement/adjustment links and existing ceilings.                                                                                                                              |
| 17.2 | Refunds and external inflows require credits; settlements allow either direction with person/obligation evidence; transfers require owned-account evidence. Unknown credits remain unexplained until valid approval.                                                                                |
| 17.3 | Both real internal-transfer legs affect their own accounts once. Matched legs within the same scope are cash-neutral across accounts and never create spend/income/peer debt. Missing/cross-period legs remain visible discrepancies.                                                               |
| 17.4 | Preserve ADR-0016. Independently compute expected ending cash = opening + credits − debits, and signed cash delta = actual − expected. No net-expense substitution, double-counted refunds, clamping or tolerance.                                                                                  |
| 17.5 | Opening/closing balances cite immutable statement evidence for the same account, currency and period. Missing evidence is unknown; do not derive actual closing cash from the movements being checked.                                                                                              |
| 17.6 | Every distinct actual statement movement participates even if excluded from spend. Verification requires complete evidence, zero delta and zero unexplained debits/credits for every account, with no unresolved coverage/transfer discrepancies. Aggregate cancellation cannot prove verification. |
| 17.7 | Deterministic bigint arithmetic, audited classification decisions and immutable account snapshots preserve payment/input provenance. Enforce identities at persistence and cross-record integrity in transactional services; corrections create new runs.                                           |

## Item-level refund attribution — ADR-0018 (item refunds), 19.1–19.6

The pipeline is **financial event → adjustment → net expense → allocation → obligation**.
See [ADR-0018 (item refunds)](../decisions/0018-item-level-refund-attribution.md) for complete
lifecycle, taxes/discounts, legacy compatibility and scenario requirements.

| ID   | Permanent requirement                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19.1 | An attribution's ExpenseItem belongs to its parent adjustment's original expense.                                                                                                                                                                                             |
| 19.2 | Item attributions sum exactly to the adjustment amount before approval; partial proposals remain pending. Legacy whole-expense adjustments have no item rows and an explicit separate distribution path.                                                                      |
| 19.3 | Cumulative attributed refunds/reimbursements never exceed original gross item cost; the expense-wide cumulative ceiling also holds. Enforce across concurrent and duplicate requests; no negative net items or allocation lines.                                              |
| 19.4 | Attribution and adjustment amounts are strictly positive integer paise; no zero, negative or floating-point amounts.                                                                                                                                                          |
| 19.5 | Original approved ExpenseItem amounts/composition and gross Expense amount never change on refund. Derive net costs and supersede allocations; full refunds keep original beneficiaries at zero.                                                                              |
| 19.6 | Original and refund Payments are immutable. Observed credit is separate from purchase debit; no fabricated Payment for evidence-first events. Total adjustment portions cannot exceed the refund Payment, and the remainder stays unexplained. Audit the item-first pipeline. |
