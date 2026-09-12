# 0056. A change made in Splitwise arrives as a proposal, never as an input

**Status:** Accepted

## Context

[ADR-0055](0055-a-correction-edits-the-entry-they-are-looking-at.md) finished the write half of
Splitwise repair and closed by naming what it had not done:

> Still not done, and still deliberate: nothing reads a correction _back_ from Splitwise. A
> change somebody makes on their side remains a `drifted` finding for a person to look at, never
> an input to this ledger (`CLAUDE.md`, principle 9).

The roadmap was blunter still — _"it is not obviously worth having"_ — and that scepticism was
right about the thing it was aimed at. **Copying Splitwise's number into this ledger is not
bidirectional sync; it is surrendering the ledger.** Principle 9 says this system's own ledger
is canonical and Splitwise's numbers are reconciled against, never trusted blindly. An import
that overwrote an approved `Expense.amount` because a flatmate retyped it on their phone would
violate invariant #6 (an approved amount never changes by any mechanism), and it would do so
silently, over the one external system this product writes to.

But "we will never read their side" is not the same statement, and it is the wrong one. Four
things happen in Splitwise that this ledger currently cannot see at all:

- Somebody edits an entry this ledger synced. Phase 19's audit notices the _balance_ moved and
  raises a `drifted` finding; nothing records what it moved **to**, so the repair pushes our
  figure back without anyone having read theirs.
- Somebody deletes an entry this ledger synced. The local row still says `synced`, the repair
  still plans a `corrected` push, and `updateExpense` against a deleted id fails at the
  boundary — a confusing failure for what is a perfectly ordinary thing for a person to do.
- Somebody adds an entry in Splitwise for a real shared cost. This ledger has no link for it,
  the audit reports `unsupported_ghost_debt`, and there is no way to say "yes, that is the
  dinner I already recorded here" even when it plainly is.
- An entry names a Splitwise user this ledger has never mapped to a `Person`. Every comparison
  involving that person is then unreadable, and nothing says so in terms a person can act on.

None of the four needs Splitwise's arithmetic to become ours. All four need their change to be
**visible, attributable and decidable** here.

## Decision

### Discovery reads; a person decides; the ledger's figures do not move

A discovery run calls `fetchLedgerEntries` per mapped friend, compares what comes back against
the local sync rows, and writes `SplitwiseRemoteChange` rows. It writes nothing else. In
particular it never touches an `Expense`, an `Allocation`, a `Settlement`, an
`ExpenseAdjustment`, a `Payment` or a `Balance`, and there is no code path by which it could:
the service imports no writer for any of them.

Each change carries both sides as recorded snapshots — `remote_snapshot` verbatim as Splitwise
reported it, `local_snapshot` as this ledger held it at comparison time — plus its provenance
(the run, the integration, the external entry id, the pair) and the completeness of the read it
came from. A screen renders those; it derives none of them.

### Accepting has a declared effect, computed server-side, and it is never a figure

Every change carries an `acceptEffect` naming exactly what accepting will do. It is computed by
the service from the change's kind, quoted by the screen, and enforced again when the decision
arrives — the same shape ADR-0055 chose for `plannedRepair`, and for the same reason: a surface
must state the consequence before a person confirms it, and working that consequence out in the
browser would put a second copy of the rule somewhere it could drift from the one the service
follows (ADR-0048).

There are five effects, and **none of them writes money**:

| Kind                               | `acceptEffect`             | What accepting writes                                                                                    | What it never does                                    |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `remote_expense_amount_changed`    | `record_drift`             | the link's `their_snapshot`, and `sync_status → drifted`                                                 | change `Expense.amount`, the allocation, or a balance |
| `remote_settlement_amount_changed` | `record_drift`             | the link's `their_snapshot`, and `sync_status → drifted`                                                 | change `Settlement.amount`                            |
| `remote_expense_deleted`           | `record_external_deletion` | `sync_status → externally_deleted`, keeping the external id                                              | delete the local expense                              |
| `remote_settlement_deleted`        | `record_external_deletion` | `sync_status → externally_deleted`, keeping the external id                                              | delete the local settlement                           |
| `remote_expense_unlinked`          | `adopt_expense_link`       | a `splitwise_expenses` row joining a **caller-named, already-approved** local expense to the external id | create an `Expense`                                   |
| `remote_settlement_unlinked`       | `adopt_settlement_link`    | a `splitwise_settlements` row joining a caller-named local `Settlement` to the external id               | create a `Settlement`                                 |
| `remote_person_unmapped`           | `map_person`               | `people.splitwise_user_id` on a caller-named `Person`                                                    | create a `Person`                                     |
| `remote_duplicate_candidate`       | `none`                     | nothing; accept is refused by name                                                                       | guess which of two external entries is the one        |

