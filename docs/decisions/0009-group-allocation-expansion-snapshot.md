# 0009. Group-beneficiary allocation lines get a per-member expansion snapshot at approval time

**Status:** Accepted

## Context

`AllocationLine.beneficiary_type` allows `group`, and the original `Balance` section described
itself as computing balances "for each Person/Group." Two problems (review finding #5):

1. Real money settlement happens between individuals. A `Group` ("the Flat") cannot itself send
   or receive a UPI transfer — someone would eventually need to know *which* flatmate owes what.
2. Splitwise's own data model has no concept of a group as a debtor — a Splitwise expense splits
   among individual Splitwise users. Nothing in `data-flow.md`'s sync step described how a
   group-level `AllocationLine` becomes valid Splitwise API input.

A secondary, related requirement from `scenario-analysis.md` #23: historical allocations must not
change meaning when group membership later changes (a flatmate moves out, a new one moves in).

## Decision

A `Group`-beneficiary `AllocationLine` remains the thing the user sees and edits ("Flat: ₹900"),
but at the moment `services.approveAllocation()` commits it, the service resolves the group's
members **as of `Expense.occurred_at`** (via `GroupMembership.joined_at`/`left_at`, exactly the
mechanism `scenario-analysis.md` #23 already established for this purpose) and writes one row per
resolved member to a new table, `allocation_line_group_expansions`:

- `allocation_line_id` — the group line being expanded.
- `person_id` — a resolved member.
- `amount` — that member's individual share.

Default: equal split across resolved members. The user may override individual shares at the same
approval step (still snapshotted, just not necessarily equal) — this is a decision, not a silent
default, matching the project's general stance on rounding/distribution (`invariants.md` #12).
Application-level check: `sum(amount) for one allocation_line_id` equals that line's own `amount`.

This snapshot is **written once and never recomputed**. A later change to `GroupMembership` (a
flatmate moving out) has zero effect on any `allocation_line_group_expansions` row already
written — satisfying the historical-stability requirement by construction, the same way
`GroupMembership` itself already protects `AllocationLine`s from retroactive reinterpretation.

**Obligations and Splitwise sync always read the expansion, never the raw group line.**
`domain.computeBalance()` and `services.proposeSplitwiseSync()` both operate on
`allocation_line_group_expansions` rows for any `AllocationLine` with `beneficiary_type = group` —
a group can never appear as a debtor in either the `Balance` output or a Splitwise API call. See
`data-flow.md`, sync step, and `ai-boundary.md`.

## Consequences

One new, small table. `Group`-beneficiary lines now always require this expansion before an
`Expense` can be considered `ALLOCATED` (i.e., the group case is not actually simpler than
enumerating individual beneficiaries directly — it's a UI/data-entry convenience over the same
underlying individual obligations, not a different kind of obligation). `scenario-analysis.md` #23
is extended with a companion scenario (#35) that walks through the mechanism with concrete
numbers.

## Alternatives considered

- **Resolve group membership live, at Balance-computation or sync time, instead of snapshotting.**
  Rejected directly by the historical-stability requirement: a live resolution would silently
  change a two-month-old expense's obligations the moment a flatmate moves out, which
  `scenario-analysis.md` #23 already identified as unacceptable for the *AllocationLine* itself —
  the same reasoning applies one level down, to its expansion.
- **Disallow `beneficiary_type = group` entirely; require the user to always enumerate
  individual beneficiaries.** Considered — it would remove the need for this table entirely.
  Rejected because it removes real convenience (splitting "the flat's" grocery bill without
  re-picking three names every time) that the product overview explicitly wants, and the
  snapshot mechanism is a small, well-contained addition that preserves the convenience without
  the settlement/sync problems.
