# Testing Strategy

Financial calculations require deterministic automated tests — this is not optional polish,
per `CLAUDE.md`. This document defines what must be tested, at what layer, and with what data,
before any financial arithmetic ships.

## Layers and what each covers

| Layer                            | Tool                                                              | Covers                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain` unit tests          | Vitest                                                            | Pure arithmetic: allocation sum-checks, rounding, balance computation, unexplained-money computation, state-transition validity. No I/O, no mocks needed — these are pure functions over plain data.                                                        |
| `src/services` integration tests | Vitest + real Postgres (Testcontainers or a CI service container) | Orchestration: does approving an allocation actually write `AllocationLine`s, an `AuditEvent`, and move `Expense.state` correctly, inside one transaction, with the invariants from `docs/domain/invariants.md` enforced.                                   |
| `src/ai` contract tests          | Vitest, AI calls mocked/stubbed                                   | Schema validation of proposed output (malformed/out-of-range responses are rejected before becoming an `AIInference`); confidence handling; never asserts specific AI outputs are "correct" since that's non-deterministic — see "What is not tested here." |
| `src/integrations` adapter tests | Vitest against a Splitwise sandbox/mock                           | Sync only fires from `APPROVED` + `ALLOCATED` expenses (invariant #19); drift detection produces a `drifted` status rather than auto-resolving.                                                                                                             |
| `src/api` route tests            | Vitest + request simulation                                       | Input validation, auth checks (once implemented), correct service calls — thin by design, so thin tests.                                                                                                                                                    |
| End-to-end scenario tests        | Vitest, driven by `fixtures/`                                     | The 25 scenarios in `docs/domain/scenario-analysis.md`, each as a runnable test once the corresponding phase is implemented — import → classify → allocate → (sync) → reconcile, asserting final ledger state.                                              |

## Required coverage for financial code specifically

Everything under `src/domain` that touches money (allocation, settlement, rounding, refunds,
deduplication decisions, reconciliation arithmetic) requires:

- A test for the exact-division case and at least one case that doesn't divide evenly (proves
  the documented rounding rule, `invariants.md` #12, is actually applied).
- A test proving the relevant sum invariant holds (`invariants.md` #11, #13, #14).
- A test for each scenario in `docs/domain/scenario-analysis.md` that exercises that function
  (e.g. allocation code is tested against scenarios #2, #3, #6, #7, #12, not just a synthetic
  happy path).
- A test for the corresponding invalid-input case (allocation lines that don't sum, negative
  amounts, an expense reaching `APPROVED` with no allocation) — these must fail loudly, not
  silently coerce.

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
charge) is not something CI can assert deterministically — models and prompts change. What CI
_does_ assert:

- The AI boundary contract: every `ai/*` function returns the `Inference<T>` shape with a
  `confidence`, and the schema-validation gate rejects malformed output regardless of what a
  real model returns (tested by feeding stubbed responses, including deliberately malformed
  ones, into the validation layer).
- The invariant that no `ai/*` output reaches an APPROVED field without passing through
  `services.decideInference()` — testable structurally (no direct call path exists) rather
  than behaviorally.

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
