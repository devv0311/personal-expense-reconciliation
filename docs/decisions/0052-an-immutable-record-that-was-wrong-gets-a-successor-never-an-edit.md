# 0052. An immutable record that was wrong gets a successor, never an edit

**Status:** Accepted

## Context

Two of the 7 September audit's rows are the same problem wearing different clothes.

Row 13: ADR-0034 makes evidence linkage write-once. A receipt attached to the wrong payment
could therefore never be moved — and there was no way to _say_ it was wrong either, so the
ledger kept asserting a link nobody believed.

Row 23: an `ExpenseAdjustment` is append-only. A refund recorded that never happened had no way
out, and every read that counts money counted it. The expense's net stayed permanently too low,
and the obligations derived from it with it.

Both sit on the same rule, and the rule is right: `invariants.md` #4 and #6 exist because a
ledger that edits its own past cannot be audited. The failure is not that the records are
immutable. It is that immutability had been implemented as "there is no way out", when the
correct shape has always been a third option between _edit it_ and _live with it_.

## Decision

### A wrong link is replaced by a new record carrying the same source facts

`POST /api/evidence/:evidenceId/supersede` writes a **new** evidence row carrying the same
immutable source facts — the same content-addressed document, the same raw text, the same
`captured_at` — with the corrected links, and stamps the original with
`superseded_by_evidence_id` and `supersede_reason`.

The wrong link stays on the wrong row. That is the point: "why did this ledger once believe
that receipt paid for this?" stays answerable, which it would not be if the link had been
moved. The content address means the successor points at the same bytes rather than a second
copy of them (ADR-0033).

The structured reading is carried across rather than re-derived, because it was a reading of
the _document_ rather than of the link, and re-deriving it would silently discard a human
correction to it.

### A wrong adjustment is stamped reversed, and stops being counted

Three columns — `reversed_at`, `reversal_reason`, `reversed_by` — granted at the role level the
way `allocations.superseded_at` already is. The amount, the kind, the date and the expense it
named all stay exactly as written. Reversal says _this was recorded in error_; it does not
rewrite what was recorded.

Fifteen reads now apply `db.ACTIVE_ADJUSTMENT`. **One deliberately does not**:
`collectExpenseTimelineSources`, because a history that hid the ledger's own corrections would
be rewriting its past rather than recording it. An expense's timeline shows the adjustment and
shows that it was reversed.

### Two arithmetic consequences that had to be faced rather than worked around

`domain.undistributedAmount` used to throw when the current allocation was _behind_ the net
amount. That was correct while nothing could make a net rise: every adjustment only ever
lowered it. Reversal can raise it, so the function now returns a **signed** figure and callers
test `!== 0n`.

And ADR-0008's "subtract a reduction from each line" path cannot run backwards. A risen net
therefore goes through `domain.restoreAllocationToNetAmount`, which re-splits to the new target
by the current lines' own weights under the one Largest Remainder Method — and **refuses** when
every line is zero. The fully-refunded shape (ADR-0013) keeps one zero-amount line per original
beneficiary, which has no proportions left to rebuild from; an equal split there would be a
guess about somebody else's money, so it raises `ALLOCATION_WEIGHTS_UNRECOVERABLE` instead.

### A reversal never rewrites an approved allocation

It reports that redistribution is **pending**. `distribute` stays the deliberate second act it
already was (`invariants.md` #6): the ledger says the obligations below are no longer current
and waits for a person, rather than quietly re-deriving what somebody had approved.

## Consequences

- **The audit trail gains two new shapes of event and loses none.** A superseded evidence row
  and a reversed adjustment are both visible as what they are, with an actor and a reason.
- **`ACTIVE_ADJUSTMENT` is now the default posture for anything that counts.** A new read that
  sums adjustments and forgets it will over-count a reversed one; the condition is a single
  exported predicate precisely so that a reviewer can grep for its absence.
- **Migration `0014_evidence_and_adjustment_supersession.sql` is additive**, and the
  `evidence_unmatched_idx` partial index was rebuilt to exclude superseded rows — a corrected
  record should not also appear in the unmatched queue.
