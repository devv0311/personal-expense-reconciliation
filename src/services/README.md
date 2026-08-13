# src/services

Orchestrates `src/domain` logic with `src/db` persistence. This is the **only** layer allowed
to write APPROVED-classified data (`docs/domain/domain-model.md`), and where the "every
mutation writes an AuditEvent" rule (`docs/domain/invariants.md` #21) and the AI
accept/modify/reject transition (`docs/architecture/ai-boundary.md`) are enforced.

**Owns:** import orchestration, classification orchestration, review-queue logic, allocation
approval, settlement/reconciliation orchestration, `decideInference()` (the sole path from an
`AIInference` to authoritative state).

**Depends on:** `src/domain`, `src/db`. Calls into `src/ai` and `src/integrations` but never
lets their output write authoritative state directly — see `docs/architecture/data-flow.md`.

Not yet implemented — see `docs/roadmap.md`.
