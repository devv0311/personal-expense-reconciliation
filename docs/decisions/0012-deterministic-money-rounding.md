# 0012. Deterministic money rounding — the Largest Remainder Method, one algorithm everywhere

> **Extension (2026-09-05).** [ADR-0018 (item refunds)](0018-item-level-refund-attribution.md)
> applies item refunds before deriving allocation. References below to copying an item's
> amount mean its derived net cost after attribution on that path; sharing an item uses this
> same Largest Remainder Method. Original gross item amounts remain immutable.

**Status:** Accepted

## Context

`invariants.md` #12 had, since the original design, said rounding "is deterministic and
documented at the point it happens," with the exact rule "finalized when allocation arithmetic
is implemented." `database-design.md` and `CLAUDE.md` both echoed this "decide later" framing.
Every downstream document that referenced rounding (allocation lines, group expansion,
adjustment distribution) pointed back at this same not-yet-decided rule. Before database
migrations or a deterministic domain layer can be written, this needs one concrete, specified
algorithm — an implementer left to invent their own risks a different rounding rule per call
site, which breaks the "identical inputs produce identical outputs" non-functional requirement
(`product/requirements.md`) the moment two people compare an allocation computed at different
times or by different code paths.

Three related, previously-unspecified questions needed resolving alongside it: how a full
refund's now-zero allocation should be shaped (see ADR-0013), whether an `AllocationLine` may
ever be zero, and whether `ExpenseAdjustment` needed a signed/negative form.

## Decision

**All monetary values are `bigint` minor units (paise for INR)** — already true for `amount`
columns per the original schema design; this ADR makes it explicit that no float or
`numeric`/`decimal` type is ever used for a monetary value in `src/domain`, at rest, or in
transit, and that no division is ever performed with floating-point arithmetic.

**The Largest Remainder Method** is the one algorithm used everywhere a total integer amount `A`
must be divided across `N` lines by integer weights: compute each line's floor share, then hand
out the leftover minor units one at a time to the lines with the largest fractional remainder,
ties broken by sorting `beneficiary_id`/`person_id` ascending as plain UUID text. Implemented
once as `domain.splitByLargestRemainder(total, weights)`, called from every site that divides a
total: equal-method and percentage-method `AllocationLine`s, `AllocationLineGroupExpansion` rows,
and `ExpenseAdjustment` distribution (proportional-to-existing-share default). Item/quantity-based
`AllocationLine`s are explicitly exempt — their amount is copied from an already-exact
`ExpenseItem.amount`, with no total to divide.

`AllocationLine.amount`/`AllocationLineGroupExpansion.amount` checks are weakened from `> 0` to
`>= 0`: a zero-amount line is now a defined, expected shape (see ADR-0013), not disallowed.
Negative amounts remain disallowed everywhere; a custom (non-proportional) adjustment
distribution that would drive a line negative is rejected outright by the service layer, never
silently clamped.

`ExpenseAdjustment.amount` remains always a positive magnitude — there is no signed/negative
adjustment. A post-approval price increase for the same purchase (a clawed-back refund, an
additional charge) is modeled as a new `Expense`, not a negative adjustment; see "Alternatives
considered."

Full details: `invariants.md` #12/#12a.

## Consequences

`invariants.md`, `domain-model.md`, `testing-strategy.md`, and `database-design.md` all now
point at one concrete algorithm instead of a placeholder. `testing-strategy.md` gained a
14-case exhaustive rounding test matrix. No new tables. Two existing `CHECK` constraints
weakened (`allocation_lines.amount`, `allocation_line_group_expansions.amount`: `> 0` → `>= 0`).
Currency scope is explicitly pinned to INR/2-decimal-places for V1; the `currency` column already
exists on `payments`/`expenses`/`accounts` so a future multi-currency phase adds a minor-unit
lookup rather than a schema migration, but mixing currencies within one computation is
unsupported and must be rejected, not coerced.

## Alternatives considered

- **Banker's rounding / round-half-to-even per line, independently.** Rejected: independent
  per-line rounding does not guarantee `Σ amount === A` — the classic problem this ADR exists to
  avoid. The Largest Remainder Method is specifically chosen because it guarantees exact
  reconciliation to the total by construction, not as a side effect of a particular rounding
  mode.
- **Remainder assigned to the payer's own line.** Considered — simple, and arguably intuitive
  ("the payer absorbs the odd paisa"). Rejected because it isn't well-defined for group
  expansion (no single "payer" among resolved members) or for a custom-weight adjustment
  distribution, and because "largest remainder first" is the standard, well-understood
  apportionment method (used in real-world seat-apportionment algorithms) rather than an
  invented convention specific to this project.
- **Signed `ExpenseAdjustment.amount` to represent clawbacks/additional charges.** Considered, to
  answer "how do negative adjustments work" directly. Rejected: it would require every
  downstream consumer (`netAmount`, the rounding algorithm's inputs, `ledger_explained_total`) to
  branch on sign, for a case — a post-approval price increase on an already-`APPROVED` (and
  therefore immutable, invariant #6) expense — that is adequately and more simply represented as
  ordinary new spend via a new `Expense`.
