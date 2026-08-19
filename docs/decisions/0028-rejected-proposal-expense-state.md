# 0028. A declined or superseded proposal's Expense becomes `rejected`, a terminal state

**Status:** Accepted. Resolves the open question ADR-0026 deferred to phase 9.

## Context

Phase 8 writes a DERIVED `Expense` when a classification proposal is recorded — it has to, or
`REVIEW_REQUIRED` is a state nothing can reach and `data-flow.md` step 5's `db.updateExpense
(APPROVED)` has no row to update (ADR-0026). That left one thing unresolved, deliberately:

> **A rejected classification leaves its DERIVED expense unapproved, and nothing deletes it.**
> … **Deciding what the review queue does with such a row is phase 9's**, and it is recorded
> here as a known, deliberate loose end rather than discovered later as a leak.

The row is harmless to totals — every `ledger_*` bucket enumerates the states it counts, starting
at `approved` (`invariants.md` #20) — but it is not harmless to _readers_. `expenses` acquires
rows that look like work in progress and are not, with nothing on the row itself to say so.
Phase 9 also adds a second way to produce one: a **superseded** proposal, when a reviewer asks
for re-classification (ADR-0030), leaves exactly the same orphan.

## Decision

**`EXPENSE_STATES` gains `rejected`, terminal, reachable only from `classified` and
`review_required`.**

```
classified ──┐
             ├──▶ rejected   (terminal)
review_required ─┘
```

`services.decideInference(reject)` moves the proposal's DERIVED expense there in the same audited
transaction as the inference's own status change. `services.reclassifyPayment` does the same to
the expense behind the proposal it supersedes. The audit event carries the distinction:
`reason` says whether the proposal was declined or superseded, exactly as `payments.ignored_reason`
distinguishes `duplicate_of:<id>` from `out_of_scope` without needing two payment states.

Nothing is deleted. Nothing that was ever `approved` can reach this state — `approved` does not
list `rejected` among its transitions, and that asymmetry is the point: declining a _proposal_ is
cheap, and unwinding an approved financial record is not something a lifecycle transition should
pretend to do.

`Expense.amount` stays unfrozen for a `rejected` expense (`isExpenseAmountFrozen` returns false),
because freezing is a consequence of approval and this row was never approved. Nothing can write
to it either way: there is no update path for `expenses.amount` anywhere in `src/db`.

## Consequences

**Every total excludes it by construction, not by vigilance.** `loadReconciliationInput` already
filters `state in ('approved', 'allocated', 'ready_to_sync', 'synced', 'reconciled')`, so a
rejected expense is outside it without that query changing. The alternative — recognising a dead
proposal by joining to its inference's status — would have made every future query over
`expenses` responsible for remembering to exclude it, which is how a row eventually gets counted.

**The queue can tell the two apart trivially.** A `review_required` expense is waiting for a
human; a `rejected` one is finished. Both are unapproved, and before this decision the only
difference between them was a join.

**A rejected proposal's payment goes back to being unexplained**, and that is what the queue
surfaces (`rejected_classification`, ranked last — nothing is at risk, the work is merely
unfinished). Re-classifying it is an explicit act (ADR-0030); a plain `classifyPayments` re-run
still skips it as `already_classified`, so a rerun cannot quietly produce a second proposal.

**One migration**, `0005_expense_rejected_state.sql`, rewriting the `expenses_state_check`
constraint. Additive in effect: no existing row changes, and no code that reads existing states
changes.

## Alternatives considered

- **Leave the row unapproved and recognise it by its inference's status.** No schema change, and
  it was phase 8's implicit state. Rejected: it makes "is this expense real?" a join rather than
  a column, in the one table where getting that wrong means counting money that does not exist.
  `expenses.state` is how every other lifecycle question here is already answered.
- **Delete the expense on rejection.** Rejected outright. Nothing in this ledger deletes financial
  records — the repository has no delete path at all in `src/db` by design (`invariants.md` #4,
  #22) — and a deleted row takes its audit trail's subject with it.
- **Add `archived_at` to `expenses` instead**, matching `people`/`merchants`. Rejected: soft
  deletion answers "should this be listed?", not "what happened to it". A state answers both, and
  the lifecycle is already the vocabulary this system reasons in. Adding a second, parallel
  mechanism for the same question is how two sources of truth start.
- **Two states, `rejected` and `superseded`, mirroring the inference statuses.** Rejected as
  distinction without a difference at the _expense_ level: in both cases a human declined this
  proposal, and the audit event already records which. `AIInference.status` keeps the distinction
  where it is meaningful.
- **Reuse the proposal's expense on re-classification rather than rejecting it.** Considered —
  it would avoid the orphan entirely by updating the existing row in place. Rejected because it
  makes one `Expense` row the subject of two different proposals, so its audit trail interleaves
  two decisions and `ai_inferences.resulting_record_id` stops being a one-to-one pointer. A fresh
  proposal producing a fresh row keeps both trails legible.
