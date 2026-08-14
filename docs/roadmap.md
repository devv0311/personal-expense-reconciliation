# Roadmap

Incremental vertical slices, per `CLAUDE.md`. Each phase should leave the system in a working,
tested state — no phase depends on a _later_ phase being done first. Do not start a phase
before the ones before it are solid; see `CLAUDE.md`, "Development workflow."

> **Revision note (2026-08).** Phases 2–5 (domain model, architecture, database model, fixtures)
> were revised in place following a pre-implementation architecture review — see
> `docs/domain/domain-model.md`'s revision note and ADRs 0006–0011 in `docs/decisions/`. Phase
> numbering and order are unchanged; phase _descriptions_ for 12, 14, and 15 below are updated to
> reflect the corrected model (`Settlement`, `ExpenseAdjustment`, group-allocation expansion).
> **No implementation phase (6+) has been started as part of this revision** — this pass was
> documentation- and schema-design-only, per explicit instruction.
>
> **Further revision note (2026-08, implementation-readiness pass).** The four open questions
> this document previously carried forward — money/rounding, the full-refund allocation shape,
> non-user obligation observability, and inflow-reconciliation scope — are all now resolved
> (ADRs 0012–0015). The "Open questions carried forward" section below is retained with each
> item marked resolved, rather than deleted, so the reasoning stays visible. **This pass also did
> not start Phase 6 or any later phase.**

## Phase status

