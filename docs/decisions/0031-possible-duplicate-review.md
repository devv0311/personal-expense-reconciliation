# 0031. A possible duplicate is confirmed or dismissed by a human, and both are recorded

**Status:** Accepted

## Context

`invariants.md` #10 has always had two halves. Deduplication is deterministic when two payments
share direction, amount, a non-null `external_reference` and a tight window — the importer acts
on that automatically (ADR-0019). Otherwise it "is surfaced as a _possible_ duplicate for human
confirmation, never silently merged or silently kept as two."

Only the first half existed. `domain.isPossibleDuplicate` has been in the codebase since the
foundation pass **with no caller**, and the importer explicitly leaves such rows alone, noting
that "surfacing those is review-queue work, not import work". Phase 9 is that queue.

Two things needed deciding: what confirming actually does, and what happens to a pair a reviewer
looks at and rules out — because without an answer to the second, a queue containing one
unresolvable resemblance can never be emptied, and a queue nobody can empty is one nobody reads.

## Decision

**Three categories stay distinct in the model**, and the queue names them:

| Category            | How it looks in the data                                             |
| ------------------- | -------------------------------------------------------------------- |
| Confirmed duplicate | `state = ignored`, `ignored_reason = duplicate_of:<canonical>`       |
| Possible duplicate  | Two live payments, plus a queue item — nothing on either row changes |
| Normal payment      | Neither                                                              |

**Confirming** (`services.confirmPossibleDuplicate`) moves the copy `imported|normalized →
ignored` with the existing reason format, resolving the **canonical** head of the
`duplicate_of` chain first so one hop from any copy reaches the row that counts. It re-checks the
pair against `domain.isPossibleDuplicate` before acting: if the two are not even candidates, it
refuses. "The reviewer said so" is not evidence that two unrelated payments are the same money,
and a wrong confirmation silently removes real spend from every total.

**Dismissing** (`services.dismissPossibleDuplicate`) changes nothing about either payment — both
are real and both still count — and records the decision as an `AuditEvent` carrying an
order-independent `possibleDuplicatePairKey`. The queue reads those back and stops offering the
pair.

Both require an attributable human actor (`domain.parseDecisionActor`). A `linked` payment is
never a candidate: the lifecycle draws no `linked → ignored` edge, because discarding an
explained payment would orphan the expense it funds.

The queue's default pairing window is **24 hours**, not `isPossibleDuplicate`'s own 60 seconds,
for the reason the importer widened its own: a bank statement carries a _date_, so two captures
of one transaction are the same calendar day rather than seconds apart. It is a caller option,
not a new domain rule.

## Consequences

**Import-time behaviour is untouched.** ADR-0019's deterministic path still runs first and still
discards what a shared reference proves; this only surfaces what it deliberately left.

**A dismissal lives in `audit_events`, not in a table of its own.** It _is_ a decision, and
decisions are already recorded there — giving it a table would mean a second place that has to
agree with the first. The cost is a JSON-keyed read (`listDismissedDuplicatePairs`), which is
honest about being a query over recorded decisions rather than over derived state.

**A dismissal is permanent for that pair**, in both directions, because the key is
order-independent. Un-dismissing is not offered: nothing in the review surface needs it yet, and
adding it later is a new audited action rather than a change to this one.

**Three lookalikes make three pairs.** The queue offers each pair separately rather than
clustering, which keeps every item one yes/no question. Clustering would be a nicer UI and a
worse decision record.

## Alternatives considered

- **Auto-confirm a possible duplicate above some similarity score.** Rejected — it is the exact
  thing invariant #10 forbids ("never silently merged"), and a similarity score is the kind of
  unexplainable number ADR-0029 already declined for ordering.
- **Widen the deterministic rule instead** (e.g. match on amount + date without a reference).
  Rejected: it would silently discard genuinely distinct same-amount payments — two ₹450 coffees
  on one day are not one coffee — and it would reclassify a decision as a fact.
- **Store dismissals in a `duplicate_reviews` table.** Rejected as a second source of truth for
  something the audit log already records. If a future phase needs to query dismissals at scale,
  a projection over `audit_events` is a smaller change than reconciling two writers.
- **Let the reviewer name any two payments as duplicates without a candidacy check.** Rejected:
  the check is cheap, and skipping it turns a review action into an unguarded way to delete money
  from the ledger's totals.
- **Mark the _older_ payment as the duplicate when the reviewer names them in that order.**
  Rejected in favour of the caller naming which one is discarded explicitly, with the canonical
  chain resolved from the survivor. Guessing which of two rows should die is not a guess this
  layer should make.
