# 0006. Explicit `paid_by_person_id` on Expense — bidirectional payer model

**Status:** Accepted

## Context

The original domain model derived "who paid" implicitly from `PaymentExpenseLink`, and
`PaymentExpenseLink` only ever points at a `Payment`, and every `Payment.account_id` must
reference an `Account` owned by the system's own `User` (`domain-model.md`, `Account`
invariants). The practical effect: the model could only represent expenses the user personally
fronted. It had no field for "Flatmate A paid the electrician; Dev and Flatmate B owe their
shares" — a routine flatmate/friend scenario, and one the product's own purpose statement
requires ("who ultimately owes whom," not "who owes the user").

None of the original 25 scenarios in `scenario-analysis.md` exercised the reverse direction —
every one was framed as "I paid." This was flagged in the pre-implementation architecture
review as Finding #4.

## Decision

Add `expenses.paid_by_person_id references people(id) not null` (nullable only transiently,
before the expense reaches `CLASSIFIED`). This is the authoritative answer to "who fronted the
money for this expense," independent of whether a `Payment` in the user's own ledger documents
it.

- **Self-funded expense** (the common case): `paid_by_person_id` = the `Person` row representing
  the system's own `User`. Normally linked to a `Payment` via `PaymentExpenseLink`.
- **Externally-funded expense**: `paid_by_person_id` = someone else's `Person` row. By
  construction, this expense will never have a `PaymentExpenseLink`, because no money moved
  through an `Account` the user owns — the only source is `Evidence` (a manual note, a forwarded
  message, a photo of someone else's receipt). This is not a transitional "evidence-pending"
  state waiting for a payment match (as the original model implicitly assumed for all
  unlinked expenses) — it is a **permanent, valid category**, and the docs now distinguish the
  two explicitly (see `domain-model.md`, "Funding source").

`AllocationLine`s continue to represent beneficiaries exactly as before. The new invariant
(`invariants.md` #2a) is: a beneficiary line where `beneficiary_id = paid_by_person_id` records
that person's own share (no obligation, they benefited from their own money); every other line
represents an obligation owed **to `paid_by_person_id`**, not to the user. `Balance` becomes a
general pairwise function over any two `Person`s (see ADR-0007's Obligation section in
`domain-model.md`), not a user-centric one.

## Consequences

Balance/obligation logic and the Splitwise sync payload builder must key off `paid_by_person_id`,
not "the user," when deciding who owes whom. This is a one-field addition with a load-bearing
change in how downstream code reads it — worth calling out explicitly to whoever implements
Phase 12/13 rather than letting it be discovered mid-implementation.

A structural limitation remains and is documented, not solved: the system can only *observe*
money movement (a `Payment`) when it passes through the user's own `Account`. A debt between two
other people (e.g., Flatmate C owing Flatmate A from an expense Flatmate A fronted) is
representable in the `Obligation`/`Balance` formula, but can never be backed by a `Payment` record
in this ledger — only by `Evidence` or by trusting Splitwise. `scenario-analysis.md` §34 documents
this explicitly rather than leaving it to be discovered as a bug; a later pass (ADR-0014) added a
concrete, computable `ObligationEvidenceStatus` so this limitation is surfaced to the user, not
just to future implementers reading this ADR.

## Alternatives considered

- **Infer payer from `PaymentExpenseLink` presence, no new field.** Rejected: this can only ever
  express "the user paid" (link exists) or leaves "someone else paid" with no representation at
  all — it can't express *which* other person paid, which is the entire point of the reverse
  case.
- **A full double-entry ledger with a `Ledger`/`JournalEntry` abstraction.** Considered, since it
  would generalize the payer/beneficiary relationship further than a single field. Rejected as
  disproportionate to a personal, single-user-operated tool — `paid_by_person_id` plus the
  existing `AllocationLine` mechanism already captures every case the product needs, per
  `scenario-analysis.md`'s stress-test coverage matrix, at a fraction of the implementation cost.
- **Model the reverse case as a `paid_on_behalf` expense from the flatmate's perspective, mirrored
  manually by the user.** Rejected: it would require the user to fabricate a `Payment` that never
  happened, violating the SOURCE-data-is-never-fabricated principle (`invariants.md` #4) more
  severely than adding a field does.
