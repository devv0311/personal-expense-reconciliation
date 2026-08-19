# 0029. The review queue is ordered by a pure function, and carries every reason

**Status:** Accepted

## Context

Phase 9 has to answer "what is waiting for me?" — and a queue is not a list, it is an _order_.
Two properties were open:

1. **What comes first.** The queue mixes four unlike things: proposals routing flagged, proposals
   it did not, possible duplicates, and payments left unexplained by a rejection. Nothing said
   how they compare.
2. **Where the order lives.** `domain.routeClassificationForReview` already computes why a
   proposal needs review (ADR-0024). A second ranking written in a service or, worse, in the API
   layer, would be a second answer to the same question — and the two would drift.

There is also a determinism requirement that is easy to under-specify. This repository has
already shipped one ordering defect (audit events tied on a millisecond timestamp and fell
through to a random UUID, fixed by a monotonic `sequence`). A queue that reorders itself between
two reads of an unchanged ledger is the same defect with a reviewer's attention as the casualty.

## Decision

**`domain.prioritiseReviewQueue` is a pure function over a total order**, and it is the only
ranking in the system.

```
rank asc  →  amount desc  →  occurred_at asc  →  id asc
```

Ranks, in order, with the argument for each:

| Rank | Kind                                          | Why here                                                                                                                                                                                       |
| ---- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `possible_duplicate`                          | Until it is resolved the ledger may be counting one transaction twice, and every downstream number derives from those rows. It is also the cheapest decision to make — two rows, one question. |
| 1    | `classification_decision`, routing flagged it | Low confidence, a material amount, or a settlement (ADR-0024).                                                                                                                                 |
| 2    | `classification_decision`, routing did not    | A high-confidence, immaterial proposal. It still needs a decision — nothing auto-approves — it just needs less attention. This rank _is_ "confidence changes friction, never the requirement". |
| 3    | `rejected_classification`                     | A payment left unexplained by a decision already taken. Unfinished, not pending; nothing is at risk.                                                                                           |

Amount descending before age, because a ₹40,000 proposal from yesterday deserves attention before
a ₹120 one from last month. Age before id, so the ordering stays meaningful rather than merely
stable. **The id is the tie-break of last resort**: without it two identical-looking entries would
be ordered by whichever row the database returned first, which is not an order at all.

`domain.classificationReviewReasons` maps a `ReviewRoute` to the queue's reasons, reusing phase 8's
routing rather than re-deriving it — so the queue's explanation and the expense's actual state
cannot disagree. Every reason is carried, never just the first, and a proposal routing did not
flag reports `decision_required` rather than nothing.

## Consequences

**The API layer contains no ranking.** `src/api` serializes what the service returns, in the order
it returns it. That is what keeps `system-architecture.md`'s "no business logic in `api`" true for
the first surface that could plausibly have argued otherwise.

**Two reads of an unchanged ledger are byte-identical**, which is what makes the queue safe to
poll and testable by repetition rather than by inspection.

**Ordering is not stored anywhere.** No `priority` column, no materialized queue. The inputs
(`confidence`, amount, `proposedKind`, `occurred_at`) are already stored, and a derived value
that is also stored is a value that can drift from its own rule.

**Adding a kind is a rank decision, in one place.** Phase 10+ items (an unmatched receipt, a
drifted Splitwise sync) slot into `REVIEW_RANKS` with an argument written next to them, rather
than each surface inventing its own precedence.

## Alternatives considered

- **Order by age alone (a FIFO queue).** Simple and obviously fair. Rejected because it ignores
  the only signal that reliably tracks consequence — the amount — and because a possible
  duplicate discovered today would sit behind a month of routine proposals while the totals it
  affects stay wrong.
- **Score items numerically (confidence × amount × age) and sort by the score.** Rejected: a
  score is unexplainable ("why is this third?" has no answer a reviewer can check), it is
  sensitive to weights nobody can justify at this scale, and it would make the order depend on
  floating-point arithmetic in a codebase whose whole discipline is exact integers.
- **Let the API sort, since it knows the client.** Rejected — that is the business logic leak
  `system-architecture.md` names explicitly, and it would put the queue's meaning in the layer
  most likely to be rewritten.
- **Store a `priority` column on the inference.** Rejected for the same reason ADR-0024 declined
  to store the routing decision: it is derivable from data already stored, and a stored
  derivation is one that can silently disagree with the rule that produced it.
