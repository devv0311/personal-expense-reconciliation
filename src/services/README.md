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

Not yet implemented — see `docs/roadmap.md`.
