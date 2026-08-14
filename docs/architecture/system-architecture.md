# System Architecture

Written after the domain model (`docs/domain/`), per the roadmap order — the domain model
drove these choices, not the reverse. This is a personal project: the guiding constraint
throughout is **simplicity and low operational complexity** without compromising the financial
correctness invariants in `docs/domain/invariants.md`.

> **Revision note (2026-08).** No stack or layering decision changed in the 2026-08 architecture
> review — the corrections (ADRs 0006–0011) were entity-model and invariant fixes, not
> infrastructure ones. `src/domain` gains a few new pure functions (`netAmount`, a generalized
> pairwise `computeBalance`, group-membership resolution for allocation expansion); `src/services`
> gains a few new orchestration entry points (`recordSettlement`, `recordExpenseAdjustment`,
> `distributeAdjustment`). Both stay inside their existing layer boundaries below — nothing moved
> layers. See `docs/domain/domain-model.md`'s revision note for the full context.
>
> **Further revision note (2026-08, implementation-readiness pass).** `domain` gains
> `splitByLargestRemainder` (ADR-0012) and `obligationEvidenceStatus` (ADR-0014) — both pure
> functions, no new layer boundaries.

## Stack decision

| Concern                 | Choice                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                | TypeScript (strict) everywhere                                                                                    | One language across domain logic, API, and eventual UI; strong types are load-bearing for financial code (see `CLAUDE.md`).                                                                                                                                                                                                                                                                 |
| Runtime                 | Node.js 20+                                                                                                       | Mature, simple to deploy, first-class TypeScript tooling.                                                                                                                                                                                                                                                                                                                                   |
| Application framework   | Next.js (App Router)                                                                                              | Single deployable unit that covers API routes now and UI later without a rewrite — avoids standing up a separate frontend service for a personal project. Domain/service code stays framework-agnostic (see "Layering" below) so this choice is swappable later at moderate cost, not high cost.                                                                                            |
| Database                | PostgreSQL                                                                                                        | Relational, strong consistency, transactional guarantees — required for invariants like "allocation lines sum to the expense's net amount" and "every mutation writes an audit event" to be enforceable, not just hoped for. Financial data with real relationships (payments↔expenses↔allocations↔people↔settlements) is exactly what a relational model is for.                           |
| ORM / schema            | Drizzle ORM                                                                                                       | SQL-close, explicit, minimal magic, strong TypeScript inference, explicit migration files under version control. Preferred over Prisma for this project because financial schema constraints (check constraints, careful numeric types) are easier to see and control directly. Recorded as `docs/decisions/0002-technology-stack.md`; revisit if the team ever grows beyond one developer. |
| Numeric types           | Integer minor units (paise), not floating point                                                                   | `amount` columns are `bigint` minor units, never `float`/`double`. The rounding rule (Largest Remainder Method, `domain.splitByLargestRemainder`) is fully finalized per `docs/domain/invariants.md` #12/#12a, ADR-0012 — not a placeholder.                                                                                                                                                |
| Auth                    | Minimal, single-user session auth (deferred implementation)                                                       | This is a personal system; a full multi-tenant auth provider is unjustified complexity right now. The `User`/`Person` split (see `domain-model.md`) keeps the door open to real multi-user auth later without a data model change.                                                                                                                                                          |
| File / evidence storage | Filesystem in dev, S3-compatible object storage in production                                                     | Evidence (`docs/domain/domain-model.md`, `Evidence.storage_ref`) is never stored in the database. Kept separate from application metadata per `docs/security/security-model.md`.                                                                                                                                                                                                            |
| Background/async work   | Postgres-backed job table, not a separate queue service                                                           | Import parsing and AI extraction are the only async-ish work at this scale. A `jobs` table with status/retry columns, polled by a lightweight worker process (or Next.js route handler invoked on a schedule), avoids operating Redis/SQS for a workload this small. Revisit if volume ever demands it.                                                                                     |
| AI provider             | Anthropic Claude API, called only from `src/ai`                                                                   | See `docs/architecture/ai-boundary.md`.                                                                                                                                                                                                                                                                                                                                                     |
| Observability           | Structured logging (pino), no request/response bodies containing financial specifics logged by default            | See `docs/security/security-model.md` for what must never appear in logs.                                                                                                                                                                                                                                                                                                                   |
| Testing                 | Vitest (unit/domain), integration tests against a real Postgres instance (Testcontainers or CI service container) | See `docs/testing/testing-strategy.md`.                                                                                                                                                                                                                                                                                                                                                     |
| Deployment              | Single container/app, managed Postgres, managed object storage                                                    | Exact provider is an open decision (Fly.io / Railway / self-hosted Docker + managed Postgres are all reasonable) — deliberately not committed here; see "Open questions" in the final report. Not needed until a real deployment phase.                                                                                                                                                     |

