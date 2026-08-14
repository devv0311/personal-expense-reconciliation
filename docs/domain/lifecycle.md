# Lifecycle

The brief specifies a single lifecycle: `IMPORTED → CLASSIFIED → REVIEW_REQUIRED → APPROVED →
READY_TO_SYNC → SYNCED → RECONCILED`. In the domain model (`domain-model.md`), this chain
doesn't map cleanly onto one entity — `Payment` doesn't get "classified" or "synced," `Expense`
does, and `Settlement`/`ExpenseAdjustment` (added in the 2026-08 revision, see `domain-model.md`'s
revision note and ADRs 0006–0011) have their own, much shorter lifecycles. This doc adapts the
brief's states to where they actually belong, while preserving the underlying distinction the
brief cares about: **the exact same transaction moves through successive, explicit states, and
nothing skips a state silently.**

## Payment lifecycle

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
  fails to represent.

A payment can move from `LINKED` back toward needing attention if a later `Expense` linked to
it is un-approved (rare, but see scenario §24) — this is handled at the `Expense` level, not by
regressing the payment's state.

## Expense lifecycle

This is where the brief's full chain applies, adapted:

```
PROPOSED ──▶ CLASSIFIED ──▶ REVIEW_REQUIRED ──▶ APPROVED ──▶ ALLOCATED ──▶ READY_TO_SYNC
                  │                                                             │
                  └───────────────▶ (skips REVIEW_REQUIRED if high-confidence)  ▼
                                                                             SYNCED ──▶ RECONCILED
```

- **PROPOSED** — an `Expense` exists (created manually, or as a byproduct of accepting a
  `classify_transaction` `AIInference`) but its relationship type/category isn't yet
  confirmed. If the expense is externally-funded (`paid_by_person_id` != the user —
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
`ai-boundary.md`). It never passes through `PROPOSED`/`CLASSIFIED`/etc., because it never becomes
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
that bypasses validation. For `classify_transaction` inferences, the produced record is either
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
