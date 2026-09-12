# 0055. A correction edits the entry they are looking at

**Status:** Accepted

## Context

The September 2026 capability audit's row 40 said:

> `stale` and `drifted` are meaningful states/findings, not implemented repair actions.

Phase 22 closed that row, and the way it closed it is the problem this ADR exists to fix.
`services.resyncExpenseToSplitwise` corrected a stale entry by calling `createExpense` a second
time and re-pointing the local row at the new id. Its own docstring was candid about it:

> Splitwise's API has no update-in-place for an expense's shares that this system can rely on,
> so a re-sync creates a corrected entry and records it against the same local expense.

Read from this ledger, that is tidy: one `SplitwiseExpense` row, one current external id, a
`supersedesExternalId` in the snapshot so an audit can still explain its own past findings.

Read from the other person's phone, it is not a correction at all. They had one entry for a
₹900 dinner saying they owed ₹450. Now they have two entries for one dinner — the original at
₹450 and a new one at ₹300 — and nothing on their screen says the first is superseded, because
nothing in Splitwise knows it is. Splitwise's pair balance counts both. The repair made their
ledger **less** accurate than the stale figure it replaced, and it did so silently, on the one
screen in this product that writes to somebody else's records.

The premise was also wrong. Splitwise's v3 API has `POST /update_expense/:id`, taking the same
parameters as `create_expense`, and `POST /delete_expense/:id`. The capability was there.

There is a second thing the create-a-duplicate approach could not do at all. When a refund takes
an expense's net to zero, there is no figure to push: ADR-0013 settled that a fully refunded
expense keeps one zero-amount line per original beneficiary, and Splitwise will not hold a
zero-cost expense. The old repair either pushed a nonsense entry or left the pre-refund figure
standing, which asserts a debt this ledger no longer says exists.

## Decision

### The external id does not move

A repair calls `updateExpense` with the id this ledger already recorded, and the id it gets back
must be that same id. The adapter checks it, the service checks it again, and a mismatch is
refused as `SPLITWISE_SYNC_FAILED` with nothing written locally — because an answer carrying a
new id means Splitwise created rather than corrected, which is the exact outcome this decision
exists to prevent, and recording it as "corrected" would hide it.

### A port that cannot correct refuses by name

`updateExpense`, `deleteEntry` and `updatePayment` are **optional** on `SplitwisePort`, the same
shape ADR-0046 chose for `fetchLedgerEntries`. An adapter that does not implement them makes the
repair fail with a message naming the missing method. It never falls back to `createExpense`.

The fallback is the defect, not the safety net. A capability that silently degrades into a
different, worse write is how the previous version shipped looking correct.

`GET /api/splitwise/resync-candidates` carries a `capability` object so a screen can say the
repair is unavailable rather than offer a button that fails — ADR-0050's rule read backwards.
The unconfigured stub in `server.ts` _declares_ all three and rejects when called, because "no
credentials are set" is a different statement from "this adapter cannot edit in place", and
`createExpense` already reports the former.

### Deletion exists for exactly one case, and it is not tidiness

`deleteEntry` is called when, and only when, the expense's net has reached zero. The local row
moves to a new `withdrawn` status, keeping the external id it held, because an audit that could
no longer see the entry it once matched could not explain its own past findings.

An external row this ledger merely cannot _explain_ stays a finding for a person to resolve
(ADR-0046). Deleting somebody else's record to make a check come out clean is the opposite of
auditing it, and nothing in this work does it.

### `withdrawn` is a status, not a footnote

A withdrawn row becomes a repair candidate again once its expense's net comes back off zero — a
reversed adjustment (ADR-0052), say. That repair must **create**, because nothing is standing in
Splitwise to correct, and keeping `withdrawn` distinct from `stale` is what lets the service
know which of the two it is doing. Folding it back into `stale` would send an update to a
deleted entry.

A withdrawn row whose net is still zero is not listed at all: there is nothing left to assert.

### Which repair a row needs is decided once, server-side

`ResyncCandidate.plannedRepair` is `corrected`, `withdrawn` or `recreated`, computed by the
service and quoted by the screen. A surface must state the consequence before a person confirms
it, and "the net is zero, so this deletes their entry" is a conclusion drawn from the figures.
Drawing it in the browser would put a second copy of the repair's own rule somewhere it could
drift from the rule the repair actually follows (ADR-0048).

### Settlements get the same repair, and nothing more

`resyncSettlementToSplitwise` corrects a `drifted` settlement in place via `updatePayment`.
There is no stale case — a settlement's amount cannot move the way an adjusted expense's net
can — and no zero case to withdraw. Direction comes from `domain.settlementParties` reading the
linked `Payment`, never re-derived at the boundary.

Recording a _second_ settlement to fix a wrong one would discharge the debt twice. That is
invariant #9 at the sync boundary, and the reason this is an update rather than another
`recordPayment`.

### `stale`/`drifted → synced` becomes a legal, asserted transition

`lifecycle.ts` modelled clearing staleness as a required trip through `pending`. Nothing ever
observed a row in that state, and the repair wrote `synced` directly without asserting anything.
The transition table now allows `stale`/`drifted → synced` and the service asserts it.

This does not relax invariant #18. What #18 forbids is _auto_-resolution — a status that clears
itself because a later run agreed, or because Splitwise's number was copied over ours. Neither
is reachable. The repair requires a person, one row at a time, with a written reason recorded on
an audit event, and it pushes only what this ledger already approved. Making the real move legal
and checked is stricter than forbidding it on paper and performing it unchecked.

## Consequences

- The counterparty sees one entry per expense, corrected in place, with no reconciliation by
  hand. This is the whole point.
- A fully refunded expense leaves Splitwise rather than sitting there asserting a stale debt.
- An adapter without the write half is a first-class, representable thing: audits still run,
  first sync still works, and the repair says what it cannot do.
- Migration `0017_splitwise_withdrawn_status.sql` widens the `splitwise_expenses` sync-status
  `CHECK`. No data moves.
- Still not done, and still deliberate: nothing reads a correction _back_ from Splitwise. A
  change somebody makes on their side remains a `drifted` finding for a person to look at, never
  an input to this ledger (`CLAUDE.md`, principle 9).