## Layering

```
src/
  domain/         Pure functions and types. No I/O, no framework imports, no AI calls.
                   Owns: allocation arithmetic, netAmount (ADR-0008), settlement/balance
                   computation (now a general pairwise function, ADR-0006), group-allocation
                   expansion resolution logic (ADR-0009), rounding, invariant validation,
                   state machine transition rules.
  services/        Orchestrates domain logic + persistence + audit logging. This is the only
                   layer allowed to write APPROVED-classified data, and it is where the
                   "every mutation writes an AuditEvent" rule (invariants.md #21) is enforced
                   structurally — not left to each call site. Gains `recordSettlement`,
                   `recordExpenseAdjustment`, `distributeAdjustment` (ADR-0007, ADR-0008), and
                   `getBalance` computing `domain.obligationEvidenceStatus` alongside `Balance`
                   (ADR-0014), on top of the existing `approveAllocation`, `decideInference`, etc.
  ai/               The AI boundary (docs/architecture/ai-boundary.md). Produces AIInference
                   records only. Never imports from services in a way that lets it write
                   authoritative state directly.
  db/               Schema (Drizzle), migrations, repository-style data access functions.
  integrations/     Adapters to external systems (Splitwise now; a bank aggregator or a
                   different debt-tracking tool later), isolated so no other layer has
                   Splitwise-specific knowledge. Gains a settlement-recording call
                   (`recordPayment`) alongside the existing `createExpense`.
  api/               Thin HTTP layer (Next.js route handlers / server actions). Validates
                   input, calls services, serializes output. No business logic here.
```

**Dependency direction is inward:** `api` and `integrations` depend on `services`; `services`
depends on `domain` and `db`; `ai` depends on `domain`'s types but not on `services` or `db`
directly (it receives what it needs as arguments and returns proposals — see
`ai-boundary.md`). `domain` depends on nothing else in `src/`. This is what makes "AI never
writes authoritative state" and "financial arithmetic is pure and testable in isolation"
enforceable rather than aspirational. This did not change in the 2026-08 revision — the new
entities (`Settlement`, `ExpenseAdjustment`, `AllocationLineGroupExpansion`) all fit the existing
layer boundaries without exception.

## Why not X

- **Not microservices.** One user, one dataset, no independent scaling needs. A single
  deployable service with clean internal module boundaries gets the maintainability benefit
  without the operational cost (see `CLAUDE.md` engineering principles).
- **Not a NoSQL/document database.** The domain is relational by nature (payments, expenses,
  allocations, settlements, and people reference each other with real referential-integrity
  needs); a document store would push consistency enforcement into application code that
  Postgres gives for free.
- **Not a separate frontend framework/repo yet.** No UI is being built in this phase
  (`docs/roadmap.md`); when it is, Next.js's App Router means it lands in the same repo and
  deployable without new infrastructure decisions.
- **Not a full workflow/orchestration engine for the review pipeline.** The state machines in
  `docs/domain/lifecycle.md` are simple enough to implement as explicit state fields plus
  service-layer transition functions; a workflow engine would be solving a problem this system
  doesn't have yet.
- **Not a single polymorphic `LedgerEvent` table covering Expense/Settlement/Adjustment.**
  Considered during the 2026-08 revision (see ADR-0007's "Alternatives considered") and rejected
  as more restructuring than the findings required — kept as separate, purpose-built tables per
  entity instead.

## Data flow

See `docs/architecture/data-flow.md` for the request/pipeline-level walkthrough.

## AI boundary

See `docs/architecture/ai-boundary.md` for the concrete service interface and validation
contract.

## Database

See `docs/architecture/database-design.md` for the schema translated from
`docs/domain/domain-model.md`. No migrations are written yet — schema is reviewed first, per
`docs/roadmap.md`.
