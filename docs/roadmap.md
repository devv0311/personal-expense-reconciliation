# Roadmap

Incremental vertical slices, per `CLAUDE.md`. Each phase should leave the system in a working,
tested state — no phase depends on a _later_ phase being done first. Do not start a phase
before the ones before it are solid; see `CLAUDE.md`, "Development workflow."

## Phase status

| #   | Phase                      | Status                                                                                                                                                                              |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository foundation      | **Done** — this document, plus everything under `docs/`, tooling in the repo root, and the `src/` module skeleton.                                                                  |
| 2   | Domain model               | **Done** — `docs/domain/`. Will evolve as implementation surfaces gaps, via ADRs.                                                                                                   |
| 3   | Architecture               | **Done** — `docs/architecture/`.                                                                                                                                                    |
| 4   | Database model             | **Designed, not migrated** — `docs/architecture/database-design.md`. Migrations are written at the start of Phase 5.                                                                |
| 5   | Synthetic fixtures         | **Done** — `fixtures/`. Will grow as later phases need more example data.                                                                                                           |
| 6   | Transaction import         | Not started. First real implementation phase: `ImportBatch` + `Payment` write path for at least one source format (start with a UPI/bank CSV).                                      |
| 7   | Transaction normalization  | Not started. Deterministic + AI-assisted counterparty/merchant resolution.                                                                                                          |
| 8   | Transaction classification | Not started. `ai.classifyTransaction`, `Expense` creation, confidence-based routing.                                                                                                |
| 9   | Human review               | Not started. Review queue surfacing `REVIEW_REQUIRED` expenses and pending `AIInference`s.                                                                                          |
| 10  | Receipt ingestion          | Not started. `Evidence` upload/storage for receipt-type documents.                                                                                                                  |
| 11  | Receipt item extraction    | Not started. `ai.parseReceipt` / `ai.extractReceiptItems` → `Receipt`/`ReceiptItem`.                                                                                                |
| 12  | Beneficiary allocation     | Not started. `Allocation`/`AllocationLine` write path, all six methods, sum-check enforcement. This is where the rounding rule (`invariants.md` #12) gets finalized and documented. |
| 13  | Expense ledger             | Not started. Querying/reporting over approved expenses; `Balance` computation.                                                                                                      |
| 14  | Splitwise integration      | Not started. `ExternalIntegration` + `SplitwiseExpense`, sandbox-only until deliberately switched to a real account.                                                                |
| 15  | Reconciliation             | Not started. `ReconciliationRun` computation and discrepancy surfacing.                                                                                                             |
| 16  | Rules/learning             | Not started. `Rule` creation (manual first, AI-proposed later) and auto-application.                                                                                                |
| 17  | Analytics                  | Not started.                                                                                                                                                                        |
| 18  | Natural-language interface | Not started.                                                                                                                                                                        |

## What "done" means for the current phase (1–5)

- `docs/` covers product, domain, architecture, decisions, testing, and security, each
  internally consistent and cross-referenced.
- Repository tooling (`package.json`, TypeScript, ESLint, Prettier, Vitest, CI) is installed
  and passing (`npm run typecheck && npm run lint && npm run format:check && npm test`).
- `src/` has the module skeleton (`domain`, `services`, `ai`, `db`, `integrations`, `api`),
  each with a `README.md` stating its responsibility — no business logic yet.
- `fixtures/` has synthetic examples for the transaction sources and expense types named in
  `docs/product/overview.md`.
- No database migrations exist yet (deliberate — schema is reviewed as a design doc first).
- No UI exists beyond what a future framework choice mandates as a placeholder.
- No real bank, card, or Splitwise account is connected anywhere in the repo or its config.

## Recommended next phase

**Phase 6, Transaction import**, starting with a single source format (a synthetic UPI or bank
CSV, matching `fixtures/`) end to end: parse → `ImportBatch` → `Payment` rows → passing tests
against the fixture. This is the smallest slice that touches real persistence and proves the
`db` layer and the SOURCE-data immutability rule work as designed, before classification or AI
involvement adds complexity on top. See the foundation report for the full rationale.
