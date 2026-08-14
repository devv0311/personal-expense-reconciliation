# Testing Strategy

Financial calculations require deterministic automated tests — this is not optional polish,
per `CLAUDE.md`. This document defines what must be tested, at what layer, and with what data,
before any financial arithmetic ships.

> **Revision note (2026-08).** Coverage requirements below were extended for `Settlement`,
> `ExpenseAdjustment`, `AllocationLineGroupExpansion`, and the tightened per-item allocation
> invariant, following a pre-implementation architecture review (ADRs 0006–0011). See
> `docs/domain/domain-model.md`'s revision note.
>
> **Further revision note (2026-08, implementation-readiness pass).** The rounding rule is now
> finalized (`invariants.md` #12/#12a, `domain.splitByLargestRemainder`) — the "exhaustive
> rounding test matrix" below replaces the previous single-bullet placeholder with the specific
> required cases.

## Layers and what each covers

| Layer                            | Tool                                                              | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain` unit tests          | Vitest                                                            | Pure arithmetic: allocation sum-checks (against `netAmount`, not gross `amount`), rounding, pairwise balance computation, group-allocation expansion resolution, unexplained-money computation (with transfers/investments/settlements/net-explained all separated), state-transition validity. No I/O, no mocks needed — these are pure functions over plain data.                                                                                                                                         |
| `src/services` integration tests | Vitest + real Postgres (Testcontainers or a CI service container) | Orchestration: does approving an allocation actually write `AllocationLine`s (and, for group lines, `AllocationLineGroupExpansion`s), an `AuditEvent`, and move `Expense.state` correctly, inside one transaction; does recording a `Settlement` correctly avoid ever creating an `Allocation`; does distributing an `ExpenseAdjustment` correctly supersede the `Allocation` and flip an already-synced `SplitwiseExpense` to `stale` — all with the invariants from `docs/domain/invariants.md` enforced. |
| `src/ai` contract tests          | Vitest, AI calls mocked/stubbed                                   | Schema validation of proposed output, including the `proposedKind: 'expense' \| 'settlement'` discriminator (malformed/out-of-range responses, or an invalid `proposedKind`, are rejected before becoming an `AIInference`); confidence handling; never asserts specific AI outputs are "correct" since that's non-deterministic — see "What is not tested here."                                                                                                                                           |
| `src/integrations` adapter tests | Vitest against a Splitwise sandbox/mock                           | Sync only fires from `APPROVED` + `ALLOCATED` expenses or `APPROVED` settlements (invariant #19); a `group`-typed `AllocationLine` is never sent raw — only its `AllocationLineGroupExpansion` rows; drift detection produces `drifted`, and our-side changes produce `stale`, rather than either being auto-resolved.                                                                                                                                                                                      |
| `src/api` route tests            | Vitest + request simulation                                       | Input validation, auth checks (once implemented), correct service calls — thin by design, so thin tests.                                                                                                                                                                                                                                                                                                                                                                                                    |
| End-to-end scenario tests        | Vitest, driven by `fixtures/`                                     | The scenarios in `docs/domain/scenario-analysis.md` (1–25 original, 26–35 added in the 2026-08 revision), each as a runnable test once the corresponding phase is implemented — import → classify → allocate → (settle / sync) → reconcile, asserting final ledger state.                                                                                                                                                                                                                                   |

## Required coverage for financial code specifically

Everything under `src/domain` that touches money (allocation, balance/settlement, rounding,
refunds/reimbursements, group expansion, deduplication decisions, reconciliation arithmetic)
requires:

- A test for the exact-division case and at least one case that doesn't divide evenly (proves
  the documented rounding rule, `invariants.md` #12, is actually applied) — including for
  `AllocationLineGroupExpansion` splits and `ExpenseAdjustment` distribution, both of which reuse
  the same rounding rule.

### Exhaustive rounding test matrix (`domain.splitByLargestRemainder`, `invariants.md` #12/#12a)

Finalized this revision — these are the specific cases required, not left to whatever the
implementer thinks to cover. Every case asserts `Σ result === total` exactly (bigint, no
floating point involved anywhere in the assertion either) and that re-running the same inputs
produces byte-identical output (determinism):

1. **Equal split, exact division.** ₹900 ÷ 3 → 300/300/300. No remainder path exercised; proves
   the trivial case doesn't accidentally take the remainder branch.
2. **Equal split, remainder of 1.** ₹1,000 ÷ 3 → 334/333/333 (paise: 100000 ÷ 3). Asserts the
   extra paisa lands on the line whose `beneficiary_id` sorts first lexicographically among the
   three, per the tie-break rule — not on the payer specifically, not on the first-created line.
3. **Equal split, remainder equal to N−1.** ₹0.05 short of an even 7-way split (a total not
   divisible by 7 at all, e.g. ₹100 ÷ 7 = 1428.57... paise) → verifies 6 of 7 lines get the extra
   paisa and exactly one does not, and that the one without it is the correct tie-break loser
   (last lexicographically), not an arbitrary one.
4. **Percentage split with rounding.** ₹1,000 split 33%/33%/34% by stated percentage → verifies
   `AllocationLine.amount` is computed once from the integer percentage numerators (not
   re-derived from `percentage` later) and sums to exactly 100000 paise, with `percentage`
   remaining informational per invariant #13.
5. **Percentage split where stated percentages don't sum to 100.** An invalid-input case — must
   be rejected before `splitByLargestRemainder` is ever called, not silently normalized.
6. **Item-based allocation, no rounding invoked.** Two `ExpenseItem`s (₹80, ₹1,160) mapped 1:1 to
   two `AllocationLine`s — asserts the algorithm is **not** called at all for this method (e.g.
   via a spy/mock in the unit test) and that `amount` is copied verbatim from `ExpenseItem`.
7. **Group expansion, exact division.** 3 resolved members, ₹2,100 total → 700 each (matches
   `fixtures/group-allocation-expansion.json`'s July case).
8. **Group expansion, remainder present.** 3 resolved members, ₹1,000 total → 334/333/333,
   tie-broken by `person_id`, same rule as case 2 but on
   `AllocationLineGroupExpansion.amount`.
9. **Adjustment distribution, proportional default, exact division.** 3 equal ₹300 lines
   (₹900 total), ₹150 partial refund distributed proportionally → verifies each line's
   reduction and that the three new line amounts still sum to the new ₹750 net amount (matches
   `fixtures/refund-partial.json`).
10. **Adjustment distribution, proportional default, with remainder.** Unequal original lines
    (e.g. ₹500/₹300/₹200 summing to ₹1,000) receiving a ₹333 partial refund distributed
    proportionally to original share — proves the weighted (not equal) form of the algorithm
    correctly ranks by each line's _fractional_ remainder under unequal weights, not simply by
    the size of the line.
11. **Full refund — net-zero, single beneficiary.** ₹450 fully refunded, one original
    beneficiary → current allocation has exactly one line, `amount = 0` (matches
    `fixtures/refund-full.json`). Explicitly asserts the result is **not** an empty array.
12. **Full refund — net-zero, multiple beneficiaries.** A 3-way-split ₹2,400 group dinner fully
    refunded → current allocation has exactly three lines, each `amount = 0`, same three
    beneficiaries as the original allocation. Explicitly asserts all three original
    `beneficiary_id`s are still present.
13. **Negative-line rejection.** A custom (non-proportional) adjustment-distribution decision
    that would drive one line below zero (e.g. a ₹150 refund assigned entirely to a beneficiary
    whose original share was only ₹100) — asserts the service layer rejects this with a
    validation error before any `Allocation` is written, and that no partial/clamped write
    occurs.
14. **Determinism / idempotency.** Any one of cases 2, 8, or 10 run twice with identical inputs
    → byte-identical output both times (guards against accidental reliance on object-key
    iteration order, `Set`/`Map` insertion order, or any other non-specified ordering).

- A test proving the relevant sum invariant holds (`invariants.md` #11, #13, #14 — #14's test
  must check the sum **per `ExpenseItem`**, not only in aggregate across the expense, per the
  2026-08 tightening).
- A test for each scenario in `docs/domain/scenario-analysis.md` that exercises that function
  (e.g. allocation code is tested against scenarios #2, #3, #6, #7, #12, §26, §27, not just a
  synthetic happy path; balance/obligation code is tested against §26–§29 and §34 specifically,
  since those are the scenarios that exercise the reverse-payer and non-user-pair directions).
- A test for the corresponding invalid-input case (allocation lines that don't sum to
  `netAmount`, negative amounts, an expense reaching `APPROVED` with no allocation, a
  `Settlement` that somehow gets an `allocation_id` — invariant #9a — a `group`-typed line with
  no `AllocationLineGroupExpansion`) — these must fail loudly, not silently coerce.
- A specific test that a `gift` expense never reaches `READY_TO_SYNC` even though it has a
  non-payer beneficiary line (the exact case the original, uncorrected lifecycle gate would have
  gotten wrong — `lifecycle.md`'s revision note, §8).
- A specific test that `Expense.amount` is rejected (at the type or service level) as a mutation
  target once `APPROVED` — the only path to correcting a cost after approval is
  `ExpenseAdjustment`.

No financial calculation merges without these. This is enforced by CI running `npm test` on
every PR (`.github/workflows/ci.yml`); reviewers additionally check the above list isn't
gamed by tests that assert on trivial happy paths only.

## Fixtures, not real data

All tests use synthetic data from `fixtures/` (see `fixtures/README.md`). No real bank
statements, receipts, UPI IDs, or account numbers are ever used in a test, even ephemeral
in-memory ones — this keeps the boundary between "safe to run anywhere, including CI" and
"contains real financial data" absolute, not judgment-call-based.

## What is not (and cannot be) deterministically tested

AI proposal _quality_ (does `classifyTransaction` correctly guess "personal" for a Netflix
charge, or correctly guess `proposedKind: 'settlement'` for a round-number transfer to a known
counterparty) is not something CI can assert deterministically — models and prompts change.
What CI _does_ assert:

- The AI boundary contract: every `ai/*` function returns the `Inference<T>` shape with a
  `confidence`, and the schema-validation gate rejects malformed output regardless of what a
  real model returns (tested by feeding stubbed responses, including deliberately malformed
  ones — an unknown `proposedKind`, a settlement proposal missing `counterpartyPersonHint` — into
  the validation layer).
- The invariant that no `ai/*` output reaches an APPROVED field without passing through
  `services.decideInference()` — testable structurally (no direct call path exists) rather
  than behaviorally. This now also covers the fact that no `ai/*` output can write an
  `AllocationLineGroupExpansion` row at all (ADR-0009) — there is no proposal type for it.

Actual AI proposal quality is evaluated separately, out of CI, once `src/ai` is implemented
(e.g. a periodically-run eval set) — out of scope for the foundation phase.

## Test data conventions

- Amounts in fixtures use realistic INR values matching the scenarios in
  `docs/product/overview.md` and `docs/domain/scenario-analysis.md`, so tests read as
  recognizable stories, not abstract numbers.
- Person/merchant names in fixtures are clearly synthetic (`"Friend A"`, `"Flatmate B"`,
  `"Sample Restaurant"`) — never a real person's name, per `CLAUDE.md`.

## Current status

Only the scaffold-proving test (`tests/scaffold.test.ts`) exists today — no domain logic has
been implemented yet (`docs/roadmap.md`). This document defines the bar the first real
domain-logic PR must clear.
