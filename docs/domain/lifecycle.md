# Lifecycle

The brief specifies a single lifecycle: `IMPORTED → CLASSIFIED → REVIEW_REQUIRED → APPROVED →
READY_TO_SYNC → SYNCED → RECONCILED`. In the domain model (`domain-model.md`), this chain
doesn't map cleanly onto one entity — `Payment` doesn't get "classified" or "synced," `Expense`
does, and `Settlement`/`ExpenseAdjustment` (added in the 2026-08 revision, see `domain-model.md`'s
revision note and ADRs 0006–0011) have their own, much shorter lifecycles. This doc adapts the
brief's states to where they actually belong, while preserving the underlying distinction the
brief cares about: **the exact same transaction moves through successive, explicit states, and
nothing skips a state silently.**

## Cash-flow classification lifecycle — shipped in Phase 16

[ADR-0017 (cash balance)](../decisions/0017-pragmatic-cash-balance-reconciliation.md) adds an
explicit interpretation lifecycle alongside `Payment.state`:

```text
IMPORTED → NORMALIZED → CASH_FLOW_CLASSIFIED → APPROVED
```

`IMPORTED` preserves raw facts; `NORMALIZED` resolves available structure and counterparties;
`CASH_FLOW_CLASSIFIED` records a validated role proposal; `APPROVED` requires an audited human
or applicable previously approved rule decision. Rejection remains reviewable and a correction
requires a new decision. A link, category guess or high confidence alone is not approval.

The exact cash categories are `PEER_SETTLEMENT`, `REFUND`, `INTERNAL_TRANSFER`, `EXTERNAL_INFLOW`.
The existing link/ignore state is kept for compatibility and the classification state is a
separate `payments.cash_flow_state` column (Phase 16); `linked` was not renamed to `approved`
and no legacy state was migrated by assumption — every existing row backfilled to `imported`.
The transitions are `domain.canTransitionCashFlow`; rejection returns a proposal to `normalized`
with its category cleared, and reclassifying an approved payment returns it to
`cash_flow_classified` and drops the approval. Ordinary
purchase/investment debits can have null category and a valid existing approved explanation;
unknown credits cannot. Mixed movements retain their actual portion links and any remainder.

A transfer/credit remaining `NORMALIZED` in the legacy lifecycle below is not sufficient for
verified cash reconciliation. Actual statement movements participate regardless of spend scope;
ignore duplicate representations, not genuine transfer legs or out-of-scope bank activity.

## Payment lifecycle — existing movement/link state

A `Payment` has a short lifecycle — it's a fact about money moving, not something that gets
"decided."

```
IMPORTED ──▶ NORMALIZED ──┬─▶ LINKED     (explained: ≥1 PaymentExpenseLink and/or ≥1 Settlement)
     │                    └─▶ IGNORED    (confirmed duplicate, or out of ledger scope)
     └──────────────────────▶ IGNORED    (duplicate confirmed at import time — ADR-0019)

  (a payment whose counterparty_type is internal_account or investment_instrument
   is excluded from spend by that classification alone and may remain at
   NORMALIZED indefinitely — see below)
```

- **IMPORTED** — row exists exactly as parsed from the source (`ImportBatch`), untouched.
- **NORMALIZED** — channel, counterparty resolution attempted (may still be `unknown`);
  `external_reference`/`reference_type`/`source_system` extraction attempted (ADR-0010).
- **LINKED** — **revised, ADR-0007**: this now means "explained," in general, not "linked to an
  Expense specifically." At least one `PaymentExpenseLink` and/or at least one `Settlement`
  exists. A payment can be `LINKED` and still have an unexplained remainder if its links/
  settlements don't sum to its full amount (see `invariants.md` #5, #9a's cross-reference to
  `PaymentExpenseLink`'s revised sum invariant).
