# 0018. A `manual_note` cannot currently distinguish "this documents the expense" from "this debt was cleared"

**Status:** Proposed — this ADR reports a contradiction between two accepted ADRs and lays out
the options. It does **not** pick one; that is a decision for review.

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

## Decision (interim, deliberately minimal)

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

## Options for resolving it properly

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

`services.getBalance()` gains an optional parameter; nothing else changes. Two tests pin the
interim behaviour: an externally-funded expense with a documenting note reports
`open_unconfirmed`, and the same pair reports `believed_settled_unconfirmed_by_ledger` when the
note is explicitly nominated. Whichever option is chosen, those tests are the ones that should
change with it.
