# Architecture Decision Records

This directory records non-trivial technical and domain decisions and why they were made, so
future sessions (human or Claude) don't silently re-litigate or accidentally reverse them.

## When to add one

Add an ADR when a decision:

- Chooses between two or more real alternatives that both would have worked (naming a class is
  not an ADR; choosing Drizzle over Prisma is).
- Would be expensive or risky to reverse later (schema shape, entity boundaries, sync
  direction with an external system).
- Rejects an approach the brief or an obvious instinct would suggest, and future readers need
  to know it was considered, not missed.

## Format

Copy `0001-record-architecture-decisions.md` as a template. Each ADR has: `Status`
(`proposed | accepted | superseded by NNNN`), `Context`, `Decision`, `Consequences`, and
`Alternatives considered`.

## Index

| ADR                                             | Title                                                                 | Status   |
| ----------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)   | Record architecture decisions                                         | Accepted |
| [0002](0002-technology-stack.md)                | Technology stack                                                      | Accepted |
| [0003](0003-relational-database.md)             | Relational database over document/NoSQL                               | Accepted |
| [0004](0004-beneficiary-settlement-modeling.md) | Fold Beneficiary/Classification/Decision/Settlement into fewer tables | Accepted |
| [0005](0005-single-repo-no-microservices.md)    | Single deployable service, no microservices                           | Accepted |