- **IGNORED** — explicitly excluded, with a reason (`duplicate_of: <payment_id>`,
  `out_of_scope`, etc.), recorded via `AuditEvent`. Never silently dropped from the import.
  A `duplicate_of` always names the **canonical** payment — the head of the chain, never
  another ignored copy — so one hop always reaches the row that counts (`invariants.md` #10).
- **`IMPORTED → IGNORED` directly (added, ADR-0019)** — for a duplicate the importer confirms
  deterministically against an existing payment (`invariants.md` #10). The asymmetry with
  `LINKED` is deliberate: being _explained_ requires knowing what a payment is, so `LINKED`
  still demands normalization first; being _discarded_ does not. Routing a row through
  `NORMALIZED` on its way to the bin would record that a counterparty was resolved for a row
  nobody will look at again. The duplicate row is still written before being ignored — the
  ledger did receive that evidence twice, and the second copy carries the reason it does not
  count.
- **A payment whose `counterparty_type` is `internal_account` (a transfer) or
  `investment_instrument` (ADR-0011) does not need to reach `LINKED` or `IGNORED` at all.**
  Exclusion from spend is driven by `counterparty_type` directly (invariant #7); staying at
  `NORMALIZED` forever is a valid terminal state for both. This was ambiguous for transfers
  before this revision and is now stated explicitly for both categories.
- **A `credit` payment that is ordinary, untracked income — not a refund/reimbursement
  (`ExpenseAdjustment.adjustment_payment_id`) and not a received settlement
  (`Settlement.payment_id`) — is, by the same pattern, not required to ever reach `LINKED` or
  `IGNORED` either.** Staying at `NORMALIZED` indefinitely is valid here too (finalized this
  revision, `domain-model.md`'s `ReconciliationRun` "V1 scope, explicit"). V1 deliberately does
  not classify or reconcile general inflow — this is a scope boundary, not a state the lifecycle
  fails to represent. **Historical Phase 15 scope only:** ADR-0017 (cash balance) now
  requires the separate classification/approval path for verified cash reports.

A payment can move from `LINKED` back toward needing attention if a later `Expense` linked to
it is un-approved (rare, but see scenario §24) — this is handled at the `Expense` level, not by
regressing the payment's state.

## Expense lifecycle

This is where the brief's full chain applies, adapted:

```
PROPOSED ──▶ CLASSIFIED ──▶ REVIEW_REQUIRED ──▶ APPROVED ──▶ ALLOCATED ──▶ READY_TO_SYNC
                  │                │                                            │
                  │                └──────────┐                                 ▼
                  ├──▶ (skips REVIEW_REQUIRED │ if high-confidence)          SYNCED ──▶ RECONCILED
                  │                           ▼
                  └──────────────────────▶ REJECTED   (terminal — added phase 9, ADR-0028)
```

- **PROPOSED** — an `Expense` exists (created manually, or as a byproduct of a
  `classify_transaction` `AIInference`) but its relationship type/category isn't yet
  confirmed. **Corrected during phase 8's implementation:** this bullet previously said "as a
  byproduct of _accepting_" the inference. The expense is created when the proposal is
  **recorded**, not when it is accepted — it has to exist unapproved for `CLASSIFIED` and
  `REVIEW_REQUIRED` to mean anything, and for step 5 of `data-flow.md` to have a row to update.
  It is DERIVED until `APPROVED` throughout (ADR-0026). A `settlement`-kind proposal creates
  nothing until accepted, because `Settlement` has no pre-approval state — see below. If the expense is externally-funded (`paid_by_person_id` != the user —
  `domain-model.md`, ADR-0006), that fact is set here too, from `Evidence` rather than a
  `Payment`.
- **CLASSIFIED** — `relationship_type` and `category` are set (by AI proposal or manual entry),
  not yet approved.
- **REVIEW_REQUIRED** — entered when confidence is below threshold, the amount is above a
  materiality threshold, or beneficiaries are ambiguous. High-confidence, low-stakes expenses
  (per invariant #16, still requiring an approval act — via a matched `Rule` the user previously
  approved, since that is the only mechanism invariant #15 allows besides a direct user action)
  can pass through this state near-instantly rather than skip it outright, keeping the audit
  trail consistent.
- **APPROVED** — `relationship_type`, `paid_by_person_id`, and `amount` are confirmed and
  `amount` is now permanently immutable (invariants.md #6). Per invariant #2, every `APPROVED`
  expense must have (or be in the process of getting) an `Allocation`.
- **ALLOCATED** — `Allocation` + `AllocationLine`s exist and sum-check against
  `domain.netAmount(Expense)` (invariant #11, revised). Any `group`-typed line also has its
  `AllocationLineGroupExpansion` written at this point (invariant #2b). Split out as its own
  state, distinct from `APPROVED`, because "I agree this ₹2,840 was the group dinner" and "I
  agree Dev/A/B split it exactly this way" are different decisions that can happen at different
  times.
- **READY_TO_SYNC** — **revised, ADR-0007**. Entered only when **both** hold: (a)
  `relationship_type ∈ {shared, paid_on_behalf, household_shared_flat}` — the same debt-creating
  set used by `Balance` (`domain-model.md`) — **and** (b) the current `Allocation` has at least
  one obligation-creating line (a non-payer beneficiary, per invariant #2a), and the user has
  confirmed the Splitwise proposal is ready to send. The original wording ("allocation involves a
  non-self beneficiary") is not sufficient on its own and is corrected here: a `gift` expense
  routinely has a non-self beneficiary line (100% to the recipient) but must **never** reach
  `READY_TO_SYNC` — a gift creates no obligation (invariant #2a implies this, since `gift` is not
  in the debt-creating set), and syncing it to Splitwise would incorrectly tell the recipient they
  owe the giver for their own gift. Expenses with no obligation-creating beneficiary at all
  (`personal`, or `gift`) skip `READY_TO_SYNC`/`SYNCED` entirely and go straight to being eligible
  for `RECONCILED`.
- **SYNCED** — a `SplitwiseExpense` record exists and sync succeeded.
- **REJECTED (added phase 9, ADR-0028)** — the DERIVED expense a classification proposal
  created, after a reviewer declined that proposal (`services.decideInference(reject)`),
  replaced it (`services.reclassifyPayment`), or decided it was a settlement after all
  (a `modify` that changes `proposedKind`). Terminal: never approved, never revived, counted by
  no `ledger_*` total — each of those enumerates the states it sums, starting at `approved`.
  Reachable **only** from `CLASSIFIED`/`REVIEW_REQUIRED`; an expense that was ever `APPROVED`
  can never reach it, because unwinding an approved financial record is a correction
  (`ExpenseAdjustment`, ADR-0008), not a state change. The audit event's `reason` says which of
  the three ways it got here — the same way `payments.ignored_reason` distinguishes
  `duplicate_of:` from `out_of_scope` without needing two states. Nothing is deleted.
- **RECONCILED** — this expense's contribution to the ledger has been checked against
  Splitwise (if synced) and against payment linkage (invariant #5) in at least one
  `ReconciliationRun` with no unresolved discrepancy attributed to it.

An expense can regress: a `RECONCILED` expense found to have drifted from Splitwise, or that
receives a new `ExpenseAdjustment` after already having synced (moving its `SplitwiseExpense` to
`stale` — see below), moves back to a `REVIEW_REQUIRED`-equivalent "needs attention" state,
always via an `AuditEvent`, never silently.

## ExpenseAdjustment lifecycle

```
recorded ──▶ distributed   (a new Allocation version exists, summing to the new netAmount)
```

- **recorded** — the `ExpenseAdjustment` row exists (a refund or reimbursement has been
  identified against a specific original `Expense`), but the original expense's current
  `Allocation` still sums to the pre-adjustment net amount. This is a real, valid, visible state
  — not an error — matching "recorded but not yet distributed" being two separate, both-visible
  facts (ADR-0008).
- **distributed** — a new `Allocation` version has been created on the original `Expense`,
  superseding the previous one, summing to the new `domain.netAmount(Expense)` (invariant #11).
  If the original expense had already reached `SYNCED`, its `SplitwiseExpense.sync_status` moves
  to `stale` at this point (see below), never silently left showing the pre-adjustment amount.

## Settlement lifecycle

`Settlement` has no state machine of its own beyond existing-or-not — it is created directly as
an `APPROVED` record once the `Payment` it references is confirmed as a settlement (manually, or
via an accepted `classify_transaction` `AIInference` whose `proposedKind = settlement` —
`ai-boundary.md`). Because there is no pre-approval state to park a proposal in, a pending
inference **is** the queue entry for a proposed settlement, and accepting it is what creates
the row — along with resolving the payment's `counterparty_type` to that `person` and moving
the payment to `LINKED` (phase 8, ADR-0026). It never passes through `PROPOSED`/`CLASSIFIED`/etc., because it never becomes
an `Expense` (ADR-0007). Its only further lifecycle is optional Splitwise sync
(`SplitwiseSettlement.sync_status`, same shape as below).

## AIInference lifecycle

```
pending ──▶ accepted   (produces/updates an authoritative record)
        ──▶ modified   (user changed the proposal before accepting; still produces a record)
        ──▶ rejected   (no authoritative record produced)
        ──▶ superseded (a newer inference for the same input replaced this one, unresolved)
```

Only `accepted` and `modified` produce or update an authoritative record, and both do so
through the normal APPROVED-data write path (invariant #15) — `accepted` is not a shortcut
that bypasses validation. **As of phase 8 that path is `services.decideInference`**, which is
the only code that writes these transitions: it re-validates the stored proposal through the
same parser a modified one passes, and refuses an actor that is not a person or a `Rule`.
`superseded` is produced by exactly one caller, added in phase 9: `services.reclassifyPayment`,
the explicit review action that asks the model again (ADR-0030). A plain `classifyPayments`
re-run still skips a payment that already carries an inference, so it remains a no-op — the two
behaviours are deliberately different, and there is a test asserting each. The superseded
proposal's DERIVED expense goes to `REJECTED` with it (ADR-0028), and the old and new proposals
move in one transaction, so a payment is never left with a superseded proposal and no
replacement. For `classify_transaction` inferences, the produced record is either
an `Expense` (`proposedKind = expense`, the default) or a `Settlement` (`proposedKind =
settlement`, ADR-0007) — never both, and the choice is part of what `accepted`/`modified`
confirms, not assumed.

## SplitwiseExpense / SplitwiseSettlement sync status

```
pending ──▶ synced ──▶ drifted   (on next reconciliation check, if Splitwise's side changed)
        ──▶ synced ──▶ stale     (if OUR side changed — e.g. an ExpenseAdjustment was distributed
                                   against an already-synced Expense — ADR-0008)
        ──▶ sync_failed
```

`drifted` and `stale` are both terminal-until-addressed states surfaced in `ReconciliationRun`,
never auto-resolved (invariant #18) — kept as two distinct statuses rather than one, because
"Splitwise changed independently" and "we changed and owe Splitwise a fresh proposal" call for
different next actions and shouldn't be conflated.

## Item-refund attribution and account snapshot extensions

Under [ADR-0018 (item refunds)](../decisions/0018-item-level-refund-attribution.md), a known
item refund first records a complete validated `ExpenseAdjustmentItem` set, then computes
net expense, then creates an approved superseding allocation, then derives obligations.
Attribution/distribution still pending is visible and must not be labeled current/verified.
No refund rewrites purchased items, source Payments, earlier allocations or settlements.

A `ReconciliationAccountSnapshot` is created with a new run as `incomplete` (missing coverage
or boundary evidence), `unreconciled` (complete inputs with a discrepancy), or `verified`
(ADR-0017's full zero-delta/zero-unexplained and evidence conditions). These are outcomes of
an immutable run, not permission to edit an old snapshot from incomplete to verified later.
New evidence produces a new run. Legacy runs without account snapshots remain outflow reports.
