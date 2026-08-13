# 0001. Record architecture decisions

**Status:** Accepted

## Context

This project will accumulate non-obvious decisions (why Drizzle over Prisma, why `Beneficiary`
isn't a table) across many sessions, likely with gaps of time between them and possibly
different people/agents doing the work. Without a record, those decisions get silently
re-litigated or reversed by someone who didn't see the original reasoning.

## Decision

Record architecture and domain decisions as numbered markdown files in `docs/decisions/`,
following the format in `docs/decisions/README.md`.

## Consequences

Every non-trivial decision has a durable "why," at the cost of a small amount of upfront
writing discipline. Superseding a decision means adding a new ADR that references and updates
the old one's status, not deleting it — the history of _why something changed_ is as valuable
as the current state.

## Alternatives considered

Relying on `CLAUDE.md` and doc prose alone — rejected because prose docs get rewritten to
reflect current state and lose the historical "we considered X and rejected it because Y,"
which is exactly the information that prevents re-litigation.
