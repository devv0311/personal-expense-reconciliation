# 0030. Re-classification is an explicit review action; a re-run stays a no-op

**Status:** Accepted

## Context

`lifecycle.md` defines `superseded` for an `AIInference` — "a newer inference for the same input
replaced this one, unresolved" — and phase 8 produced none, deliberately: a payment that already
carries a classification inference is not eligible for classification again
(`already_classified`), which is what makes `classifyPayments` a no-op on a second run (the
ADR-0021 pattern).

That leaves a real gap phase 9 has to close. A reviewer looking at a proposal has three answers
today — accept, modify, reject — and none of them is _"ask again"_. Rejecting is not the same
thing: it records that this proposal was wrong and leaves the payment unexplained, with no way to
get a fresh proposal for it, because the eligibility rule now skips it forever.

The obvious shortcut is to make a re-run reconsider anything undecided. That is exactly what
ADR-0021 rejected for normalization, and for the same reason: it turns a scheduled job into
something that silently rewrites a derived value a human may already have acted on.

## Decision

**`services.reclassifyPayment` is the only thing that lifts the idempotency rule**, and it
requires an attributable human actor (`domain.parseDecisionActor`, which rejects `ai` and
`system`).

What it does, in order:

1. Refuses a payment that is not `normalized` — an explained payment would have to be
   un-explained first, and an ignored one is out of the ledger's concern.
2. Refuses a payment whose latest proposal was **accepted** or **modified**: it is already
   explained by an approved `Expense` or a `Settlement`, and unwinding that is not a review
   action this phase offers.
3. Calls the model, validates the answer through both gates, and then — **in one transaction** —
   marks the previous proposal `superseded` (if it was `pending`), moves the expense that
   proposal created to `rejected` (ADR-0028), records the new proposal and its new DERIVED
   expense.

A **`rejected`** proposal is not superseded. It was decided, and a decision the trail keeps is
not rewritten as though nobody made it; re-classification after a rejection simply adds a new
proposal beside it.

The single transaction is the load-bearing part. Superseding first and asking afterwards would
leave a payment whose only proposal is marked `superseded` if the model never answered — a state
the queue shows as _nothing at all_, because it is neither pending nor rejected.

`classifyPayment`'s proposal-recording core is extracted (`proposeClassification`) and shared,
rather than adding a `force` flag: a flag that skips the idempotency rule is a flag that will
eventually be passed by something that should not.

## Consequences

**`superseded` is now produced**, by exactly one caller. The audit event on the inference says
who asked and why, and the expense's own event says it was closed because its proposal was
replaced.

**A plain `classifyPayments` re-run is still a no-op**, and there is a test asserting exactly
that next to the re-classification tests, so the two behaviours are visibly different rather
than accidentally similar.

**One payment can accumulate several inferences.** `findClassificationInferenceByPayment` already
returned the newest rather than assuming uniqueness — written that way in phase 8 for this
arrival — and the queue keys classification items on the inference id, so a superseded proposal
simply stops appearing.

**Re-classification costs a model call**, deliberately. It is a human asking for a second
opinion, not a retry loop; nothing schedules it, and nothing retries it automatically.

## Alternatives considered

- **Let `classifyPayments` reconsider any payment with no _decided_ proposal.** Rejected: it
  makes a scheduled job rewrite proposals a reviewer may be looking at, and it removes the
  distinction between "the classifier has not seen this" and "the classifier answered and a
  human has not decided". ADR-0021 settled the same question for normalization.
- **A `force: true` flag on `classifyPayment`.** Smaller diff, worse boundary — see above.
- **Delete the old inference instead of superseding it.** Rejected outright: it is evidence of
  what a model proposed, and the whole point of `AIInference` is that this record survives the
  decision.
- **Allow re-classification of an accepted proposal, unwinding the `Expense`/`Settlement`.**
  Rejected as out of scope and unsafe here: unwinding means reversing an approved record, its
  `PaymentExpenseLink`, and the payment's `linked` state, none of which the lifecycle draws a
  path back from. A correction to an approved expense already has a mechanism —
  `ExpenseAdjustment` (ADR-0008) — and inventing a second one in a review queue would put two
  ways to undo money in the system.