Read down the right-hand column: **acceptance changes what this ledger knows about Splitwise,
and never what it says about money.** That is the whole line this ADR draws, and it is what
makes reading their side safe. Bringing a remote figure into the ledger as an actual correction
stays what it has always been — a person recording an `ExpenseAdjustment`, authoring an expense,
or running the repair in the other direction — each with its own evidence and its own audit
event.

An adoption takes an argument, because the local record it links to is a judgement no
comparison can make: two dinners on the same evening for the same amount are not
interchangeable. The service validates the named record exists, is in a state that may be
synced, and is not already linked to a different external entry — and refuses otherwise, rather
than repointing an existing link.

### `externally_deleted` is a status of its own

`SPLITWISE_EXPENSE_SYNC_STATUSES` and `SPLITWISE_SETTLEMENT_SYNC_STATUSES` both gain
`externally_deleted`: the entry this ledger synced is gone from Splitwise, by somebody else's
hand.

Folding it into ADR-0055's `withdrawn` would have been the obvious shortcut and would have been
wrong. `withdrawn` means _this ledger removed the entry because its net reached zero_ — a
correct, finished state. `externally_deleted` means _this ledger still asserts a figure and
nothing in Splitwise is carrying it_ — a disagreement, and one whose repair is a **create**
rather than an update. Keeping them apart is what lets `listResyncCandidates` plan `recreated`
for one and nothing at all for the other, which is the same argument ADR-0055 made for not
folding `withdrawn` into `stale`.

The transition table gains `synced|drifted|stale → externally_deleted` and
`externally_deleted → synced`, and the service asserts them like every other move.

### Absence proves nothing unless the read was complete

A change that asserts something is **missing** — `remote_expense_deleted`,
`remote_settlement_deleted` — is produced only from a `complete` listing for that pair. Under a
`partial`, `failed` or `unsupported` read the run records the incompleteness and produces no
deletion change at all, because an entry absent from a page is an entry nobody looked for.

Positive observations survive an incomplete read: an entry that **is** present with a different
figure was seen, and seeing it is not conditional on having seen everything else. Each change
carries the `readStatus` it was observed under, so a partial run's output can never be read as
a full reconciliation.

This is ADR-0046's rule — _an incomplete check is not agreement_ — applied to the opposite
direction of travel, and its failure mode is the same: a run that quietly turned "we could not
list the pair" into "they deleted four entries" would propose four external deletions that never
happened.

### A change is identified by its cause, and a decided change stays decided

`fingerprint` is the change's identity — integration, kind, and the subject it is about — and
is unique among rows that have not been superseded. `comparison_digest` is its materiality, a
hash over both snapshots. A rerun that computes the same digest touches `last_observed_*` and
nothing else; a different digest supersedes the row and inserts a new one, preserving the
original snapshots exactly as they were observed.

Once a person has accepted or rejected a change, **an unchanged rerun does not reopen it**. The
same remote state re-observed is the same decision, already made. A _materially different_
remote state supersedes the decided row with a fresh `proposed` one, because the thing they
decided about is not the thing standing now — and the decided row stays on file, with its actor,
its timestamp and its reason, as the record of what was true then.

Accepting is idempotent for the same reason: a second accept of an already-decided change is
refused as `PRECONDITION_FAILED` rather than applying its effect twice.

### Nothing here is an inference

Every change kind is a deterministic comparison of two recorded figures. There is no model on
this path, no confidence level, and no proposal in `ai-boundary.md`'s sense — the word
"proposal" here means _a thing awaiting a person's decision_, which is what a `pending`
`AIInference` also is, not that a model produced it. A person is required for every acceptance,
one change at a time, with a written reason recorded on an audit event, exactly as ADR-0055's
repair requires one.

### Retrying is re-running

There is no retry queue. A discovery run that failed to read a pair records that pair as
unchecked and says why; running discovery again re-reads it. Because identity is a fingerprint
rather than a row position, a re-run after a transient failure converges on the same set of
changes rather than duplicating the ones that succeeded the first time. A run is also safe to
schedule as a background job (`JOB_KINDS`), which changes who starts it and nothing about what
it may do.

## Consequences

- An edit made on somebody's phone becomes a thing this ledger can show, explain and decide
  about, with both figures side by side — rather than an unattributable balance gap.
- A deleted entry stops producing a confusing boundary failure from the repair: the row is
  marked `externally_deleted` and the repair plans a `recreated` push, which is what the
  situation actually calls for.
- An expense somebody entered in Splitwise can be adopted against the local expense it
  corresponds to, which is the honest half of "bidirectional": the ids join up, and no money
  moved.
- **Still not done, and still deliberate:** no external figure becomes a local figure. If
  Splitwise says ₹500 and this ledger says ₹450, accepting the change records that they say
  ₹500. Making ₹500 true here is a person recording an adjustment, with evidence, under
  invariant #6.
- Migration `0018_splitwise_remote_changes.sql` adds two tables and widens two `CHECK`s. No data
  moves.
