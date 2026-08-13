# Personal Expense Reconciliation System

A personal financial reconciliation system: it reconstructs where money went, who benefited
from each payment, and what portion of each expense belongs to the owner versus other people.

This is **not** an expense tracker, a budgeting app, a receipt scanner, or a Splitwise
replacement. Those are surface features. The actual problem being solved is:

> I make many payments through UPI and other methods — some for myself, some for my flat,
> some for flatmates, some for friends, some shared. Later I have difficulty reconstructing
> where the money actually went, who benefited, what my real share was, and who owes me money.

The system turns messy financial evidence (bank statements, UPI transactions, receipts,
screenshots, manual notes) into a verified, explainable financial ledger, and keeps that
ledger reconciled against external systems like Splitwise.

## Status

**Foundation stage.** The domain model, architecture, and engineering rules are established.
No transaction import, classification, or UI has been built yet. See
[`docs/roadmap.md`](docs/roadmap.md) for the implementation plan and current phase.

## Start here

If you are a person (or a Claude session) picking this project up, read in this order:

1. [`CLAUDE.md`](CLAUDE.md) — persistent engineering context: domain principles, financial
   safety rules, AI boundaries, conventions. Read this first, every time.
2. [`docs/product/overview.md`](docs/product/overview.md) — the problem and product vision.
3. [`docs/domain/domain-model.md`](docs/domain/domain-model.md) — the entities and their
   relationships.
4. [`docs/domain/scenario-analysis.md`](docs/domain/scenario-analysis.md) — 25 real scenarios
   used to stress-test the model, and what they changed.
5. [`docs/architecture/system-architecture.md`](docs/architecture/system-architecture.md) —
   the technical design and why it was chosen.
6. [`docs/roadmap.md`](docs/roadmap.md) — what's built, what's next.

## Repository layout

```
docs/               Product, domain, architecture, decision, testing, and security docs
fixtures/           Synthetic (non-real) example financial data used to drive tests
src/
  domain/           Pure domain logic: entities, invariants, deterministic calculations
  services/         Application services orchestrating domain logic + persistence
  ai/               AI inference boundary — structured proposals only, never authoritative writes
  db/               Schema and persistence layer
  integrations/     Adapters to external systems (e.g. Splitwise)
  api/              Thin HTTP/API layer
tests/              Cross-cutting and integration tests
```

Each `src/` subdirectory currently contains only a `README.md` describing its intended
responsibility and boundaries — see [`docs/roadmap.md`](docs/roadmap.md) for what gets
implemented in which phase.

## Development

Requires Node.js 20+.

```bash
npm install
npm run typecheck   # TypeScript, strict mode
npm run lint         # ESLint
npm run format:check # Prettier
npm test             # Vitest
```

All four must pass before a change is committed; CI (`.github/workflows/ci.yml`) enforces
this on every push and pull request.

## Core principles (see `CLAUDE.md` for the full version)

- **Payment ≠ Expense ≠ Receipt.** A payment can contain multiple expenses; an expense can
  have multiple beneficiaries; an occasion can span multiple payments. The domain model never
  collapses these.
- **Evidence is immutable.** Raw imported financial data is never overwritten by inference.
- **AI proposes, code decides.** All authoritative financial arithmetic (totals, allocations,
  balances, settlements) is deterministic application code. AI output is a structured,
  confidence-scored proposal that a human approves or the app validates — never a source of
  truth.
- **Splitwise is a sync target, not the source of truth.** This application's own ledger is
  canonical.
- **Every meaningful amount of money should eventually be explainable.**

## License

Personal project. Not currently licensed for reuse or redistribution.
