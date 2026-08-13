# Lifecycle

The brief specifies a single lifecycle: `IMPORTED → CLASSIFIED → REVIEW_REQUIRED → APPROVED →
READY_TO_SYNC → SYNCED → RECONCILED`. In the domain model (`domain-model.md`), this chain
doesn't map cleanly onto one entity — `Payment` doesn't get "classified" or "synced," `Expense`
does. This doc adapts the brief's states to where they actually belong, while preserving the
underlying distinction the brief cares about: **the exact same transaction moves through
successive, explicit states, and nothing skips a state silently.**

## Payment lifecycle

A `Payment` has a short lifecycle — it's a fact about money moving, not something that gets
"decided."

```
IMPORTED ──▶ NORMALIZED ──┬─▶ LINKED     (attached to ≥1 Expense via PaymentExpenseLink)
                          └─▶ IGNORED    (confirmed duplicate, or out of ledger scope)
```

- **IMPORTED** — row exists exactly as parsed from the source (`ImportBatch`), untouched.
- **NORMALIZED** — channel, counterparty resolution attempted (may still be `unknown`).
- **LINKED** — at least one `PaymentExpenseLink` exists. A payment can be `LINKED` and still
  have an unexplained remainder if its links don't sum to its full amount (see
  `invariants.md` #5).
- **IGNORED** — explicitly excluded, with a reason (`duplicate_of: <payment_id>`,
  `out_of_scope`, etc.), recorded via `AuditEvent`. Never silently dropped from the import.

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
  confirmed.
- **CLASSIFIED** — `relationship_type` and `category` are set (by AI proposal or manual entry),
  not yet approved.
- **REVIEW_REQUIRED** — entered when confidence is below threshold, the amount is above a
  materiality threshold, or beneficiaries are ambiguous. High-confidence, low-stakes expenses
  (per invariant #16, still requiring an approval act — often an auto-applied `Rule`) can pass
  through this state near-instantly rather than skip it outright, keeping the audit trail
  consistent.
- **APPROVED** — `relationship_type`, `category`, and amount are confirmed. Per invariant #2,
  every `APPROVED` expense must have (or be in the process of getting) an `Allocation`.
- **ALLOCATED** — `Allocation` + `AllocationLine`s exist and sum-check against
  `Expense.amount` (invariant #11). Split out as its own state, distinct from `APPROVED`,
  because "I agree this ₹2,840 was the group dinner" and "I agree Dev/A/B split it exactly this
  way" are different decisions that can happen at different times.
- **READY_TO_SYNC** — allocation involves a non-self beneficiary and the user has confirmed the
  Splitwise proposal is ready to send. Expenses with no external-facing beneficiary (pure
  `personal`) skip `READY_TO_SYNC`/`SYNCED` entirely and go straight to being eligible for
  `RECONCILED`.
- **SYNCED** — a `SplitwiseExpense` record exists and sync succeeded.
- **RECONCILED** — this expense's contribution to the ledger has been checked against
  Splitwise (if synced) and against payment linkage (invariant #5) in at least one
  `ReconciliationRun` with no unresolved discrepancy attributed to it.

An expense can regress: a `RECONCILED` expense found to have drifted from Splitwise moves back
to a `REVIEW_REQUIRED`-equivalent "needs attention" state, always via an `AuditEvent`, never
silently.

## AIInference lifecycle

```
pending ──▶ accepted   (produces/updates an authoritative record)
        ──▶ modified   (user changed the proposal before accepting; still produces a record)
        ──▶ rejected   (no authoritative record produced)
        ──▶ superseded (a newer inference for the same input replaced this one, unresolved)
```

Only `accepted` and `modified` produce or update an authoritative record, and both do so
through the normal APPROVED-data write path (invariant #15) — `accepted` is not a shortcut
that bypasses validation.

## SplitwiseExpense sync status

```
pending ──▶ synced ──▶ (drifted on next reconciliation check, if applicable)
        ──▶ sync_failed
```

`drifted` is a terminal-until-addressed state surfaced in `ReconciliationRun`, not
auto-resolved (invariant #18).
