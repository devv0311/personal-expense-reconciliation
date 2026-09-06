# src/domain

Pure domain logic. No I/O, no framework imports, no AI/network calls, no database access.

**Owns:** entity types matching `docs/domain/domain-model.md`; allocation arithmetic (sum
validation, rounding per `docs/domain/invariants.md` #12); balance/settlement computation;
unexplained-money computation; state-transition validity checks for the lifecycles in
`docs/domain/lifecycle.md`.

**Depends on:** nothing else in `src/`.

**Rule:** everything here must be testable with plain function calls and no mocks — see
`docs/testing/testing-strategy.md`. If a function in this directory needs a mock to test, it
belongs in `src/services` instead.

**Implemented.** Modules, each with colocated unit tests:

| Module                    | Owns                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `money.ts`                | The `Paise` branded `bigint`, exact major-unit parsing/formatting, INR-only currency scope                               |
| `rounding.ts`             | `splitByLargestRemainder` — the single implementation of `invariants.md` #12                                             |
| `enums.ts`, `ids.ts`      | Every closed value set (shared with `src/db`'s check constraints) and branded ids                                        |
| `entities.ts`             | Entity shapes from `domain-model.md`                                                                                     |
| `allocation.ts`           | All six allocation methods; sum checks #11, #13, #14                                                                     |
| `group-expansion.ts`      | Membership resolution as of the expense date; group-line expansion (ADR-0009)                                            |
| `expense.ts`              | `netAmount`, adjustment-total validation, `validateExpenseItemsSum` (`ExpenseItem` invariant)                            |
| `adjustment.ts`           | Adjustment distribution, including the full-refund zero-line shape (ADR-0013)                                            |
| `balance.ts`              | Pairwise obligations and `NetBalance` in both directions; `obligationEvidenceStatus`                                     |
| `payment.ts`              | Payment-explanation budget, non-spend guard #7, duplicate detection #10                                                  |
| `normalization.ts`        | `refineChannel` (ADR-0020) and `merchantAliasKey` — the deterministic normalization rules                                |
| `lifecycle.ts`            | Explicit transition tables for every lifecycle in `lifecycle.md`                                                         |
| `immutability.ts`         | SOURCE and approved-amount write guards (#4, #6)                                                                         |
| `classification.ts`       | Eligibility, review routing by confidence and materiality, the decision actor (#17)                                      |
| `evidence.ts`             | `note_kind` semantics (ADR-0018), accepted document formats, write-once linkage (ADR-0034)                               |
| `receipt.ts`              | Extraction eligibility, the two surfaced discrepancies, candidate payment matching (ADR-0036, ADR-0037)                  |
| `review.ts`               | The queue's total order and the reasons an item is in it (ADR-0029, ADR-0035)                                            |
| `reconciliation.ts`       | `computeUnexplained` (#20) — see ADR-0016 for its outflow scoping                                                        |
| `cash-flow.ts`            | Cash-flow direction and approval-evidence gates (ADR-0017 (cash balance), 17.1–17.2)                                     |
| `cash-balance.ts`         | The account cash identity, verification status, transfer pairing/neutrality (17.3–17.7)                                  |
| `refund-attribution.ts`   | Item-refund attribution rules and derived net item costs (ADR-0018 (item refunds), 19.1–19.6)                            |
| `refund-allocation.ts`    | The item-refund allocation engine: net item cost to superseding lines, legacy reduction applied once (ADR-0045)          |
| `evidence-observation.ts` | The structured reading of one evidence record: notification parsing, reference normalization, dedupe identity (ADR-0044) |
| `evidence-matching.ts`    | The six context-re-attachment signals, candidate eligibility, strength and ordering (ADR-0044)                           |
| `evidence-context.ts`     | The re-attached context of a payment: reconstruction beside the narration, disagreements named (ADR-0044)                |
| `splitwise-drift.ts`      | The aggregate pair comparison against Splitwise's own reported balance (ADR-0041)                                        |
| `splitwise-audit.ts`      | Per-record drift attribution, earned by `balanceImpact`; an unread Splitwise is a finding, never agreement (ADR-0046)    |

Import from `src/domain/index.js`, the layer's public surface, rather than an individual file.
