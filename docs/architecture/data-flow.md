# Data Flow

How data actually moves through the layers in `docs/architecture/system-architecture.md`, for
the full pipeline from `docs/domain/domain-model.md`:

```
PAYMENT → PURPOSE → EVIDENCE → EXPENSE → BENEFICIARIES → ALLOCATION → SETTLEMENT → RECONCILIATION
```

> **Revision note (2026-08).** Steps 3, 6, 8, and 9 changed to account for `Settlement` (ADR-0007),
> `ExpenseAdjustment` (ADR-0008), group-allocation expansion (ADR-0009), and the
> `external_reference` dedup fields (ADR-0010). See `docs/domain/domain-model.md`'s revision note.
>
> **Further revision note (2026-08, implementation-readiness pass).** Step 6a's rounding
> reference is now the finalized Largest Remainder Method (ADR-0012) with the resolved
> net-zero/deletion behavior (ADR-0013); step 7 gained `obligationEvidenceStatus` (ADR-0014).

## 1. Import

`api` receives a file/export (or a manual entry) → `services.importPayments()` → parses via a
source-specific adapter in `db`/`integrations` → writes `ImportBatch` + `Payment` rows
(SOURCE data, `src/db`) → no AI call yet.

```
api ─▶ services.importPayments ─▶ db.createImportBatch / db.createPayments
```

## 2. Normalization

`services.normalizePayments()` resolves `channel`/`counterparty` deterministically where
possible (e.g. exact merchant string match against known `Merchant.aliases`), and also extracts
`external_reference`/`reference_type`/`source_system` where the source format provides them
(structured fields) or where they can be reliably parsed out of `raw_description` (ADR-0010).
Where counterparty resolution is not deterministic, calls `ai.normalizeMerchant()`, which
returns an `AIInference` (`inference_type = normalize_merchant`) — a proposal, not a write.

```
services.normalizePayments ─▶ db (deterministic match + reference extraction) ──┐
                            └─▶ ai.normalizeMerchant ─▶ AIInference (pending) ─▶ db (stored, unapplied)
```

> **As of phase 7 (2026-08-19), only the deterministic leg exists.** `services.normalizePayments`
> refines `channel` from `reference_type` (ADR-0020) and resolves a merchant by exact match on a
> canonical alias key, then stops. **The `ai.normalizeMerchant()` leg is not built** — `src/ai/`
> holds only a `README.md`, and `ai_inferences` has no writer, so the table stays empty until
> phase 8 (ADR-0022). A counterparty the deterministic leg cannot resolve ends at
> `state = normalized`, `counterparty_type = unknown`, with **no `AIInference` row** — a recorded
> outcome, not a gap. The two-leg description above is the target state and is deliberately kept.
>
> Reference extraction moved earlier than this diagram shows: `external_reference`,
> `reference_type`, and `source_system` are populated by the adapter **at import** (phase 6,
> ADR-0010), not during normalization. Normalization reads `reference_type`; it does not derive
> it.

## 3. Classification

