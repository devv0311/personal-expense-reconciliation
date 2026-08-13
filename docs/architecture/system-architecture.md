# System Architecture

Written after the domain model (`docs/domain/`), per the roadmap order — the domain model
drove these choices, not the reverse. This is a personal project: the guiding constraint
throughout is **simplicity and low operational complexity** without compromising the financial
correctness invariants in `docs/domain/invariants.md`.

## Stack decision

| Concern                 | Choice                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                | TypeScript (strict) everywhere                                                                                    | One language across domain logic, API, and eventual UI; strong types are load-bearing for financial code (see `CLAUDE.md`).                                                                                                                                                                                                                                                                 |
| Runtime                 | Node.js 20+                                                                                                       | Mature, simple to deploy, first-class TypeScript tooling.                                                                                                                                                                                                                                                                                                                                   |
| Application framework   | Next.js (App Router)                                                                                              | Single deployable unit that covers API routes now and UI later without a rewrite — avoids standing up a separate frontend service for a personal project. Domain/service code stays framework-agnostic (see "Layering" below) so this choice is swappable later at moderate cost, not high cost.                                                                                            |
| Database                | PostgreSQL                                                                                                        | Relational, strong consistency, transactional guarantees — required for invariants like "allocation lines sum to the expense amount" and "every mutation writes an audit event" to be enforceable, not just hoped for. Financial data with real relationships (payments↔expenses↔allocations↔people) is exactly what a relational model is for.                                             |
| ORM / schema            | Drizzle ORM                                                                                                       | SQL-close, explicit, minimal magic, strong TypeScript inference, explicit migration files under version control. Preferred over Prisma for this project because financial schema constraints (check constraints, careful numeric types) are easier to see and control directly. Recorded as `docs/decisions/0002-technology-stack.md`; revisit if the team ever grows beyond one developer. |
| Numeric types           | Integer minor units (paise), not floating point                                                                   | `amount` columns are `bigint` minor units, never `float`/`double`. Rounding rules live in application code per `docs/domain/invariants.md` #12.                                                                                                                                                                                                                                             |
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
                   Owns: allocation arithmetic, settlement/balance computation, rounding,
                   invariant validation, state machine transition rules.
  services/        Orchestrates domain logic + persistence + audit logging. This is the only
                   layer allowed to write APPROVED-classified data, and it is where the
                   "every mutation writes an AuditEvent" rule (invariants.md #21) is enforced
                   structurally — not left to each call site.
  ai/               The AI boundary (docs/architecture/ai-boundary.md). Produces AIInference
                   records only. Never imports from services in a way that lets it write
                   authoritative state directly.
  db/               Schema (Drizzle), migrations, repository-style data access functions.
  integrations/     Adapters to external systems (Splitwise now; a bank aggregator or a
                   different debt-tracking tool later), isolated so no other layer has
                   Splitwise-specific knowledge.
  api/               Thin HTTP layer (Next.js route handlers / server actions). Validates
                   input, calls services, serializes output. No business logic here.
```

**Dependency direction is inward:** `api` and `integrations` depend on `services`; `services`
depends on `domain` and `db`; `ai` depends on `domain`'s types but not on `services` or `db`
directly (it receives what it needs as arguments and returns proposals — see
`ai-boundary.md`). `domain` depends on nothing else in `src/`. This is what makes "AI never
writes authoritative state" and "financial arithmetic is pure and testable in isolation"
enforceable rather than aspirational.

## Why not X

- **Not microservices.** One user, one dataset, no independent scaling needs. A single
  deployable service with clean internal module boundaries gets the maintainability benefit
  without the operational cost (see `CLAUDE.md` engineering principles).
- **Not a NoSQL/document database.** The domain is relational by nature (payments, expenses,
  allocations, and people reference each other with real referential-integrity needs); a
  document store would push consistency enforcement into application code that Postgres gives
  for free.
- **Not a separate frontend framework/repo yet.** No UI is being built in this phase
  (`docs/roadmap.md`); when it is, Next.js's App Router means it lands in the same repo and
  deployable without new infrastructure decisions.
- **Not a full workflow/orchestration engine for the review pipeline.** The state machines in
  `docs/domain/lifecycle.md` are simple enough to implement as explicit state fields plus
  service-layer transition functions; a workflow engine would be solving a problem this system
  doesn't have yet.

## Data flow

See `docs/architecture/data-flow.md` for the request/pipeline-level walkthrough.

## AI boundary

See `docs/architecture/ai-boundary.md` for the concrete service interface and validation
contract.

## Database

See `docs/architecture/database-design.md` for the schema translated from
`docs/domain/domain-model.md`. No migrations are written yet — schema is reviewed first, per
`docs/roadmap.md`.
