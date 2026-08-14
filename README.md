# Personal Expense Reconciliation System

A personal financial reconciliation system: it reconstructs where money went, who benefited
from each payment, and what portion of each expense belongs to the owner versus other people —
**in either direction**: who the owner owes, and who owes the owner.

This is **not** an expense tracker, a budgeting app, a receipt scanner, or a Splitwise
replacement. Those are surface features. The actual problem being solved is:

> I make many payments through UPI and other methods — some for myself, some for my flat,
> some for flatmates, some for friends, some shared. Sometimes it's the other way around — a
> flatmate or friend pays and I owe my share. Later I have difficulty reconstructing where the
> money actually went, who benefited, what my real share was, and who owes whom.

The system turns messy financial evidence (bank statements, UPI transactions, receipts,
screenshots, manual notes) into a verified, explainable financial ledger, and keeps that
ledger reconciled against external systems like Splitwise.

## Status

**Foundation stage, revised 2026-08, implementation-ready.** The domain model, architecture, and
engineering rules are established, corrected in a pre-implementation architecture review (ADRs
0006–0011), and finalized in a follow-up implementation-readiness pass that resolved every
remaining open question — money/rounding, the full-refund allocation shape, non-user obligation
observability, and inflow-reconciliation scope (ADRs 0012–0015 in
[`docs/decisions/`](docs/decisions/)). No transaction import, classification, or UI has been
built yet. See [`docs/roadmap.md`](docs/roadmap.md) for the implementation plan and current
phase.

## Start here

If you are a person (or a Claude session) picking this project up, read in this order:

1. [`CLAUDE.md`](CLAUDE.md) — persistent engineering context: domain principles, financial
   safety rules, AI boundaries, conventions. Read this first, every time.
2. [`docs/product/overview.md`](docs/product/overview.md) — the problem and product vision.
3. [`docs/domain/domain-model.md`](docs/domain/domain-model.md) — the entities and their
   relationships.
4. [`docs/domain/scenario-analysis.md`](docs/domain/scenario-analysis.md) — 35 real scenarios
   used to stress-test the model (25 original + 10 added in the 2026-08 revision), and what
   they changed, plus a stress-test coverage matrix.
5. [`docs/decisions/`](docs/decisions/) — why the model looks the way it does: ADRs 0006–0011
   for why settlements/refunds/reimbursements aren't `Expense`s, ADRs 0012–0015 for the
   money-rounding algorithm, the full-refund allocation shape, non-user obligation
   observability, and the inflow-reconciliation scope boundary.
6. [`docs/architecture/system-architecture.md`](docs/architecture/system-architecture.md) —
   the technical design and why it was chosen.
7. [`docs/roadmap.md`](docs/roadmap.md) — what's built, what's next.

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
- **The payer isn't always the owner.** An expense someone else fronted, that the owner owes
  their share of, is exactly as representable as the reverse.
- **A settlement discharges a debt; it never creates one.** Settlements, refunds, and
  reimbursements are distinct from new spending and never require their own `Allocation`.
- **Evidence is immutable.** Raw imported financial data is never overwritten by inference, and
  neither is an approved expense's original recorded amount.
- **AI proposes, code decides.** All authoritative financial arithmetic (totals, allocations,
  balances, settlements) is deterministic application code. AI output is a structured,
  confidence-scored proposal that a human approves or the app validates — never a source of
  truth.
- **Splitwise is a sync target, not the source of truth.** This application's own ledger is
  canonical.
- **Every meaningful amount of money should eventually be explainable.**

## License

Personal project. Not currently licensed for reuse or redistribution.
