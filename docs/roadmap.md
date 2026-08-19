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

| #   | Phase                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository foundation      | **Done** — this document, plus everything under `docs/`, tooling in the repo root, and the `src/` module skeleton.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | Domain model               | **Done, revised 2026-08** — `docs/domain/`. See revision note above. Will continue to evolve as implementation surfaces gaps, via ADRs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | Architecture               | **Done, revised 2026-08** — `docs/architecture/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4   | Database model             | **Designed, not migrated, revised 2026-08** — `docs/architecture/database-design.md`. Migrations are written at the start of Phase 5's successor, Phase 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | Synthetic fixtures         | **Done, revised 2026-08** — `fixtures/`. New fixtures added for the reverse-payer, settlement, adjustment, group-expansion, and dedup scenarios (`scenario-analysis.md` §26–§35).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | Transaction import         | **Done (2026-08-15)** — one synthetic source format end to end: `fixtures/bank-statement.csv` → `integrations/bank-csv` parser → `services.importBankStatementCsv` → `ImportBatch` + immutable `Payment` rows, with `external_reference`/`reference_type`/`source_system` populated at import as planned. Deterministic dedup at two levels (file content hash; per-row external reference). Classification is deliberately **not** performed — every imported payment stays `counterparty_type = unknown` and `state = imported`. Surfaced two corrections, ADR-0019.                                                                                                                                                                                                                                                                       |
| 7   | Transaction normalization  | **Done (2026-08-19)** — the deterministic leg only. `domain.refineChannel` refines `channel` from `reference_type`, never the description (ADR-0020); `domain.merchantAliasKey` + exact alias match resolves a catalogued merchant; `services.normalizePayments` moves `imported → normalized` in one audited transaction, acting only on `imported` payments so a re-run is a no-op (ADR-0021). The `ai.normalizeMerchant()` leg is deliberately deferred to phase 8 (ADR-0022), so an unresolved counterparty ends `normalized`/`unknown` with no `AIInference` row. 5 of the bank fixture's 8 rows resolve a merchant; the two self-transfer legs and the person-to-person row stay `unknown` because recognising either is classification.                                                                                               |
| 8   | Transaction classification | **Done (2026-08-19)** — the AI service boundary itself, not merely its first user. `src/ai` holds the `Inference<T>` contract, the strict validator, the redaction step and `classifyTransaction` behind an injected `ModelTransport` (ADR-0025, no provider wired). `services.classifyPayments` runs a deterministic self-transfer leg first (ADR-0023), then the model for what it cannot settle, then a semantic gate, a pending `AIInference` and a DERIVED `Expense` routed to `classified` or `review_required` (ADR-0024, ADR-0026). `services.decideInference` is the sole path out of `pending`, producing an approved `Expense` + `PaymentExpenseLink` or a `Settlement`. Credits are deliberately out of scope (ADR-0027). All 8 bank-fixture rows reach a stated outcome; the pipeline ends with `ledger_unexplained_total = 0`. |
| 9   | Human review               | **Next.** Review queue surfacing `REVIEW_REQUIRED` expenses and pending `AIInference`s, including the settlement-vs-expense disambiguation. Phase 8 wrote both, and `services.decideInference` is the function the queue calls — what is missing is the listing/prioritisation query and the surface, plus possible-duplicate surfacing and a policy for a DERIVED expense whose proposal was rejected (ADR-0026).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | Receipt ingestion          | Not started. `Evidence` upload/storage for receipt-type documents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11  | Receipt item extraction    | Not started. `ai.parseReceipt` / `ai.extractReceiptItems` → `Receipt`/`ReceiptItem`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 12  | Beneficiary allocation     | Not started. `Allocation`/`AllocationLine` write path, all six methods, sum-check enforcement against `domain.netAmount` (not gross amount). **Now also includes:** `AllocationLineGroupExpansion` resolution for group-typed lines (ADR-0009), `ExpenseAdjustment` recording and distribution (ADR-0008), and `Settlement` recording (ADR-0007) — these were previously scattered across phases 12–15 under the pre-revision model and are consolidated here since they share the allocation/obligation machinery. This is also where the rounding rule (`invariants.md` #12) gets finalized and documented.                                                                                                                                                                                                                                |
| 13  | Expense ledger             | Not started. Querying/reporting over approved expenses; pairwise `Balance` computation (ADR-0006).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | Splitwise integration      | Not started. `ExternalIntegration` + `SplitwiseExpense` + `SplitwiseSettlement` (ADR-0007), sandbox-only until deliberately switched to a real account. Group-line expansion (ADR-0009) is enforced here as the only path into the sync payload builder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 15  | Reconciliation             | Not started. `ReconciliationRun` computation (now with `ledger_investments_total` and `ledger_settlements_total` buckets, ADR-0011/0007) and discrepancy surfacing, including `stale` vs. `drifted` sync-status handling (ADR-0008).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 16  | Rules/learning             | Not started. `Rule` creation (manual first, AI-proposed later) and auto-application.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | Analytics                  | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 18  | Natural-language interface | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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

> **Phase 6 implementation note (2026-08-15).** Scope held to the smallest end-to-end path:
> one CSV format, parsed, validated, persisted, deduplicated, tested against a real Postgres
> engine. No normalization, classification, AI, review queue, receipts, allocation UI,
> Splitwise or analytics — phases 7+ remain **not started**. Two things the fixture exposed
> needed reviewed documents changed, both recorded in ADR-0019: duplicate matching omitted
> `direction` (which collapsed the two legs of one transfer into a false duplicate), and the
> payment lifecycle had no route from `imported` to `ignored` for a duplicate confirmed at
> import. A third defect was fixed without an ADR: the audit log's read order was
> non-deterministic. `audit_events.occurred_at` defaulted to `now()` — PostgreSQL's
> _transaction_ start — so every event written inside one audited unit of work shared a
> timestamp and ordering fell through to a random UUID.
>
> **That fix was incomplete and is corrected in a follow-up.** Moving the default to
> `clock_timestamp()` was right for the column's meaning (an event happened when it happened,
> not when its transaction opened) but did not fix ordering: the clock resolves to
> milliseconds, so events written back-to-back still tie. `audit_events` now carries a
> monotonic `sequence bigserial`, and `listAuditEvents` orders by it alone. `occurred_at`
> remains the human-facing _when_; `sequence` is the _order_.

