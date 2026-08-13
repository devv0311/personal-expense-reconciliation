# Data Flow

How data actually moves through the layers in `docs/architecture/system-architecture.md`, for
the full pipeline from `docs/domain/domain-model.md`:

```
PAYMENT → PURPOSE → EVIDENCE → EXPENSE → BENEFICIARIES → ALLOCATION → SETTLEMENT → RECONCILIATION
```

## 1. Import

`api` receives a file/export (or a manual entry) → `services.importPayments()` → parses via a
source-specific adapter in `db`/`integrations` → writes `ImportBatch` + `Payment` rows
(SOURCE data, `src/db`) → no AI call yet.

```
api ─▶ services.importPayments ─▶ db.createImportBatch / db.createPayments
```

## 2. Normalization

`services.normalizePayments()` resolves `channel`/`counterparty` deterministically where
possible (e.g. exact merchant string match against known `Merchant.aliases`); where not
deterministic, calls `ai.normalizeMerchant()`, which returns an `AIInference`
(`inference_type = normalize_merchant`) — a proposal, not a write.

```
services.normalizePayments ─▶ db (deterministic match) ──────────┐
                            └─▶ ai.normalizeMerchant ─▶ AIInference (pending) ─▶ db (stored, unapplied)
```

## 3. Classification

`services.classifyPayment()` calls `ai.classifyTransaction()`, which returns a proposed
`relationship_type`/`category`/confidence as an `AIInference`. The service layer applies
review-queue rules (confidence threshold, amount threshold, ambiguous-beneficiary check) to
decide whether this can auto-progress toward `APPROVED` (still via an explicit `accepted`
transition, per invariant #16) or must sit in `REVIEW_REQUIRED`.

```
services.classifyPayment ─▶ ai.classifyTransaction ─▶ AIInference (pending)
                          ─▶ services.evaluateForReview ─▶ Expense.state = CLASSIFIED | REVIEW_REQUIRED
```

## 4. Evidence

Independently of the above, `Evidence` (receipts, screenshots, manual notes) can arrive before,
during, or after classification. `ai.parseReceipt()` / `ai.extractReceiptItems()` turn
receipt-type `Evidence` into a `Receipt` + `ReceiptItem`s (DERIVED, per `domain-model.md`),
again as inferences requiring confirmation before they're treated as settled.

## 5. Human review

`api` surfaces `Expense`s in `REVIEW_REQUIRED` (and any pending `AIInference`s attached to
them). The user accepts, modifies, or rejects. This is the only path (besides a matched `Rule`,
which is itself an approved act) by which an `AIInference.status` leaves `pending` and by which
`Expense.state` reaches `APPROVED`.

```
api (review UI) ─▶ services.decideInference(accept|modify|reject) ─▶ db.updateExpense (APPROVED)
                                                                   ─▶ db.insertAuditEvent
```

## 6. Allocation

`services.proposeAllocation()` may call `ai.suggestBeneficiaries()` /
`ai.suggestAllocation()` for a default split proposal; the user confirms or adjusts;
`services.approveAllocation()` validates the sum-check invariant (#11) in `domain` before
writing `Allocation` + `AllocationLine`s and an `AuditEvent`.

```
services.proposeAllocation ─▶ ai.suggestAllocation ─▶ AIInference (pending)
services.approveAllocation ─▶ domain.validateAllocationSums ─▶ db.insertAllocation ─▶ db.insertAuditEvent
```

## 7. Settlement

`Balance` is never written directly — `services.getBalance(person|group)` calls
`domain.computeBalance()`, a pure function over `AllocationLine`s and settlement-classified
`Payment`s, on every read. No caching layer sits in front of this until/unless performance
requires it (not expected at personal-project scale).

## 8. Sync (Splitwise)

`services.proposeSplitwiseSync()` builds the proposal from an `APPROVED`+`ALLOCATED` `Expense`;
user confirms; `integrations/splitwise.createExpense()` performs the actual external write;
result recorded as `SplitwiseExpense`. No AI call is on this path at all — by the time an
expense is ready to sync, every field involved is already APPROVED data.

```
services.proposeSplitwiseSync ─▶ (user confirmation, api) ─▶ integrations.splitwise.createExpense
                                                             ─▶ db.insertSplitwiseExpense
```

## 9. Reconciliation

`services.runReconciliation(period)` calls `domain.computeUnexplained()` (pure arithmetic over
`Payment`/`Expense`/`Allocation`) and `integrations.splitwise.fetchBalances()` (external read),
compares, and writes one `ReconciliationRun`.

```
services.runReconciliation ─▶ domain.computeUnexplained ─┐
                            ─▶ integrations.splitwise.fetchBalances ─┤
                                                                     ▼
                                                          db.insertReconciliationRun
```

## Where the AI boundary sits

Every arrow leaving `ai/` in the diagrams above lands on an `AIInference` row, never directly
on an APPROVED-classified field. Every arrow into `db` that touches an APPROVED-classified
field originates in `services`, after either an explicit user decision or a matched `Rule`.
See `docs/architecture/ai-boundary.md` for the enforcement mechanism, and
`docs/domain/invariants.md` #15–17 for the invariants this preserves.
