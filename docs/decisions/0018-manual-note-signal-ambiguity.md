# 0018. A `manual_note` cannot currently distinguish "this documents the expense" from "this debt was cleared"

**Status:** Accepted (2026-08-15). Reported a contradiction between two accepted ADRs; option 1
below was chosen and implemented.

## Context

Two accepted decisions specify the **same data shape** for two opposite meanings.

**ADR-0006** — an externally-funded expense (somebody other than the user fronted the money)
can never have a `Payment`, so _"the only source is `Evidence` (a manual note, a forwarded
message, a photo of someone else's receipt)"_. In practice that is an `Evidence` row with
`type = 'manual_note'` and `linked_expense_id` set to the expense it documents. This is the
normal, expected shape for every §26/§27-style expense.

**ADR-0014 / `invariants.md` #9b** — when a human wants to record a _belief_ that an
unobservable debt was cleared, _"that belief is captured as an ordinary `Evidence` row
(`type = manual_note`, `linked_expense_id` set)"_, and
`domain.obligationEvidenceStatus(X, Y)` reads it as
`believed_settled, unconfirmed_by_ledger`.

Nothing on `evidence` distinguishes the two. The collision is not theoretical: it fires on the
very first externally-funded expense. Implementing `services.getBalance()` surfaced it
immediately — `scenario-analysis.md` §26's own worked example (Flatmate A's note, "paid the
electrician, ₹3,000, split three ways") is a note that _documents the expense_, and the literal
ADR-0014 rule reports the resulting obligation as "believed settled" the moment it is recorded.

That is exactly backwards. The status exists so the product can show _"an obligation is
expected here, but this ledger has no settlement evidence for it"_; under the literal rule it
would instead claim settlement evidence for every obligation that most needs the warning.

## Decision (superseded — kept for the reasoning)

_The interim below was what shipped while the contradiction was unresolved. It is retained
because the reasoning still explains why the service refuses to guess._

`domain.obligationEvidenceStatus` is **unchanged** and implements ADR-0014 exactly as written:
it takes the set of expense ids whose notes claim settlement, and applies the documented rule.

`services.getBalance()` **does not infer that set**. It is an opt-in parameter
(`believedSettledExpenseIds`), empty by default, so the ledger never guesses which of two
indistinguishable things a note is. The unambiguous signal — a `ReconciliationRun` discrepancy
showing Splitwise reporting a lower balance — is wired as normal.
`services.listCandidateSettlementNotes()` exposes the notes so a future review UI can _offer_
them for a human to confirm, which is what ADR-0014 means by a human's explicit act.

The effect today: an obligation reports `open_unconfirmed` unless a human explicitly nominates
a note, or Splitwise disagrees. No behaviour is invented, no schema is changed, and no
documented rule is silently weakened.

## Resolution — option 1, an explicit discriminator on `evidence`

`evidence.note_kind text` (nullable at the column level), with two check constraints:

```sql
check (note_kind is null or note_kind in ('documentation', 'settlement_claim'))
check ((type = 'manual_note') = (note_kind is not null))
```

The second is what makes it honest: a manual note **must** declare which of the two things it
is, and nothing else may declare either. There is no "unspecified" state to fall back on and
therefore no default to get wrong — defaulting to `documentation` would silently discard a
settlement claim, and defaulting to `settlement_claim` would mark every documented expense
settled.

Named `documentation`/`settlement_claim` rather than the `documents_expense`/`claims_settlement`
this ADR first sketched: a manual note can attach to a `Payment` as well as an `Expense`, so the
neutral noun reads correctly in both cases.

**This makes the rule deterministic, so the interim opt-in is withdrawn.** `services.getBalance()`
no longer takes `believedSettledExpenseIds` and no longer abstains — it reads
`settlement_claim` notes directly, which is what ADR-0014 always intended. The escape hatch
existed only because the data could not express the distinction; it can now.

Implemented in: `evidence.note_kind` (schema + migration `0001_evidence_note_kind.sql`),
`EVIDENCE_NOTE_KINDS` and `Evidence.noteKind` (domain), `domain.validateEvidenceNoteKind` and
`domain.claimsSettlement` (validation), `db.listSettlementClaimExpenseIds`,
`services.getBalance`, and `domain.obligationEvidenceStatus`'s input, renamed from
`manualNoteExpenseIds` to `settlementClaimExpenseIds` so the parameter cannot be mistaken for
the broader set again.

**Migration note.** `0001` is additive and safe on an empty database. Applied to a database that
already held `manual_note` rows, the second check would fail until those rows were backfilled
with a kind — deliberately, since guessing on their behalf is the very thing this ADR forbids.
No such database exists yet. The reverse of the migration is
`alter table evidence drop column note_kind` (the constraints and index go with the column);
Drizzle does not generate down-migrations, which is a pre-existing repository-wide gap rather
than something specific to this change.

## Options considered before choosing option 1

1. **Add a discriminator to `evidence`** — e.g. `note_kind text check (note_kind in
('documents_expense', 'claims_settlement'))`, nullable for existing rows. Smallest change
   that makes the ADR-0014 rule directly implementable. Costs one column and one migration.
2. **Add the `believed_settlements` table ADR-0014 already considered and rejected.** It was
   rejected as unnecessary "since the two signals already available cover the realistic
   cases" — an argument that assumed the `Evidence` signal was usable, which this ADR shows it
   is not. Worth reconsidering on its own merits now.
3. **Keep the interim behaviour permanently**: the manual-note signal is only ever a human's
   explicit, per-obligation act through the UI, never derived from stored data. Costs nothing,
   but means ADR-0014's first bullet describes something the system does not automatically do.
4. **Narrow the rule to notes linked to a `Payment` rather than an `Expense`.** Rejected on
   sight: the whole point of §34 is that no `Payment` exists for these settlements.

Option 1 looks cheapest and most honest, but it is a schema decision on reviewed tables and is
not being made here.

## Consequences

One nullable column, two check constraints, one partial index, and one additive migration.
`services.getBalance()` loses its optional parameter and becomes deterministic. `ADR-0014`'s
first bullet, `invariants.md` #9b, `domain-model.md`'s `Evidence` and `ObligationEvidenceStatus`
sections, and `database-design.md`'s `evidence` table all now state the discriminator rather
than the ambiguous shape.

A manual note now costs the caller one decision it did not previously have to make. That is the
point: the decision was always being made, silently and wrongly, by whichever rule happened to
read the row.

The regression suite in `tests/scenarios/` pins the behaviour that matters — an externally-funded
expense documented with an ordinary note reports `open_unconfirmed`, the same pair reports
`believed_settled_unconfirmed_by_ledger` only when a note actually claims settlement, and
neither case moves `NetBalance` or fabricates a `Payment`/`Settlement` (invariant #9b).
