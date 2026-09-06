# Roadmap

> **Current roadmap (2026-09-06).** Phases 16–20 are complete; Phase 21 (the UI overhaul) is
> next. Phases 16–21 replace the earlier numbered Rules/learning, Analytics and Natural-language
> sequence. Those capabilities remain unnumbered later work after Phase 21. Historical notes
> below and in `docs/superpowers/` retain their original phase references; this schedule governs.
> ADR-0017 (cash balance)'s persistence, classification lifecycle and account snapshots, and
> ADR-0018 (item refunds) in full — attribution schema, validation, **and** the allocation
> engine that turns net item costs into a superseding allocation and new obligations — are now
> **shipped**, as is Phase 19's Splitwise drift and ghost-debt auditing engine
> ([ADR-0046](decisions/0046-splitwise-audit-findings-and-external-read-completeness.md)) and
> Phase 20's derived proof packs
> ([ADR-0047](decisions/0047-proof-packs-are-a-derived-read-not-a-second-ledger.md)):
> `domain.buildProofPack` + `services.buildProofPackPreview` + `GET /api/proof-packs/:recipientPersonId`,
> a pure recipient-specific read that quotes `getBalance`, `getRefundAllocationState` and the
> open Phase 19 findings rather than recomputing any figure, redacts free text through Phase 17's
> boundary and refuses to return an unredacted pack, and persists nothing — no table, no
> migration. Only Phase 21 (the `web/` overhaul) remains before the unnumbered later work.

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