`services.classifyPayment()` calls `ai.classifyTransaction()`, which returns a proposed
`proposedKind` (`expense` or `settlement` — ADR-0007), and, for `expense`, a proposed
`relationship_type`/`category`/`paidByPersonHint`/confidence as an `AIInference`. The service
layer applies review-queue rules (confidence threshold, amount threshold, ambiguous-beneficiary
or ambiguous-kind check) to decide whether this can auto-progress toward `APPROVED` (still via
an explicit `accepted` transition, per invariant #16) or must sit in `REVIEW_REQUIRED`. Accepting
the inference produces **either** an `Expense` **or** a `Settlement` — the two paths diverge
here and never re-converge (a `Settlement` never becomes an `Expense` later, and vice versa).

```
services.classifyPayment ─▶ ai.classifyTransaction ─▶ AIInference (pending, proposedKind: expense | settlement)
                          ─▶ services.evaluateForReview ─┬─▶ Expense.state = CLASSIFIED | REVIEW_REQUIRED
                                                          └─▶ (settlement path) Settlement review queue
```

> **As of phase 8 (2026-08-19), this step is built.** Two things it turned out to need, both
> recorded as decisions rather than left implicit:
>
> - **A deterministic leg runs first.** A payment paired with an opposite-direction leg sharing
>   one reference, amount and instant is a transfer between the user's own accounts. That is
>   arithmetic over two rows, not semantics, so it is `domain.isSelfTransferPair` and it writes
>   `counterparty_type = internal_account` with **no `AIInference` at all** (ADR-0023).
>   `proposedKind` keeps its two members; there is no `transfer` to propose.
> - **Only debits reach the model.** A credit is never new spend, and V1 does not classify
>   inflow (ADR-0015); the fixture's refund credit ends the phase `normalized`, merchant
>   resolved, with the outcome `skipped: credit_out_of_scope` recorded (ADR-0027). A credit
>   still goes through the deterministic leg, because a transfer needs both its legs.
>
> `services.evaluateForReview` in the diagram is `domain.routeClassificationForReview` plus the
> `Expense` writes in `services.classifyPayment` — the routing rule is pure and lives in
> `domain`, since it decides nothing but where a validated proposal stops (ADR-0024). The
> expense path writes a DERIVED `Expense` (`proposed → classified → review_required`, each
> transition asserted and audited); the settlement path writes **nothing** until the proposal is
> accepted, because a `Settlement` has no pre-approval state to sit in (ADR-0026).

## 4. Evidence

Independently of the above, `Evidence` (receipts, screenshots, manual notes) can arrive before,
during, or after classification. `ai.parseReceipt()` / `ai.extractReceiptItems()` turn
receipt-type `Evidence` into a `Receipt` + `ReceiptItem`s (DERIVED, per `domain-model.md`),
again as inferences requiring confirmation before they're treated as settled. For an
**externally-funded** expense (`paid_by_person_id` != the user, ADR-0006), `Evidence` is the
_only_ source that will ever exist — there is no `Payment` to eventually match against.

```
api ─▶ services.ingestEvidenceDocument ─▶ integrations/evidence-store.put ─▶ db.insertEvidence
       services.recordManualNote                                          ─▶ db.insertEvidence
       services.linkEvidence          ─▶ domain.assertEvidenceLinkOnce    ─▶ db.updateEvidenceLinks
```

> **Ingestion landed in phase 10 (2026-08-22); extraction is phase 11.** What ingestion does:
> stores the bytes at a content address, records the row, and audits it. What it deliberately
> does not do: call a model, read an amount, identify a merchant, or match the document to a
> payment. A document that arrives with nothing known about it is stored unlinked and surfaces in
> the review queue as `unmatched_evidence` (ADR-0035), where a human attaches it — the matching a
> total would make deterministic is exactly what phase 11 unlocks.
>
> Re-ingesting the same bytes against the same links returns the row that already holds them
> rather than a second one. Evidence carries no money, so this is not `invariants.md` #10; it is
> so that one receipt shared twice is one thing for a person to look at.

## 5. Human review

`api` surfaces `Expense`s in `REVIEW_REQUIRED` (and any pending `AIInference`s attached to
them). The user accepts, modifies, or rejects. This is the only path (besides a matched `Rule`,
which is itself an approved act) by which an `AIInference.status` leaves `pending` and by which
`Expense.state` reaches `APPROVED`.

```
api (review UI) ─▶ services.decideInference(accept|modify|reject) ─▶ db.updateExpense (APPROVED)
                                                                   ─▶ db.insertAuditEvent
```

> **`services.decideInference` exists as of phase 8**, and is the only path by which an
> `AIInference` leaves `pending`. What it does beyond the diagram: it parses the actor first
> (a person or a `Rule`, never the model and never `system` — `invariants.md` #17), re-validates
> the stored proposal through the same `ai.parseTransactionClassification` a modified one goes
> through, and then produces **either** an approved `Expense` with its `PaymentExpenseLink` and
> the payment moving `normalized → linked`, **or** a `Settlement` with the payment's
> counterparty resolved to that person. A `modify` may change the `proposedKind` — that is what
> the review queue's settlement-vs-expense disambiguation _is_. A `reject` produces nothing and
> deletes nothing.
>
> **The review queue itself landed in phase 9 (2026-08-20).** `services.listReviewQueue` answers
> "what is waiting for a human?" over three kinds of item — pending classification proposals
> (including settlement ones, which have no `Expense` to show beside them), possible-duplicate
> payment pairs, and payments left unexplained by a rejection. It is a read: the order comes from
> `domain.prioritiseReviewQueue` and the reasons from `domain.routeClassificationForReview`, so
> the queue cannot disagree with the states it describes (ADR-0029).
>
> Three review actions sit beside `decideInference`, and none of them bypasses it:
>
> - `services.reclassifyPayment` — supersedes an undecided proposal and asks the model again, in
>   one transaction. The only thing that lifts phase 8's "a re-run is a no-op" rule (ADR-0030).
> - `services.confirmPossibleDuplicate` — moves the copy to `ignored` with
>   `duplicate_of:<canonical>`, after re-checking the pair against `domain.isPossibleDuplicate`.
> - `services.dismissPossibleDuplicate` — records "these two are different" as an `AuditEvent`,
>   changing neither payment (ADR-0031).
>
> Rejecting a proposal now also closes out the DERIVED `Expense` it created, to `rejected`
> (ADR-0028 — the disposition ADR-0026 deferred to this phase).
>
> ```
> api  GET  /api/review                                    ─▶ services.listReviewQueue
>      POST /api/review/inferences/:id/decision            ─▶ services.decideInference
>      POST /api/review/payments/:id/reclassify            ─▶ services.reclassifyPayment
>      POST /api/review/payments/:id/duplicate             ─▶ services.confirm|dismissPossibleDuplicate
> ```
>
> The handlers are Web `Request → Response` functions — a Next.js route handler's exact
> signature — with no framework installed before any UI exists (ADR-0032). Phase 10 added five
> more under `/api/evidence` (step 4 above) to the same table and the same dispatcher.

## 6. Allocation

`services.proposeAllocation()` may call `ai.suggestBeneficiaries()` /
`ai.suggestAllocation()` for a default split proposal; the user confirms or adjusts;
`services.approveAllocation()` validates the sum-check invariant (#11, against
`domain.netAmount(expense)`, not gross `amount` — ADR-0008) in `domain` before writing
`Allocation` + `AllocationLine`s and an `AuditEvent`. **For any `group`-typed line, this same
call also resolves `GroupMembership` as of `Expense.occurred_at` and writes the
`AllocationLineGroupExpansion` rows (ADR-0009)** — this is a deterministic resolution, not an AI
step; there is no inference to accept here.

```
services.proposeAllocation ─▶ ai.suggestAllocation ─▶ AIInference (pending)
services.approveAllocation ─▶ domain.validateAllocationSums ─▶ db.insertAllocation
                                                              ─▶ db.insertAllocationLines
                                                              ─▶ db.insertAllocationLineGroupExpansions (group lines only)
                                                              ─▶ db.insertAuditEvent
```

## 6a. Refund / reimbursement (new, ADR-0008)

Independently of the original allocation, `services.recordExpenseAdjustment()` records an
`ExpenseAdjustment` (`kind = merchant_refund | third_party_reimbursement`) against an existing,
already-`APPROVED` `Expense` — either from a matched credit `Payment` (an `AIInference` may
propose the match) or entered manually. This alone does not change the expense's current
`Allocation`. A separate, explicit step, `services.distributeAdjustment()`, creates the
superseding `Allocation` version summing to the new `domain.netAmount(expense)`, using the
Largest Remainder Method (`invariants.md` #12) against whatever weight set the user's
distribution decision implies — proportional-to-existing-share by default, never a silent
assumption (§12). When `netAmount` reaches exactly 0, the resulting `Allocation` still has one
zero-amount line per original beneficiary, never an empty line set (`invariants.md` #12a,
ADR-0013). If the expense had already reached `SYNCED`, this step also flips the existing
`SplitwiseExpense.sync_status` to `stale` — and, specifically when the new `netAmount` is 0, the
fresh sync proposal `stale` implies is a **deletion** of the Splitwise expense, not a $0-amount
update (`domain-model.md`'s "Splitwise implications of a net-zero adjustment").

```
services.recordExpenseAdjustment ─▶ db.insertExpenseAdjustment ─▶ db.insertAuditEvent
services.distributeAdjustment    ─▶ domain.validateAllocationSums (against new netAmount)
                                  ─▶ db.insertAllocation (supersedes previous)
                                  ─▶ db.insertAuditEvent
                                  ─▶ db.updateSplitwiseExpense (sync_status = stale, if applicable)
```

## 7. Settlement (discharge, not creation)

`Balance` is never written directly — `services.getBalance(personA, personB)` calls
`domain.computeBalance()`, a pure function over `AllocationLine`s (and, for group beneficiaries,
`AllocationLineGroupExpansion`s — ADR-0009) and `Settlement`-linked `Payment`s, on every read.
No caching layer sits in front of this until/unless performance requires it (not expected at
personal-project scale). When `NetBalance > 0`, `services.getBalance()` also computes
`domain.obligationEvidenceStatus(personA, personB)` (ADR-0014) alongside it — another pure,
read-only function over `Evidence`/`ReconciliationRun` data, never a separate write path.
Recording a settlement is a separate, explicit act:
`services.recordSettlement()` validates the linked `Payment` isn't already fully explained
(shares the payment-explanation budget with `PaymentExpenseLink`, per the revised invariant) and
writes the `Settlement` + `AuditEvent` — no `Allocation` is ever created (invariant #9a).

```
services.getBalance        ─▶ domain.computeBalance (pure, reads AllocationLine/AllocationLineGroupExpansion + Settlement)
services.recordSettlement  ─▶ domain.validatePaymentExplanationBudget ─▶ db.insertSettlement ─▶ db.insertAuditEvent
```

## 8. Sync (Splitwise)

`services.proposeSplitwiseSync()` builds the proposal from an `APPROVED`+`ALLOCATED` `Expense`
**or** an `APPROVED` `Settlement`; user confirms; `integrations/splitwise.createExpense()` or
`integrations/splitwise.recordPayment()` performs the actual external write; result recorded as
`SplitwiseExpense` or `SplitwiseSettlement` respectively. No AI call is on this path at all — by
the time an expense or settlement is ready to sync, every field involved is already APPROVED
data. **For an `Expense` with any `group`-typed `AllocationLine`, the proposal is always built
from that line's `AllocationLineGroupExpansion` rows, never the raw group line** — Splitwise's
API has no concept of a group debtor (invariant #19, ADR-0009).

```
services.proposeSplitwiseSync (expense)    ─▶ (user confirmation, api) ─▶ integrations.splitwise.createExpense
                                                                          ─▶ db.insertSplitwiseExpense
services.proposeSplitwiseSync (settlement) ─▶ (user confirmation, api) ─▶ integrations.splitwise.recordPayment
                                                                          ─▶ db.insertSplitwiseSettlement
```

## 9. Reconciliation

`services.runReconciliation(period)` calls `domain.computeUnexplained()` (pure arithmetic over
`Payment`/`Expense`/`Allocation`/`ExpenseAdjustment`/`Settlement`) and
`integrations.splitwise.fetchBalances()` (external read), compares, and writes one
`ReconciliationRun`. `domain.computeUnexplained()` now separately tallies
`ledger_transfers_total`, `ledger_investments_total` (ADR-0011), and `ledger_settlements_total`
(ADR-0007), and sums `domain.netAmount(expense)` per expense — not gross `Expense.amount` — into
`ledger_explained_total` (ADR-0008), per the revised invariant #20.

```
services.runReconciliation ─▶ domain.computeUnexplained ─┐
                            ─▶ integrations.splitwise.fetchBalances ─┤
                                                                     ▼
                                                          db.insertReconciliationRun
```

## Where the AI boundary sits

Every arrow leaving `ai/` in the diagrams above lands on an `AIInference` row, never directly
on an APPROVED-classified field. Every arrow into `db` that touches an APPROVED-classified
field originates in `services`, after either an explicit user decision or a matched `Rule` — this
now includes `Settlement`, `ExpenseAdjustment`, and `AllocationLineGroupExpansion` writes, none
of which have any AI-authored path into `db` either. See `docs/architecture/ai-boundary.md` for
the enforcement mechanism, and `docs/domain/invariants.md` #15–17, #21 for the invariants this
preserves.
