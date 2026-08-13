# 0002. Technology stack

**Status:** Accepted

## Context

Needed a stack for a personal financial reconciliation system: TypeScript domain logic,
relational data, AI-assisted classification, eventually a review UI and Splitwise sync.
Optimizing for simplicity and low operational complexity (single user, no team, no need for
independent scaling of components) without compromising financial correctness (see
`docs/domain/invariants.md`).

## Decision

TypeScript (strict) throughout. Node.js 20+. Next.js (App Router) as the single deployable
application shell for API and, later, UI. PostgreSQL as the database. Drizzle ORM for schema
and migrations. Vitest for testing. A Postgres-backed job table for the limited async work
this system needs, rather than a separate queue service. Anthropic Claude API for AI inference,
called only from `src/ai` (see `docs/architecture/ai-boundary.md`).

## Consequences

One language, one deployable unit, one datastore to operate. Domain/service code
(`src/domain`, `src/services`) is kept framework-agnostic so Next.js is swappable later at
moderate, not high, cost if requirements outgrow it. Drizzle's closeness to SQL means schema
constraints for financial data are visible and reviewable, at the cost of slightly more manual
schema-writing than Prisma's more automated workflow.

## Alternatives considered

- **Separate Express/Fastify API + separate frontend app.** Rejected for now: two deployables
  and two build pipelines for a personal project with no current need for independent scaling.
- **Prisma over Drizzle.** Considered seriously — Prisma's migration ergonomics are excellent.
  Rejected because Drizzle's schema-as-TypeScript-close-to-SQL style makes financial
  constraints (check constraints, exact numeric types, partial unique indexes) easier to read
  and reason about directly in the schema file, which matters more here than migration
  convenience. Revisit if this becomes a team project.
- **MongoDB / a document store.** Rejected — see `0003-relational-database.md`.
- **Redis/SQS-backed job queue.** Rejected at this scale — see
  `docs/architecture/system-architecture.md`, "Why not X." Revisit if import/AI-extraction
  volume grows enough to need real concurrency control or retries-at-scale.
- **Python (FastAPI + SQLAlchemy) instead of TypeScript.** Considered given AI/data tooling is
  often Python-first. Rejected because a single language across domain logic, API, and future
  UI reduces context-switching for a solo maintainer, and TypeScript's type system is
  sufficient (and arguably stricter by default) for the financial correctness this project
  needs; Python's AI ecosystem advantage doesn't apply here since AI calls are a thin,
  isolated boundary (`src/ai`) regardless of language.