| #   | Phase                                                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository foundation                                      | **Done** — this document, plus everything under `docs/`, tooling in the repo root, and the `src/` module skeleton.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2   | Domain model                                               | **Done, revised 2026-08** — `docs/domain/`. See revision note above. Will continue to evolve as implementation surfaces gaps, via ADRs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | Architecture                                               | **Done, revised 2026-08** — `docs/architecture/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Database model                                             | **Designed, not migrated, revised 2026-08** — `docs/architecture/database-design.md`. Migrations are written at the start of Phase 5's successor, Phase 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | Synthetic fixtures                                         | **Done, revised 2026-08** — `fixtures/`. New fixtures added for the reverse-payer, settlement, adjustment, group-expansion, and dedup scenarios (`scenario-analysis.md` §26–§35).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | Transaction import                                         | **Done (2026-08-15)** — one synthetic source format end to end: `fixtures/bank-statement.csv` → `integrations/bank-csv` parser → `services.importBankStatementCsv` → `ImportBatch` + immutable `Payment` rows, with `external_reference`/`reference_type`/`source_system` populated at import as planned. Deterministic dedup at two levels (file content hash; per-row external reference). Classification is deliberately **not** performed — every imported payment stays `counterparty_type = unknown` and `state = imported`. Surfaced two corrections, ADR-0019.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | Transaction normalization                                  | **Done (2026-08-19)** — the deterministic leg only. `domain.refineChannel` refines `channel` from `reference_type`, never the description (ADR-0020); `domain.merchantAliasKey` + exact alias match resolves a catalogued merchant; `services.normalizePayments` moves `imported → normalized` in one audited transaction, acting only on `imported` payments so a re-run is a no-op (ADR-0021). The `ai.normalizeMerchant()` leg is deliberately deferred to phase 8 (ADR-0022), so an unresolved counterparty ends `normalized`/`unknown` with no `AIInference` row. 5 of the bank fixture's 8 rows resolve a merchant; the two self-transfer legs and the person-to-person row stay `unknown` because recognising either is classification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | Transaction classification                                 | **Done (2026-08-19)** — the AI service boundary itself, not merely its first user. `src/ai` holds the `Inference<T>` contract, the strict validator, the redaction step and `classifyTransaction` behind an injected `ModelTransport` (ADR-0025, no provider wired). `services.classifyPayments` runs a deterministic self-transfer leg first (ADR-0023), then the model for what it cannot settle, then a semantic gate, a pending `AIInference` and a DERIVED `Expense` routed to `classified` or `review_required` (ADR-0024, ADR-0026). `services.decideInference` is the sole path out of `pending`, producing an approved `Expense` + `PaymentExpenseLink` or a `Settlement`. Credits are deliberately out of scope (ADR-0027). All 8 bank-fixture rows reach a stated outcome; the pipeline ends with `ledger_unexplained_total = 0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 9   | Human review                                               | **Done (2026-08-20)** — `services.listReviewQueue` over three item kinds (pending classification proposals including settlement ones, possible-duplicate pairs, payments left unexplained by a rejection), ordered by a pure total-order function with every reason carried (ADR-0029). Three review actions beside `decideInference`, none bypassing it: `reclassifyPayment` (supersede and ask again — the only thing that lifts phase 8's no-op rule, ADR-0030), `confirmPossibleDuplicate` and `dismissPossibleDuplicate` (ADR-0031). A declined or superseded proposal's DERIVED expense now ends at the terminal `rejected` state (ADR-0028), resolving what ADR-0026 deferred. Four Web-standard route handlers expose it, with no framework installed (ADR-0032).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | Receipt ingestion                                          | **Done (2026-08-22)** — the storage decision made rather than described. Documents are content-addressed (`sha256/<digest>.<ext>`) behind an `EvidenceStore` port with one adapter, the filesystem one, rooted at `EVIDENCE_STORAGE_PATH` (ADR-0033); no S3 client is wired. `services.ingestEvidenceDocument` / `recordManualNote` / `linkEvidence` / `readEvidenceDocument` write and read `Evidence`, audited, with re-ingestion of the same bytes resolving to the row that already holds them. Linkage may be filled in once and never rewritten (ADR-0034). A document attached to nothing surfaces as `unmatched_evidence`, ranked last in the existing queue and carrying no proposal (ADR-0035). Five more route handlers, still no framework. Migration `0006_evidence_ingestion.sql` adds `media_type`/`byte_size` and five check constraints. Extraction is deliberately **not** performed: no model is called and no receipt is read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | Receipt item extraction                                    | **Done (2026-08-27)** — `ai.parseReceipt`/`ai.extractReceiptItems`, the fourth and fifth operations on phase 8's boundary, still behind an injected transport with no provider wired. `services.extractReceipt` writes `Receipt` + `ReceiptItem`s directly (no `decideInference`-shaped gate — `Receipt` is DERIVED, not APPROVED-classified, ADR-0036); `confirmReceipt`/`correctReceipt` are the human side, a boolean flip or an overwrite. The two discrepancies `scenario-analysis.md` §20 and `ReceiptItem`'s own invariant call for are computed and returned, never enforced. `unmatched_evidence` (ADR-0035) is enriched with a receipt's total and any deterministic candidate payment match once one exists — never auto-linked (ADR-0037); `services.linkEvidence` is still the only write path. Four route handlers. Deferred, by explicit scope decision: `ai.normalizeMerchant()`/the Merchant catalog write path, and manual (no-AI) receipt/item entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 12  | Beneficiary allocation                                     | **Done (2026-08-27)** — the write path (`approveAllocation`, all six methods, group-line expansion, `recordExpenseAdjustment`/`distributeAdjustment`, `recordSettlement`) turned out to already exist, complete, from the 2026-08-14 foundation pass (ADR-0038 corrects this row's earlier "Not started"). This phase's actual work: `services.recordExpenseItems` (the one genuinely new piece — `ExpenseItem`'s write path, closing phase 11's deferred manual item entry), and six route handlers giving all of the above their first `src/api` caller, including a second, independent settlement path alongside `decideInference`'s existing one. `ai.suggestBeneficiaries`/`suggestAllocation` and `getBalance`/`runReconciliation` API exposure deliberately deferred (the latter to phases 13/15, which already own it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | Expense ledger                                             | **Done (2026-09-04)** — `services.getBalance` (pairwise `Balance`, in either direction, ADR-0006) turned out to already exist, complete, from the 2026-08-14 foundation pass (ADR-0039 corrects this row's earlier "Not started"). This phase's actual work: `db.listExpenses`/`services.listExpenses`, a new filterable, newest-first ledger listing computing `netAmount` the same batched way `loadReconciliationInput` already does, and two route handlers — `GET /api/expenses`, `GET /api/balances/:personAId/:personBId` — giving both their first `src/api` caller. `runReconciliation` API exposure deliberately deferred to phase 15, which already owns it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14  | Splitwise integration                                      | **Done (2026-09-04)** — the schema, enums and `markSplitwiseExpenseStale` turned out to already exist from the 2026-08-14 foundation pass (ADR-0040 corrects this row's earlier "Not started"), but nothing above the schema did. This phase's actual work: a `SplitwisePort` interface with no concrete adapter (ADR-0025's precedent), the missing repository writes/reads for `external_integrations`/`splitwise_expenses`/`splitwise_settlements`, `services.connectSplitwiseIntegration`/`syncExpenseToSplitwise`/`syncSettlementToSplitwise` (group-line expansion always resolved via `loaders.resolveAllocationShares`, never a raw group id), and four route handlers — including the first `src/api` caller for the `allocated → ready_to_sync` transition. `fetchBalances`/drift detection and `stale`→re-sync were initially deferred; Phase 15 delivered drift detection and left re-sync as separate future integration work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 15  | Reconciliation                                             | **Done (2026-09-04)** — the outflow-only `ReconciliationRun` computation turned out to already exist, complete, from the 2026-08-14 foundation pass (ADR-0041 corrects this row's earlier "Not started"). This phase's actual work: `SplitwisePort.fetchBalances()` and `domain.compareSplitwiseBalance`, giving `drifted` its first writer (`runReconciliation` now compares this ledger's `NetBalance` against Splitwise's reported balance per linked person when connected, resilient to a failed fetch — ADR-0041); three routes (`POST`/`GET /api/reconciliation/runs`, `GET /api/reconciliation/runs/:id`); and, as a first-class deliverable rather than a placeholder, the project's first production UI — a standalone Next.js app in `web/`, served by a new `src/server.ts` (`node:http` bridge over `createApi`, no framework — ADR-0042), reachable for the first time outside a test. `GET /api/people` (`services.listPeople`) shipped alongside it, the roster the UI needed and no phase before it did.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 16  | ADR-0017 & ADR-0018 Schema & Domain Extension              | **Done (2026-09-06)** — migration `0007_phase16_cash_flow_and_item_refunds.sql`, additive only. `Payment.cash_flow_category` plus an explicit `cash_flow_state` lifecycle running **alongside** the untouched `Payment.state`, with the direction, category/state, approved-credit, approved-counterparty and approval-provenance rules as row-local `CHECK`s and the evidence gates in `services.approvePaymentCashFlow`. `reconciliation_account_snapshots` carries ADR-0017's second identity per account, with every arithmetic identity — coverage, transfer subsets, `expected_ending_balance`, `cash_balance_delta`, and the full `verified` condition — enforced as a row `CHECK`; `runReconciliation` writes one per account per run while ADR-0016's totals come out byte-identical. `expense_adjustment_items` records which item a refund gave money back for, validated as a complete set under a row lock on the parent expense (19.2/19.3). Three domain modules (`cash-flow`, `cash-balance`, `refund-attribution`), 210 new tests. Deliberately **not** done: the item-refund allocation engine (Phase 18), any API surface for boundary balances or snapshots (Phase 21), and any backfill of legacy runs, approvals or attributions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 17  | Evidence Enrichment & Context Re-attachment Service        | **Done (2026-09-06)** — migration `0008_phase17_evidence_enrichment.sql`, additive apart from widening `audit_events`' entity-type check and the `evidence_unmatched_idx` predicate. Two DERIVED tables beside the immutable source: `evidence_observations` (one structured reading per `Evidence` — amount, direction, reference, masked account tail, merchant, instant — parsed deterministically by `domain.parseNotificationText` or supplied by an importer, never by a model, with a unique-where-present `notification_key` so a forwarded notification is one record) and `evidence_match_candidates` (one explained offer per evidence/payment pair, carrying every signal's verdict and both sides of the comparison). `domain.matchEvidenceToPayments` compares six signals — reference, amount, direction, owned account, time, merchant — with `absent` kept distinct from `conflicted`; a structural disagreement produces no candidate, a reference match with a disagreeing amount produces a flagged one. **Nothing auto-links:** `services.decideEvidenceMatch` reaches `evidence.linked_payment_id` through phase 10's own `assertEvidenceLinkOnce`/`applyEvidenceLink`, and the schema refuses `accepted`/`dismissed` without a recorded actor (ADR-0044). A re-run over an unchanged ledger writes nothing — no row, no `updated_at`, no audit event. Bank/UPI notifications became first-class evidence with their own ingestion route and a place in the review queue; the `unmatched_evidence` item gained `observation` and `matchCandidates` beside ADR-0037's unchanged `candidateMatches`. `services.getPaymentContext` derives the re-attached context as a pure read, narration verbatim and disagreements named rather than resolved, and feeds its merchant hints to phase 8's classifier. The sanitization boundary gained `assertPayloadSanitized` — a fail-closed guard that throws instead of sending, running at the end of every redaction builder — and `createLocalRedactionMap`, the reversible mapping kept local. 156 new tests. Deliberately **not** done: the item-refund allocation engine (Phase 18), any UI for enrichment (Phase 21), and any rule-learning or auto-approval, which stays unnumbered later work.                                                                                 |
| 18  | Item-Level Refund Allocation Engine & Scenario Test Matrix | **Done (2026-09-06)** — no migration; every input the engine needs was already recorded, and allocation versions were already append-only ([ADR-0045](decisions/0045-item-refund-allocation-is-rebuilt-not-decremented.md)). `domain.buildItemAwareAllocationLines` places each item's net cost (`gross − Σ attributions`) on that item's **own** beneficiaries — a sole owner's exact figure copied with no division, a genuinely shared item apportioned by the existing `splitByLargestRemainder` and its `beneficiary_id`-ascending tie-break — then applies any unattributed whole-expense reduction **once**, afterwards, through ADR-0008's own `distributeAdjustment` rather than a second copy of it. The lines are rebuilt from recorded facts every time, so distributing two refunds together lands where distributing after each does, in either order; a second call with nothing new recorded is refused rather than rewriting the same numbers. An allocation that cannot say who owned a refunded item — no `expense_item_id`, an item with no line, a shared item whose shares are all zero — is refused with the new `REFUND_ITEM_OWNERSHIP_REQUIRED` and never falls back to the whole-basket proportional default (ADR-0018, "Calculation semantics"). `services.approveAllocation` now allocates item-based lines against net item costs (invariant #14's tightened form; identical to before when nothing has been refunded). Already-recorded `Settlement`s are untouched, so a refund after settlement surfaces as a reverse balance; a synced `SplitwiseExpense` still moves to `stale` on distribution, with `delete` recorded as the fresh proposal at net zero (ADR-0013). New reads: `services.getRefundAllocationState` and `GET /api/expenses/:expenseId/refund-allocation`, plus `itemAttributions` on `POST /api/expenses/:expenseId/adjustments` — the body field Phase 16's service had been waiting for. 92 new tests (1,594 backend, from 1,502). Deliberately **not** done: persisting per-adjustment distribution weights (ADR-0045, "Consequences"), Splitwise stale re-sync (Phase 19) and any UI (Phase 21).                                                                                                                                                                                             |
| 19  | Splitwise Drift & Ghost-Debt Auditing Engine               | **Done (2026-09-06)** — migration `0009_phase19_splitwise_auditing.sql`, additive: two tables plus two more values on `audit_events_entity_type_check` ([ADR-0046](decisions/0046-splitwise-audit-findings-and-external-read-completeness.md)). Phase 15's aggregate comparison is extended, not rebuilt: `compareSplitwiseBalance`, `detectSplitwiseDrift`, the `drifted` marking rule and the existing `ReconciliationDiscrepancy` entries are unchanged, and `detectSplitwiseDrift` now hands its fetched balances to the audit so one reconciliation still makes one `fetchBalances` call. New: an **optional** `SplitwisePort.fetchLedgerEntries` (read-only, per-entry, with a `complete` flag), `domain.auditSplitwisePair` / `auditUnobservablePairs` / `assessExternalListingCompleteness`, `services.runSplitwiseAudit` / `reviewSplitwiseAuditFinding` and their reads, and six routes under `/api/splitwise/audits`. Each finding carries both compared snapshots, evidence pointers, amount, suspected cause, confidence, the identifiers it actually knows, its run provenance and its review state; `balanceImpact` makes attribution checkable, so whatever no record explains is reported as `unattributed_balance_mismatch` at `unknown` confidence rather than pinned on whichever record would have balanced the totals. `stale` (our side) stays distinct from `drifted` (theirs), and an item-attributed refund is named as its own cause (`unreflected_item_refund`). A failed, partial, unsupported or unreported read is an **incomplete** finding, never agreement: absence is evidence only under a complete read, and no finding is retired by a read that could not be made. Review records actor/time/reason with an append-only `audit_events` history and supersedes rather than rewrites; it authorizes no external write. 102 new tests (1,697 backend, from 1,595). Deliberately **not** done: Splitwise re-sync/update/delete (still unbuilt, third phase running), proof packs (Phase 20) and any UI (Phase 21).                                                                                                                                                                                                                                                                                               |
| 20  | Derived Proof Packs                                        | **Done (2026-09-06)** — no migration and no table ([ADR-0047](decisions/0047-proof-packs-are-a-derived-read-not-a-second-ledger.md)): a proof pack is a pure derived read, like `getBalance` / `getRefundAllocationState` / `getPaymentContext`, none of which persist. `domain.buildProofPack` arranges already-derived facts — the pair balance and its `ObligationEvidenceStatus` from `getBalance`, each expense's recipient share from its `contributions`, the net-after-refund and pending state from `getRefundAllocationState`, prior settlements from `listSettlementsForAudit`, open Phase 19 findings, and `getPaymentContext`'s conflict flag — into a structured pack and a deterministic WhatsApp-ready `generatedText`. It quotes every figure; it re-divides, re-nets and re-derives nothing (a pack that recomputes a share is a bug). **Recipient isolation is structural**: the assembler is only ever handed the recipient's own share and the pair's settlements, so no third party is named. **Redaction reuses Phase 17**: every free-text field goes through `redactReceiptText` with a local, never-returned map, and `services.assertProofPackExportable` walks the finished pack through `findResidualIdentifiers` and throws `SanitizationError` rather than return an unredacted pack (`http.ts` maps it to `500 PAYLOAD_NOT_SANITIZED`). **Uncertainty is carried, never smoothed** — an unresolved audit finding, a pending or review-blocked refund distribution, a believed-settled-but-unconfirmed status, a reverse balance after a settlement, a mixed adjustment basis, conflicting or missing evidence each become a visible `ProofPackWarning` and a `PLEASE NOTE` line, and the pack always states its figures are "not yet confirmed by you". `asOf` is an explicit snapshot label, not a historical filter (that would need a second balance engine); a fixed `asOf` over an unchanged ledger is byte-identical. One route, `GET /api/proof-packs/:recipientPersonId`, a read. 51 new tests (24 `src/domain/proof-pack.test.ts`, 20 `tests/scenarios/proof-packs.test.ts`, 7 `tests/integration/proof-pack-api.test.ts`) — 1,748 backend, from 1,697. Deliberately **not** done: any WhatsApp/messaging transport, a persisted-pack table, a "record that this was shared" event, and all UI (Phase 21). |
| 21  | Modern UI/UX Overhaul in `web/`                            | **Not started.** Tier-1 design system, command palette, interactive splitters, inspectors and visual cash waterfall.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

> **Phase 14 implementation note (2026-09-04, ADR-0040).** Unlike phases 12 and 13, this phase
> turned out stale in the _opposite_ direction: the schema (`external_integrations`,
> `splitwise_expenses`, `splitwise_settlements`, every constraint and index), the enums, the
> branded ids, and `db.markSplitwiseExpenseStale` (already wired into `distributeAdjustment`)
> all predate this phase — but nothing above the schema existed at all, confirmed by `grep`ing
> `src/services/`, `src/api/`, and finding `src/integrations/splitwise/` held only a README.
> The corrected, confirmed scope:
>
> - **`src/integrations/splitwise/port.ts`** — a `SplitwisePort` interface (`createExpense`,
>   `recordPayment`), no concrete adapter, mirroring ADR-0025's "no provider wired" precedent.
> - **The missing repository writes/reads** for all three tables, plus `getSettlementById` and
>   a widened `getPersonById`/`getPrimaryUserPerson`/`getExpenseById` (additive fields, not new
>   functions).
> - **`services/splitwise-service.ts`** — `connectSplitwiseIntegration`,
>   `syncExpenseToSplitwise`, `syncSettlementToSplitwise`. Group-line resolution is shared via
>   the new `loaders.resolveAllocationShares`, extracted from `expense-service.ts`'s
>   `assertReadyToSync` rather than re-implemented.
> - **Four routes**, including the first `src/api` caller for `services.transitionExpense`
>   (`allocated → ready_to_sync`), which had none since it was built.
>
> Deferred, explicitly: `fetchBalances`/drift detection (phase 15, `data-flow.md` step 9);
> re-sync of a `stale` `SplitwiseExpense` (needs `updateExpense`/`deleteExpense` port methods
> this phase does not add); a separate propose/preview route (every other consequential write
> in this codebase is a single POST, and no AI proposal sits on this path to review).
>
> Delivered as three slices on one phase branch: the repository/loaders layer, the port and
> service layer, and the API surface — see
> `docs/superpowers/specs/2026-09-04-phase-14-splitwise-integration-design.md` for the full
> reasoning.

> **Phase 15 implementation note (2026-09-04, ADR-0041, ADR-0042).** Before implementation
> started, reading the actual code found the same pattern as phases 12/13: `domain.
computeUnexplained` and `services.runReconciliation` (persisting a `ReconciliationRun`, the
> row-level identity `CHECK`) were already complete, from the foundation pass — but
> `SplitwisePort` had no `fetchBalances`, nothing computed a Splitwise-balance discrepancy, and
> `drifted` (`SPLITWISE_EXPENSE_SYNC_TRANSITIONS`) had no writer anywhere in the codebase, exactly
> as phase 14's own handoff note said. Separately, and for the first time, this phase's brief
> made a UI a first-class deliverable rather than a placeholder — no prior phase had built one.
> The corrected, confirmed scope:
>
> - **`SplitwisePort.fetchBalances()`** — one entry per Splitwise friend of the connected
>   account, no adapter (ADR-0025/0040 precedent).
> - **`domain.compareSplitwiseBalance`** — a pure, exact `bigint` equality check (no tolerance);
>   `runReconciliation` calls it once per Splitwise-linked person when an integration is
>   connected, marks every affected `synced` `SplitwiseExpense`/`SplitwiseSettlement` `drifted`
>   (audited), and is resilient to `fetchBalances()` itself failing — the ledger's own outflow
>   totals must never become hostage to an unrelated third party being unreachable (ADR-0041).
> - **Three routes**: `POST`/`GET /api/reconciliation/runs`, `GET /api/reconciliation/runs/:id`
>   — `services.runReconciliation`'s first `src/api` caller, deferred here since phase 13
>   (ADR-0039).
> - **`GET /api/people`** (`services.listPeople`, new) — the UI's first need for a name/roster
>   read no earlier phase had a caller for.
> - **`src/server.ts`** — a plain `node:http` + Web `Request`/`Response` bridge over `createApi`,
>   no framework added to `src/` (ADR-0042); `ai`/`splitwise` are unconfigured stubs defined
>   privately inside it, so neither `src/ai`'s nor `src/integrations/splitwise`'s "no adapter
>   ships here" documentation becomes false.
> - **`web/`** — a standalone Next.js (App Router) + Tailwind + TanStack Query app (ADR-0042),
>   its own package/lockfile/tsconfig/eslint/Prettier/Vitest setup, isolated from the root gate.
>   Three screens: the reconciliation dashboard (run a period, the outflow/transfers/
>   investments/settlements/explained/unexplained breakdown as a ledger-style subtraction chain,
>   Splitwise discrepancies, history), balances (pick two people, see `NetBalance` +
>   `ObligationEvidenceStatus` + contributing obligations), and the expense ledger (filterable
>   list). 37 tests (Vitest + React Testing Library); real browser verification (light/dark,
>   desktop/mobile, loading/error/empty/success, a live end-to-end run against seeded data) found
>   and fixed two real defects before merge — see the ADR for both.
>
> Deferred, explicitly: re-syncing a `stale` `SplitwiseExpense`/`SplitwiseSettlement` (a write
> capability against Splitwise, categorically different from this phase's read-and-compare
> scope — `updateExpense`/`deleteExpense` port methods don't exist yet); resolving a discrepancy
> (`ReconciliationDiscrepancy.resolvedAt` stays write-less); per-expense Splitwise refetch for
> precise drift attribution; frontend coverage of review/evidence/receipts (phases 9–11's own
> surfaces); frontend CI.
>
> Delivered as four slices on one phase branch: the drift-detection domain/service/API layer,
> the server bridge + seed script + people route, the frontend foundation and all three screens,
> and this documentation pass — see
> `docs/superpowers/specs/2026-09-04-phase-15-reconciliation-design.md` for the full reasoning.

> **Frontend design-quality pass (2026-09-05, ADR-0043) — not a numbered phase.** Requested
> explicitly, ahead of phase 16: the phase 15 UI was functional but not production-quality, and
> this pass fixed that before any new capability was added. Redesigned the same four screens
> (reconciliation list/detail, balances, expenses) and every loading/empty/error/success state;
> added no product scope. `web/Design.md` is now the authoritative, living design system —
> tokens, typography, component principles, accessibility/responsive rules. Concretely: a named
> seven-step type scale replacing ad hoc pixel values, with exactly one `text-display`/`text-
figure` hero number per screen (previously every figure sat in the same narrow 13–16px band,
> including `ledgerUnexplainedTotal`, the number the whole reconciliation feature exists to
> compute); a new `attention` semantic color separating "a Splitwise mismatch, worth a look" from
> `debit` "this is wrong" (they were both red before, which taught the reader to distrust every
> red figure); a small hand-owned `src/components/ui/` primitive layer (button, table, alert,
> skeleton, styled-native select/input/label) in shadcn/ui's authoring style; and a genuine
> mobile-card fallback (not horizontal scroll) for the three data-dense tables. Lighthouse
> accessibility is 100 on all four screens, desktop and mobile, as of this pass. Two real bugs
> were caught and fixed in the process, both documented in ADR-0043 and `web/Design.md`
> ("Typography"): a dark-mode button using literal `text-white` on a light-in-dark-mode `accent`
> background (a real contrast failure), and a `tailwind-merge` gotcha where two unrelated custom
> `text-*` tokens (a font size and a text color) were treated as conflicting and one silently
> dropped — caught only by reading `getComputedStyle`, not by a screenshot. All 1170 tests (1133
> backend + 37 frontend) and the full gate (`typecheck`/`lint`/`format:check`/`db:check`/`test`,
> both packages) pass unchanged.

> **Phase 16 implementation note (2026-09-06).** Delivered as one branch against the accepted
> designs, additive throughout. Migration `0007_phase16_cash_flow_and_item_refunds.sql` adds four
> columns to `payments` and two tables, drops nothing, and re-adds only the `audit_events`
> entity-type `CHECK` it widens — the same shape migration 0006 used. Three points are worth
> carrying forward because each was a decision, not a transcription:
>
> - **Two gates, not one.** ADR-0017's category table is headed "required interpretation
>   _before approval_", and the ADR separately allows an unresolved counterparty during
>   normalization. So the **direction** rule (a debit refund is arithmetically impossible) is
>   absolute and holds at every stage, while the counterparty and evidence requirements are
>   enforced only at approval. Enforcing them earlier would make the rows that most need a
>   proposal — an unresolved credit — the ones that cannot have one.
> - **`verified` is a database constraint, not a convention.** Every term of 17.6 lands on one
>   snapshot row, so the full condition (evidenced boundaries, zero delta, zero unexplained in
>   both directions, no unresolved discrepancy) is a row `CHECK`. A numeric zero over
>   unidentified transactions cannot be stored as a verified ₹0 Unaccounted Delta by any code
>   path, including one written later that forgets the rule.
> - **19.3's concurrency half is a row lock on the parent expense.** Two refunds recorded at
>   once would otherwise each read the same "already attributed" totals, each find room under
>   the ceiling, and together exceed it. `lockExpenseForAdjustment` serialises them; the test
>   asserts exactly one of two simultaneous over-ceiling refunds survives.
>
> No API surface was added: collecting evidenced statement balances and displaying the account
> waterfall are Phase 21's, so a run given no boundaries produces honestly `incomplete`
> snapshots rather than a cosmetic zero. 1,343 backend tests pass, up from 1,133, with the full
> gate (`typecheck`/`lint`/`format:check`/`db:check`/`build`/`test`) green.

## Recommended next phase

**Phase 21: Modern UI/UX overhaul in `web/`.** All six pillars now have a domain and service
surface; Phase 21 is where they become reachable through coherent end-to-end flows at the
Tier-1 design bar (`CLAUDE.md`, "The Design Standard"). Read
[ADR-0042](decisions/0042-frontend-stack-and-server-bridge.md),
[ADR-0043](decisions/0043-frontend-design-system-and-component-primitives.md) and `web/Design.md`
before starting, and the Phase 21 section below for scope. The proof-pack preview
([ADR-0047](decisions/0047-proof-packs-are-a-derived-read-not-a-second-ledger.md)) is one of the
surfaces it integrates: its deliberate copy/export/share step is a UI concern this phase owns,
and the redaction the preview already performs is not a substitute for a recipient-facing
review of exactly what is about to be sent.

### Phase 20 — Derived proof packs (delivered)

Read [ADR-0047](decisions/0047-proof-packs-are-a-derived-read-not-a-second-ledger.md),
[ADR-0018 (item refunds)](decisions/0018-item-level-refund-attribution.md) and `CLAUDE.md`'s
fifth pillar. Every number a pack quotes already exists and is already derived once —
`domain.netAmount`, the current refund-aware allocation, `computeNetBalance`,
`obligationEvidenceStatus` — so the phase was a _rendering and redaction_ problem, not a second
financial engine, and a pack that recomputes a share is a bug. Two things phase 19 made newly
relevant were carried through: a pair with an open audit finding has facts that are not settled,
and the pack shows that as a warning rather than quoting a confident balance over it; and the
same "an incomplete check is not agreement" rule governs the pack's own as-of label, which is a
snapshot instant and never presented as externally confirmed. Generating a pack neither sends
it nor records a settlement, and the recipient preview/redaction step is separate from the local
evidence boundary that let the pack be built at all.

### Phase 16 — Schema & domain extension (delivered)

- Add Drizzle migrations and domain types/enums for `Payment.cash_flow_category`, its explicit
  interpretation lifecycle, `ReconciliationAccountSnapshot` and `ExpenseAdjustmentItem`.
  Preserve existing `Payment.state`, source facts, outflow functions and historical runs.
- Implement deterministic cash snapshot calculations/persistence, direction/category validation,
  source boundary provenance, completeness checks, transfer pairing provenance, refund item
  validation, and transactional aggregate ceilings. Add foreign keys, positive/unique checks
  and row-local arithmetic checks; enforce cross-record rules in transactional services.
- Backfill conservatively: unknown category/evidence/approval stays unknown. Never retroactively
  certify legacy runs or silently infer item attribution. Document the migration and upgrade
  path for existing data, including genuine movements previously ignored for spend purposes.
- Exit criteria: ADR-0017 invariants 17.1–17.7 and ADR-0018 invariants 19.1–19.6 covered by
  meaningful unit/integration tests, including database enforcement, concurrent ceilings,
  missing evidence and transfers; legacy scenarios and repository quality gates still pass.
  Exercise constraints against the existing PGlite/local and PostgreSQL/CI setup.

### Phase 17 — Evidence enrichment & context re-attachment service (delivered)

- Build the bank statement ↔ SMS/push/receipt matching engine. Use reference, amount, direction,
  account, time window and merchant signals; record candidate provenance, confidence and
  conflicting signals. Reconstruct decayed UPI context without overwriting source narration.
- Prefer deterministic matches. Ambiguous matches are proposals requiring review; linking
  remains explicit and audited. Multiple evidence records enrich one financial movement.
  Deduplication and repeat matching must be idempotent. Retain approved/write-once evidence
  links; new interpretations cannot silently replace them (ADR-0034/0037).
- Extend the local PII sanitization boundary before any external AI transport; raw evidence and
  re-identification mappings remain local. Test payload/log redaction with synthetic sensitive
  markers and fail closed on unsafe output.
- Exit criteria: exact matches, missing references, time skew, same-amount collisions, partial
  evidence, conflicting merchants and repeated imports have explicit outcomes and traceable
  review actions. Matched context never changes arithmetic or silently approves classification.
- **Delivered 2026-09-06** ([ADR-0044](decisions/0044-evidence-observations-and-match-candidates.md)).
  `evidence_observations` + `evidence_match_candidates`, `domain.parseNotificationText` /
  `matchEvidenceToPayments` / `deriveReattachedContext`,
  `services.recordEvidenceNotification` / `recordEvidenceObservation` / `matchEvidenceContext` /
  `decideEvidenceMatch` / `getPaymentContext`, six routes, and a fail-closed
  `ai.assertPayloadSanitized` with `createLocalRedactionMap`. ADR-0034's write-once linkage and
  ADR-0037's candidates-only rule are unchanged and reused rather than re-implemented.

### Phase 18 — Item-level refund allocation engine & scenario test matrix

- Integrate complete `ExpenseAdjustmentItem` attribution into recording/review and allocation
  services: financial event → adjustment → net expense → allocation → obligation.
- Preserve item ownership, original purchase composition and old allocations. Shared item and
  quantity splits use exact rounding. Keep whole-expense legacy reductions explicit and apply
  them once. Pending distributions must remain visible; full refunds retain zero-valued lines.
- Implement the ADR's tax/discount paid-basis policy and original evidence display. Existing
  settlements remain immutable; expose reverse balances when a settled expense is refunded.
- Exit criteria: the complete scenario matrix in ADR-0018 passes, including single/multi-item
  and successive partial refunds, item/expense ceilings, duplicate/concurrent requests, paise
  rounding, wrong-expense links, tax/discount/fee components, evidence-first and externally
  funded cases, mixed legacy adjustments, full refunds, already-settled and synced expenses.
- **Delivered 2026-09-06** ([ADR-0045](decisions/0045-item-refund-allocation-is-rebuilt-not-decremented.md)).
  `domain/refund-allocation.ts` — `deriveItemRefundBases`, `buildItemAwareAllocationLines`,
  `itemAwareAllocationTotal`, `validateItemNetLineSums` — plus the item-attributed branch of
  `services.distributeAdjustment`, `services.getRefundAllocationState`, net-cost-aware
  `approveAllocation`, `db.listExpenseAdjustmentSummaries`, and two API surfaces
  (`itemAttributions` on the record route, `GET /api/expenses/:expenseId/refund-allocation`).
  The engine rebuilds the allocation from the ledger's recorded facts rather than decrementing
  the current lines, which is what makes it order-independent and idempotent; it refuses
  (`REFUND_ITEM_OWNERSHIP_REQUIRED`) rather than falling back to the whole-basket default when
  the current allocation cannot say who owned a refunded item. ADR-0008's whole-expense path is
  untouched and still taken whenever no attribution exists. The full matrix is
  `tests/scenarios/item-refund-allocation.test.ts` (52 scenarios) with the engine's arithmetic
  in `src/domain/refund-allocation.test.ts` (31) and the HTTP surface in
  `tests/integration/allocation-api.test.ts`. 1,594 backend tests pass, up from 1,502, with the
  full gate (`typecheck`/`lint`/`format:check`/`db:check`/`build`/`test`) green against both
  PGlite and stock PostgreSQL 16.

### Phase 19 — Splitwise drift & ghost-debt auditing engine

- Extend Phase 15's completed pair-level comparison with finer expense/allocation/refund and
  settlement evidence where the external read surface supports it. Distinguish local `stale`
  from external `drifted` records; missing or duplicate entries and unreflected item refunds
  can leave apparent debt with no support in the current local ledger.
- Every finding must show compared snapshots, evidence, amount, suspected cause and confidence
  or uncertainty. Aggregate mismatch alone must never assert a particular culprit. Keep
  non-user settlement observability warnings and the canonical local ledger intact.
- Provide explicit audited review/resolution, preserving discrepancy history. Failed or
  unavailable external reads are incomplete checks, never agreement. Audit generation does
  not authorize external writes or invented settlements; stale re-sync/update/delete remains
  a separately previewed and approved operation under the existing policy.
- Exit criteria: missing/duplicate expenses, stale partial/full refunds, missing settlements,
  genuine disagreement, unsupported debt, inaccessible external records and API failures are
  covered, with no accidental change to obligations or source Payments.
- **Delivered 2026-09-06** ([ADR-0046](decisions/0046-splitwise-audit-findings-and-external-read-completeness.md)).
  `domain/splitwise-audit.ts` — `auditSplitwisePair`, `auditUnobservablePairs`,
  `assessExternalListingCompleteness`, `findingFingerprint`, `findingComparisonSource`,
  `findingDependsOnExternalRead` — beside phase 15's untouched `compareSplitwiseBalance`;
  `splitwise_audit_runs` + `splitwise_audit_findings`; `services.runSplitwiseAudit` (also run
  inside `runReconciliation`, on the balances that comparison already fetched) and
  `reviewSplitwiseAuditFinding`; six routes under `/api/splitwise/audits`. The external read
  gains one **optional** method, `SplitwisePort.fetchLedgerEntries`, so an adapter that cannot
  list a pair's entries is representable as `unsupported` rather than as a Splitwise holding
  nothing — and a "complete" listing that cannot account for the balance Splitwise itself
  reported is downgraded to `partial` rather than read as a ledger full of missing expenses.
  Seventeen finding kinds across three classes (`discrepancy`, `limitation`, `incomplete`), each
  produced only where the evidence supports it: `balanceImpact` accounts for a signed share of
  the gap, and whatever is left over is `unattributed_balance_mismatch` at `unknown` confidence.
  Idempotency is a `fingerprint` (cause + record, no amounts, unique among non-superseded rows
  as a partial index) plus a `comparison_digest` (SHA-256 over the canonically rendered
  snapshots): same digest re-observes with no audit event, different digest supersedes and
  inserts, and a finding is retired only by a run that could actually re-derive it. Review is a
  person's decision with actor, time and reason, held append-only in `audit_events`, and
  authorizes no external write. Two permanent limits are recorded as findings rather than left
  implicit: `non_user_settlement_unobservable` (`invariants.md` #9b) and
  `cross_payer_attribution_unavailable` (ADR-0041 §4). Tests: 40 in
  `src/domain/splitwise-audit.test.ts`, 40 in `tests/integration/splitwise-audit.test.ts` and 22
  in `tests/integration/splitwise-audit-api.test.ts` — 1,697 backend tests pass, up from 1,595,
  with the full gate (`typecheck`/`lint`/`format:check`/`db:check`/`build`/`test`) green against
  both PGlite and stock PostgreSQL 16.

### Phase 20 — Derived proof packs

- Generate one-click WhatsApp-ready summaries from approved ledger state: original purchase,
  attributed item refunds, net expense, recipient's share, prior settlements and remaining
  balance, supported by selected evidence references and an as-of timestamp.
- Preview recipient, text and evidence; redact unnecessary third-party and account details.
  Keep uncertain/pending facts labeled. Copy/export/share is a deliberate action; generating
  a pack neither sends it nor records a settlement. No WhatsApp transport is required merely
  to produce the artifact.
- Exit criteria: recipient math matches domain outputs exactly, partial/full refund and reverse
  balance summaries are understandable, stale/pending data is visible, and privacy tests prove
  irrelevant PII is not exported. Regenerate after changes without mutating source records.
- **Delivered 2026-09-06** ([ADR-0047](decisions/0047-proof-packs-are-a-derived-read-not-a-second-ledger.md)).
  `src/domain/proof-pack.ts` — `buildProofPack`, `renderProofPackText`, `formatInr`,
  `collectProofPackExportableStrings` — plus `services.buildProofPackPreview` /
  `assertProofPackExportable`, two small repository reads (`db.listExpensePaymentIds`,
  `db.listEvidenceLinkedToExpense`), and one route, `GET /api/proof-packs/:recipientPersonId`.
  **No migration and no table**: a pack is a pure derived read. Every figure is quoted from
  `getBalance` (balance + `ObligationEvidenceStatus` + per-expense `contributions`),
  `getRefundAllocationState` (net-after-refund, pending/review state) and `getPaymentContext`
  (evidence conflict); prior settlements come from `listSettlementsForAudit` and unresolved
  contested facts from the open `splitwise_audit_findings` for the pair. Recipient isolation is
  structural — the assembler only ever receives the recipient's own share and the pair's
  settlements. Redaction reuses Phase 17's `redactReceiptText` with a local, never-returned map,
  and the finished pack is walked through `findResidualIdentifiers`, throwing `SanitizationError`
  rather than returning an unredacted pack. Uncertainty (open findings, pending/blocked refund
  distribution, believed-settled-unconfirmed, reverse balance after settlement, mixed basis,
  conflicting/missing evidence) each surfaces as a `ProofPackWarning` and a `PLEASE NOTE` line.
  `asOf` is an explicit snapshot label, not a filter; a fixed `asOf` over an unchanged ledger is
  byte-identical, and generating a pack writes nothing — no `AuditEvent`, no row moved, no
  Splitwise call. 51 new tests (24 `src/domain/proof-pack.test.ts`, 20
  `tests/scenarios/proof-packs.test.ts`, 7 `tests/integration/proof-pack-api.test.ts`); 1,748
  backend tests pass, up from 1,697, with the full gate
  (`typecheck`/`lint`/`format:check`/`db:check`/`build`/`test`) green against both PGlite and
  stock PostgreSQL 16. Deliberately **not** done: any WhatsApp/messaging transport, a persisted
  proof-pack table, a "recorded that this was shared" event, and all UI (Phase 21).

### Phase 21 — Modern UI/UX overhaul in `web/`

- Meet `CLAUDE.md`'s Linear / Mercury / Ramp / Raycast-level craft standard. Evolve the existing
  ADR-0042/0043 frontend/design system with dense readable lists, accessible tokens and aligned
  amounts, zero-clutter evidence inspectors and refined micro-interactions.
- Deliver `Cmd+K`/`Ctrl+K`, discoverable triage shortcuts, predictable focus, interactive
  item/beneficiary splitters with immediate net-cost previews, and an account-level visual
  waterfall from statement opening balance through credits/debits to closing balance/delta.
- Integrate context re-attachment, item refund attribution, ghost-debt findings and proof-pack
  preview. Every financial number drills into its evidence/decision; calculations come from
  the domain engine. Never show a verified zero for incomplete statements or unknown movements.
- Exit criteria: all six pillars are reachable through coherent end-to-end flows; responsive,
  keyboard, reduced-motion, loading/error/empty and accessibility behavior are browser-tested
  with synthetic data. Cover the review/evidence/receipt flows and frontend CI gaps inherited
  from Phase 15. Financial UI assertions agree with domain results.

### Later work without assigned phase numbers

Rules/learning (manual rules first, AI proposals later), broader analytics and the
natural-language interface remain deferred after Phase 21. No auto-approval may be inferred
from confidence while rule creation/application is unimplemented. Concrete external adapters
and stale Splitwise re-sync remain explicit integration work; acceptance of an audit or proof
pack does not implicitly authorize outbound writes.

## Open questions carried forward from the 2026-08 revision

Documented explicitly so they aren't rediscovered as bugs later — none block starting Phase 6:

- **The original inflow exclusion is superseded for pragmatic cash reconciliation** by
  [ADR-0017 (cash balance)](decisions/0017-pragmatic-cash-balance-reconciliation.md).
  Phase 16 adds classification and evidence-backed account snapshots while preserving
  ADR-0016's outflow identity. General budgeting/tax logic remains outside the core; this is
  now scheduled work, not an unspecified future income-accounting phase.
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
