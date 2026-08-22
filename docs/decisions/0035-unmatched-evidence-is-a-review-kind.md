# 0035. An unmatched document is a review kind ranked last, and carries no proposal

**Status:** Accepted

## Context

A document can be ingested with no `linked_payment_id` and no `linked_expense_id` — a receipt
photographed at the till, before any statement carrying that transaction has been imported. Phase
10 makes that state reachable, so something has to surface it, or a receipt with no home is
simply invisible.

`docs/roadmap.md` already scoped the answer: _"the review queue is where an unmatched receipt
will surface. Adding a kind is one entry in `domain.REVIEW_RANKS` with an argument written next
to it (ADR-0029), not a new queue."_ Two questions were left: **where does it rank**, and **does
the item propose where the document belongs?**

## Decision

**`unmatched_evidence` is a fourth review kind, at rank 4 — last.** The argument, per ADR-0029's
requirement that the order be written down rather than left in a comparator:

- **No ledger number is wrong while it sits there.** Every kind above it is about money this
  ledger has already recorded: a possible duplicate may be counting one transaction twice, a
  pending classification is an unmade decision about a recorded payment, a rejected one is a
  recorded payment with no explanation. An unmatched document is about money the ledger may never
  have seen. Nothing is double-counted, no obligation is misreported, and no total moves when it
  is resolved.
- **Its amount is genuinely unknown.** Reading a total off a document is extraction — phase 11 —
  so at ingestion there is no stake to compare. `ReviewQueueEntry.amount` is `0n`, and that zero
  means _unknown_, not _free_; it is documented where the field is declared. The effect is that
  unmatched documents sort oldest-first among themselves rather than pretending to a materiality
  nobody has established.

It is in the queue at all because a receipt with no home is one of two things worth a human's
attention: a purchase nothing in the ledger recorded, or a link only a person can make.

**Only documents, never manual notes.** A note's links were chosen by the person who typed it, in
the same act. An unlinked note is a note about nothing in particular; an unlinked _file_ can
arrive from a share sheet with nothing else known about it. `db.listUnmatchedEvidence` filters on
`storage_ref is not null`, served by a partial index.

**The item carries no proposal about where the document belongs.** Matching a receipt to a payment
needs an amount and a date to match on; the date is the capture time, but the amount is locked
inside the document until extraction reads it. A guess here would be an inference in the one place
in this system with no confidence level to route on (`ai-boundary.md`, ADR-0024) — and the
deterministic version of the same match becomes possible in phase 11 for free. The action the item
implies is `services.linkEvidence` (ADR-0034), and the reviewer supplies the answer.

## Consequences

`REVIEW_ITEM_KINDS`, `REVIEW_RANKS`, `ReviewReason` and the queue's `counts` all gain one member,
which is exactly the shape ADR-0029 predicted. `ReviewQueueItem` becomes a union whose members no
longer all carry a `payment` — the first kind that is not about one — so readers narrow instead of
assuming.

A user who ingests documents faster than they import statements accumulates a tail of unmatched
items. They sit at the bottom, they move no number, and phase 11 is what shortens the tail by
making a deterministic amount-and-date match possible.

## Alternatives considered

1. **Rank it above `rejected_classification`.** Both are "nothing is at risk" items, but a
   rejected classification is a payment this ledger recorded and cannot explain — money in,
   unaccounted for — while an unmatched document is a piece of paper. The unexplained payment is
   the one that makes `unexplained` non-zero.
2. **Rank it by an amount read from the document.** That amount does not exist yet. It is exactly
   what phase 11 produces, and ranking on it before then would mean either guessing or blocking
   the queue entry on a phase that has not shipped.
3. **A separate "unmatched documents" listing outside the review queue.** Rejected by the roadmap
   in advance, and rightly: it splits "what needs a human" across two surfaces, and the reviewer
   then has to remember the second one exists.
4. **Propose a match at ingestion, using the capture time against nearby payments.** Time alone
   matches far too much — every payment that day — and a proposal that is usually wrong trains a
   reviewer to accept without reading, which is the failure mode the whole confidence-routing
   design exists to avoid.
