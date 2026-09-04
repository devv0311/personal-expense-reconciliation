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

| #   | Phase                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Repository foundation      | **Done** — this document, plus everything under `docs/`, tooling in the repo root, and the `src/` module skeleton.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Domain model               | **Done, revised 2026-08** — `docs/domain/`. See revision note above. Will continue to evolve as implementation surfaces gaps, via ADRs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | Architecture               | **Done, revised 2026-08** — `docs/architecture/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | Database model             | **Designed, not migrated, revised 2026-08** — `docs/architecture/database-design.md`. Migrations are written at the start of Phase 5's successor, Phase 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | Synthetic fixtures         | **Done, revised 2026-08** — `fixtures/`. New fixtures added for the reverse-payer, settlement, adjustment, group-expansion, and dedup scenarios (`scenario-analysis.md` §26–§35).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | Transaction import         | **Done (2026-08-15)** — one synthetic source format end to end: `fixtures/bank-statement.csv` → `integrations/bank-csv` parser → `services.importBankStatementCsv` → `ImportBatch` + immutable `Payment` rows, with `external_reference`/`reference_type`/`source_system` populated at import as planned. Deterministic dedup at two levels (file content hash; per-row external reference). Classification is deliberately **not** performed — every imported payment stays `counterparty_type = unknown` and `state = imported`. Surfaced two corrections, ADR-0019.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7   | Transaction normalization  | **Done (2026-08-19)** — the deterministic leg only. `domain.refineChannel` refines `channel` from `reference_type`, never the description (ADR-0020); `domain.merchantAliasKey` + exact alias match resolves a catalogued merchant; `services.normalizePayments` moves `imported → normalized` in one audited transaction, acting only on `imported` payments so a re-run is a no-op (ADR-0021). The `ai.normalizeMerchant()` leg is deliberately deferred to phase 8 (ADR-0022), so an unresolved counterparty ends `normalized`/`unknown` with no `AIInference` row. 5 of the bank fixture's 8 rows resolve a merchant; the two self-transfer legs and the person-to-person row stay `unknown` because recognising either is classification.                                                                                                                                                                                                                           |
| 8   | Transaction classification | **Done (2026-08-19)** — the AI service boundary itself, not merely its first user. `src/ai` holds the `Inference<T>` contract, the strict validator, the redaction step and `classifyTransaction` behind an injected `ModelTransport` (ADR-0025, no provider wired). `services.classifyPayments` runs a deterministic self-transfer leg first (ADR-0023), then the model for what it cannot settle, then a semantic gate, a pending `AIInference` and a DERIVED `Expense` routed to `classified` or `review_required` (ADR-0024, ADR-0026). `services.decideInference` is the sole path out of `pending`, producing an approved `Expense` + `PaymentExpenseLink` or a `Settlement`. Credits are deliberately out of scope (ADR-0027). All 8 bank-fixture rows reach a stated outcome; the pipeline ends with `ledger_unexplained_total = 0`.                                                                                                                             |
| 9   | Human review               | **Done (2026-08-20)** — `services.listReviewQueue` over three item kinds (pending classification proposals including settlement ones, possible-duplicate pairs, payments left unexplained by a rejection), ordered by a pure total-order function with every reason carried (ADR-0029). Three review actions beside `decideInference`, none bypassing it: `reclassifyPayment` (supersede and ask again — the only thing that lifts phase 8's no-op rule, ADR-0030), `confirmPossibleDuplicate` and `dismissPossibleDuplicate` (ADR-0031). A declined or superseded proposal's DERIVED expense now ends at the terminal `rejected` state (ADR-0028), resolving what ADR-0026 deferred. Four Web-standard route handlers expose it, with no framework installed (ADR-0032).                                                                                                                                                                                                |
| 10  | Receipt ingestion          | **Done (2026-08-22)** — the storage decision made rather than described. Documents are content-addressed (`sha256/<digest>.<ext>`) behind an `EvidenceStore` port with one adapter, the filesystem one, rooted at `EVIDENCE_STORAGE_PATH` (ADR-0033); no S3 client is wired. `services.ingestEvidenceDocument` / `recordManualNote` / `linkEvidence` / `readEvidenceDocument` write and read `Evidence`, audited, with re-ingestion of the same bytes resolving to the row that already holds them. Linkage may be filled in once and never rewritten (ADR-0034). A document attached to nothing surfaces as `unmatched_evidence`, ranked last in the existing queue and carrying no proposal (ADR-0035). Five more route handlers, still no framework. Migration `0006_evidence_ingestion.sql` adds `media_type`/`byte_size` and five check constraints. Extraction is deliberately **not** performed: no model is called and no receipt is read.                       |
| 11  | Receipt item extraction    | **Done (2026-08-27)** — `ai.parseReceipt`/`ai.extractReceiptItems`, the fourth and fifth operations on phase 8's boundary, still behind an injected transport with no provider wired. `services.extractReceipt` writes `Receipt` + `ReceiptItem`s directly (no `decideInference`-shaped gate — `Receipt` is DERIVED, not APPROVED-classified, ADR-0036); `confirmReceipt`/`correctReceipt` are the human side, a boolean flip or an overwrite. The two discrepancies `scenario-analysis.md` §20 and `ReceiptItem`'s own invariant call for are computed and returned, never enforced. `unmatched_evidence` (ADR-0035) is enriched with a receipt's total and any deterministic candidate payment match once one exists — never auto-linked (ADR-0037); `services.linkEvidence` is still the only write path. Four route handlers. Deferred, by explicit scope decision: `ai.normalizeMerchant()`/the Merchant catalog write path, and manual (no-AI) receipt/item entry. |
| 12  | Beneficiary allocation     | **Done (2026-08-27)** — the write path (`approveAllocation`, all six methods, group-line expansion, `recordExpenseAdjustment`/`distributeAdjustment`, `recordSettlement`) turned out to already exist, complete, from the 2026-08-14 foundation pass (ADR-0038 corrects this row's earlier "Not started"). This phase's actual work: `services.recordExpenseItems` (the one genuinely new piece — `ExpenseItem`'s write path, closing phase 11's deferred manual item entry), and six route handlers giving all of the above their first `src/api` caller, including a second, independent settlement path alongside `decideInference`'s existing one. `ai.suggestBeneficiaries`/`suggestAllocation` and `getBalance`/`runReconciliation` API exposure deliberately deferred (the latter to phases 13/15, which already own it).                                                                                                                                         |
| 13  | Expense ledger             | **Done (2026-09-04)** — `services.getBalance` (pairwise `Balance`, in either direction, ADR-0006) turned out to already exist, complete, from the 2026-08-14 foundation pass (ADR-0039 corrects this row's earlier "Not started"). This phase's actual work: `db.listExpenses`/`services.listExpenses`, a new filterable, newest-first ledger listing computing `netAmount` the same batched way `loadReconciliationInput` already does, and two route handlers — `GET /api/expenses`, `GET /api/balances/:personAId/:personBId` — giving both their first `src/api` caller. `runReconciliation` API exposure deliberately deferred to phase 15, which already owns it.                                                                                                                                                                                                                                                                                                  |
| 14  | Splitwise integration      | Not started. `ExternalIntegration` + `SplitwiseExpense` + `SplitwiseSettlement` (ADR-0007), sandbox-only until deliberately switched to a real account. Group-line expansion (ADR-0009) is enforced here as the only path into the sync payload builder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 15  | Reconciliation             | Not started. `ReconciliationRun` computation (now with `ledger_investments_total` and `ledger_settlements_total` buckets, ADR-0011/0007) and discrepancy surfacing, including `stale` vs. `drifted` sync-status handling (ADR-0008).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 16  | Rules/learning             | Not started. `Rule` creation (manual first, AI-proposed later) and auto-application.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 17  | Analytics                  | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 18  | Natural-language interface | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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

> **Phase 9 implementation note (2026-08-20).** Human review turned phase 8's states into a
> capability: a queue, three actions, and a surface. Five decisions were needed, each an ADR.
>
> - **ADR-0028** — a declined or superseded proposal's DERIVED `Expense` moves to a terminal
>   `rejected` state, resolving the loose end ADR-0026 deliberately left to this phase. A state
>   rather than a derived query, because "is this expense real?" should be a column in the one
>   table where getting it wrong means counting money that does not exist. Migration
>   `0005_expense_rejected_state.sql`.
> - **ADR-0029** — the queue's order is a pure total-order function (rank, amount desc, oldest
>   first, id) and its reasons are phase 8's `routeClassificationForReview`, reused rather than
>   re-derived. Possible duplicates rank first; a proposal routing did not flag still appears,
>   because nothing auto-approves.
> - **ADR-0030** — re-classification is an explicit human action that supersedes an undecided
>   proposal, in one transaction with the new one. A plain `classifyPayments` re-run stays a
>   no-op; `superseded` now has exactly one producer.
> - **ADR-0031** — `domain.isPossibleDuplicate`, which had no caller since the foundation pass,
>   is wired to the queue. Confirming re-checks the pair before discarding a payment; dismissing
>   changes nothing and records the decision, which is what lets a queue be emptied.
> - **ADR-0032** — the API ships as Web `Request → Response` handlers, which is a Next.js route
>   handler's exact signature, without installing Next.js to serve four routes before any UI
>   exists. Verified against the existing toolchain before deciding it.
>
> Two things worth recording beyond the ADRs. The queue re-parses stored proposals on read and
> surfaces an unreadable one as `malformed_proposal` rather than throwing, so one bad row cannot
> take the whole queue down. And `classifyPayment`'s recording core was extracted
> (`proposeClassification`) so re-classification could share it — deliberately not a `force`
> flag, because a flag that skips the idempotency rule will eventually be passed by something
> that should not.
>
> Delivered as six reviewed slices on one phase branch: spec, domain review model, repository
> queries, the queue service, the review actions, the API surface, and this documentation pass.

> **Phase 10 implementation note (2026-08-22).** Receipt ingestion is the first phase that had
> to _make_ a deployment-shaped decision rather than describe one, and the first that writes an
> `Evidence` row outside the test harness. Three ADRs.
>
> - **ADR-0033** — documents are content-addressed, `sha256/<digest>.<ext>`, behind a
>   `put`/`get`/`has` port with no `delete`. A content address makes `Evidence`'s immutability a
>   property of the layout rather than a rule to remember, makes re-ingesting the same photograph
>   deterministic, and keeps merchant names and original filenames out of storage paths. One
>   adapter ships (filesystem, `EVIDENCE_STORAGE_PATH`); object storage is a sibling file when a
>   phase needs it. `media_type`/`byte_size` become columns, because a ledger that cannot describe
>   its own evidence without calling out to storage has put the description in the wrong place.
> - **ADR-0034** — linkage may be filled in once and never re-pointed or cleared. The grants file
>   already called it DERIVED metadata and granted the `UPDATE` back on an otherwise unwritable
>   table; what it did not say was _how many times_. A receipt reaching its payment through those
>   two columns is what everything extracted from it inherits.
> - **ADR-0035** — `unmatched_evidence` is a fourth queue kind at rank 4, last, with the argument
>   written next to it: no ledger number is wrong while it sits there, and its amount is unknown
>   until extraction reads one. It carries no proposal about where the document belongs.
>
> Two things worth recording beyond the ADRs. The router now gives the first matching pattern
> ownership of a path — without it, a `GET /api/evidence/files` fell past the POST it belongs to
> into `/api/evidence/:evidenceId` and complained that "files" is not a UUID. And the domain's
> write-once set for `Evidence` gained `type` and `note_kind`: a documenting note that quietly
> became a `settlement_claim` would report an obligation cleared that nobody said was cleared,
> which is precisely what ADR-0018 exists to prevent.
>
> Delivered as seven reviewed slices on one phase branch: the domain rules, the store, the
> schema, the service, the queue kind, the API surface, and this documentation pass.

> **Phase 11 implementation note (2026-08-27).** Receipt item extraction is the first phase whose
> output writes state without a `decideInference`-shaped gate — `Receipt` is DERIVED, not
> APPROVED-classified anywhere in `domain-model.md`, and its own lifecycle text ("Created by AI
> extraction … Confirmed or corrected by the user") describes direct creation, not a proposal
> withheld until accepted. Two ADRs.
>
> - **ADR-0036** — `services.extractReceipt` writes `Receipt` + `ReceiptItem`s in the same
>   audited unit of work as the two `AIInference` rows (`parse_receipt`, `extract_receipt_items`).
>   `confirmed_by_user` is the human-facing surface: `confirmReceipt` flips it and accepts both
>   inferences, `correctReceipt` overwrites fields/items and marks them `modified` — either action
>   touching only an inference still `pending`, so a correction after an earlier confirmation
>   leaves that confirmation's decided inferences alone rather than re-deciding something
>   terminal.
> - **ADR-0037** — `unmatched_evidence` (ADR-0035) is enriched with a receipt's total and any
>   deterministic candidate payment match (`domain.findCandidatePaymentMatches`: exact amount,
>   bounded date window) once one exists. Nothing auto-links: ADR-0034's write-once evidence
>   linkage makes a wrong auto-link unrecoverable, so `services.linkEvidence` stays the only,
>   human-driven, write path.
>
> Two things worth recording beyond the ADRs. `ModelRequest.input` widened from `RedactedPayment`
> to `unknown` so one `ModelTransport` could serve `parseReceipt`/`extractReceiptItems` alongside
> `classifyTransaction` — a transport reads `operation` to know which shape it received. And a
> `ReceiptDraft`/`ReceiptItemDraft[]` carries `Paise` (bigint) fields directly, which `jsonb`
> cannot serialize; `AIInference.proposed_output` stores them as exact minor-units strings, which
> costs nothing because nothing reads that column back into a typed proposal.
>
> Two things deliberately deferred, decided before implementation started rather than discovered
> mid-phase: **`ai.normalizeMerchant()` and the Merchant catalog write path** (`Merchant` _is_ in
> `ai-boundary.md`'s gated APPROVED-classified list, so it needs its own decision path — a receipt
> resolves its merchant only through the existing phase-7 deterministic alias match, leaving an
> unmatched hint's `merchant_id` null exactly as an unresolved payment counterparty already does),
> and **manual (no-AI) receipt/item entry** (closer to phase 12's `ExpenseItem` work than to this
> phase's AI-extraction driver). See
> `docs/superpowers/specs/2026-08-27-phase-11-receipt-item-extraction-design.md` for the reasoning
> behind both.
>
> Delivered as seven reviewed slices on one phase branch: domain rules, the AI boundary,
> repository queries, the receipt service, review-queue enrichment, the API surface, and this
> documentation pass.

> **Phase 12 implementation note (2026-08-27, ADR-0038).** Before implementation started,
> reading the actual code found this phase's roadmap description stale: `approveAllocation`
> (all six methods, group-line expansion), `recordExpenseAdjustment`/`distributeAdjustment` and
> `recordSettlement` all already existed, complete, from the 2026-08-14 foundation pass, covered
> by 2172 lines of scenario tests. The corrected, actual scope, confirmed with Dev directly:
>
> - **`services.recordExpenseItems`** — the one genuinely new piece. Writes an expense's
>   complete item breakdown once, `domain.validateExpenseItemsSum` refusing a partial one
>   (`domain-model.md`'s `ExpenseItem` invariant: items must sum to exactly the gross amount).
>   Closes phase 11's deferred manual (no-AI) item entry as a side effect — the caller supplies
>   final numbers directly, which was never an inference.
> - **Six route handlers** giving the foundation pass's services their first `src/api` caller —
>   the same gap phases 9–11 each closed for their own layer. Includes a second, independent
>   `POST /api/payments/:paymentId/settlements` alongside `decideInference`'s existing
>   settlement path.
>
> Deferred, explicitly: `ai.suggestBeneficiaries`/`suggestAllocation` (a second gated AI
> operation pair, not an extension of "wire an existing path to HTTP" — ADR-0036's precedent),
> and `getBalance`/`runReconciliation` API exposure, left to phases 13/15 which already own that
> surface per this document.
>
> Delivered as three slices on one phase branch: the `ExpenseItem` write path, the API surface,
> and this documentation pass — see `docs/superpowers/specs/2026-08-27-phase-12-beneficiary-
allocation-design.md` for the full scope-correction reasoning.

> **Phase 13 implementation note (2026-09-04, ADR-0039).** Before implementation started,
> checking the two things phase 12's own "Recommended next phase" note asked to verify found
> both true: `services.getBalance` (`balance-service.ts:67-96`) was complete, from the
> 2026-08-14 foundation pass, and had no `src/api` caller; there was no `db.repositories.ts`
> listing query and no service reading back the expense ledger. The corrected, confirmed scope:
>
> - **`GET /api/balances/:personAId/:personBId`** — the already-complete `getBalance`'s first
>   caller. `userPersonId` resolves via the existing `requireUserPersonId`, not a request field.
> - **`db.listExpenses` + `services.listExpenses` + `GET /api/expenses`** — the one genuinely
>   new piece: a filterable (`state`, `paidByPersonId`, bounded `limit`), newest-first ledger
>   listing. `netAmount` per row is computed the same "batch gross + adjustments, let
>   `domain.netAmount` subtract" way `loadReconciliationInput` already does for the identical
>   figure — never a second implementation of the subtraction.
>
> Deferred, explicitly: `runReconciliation` API exposure, left to phase 15 which already owns
> that surface per this document; date-range/cursor pagination on the ledger listing, not named
> by this phase's own description.
>
> Delivered as two slices on one phase branch: the read path (`db.listExpenses` +
> `services.listExpenses`), and the API surface — see
> `docs/superpowers/specs/2026-09-04-phase-13-expense-ledger-design.md` for the full reasoning.

## Recommended next phase

**Phase 14, Splitwise integration.** `ExternalIntegration` + `SplitwiseExpense` +
`SplitwiseSettlement` (ADR-0007), sandbox-only until deliberately switched to a real account;
group-line expansion (ADR-0009) is enforced as the only path into the sync payload builder.
Given the pattern the last several phases have found — service/domain logic already built by
the 2026-08-14 foundation pass, waiting only for a caller — check `src/services/` and `grep`
`src/api/` for any Splitwise-shaped function before assuming this phase starts from zero, the
same discipline ADR-0038 and ADR-0039 both argue for.

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
