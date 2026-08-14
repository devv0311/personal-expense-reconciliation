# 0007. Settlements are Payment-linked events that discharge obligations, not Expenses

**Status:** Accepted. Partially supersedes ADR-0004's settlement paragraph (see "Relationship to
ADR-0004" below).

## Context

The pre-implementation review found the settlement design self-contradictory in three ways
(review findings #1, #2):

1. `invariants.md` #2 required _every_ `APPROVED` Expense to have an `Allocation`, with no
   exception — but the reference fixture for the canonical settlement scenario had none.
2. `domain-model.md` documented a second settlement path directly on `Payment`
   (`is_settlement = true`) that had no corresponding column anywhere in
   `database-design.md`.
3. If a settlement _did_ get a trivial Allocation (to satisfy #1), nothing excluded
   `relationship_type = settlement` from the Balance calculation the way `gift` and `personal`
   were explicitly excluded — so a settlement risked being counted twice: once as debt discharge,
   once as new debt.

Underlying all three: a settlement is not new consumption. Money already changed hands
conceptually when the original shared/paid-on-behalf/household expense was allocated; a
settlement payment doesn't create a new "what was this for" question the way an Expense does —
it answers "has the existing debt been paid," which is a different kind of fact.

## Decision

Settlement is **not** a kind of `Expense`. It is a new entity, `Settlement`, that:

- Is always anchored to exactly one `Payment` (a real transfer of money observed in the user's
  own account — see ADR-0006 for the "who observed this" limitation for third-party-to-third-party
  settlements).
- References the `counterparty_person_id` — the other party in the two-person obligation being
  discharged.
- Carries its own `amount` (usually the full linked `Payment.amount`, but may be a portion — the
  same "sum of links ≤ payment amount, remainder surfaced as unexplained" pattern already used
  for `PaymentExpenseLink` is extended to include `Settlement` amounts in that sum).
- Never touches `Allocation` and is never a beneficiary line. Direction (did the user pay the
  counterparty, or receive from them) is read from the linked `Payment.direction`, not stored
  redundantly.
- Reduces the derived `Balance(user, counterparty)` (or, generalized, `Balance(X, Y)` — see
  ADR-0006) directly. It never contributes to `ledger_explained_total` (new-spend total); it gets
  its own bucket, `ledger_settlements_total`, in `ReconciliationRun` (`invariants.md` #9,
  revised).
- Removes `settlement` from `expenses.relationship_type` entirely — an expense can no longer be
  "of type settlement."
- `expenses.relationship_type` shrinks to `personal | shared | paid_on_behalf | gift |
household_shared_flat`.

Because a `Settlement` is not an `Expense`, invariant #2 ("every APPROVED expense needs an
Allocation") simply no longer applies to it — there's no contradiction to patch, because the
category it used to apply to (settlement-as-Expense) no longer exists.

**Detection.** `ai.classifyTransaction`'s proposed output gains a `proposedKind: 'expense' |
'settlement'` field (`ai-boundary.md`) alongside its existing `relationship_type` proposal, so a
`Payment` to/from a known `Person` counterparty can be flagged as a likely settlement (e.g. a
round-number UPI transfer to a person who has an open balance) — still only advisory, still
requires the same `services.decideInference()` approval path as any other classification. Manual
override (the user explicitly marking a Payment as a settlement during review) is always
available and doesn't require an `AIInference` at all, same as manual Expense entry.

**No receipt / evidence-free settlements.** A `Settlement`'s `Payment` may have zero `Evidence`
rows, exactly like any other `Payment` — Evidence has always been optional (`domain-model.md`,
`Evidence`). No special-casing needed.

**Splitwise.** A parallel `splitwise_settlements` table (structurally identical to
`splitwise_expenses`, referencing `settlements` instead of `expenses`) records the sync. Splitwise
itself has a native "record a payment" concept distinct from "record an expense," so this maps
cleanly. See `database-design.md`.

## Relationship to ADR-0004

ADR-0004 rejected a standalone `SettlementTransaction` table on the grounds that "a settlement
repayment _is_ a payment; giving it its own table would create two ways to represent 'money
moved.'" That reasoning still holds and is preserved here: `Settlement` does **not** duplicate
`Payment` — it never records an amount independent of a `Payment` row, and money movement is
still represented exactly once, by `Payment`. What ADR-0004 got wrong was the _second_ half of its
settlement decision — routing settlements through an `Expense` shell "so it still flows through
the same Allocation/AuditEvent machinery." That part is superseded: `Settlement` gets its own
`AuditEvent` writes directly (it's an APPROVED-classified record like any other), without needing
`Expense`/`Allocation` as an intermediary. ADR-0004's Beneficiary, Classification, and
Decision/Approval folds are untouched by this ADR.

## Consequences

One new table (`settlements`) and one new parallel sync table (`splitwise_settlements`). The
`expenses.relationship_type` enum shrinks (a schema change, but no migration exists yet, so this
is a design-doc edit, not a migration). `ledger_explained_total`'s definition now explicitly
excludes settlements as well as transfers. The Payment lifecycle's `LINKED` state is
reinterpreted to mean "explained by a `PaymentExpenseLink` and/or a `Settlement`," not
"explained by an Expense specifically" — see `lifecycle.md`.

## Alternatives considered

- **Option A — settlement stays an Expense, add the missing exception to invariant #2.** Rejected
  per the user's explicit direction: a settlement is not new consumption, and forcing it through
  Allocation (even trivially) invites exactly the double-counting risk finding #1 identified.
  Also would have required Balance's exclusion list to grow indefinitely as new non-spend
  categories are discovered (this ADR + ADR-0011's investment category would each need their own
  carve-out under Option A; under Option B, only `Expense`-typed relationship_types are ever
  candidates for Balance in the first place).
- **Option C — a fully generalized `LedgerEvent` type with a `kind` discriminator covering
  Expense, Settlement, Refund, Reimbursement, and Investment all in one polymorphic table.**
  Considered, since several of these ("not new spend, references an existing obligation/expense")
  share a shape. Rejected for the foundation phase as more restructuring than the findings
  require — `Expense` already has significant machinery (state lifecycle, `AIInference`
  proposals, `PaymentExpenseLink`) that doesn't apply to a `Settlement`, and forcing them into one
  polymorphic table would mean most of that machinery becomes conditional on `kind`. A future ADR
  can revisit unification if a fourth or fifth non-spend event type emerges and the duplication
  becomes a real maintenance cost.
