# src/services

Orchestrates `src/domain` logic with `src/db` persistence. This is the **only** layer allowed
to write APPROVED-classified data (`docs/domain/domain-model.md`), and where the "every
mutation writes an AuditEvent" rule (`docs/domain/invariants.md` #21) and the AI
accept/modify/reject transition (`docs/architecture/ai-boundary.md`) are enforced.

**Owns:** import orchestration, classification orchestration (including the expense-vs-
settlement `proposedKind` disambiguation, ADR-0007), review-queue logic, allocation approval
(including group-line expansion into `AllocationLineGroupExpansion`, ADR-0009), settlement
recording (`recordSettlement`, never producing an `Allocation`, ADR-0007), expense-adjustment
recording and distribution (`recordExpenseAdjustment` / `distributeAdjustment`, ADR-0008),
reconciliation orchestration, `decideInference()` (the sole path from an `AIInference` to
authoritative state).

**Depends on:** `src/domain`, `src/db`. Calls into `src/ai` and `src/integrations` but never
lets their output write authoritative state directly — see `docs/architecture/data-flow.md`.

**Partly implemented.** Landed in the deterministic-foundation phase, plus transaction
import (phase 6):

- `audit.ts` — `runAudited()`, which opens the transaction, hands the body the only executor in
  scope, and **refuses to commit a mutation that recorded no `AuditEvent`**. This is the
  structural half of invariant #21: forgetting the audit event fails the operation rather than
  quietly producing unaudited financial state.
- `expense-service.ts` — gated lifecycle transitions, including the corrected `READY_TO_SYNC`
  gate that keeps a `gift` out; and `assertAmountChangeAllowed`, which exists so that a caller
  attempting to change an approved amount gets pointed at `ExpenseAdjustment` rather than
  finding a missing function and adding one.
- `expense-item-service.ts` — `recordExpenseItems`/`getExpenseItems` (phase 12). Writes an
  expense's complete item breakdown once — `domain.validateExpenseItemsSum` refuses a partial
  one — optionally linking each item back to the `ReceiptItem` it derives from. Also the manual
  (no-AI) item-entry path phase 11 deferred here: the caller supplies final numbers directly.
- `allocation-service.ts` — `approveAllocation`, including group-line expansion.
- `settlement-service.ts` — `recordSettlement`. Imports nothing that could create an
  `Allocation` (invariant #9a).
- `adjustment-service.ts` — `recordExpenseAdjustment` and `distributeAdjustment`.
- `balance-service.ts` — `getBalance` and `runReconciliation`, both read-then-compute.
- `import-service.ts` — `importBankStatementCsv`: parse, then `ImportBatch` + immutable
  `Payment` rows, with deterministic duplicate handling at both the file and the row level
  (ADR-0019). Classifies nothing.
- `normalization-service.ts` — `normalizePayments`: refines `channel` from `reference_type`
  (ADR-0020), resolves a catalogued merchant by exact alias-key match, and moves payments
  `imported → normalized` in one audited transaction. Acts **only** on `imported` payments, so a
  re-run is a no-op rather than a silent rewrite (ADR-0021) — which is also why it reads
  eligibility _before_ opening the transaction, since `runAudited` rolls back a unit of work that
  records no event. Deterministic leg only: no `ai.normalizeMerchant()` call and no `AIInference`
  row (ADR-0022). Classifies nothing.

- `classification-service.ts` — `classifyPayment` / `classifyPayments`: the deterministic
  self-transfer leg first (ADR-0023), then `ai.classifyTransaction` for what it cannot settle,
  then the semantic gate, the pending `AIInference`, and the DERIVED `Expense` walked
  `proposed → classified → (review_required)`. Each payment is its own audited transaction, so
  one nonsensical answer does not roll back the payments classified beside it. Approves
  nothing, at any confidence.
- `inference-decision-service.ts` — `decideInference`: the only path by which an `AIInference`
  leaves `pending`. Parses the actor first (a person or a `Rule`, never the model, never
  `system`), re-validates the proposal through the same parser a modified one passes, and
  produces either an approved `Expense` with its `PaymentExpenseLink` or a `Settlement` — never
  both, in one transaction.

- `review-service.ts` — `listReviewQueue`: everything waiting for a human, in the order it
  should be looked at. A read; it holds no ranking of its own (`domain.prioritiseReviewQueue`)
  and no reasons of its own (`domain.routeClassificationForReview`), so the queue cannot
  disagree with the states it describes. A stored proposal that no longer parses is surfaced as
  `malformed_proposal` rather than thrown — one unreadable row must not take the queue down.
- `review-action-service.ts` — the three review actions that are not a `decideInference` call:
  `reclassifyPayment` (supersede an undecided proposal and ask again — the only thing that lifts
  phase 8's "a re-run is a no-op" rule, ADR-0030), `confirmPossibleDuplicate` and
  `dismissPossibleDuplicate` (ADR-0031). All three require an attributable human actor.

- `evidence-service.ts` — `ingestEvidenceDocument`, `recordManualNote`, `linkEvidence`,
  `readEvidenceDocument`: the other half of the pipeline, arriving before, during or after
  classification. Documents go to an injected `EvidenceStore` (ADR-0033) and the row points at
  them by content address; re-ingesting the same bytes against the same links resolves to the
  row that already holds them. Linkage may be filled in once, never rewritten (ADR-0034).

- `receipt-service.ts` — `extractReceipt`: redact, ask both `ai.parseReceipt`/
  `extractReceiptItems`, validate (`domain.assertReceiptDraftInformative`), write `Receipt` +
  `ReceiptItem`s directly — no `decideInference`-shaped gate, because `Receipt` is DERIVED, not
  APPROVED-classified (ADR-0036). `confirmReceipt`/`correctReceipt` are the human side: a
  boolean flip or a field/item overwrite, each moving only the inferences still `pending`.
  `getReceipt`/`getReceiptViewByEvidenceId` compute the two surfaced discrepancies (item sum vs
  `subtotal`, `total` vs a linked payment's amount) and any deterministic candidate payment
  match (`domain.findCandidatePaymentMatches`, ADR-0037) fresh on every read — never stored.

Not yet implemented: Splitwise sync orchestration — see `docs/roadmap.md` phase 14.
