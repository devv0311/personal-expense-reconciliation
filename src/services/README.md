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

Not yet implemented: classification, review-queue, `decideInference`, and Splitwise sync
orchestration — see `docs/roadmap.md` phases 8–11 and 14.
