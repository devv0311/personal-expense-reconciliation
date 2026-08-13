# 0005. Single deployable service, no microservices

**Status:** Accepted

## Context

The domain spans several conceptually distinct concerns (import/normalization, classification,
review, allocation, sync, reconciliation, and eventually analytics and a natural-language
interface) that could be split into independently deployable services.

## Decision

One deployable application (`docs/architecture/system-architecture.md`), with the concerns
separated by internal module boundaries (`src/domain`, `src/services`, `src/ai`, `src/db`,
`src/integrations`, `src/api`) instead of network boundaries.

## Consequences

No distributed-systems failure modes (partial failure across services, network calls where
function calls would do, eventual-consistency reasoning) for a workload that is single-user
and low-volume. Module boundaries still give most of the maintainability benefit people reach
for microservices for — a change to `src/ai` can't accidentally break `src/domain`'s pure
functions, because it doesn't import them. Cost: if this ever needs to scale to genuine
multi-tenant, high-volume usage, splitting deployables later means real work; judged
acceptable given the project's stated scope (personal use).

## Alternatives considered

- **Microservices split by pipeline stage** (an import service, a classification service, a
  sync service). Rejected: adds operational surface (multiple deploys, service discovery,
  network-boundary error handling) with no corresponding benefit at this scale — nothing about
  this project needs independent scaling of "import" versus "classification."
- **Serverless functions per operation.** Considered for the AI-calling operations
  specifically (natural fit for request/response, bursty AI calls). Rejected for now to avoid
  splitting the codebase's deployment model in two; revisit specifically for `src/ai` if cold-
  start cost or cost-at-idle becomes a real concern once it's implemented.
