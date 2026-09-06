# 0045. The item-refund allocation is rebuilt from recorded facts, and refuses to guess ownership

**Status:** Accepted (2026-09-06); implemented in Phase 18.

Extends [ADR-0018 (item refunds)](0018-item-level-refund-attribution.md), whose allocation
half this record implements. It changes none of that ADR's rules — 19.1–19.6 stand exactly as
written — and settles the three questions its "Calculation semantics" section leaves to the
implementation.

## Context

Phase 16 shipped `ExpenseAdjustmentItem`, its validation and its cumulative ceilings.
ADR-0018 fixes the pipeline that follows —
`financial event → adjustment → net item cost → superseding allocation → obligation` — and
states the rule the whole ADR exists for: only the beneficiaries of the item that came back
may absorb its refund. What it deliberately does not fix is _how_ the superseding allocation
is produced, and three questions had to be answered before the engine could be written.

**First, incremental or from scratch?** ADR-0008's existing `distributeAdjustment` derives the
amount to distribute as "the current lines' total minus the current net amount" and subtracts
it from where the lines happen to stand. That is correct for a whole-expense refund, where the
weights and the target are the same lines. It cannot express an item refund, where the target
comes from the items and only the weights come from the lines.

**Second, what happens when the current allocation cannot say who owned the refunded item?**
An `equal`, `percentage`, `exact` or `custom` allocation carries no `expense_item_id` on any
line. ADR-0018 says a human "must approve the item mapping or method change before
distribution", and that neither the AI nor the refund engine may invent beneficiary ownership —
but the shape of that refusal, and where it surfaces, was undecided.

**Third, how does a legacy whole-expense reduction coexist with item attribution?** ADR-0018
requires its unattributed reduction to be shown separately and "applied once", and forbids
pretending item net totals contain it. Two reductions with different rules have to reach one
set of lines that sums exactly to `netAmount`.

## Decision

**The item-attributed path recomputes the whole allocation from recorded facts, every time.**
`domain.buildItemAwareAllocationLines` takes the immutable gross `ExpenseItem.amount`s, every
`ExpenseAdjustmentItem` ever recorded, and the unattributed remainder, and derives the lines in
two stages:

1. **Item stage.** Each item's net cost — `gross − Σ attributions` — is placed on that item's
   own lines. A sole owner's line is that exact figure copied, with no division at all
   (ADR-0012's item-sourced exemption). A genuinely shared item apportions its net cost across
   its lines by the existing `splitByLargestRemainder`, weighted by their approved shares, with
   the documented `beneficiary_id`-ascending tie-break.
2. **Legacy stage.** Any unattributed reduction is then distributed over the item-derived lines
   by ADR-0008's own `distributeAdjustment` — the same function, reused rather than
   reimplemented — proportionally by default, or by an explicit weight set the caller supplies.

The current lines are read only as beneficiaries and as weights, never as a target. That is
what makes the result independent of how many times distribution ran along the way and of the
order the refunds arrived in: `Σ net item cost − unattributed reduction` is a function of the
ledger's recorded facts alone, and it equals `domain.netAmount` whenever the items account for
the expense's gross amount, which `validateExpenseItemsSum` already requires.

Idempotence is preserved at the boundary rather than by making the arithmetic a fixed point:
`services.distributeAdjustment` still refuses outright when the current allocation already sums
to the net amount, so the same state is never rewritten twice.

**An allocation that cannot express item ownership is refused, with a new domain error code
`REFUND_ITEM_OWNERSHIP_REQUIRED`.** It covers three shapes: a line with no `expense_item_id`, an
item with no line at all, and a shared item whose approved shares are all zero. All three mean
the ledger has no approved answer to "whose item was this", and the whole-basket proportional
default is exactly the wrong answer to fall back on. `services.getRefundAllocationState` reports
the same refusal as a pending review decision instead of throwing, because "this cannot be
distributed yet" is a state the product has to show, not an error to swallow.

**The two reductions stay separate all the way through.** `listExpenseAdjustmentSummaries` reads
adjustments apart by whether they carry attribution rows; the item stage's targets are
gross-minus-attribution and never absorb the legacy reduction; the legacy stage applies it once,
afterwards. Invariant #14's per-item form is checked against net item costs only while no
unattributed reduction is in play — with one, a line's share is its item's net cost less that
item's part of the whole-expense refund, and the invariant's own wording keeps the two
distinguishable. `DistributeAdjustmentResult` and the audit event both carry
`attributedReduction`, `unattributedReduction` and the per-item net costs, so the pipeline is
readable after the fact rather than only at the moment it ran.

**No schema change.** Every input the engine needs is already recorded, and allocation versions
are already append-only.

## Consequences

`src/domain/refund-allocation.ts` is new; `domain/adjustment.ts`, `domain/allocation.ts` and
`domain/rounding.ts` are unchanged in behaviour. `services.distributeAdjustment` branches on
whether any attribution exists, takes the same row lock `recordExpenseAdjustment` takes, and
returns the basis it used. `services.approveAllocation` now allocates item-based lines against
each item's **net** cost — with no attributions that is the gross amount, so nothing about a
never-refunded expense changes. `services.getRefundAllocationState` and
`GET /api/expenses/:expenseId/refund-allocation` are new reads;
`POST /api/expenses/:expenseId/adjustments` gained the optional `itemAttributions` body field
that Phase 16's service had been waiting for.

One consequence is worth stating plainly: because the item-attributed path rebuilds from
recorded facts, a **non-proportional** distribution of an earlier legacy reduction is not
preserved through a later rebuild — the default proportional shape is re-derived unless the
caller states the weights again. Storing per-adjustment distribution weights would preserve it,
at the cost of a new column and a second place for a distribution decision to live. Since the
weight set is supplied per call today and the resulting allocation is the record, restating it
is the same act as choosing it the first time. This is a real limitation, deliberately taken,
and the arithmetic is unaffected: the reduction is still counted exactly once.

## Alternatives considered

- **Extend `distributeAdjustment`'s decrement in place, subtracting each new refund from the
  current lines.** Rejected: the target of an item refund is a property of the items, not of
  the lines, so the decrement would have to reconstruct the item targets anyway — and doing it
  incrementally makes the result depend on the order refunds arrived and on how often
  distribution ran, which is precisely what "deterministic, identical inputs produce identical
  outputs" forbids.
- **Fall back to the whole-expense proportional default when the allocation names no items.**
  Rejected outright: ADR-0018 exists because that default reduces a debt owed by someone whose
  item was never refunded. Silently doing it when ownership is merely unstated would reintroduce
  the bug in the one case where the ledger has least reason to be confident.
- **Infer item ownership from the beneficiary set (e.g. "the sole beneficiary owns everything").**
  Rejected: it is an inference about a financially consequential fact, which makes it a
  proposal requiring approval at best, and ADR-0018 names inventing beneficiary ownership as
  something neither the AI nor this engine may do.
- **Fold the unattributed reduction into per-item targets so there is one stage instead of
  two.** Rejected: ADR-0018 explicitly forbids pretending item net totals contain a
  whole-expense reduction, and doing it would make an item's recorded net cost disagree with
  its own attribution rows.
- **Store each adjustment's distribution weights so a custom legacy shape survives a rebuild.**
  Considered, and the reason it was not taken is in "Consequences" above: a new column, and a
  second home for a decision the allocation already records, for a case a caller can restate in
  one field.
