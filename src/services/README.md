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
- `cash-flow-service.ts` — the ADR-0017 (cash balance) classification lifecycle.
- `balance-service.ts` — `getBalance` and `runReconciliation`, both read-then-compute.
- `expense-ledger-service.ts` — `listExpenses` (phase 13). A thin pass-through over
  `db.listExpenses`, which does the filtering and the batched `domain.netAmount` computation
  itself (mirroring `loadReconciliationInput`'s split for the same figure) — kept here only so
  `src/api` depends on `src/services`, never `src/db`, directly.
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

- `splitwise-service.ts` — `connectSplitwiseIntegration` (not run through `runAudited`;
  `ExternalIntegration` is SYSTEM-classified, not APPROVED/DERIVED, ADR-0040),
  `syncExpenseToSplitwise`/`syncSettlementToSplitwise` (phase 14). Both build the payload and
  call the injected `SplitwisePort` in one call — no separate propose/confirm pair, since no AI
  proposal sits on this path. A `SplitwiseExpense`/`SplitwiseSettlement` row is only ever
  written once the port already returned an external id, so a failed sync leaves nothing behind
  and a retry is calling the same function again. Group-line resolution comes from
  `loaders.resolveAllocationShares`, shared with `expense-service.ts`'s `assertReadyToSync`
  rather than re-implemented.

- `balance-service.ts` — `getBalance` (unchanged since phase 13) and `runReconciliation`
  (phase 15, ADR-0041): stores the outflow-only `ReconciliationRun` snapshot exactly as before,
  and now also, when a Splitwise `ExternalIntegration` is connected, compares this ledger's own
  `NetBalance` against `splitwise.fetchBalances()` for every linked person via the pure
  `domain.compareSplitwiseBalance`, records any disagreement as a `ReconciliationDiscrepancy`,
  and marks every affected `synced` `SplitwiseExpense`/`SplitwiseSettlement` `drifted` — its
  first writer. A `fetchBalances()` call that itself fails doesn't fail the run: it's recorded
  as a `splitwise_fetch_failed` discrepancy instead, since the ledger's own totals don't depend
  on Splitwise being reachable. `listReconciliationRunHistory`/`getReconciliationRun` are new,
  thin reads over `db.listReconciliationRuns`/`getReconciliationRunById`.

- `people-service.ts` — `listPeople` (phase 15): everyone not archived, each flagged with
  whether they're the ledger's user. `db.listPeople`/`getPrimaryUserPerson`'s first
  `src/api` caller — no phase before 15 had a UI needing a name to render.

- `cash-flow-service.ts` — `markPaymentCashFlowNormalized`, `classifyPaymentCashFlow`,
  `approvePaymentCashFlow`, `rejectPaymentCashFlow` (phase 16, ADR-0017 (cash balance)). The
  cash-flow _interpretation_ lifecycle, which runs alongside `Payment.state` and never touches
  it: a `linked` payment is not thereby cash-flow approved, and an approved transfer is still
  `normalized` in the legacy lifecycle. Classification writes a **proposal** — only the
  absolute direction rule applies, since ADR-0017 allows an unresolved counterparty during
  normalization — and approval is where the evidence gates bite, counted from the ledger's own
  rows (settlements, adjustments, attached evidence, account ownership) rather than supplied by
  the caller. Rejection clears the category; reclassifying an approved payment drops the
  approval, because a correction is an audited new decision rather than an edit. `'system'` is
  deliberately not a valid approver.

- `adjustment-service.ts` (phase 16 extension, ADR-0018 (item refunds)) —
  `recordExpenseAdjustment` now optionally takes `itemAttributions`, the complete set of
  `ExpenseAdjustmentItem` rows saying **which items** the refund gave money back for. The set
  is validated through `domain.validateRefundAttribution` _before_ the adjustment row exists,
  so a rejected attribution leaves no adjustment behind — the item refund and the financial
  event it attributes are one decision. `db.lockExpenseForAdjustment` takes a row lock on the
  parent expense first, which is what stops two concurrent refunds each finding room under the
  same remaining ceiling (19.3). Omitting `itemAttributions` is the legacy whole-expense path
  from ADR-0008, unchanged.

- `adjustment-service.ts` (phase 18, ADR-0018 (item refunds) / ADR-0045) —
  `distributeAdjustment` now picks its arithmetic from what the ledger recorded. With no
  attribution anywhere on the expense it is ADR-0008's whole-expense proportional distribution,
  unchanged; with any attribution it calls `domain.buildItemAwareAllocationLines`, which puts
  each item's net cost on that item's **own** beneficiaries and then applies any unattributed
  whole-expense reduction once, afterwards, over the item-derived lines. The lines are rebuilt
  from recorded facts each time rather than decremented, which is what makes the outcome
  independent of refund order and of how often distribution ran; a second call with nothing new
  recorded is refused (`PRECONDITION_FAILED`) rather than rewriting the same numbers, and the
  same row lock `recordExpenseAdjustment` takes is held throughout. An allocation that cannot
  say who owned a refunded item raises `REFUND_ITEM_OWNERSHIP_REQUIRED` — the whole-basket
  default is never the fallback. `getRefundAllocationState` is the read beside it: gross beside
  net per item, the two reductions kept apart, the lines a distribution would write, and
  `reviewRequired` when it could not. Custom weights describe the unattributed reduction only,
  and are refused outright when the whole reduction is item-attributed.

- `balance-service.ts` (phase 16 extension, ADR-0017 (cash balance)) — `runReconciliation` now
  also writes one immutable `ReconciliationAccountSnapshot` per account per run, carrying the
  **second**, independent identity: `opening + credits - debits` against the statement's actual
  closing balance. ADR-0016's totals, fields and callers are untouched, and neither number is
  derived from the other. Transfer legs are paired across every account _before_ any account is
  computed, because a leg's counter-leg lives on a different account; a leg left over is
  reported as an `unpaired_internal_transfer` rather than given an invented partner. Evidenced
  statement boundaries arrive as an optional `accountBoundaries` input — nothing ingests
  statement _balances_ yet — so a run given none produces honestly `incomplete` snapshots
  instead of a cosmetic zero.

- `evidence-enrichment-service.ts` (phase 17, ADR-0044) — context re-attachment.
  `recordEvidenceNotification` stores a bank SMS or UPI push notification with its text
  verbatim plus one DERIVED `EvidenceObservation`, deduplicated on a deterministic key so a
  forwarded notification is one record. `recordEvidenceObservation` replaces that reading when
  a person corrects it, and writes nothing when the correction says what is already recorded.
  `matchEvidenceContext` pre-filters payments in `db` (a date window, plus anything sharing the
  reference regardless of date) and hands them to `domain.matchEvidenceToPayments`, then
  **upserts candidates only where something changed** — the whole write plan is computed before
  the transaction opens, so a re-run over an unchanged ledger returns `unchanged` having
  written no row, no `updated_at` and no audit event. `decideEvidenceMatch` is the only path
  from a candidate to a link, and it goes through phase 10's own
  `domain.assertEvidenceLinkOnce` and `applyEvidenceLink` rather than a second write path to
  the column ADR-0034 governs; accepting also supersedes the candidate's siblings, and a
  candidate a person has decided is never rewritten by a later run. `getPaymentContext` is a
  read: `domain.deriveReattachedContext` over the payment and every evidence record linked to
  it, narration verbatim and disagreements reported rather than resolved.

  Two things this service deliberately cannot do: change a financial number (no amount, no
  `raw_description`), and approve a cash-flow interpretation (no `cash_flow_category`, no
  `cash_flow_state` — matching a refund notification to a credit explains it to a human, it
  does not classify it).

- `classification-service.ts` (phase 17 extension) — `buildClassificationContext` now also
  loads whatever evidence is attached to the payment and derives the re-attached context from
  it, so a decayed UPI narration reaches the model with the merchant a linked notification
  named. Only the merchant _names_ travel; `ai.redactPaymentForInference` takes those and
  nothing else off the context, and fails closed if anything identifying is still in the
  payload (`security-model.md`).

Not yet implemented: re-sync of a `stale` `SplitwiseExpense`/`SplitwiseSettlement`, and
resolving a `ReconciliationDiscrepancy` — see `docs/roadmap.md` phase 15's implementation note.
