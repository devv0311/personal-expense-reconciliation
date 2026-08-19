# 0023. Recognising a self-transfer is deterministic, not an AI proposal

**Status:** Accepted

## Context

`fixtures/bank-statement.csv` has two rows that are one event:

```
2026-07-02,NEFT TRANSFER TO SELF A/C X4821,15000.00,DEBIT,NEFT/N072026001
2026-07-02,NEFT TRANSFER FROM SELF A/C X9013,15000.00,CREDIT,NEFT/N072026001
```

Phase 7 deliberately left both at `counterparty_type = unknown`, recording that "recognising a
self-transfer or a person is classification (phase 8), not merchant normalization" (ADR-0022).
So phase 8 owes them an answer.

The obvious place to put that answer is `ai.classifyTransaction` — except its proposal type has
exactly two members, `proposedKind: 'expense' | 'settlement'` (ADR-0007), and a transfer is
neither. Adding a third member would be a change to the AI contract, the domain model, and
`ai-boundary.md`, and it would assign to inference something that is not inferential.

Because it isn't. `domain-model.md` states that a `Payment` "always moves through an `Account`
the user owns — it can never, by itself, represent money someone else spent". Two payments that
share one bank reference, one amount and one instant, in opposite directions, are therefore the
same money leaving one account the user owns and arriving in another. That conclusion follows
from the fields alone. Nothing is being interpreted.

`CLAUDE.md` draws the line in exactly this place: deterministic code owns "deduplication
wherever the evidence is deterministic", AI owns "semantic transaction classification". And
ADR-0022 closes by reserving AI "for what deterministic code _cannot_ settle".

## Decision

**Classification has two legs, and the deterministic one runs first.**

`domain.isSelfTransferPair(a, b)` is a pure rule: two payments are the legs of one self-transfer
when they are different rows, neither is `ignored`, both carry the same non-null
`external_reference`, their amounts are equal, their directions are opposite, and their
timestamps fall inside a 60-second window. A payment with such a counter-leg is written
`counterparty_type = 'internal_account'`, `counterparty_id = null`, and stays at
`state = 'normalized'` — a valid terminal state for a transfer (`lifecycle.md`,
`invariants.md` #7, ADR-0011).

**No `AIInference` row is created for it**, because no model proposed anything. `proposedKind`
keeps its two members and this phase adds no third.

The rule is the deliberate mirror image of `domain.isDeterministicDuplicate`, which requires the
_same_ direction. ADR-0019 made direction load-bearing for deduplication precisely because
these two legs were being collapsed into one false duplicate; the same evidence, read the other
way round, is what identifies them as a transfer.

`counterparty_id` is `null` rather than the destination account's id: the statement line names
the far side only as free text ("SELF A/C X4821"), and resolving that to an `Account` row is a
different question — one no fixture currently has the evidence to answer. Exclusion from spend
comes from `counterparty_type` alone, which invariant #7 already guarantees.

## Consequences

**Both legs get classified, and each is its own audited unit of work.** The pairing evidence is
symmetric, so `classifyPayments` reaches the same conclusion from either side; a single-payment
call marks only the payment it was given, because a decision about the other leg is that leg's
own decision to record.

**A credit participates in classification after all.** The credit leg of a transfer must be
recognised, so the eligibility rule cannot simply exclude credits (ADR-0027 excludes them from
the _AI_ leg only). This is why `classificationEligibility` has three outcomes rather than two.

**A transfer never reaches the AI at all**, so it costs no model call and produces no proposal
anyone has to review. The AI leg sees a smaller, harder set of payments — which is the point.

**A transfer captured without a reference is not recognised.** Some sources record no reference
for one or both legs; those stay `unknown` and are left for a human. That is the same "recorded
outcome, not a gap" stance phase 7 took, and inventing a looser rule (same amount, opposite
directions, no reference) would silently reclassify a genuine pair of unrelated payments.

## Alternatives considered

- **Add `transfer` to `proposedKind` and let the model propose it.** Rejected: it hands
  deterministic evidence to an inference engine, requires a human to approve a conclusion that
  cannot be wrong, and grows the AI contract to cover something no model is needed for. It also
  contradicts ADR-0007's framing of `proposedKind` as the expense-vs-settlement discriminator.
- **Recognise the transfer during phase 7's normalization instead.** Rejected, and the reason it
  is a phase-8 rule rather than a phase-7 one is worth stating: normalization answers "who is the
  counterparty" from _this row's_ evidence, while this rule reads _two_ rows and concludes what
  the payment is. That is classification's question, and ADR-0021's "act only on `imported`
  payments" eligibility would also have been wrong for it.
- **Mark both legs `ignored` instead of `internal_account`.** Rejected: `ignored` means the row
  is out of the ledger's concern, and the reason is stored as free text. A transfer is very much
  the ledger's concern — reconciliation reports `ledger_transfers_total` as its own bucket
  (invariant #20) — and `counterparty_type` is the typed field that feeds it. `lifecycle.md`
  already says a transfer may stay `NORMALIZED` forever.
