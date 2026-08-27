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

| Module               | Owns                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `money.ts`           | The `Paise` branded `bigint`, exact major-unit parsing/formatting, INR-only currency scope              |
| `rounding.ts`        | `splitByLargestRemainder` — the single implementation of `invariants.md` #12                            |
| `enums.ts`, `ids.ts` | Every closed value set (shared with `src/db`'s check constraints) and branded ids                       |
| `entities.ts`        | Entity shapes from `domain-model.md`                                                                    |
| `allocation.ts`      | All six allocation methods; sum checks #11, #13, #14                                                    |
| `group-expansion.ts` | Membership resolution as of the expense date; group-line expansion (ADR-0009)                           |
| `expense.ts`         | `netAmount`, adjustment-total validation, `validateExpenseItemsSum` (`ExpenseItem` invariant)           |
| `adjustment.ts`      | Adjustment distribution, including the full-refund zero-line shape (ADR-0013)                           |
| `balance.ts`         | Pairwise obligations and `NetBalance` in both directions; `obligationEvidenceStatus`                    |
| `payment.ts`         | Payment-explanation budget, non-spend guard #7, duplicate detection #10                                 |
| `normalization.ts`   | `refineChannel` (ADR-0020) and `merchantAliasKey` — the deterministic normalization rules               |
| `lifecycle.ts`       | Explicit transition tables for every lifecycle in `lifecycle.md`                                        |
| `immutability.ts`    | SOURCE and approved-amount write guards (#4, #6)                                                        |
| `classification.ts`  | Eligibility, review routing by confidence and materiality, the decision actor (#17)                     |
| `evidence.ts`        | `note_kind` semantics (ADR-0018), accepted document formats, write-once linkage (ADR-0034)              |
| `receipt.ts`         | Extraction eligibility, the two surfaced discrepancies, candidate payment matching (ADR-0036, ADR-0037) |
| `review.ts`          | The queue's total order and the reasons an item is in it (ADR-0029, ADR-0035)                           |
| `reconciliation.ts`  | `computeUnexplained` (#20) — see ADR-0016 for its outflow scoping                                       |

Import from `src/domain/index.js`, the layer's public surface, rather than an individual file.