> **Phase 7 implementation note (2026-08-19).** Supersedes the phase 6 note's "phases 7+ remain
> not started". Scope held to normalization's **deterministic leg only** (ADR-0022): `channel`
> refined from `reference_type` rather than the description (ADR-0020, which departs from this
> document's earlier phase 7 wording), and merchant resolution by exact match on a canonical
> alias key. No AI, no `AIInference` rows, no classification — `src/ai/` still holds only a
> `README.md`. Delivered as seven reviewed slices, PRs #10–#16. Two things worth recording:
> normalization acts only on `imported` payments, which makes a re-run a no-op rather than a
> silent rewrite of a derived value someone may have acted on (ADR-0021); and the service must
> read eligibility _before_ opening its transaction, because `runAudited` rolls back any unit of
> work that records no audit event, so an empty run would otherwise throw instead of returning
> an empty result.

> **Phase 8 implementation note (2026-08-19).** Classification is where the **AI service
> boundary was built**, not merely used, and that is most of what the phase was. `src/ai` went
> from one `README.md` to the `Inference<T>` contract, a strict hand-written validator (no
> dependency added), the redaction step `security-model.md` requires be one named function, and
> `classifyTransaction` behind an injected `ModelTransport`. `ai_inferences` went from a table
> nothing could write to one with a writer, a decision function, and a `CHECK` constraining
> `inference_type` to the nine operations the contract defines.
>
> Five decisions were needed, each an ADR:
>
> - **ADR-0023** — recognising a self-transfer is deterministic, so `proposedKind` keeps its two
>   members and the two `NEFT/N072026001` legs never reach a model.
> - **ADR-0024** — confidence routes to `CLASSIFIED` or `REVIEW_REQUIRED`; nothing auto-approves,
>   because the only mechanism invariant #16 permits for that is a matched `Rule` (phase 16).
> - **ADR-0025** — the model transport is injected and no provider is wired; the suite scripts
>   one from a fixture, so the real validator, service and database all run in the test.
> - **ADR-0026** — a classification proposal writes a DERIVED `Expense`; a settlement proposal
>   writes nothing until accepted, because `Settlement` has no pre-approval state.
> - **ADR-0027** — debits only. A credit is never new spend, and V1 does not classify inflow
>   (ADR-0015), so the fixture's refund credit ends the phase untouched with a recorded reason.
>
> One documented statement was corrected: `lifecycle.md`'s `PROPOSED` bullet said an `Expense`
> is created "as a byproduct of _accepting_" a classification inference. It is created when the
> proposal is **recorded** — otherwise `REVIEW_REQUIRED` is unreachable and `data-flow.md` step
> 5's `db.updateExpense (APPROVED)` has nothing to update.
>
> Delivered as seven reviewed slices on one phase branch: spec, domain rules, the AI boundary,
> repository queries, the classification service, `decideInference`, the end-to-end pipeline,
> and this documentation pass.

## Recommended next phase

**Phase 9, Human review.** Phase 8 produces exactly what a review queue needs and nothing that
reads it: `REVIEW_REQUIRED` expenses, pending `AIInference`s (including settlement proposals,
which have no expense to show beside them), and `services.decideInference` as the function the
queue calls. What is missing is the listing side and the policies around it.

Six things to carry into it:

- **There is no listing query yet.** Phase 8 added `findClassificationInferenceByPayment` (one
  payment's proposal) and `listPaymentsAwaitingClassification`, but nothing that answers "what
  is waiting for me". Prioritisation is available for free: `domain.routeClassificationForReview`
  is pure and returns _every_ reason a proposal needs review, so the queue can order and explain
  itself without storing anything.
- **A rejected proposal leaves its DERIVED `Expense` unapproved, and nothing cleans it up**
  (ADR-0026). Deliberate — nothing here deletes financial records, and an unapproved expense
  reaches no total — but the queue has to decide whether such a row is hidden, re-proposed, or
  given a state. That decision is phase 9's.
- **`superseded` is defined and unused.** A payment that already carries a classification
  inference is not classified again, so a re-run is a no-op. Re-classification (which is what
  produces a `superseded` inference) is a review action.
- **Possible-duplicate surfacing is still unbuilt**, and still belongs here — a row that merely
  _resembles_ another (same amount and date, no matching reference) is left alone by the
  importer. `domain.isPossibleDuplicate` has existed since the foundation pass with no caller.
- **`ai.normalizeMerchant()` is still unbuilt** (ADR-0022, carried forward again). The boundary
  it was waiting for now exists, so it is a small addition rather than a design: it belongs on
  the miss path where `findMerchantByAliasKey` returns `null`. Which phase ships it is open.
- **The merchant catalog still has no production seeding path** (carried forward from phase 7).
  `fixtures/merchants.json` is seeded only by the test harness. Classification never writes a
  `Merchant`, so phase 8 did not need one — but `ai.normalizeMerchant()` accepted _would_ create
  one, so that leg and this path arrive together.

Two more things phase 8 deliberately did not build, recorded so they are not mistaken for gaps:
no production `ModelTransport` and no prompt text (ADR-0025), and no allocation — an approved
expense from this phase has no beneficiaries yet, which is phase 12's.

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
