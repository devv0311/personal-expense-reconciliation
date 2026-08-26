# 0037. Receipt-to-payment matching surfaces candidates only; linking stays a manual, write-once action

**Status:** Accepted

## Context

ADR-0035 left `unmatched_evidence` carrying no proposal about where a document belongs, because
"matching a receipt to a payment needs an amount, and reading one off the document is
extraction — phase 11." That phase has now shipped: `services.extractReceipt` gives a receipt a
`total`, and an amount-and-date match against live payments is deterministic — `src/domain`
arithmetic over two rows, not an inference.

The natural next question is what to do with a match. The strongest version — auto-link when
exactly one payment matches — runs straight into ADR-0034: `evidence` linkage is **write-once**.
`null → id` is permitted; re-pointing or clearing a recorded link is not, because "anything
extracted from this evidence reaches its payment and expense through exactly these two columns."
A same-amount, same-day coincidence is not a rare shape (two purchases at the same round figure,
a subscription and a one-off charge landing on the same date) and an auto-link that turns out
wrong cannot be undone by this system — only worked around by ingesting superseding evidence,
which does nothing to un-misattach the original document from the payment it was wrongly
attached to.

## Decision

**Matching produces candidates, never a link.** `domain.findCandidatePaymentMatches` is a pure
function: exact `Payment.amount = Receipt.total`, `Payment.occurred_at` within a bounded window
(default 3 days) of `Evidence.captured_at`, restricted to live (`imported`/`normalized`), debit,
currently-unlinked payments. It returns an ordered list — closest date first — and nothing more.

The `unmatched_evidence` review item (`services.listReviewQueue`) is enriched with this list once
a `Receipt` exists for the evidence. Attaching evidence to a payment is still, and only,
`services.linkEvidence` (phase 10, ADR-0034) — unchanged by this phase. A reviewer looking at the
enriched item sees the same candidates a machine would have picked, and still has to click.

The date window is intentionally generous rather than same-day: a forwarded email receipt or a
photographed paper one is routinely captured after the purchase, not at the instant of it, and
`Evidence.captured_at` — not an unextracted purchase date — is the only capture-time fact this
system has.

## Consequences

- `unmatched_evidence`'s `amount` field (`domain.ReviewQueueEntry`, ADR-0029/0035) finally
  carries a real figure once extraction has run, so materiality ordering applies to it the same
  way it already applies to every other review kind.
- No new write path was needed: `services.linkEvidence`'s write-once guarantee is exercised
  exactly as it already was, just now with a suggestion in front of it instead of a blank
  "attach this to something" prompt.
- A receipt whose total matches nothing currently in the ledger (the purchase has not been
  imported yet, or was paid by someone else with no `Payment` this system observes, ADR-0006)
  surfaces an empty candidate list — itself informative, and distinct from a receipt that has
  not been extracted at all (`receiptId: null` vs. `receiptId` set with `candidateMatches: []`).

## Alternatives considered

1. **Auto-link when exactly one payment matches.** Rejected for the reason in Context: a wrong
   auto-link is unrecoverable under ADR-0034, and "exactly one match" is not the same guarantee
   as "the correct match" — it only means no other live payment happens to share the amount and
   window today, which can change as more statements import.
2. **A confidence-scored proposal, routed through review the way `classify_transaction` is.**
   Rejected: `ai-boundary.md`'s confidence machinery exists for judgement calls a model makes
   over ambiguous evidence. An exact amount match within a date window is not a judgement — it is
   arithmetic — and dressing it up as a scored proposal would misstate what kind of claim it is
   (ADR-0035's "no confidence level to route on" carries forward here, one layer later).
3. **Widen or narrow the date window based on evidence type** (e.g. tighter for `receipt_image`,
   wider for `email_receipt`). Rejected as unmotivated complexity for this phase: nothing in the
   fixtures or the domain model distinguishes capture-lag by evidence type, and a single named
   constant is easier to reason about and to revisit than a type-keyed table with no data behind
   it yet.