| #                                                                                                                       | Phase                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                                                                                                                       | Repository foundation      | **Done** — this document, plus everything under `docs/`, tooling in the repo root, and the `src/` module skeleton.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2                                                                                                                       | Domain model               | **Done, revised 2026-08** — `docs/domain/`. See revision note above. Will continue to evolve as implementation surfaces gaps, via ADRs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3                                                                                                                       | Architecture               | **Done, revised 2026-08** — `docs/architecture/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4                                                                                                                       | Database model             | **Designed, not migrated, revised 2026-08** — `docs/architecture/database-design.md`. Migrations are written at the start of Phase 5's successor, Phase 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5                                                                                                                       | Synthetic fixtures         | **Done, revised 2026-08** — `fixtures/`. New fixtures added for the reverse-payer, settlement, adjustment, group-expansion, and dedup scenarios (`scenario-analysis.md` §26–§35).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6                                                                                                                       | Transaction import         | Not started. First real implementation phase: `ImportBatch` + `Payment` write path for at least one source format (start with a UPI/bank CSV), now including                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `external_reference`/`reference_type`/`source_system` extraction (ADR-0010) from day one rather than as a later add-on. |
| 7                                                                                                                       | Transaction normalization  | Not started. Deterministic + AI-assisted counterparty/merchant resolution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8                                                                                                                       | Transaction classification | Not started. `ai.classifyTransaction` (now proposing `proposedKind: expense \| settlement`, ADR-0007), `Expense`/`Settlement` creation, confidence-based routing.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 9                                                                                                                       | Human review               | Not started. Review queue surfacing `REVIEW_REQUIRED` expenses and pending `AIInference`s, including the settlement-vs-expense disambiguation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10                                                                                                                      | Receipt ingestion          | Not started. `Evidence` upload/storage for receipt-type documents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 11                                                                                                                      | Receipt item extraction    | Not started. `ai.parseReceipt` / `ai.extractReceiptItems` → `Receipt`/`ReceiptItem`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 12                                                                                                                      | Beneficiary allocation     | Not started. `Allocation`/`AllocationLine` write path, all six methods, sum-check enforcement against `domain.netAmount` (not gross amount). **Now also includes:** `AllocationLineGroupExpansion` resolution for group-typed lines (ADR-0009), `ExpenseAdjustment` recording and distribution (ADR-0008), and `Settlement` recording (ADR-0007) — these were previously scattered across phases 12–15 under the pre-revision model and are consolidated here since they share the allocation/obligation machinery. This is also where the rounding rule (`invariants.md` #12) gets finalized and documented. |
| 13                                                                                                                      | Expense ledger             | Not started. Querying/reporting over approved expenses; pairwise `Balance` computation (ADR-0006).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14                                                                                                                      | Splitwise integration      | Not started. `ExternalIntegration` + `SplitwiseExpense` + `SplitwiseSettlement` (ADR-0007), sandbox-only until deliberately switched to a real account. Group-line expansion (ADR-0009) is enforced here as the only path into the sync payload builder.                                                                                                                                                                                                                                                                                                                                                      |
| 15                                                                                                                      | Reconciliation             | Not started. `ReconciliationRun` computation (now with `ledger_investments_total` and `ledger_settlements_total` buckets, ADR-0011/0007) and discrepancy surfacing, including `stale` vs. `drifted` sync-status handling (ADR-0008).                                                                                                                                                                                                                                                                                                                                                                          |
| 16                                                                                                                      | Rules/learning             | Not started. `Rule` creation (manual first, AI-proposed later) and auto-application.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 17                                                                                                                      | Analytics                  | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 18                                                                                                                      | Natural-language interface | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## What "done" means for the current phase (1–5)

- `docs/` covers product, domain, architecture, decisions, testing, and security, each
  internally consistent and cross-referenced — re-verified in the 2026-08 revision's
  consistency audit.
- Repository tooling (`package.json`, TypeScript, ESLint, Prettier, Vitest, CI) is installed
  and passing (`npm run typecheck && npm run lint && npm run format:check && npm test`).
- `src/` has the module skeleton (`domain`, `services`, `ai`, `db`, `integrations`, `api`),
  each with a `README.md` stating its responsibility — no business logic yet.
- `fixtures/` has synthetic examples for the transaction sources and expense types named in
  `docs/product/overview.md`, including the reverse-payer, settlement, adjustment, and
  group-expansion cases added in the 2026-08 revision.
- No database migrations exist yet (deliberate — schema is reviewed as a design doc first).
- No UI exists beyond what a future framework choice mandates as a placeholder.
- No real bank, card, or Splitwise account is connected anywhere in the repo or its config.

> **Implementation note (2026-08-14, deterministic foundation).** A foundation pass has now
> landed `src/domain`, `src/db` (schema + migrations), and the deterministic half of
> `src/services`. It deliberately cuts **across** the phase numbering above rather than
> following it: phase 4's migrations are written, and the allocation/adjustment/settlement/
> balance/reconciliation machinery described under phases 12, 13 and 15 exists as pure domain
> logic plus its service orchestration — while phases 6–11 (import, normalization,
> classification, human review, receipts) remain **not started**. That ordering was explicitly
> instructed, on the reasoning that a trustworthy financial core should exist before anything
> feeds data into it; it is recorded here because it departs from `CLAUDE.md`'s "do not jump
> ahead of the current phase" rule and should not be taken as precedent. No AI, Splitwise, bank
> ingestion or UI code was written. See ADRs 0016–0018 for what the pass surfaced.

## Recommended next phase

**Phase 6, Transaction import**, starting with a single source format (a synthetic UPI or bank
CSV, matching `fixtures/`) end to end: parse → `ImportBatch` → `Payment` rows (including the new
`external_reference`/`reference_type`/`source_system` fields) → passing tests against the
fixture. This is the smallest slice that touches real persistence and proves the `db` layer and
the SOURCE-data immutability rule work as designed, before classification or AI involvement adds
complexity on top. See the foundation report for the full rationale. **This revision did not
start Phase 6 or any later phase** — the domain/schema/documentation layer is now internally
consistent and is the correct point to resume from.

## Open questions carried forward from the 2026-08 revision

Documented explicitly so they aren't rediscovered as bugs later — none block starting Phase 6:

- **Inflow-side reconciliation is an explicit V1 scope boundary, not an unmodeled gap**
  (finalized this revision — `domain-model.md`'s `ReconciliationRun` "V1 scope, explicit"). V1
  reconciles outflow, expenses, obligations, settlements, refunds/reimbursements, transfers, and
  investments; it deliberately does not build a general income/inflow accounting system (salary
  deposits, ad hoc payments received, interest, etc.). The schema does not block adding this
  later: `payments.direction = credit` is already fully supported, and refund/reimbursement/
  received-settlement credits are already fully modeled — only _plain, otherwise-unclassified_
  income is out of scope. A future inflow phase would add: an income-side classification
  (analogous to `Expense.relationship_type`, but for credits that aren't already
  `ExpenseAdjustment`- or `Settlement`-linked), a symmetric `ledger_unexplained_inflow` total on
  `ReconciliationRun`, and a lifecycle/state answer for those payments beyond "stays at
  `NORMALIZED` indefinitely" (`lifecycle.md`) — none of which requires restructuring `Payment`,
  `Account`, or any table that exists today.
- **A settlement between two people, neither of whom is the user**, can never be backed by a
  `Payment` this system observes (`scenario-analysis.md` §34) — a permanent, deliberate
  observability boundary, not a bug (`invariants.md` #9b). The `Balance` formula still
  represents the obligation correctly; only its _discharge_ is unobservable without Splitwise or
  manual evidence. **The "confirmed vs. believed-settled" distinction is now fully designed**
  (`domain-model.md`'s `ObligationEvidenceStatus`, computed read-only from existing `Evidence`
  and `ReconciliationRun` data — no schema change needed) — what remains for Phase 13 is wiring
  it into the actual balance-display UI, not designing it from scratch.
- ~~**Net-zero expense allocation shape**~~ — **resolved in the 2026-08 implementation-
  readiness pass**, not left open: the superseding `Allocation` keeps one line per original
  beneficiary, each at `amount = 0` (the deterministic output of the Largest Remainder Method
  applied with a total of 0), never an empty line set. See `invariants.md` #12a and
  `domain-model.md`'s "Full refunds, resolved" (`scenario-analysis.md` §11, §31).
